use serde::Serialize;
use tauri::Manager;

mod capture;
mod direct;
mod docx;
mod file_commands;
mod payload;
mod pdf_render;
mod proxy;
mod text;

use capture::{
    capture_system_screenshot_png_base64, capture_window_png_base64, SYSTEM_SCREENSHOT_ERROR,
    WINDOW_CAPTURE_ERROR,
};
#[cfg(target_os = "windows")]
use direct::{is_glm_ocr_model, read_glm_ocr_from_image, read_uploaded_glm_ocr};
use direct::{ollama_model_available, read_ocr_from_image, read_uploaded_ocr_from_images};
use docx::build_markdown_docx_export;
#[cfg(target_os = "windows")]
use file_commands::unique_temp_path;
use file_commands::{
    begin_file_command, choose_markdown_file_path, export_safe_base_name, finish_file_command,
    finish_file_command_with_dialog, read_opened_markdown_file, save_binary_file,
};
use payload::{
    is_pdf_upload, pdf_bytes_from_upload, uploaded_images_from_payload,
    validate_uploaded_pdf_bytes, UploadedOcrImage,
};
use pdf_render::{
    build_pdf_image_export, render_pdf_bytes_for_export, render_pdf_bytes_for_ocr,
    PDF_RENDER_TASK_ERROR,
};
use proxy::{
    read_ocr_proxy_from_image, read_uploaded_ocr_proxy_from_images,
    read_uploaded_ocr_proxy_from_pdf,
};

const GENERIC_LOCAL_PDF_UPLOAD_AVAILABLE: bool = cfg!(target_os = "windows");
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn strip_data_url_prefix(value: &str) -> &str {
    let trimmed = value.trim();
    if let Some((prefix, payload)) = trimmed.split_once(',') {
        if prefix.trim_start().starts_with("data:") {
            return payload.trim();
        }
    }
    trimmed
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrReadResult {
    pub app_name: String,
    pub window_title: String,
    pub app_type: crate::llm::AppType,
    pub text: String,
    pub elapsed_ms: u32,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrConnectionTestResult {
    pub model_available: bool,
    pub image_available: bool,
    pub pdf_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub router_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_available: Option<bool>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ScreenOcrSelectionOutcome {
    Success { result: OcrReadResult },
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImageExportResult {
    pub file_name: String,
    pub mime_type: String,
    pub page_count: u32,
    pub file_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDiagnosticResult {
    pub ok: bool,
    pub stage: String,
    pub message: String,
    pub page_count: Option<u32>,
    pub input_bytes: Option<usize>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocxExportResult {
    pub file_name: String,
    pub mime_type: String,
    pub file_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedMarkdownFile {
    pub file_name: String,
    pub text: String,
}

fn http_base_url(base_url: &str) -> Result<String, String> {
    if base_url.trim().is_empty() {
        return Err("OCR base URL is empty".to_string());
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("Invalid OCR base URL: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("OCR base URL must use http or https scheme".to_string());
    }

    Ok(trimmed.to_string())
}

fn uploaded_window_snapshot(file_name: &str) -> crate::app_detector::WindowSnapshot {
    crate::app_detector::WindowSnapshot {
        context: crate::app_detector::AppContext {
            app_name: "上传附件".to_string(),
            window_title: file_name.trim().to_string(),
            app_type: crate::llm::AppType::Document,
        },
        bounds: None,
    }
}

fn uploaded_source_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        "上传附件".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn uploaded_images_from_payload_async(
    file_name: String,
    mime_type: String,
    image_base64: Option<String>,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<Vec<UploadedOcrImage>, String> {
    if is_pdf_upload(&file_name, &mime_type) {
        return tauri::async_runtime::spawn_blocking(move || {
            uploaded_images_from_payload(
                &file_name,
                &mime_type,
                image_base64,
                file_base64,
                file_bytes,
            )
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "PDF upload render task failed");
            PDF_RENDER_TASK_ERROR.to_string()
        })?;
    }

    uploaded_images_from_payload(
        &file_name,
        &mime_type,
        image_base64,
        file_base64,
        file_bytes,
    )
}

async fn uploaded_proxy_images_from_payload_async(
    file_name: String,
    mime_type: String,
    image_base64: Option<String>,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<(Vec<UploadedOcrImage>, Option<String>), String> {
    if is_pdf_upload(&file_name, &mime_type) {
        return tauri::async_runtime::spawn_blocking(move || {
            let bytes = pdf_bytes_from_upload(file_base64, file_bytes)?;
            validate_uploaded_pdf_bytes(&bytes)?;
            let parent_key = crate::idempotency::derived_key("ocr-legacy-pdf", &[&bytes]);
            let images = render_pdf_bytes_for_ocr(bytes)?
                .into_iter()
                .map(|base64| UploadedOcrImage {
                    base64,
                    mime_type: "image/png",
                    document_page: true,
                })
                .collect();
            Ok((images, Some(parent_key)))
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "PDF upload render task failed");
            PDF_RENDER_TASK_ERROR.to_string()
        })?;
    }

    uploaded_images_from_payload_async(file_name, mime_type, image_base64, file_base64, file_bytes)
        .await
        .map(|images| (images, None))
}

async fn capture_current_window_png_base64(
    app: &tauri::AppHandle,
) -> Result<(crate::app_detector::WindowSnapshot, String), String> {
    let main_window = app.get_webview_window("main");
    if let Some(window) = main_window.as_ref() {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            tokio::time::sleep(std::time::Duration::from_millis(260)).await;
        }
    }

    let window_snapshot = crate::app_detector::detect_current_window_snapshot();
    let capture_bounds = window_snapshot.bounds;
    let capture_result =
        tauri::async_runtime::spawn_blocking(move || capture_window_png_base64(capture_bounds))
            .await
            .map_err(|error| {
                tracing::error!(%error, "Window capture task failed");
                WINDOW_CAPTURE_ERROR.to_string()
            })
            .and_then(|result| result);

    if let Some(window) = main_window.as_ref() {
        let _ = window.show();
        let _ = window.set_focus();
    }

    capture_result.map(|image| (window_snapshot, image))
}

async fn capture_system_selection_png_base64(
    app: &tauri::AppHandle,
) -> Result<Option<(crate::app_detector::WindowSnapshot, String)>, String> {
    let main_window = app.get_webview_window("main");
    if let Some(window) = main_window.as_ref() {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            tokio::time::sleep(std::time::Duration::from_millis(260)).await;
        }
    }

    let window_snapshot = crate::app_detector::detect_current_window_snapshot();
    let capture_result = tauri::async_runtime::spawn_blocking(capture_system_screenshot_png_base64)
        .await
        .map_err(|error| {
            tracing::error!(%error, "System screenshot task failed");
            SYSTEM_SCREENSHOT_ERROR.to_string()
        })
        .and_then(|result| result);

    if let Some(window) = main_window.as_ref() {
        let _ = window.show();
        let _ = window.set_focus();
    }

    capture_result.map(|image| image.map(|image| (window_snapshot, image)))
}

#[tauri::command]
pub async fn test_ocr_connection(
    base_url: String,
    model: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<OcrConnectionTestResult, String> {
    let base_url = http_base_url(&base_url)?;
    let model = model.trim();
    if model.is_empty() {
        return Ok(OcrConnectionTestResult {
            model_available: false,
            image_available: false,
            pdf_available: false,
            router_available: None,
            pipeline_available: None,
            issues: vec!["OCR model is empty".to_string()],
        });
    }

    #[cfg(target_os = "windows")]
    if is_glm_ocr_model(model) {
        if let Err(error) = super::ocr_runtime::validate_runtime_target(&base_url, model) {
            return Ok(OcrConnectionTestResult {
                model_available: false,
                image_available: false,
                pdf_available: false,
                router_available: Some(false),
                pipeline_available: Some(false),
                issues: vec![error],
            });
        }
        let local_client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|error| format!("Failed to prepare local OCR client: {error}"))?;
        let model_available = ollama_model_available(&local_client, &base_url, model).await?;
        let (router, pipeline) = tokio::join!(
            super::ocr_runtime::probe_router_runtime(&base_url, model),
            super::ocr_runtime::probe_pipeline_runtime(&base_url, model),
        );
        let router_available = router.is_ok();
        let pipeline_available = pipeline.is_ok();
        let mut issues = Vec::new();
        if !model_available {
            issues.push("Ollama model is unavailable".to_string());
        }
        if let Err(error) = router {
            issues.push(format!("Image router: {error}"));
        }
        if let Err(error) = pipeline {
            issues.push(format!("Document pipeline: {error}"));
        }
        return Ok(OcrConnectionTestResult {
            model_available,
            image_available: model_available && router_available,
            pdf_available: model_available && pipeline_available,
            router_available: Some(router_available),
            pipeline_available: Some(pipeline_available),
            issues,
        });
    }

    let client = client.client()?;
    let model_available = ollama_model_available(&client, &base_url, model).await?;
    Ok(OcrConnectionTestResult {
        model_available,
        image_available: model_available,
        pdf_available: model_available && GENERIC_LOCAL_PDF_UPLOAD_AVAILABLE,
        router_available: None,
        pipeline_available: None,
        issues: (!model_available)
            .then(|| "OCR model is unavailable".to_string())
            .into_iter()
            .collect(),
    })
}

#[tauri::command]
pub async fn read_screen_ocr(
    app: tauri::AppHandle,
    base_url: String,
    model: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<OcrReadResult, String> {
    let (window_snapshot, image_base64) = capture_current_window_png_base64(&app).await?;
    #[cfg(target_os = "windows")]
    if is_glm_ocr_model(&model) {
        return read_glm_ocr_from_image(window_snapshot, image_base64, base_url, model).await;
    }
    let client = client.client()?;
    read_ocr_from_image(window_snapshot, image_base64, base_url, model, &client).await
}

#[tauri::command]
pub async fn read_screen_ocr_proxy(
    app: tauri::AppHandle,
    api_base_url: String,
    token: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<OcrReadResult, String> {
    let (window_snapshot, image_base64) = capture_current_window_png_base64(&app).await?;
    let client = client.client()?;
    read_ocr_proxy_from_image(
        window_snapshot,
        image_base64,
        "image/png",
        false,
        api_base_url,
        token,
        None,
        registry.inner(),
        &client,
    )
    .await
}

#[tauri::command]
pub async fn read_screen_ocr_selection(
    app: tauri::AppHandle,
    base_url: String,
    model: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
    onboarding_guard: tauri::State<'_, crate::onboarding_guard::OnboardingGuard>,
) -> Result<ScreenOcrSelectionOutcome, String> {
    if onboarding_guard.is_active() {
        return Ok(ScreenOcrSelectionOutcome::Cancelled);
    }
    let Some((window_snapshot, image_base64)) = capture_system_selection_png_base64(&app).await?
    else {
        return Ok(ScreenOcrSelectionOutcome::Cancelled);
    };
    if onboarding_guard.is_active() {
        return Ok(ScreenOcrSelectionOutcome::Cancelled);
    }
    #[cfg(target_os = "windows")]
    if is_glm_ocr_model(&model) {
        let result =
            read_glm_ocr_from_image(window_snapshot, image_base64, base_url, model).await?;
        return Ok(ScreenOcrSelectionOutcome::Success { result });
    }
    let client = client.client()?;
    let result =
        read_ocr_from_image(window_snapshot, image_base64, base_url, model, &client).await?;
    Ok(ScreenOcrSelectionOutcome::Success { result })
}

#[tauri::command]
pub async fn read_screen_ocr_selection_proxy(
    app: tauri::AppHandle,
    api_base_url: String,
    token: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
    onboarding_guard: tauri::State<'_, crate::onboarding_guard::OnboardingGuard>,
) -> Result<ScreenOcrSelectionOutcome, String> {
    if onboarding_guard.is_active() {
        return Ok(ScreenOcrSelectionOutcome::Cancelled);
    }
    let Some((window_snapshot, image_base64)) = capture_system_selection_png_base64(&app).await?
    else {
        return Ok(ScreenOcrSelectionOutcome::Cancelled);
    };
    if onboarding_guard.is_active() {
        return Ok(ScreenOcrSelectionOutcome::Cancelled);
    }
    let client = client.client()?;
    let result = read_ocr_proxy_from_image(
        window_snapshot,
        image_base64,
        "image/png",
        false,
        api_base_url,
        token,
        None,
        registry.inner(),
        &client,
    )
    .await?;
    Ok(ScreenOcrSelectionOutcome::Success { result })
}

#[tauri::command]
pub async fn read_uploaded_ocr(
    base_url: String,
    model: String,
    file_name: String,
    mime_type: String,
    image_base64: Option<String>,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<OcrReadResult, String> {
    #[cfg(target_os = "windows")]
    if is_glm_ocr_model(&model) {
        return read_uploaded_glm_ocr(
            file_name,
            mime_type,
            image_base64,
            file_base64,
            file_bytes,
            base_url,
            model,
        )
        .await;
    }

    let images = uploaded_images_from_payload_async(
        file_name.clone(),
        mime_type,
        image_base64,
        file_base64,
        file_bytes,
    )
    .await?;
    let client = client.client()?;
    read_uploaded_ocr_from_images(file_name, images, base_url, model, &client).await
}

#[tauri::command]
pub async fn read_uploaded_ocr_proxy(
    api_base_url: String,
    token: String,
    file_name: String,
    mime_type: String,
    image_base64: Option<String>,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<OcrReadResult, String> {
    let (images, idempotency_parent) = uploaded_proxy_images_from_payload_async(
        file_name.clone(),
        mime_type,
        image_base64,
        file_base64,
        file_bytes,
    )
    .await?;
    let client = client.client()?;
    read_uploaded_ocr_proxy_from_images(
        file_name,
        images,
        api_base_url,
        token,
        idempotency_parent,
        registry.inner(),
        &client,
    )
    .await
}

#[tauri::command]
pub async fn read_uploaded_pdf_proxy(
    api_base_url: String,
    token: String,
    file_name: String,
    mime_type: String,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<OcrReadResult, String> {
    if !is_pdf_upload(&file_name, &mime_type) {
        return Err("Only PDF files can use the document OCR endpoint.".to_string());
    }
    let bytes = pdf_bytes_from_upload(file_base64, file_bytes)?;
    validate_uploaded_pdf_bytes(&bytes)?;
    let client = client.client()?;
    read_uploaded_ocr_proxy_from_pdf(
        file_name,
        bytes,
        api_base_url,
        token,
        registry.inner(),
        &client,
    )
    .await
}

async fn export_pdf_images(
    file_name: String,
    mime_type: String,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<PdfImageExportResult, String> {
    if !is_pdf_upload(&file_name, &mime_type) {
        return Err("Only PDF files can be exported as page images.".to_string());
    }
    let bytes = pdf_bytes_from_upload(file_base64, file_bytes)?;
    validate_uploaded_pdf_bytes(&bytes)?;

    tauri::async_runtime::spawn_blocking(move || {
        let pages = render_pdf_bytes_for_export(bytes)?;
        build_pdf_image_export(&file_name, pages)
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "PDF image export task failed");
        PDF_RENDER_TASK_ERROR.to_string()
    })?
}

#[tauri::command]
pub async fn diagnose_pdf_upload(
    file_name: String,
    mime_type: String,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<PdfDiagnosticResult, String> {
    let started = std::time::Instant::now();
    if !is_pdf_upload(&file_name, &mime_type) {
        return Ok(PdfDiagnosticResult {
            ok: false,
            stage: "type".to_string(),
            message: "请选择 PDF 文件。".to_string(),
            page_count: None,
            input_bytes: None,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }

    let bytes = match pdf_bytes_from_upload(file_base64, file_bytes) {
        Ok(bytes) => bytes,
        Err(message) => {
            return Ok(PdfDiagnosticResult {
                ok: false,
                stage: "payload".to_string(),
                message,
                page_count: None,
                input_bytes: None,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
    };
    let input_bytes = bytes.len();
    if let Err(message) = validate_uploaded_pdf_bytes(&bytes) {
        return Ok(PdfDiagnosticResult {
            ok: false,
            stage: "payload".to_string(),
            message,
            page_count: None,
            input_bytes: Some(input_bytes),
            elapsed_ms: started.elapsed().as_millis(),
        });
    }

    let rendered = tauri::async_runtime::spawn_blocking(move || render_pdf_bytes_for_ocr(bytes))
        .await
        .map_err(|error| {
            tracing::error!(%error, "PDF diagnostic task failed");
            PDF_RENDER_TASK_ERROR.to_string()
        })?;

    match rendered {
        Ok(pages) => Ok(PdfDiagnosticResult {
            ok: true,
            stage: "render".to_string(),
            message: format!("PDF 解析正常，共 {} 页。", pages.len()),
            page_count: Some(pages.len() as u32),
            input_bytes: Some(input_bytes),
            elapsed_ms: started.elapsed().as_millis(),
        }),
        Err(message) => Ok(PdfDiagnosticResult {
            ok: false,
            stage: "render".to_string(),
            message,
            page_count: None,
            input_bytes: Some(input_bytes),
            elapsed_ms: started.elapsed().as_millis(),
        }),
    }
}

async fn export_markdown_docx(
    source_name: String,
    markdown: String,
    page_count: Option<u32>,
) -> Result<MarkdownDocxExportResult, String> {
    let insert_page_breaks = page_count.is_some_and(|count| count > 1);
    tauri::async_runtime::spawn_blocking(move || {
        build_markdown_docx_export(&source_name, &markdown, insert_page_breaks)
    })
    .await
    .map_err(|e| format!("DOCX export task failed: {e}"))?
}

#[tauri::command]
pub async fn open_markdown_file(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Option<OpenedMarkdownFile>, String> {
    let Some(path) = choose_markdown_file_path(&window, &app).await? else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || read_opened_markdown_file(&path))
        .await
        .map_err(|error| format!("Markdown 文件读取任务失败：{error}"))?
        .map(Some)
}

#[tauri::command]
pub async fn run_save_markdown_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    owners: tauri::State<'_, crate::process_ownership::ProcessOwners>,
    key: crate::process_ownership::FileCommandKey,
    request_fingerprint: String,
    file_name: String,
    text: String,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    use crate::process_ownership::FileCommandKind;
    if key.command_kind != FileCommandKind::SaveMarkdown {
        return Err("Invalid file command kind.".into());
    }
    let lease_id = match begin_file_command(&window, &app, &owners, &key, request_fingerprint) {
        Ok(id) => id,
        Err(snapshot) => return Ok(snapshot),
    };
    if text.trim().is_empty() {
        return finish_file_command(
            &app,
            &owners,
            &key,
            lease_id,
            Err("没有可保存的 Markdown 内容。".to_string()),
        );
    }
    finish_file_command_with_dialog(
        &window,
        &app,
        &owners,
        &key,
        lease_id,
        "保存 Markdown",
        &file_name,
        "echolike-markdown.md",
        "Markdown 文档",
        &["md"],
        text.into_bytes(),
        "Markdown saved".to_string(),
    )
    .await
}

#[tauri::command]
pub async fn run_export_markdown_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    owners: tauri::State<'_, crate::process_ownership::ProcessOwners>,
    key: crate::process_ownership::FileCommandKey,
    request_fingerprint: String,
    file_name: String,
    text: String,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    use crate::process_ownership::FileCommandKind;
    if key.command_kind != FileCommandKind::ExportMarkdown {
        return Err("Invalid file command kind.".into());
    }
    let lease_id = match begin_file_command(&window, &app, &owners, &key, request_fingerprint) {
        Ok(id) => id,
        Err(snapshot) => return Ok(snapshot),
    };
    if text.trim().is_empty() {
        return finish_file_command(
            &app,
            &owners,
            &key,
            lease_id,
            Err("没有可保存的 Markdown 内容。".to_string()),
        );
    }
    finish_file_command_with_dialog(
        &window,
        &app,
        &owners,
        &key,
        lease_id,
        "保存 Markdown",
        &file_name,
        "echolike-ocr.md",
        "Markdown 文档",
        &["md"],
        text.into_bytes(),
        "Markdown exported".to_string(),
    )
    .await
}

#[tauri::command]
pub async fn run_export_markdown_docx(
    window: tauri::Window,
    app: tauri::AppHandle,
    owners: tauri::State<'_, crate::process_ownership::ProcessOwners>,
    key: crate::process_ownership::FileCommandKey,
    request_fingerprint: String,
    source_name: String,
    markdown: String,
    page_count: Option<u32>,
    prompt_for_destination: Option<bool>,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    use crate::process_ownership::FileCommandKind;
    if key.command_kind != FileCommandKind::ExportDocx {
        return Err("Invalid file command kind.".into());
    }
    let lease_id = match begin_file_command(&window, &app, &owners, &key, request_fingerprint) {
        Ok(id) => id,
        Err(snapshot) => return Ok(snapshot),
    };
    if markdown.trim().is_empty() {
        return finish_file_command(
            &app,
            &owners,
            &key,
            lease_id,
            Err("没有可导出的 Markdown 内容。".to_string()),
        );
    }
    let export = match export_markdown_docx(source_name, markdown, page_count).await {
        Ok(export) => export,
        Err(error) => {
            return finish_file_command(&app, &owners, &key, lease_id, Err(error));
        }
    };
    if prompt_for_destination.unwrap_or(false) {
        return finish_file_command_with_dialog(
            &window,
            &app,
            &owners,
            &key,
            lease_id,
            "导出 Word",
            &export.file_name,
            "echolike-export.docx",
            "Word 文档",
            &["docx"],
            export.file_bytes,
            "Word exported".to_string(),
        )
        .await;
    }
    let result = save_binary_file(app.clone(), export.file_name, export.file_bytes)
        .map(|path| (path, "Word exported".to_string()));
    finish_file_command(&app, &owners, &key, lease_id, result)
}

#[tauri::command]
pub async fn run_export_pdf_images(
    window: tauri::Window,
    app: tauri::AppHandle,
    owners: tauri::State<'_, crate::process_ownership::ProcessOwners>,
    key: crate::process_ownership::FileCommandKey,
    request_fingerprint: String,
    file_name: String,
    mime_type: String,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    use crate::process_ownership::FileCommandKind;
    if key.command_kind != FileCommandKind::ExportPdf {
        return Err("Invalid file command kind.".into());
    }
    let lease_id = match begin_file_command(&window, &app, &owners, &key, request_fingerprint) {
        Ok(id) => id,
        Err(snapshot) => return Ok(snapshot),
    };
    let export = match export_pdf_images(file_name, mime_type, file_base64, file_bytes).await {
        Ok(export) => export,
        Err(error) => {
            return finish_file_command(&app, &owners, &key, lease_id, Err(error));
        }
    };
    let (message, filter_name, extensions, fallback_file_name) = if export.page_count > 1 {
        (
            format!("已导出 {} 页图片包", export.page_count),
            "ZIP 图片包",
            &["zip"][..],
            "echolike-pdf-pages.zip",
        )
    } else {
        (
            "已导出 PDF 页面图片".to_string(),
            "PNG 图片",
            &["png"][..],
            "echolike-pdf-page.png",
        )
    };
    finish_file_command_with_dialog(
        &window,
        &app,
        &owners,
        &key,
        lease_id,
        "导出 PDF 页面图片",
        &export.file_name,
        fallback_file_name,
        filter_name,
        extensions,
        export.file_bytes,
        message,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_independent_local_ocr_capabilities_for_the_frontend() {
        let value = serde_json::to_value(OcrConnectionTestResult {
            model_available: true,
            image_available: true,
            pdf_available: false,
            router_available: Some(true),
            pipeline_available: Some(false),
            issues: vec!["Document pipeline unavailable".to_string()],
        })
        .unwrap();

        assert_eq!(value["modelAvailable"], true);
        assert_eq!(value["imageAvailable"], true);
        assert_eq!(value["pdfAvailable"], false);
        assert_eq!(value["routerAvailable"], true);
        assert_eq!(value["pipelineAvailable"], false);
    }

    #[test]
    fn generic_local_pdf_capability_matches_the_platform_renderer() {
        assert_eq!(
            GENERIC_LOCAL_PDF_UPLOAD_AVAILABLE,
            cfg!(target_os = "windows")
        );
    }
}
