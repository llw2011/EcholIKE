use super::{export_safe_base_name, strip_data_url_prefix, PdfImageExportResult};
#[cfg(target_os = "windows")]
use super::{unique_temp_path, CREATE_NO_WINDOW};
use base64::{engine::general_purpose, Engine as _};
use std::io::{Cursor, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub(super) const PDF_RENDER_MAX_PAGES: u32 = 20;
const PDF_RENDER_OCR_SCALE: f64 = 1.75;
const PDF_RENDER_OCR_MAX_SIDE: u32 = 2200;
const PDF_RENDER_EXPORT_SCALE: f64 = 2.0;
const PDF_RENDER_EXPORT_MAX_SIDE: u32 = 3200;
const PDF_RENDER_NO_PAGES_MARKER: &str = "ECHOLIKE_PDF_NO_PAGES";
const PDF_RENDER_PAGE_LIMIT_MARKER: &str = "ECHOLIKE_PDF_PAGE_LIMIT";
const PDF_RENDER_GENERIC_ERROR: &str = "无法读取这份 PDF。请确认文件未损坏、未加密，然后重试。";
pub(super) const PDF_RENDER_TASK_ERROR: &str = "PDF 处理任务未能完成，请重试。";

fn export_base_name(file_name: &str) -> String {
    export_safe_base_name(file_name, "echolike-pdf")
}

fn pdf_page_image_name(base_name: &str, page_index: usize, page_count: usize) -> String {
    let width = page_count.to_string().len().max(2);
    format!(
        "{}-page-{:0width$}.png",
        base_name,
        page_index + 1,
        width = width
    )
}

#[cfg(target_os = "windows")]
const PDF_RENDER_SCRIPT: &str = r#"
param(
  [Parameter(Mandatory=$true)][string]$PdfPath,
  [int]$MaxPages = 20,
  [double]$Scale = 2.0,
  [double]$MaxSide = 3200.0
)

$ErrorActionPreference = 'Stop'
[void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
[void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskOperation = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
$asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } |
  Select-Object -First 1

function Await-Operation($Operation, [Type]$ResultType) {
  $task = $asTaskOperation.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
  return $task.Result
}

function Await-UInt32($Operation) {
  $task = $asTaskOperation.MakeGenericMethod([UInt32]).Invoke($null, @($Operation))
  $task.Wait()
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
  return $task.Result
}

function Await-Action($Action) {
  $task = $asTaskAction.Invoke($null, @($Action))
  $task.Wait()
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
}

$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$document = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$pageCount = [int]$document.PageCount
if ($pageCount -lt 1) {
  [Console]::Error.Write('ECHOLIKE_PDF_NO_PAGES')
  exit 3
}
if ($pageCount -gt $MaxPages) {
  [Console]::Error.Write("ECHOLIKE_PDF_PAGE_LIMIT|$pageCount|$MaxPages")
  exit 4
}

$pages = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $pageCount; $i++) {
  $page = $document.GetPage([uint32]$i)
  $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $reader = $null
  try {
    $rawWidth = [double]$page.Size.Width * [Math]::Max(0.5, $Scale)
    $rawHeight = [double]$page.Size.Height * [Math]::Max(0.5, $Scale)
    $boundedMaxSide = [Math]::Max(640.0, $MaxSide)
    $pageScale = [Math]::Min(1.0, $boundedMaxSide / [Math]::Max($rawWidth, $rawHeight))
    $width = [uint32][Math]::Max(1, [Math]::Round($rawWidth * $pageScale))
    $height = [uint32][Math]::Max(1, [Math]::Round($rawHeight * $pageScale))
    $options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
    $options.DestinationWidth = $width
    $options.DestinationHeight = $height

    Await-Action ($page.RenderToStreamAsync($stream, $options))
    $stream.Seek(0)
    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    $size = [uint32]$stream.Size
    [void](Await-UInt32 ($reader.LoadAsync($size)))
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    [void]$pages.Add([Convert]::ToBase64String($bytes))
  } finally {
    if ($null -ne $reader -and $reader -is [System.IDisposable]) { $reader.Dispose() }
    if ($stream -is [System.IDisposable]) { $stream.Dispose() }
    if ($page -is [System.IDisposable]) { $page.Dispose() }
  }
}

$jsonItems = @($pages.ToArray() | ForEach-Object { ConvertTo-Json -Compress -InputObject $_ })
[Console]::Out.Write("[$($jsonItems -join ',')]")
"#;

fn pdf_page_limit_from_marker(stderr: &str) -> Option<(u32, u32)> {
    stderr.lines().find_map(|line| {
        let mut fields = line.trim().split('|');
        if fields.next()? != PDF_RENDER_PAGE_LIMIT_MARKER {
            return None;
        }
        let page_count = fields.next()?.parse().ok()?;
        let max_pages = fields.next()?.parse().ok()?;
        if fields.next().is_some() {
            return None;
        }
        Some((page_count, max_pages))
    })
}

fn interpret_pdf_render_output(
    success: bool,
    status_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Vec<String>, String> {
    if !success {
        let stderr = String::from_utf8_lossy(stderr);
        if stderr
            .lines()
            .any(|line| line.trim() == PDF_RENDER_NO_PAGES_MARKER)
        {
            return Err("这份 PDF 没有可读取的页面，请检查文件后重试。".to_string());
        }
        if let Some((page_count, max_pages)) = pdf_page_limit_from_marker(&stderr) {
            return Err(format!(
                "这份 PDF 共 {page_count} 页，当前一次最多处理 {max_pages} 页。请拆分后重试。"
            ));
        }

        tracing::error!(
            status_code = ?status_code,
            stderr = %stderr.trim(),
            "PDF renderer process failed"
        );
        return Err(PDF_RENDER_GENERIC_ERROR.to_string());
    }

    let stdout = match std::str::from_utf8(stdout) {
        Ok(stdout) => stdout,
        Err(error) => {
            tracing::error!(%error, "PDF renderer returned non-UTF-8 output");
            return Err(PDF_RENDER_GENERIC_ERROR.to_string());
        }
    };
    let pages: Vec<String> = match serde_json::from_str(stdout.trim()) {
        Ok(pages) => pages,
        Err(error) => {
            tracing::error!(%error, "PDF renderer returned invalid JSON");
            return Err(PDF_RENDER_GENERIC_ERROR.to_string());
        }
    };
    if pages.is_empty() || pages.iter().any(|page| page.trim().is_empty()) {
        tracing::error!("PDF renderer returned one or more empty pages");
        return Err(PDF_RENDER_GENERIC_ERROR.to_string());
    }

    Ok(pages)
}

#[cfg(target_os = "windows")]
fn render_pdf_bytes_to_png_base64(
    file_bytes: Vec<u8>,
    scale: f64,
    max_side: u32,
) -> Result<Vec<String>, String> {
    let pdf_path = unique_temp_path("pdf");
    let script_path = unique_temp_path("ps1");

    if let Err(error) = std::fs::write(&pdf_path, file_bytes) {
        let _ = std::fs::remove_file(&pdf_path);
        tracing::error!(%error, "Failed to create the temporary PDF input");
        return Err(PDF_RENDER_TASK_ERROR.to_string());
    }
    if let Err(error) = std::fs::write(&script_path, PDF_RENDER_SCRIPT) {
        let _ = std::fs::remove_file(&pdf_path);
        let _ = std::fs::remove_file(&script_path);
        tracing::error!(%error, "Failed to create the temporary PDF renderer script");
        return Err(PDF_RENDER_TASK_ERROR.to_string());
    }

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .arg(&pdf_path)
        .arg(PDF_RENDER_MAX_PAGES.to_string())
        .arg(scale.to_string())
        .arg(max_side.to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| {
            tracing::error!(%error, "Failed to launch the PDF renderer process");
            PDF_RENDER_TASK_ERROR.to_string()
        });

    let _ = std::fs::remove_file(&pdf_path);
    let _ = std::fs::remove_file(&script_path);

    let output = output?;
    interpret_pdf_render_output(
        output.status.success(),
        output.status.code(),
        &output.stdout,
        &output.stderr,
    )
}

#[cfg(not(target_os = "windows"))]
fn render_pdf_bytes_to_png_base64(
    _file_bytes: Vec<u8>,
    _scale: f64,
    _max_side: u32,
) -> Result<Vec<String>, String> {
    Err("当前系统暂不支持 PDF 识别。".to_string())
}

pub(super) fn render_pdf_bytes_for_ocr(file_bytes: Vec<u8>) -> Result<Vec<String>, String> {
    render_pdf_bytes_to_png_base64(file_bytes, PDF_RENDER_OCR_SCALE, PDF_RENDER_OCR_MAX_SIDE)
}

pub(super) fn render_pdf_bytes_for_export(file_bytes: Vec<u8>) -> Result<Vec<String>, String> {
    render_pdf_bytes_to_png_base64(
        file_bytes,
        PDF_RENDER_EXPORT_SCALE,
        PDF_RENDER_EXPORT_MAX_SIDE,
    )
}

pub(super) fn build_pdf_image_export(
    file_name: &str,
    pages_base64: Vec<String>,
) -> Result<PdfImageExportResult, String> {
    let page_count = pages_base64.len();
    if page_count == 0 {
        return Err("PDF renderer returned empty pages".to_string());
    }

    let base_name = export_base_name(file_name);
    let pages = pages_base64
        .into_iter()
        .map(|page| {
            general_purpose::STANDARD
                .decode(strip_data_url_prefix(&page))
                .map_err(|e| format!("PDF page image decode failed: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    if page_count == 1 {
        return Ok(PdfImageExportResult {
            file_name: pdf_page_image_name(&base_name, 0, page_count),
            mime_type: "image/png".to_string(),
            page_count: 1,
            file_bytes: pages.into_iter().next().unwrap_or_default(),
        });
    }

    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for (index, page_bytes) in pages.into_iter().enumerate() {
        archive
            .start_file(pdf_page_image_name(&base_name, index, page_count), options)
            .map_err(|e| format!("PDF image zip failed: {e}"))?;
        archive
            .write_all(&page_bytes)
            .map_err(|e| format!("PDF image zip write failed: {e}"))?;
    }

    let cursor = archive
        .finish()
        .map_err(|e| format!("PDF image zip finalize failed: {e}"))?;

    Ok(PdfImageExportResult {
        file_name: format!("{base_name}-pages.zip"),
        mime_type: "application/zip".to_string(),
        page_count: page_count as u32,
        file_bytes: cursor.into_inner(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_page_limit_marker_returns_readable_error_without_powershell_details() {
        let error =
            interpret_pdf_render_output(false, Some(4), b"", b"ECHOLIKE_PDF_PAGE_LIMIT|68|20")
                .unwrap_err();

        assert_eq!(
            error,
            "这份 PDF 共 68 页，当前一次最多处理 20 页。请拆分后重试。"
        );
        assert!(!error.contains(PDF_RENDER_PAGE_LIMIT_MARKER));
        assert!(!error.contains("PowerShell"));
    }

    #[test]
    fn pdf_empty_document_marker_returns_readable_error() {
        assert_eq!(
            interpret_pdf_render_output(false, Some(3), b"", PDF_RENDER_NO_PAGES_MARKER.as_bytes(),),
            Err("这份 PDF 没有可读取的页面，请检查文件后重试。".to_string())
        );
    }

    #[test]
    fn pdf_renderer_error_record_is_logged_but_not_returned() {
        let error_record = br#"At C:\Users\TestUser\AppData\Local\Temp\echolike-ocr.ps1:51 char:3
+ throw 'PDF failed'
+ CategoryInfo : OperationStopped: (PDF failed:String) [], RuntimeException
+ FullyQualifiedErrorId : PDF failed"#;
        let error = interpret_pdf_render_output(false, Some(1), b"", error_record).unwrap_err();

        assert_eq!(error, PDF_RENDER_GENERIC_ERROR);
        for private_detail in ["C:\\Users", "CategoryInfo", "RuntimeException", "throw"] {
            assert!(!error.contains(private_detail));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pdf_render_script_uses_markers_instead_of_throwing_for_page_bounds() {
        assert!(PDF_RENDER_SCRIPT.contains("ECHOLIKE_PDF_NO_PAGES"));
        assert!(PDF_RENDER_SCRIPT.contains("ECHOLIKE_PDF_PAGE_LIMIT|$pageCount|$MaxPages"));
        assert!(!PDF_RENDER_SCRIPT.contains("throw 'PDF has no pages.'"));
        assert!(!PDF_RENDER_SCRIPT.contains("throw \"PDF has $pageCount pages"));
    }

    #[test]
    fn builds_single_page_pdf_image_export() {
        let result = build_pdf_image_export("report.pdf", vec!["aGVsbG8=".to_string()]).unwrap();

        assert_eq!(result.file_name, "report-page-01.png");
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.page_count, 1);
        assert_eq!(result.file_bytes, b"hello");
    }

    #[test]
    fn builds_multi_page_pdf_image_zip() {
        let result = build_pdf_image_export(
            "bad:/name.pdf",
            vec!["b25l".to_string(), "dHdv".to_string()],
        )
        .unwrap();

        assert_eq!(result.file_name, "bad-name-pages.zip");
        assert_eq!(result.mime_type, "application/zip");
        assert_eq!(result.page_count, 2);
        assert!(result.file_bytes.starts_with(b"PK"));

        let mut archive = zip::ZipArchive::new(Cursor::new(result.file_bytes)).unwrap();
        let mut first = archive.by_name("bad-name-page-01.png").unwrap();
        let mut first_bytes = Vec::new();
        std::io::Read::read_to_end(&mut first, &mut first_bytes).unwrap();
        assert_eq!(first_bytes, b"one");
    }
}
