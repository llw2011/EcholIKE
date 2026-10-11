use super::{uploaded_source_name, OpenedMarkdownFile};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const MARKDOWN_TEXT_MAX_BYTES: usize = 2 * 1024 * 1024;
const MARKDOWN_TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext", "txt",
];
const EXPORT_BASE_NAME_MAX_CHARS: usize = 80;

pub(super) fn export_safe_base_name(file_name: &str, fallback: &str) -> String {
    let name = uploaded_source_name(file_name);
    let without_extension = name.rsplit_once('.').map(|(base, _)| base).unwrap_or(&name);
    let mut cleaned = String::new();
    let mut last_dash = false;
    let mut last_space = false;

    for ch in without_extension.chars() {
        if matches!(
            ch,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\u{0}'..='\u{1f}'
        ) {
            if last_space {
                while cleaned.ends_with(' ') {
                    cleaned.pop();
                }
            }
            if !last_dash {
                cleaned.push('-');
            }
            last_dash = true;
            last_space = false;
            continue;
        }

        if ch.is_whitespace() {
            if last_dash {
                continue;
            }
            if !last_space {
                cleaned.push(' ');
            }
            last_dash = false;
            last_space = true;
            continue;
        }

        cleaned.push(ch);
        last_dash = false;
        last_space = false;
    }

    let mut cleaned = cleaned.trim_matches([' ', '.', '-']).to_string();
    if cleaned.is_empty() {
        cleaned = fallback.to_string();
    }
    if is_reserved_windows_file_base(&cleaned) {
        cleaned.push_str("-file");
    }

    let truncated = cleaned
        .chars()
        .take(EXPORT_BASE_NAME_MAX_CHARS)
        .collect::<String>()
        .trim_matches([' ', '.', '-'])
        .to_string();
    if truncated.is_empty() {
        fallback.to_string()
    } else {
        truncated
    }
}

fn is_reserved_windows_file_base(value: &str) -> bool {
    let upper = value.trim_matches('.').to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper[3..].chars().all(|ch| ('1'..='9').contains(&ch)))
}

fn export_safe_file_name(file_name: &str, fallback: &str) -> String {
    let raw_name = uploaded_source_name(file_name);
    let fallback_extension = file_extension(fallback).unwrap_or_default();
    let extension = file_extension(&raw_name).unwrap_or_else(|| fallback_extension.clone());
    let base_source = if extension.is_empty() {
        raw_name.as_str()
    } else {
        raw_name
            .strip_suffix(&extension)
            .unwrap_or(raw_name.as_str())
            .trim_end_matches('.')
    };
    let fallback_base = if fallback_extension.is_empty() {
        fallback
    } else {
        fallback
            .strip_suffix(&fallback_extension)
            .unwrap_or(fallback)
            .trim_end_matches('.')
    };

    format!(
        "{}{}",
        export_safe_base_name(base_source, fallback_base),
        extension
    )
}

fn file_extension(file_name: &str) -> Option<String> {
    let (_, extension) = file_name.rsplit_once('.')?;
    let extension = extension.trim();
    if extension.is_empty()
        || extension.len() > 8
        || !extension.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        return None;
    }

    Some(format!(".{extension}"))
}

fn select_export_directory(
    system_downloads: Option<PathBuf>,
    home_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    system_downloads.or_else(|| home_dir.map(|path| path.join("Downloads")))
}

fn environment_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let variables = ["USERPROFILE", "HOME"];
    #[cfg(not(target_os = "windows"))]
    let variables = ["HOME", "USERPROFILE"];

    variables.into_iter().find_map(|variable| {
        std::env::var_os(variable)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    })
}

fn resolve_export_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let system_downloads = app.path().download_dir();
    let system_error = system_downloads
        .as_ref()
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "unknown path".to_string());
    let home_dir = if system_downloads.is_err() {
        app.path().home_dir().ok().or_else(environment_home_dir)
    } else {
        None
    };

    select_export_directory(system_downloads.ok(), home_dir)
        .ok_or_else(|| format!("无法定位系统下载目录：{system_error}"))
}

fn next_available_export_path(downloads_dir: &Path, file_name: &str) -> PathBuf {
    let candidate = downloads_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let extension = file_extension(file_name).unwrap_or_default();
    let base = if extension.is_empty() {
        file_name.to_string()
    } else {
        file_name
            .strip_suffix(&extension)
            .unwrap_or(file_name)
            .trim_end_matches('.')
            .to_string()
    };

    for index in 1..1000 {
        let candidate = downloads_dir.join(format!("{base} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    downloads_dir.join(format!(
        "{base}-{}{}",
        chrono::Utc::now().timestamp_millis(),
        extension
    ))
}

fn save_export_bytes(
    app: &tauri::AppHandle,
    file_name: &str,
    fallback_file_name: &str,
    file_bytes: &[u8],
) -> Result<String, String> {
    if file_bytes.is_empty() {
        return Err("导出文件为空，已取消保存。".to_string());
    }

    let downloads_dir = resolve_export_directory(app)?;
    std::fs::create_dir_all(&downloads_dir).map_err(|e| format!("无法创建下载目录：{e}"))?;

    let safe_file_name = export_safe_file_name(file_name, fallback_file_name);
    let path = next_available_export_path(&downloads_dir, &safe_file_name);
    std::fs::write(&path, file_bytes).map_err(|e| format!("保存文件失败：{e}"))?;

    Ok(path.to_string_lossy().to_string())
}

fn save_export_bytes_to_path(path: &Path, file_bytes: &[u8]) -> Result<String, String> {
    if file_bytes.is_empty() {
        return Err("导出文件为空，已取消保存。".to_string());
    }

    std::fs::write(path, file_bytes).map_err(|e| format!("保存文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
pub(super) fn unique_temp_path(extension: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "echolike-ocr-{}-{}.{}",
        std::process::id(),
        nanos,
        extension.trim_start_matches('.')
    ))
}

fn is_supported_markdown_text_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MARKDOWN_TEXT_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn decode_utf16_markdown(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("Markdown 文件的 UTF-16 内容不完整。".to_string());
    }

    let units = bytes
        .chunks_exact(2)
        .map(|chunk| {
            let pair = [chunk[0], chunk[1]];
            if little_endian {
                u16::from_le_bytes(pair)
            } else {
                u16::from_be_bytes(pair)
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16(&units).map_err(|_| "Markdown 文件包含无效的 UTF-16 文本。".to_string())
}

fn decode_markdown_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MARKDOWN_TEXT_MAX_BYTES {
        return Err("Markdown 文件过大，请选择不超过 2 MB 的文本文件。".to_string());
    }

    let text = if let Some(content) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        std::str::from_utf8(content)
            .map(str::to_string)
            .map_err(|_| "Markdown 文件不是可读取的 UTF-8 文本。".to_string())?
    } else if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        decode_utf16_markdown(content, true)?
    } else if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        decode_utf16_markdown(content, false)?
    } else {
        std::str::from_utf8(bytes)
            .map(str::to_string)
            .map_err(|_| {
                "Markdown 文件不是可读取的 UTF-8 文本；如使用 UTF-16，请保留文件 BOM。".to_string()
            })?
    };

    if text.contains('\0') {
        return Err("Markdown 文件包含二进制内容，无法作为文本打开。".to_string());
    }
    Ok(text)
}

pub(super) fn read_opened_markdown_file(path: &Path) -> Result<OpenedMarkdownFile, String> {
    if !is_supported_markdown_text_path(path) {
        return Err(format!(
            "仅支持以下 Markdown 文本后缀：{}",
            MARKDOWN_TEXT_EXTENSIONS
                .iter()
                .map(|extension| format!(".{extension}"))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }

    let metadata = std::fs::metadata(path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件。".to_string());
    }
    if metadata.len() > MARKDOWN_TEXT_MAX_BYTES as u64 {
        return Err("Markdown 文件过大，请选择不超过 2 MB 的文本文件。".to_string());
    }

    let bytes = std::fs::read(path).map_err(|error| format!("打开 Markdown 文件失败：{error}"))?;
    let text = decode_markdown_text(&bytes)?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "无法读取所选文件名。".to_string())?;

    Ok(OpenedMarkdownFile { file_name, text })
}

pub(super) fn save_binary_file(
    app: tauri::AppHandle,
    file_name: String,
    file_bytes: Vec<u8>,
) -> Result<String, String> {
    save_export_bytes(&app, &file_name, "echolike-export.bin", &file_bytes)
}

pub(super) fn finish_file_command(
    app: &tauri::AppHandle,
    owners: &crate::process_ownership::ProcessOwners,
    key: &crate::process_ownership::FileCommandKey,
    lease_id: u64,
    result: Result<(String, String), String>,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    let snapshot = owners
        .complete_file(key, lease_id, result)
        .ok_or_else(|| "File command lease is stale.".to_string())?;
    let _ = app.emit("file-command:updated", &snapshot);
    Ok(snapshot)
}

fn cancel_file_command(
    app: &tauri::AppHandle,
    owners: &crate::process_ownership::ProcessOwners,
    key: &crate::process_ownership::FileCommandKey,
    lease_id: u64,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    let snapshot = owners
        .cancel_file(key, lease_id)
        .ok_or_else(|| "File command lease is stale.".to_string())?;
    let _ = app.emit("file-command:updated", &snapshot);
    Ok(snapshot)
}

async fn choose_export_path(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    title: &str,
    file_name: &str,
    filter_name: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter_name, extensions);
    if let Ok(downloads_dir) = resolve_export_directory(app) {
        dialog = dialog.set_directory(downloads_dir);
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = sender.send(path);
    });
    let selected = receiver
        .await
        .map_err(|_| "系统保存对话框意外关闭，请重试。".to_string())?;
    selected
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("无法读取所选保存路径：{error}"))
        })
        .transpose()
}

pub(super) async fn choose_markdown_file_path(
    window: &tauri::Window,
    app: &tauri::AppHandle,
) -> Result<Option<PathBuf>, String> {
    let dialog = app
        .dialog()
        .file()
        .set_parent(window)
        .set_title("打开 Markdown 文件")
        .add_filter("Markdown 文本", MARKDOWN_TEXT_EXTENSIONS);

    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |path| {
        let _ = sender.send(path);
    });
    let selected = receiver
        .await
        .map_err(|_| "系统打开对话框意外关闭，请重试。".to_string())?;
    selected
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("无法读取所选文件路径：{error}"))
        })
        .transpose()
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn finish_file_command_with_dialog(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    owners: &crate::process_ownership::ProcessOwners,
    key: &crate::process_ownership::FileCommandKey,
    lease_id: u64,
    title: &str,
    file_name: &str,
    fallback_file_name: &str,
    filter_name: &str,
    extensions: &[&str],
    file_bytes: Vec<u8>,
    message: String,
) -> Result<crate::process_ownership::FileCommandSnapshot, String> {
    if file_bytes.is_empty() {
        return finish_file_command(
            app,
            owners,
            key,
            lease_id,
            Err("导出文件为空，已取消保存。".to_string()),
        );
    }

    let safe_file_name = export_safe_file_name(file_name, fallback_file_name);
    let selected = match choose_export_path(
        window,
        app,
        title,
        &safe_file_name,
        filter_name,
        extensions,
    )
    .await
    {
        Ok(selected) => selected,
        Err(error) => {
            return finish_file_command(app, owners, key, lease_id, Err(error));
        }
    };
    let Some(path) = selected else {
        return cancel_file_command(app, owners, key, lease_id);
    };
    let result = save_export_bytes_to_path(&path, &file_bytes).map(|path| (path, message));
    finish_file_command(app, owners, key, lease_id, result)
}

pub(super) fn begin_file_command(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    owners: &crate::process_ownership::ProcessOwners,
    key: &crate::process_ownership::FileCommandKey,
    request_fingerprint: String,
) -> Result<u64, crate::process_ownership::FileCommandSnapshot> {
    let Some(lease) = owners.acquire_file_request(
        key.clone(),
        window.label().to_string(),
        request_fingerprint.clone(),
    ) else {
        return Err(owners
            .file_snapshot(key)
            .expect("running file owner must have a snapshot"));
    };
    let running = crate::process_ownership::FileCommandSnapshot {
        key: key.clone(),
        owner_window: window.label().to_string(),
        request_fingerprint,
        outcome: crate::process_ownership::FileCommandOutcome::Running {
            lease_id: lease.lease_id,
        },
    };
    let _ = app.emit("file-command:updated", &running);
    Ok(lease.lease_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_markdown_text_suffixes() {
        for file_name in [
            "notes.md",
            "notes.MARKDOWN",
            "notes.mdown",
            "notes.mkd",
            "notes.mkdn",
            "notes.mdwn",
            "notes.mdtxt",
            "notes.mdtext",
            "notes.txt",
        ] {
            assert!(
                is_supported_markdown_text_path(Path::new(file_name)),
                "expected {file_name} to be accepted"
            );
        }
        for file_name in [
            "notes.mdx",
            "notes.html",
            "notes.docx",
            "notes",
            "notes.md.exe",
        ] {
            assert!(
                !is_supported_markdown_text_path(Path::new(file_name)),
                "expected {file_name} to be rejected"
            );
        }
    }

    #[test]
    fn decodes_utf8_and_bom_marked_utf16_markdown_text() {
        assert_eq!(
            decode_markdown_text(b"\xef\xbb\xbf# UTF-8").unwrap(),
            "# UTF-8"
        );

        let utf16_le = [
            0xff, 0xfe, b'#', 0, b' ', 0, 0x1a, 0x4f, 0xae, 0x8b, 0, 0x4e,
        ];
        assert_eq!(decode_markdown_text(&utf16_le).unwrap(), "# 会议一");

        let utf16_be = [0xfe, 0xff, 0, b'#', 0, b' ', 0x4f, 0x60, 0x59, 0x7d];
        assert_eq!(decode_markdown_text(&utf16_be).unwrap(), "# 你好");
    }

    #[test]
    fn rejects_invalid_or_binary_markdown_text() {
        assert!(decode_markdown_text(&[0xff, 0xfe, 0x41]).is_err());
        assert!(decode_markdown_text(b"text\0binary").is_err());
        assert!(decode_markdown_text(&vec![b'a'; MARKDOWN_TEXT_MAX_BYTES + 1]).is_err());
    }

    #[test]
    fn sanitizes_export_base_names_for_windows_downloads() {
        assert_eq!(export_safe_base_name("CON.pdf", "fallback"), "CON-file");
        assert_eq!(
            export_safe_base_name("  bad:/   name?.pdf  ", "fallback"),
            "bad-name"
        );
        assert_eq!(
            export_safe_file_name("CON?.png", "fallback.md"),
            "CON-file.png"
        );
        assert_eq!(
            export_safe_file_name("  bad:/   name?.pdf  ", "fallback.md"),
            "bad-name.pdf"
        );
        assert_eq!(export_safe_file_name("no-ext", "fallback.md"), "no-ext.md");

        let long_name = format!("{}.pdf", "a".repeat(120));
        assert_eq!(
            export_safe_base_name(&long_name, "fallback")
                .chars()
                .count(),
            EXPORT_BASE_NAME_MAX_CHARS
        );
    }

    #[test]
    fn selects_home_downloads_when_system_known_folder_is_unavailable() {
        let redirected_downloads = PathBuf::from("D:/Backup/Downloads");
        let home_dir = PathBuf::from("C:/Users/demo");

        assert_eq!(
            select_export_directory(Some(redirected_downloads.clone()), Some(home_dir.clone())),
            Some(redirected_downloads)
        );
        assert_eq!(
            select_export_directory(None, Some(home_dir.clone())),
            Some(home_dir.join("Downloads"))
        );
        assert_eq!(select_export_directory(None, None), None);
    }

    #[test]
    fn selected_export_path_is_used_exactly() {
        let path = unique_temp_path("md");
        let saved = save_export_bytes_to_path(&path, b"# selected destination").unwrap();
        assert_eq!(saved, path.to_string_lossy());
        assert_eq!(std::fs::read(&path).unwrap(), b"# selected destination");
        let _ = std::fs::remove_file(path);
    }
}
