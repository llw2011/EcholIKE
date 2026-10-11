use super::payload::UploadedOcrImage;
use super::pdf_render::PDF_RENDER_MAX_PAGES;
use super::text::clean_ocr_text;
use super::{http_base_url, uploaded_source_name, uploaded_window_snapshot, OcrReadResult};
use serde::Deserialize;

const OCR_PROXY_CLIENT_TIMEOUT_SECS: u64 = 135;
const OCR_PDF_PROXY_CLIENT_TIMEOUT_SECS: u64 = 930;
const OCR_PROXY_RESPONSE_MAX_BYTES: usize = 8 * 1024 * 1024;
const OCR_PDF_PROXY_RESPONSE_MAX_BYTES: usize = 16 * 1024 * 1024;
const OCR_PROXY_RETRY_WINDOW_SECS: u64 = 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcrProxyResponseBody {
    text: String,
    model: Option<String>,
    route: Option<String>,
    processing_reason: Option<String>,
    warnings: Option<Vec<String>>,
    degraded: Option<bool>,
    page_count: Option<u32>,
    request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedOcrProxyResponse {
    text: String,
    model: String,
    route: Option<String>,
    processing_reason: Option<String>,
    warnings: Option<Vec<String>>,
    degraded: Option<bool>,
    page_count: Option<u32>,
    request_id: Option<String>,
}

fn proxy_endpoint(api_base_url: &str, path: &str) -> Result<String, String> {
    Ok(format!("{}{}", http_base_url(api_base_url)?, path))
}

fn ocr_proxy_request_body(
    image_base64: &str,
    image_mime_type: &str,
    document_page: bool,
) -> serde_json::Value {
    serde_json::json!({
        "contractVersion": 2,
        "imageBase64": image_base64,
        "imageMimeType": image_mime_type,
        "documentPage": document_page,
    })
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalized_proxy_warnings(warnings: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut normalized = Vec::new();
    for warning in warnings.into_iter().flatten() {
        let warning = warning.trim().to_string();
        if !warning.is_empty() && !normalized.contains(&warning) {
            normalized.push(warning);
        }
    }
    (!normalized.is_empty()).then_some(normalized)
}

fn parse_ocr_proxy_response(
    text: &str,
    document_page: bool,
) -> Result<ParsedOcrProxyResponse, String> {
    let body: OcrProxyResponseBody =
        serde_json::from_str(text).map_err(|e| format!("OCR proxy returned invalid JSON: {e}"))?;
    let warnings = normalized_proxy_warnings(body.warnings);
    let ocr_text = clean_ocr_text(&body.text);
    let declared_blank_page = document_page
        && body.degraded == Some(true)
        && warnings
            .as_ref()
            .is_some_and(|warnings| !warnings.is_empty());
    if ocr_text.is_empty() && !declared_blank_page {
        return Err("OCR proxy returned empty text".to_string());
    }

    Ok(ParsedOcrProxyResponse {
        text: ocr_text,
        model: normalized_optional_string(body.model).unwrap_or_else(|| "cloud-ocr".to_string()),
        route: normalized_optional_string(body.route),
        processing_reason: normalized_optional_string(body.processing_reason),
        warnings,
        degraded: body.degraded,
        page_count: body.page_count.filter(|page_count| *page_count > 0),
        request_id: normalized_optional_string(body.request_id),
    })
}

fn parse_pdf_proxy_response(text: &str) -> Result<ParsedOcrProxyResponse, String> {
    let body: OcrProxyResponseBody = serde_json::from_str(text)
        .map_err(|error| format!("PDF OCR proxy returned invalid JSON: {error}"))?;
    if normalized_optional_string(body.model).is_none() {
        return Err("PDF OCR proxy response is missing model".to_string());
    }
    let parsed = parse_ocr_proxy_response(text, false)?;
    if parsed.route.as_deref() != Some("pipeline") {
        return Err("PDF OCR proxy returned a non-pipeline result".to_string());
    }
    if parsed.processing_reason.as_deref() != Some("server-pdf-pipeline") {
        return Err("PDF OCR proxy returned an incompatible processingReason".to_string());
    }
    if parsed.request_id.is_none() {
        return Err("PDF OCR proxy response is missing requestId".to_string());
    }
    match parsed.page_count {
        Some(1..=PDF_RENDER_MAX_PAGES) => Ok(parsed),
        Some(page_count) => Err(format!(
            "PDF OCR proxy returned invalid page count {page_count}"
        )),
        None => Err("PDF OCR proxy response is missing pageCount".to_string()),
    }
}

fn consistent_proxy_page_metadata<'a>(
    mut values: impl Iterator<Item = Option<&'a str>>,
) -> Option<String> {
    let first = values.next()??;
    values
        .all(|value| value == Some(first))
        .then(|| first.to_string())
}

fn aggregate_uploaded_proxy_results(
    source_name: String,
    page_results: Vec<OcrReadResult>,
    document_pages: bool,
    elapsed_ms: u32,
) -> Result<OcrReadResult, String> {
    if page_results.is_empty() {
        return Err("OCR proxy returned no pages".to_string());
    }
    if document_pages
        && page_results
            .iter()
            .all(|result| result.text.trim().is_empty())
    {
        return Err("OCR proxy returned no text for any PDF page".to_string());
    }

    let page_count = page_results.len() as u32;
    let model = page_results
        .last()
        .map(|result| result.model.clone())
        .unwrap_or_else(|| "cloud-ocr".to_string());
    let route = if document_pages {
        Some("direct".to_string())
    } else {
        consistent_proxy_page_metadata(page_results.iter().map(|result| result.route.as_deref()))
    };
    let processing_reason = if document_pages {
        Some("client-pdf-rasterization".to_string())
    } else {
        consistent_proxy_page_metadata(
            page_results
                .iter()
                .map(|result| result.processing_reason.as_deref()),
        )
    };
    let mut warnings = Vec::new();
    let mut saw_degraded = false;
    let mut degraded = false;
    for result in &page_results {
        for warning in result.warnings.iter().flatten() {
            let warning = warning.trim().to_string();
            if !warning.is_empty() && !warnings.contains(&warning) {
                warnings.push(warning);
            }
        }
        if let Some(value) = result.degraded {
            saw_degraded = true;
            degraded |= value;
        }
    }
    if document_pages {
        let warning = "PDF 已由桌面端分页后兼容识别，请核对跨页排版和复杂结构。".to_string();
        if !warnings.contains(&warning) {
            warnings.push(warning);
        }
        saw_degraded = true;
        degraded = true;
    }

    let pages = page_results
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            let text = result.text.trim();
            if page_count > 1 || (document_pages && text.is_empty()) {
                format!("## 第 {} 页\n\n{}", index + 1, text)
            } else {
                text.to_string()
            }
        })
        .collect::<Vec<_>>();

    Ok(OcrReadResult {
        app_name: "上传附件".to_string(),
        window_title: source_name.clone(),
        app_type: crate::llm::AppType::Document,
        text: pages.join("\n\n").trim().to_string(),
        elapsed_ms,
        model,
        source_kind: Some("upload".to_string()),
        source_name: Some(source_name),
        page_count: Some(page_count),
        route,
        processing_reason,
        warnings: (!warnings.is_empty()).then_some(warnings),
        degraded: saw_degraded.then_some(degraded),
        operation_id: None,
    })
}

pub(super) async fn read_ocr_proxy_from_image(
    window_snapshot: crate::app_detector::WindowSnapshot,
    image_base64: String,
    image_mime_type: &'static str,
    document_page: bool,
    api_base_url: String,
    token: String,
    idempotency_key: Option<String>,
    registry: &crate::idempotency::Registry,
    client: &reqwest::Client,
) -> Result<OcrReadResult, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Auth token is empty".to_string());
    }

    let endpoint = proxy_endpoint(&api_base_url, "/proxy/ocr")?;
    let started = std::time::Instant::now();
    let body = ocr_proxy_request_body(&image_base64, image_mime_type, document_page);
    let persistent_operation = if idempotency_key.is_none() {
        let semantic_body = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
        Some(registry.acquire_authenticated(
            "ocr-image",
            &api_base_url,
            &token,
            &[&semantic_body],
        )?)
    } else {
        None
    };
    let operation_key = idempotency_key.unwrap_or_else(|| {
        persistent_operation
            .as_ref()
            .expect("persistent OCR operation was acquired")
            .root()
            .to_string()
    });
    let operation_id = persistent_operation
        .as_ref()
        .map(|operation| operation.root().to_string());
    let build = || {
        client
            .post(&endpoint)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .json(&body)
    };
    let attempt_timeout = std::time::Duration::from_secs(OCR_PROXY_CLIENT_TIMEOUT_SECS);
    let retry_window = std::time::Duration::from_secs(OCR_PROXY_RETRY_WINDOW_SECS);
    let response = crate::idempotency::execute_buffered_with_key(
        operation_key,
        attempt_timeout,
        retry_window,
        OCR_PROXY_RESPONSE_MAX_BYTES,
        build,
    )
    .await?;

    let status = response.status;
    let text = String::from_utf8(response.body)
        .map_err(|_| "OCR proxy returned a non-UTF-8 response".to_string())?;
    if !status.is_success() {
        if crate::idempotency::response_retires_operation(status, text.as_bytes()) {
            if let Some(operation) = &persistent_operation {
                operation.retire()?;
            }
        }
        return Err(super::super::backend::structured_backend_error(
            "ocr",
            status,
            &text,
            "OCR 识别失败。",
        ));
    }

    let parsed = parse_ocr_proxy_response(&text, document_page)?;

    let result = OcrReadResult {
        app_name: window_snapshot.context.app_name,
        window_title: window_snapshot.context.window_title,
        app_type: window_snapshot.context.app_type,
        text: parsed.text,
        elapsed_ms: started.elapsed().as_millis() as u32,
        model: parsed.model,
        source_kind: None,
        source_name: None,
        page_count: parsed.page_count,
        route: parsed.route,
        processing_reason: parsed.processing_reason,
        warnings: parsed.warnings,
        degraded: parsed.degraded,
        operation_id,
    };
    Ok(result)
}

fn pdf_proxy_protocol_error(reason: &str) -> String {
    tracing::error!(
        reason,
        "Server PDF OCR response violated the negotiated contract"
    );
    pdf_proxy_failed_error()
}

fn pdf_proxy_failed_error() -> String {
    serde_json::json!({
        "service": "ocr",
        "status": 502,
        "code": "ocr_failed",
        "message": "PDF OCR request failed"
    })
    .to_string()
}

async fn request_pdf_proxy(
    client: &reqwest::Client,
    api_base_url: &str,
    token: &str,
    pdf_bytes: Vec<u8>,
    idempotency_key: String,
) -> Result<ParsedOcrProxyResponse, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Auth token is empty".to_string());
    }

    let endpoint = proxy_endpoint(api_base_url, "/proxy/ocr/document")?;
    let response = crate::idempotency::execute_buffered_with_key(
        idempotency_key,
        std::time::Duration::from_secs(OCR_PDF_PROXY_CLIENT_TIMEOUT_SECS),
        std::time::Duration::from_secs(OCR_PROXY_RETRY_WINDOW_SECS),
        OCR_PDF_PROXY_RESPONSE_MAX_BYTES,
        || {
            let document = reqwest::multipart::Part::bytes(pdf_bytes.clone())
                .file_name("document.pdf")
                .mime_str("application/pdf")
                .expect("static PDF MIME should be valid");
            client
                .post(&endpoint)
                .bearer_auth(&token)
                .multipart(reqwest::multipart::Form::new().part("document", document))
        },
    )
    .await
    .map_err(|error| {
        tracing::warn!(error, "Server PDF OCR idempotent request failed");
        pdf_proxy_failed_error()
    })?;
    let status = response.status;
    let text = String::from_utf8(response.body)
        .map_err(|_| pdf_proxy_protocol_error("response body is not UTF-8"))?;
    if !status.is_success() {
        return Err(super::super::backend::structured_backend_error(
            "ocr",
            status,
            &text,
            "PDF 识别失败。",
        ));
    }

    parse_pdf_proxy_response(&text).map_err(|error| pdf_proxy_protocol_error(&error))
}

pub(super) async fn read_uploaded_ocr_proxy_from_pdf(
    file_name: String,
    pdf_bytes: Vec<u8>,
    api_base_url: String,
    token: String,
    registry: &crate::idempotency::Registry,
    client: &reqwest::Client,
) -> Result<OcrReadResult, String> {
    let source_name = uploaded_source_name(&file_name);
    let started = std::time::Instant::now();
    let persistent_operation =
        registry.acquire_authenticated("ocr-document", &api_base_url, &token, &[&pdf_bytes])?;
    let parsed = match request_pdf_proxy(
        client,
        &api_base_url,
        &token,
        pdf_bytes,
        persistent_operation.root().to_string(),
    )
    .await
    {
        Ok(parsed) => parsed,
        Err(error) => {
            if crate::idempotency::error_retires_operation(&error) {
                persistent_operation.retire()?;
            }
            return Err(error);
        }
    };
    if let Some(request_id) = parsed.request_id.as_deref() {
        tracing::debug!(request_id, "Server PDF OCR completed");
    }
    Ok(OcrReadResult {
        app_name: "上传附件".to_string(),
        window_title: source_name.clone(),
        app_type: crate::llm::AppType::Document,
        text: parsed.text,
        elapsed_ms: started.elapsed().as_millis() as u32,
        model: parsed.model,
        source_kind: Some("upload".to_string()),
        source_name: Some(source_name),
        page_count: parsed.page_count,
        route: parsed.route,
        processing_reason: parsed.processing_reason,
        warnings: parsed.warnings,
        degraded: parsed.degraded,
        operation_id: Some(persistent_operation.root().to_string()),
    })
}

pub(super) async fn read_uploaded_ocr_proxy_from_images(
    file_name: String,
    images: Vec<UploadedOcrImage>,
    api_base_url: String,
    token: String,
    idempotency_parent: Option<String>,
    registry: &crate::idempotency::Registry,
    client: &reqwest::Client,
) -> Result<OcrReadResult, String> {
    let source_name = uploaded_source_name(&file_name);
    let started = std::time::Instant::now();
    let document_pages = images.first().is_some_and(|image| image.document_page)
        && images.iter().all(|image| image.document_page);
    let mut page_results = Vec::with_capacity(images.len());
    let page_count = (images.len() as u64).to_be_bytes();
    let mut semantic_parts = vec![source_name.as_bytes(), page_count.as_slice()];
    if let Some(parent) = idempotency_parent.as_deref() {
        semantic_parts.push(parent.as_bytes());
    } else {
        for image in &images {
            semantic_parts.push(image.mime_type.as_bytes());
            semantic_parts.push(image.base64.as_bytes());
        }
    }
    let persistent_operation =
        registry.acquire_authenticated("ocr-upload", &api_base_url, &token, &semantic_parts)?;

    for (index, image) in images.into_iter().enumerate() {
        let page_index = (index as u64).to_be_bytes();
        let child_key = crate::idempotency::derived_key(
            "ocr-page",
            &[
                persistent_operation.root().as_bytes(),
                &page_index,
                image.mime_type.as_bytes(),
                image.base64.as_bytes(),
            ],
        );
        let page_result = read_ocr_proxy_from_image(
            uploaded_window_snapshot(&source_name),
            image.base64,
            image.mime_type,
            image.document_page,
            api_base_url.clone(),
            token.clone(),
            Some(child_key),
            registry,
            client,
        )
        .await;
        let page_result = match page_result {
            Ok(result) => result,
            Err(error) => {
                if crate::idempotency::error_retires_operation(&error) {
                    persistent_operation.retire()?;
                }
                return Err(error);
            }
        };
        page_results.push(page_result);
    }

    let mut result = aggregate_uploaded_proxy_results(
        source_name,
        page_results,
        document_pages,
        started.elapsed().as_millis() as u32,
    )?;
    result.operation_id = Some(persistent_operation.root().to_string());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy_page_result(
        text: &str,
        route: Option<&str>,
        reason: Option<&str>,
        warnings: &[&str],
        degraded: Option<bool>,
    ) -> OcrReadResult {
        OcrReadResult {
            app_name: "上传附件".to_string(),
            window_title: "report.pdf".to_string(),
            app_type: crate::llm::AppType::Document,
            text: text.to_string(),
            elapsed_ms: 1,
            model: "cloud-ocr".to_string(),
            source_kind: None,
            source_name: None,
            page_count: Some(1),
            route: route.map(ToString::to_string),
            processing_reason: reason.map(ToString::to_string),
            warnings: (!warnings.is_empty())
                .then(|| warnings.iter().map(|value| (*value).to_string()).collect()),
            degraded,
            operation_id: None,
        }
    }

    #[test]
    fn proxy_request_declares_mime_and_document_page_explicitly() {
        let body = ocr_proxy_request_body("encoded", "image/webp", true);

        assert_eq!(body["imageBase64"], "encoded");
        assert_eq!(body["imageMimeType"], "image/webp");
        assert_eq!(body["documentPage"], true);
        assert_eq!(body["contractVersion"], 2);
        assert_eq!(OCR_PROXY_CLIENT_TIMEOUT_SECS, 135);
    }

    #[test]
    fn parses_only_complete_server_pipeline_pdf_responses() {
        let parsed = parse_pdf_proxy_response(
            r##"{
                "text":"# document",
                "model":"glm-ocr:latest",
                "route":"pipeline",
                "processingReason":"server-pdf-pipeline",
                "warnings":["check blank page"],
                "degraded":true,
                "pageCount":20,
                "requestId":"req-pdf-1"
            }"##,
        )
        .unwrap();

        assert_eq!(parsed.text, "# document");
        assert_eq!(parsed.route.as_deref(), Some("pipeline"));
        assert_eq!(parsed.page_count, Some(20));
        assert_eq!(parsed.request_id.as_deref(), Some("req-pdf-1"));
        assert_eq!(OCR_PDF_PROXY_CLIENT_TIMEOUT_SECS, 930);

        for invalid in [
            r#"{"text":"","model":"glm-ocr","route":"pipeline","processingReason":"server-pdf-pipeline","pageCount":1,"requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"direct","pageCount":1,"requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"pipeline","pageCount":1,"requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"pipeline","processingReason":"other-pipeline","pageCount":1,"requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"pipeline","processingReason":"server-pdf-pipeline","requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"pipeline","processingReason":"server-pdf-pipeline","pageCount":0,"requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"pipeline","processingReason":"server-pdf-pipeline","pageCount":21,"requestId":"req"}"#,
            r#"{"text":"ok","route":"pipeline","processingReason":"server-pdf-pipeline","pageCount":1,"requestId":"req"}"#,
            r#"{"text":"ok","model":"glm-ocr","route":"pipeline","processingReason":"server-pdf-pipeline","pageCount":1}"#,
        ] {
            assert!(
                parse_pdf_proxy_response(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[tokio::test]
    async fn pdf_proxy_sends_original_bytes_once_as_the_document_multipart() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let original = b"%PDF-1.7\nunique-echolike-pdf-payload\n%%EOF".to_vec();
        let expected = original.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let header_end;
            loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "client closed before sending request headers");
                request.extend_from_slice(&chunk[..read]);
                if let Some(index) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                    header_end = index + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .expect("multipart request should declare content-length");
            while request.len() < header_end + content_length {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "client closed before sending the multipart body");
                request.extend_from_slice(&chunk[..read]);
            }
            let body = &request[header_end..header_end + content_length];

            assert!(headers.starts_with("post /proxy/ocr/document http/1.1"));
            assert!(headers.contains("authorization: bearer test-token"));
            assert!(headers.contains("x-idempotency-key: test-pdf-operation"));
            assert!(headers.contains("content-type: multipart/form-data; boundary="));
            let body_text = String::from_utf8_lossy(body).to_ascii_lowercase();
            assert!(body_text.contains("name=\"document\""));
            assert!(body_text.contains("filename=\"document.pdf\""));
            assert!(!body_text.contains("report.pdf"));
            assert!(body_text.contains("content-type: application/pdf"));
            assert_eq!(
                body.windows(expected.len())
                    .filter(|window| *window == expected.as_slice())
                    .count(),
                1
            );

            let response = r##"{"text":"# ok","model":"glm-ocr:latest","route":"pipeline","processingReason":"server-pdf-pipeline","warnings":[],"degraded":false,"pageCount":1,"requestId":"req-pdf-wire"}"##;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });

        let client = reqwest::Client::new();
        let parsed = request_pdf_proxy(
            &client,
            &format!("http://{address}"),
            "test-token",
            original,
            "test-pdf-operation".to_string(),
        )
        .await
        .unwrap();
        server.join().unwrap();

        assert_eq!(parsed.route.as_deref(), Some("pipeline"));
        assert_eq!(parsed.page_count, Some(1));
        assert_eq!(parsed.request_id.as_deref(), Some("req-pdf-wire"));
    }

    #[tokio::test]
    async fn pdf_proxy_preserves_structured_non_success_diagnostics() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let header_end;
            loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
                if let Some(index) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                    header_end = index + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap();
            while request.len() < header_end + content_length {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
            }

            let response = r#"{"code":"ocr_document_page_limit","message":"too many pages","requestId":"req-pdf-422"}"#;
            write!(
                stream,
                "HTTP/1.1 422 Unprocessable Content\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });

        let error = request_pdf_proxy(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "test-token",
            b"%PDF-1.7\n%%EOF".to_vec(),
            "test-pdf-error".to_string(),
        )
        .await
        .unwrap_err();
        server.join().unwrap();
        let diagnostic: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(diagnostic["service"], "ocr");
        assert_eq!(diagnostic["status"], 422);
        assert_eq!(diagnostic["code"], "ocr_document_page_limit");
        assert_eq!(diagnostic["requestId"], "req-pdf-422");
    }

    #[tokio::test]
    async fn pdf_proxy_connect_errors_are_structured_without_leaking_the_endpoint() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        let error = request_pdf_proxy(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "test-token",
            b"%PDF-1.7\n%%EOF".to_vec(),
            "test-pdf-connect".to_string(),
        )
        .await
        .unwrap_err();
        let diagnostic: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(diagnostic["service"], "ocr");
        assert_eq!(diagnostic["status"], 502);
        assert_eq!(diagnostic["code"], "ocr_failed");
        assert!(!error.contains(&address.to_string()));
        assert!(!error.contains("/proxy/ocr/document"));
    }

    #[test]
    fn parses_new_and_legacy_proxy_response_contracts() {
        let legacy =
            parse_ocr_proxy_response(r#"{"text":" legacy text ","model":"legacy-model"}"#, false)
                .unwrap();
        assert_eq!(legacy.text, "legacy text");
        assert_eq!(legacy.model, "legacy-model");
        assert_eq!(legacy.route, None);
        assert_eq!(legacy.processing_reason, None);
        assert_eq!(legacy.warnings, None);
        assert_eq!(legacy.degraded, None);
        assert_eq!(legacy.page_count, None);

        let current = parse_ocr_proxy_response(
            r##"{
                "text":"# result",
                "model":"glm-ocr",
                "route":"direct",
                "processingReason":"provider-direct",
                "warnings":[" check page ","","check page"],
                "degraded":true,
                "pageCount":2
            }"##,
            false,
        )
        .unwrap();
        assert_eq!(current.route.as_deref(), Some("direct"));
        assert_eq!(
            current.processing_reason.as_deref(),
            Some("provider-direct")
        );
        assert_eq!(current.warnings, Some(vec!["check page".to_string()]));
        assert_eq!(current.degraded, Some(true));
        assert_eq!(current.page_count, Some(2));
    }

    #[test]
    fn only_document_pages_accept_declared_blank_proxy_results() {
        let blank = r#"{
            "text":"",
            "model":"cloud-ocr",
            "route":"direct",
            "warnings":["This page appears blank"],
            "degraded":true,
            "pageCount":1
        }"#;

        assert!(parse_ocr_proxy_response(blank, false).is_err());
        let parsed = parse_ocr_proxy_response(blank, true).unwrap();
        assert!(parsed.text.is_empty());
        assert_eq!(parsed.page_count, Some(1));
    }

    #[test]
    fn rejects_missing_null_or_partially_declared_blank_proxy_results() {
        let invalid = [
            r#"{"model":"cloud-ocr","degraded":true,"warnings":["blank"]}"#,
            r#"{"text":null,"model":"cloud-ocr","degraded":true,"warnings":["blank"]}"#,
            r#"{"text":"","model":"cloud-ocr","degraded":false,"warnings":["blank"]}"#,
            r#"{"text":"","model":"cloud-ocr","degraded":true,"warnings":[]}"#,
        ];

        for response in invalid {
            assert!(parse_ocr_proxy_response(response, true).is_err());
        }
    }

    #[test]
    fn aggregates_proxy_pdf_metadata_and_preserves_declared_blank_pages() {
        let result = aggregate_uploaded_proxy_results(
            "report.pdf".to_string(),
            vec![
                proxy_page_result(
                    "first page",
                    Some("direct"),
                    Some("provider-direct"),
                    &["check layout"],
                    Some(false),
                ),
                proxy_page_result(
                    "",
                    Some("direct"),
                    Some("provider-direct"),
                    &["check layout", "blank page retained"],
                    Some(true),
                ),
            ],
            true,
            42,
        )
        .unwrap();

        assert_eq!(result.page_count, Some(2));
        assert_eq!(result.route.as_deref(), Some("direct"));
        assert_eq!(
            result.processing_reason.as_deref(),
            Some("client-pdf-rasterization")
        );
        assert_eq!(
            result.warnings,
            Some(vec![
                "check layout".to_string(),
                "blank page retained".to_string(),
                "PDF 已由桌面端分页后兼容识别，请核对跨页排版和复杂结构。".to_string()
            ])
        );
        assert_eq!(result.degraded, Some(true));
        assert_eq!(result.elapsed_ms, 42);
        assert!(result.text.contains("## 第 1 页\n\nfirst page"));
        assert!(result.text.ends_with("## 第 2 页"));
    }

    #[test]
    fn pins_client_rasterized_pdf_metadata_even_when_legacy_pages_omit_it() {
        let result = aggregate_uploaded_proxy_results(
            "scan.pdf".to_string(),
            vec![
                proxy_page_result("one", None, None, &[], None),
                proxy_page_result("two", None, None, &[], None),
            ],
            true,
            1,
        )
        .unwrap();

        assert_eq!(result.route.as_deref(), Some("direct"));
        assert_eq!(
            result.processing_reason.as_deref(),
            Some("client-pdf-rasterization")
        );
        assert_eq!(result.degraded, Some(true));
        assert!(result
            .warnings
            .as_ref()
            .is_some_and(|warnings| warnings.iter().any(|warning| warning.contains("兼容识别"))));
    }

    #[test]
    fn rejects_a_pdf_when_every_declared_page_is_blank() {
        let error = aggregate_uploaded_proxy_results(
            "blank.pdf".to_string(),
            vec![proxy_page_result(
                "",
                Some("direct"),
                Some("provider-direct"),
                &["blank page retained"],
                Some(true),
            )],
            true,
            1,
        )
        .unwrap_err();

        assert_eq!(error, "OCR proxy returned no text for any PDF page");
    }
}
