use super::{render_pdf_bytes_for_ocr, strip_data_url_prefix};
use base64::{engine::general_purpose, Engine as _};

const OCR_UPLOAD_MAX_BYTES: usize = 25 * 1024 * 1024;
const OCR_UPLOAD_MAX_BASE64_BYTES: usize = OCR_UPLOAD_MAX_BYTES.div_ceil(3) * 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UploadedOcrImage {
    pub(super) base64: String,
    pub(super) mime_type: &'static str,
    pub(super) document_page: bool,
}

pub(super) fn is_pdf_upload(file_name: &str, mime_type: &str) -> bool {
    let mime = mime_type.trim().to_ascii_lowercase();
    if matches!(mime.as_str(), "application/pdf" | "application/x-pdf") {
        return true;
    }
    (mime.is_empty() || mime == "application/octet-stream")
        && file_name.to_ascii_lowercase().ends_with(".pdf")
}

pub(super) fn is_image_upload(file_name: &str, mime_type: &str) -> bool {
    let mime = mime_type.trim().to_ascii_lowercase();
    if !mime.is_empty() && mime != "application/octet-stream" {
        return matches!(
            mime.as_str(),
            "image/png"
                | "image/jpeg"
                | "image/jpg"
                | "image/webp"
                | "image/bmp"
                | "image/x-bmp"
                | "image/x-ms-bmp"
        );
    }

    let name = file_name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".bmp"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

pub(super) fn image_base64_from_upload(
    image_base64: Option<String>,
) -> Result<Vec<String>, String> {
    let image_base64 = image_base64
        .map(|value| strip_data_url_prefix(&value).to_string())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Uploaded image is empty".to_string())?;
    Ok(vec![image_base64])
}

pub(super) fn decode_uploaded_base64(file_base64: String, label: &str) -> Result<Vec<u8>, String> {
    let payload = strip_data_url_prefix(&file_base64);
    if payload.trim().is_empty() {
        return Err(format!("{label} is empty"));
    }
    if payload.len() > OCR_UPLOAD_MAX_BASE64_BYTES {
        return Err(format!("{label} is too large; please keep it under 25 MB"));
    }

    let bytes = general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("{label} base64 decode failed: {e}"))?;
    if bytes.len() > OCR_UPLOAD_MAX_BYTES {
        return Err(format!("{label} is too large; please keep it under 25 MB"));
    }
    Ok(bytes)
}

pub(super) fn pdf_bytes_from_upload(
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    if let Some(file_base64) = file_base64.filter(|value| !value.trim().is_empty()) {
        return decode_uploaded_base64(file_base64, "Uploaded PDF");
    }

    file_bytes.ok_or_else(|| "Uploaded PDF is empty".to_string())
}

pub(super) fn validate_uploaded_pdf_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Uploaded PDF is empty".to_string());
    }
    if bytes.len() > OCR_UPLOAD_MAX_BYTES {
        return Err("Uploaded PDF is too large; please keep it under 25 MB".to_string());
    }
    if !bytes[..bytes.len().min(1024)]
        .windows(b"%PDF-".len())
        .any(|window| window == b"%PDF-")
    {
        return Err("Uploaded file does not contain a valid PDF signature".to_string());
    }
    Ok(())
}

pub(super) fn uploaded_image_extension_from_bytes(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok("jpg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Ok("webp");
    }
    if bytes.starts_with(b"BM") {
        return Ok("bmp");
    }
    Err("Uploaded file is not a supported PNG, JPG, WebP, or BMP image".to_string())
}

fn uploaded_image_mime_type_from_bytes(bytes: &[u8]) -> Result<&'static str, String> {
    match uploaded_image_extension_from_bytes(bytes)? {
        "png" => Ok("image/png"),
        "jpg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "bmp" => Ok("image/bmp"),
        _ => Err("Uploaded image format does not have a canonical MIME type".to_string()),
    }
}

pub(super) fn validate_uploaded_image_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Uploaded image is empty".to_string());
    }
    if bytes.len() > OCR_UPLOAD_MAX_BYTES {
        return Err("Uploaded image is too large; please keep it under 25 MB".to_string());
    }
    uploaded_image_extension_from_bytes(bytes)?;
    Ok(())
}

pub(super) fn uploaded_images_from_payload(
    file_name: &str,
    mime_type: &str,
    image_base64: Option<String>,
    file_base64: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<Vec<UploadedOcrImage>, String> {
    if is_pdf_upload(file_name, mime_type) {
        let bytes = pdf_bytes_from_upload(file_base64, file_bytes)?;
        validate_uploaded_pdf_bytes(&bytes)?;
        return render_pdf_bytes_for_ocr(bytes).map(|pages| {
            pages
                .into_iter()
                .map(|base64| UploadedOcrImage {
                    base64,
                    mime_type: "image/png",
                    document_page: true,
                })
                .collect()
        });
    }

    if is_image_upload(file_name, mime_type) {
        let images = image_base64_from_upload(image_base64)?;
        let bytes = decode_uploaded_base64(images[0].clone(), "Uploaded image")?;
        validate_uploaded_image_bytes(&bytes)?;
        let canonical_mime_type = uploaded_image_mime_type_from_bytes(&bytes)?;
        return Ok(images
            .into_iter()
            .map(|base64| UploadedOcrImage {
                base64,
                mime_type: canonical_mime_type,
                document_page: false,
            })
            .collect());
    }

    Err("Unsupported OCR file type. Please upload PNG, JPG, WebP, BMP, or PDF.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_upload_types() {
        assert!(is_image_upload("table.PNG", ""));
        assert!(is_image_upload("scan", "image/webp"));
        assert!(is_pdf_upload("report.pdf", ""));
        assert!(is_pdf_upload("report", "application/pdf"));
        assert!(!is_image_upload("animation.gif", "image/gif"));
        assert!(!is_image_upload("vector.svg", "image/svg+xml"));
        assert!(!is_image_upload("scan.tiff", "image/tiff"));
        assert!(!is_image_upload("notes.txt", "text/plain"));
        assert!(!is_pdf_upload("notes.txt", "text/plain"));
    }

    #[test]
    fn rejects_payloads_that_do_not_match_supported_file_signatures() {
        assert!(validate_uploaded_pdf_bytes(b"not a pdf").is_err());
        assert!(validate_uploaded_image_bytes(b"not an image").is_err());
        assert!(validate_uploaded_pdf_bytes(&vec![b'x'; OCR_UPLOAD_MAX_BYTES + 1]).is_err());
    }

    #[test]
    fn detects_supported_image_formats_from_content_instead_of_file_names() {
        assert_eq!(
            uploaded_image_extension_from_bytes(b"\x89PNG\r\n\x1a\nrest").unwrap(),
            "png"
        );
        assert_eq!(
            uploaded_image_extension_from_bytes(&[0xff, 0xd8, 0xff, 0x00]).unwrap(),
            "jpg"
        );
        assert_eq!(
            uploaded_image_extension_from_bytes(b"RIFF\x00\x00\x00\x00WEBPrest").unwrap(),
            "webp"
        );
        assert_eq!(
            uploaded_image_extension_from_bytes(b"BMrest").unwrap(),
            "bmp"
        );
        assert!(uploaded_image_extension_from_bytes(b"GIF89a").is_err());
        assert!(uploaded_image_extension_from_bytes(b"<svg></svg>").is_err());
    }

    #[test]
    fn derives_canonical_proxy_mime_from_validated_image_magic() {
        let cases = [
            (b"\x89PNG\r\n\x1a\nrest".as_slice(), "image/png"),
            (&[0xff, 0xd8, 0xff, 0x00], "image/jpeg"),
            (b"RIFF\x00\x00\x00\x00WEBPrest".as_slice(), "image/webp"),
            (b"BMrest".as_slice(), "image/bmp"),
        ];

        for (bytes, expected_mime) in cases {
            assert_eq!(
                uploaded_image_mime_type_from_bytes(bytes).unwrap(),
                expected_mime
            );
            let images = uploaded_images_from_payload(
                "misleading.png",
                "image/png",
                Some(general_purpose::STANDARD.encode(bytes)),
                None,
                None,
            )
            .unwrap();
            assert_eq!(images.len(), 1);
            assert_eq!(images[0].mime_type, expected_mime);
            assert!(!images[0].document_page);
        }
    }

    #[test]
    fn strips_uploaded_data_url_prefix() {
        assert_eq!(
            strip_data_url_prefix("data:image/png;base64,aGVsbG8="),
            "aGVsbG8="
        );
        assert_eq!(strip_data_url_prefix(" plain "), "plain");
    }
}
