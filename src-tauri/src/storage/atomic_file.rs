use anyhow::{Context, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const LEGACY_TEMP_FILE_FALLBACK: &str = "app-config-v2.json";
static ATOMIC_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_atomic_temp_path(target: &Path) -> Result<(PathBuf, std::fs::File)> {
    let parent = target
        .parent()
        .context("atomic state path has no parent directory")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create atomic state directory {}", parent.display()))?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(LEGACY_TEMP_FILE_FALLBACK);

    for _ in 0..32 {
        let sequence = ATOMIC_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("create temporary state next to {}", target.display())
                });
            }
        }
    }

    anyhow::bail!(
        "create temporary state next to {}: exhausted unique names",
        target.display()
    )
}

#[cfg(target_os = "windows")]
pub(super) fn replace_file_atomically(temporary: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let succeeded = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn replace_file_atomically(temporary: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temporary, target)?;
    if let Some(parent) = target.parent() {
        let directory_sync = std::fs::File::open(parent).and_then(|directory| directory.sync_all());
        if let Err(error) = directory_sync {
            // The rename has already committed. Returning Err here would falsely tell callers that
            // the old state is still authoritative, so unsupported directory fsync is observable
            // only as a durability warning.
            tracing::warn!("Atomic state directory sync failed after committed rename: {error}");
        }
    }
    Ok(())
}

pub(super) fn atomic_write_with(
    target: &Path,
    bytes: &[u8],
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    let (temporary, mut file) = next_atomic_temp_path(target)?;
    let result = (|| -> Result<()> {
        file.write_all(bytes)
            .with_context(|| format!("write temporary state {}", temporary.display()))?;
        file.flush()
            .with_context(|| format!("flush temporary state {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("sync temporary state {}", temporary.display()))?;
        drop(file);
        replace(&temporary, target).with_context(|| {
            format!(
                "atomically replace state file {} from {}",
                target.display(),
                temporary.display()
            )
        })?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_directory(name: &str) -> PathBuf {
        let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "echolike-storage-atomic-{name}-{}-{sequence}",
                std::process::id()
            ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn failed_atomic_replace_preserves_the_previous_target_bytes() {
        let directory = test_directory("failed-replace");
        let target = directory.join(LEGACY_TEMP_FILE_FALLBACK);
        fs::write(&target, b"previous-valid-bytes").unwrap();

        let error = atomic_write_with(&target, b"next-bytes", |_temporary, _target| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected replace failure",
            ))
        })
        .unwrap_err();

        assert!(format!("{error:#}").contains("atomically replace state file"));
        assert_eq!(fs::read(&target).unwrap(), b"previous-valid-bytes");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
