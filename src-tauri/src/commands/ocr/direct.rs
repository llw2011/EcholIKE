use super::payload::{
    decode_uploaded_base64, image_base64_from_upload, is_image_upload, is_pdf_upload,
    pdf_bytes_from_upload, uploaded_image_extension_from_bytes, validate_uploaded_image_bytes,
    validate_uploaded_pdf_bytes, UploadedOcrImage,
};
use super::text::extract_ocr_text;
use super::{http_base_url, uploaded_source_name, uploaded_window_snapshot, OcrReadResult};

const OCR_NUM_PREDICT: u32 = 16384;
const GLM_OCR_TEXT_RECOGNITION_PROMPT: &str = "Text Recognition:";
const DEFAULT_OCR_PROMPT: &str = r#"你是严格的 OCR 与版面还原引擎。请完整读取图片、窗口截图或 PDF 页面中的全部可见文字，不要摘要、不要改写、不要省略、不要只返回局部。

输出要求：
1. 只输出工整 Markdown，不要输出 JSON，也不要输出解释性前后缀。
2. 保持自然阅读顺序、标题层级、列表、表格、代码块、按钮/标签等结构。
3. 表格要尽量还原为标准 Markdown 表格；内容很多时也要持续读取到所有可见文字，不要只返回页面上半部分或第一块区域。
4. 看不清的文字用 [无法识别] 标记；不要凭空编造。
5. 不要把 Markdown 整体包在 ```markdown 代码围栏里。
6. 不要重复输出同一行、同一段或同一截图片段；已经输出过的内容不要再次复述。"#;

fn model_matches(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.trim();
    let expected = expected.trim();
    candidate == expected
        || candidate.strip_suffix(":latest") == Some(expected)
        || expected.strip_suffix(":latest") == Some(candidate)
}

pub(super) fn is_glm_ocr_model(model: &str) -> bool {
    model
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("glm-ocr"))
}

fn prompt_for_ocr_model(model: &str) -> &'static str {
    if is_glm_ocr_model(model) {
        GLM_OCR_TEXT_RECOGNITION_PROMPT
    } else {
        DEFAULT_OCR_PROMPT
    }
}

fn extract_model_names(body: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();

    if let Some(models) = body.get("models").and_then(|value| value.as_array()) {
        for model in models {
            if let Some(name) = model
                .get("name")
                .or_else(|| model.get("model"))
                .and_then(|value| value.as_str())
            {
                names.push(name.to_string());
            }
        }
    }

    names
}

fn ocr_request_body(model: &str, image_base64: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "prompt": prompt_for_ocr_model(model),
        "images": [image_base64],
        "stream": false,
        "options": {
            "temperature": 0,
            "num_predict": OCR_NUM_PREDICT,
            "repeat_last_n": 2048,
            "repeat_penalty": 1.15
        }
    })
}

#[cfg(target_os = "windows")]
pub(super) async fn read_glm_ocr_from_image(
    window_snapshot: crate::app_detector::WindowSnapshot,
    image_base64: String,
    base_url: String,
    model: String,
) -> Result<OcrReadResult, String> {
    let base_url = http_base_url(&base_url)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("OCR model is empty".to_string());
    }

    let started = std::time::Instant::now();
    let image_bytes = decode_uploaded_base64(image_base64, "OCR image")?;
    let output =
        super::super::ocr_runtime::process_image(image_bytes, "png", &base_url, &model).await?;
    Ok(local_runtime_result(
        window_snapshot,
        model,
        started,
        output,
        None,
        None,
    ))
}

pub(super) async fn read_ocr_from_image(
    window_snapshot: crate::app_detector::WindowSnapshot,
    image_base64: String,
    base_url: String,
    model: String,
    client: &reqwest::Client,
) -> Result<OcrReadResult, String> {
    let base_url = http_base_url(&base_url)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("OCR model is empty".to_string());
    }

    let started = std::time::Instant::now();

    let body = ocr_request_body(&model, &image_base64);

    let response = client
        .post(format!("{}/api/generate", base_url))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OCR HTTP {}: {}", status, text));
    }

    let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let ocr_text = extract_ocr_text(&body).ok_or_else(|| "OCR returned empty text".to_string())?;

    Ok(OcrReadResult {
        app_name: window_snapshot.context.app_name,
        window_title: window_snapshot.context.window_title,
        app_type: window_snapshot.context.app_type,
        text: ocr_text,
        elapsed_ms: started.elapsed().as_millis() as u32,
        model,
        source_kind: None,
        source_name: None,
        page_count: None,
        route: Some("direct".to_string()),
        processing_reason: Some("direct-ollama".to_string()),
        warnings: None,
        degraded: Some(false),
        operation_id: None,
    })
}

#[cfg(target_os = "windows")]
fn local_runtime_result(
    window_snapshot: crate::app_detector::WindowSnapshot,
    model: String,
    started: std::time::Instant,
    output: super::super::ocr_runtime::LocalOcrOutput,
    source_kind: Option<String>,
    source_name: Option<String>,
) -> OcrReadResult {
    OcrReadResult {
        app_name: window_snapshot.context.app_name,
        window_title: window_snapshot.context.window_title,
        app_type: window_snapshot.context.app_type,
        text: output.text,
        elapsed_ms: started.elapsed().as_millis() as u32,
        model,
        source_kind,
        source_name,
        page_count: output.page_count,
        route: Some(output.route.to_string()),
        processing_reason: Some(output.reason),
        warnings: (!output.warnings.is_empty()).then_some(output.warnings),
        degraded: Some(output.degraded),
        operation_id: None,
    }
}

pub(super) async fn read_uploaded_ocr_from_images(
    file_name: String,
    images: Vec<UploadedOcrImage>,
    base_url: String,
    model: String,
    client: &reqwest::Client,
) -> Result<OcrReadResult, String> {
    let source_name = uploaded_source_name(&file_name);
    let page_count = images.len() as u32;
    let started = std::time::Instant::now();
    let mut model_name = model.trim().to_string();
    let mut pages = Vec::new();

    for (index, image) in images.into_iter().enumerate() {
        let page_result = read_ocr_from_image(
            uploaded_window_snapshot(&source_name),
            image.base64,
            base_url.clone(),
            model.clone(),
            client,
        )
        .await?;
        model_name = page_result.model;
        let text = page_result.text.trim();
        if page_count > 1 {
            pages.push(format!("## 第 {} 页\n\n{}", index + 1, text));
        } else {
            pages.push(text.to_string());
        }
    }

    Ok(OcrReadResult {
        app_name: "上传附件".to_string(),
        window_title: source_name.clone(),
        app_type: crate::llm::AppType::Document,
        text: pages.join("\n\n").trim().to_string(),
        elapsed_ms: started.elapsed().as_millis() as u32,
        model: model_name,
        source_kind: Some("upload".to_string()),
        source_name: Some(source_name),
        page_count: Some(page_count),
        route: Some("direct".to_string()),
        processing_reason: Some("direct-ollama".to_string()),
        warnings: None,
        degraded: Some(false),
        operation_id: None,
    })
}

#[cfg(target_os = "windows")]
pub(super) async fn read_uploaded_glm_ocr(
    file_name: String,
    mime_type: String,
    image_base64: Option<String>,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
    base_url: String,
    model: String,
) -> Result<OcrReadResult, String> {
    let source_name = uploaded_source_name(&file_name);
    let snapshot = uploaded_window_snapshot(&source_name);
    let started = std::time::Instant::now();
    let output = if is_pdf_upload(&file_name, &mime_type) {
        let bytes = pdf_bytes_from_upload(file_base64, file_bytes)?;
        validate_uploaded_pdf_bytes(&bytes)?;
        super::super::ocr_runtime::process_pdf(bytes, &base_url, &model).await?
    } else if is_image_upload(&file_name, &mime_type) {
        let image = image_base64_from_upload(image_base64)?
            .into_iter()
            .next()
            .ok_or_else(|| "Uploaded image is empty".to_string())?;
        let bytes = decode_uploaded_base64(image, "Uploaded image")?;
        validate_uploaded_image_bytes(&bytes)?;
        let extension = uploaded_image_extension_from_bytes(&bytes)?;
        super::super::ocr_runtime::process_image(bytes, extension, &base_url, &model).await?
    } else {
        return Err(
            "Unsupported OCR file type. Please upload PNG, JPG, WebP, BMP, or PDF.".to_string(),
        );
    };

    Ok(local_runtime_result(
        snapshot,
        model,
        started,
        output,
        Some("upload".to_string()),
        Some(source_name),
    ))
}

pub(super) async fn ollama_model_available(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
) -> Result<bool, String> {
    let response = client
        .get(format!("{base_url}/api/tags"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(false);
    };

    if !response.status().is_success() {
        return Ok(false);
    }

    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(extract_model_names(&body)
        .iter()
        .any(|candidate| model_matches(candidate, model)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_latest_model_suffix() {
        assert!(model_matches("glm-ocr:latest", "glm-ocr"));
        assert!(model_matches("glm-ocr", "glm-ocr:latest"));
        assert!(!model_matches("qwen", "glm-ocr"));
    }

    #[test]
    fn extracts_ollama_model_names() {
        let ollama = serde_json::json!({
            "models": [
                { "name": "glm-ocr:latest" },
                { "model": "qwen:latest" }
            ]
        });
        assert_eq!(
            extract_model_names(&ollama),
            vec!["glm-ocr:latest".to_string(), "qwen:latest".to_string()]
        );
    }

    #[test]
    fn prompt_requires_complete_markdown_output() {
        assert!(DEFAULT_OCR_PROMPT.contains("完整读取"));
        assert!(DEFAULT_OCR_PROMPT.contains("不要摘要"));
        assert!(DEFAULT_OCR_PROMPT.contains("只输出工整 Markdown"));
        assert!(DEFAULT_OCR_PROMPT.contains("所有可见文字"));
        assert!(DEFAULT_OCR_PROMPT.contains("标准 Markdown 表格"));
        assert!(DEFAULT_OCR_PROMPT.contains("不要重复输出"));
        assert!(OCR_NUM_PREDICT >= 16384);
    }

    #[test]
    fn ollama_ocr_request_does_not_force_json_mode() {
        let body = ocr_request_body("glm-ocr:latest", "image");

        assert_eq!(body["model"], "glm-ocr:latest");
        assert_eq!(body["prompt"], "Text Recognition:");
        assert_eq!(body["images"][0], "image");
        assert!(body.get("format").is_none());
        assert_eq!(body["options"]["num_predict"], OCR_NUM_PREDICT);
        assert_eq!(body["options"]["repeat_last_n"], 2048);
        assert_eq!(body["options"]["repeat_penalty"], 1.15);
    }

    #[test]
    fn generic_ollama_vision_models_keep_the_detailed_ocr_prompt() {
        let body = ocr_request_body("qwen2.5vl:latest", "image");

        assert_eq!(body["prompt"], DEFAULT_OCR_PROMPT);
        assert!(body["prompt"].as_str().unwrap().contains("完整读取"));
    }
}
