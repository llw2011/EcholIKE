use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

const MAX_CHUNK_CHARS: usize = 1_200;
const MAX_CHUNKS: usize = 256;
const MAX_FINAL_WAV_BYTES: usize = 512 * 1024 * 1024;
const MAX_INLINE_PLAYBACK_WAV_BYTES: usize = 128 * 1024 * 1024;
const ASSET_LOOKUP_BATCH_SIZE: i64 = 16;
const AUDIO_BASE_MAX_CHARS: usize = 80;
const AUDIO_DIRECTORY_PARENT: &str = "EcholIKE";
const AUDIO_DIRECTORY_NAME: &str = "朗读音频";
const OWNED_PART_PREFIX: &str = ".echolike-speech-";
const OWNED_PART_SUFFIX: &str = ".part";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSpeechKey {
    pub draft_id: String,
    pub content_revision: String,
    pub voice_key: String,
    pub speed_milli: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSpeechAsset {
    pub id: i64,
    pub key: MarkdownSpeechKey,
    pub file_name: String,
    pub directory_path: String,
    pub created_at: String,
    pub byte_length: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum MarkdownSpeechOutcome {
    Running {
        lease_id: u64,
        completed_chunks: usize,
        total_chunks: usize,
    },
    Success {
        lease_id: u64,
        asset: MarkdownSpeechAsset,
    },
    Error {
        lease_id: u64,
        error: String,
    },
}

impl MarkdownSpeechOutcome {
    fn lease_id(&self) -> u64 {
        match self {
            Self::Running { lease_id, .. }
            | Self::Success { lease_id, .. }
            | Self::Error { lease_id, .. } => *lease_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSpeechTaskSnapshot {
    pub key: MarkdownSpeechKey,
    pub owner_window: String,
    pub outcome: MarkdownSpeechOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSpeechStateSnapshot {
    pub key: MarkdownSpeechKey,
    pub task: Option<MarkdownSpeechTaskSnapshot>,
    pub current_asset: Option<MarkdownSpeechAsset>,
    pub latest_asset: Option<MarkdownSpeechAsset>,
    pub directory_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMarkdownSpeechRequest {
    pub key: MarkdownSpeechKey,
    pub title: String,
    pub chunks: Vec<String>,
    pub api_base_url: String,
    pub token: String,
}

#[derive(Debug, Clone)]
struct StoredAsset {
    id: i64,
    key: MarkdownSpeechKey,
    file_name: String,
    created_at: String,
    byte_length: u64,
    duration_ms: u64,
}

fn stored_asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredAsset> {
    Ok(StoredAsset {
        id: row.get(0)?,
        key: MarkdownSpeechKey {
            draft_id: row.get(1)?,
            content_revision: row.get(2)?,
            voice_key: row.get(3)?,
            speed_milli: row.get(4)?,
        },
        file_name: row.get(5)?,
        created_at: row.get(6)?,
        byte_length: row.get(7)?,
        duration_ms: row.get(8)?,
    })
}

#[derive(Default)]
struct TaskRuntime {
    active_lease_id: Option<u64>,
    latest_by_draft: HashMap<String, MarkdownSpeechTaskSnapshot>,
}

#[derive(Debug, Clone)]
enum AudioDirectory {
    Available(PathBuf),
    Unavailable(String),
}

pub struct MarkdownSpeechManager {
    connection: Mutex<Connection>,
    directory: AudioDirectory,
    tasks: Mutex<TaskRuntime>,
}

impl MarkdownSpeechManager {
    pub fn new(
        database_path: PathBuf,
        documents_directory: Result<PathBuf, String>,
    ) -> Result<Self, String> {
        let connection = Connection::open(database_path)
            .map_err(|error| format!("初始化朗读音频索引失败：{error}"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("初始化朗读音频索引失败：{error}"))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE IF NOT EXISTS markdown_speech_asset (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    draft_id TEXT NOT NULL,
                    content_revision TEXT NOT NULL,
                    voice_key TEXT NOT NULL,
                    speed_milli INTEGER NOT NULL,
                    file_name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    byte_length INTEGER NOT NULL,
                    duration_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS markdown_speech_asset_identity
                    ON markdown_speech_asset (
                        draft_id, content_revision, voice_key, speed_milli, id DESC
                    );
                 CREATE INDEX IF NOT EXISTS markdown_speech_asset_draft
                    ON markdown_speech_asset (draft_id, id DESC);",
            )
            .map_err(|error| format!("初始化朗读音频索引失败：{error}"))?;

        let directory = match documents_directory {
            Ok(path) => {
                let path = path.join(AUDIO_DIRECTORY_PARENT).join(AUDIO_DIRECTORY_NAME);
                cleanup_owned_part_files(&path);
                AudioDirectory::Available(path)
            }
            Err(error) => AudioDirectory::Unavailable(error),
        };

        Ok(Self {
            connection: Mutex::new(connection),
            directory,
            tasks: Mutex::new(TaskRuntime::default()),
        })
    }

    fn audio_directory(&self) -> Result<&Path, String> {
        match &self.directory {
            AudioDirectory::Available(path) => Ok(path),
            AudioDirectory::Unavailable(error) => Err(error.clone()),
        }
    }

    fn directory_display(&self) -> String {
        match &self.directory {
            AudioDirectory::Available(path) => path.to_string_lossy().to_string(),
            AudioDirectory::Unavailable(_) => String::new(),
        }
    }

    fn running_for_key(&self, key: &MarkdownSpeechKey) -> Option<MarkdownSpeechTaskSnapshot> {
        let tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        let snapshot = tasks.latest_by_draft.get(&key.draft_id)?;
        matches!(snapshot.outcome, MarkdownSpeechOutcome::Running { .. })
            .then(|| snapshot.clone())
            .filter(|snapshot| snapshot.key == *key)
    }

    fn begin_task(
        &self,
        key: MarkdownSpeechKey,
        owner_window: String,
        lease_id: u64,
        total_chunks: usize,
    ) -> Result<MarkdownSpeechTaskSnapshot, String> {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        if tasks.active_lease_id.is_some() {
            return Err("已有朗读或音频生成任务正在进行，请稍后再试。".to_string());
        }
        let snapshot = MarkdownSpeechTaskSnapshot {
            key: key.clone(),
            owner_window,
            outcome: MarkdownSpeechOutcome::Running {
                lease_id,
                completed_chunks: 0,
                total_chunks,
            },
        };
        tasks.active_lease_id = Some(lease_id);
        tasks
            .latest_by_draft
            .insert(key.draft_id.clone(), snapshot.clone());
        Ok(snapshot)
    }

    fn update_progress(
        &self,
        lease_id: u64,
        completed_chunks: usize,
    ) -> Option<MarkdownSpeechTaskSnapshot> {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        if tasks.active_lease_id != Some(lease_id) {
            return None;
        }
        let snapshot = tasks
            .latest_by_draft
            .values_mut()
            .find(|snapshot| snapshot.outcome.lease_id() == lease_id)?;
        let total_chunks = match snapshot.outcome {
            MarkdownSpeechOutcome::Running { total_chunks, .. } => total_chunks,
            _ => return None,
        };
        snapshot.outcome = MarkdownSpeechOutcome::Running {
            lease_id,
            completed_chunks: completed_chunks.min(total_chunks),
            total_chunks,
        };
        Some(snapshot.clone())
    }

    fn finish_task(
        &self,
        lease_id: u64,
        result: Result<MarkdownSpeechAsset, String>,
    ) -> Option<MarkdownSpeechTaskSnapshot> {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        if tasks.active_lease_id != Some(lease_id) {
            return None;
        }
        let snapshot = tasks
            .latest_by_draft
            .values_mut()
            .find(|snapshot| snapshot.outcome.lease_id() == lease_id)?;
        snapshot.outcome = match result {
            Ok(asset) => MarkdownSpeechOutcome::Success { lease_id, asset },
            Err(error) => MarkdownSpeechOutcome::Error { lease_id, error },
        };
        let finished = snapshot.clone();
        tasks.active_lease_id = None;
        Some(finished)
    }

    fn latest_task_for_draft(&self, draft_id: &str) -> Option<MarkdownSpeechTaskSnapshot> {
        self.tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .latest_by_draft
            .get(draft_id)
            .cloned()
    }

    fn insert_asset(
        &self,
        key: &MarkdownSpeechKey,
        file_name: &str,
        byte_length: u64,
        duration_ms: u64,
    ) -> Result<MarkdownSpeechAsset, String> {
        let created_at = chrono::Utc::now().to_rfc3339();
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        connection
            .execute(
                "INSERT INTO markdown_speech_asset (
                    draft_id, content_revision, voice_key, speed_milli,
                    file_name, created_at, byte_length, duration_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    key.draft_id,
                    key.content_revision,
                    key.voice_key,
                    key.speed_milli,
                    file_name,
                    created_at,
                    byte_length,
                    duration_ms,
                ],
            )
            .map_err(|error| format!("保存朗读音频索引失败：{error}"))?;
        let id = connection.last_insert_rowid();
        Ok(MarkdownSpeechAsset {
            id,
            key: key.clone(),
            file_name: file_name.to_string(),
            directory_path: self.directory_display(),
            created_at,
            byte_length,
            duration_ms,
        })
    }

    fn stored_assets_for_key_before(
        &self,
        key: &MarkdownSpeechKey,
        before_id: i64,
    ) -> Result<Vec<StoredAsset>, String> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut statement = connection
            .prepare(
                "SELECT id, draft_id, content_revision, voice_key, speed_milli,
                        file_name, created_at, byte_length, duration_ms
                 FROM markdown_speech_asset
                 WHERE draft_id = ?1
                   AND content_revision = ?2
                   AND voice_key = ?3
                   AND speed_milli = ?4
                   AND id < ?5
                 ORDER BY id DESC
                 LIMIT ?6",
            )
            .map_err(|error| format!("读取朗读音频索引失败：{error}"))?;
        let rows = statement
            .query_map(
                params![
                    key.draft_id,
                    key.content_revision,
                    key.voice_key,
                    key.speed_milli,
                    before_id,
                    ASSET_LOOKUP_BATCH_SIZE,
                ],
                stored_asset_from_row,
            )
            .map_err(|error| format!("读取朗读音频索引失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取朗读音频索引失败：{error}"))
    }

    fn stored_assets_for_draft_before(
        &self,
        draft_id: &str,
        before_id: i64,
    ) -> Result<Vec<StoredAsset>, String> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut statement = connection
            .prepare(
                "SELECT id, draft_id, content_revision, voice_key, speed_milli,
                        file_name, created_at, byte_length, duration_ms
                 FROM markdown_speech_asset
                 WHERE draft_id = ?1 AND id < ?2
                 ORDER BY id DESC
                 LIMIT ?3",
            )
            .map_err(|error| format!("读取朗读音频索引失败：{error}"))?;
        let rows = statement
            .query_map(
                params![draft_id, before_id, ASSET_LOOKUP_BATCH_SIZE],
                stored_asset_from_row,
            )
            .map_err(|error| format!("读取朗读音频索引失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取朗读音频索引失败：{error}"))
    }

    fn public_asset(&self, stored: StoredAsset) -> Option<MarkdownSpeechAsset> {
        let path = self.controlled_asset_path(&stored.file_name, true).ok()?;
        let metadata = fs::metadata(path).ok()?;
        Some(MarkdownSpeechAsset {
            id: stored.id,
            key: stored.key,
            file_name: stored.file_name,
            directory_path: self.directory_display(),
            created_at: stored.created_at,
            byte_length: metadata.len().max(stored.byte_length),
            duration_ms: stored.duration_ms,
        })
    }

    fn first_available_asset_for_key(
        &self,
        key: &MarkdownSpeechKey,
    ) -> Result<Option<MarkdownSpeechAsset>, String> {
        let mut before_id = i64::MAX;
        loop {
            let candidates = self.stored_assets_for_key_before(key, before_id)?;
            let Some(last_id) = candidates.last().map(|asset| asset.id) else {
                return Ok(None);
            };
            before_id = last_id;
            if let Some(asset) = candidates
                .into_iter()
                .find_map(|stored| self.public_asset(stored))
            {
                return Ok(Some(asset));
            }
        }
    }

    fn first_available_asset_for_draft(
        &self,
        draft_id: &str,
    ) -> Result<Option<MarkdownSpeechAsset>, String> {
        let mut before_id = i64::MAX;
        loop {
            let candidates = self.stored_assets_for_draft_before(draft_id, before_id)?;
            let Some(last_id) = candidates.last().map(|asset| asset.id) else {
                return Ok(None);
            };
            before_id = last_id;
            if let Some(asset) = candidates
                .into_iter()
                .find_map(|stored| self.public_asset(stored))
            {
                return Ok(Some(asset));
            }
        }
    }

    fn state_for_key(&self, key: MarkdownSpeechKey) -> Result<MarkdownSpeechStateSnapshot, String> {
        validate_key(&key)?;
        let current_asset = self.first_available_asset_for_key(&key)?;
        let latest_asset = self.first_available_asset_for_draft(&key.draft_id)?;
        Ok(MarkdownSpeechStateSnapshot {
            task: self.latest_task_for_draft(&key.draft_id),
            current_asset,
            latest_asset,
            directory_path: self.directory_display(),
            key,
        })
    }

    fn stored_asset_by_id(&self, asset_id: i64) -> Result<StoredAsset, String> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        connection
            .query_row(
                "SELECT id, draft_id, content_revision, voice_key, speed_milli,
                        file_name, created_at, byte_length, duration_ms
                 FROM markdown_speech_asset
                 WHERE id = ?1",
                params![asset_id],
                |row| {
                    Ok(StoredAsset {
                        id: row.get(0)?,
                        key: MarkdownSpeechKey {
                            draft_id: row.get(1)?,
                            content_revision: row.get(2)?,
                            voice_key: row.get(3)?,
                            speed_milli: row.get(4)?,
                        },
                        file_name: row.get(5)?,
                        created_at: row.get(6)?,
                        byte_length: row.get(7)?,
                        duration_ms: row.get(8)?,
                    })
                },
            )
            .map_err(|_| "没有找到这份朗读音频，请重新生成。".to_string())
    }

    fn controlled_asset_path(
        &self,
        file_name: &str,
        require_existing: bool,
    ) -> Result<PathBuf, String> {
        if !is_safe_wav_file_name(file_name) {
            return Err("朗读音频索引包含无效文件名。".to_string());
        }
        let directory = self.audio_directory()?;
        let path = directory.join(file_name);
        if require_existing && !path.is_file() {
            return Err("这份朗读音频已被移动或删除，请重新生成。".to_string());
        }
        if require_existing {
            let canonical_directory = fs::canonicalize(directory)
                .map_err(|_| "无法读取朗读音频目录，请检查文件夹权限。".to_string())?;
            let canonical_path = fs::canonicalize(&path)
                .map_err(|_| "这份朗读音频已被移动或删除，请重新生成。".to_string())?;
            if !canonical_path.starts_with(canonical_directory) {
                return Err("朗读音频路径超出应用管理目录。".to_string());
            }
            return Ok(canonical_path);
        }
        Ok(path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PcmFormat {
    channels: u16,
    sample_rate: u32,
    byte_rate: u32,
    block_align: u16,
    bits_per_sample: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MergedWav {
    bytes: Vec<u8>,
    duration_ms: u64,
}

struct PcmWavAccumulator {
    format: Option<PcmFormat>,
    bytes: Vec<u8>,
    max_final_wav_bytes: usize,
}

impl PcmWavAccumulator {
    fn new() -> Self {
        Self {
            format: None,
            bytes: Vec::new(),
            max_final_wav_bytes: MAX_FINAL_WAV_BYTES,
        }
    }

    #[cfg(test)]
    fn with_max_final_wav_bytes(max_final_wav_bytes: usize) -> Self {
        Self {
            format: None,
            bytes: Vec::new(),
            max_final_wav_bytes,
        }
    }

    fn append_chunk(&mut self, chunk: &[u8]) -> Result<(), String> {
        let parsed = parse_pcm_wav(chunk)?;
        if self.format.is_some_and(|format| format != parsed.format) {
            return Err("分段朗读音频格式不一致，无法合并。请重试或检查后台语音服务。".to_string());
        }

        let current_data_length = self.bytes.len().saturating_sub(44);
        let next_data_length = current_data_length.checked_add(parsed.data.len());
        let final_length = next_data_length.and_then(|length| {
            44_usize
                .checked_add(length)
                .and_then(|total| total.checked_add(length % 2))
        });
        if final_length.is_none_or(|length| length > self.max_final_wav_bytes) {
            return Err("生成的朗读音频过大，请拆分文稿后重试。".to_string());
        }

        if self.format.is_none() {
            self.format = Some(parsed.format);
            write_pcm_wav_header(&mut self.bytes, parsed.format, 0);
        }
        self.bytes.extend_from_slice(parsed.data);
        Ok(())
    }

    fn finish(mut self) -> Result<MergedWav, String> {
        let format = self
            .format
            .ok_or_else(|| "朗读服务没有返回音频。".to_string())?;
        let data_length = u32::try_from(self.bytes.len().saturating_sub(44))
            .map_err(|_| "生成的朗读音频过大，请拆分文稿后重试。".to_string())?;
        let padding_length = data_length % 2;
        let riff_length = 36_u32
            .checked_add(data_length)
            .and_then(|length| length.checked_add(padding_length))
            .ok_or_else(|| "生成的朗读音频过大，请拆分文稿后重试。".to_string())?;
        self.bytes[4..8].copy_from_slice(&riff_length.to_le_bytes());
        self.bytes[40..44].copy_from_slice(&data_length.to_le_bytes());
        if padding_length != 0 {
            self.bytes.push(0);
        }
        let duration_ms = if format.byte_rate == 0 {
            0
        } else {
            (u64::from(data_length) * 1_000) / u64::from(format.byte_rate)
        };
        Ok(MergedWav {
            bytes: self.bytes,
            duration_ms,
        })
    }
}

fn write_pcm_wav_header(bytes: &mut Vec<u8>, format: PcmFormat, data_length: u32) {
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36_u32 + data_length).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&format.channels.to_le_bytes());
    bytes.extend_from_slice(&format.sample_rate.to_le_bytes());
    bytes.extend_from_slice(&format.byte_rate.to_le_bytes());
    bytes.extend_from_slice(&format.block_align.to_le_bytes());
    bytes.extend_from_slice(&format.bits_per_sample.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_length.to_le_bytes());
}

fn validate_key(key: &MarkdownSpeechKey) -> Result<(), String> {
    if key.draft_id.trim().is_empty() || key.draft_id.encode_utf16().count() > 256 {
        return Err("文稿标识无效，请重新打开编辑器后再试。".to_string());
    }
    if key.content_revision.trim().is_empty() || key.content_revision.len() > 128 {
        return Err("文稿版本无效，请重新打开编辑器后再试。".to_string());
    }
    if key.voice_key.encode_utf16().count() > 64 {
        return Err("朗读音色标识过长，请检查后台语音配置。".to_string());
    }
    if !(250..=4_000).contains(&key.speed_milli) {
        return Err("朗读语速无效，请选择 0.25 到 4 倍语速。".to_string());
    }
    Ok(())
}

fn validate_chunks(chunks: &[String]) -> Result<(), String> {
    if chunks.is_empty() {
        return Err("没有可生成朗读的 Markdown 内容。".to_string());
    }
    if chunks.len() > MAX_CHUNKS {
        return Err("文稿过长，当前一次最多生成 256 段朗读音频。请拆分文稿后重试。".to_string());
    }
    for chunk in chunks {
        let length = chunk.trim().encode_utf16().count();
        if length == 0 {
            return Err("朗读分段中包含空内容，请重新生成。".to_string());
        }
        if length > MAX_CHUNK_CHARS {
            return Err("朗读分段超过 1200 字，请重新生成。".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
fn merge_pcm_wav_chunks(chunks: &[Vec<u8>]) -> Result<MergedWav, String> {
    let mut accumulator = PcmWavAccumulator::new();
    for chunk in chunks {
        accumulator.append_chunk(chunk)?;
    }
    accumulator.finish()
}

struct ParsedWav<'a> {
    format: PcmFormat,
    data: &'a [u8],
}

fn parse_pcm_wav(bytes: &[u8]) -> Result<ParsedWav<'_>, String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("朗读服务没有返回可保存的 WAV 音频，请检查后台语音服务配置。".to_string());
    }
    let declared_length = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8;
    if declared_length != bytes.len() {
        return Err("朗读服务返回的 WAV 音频不完整，请重试。".to_string());
    }

    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_length =
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start
            .checked_add(chunk_length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "朗读服务返回的 WAV 音频不完整，请重试。".to_string())?;
        if chunk_id == b"fmt " {
            if format.is_some() {
                return Err("朗读服务返回的 WAV 包含重复格式信息，无法安全合并。".to_string());
            }
            if chunk_length < 16 {
                return Err("朗读服务返回的 WAV 格式无效，请检查后台语音服务配置。".to_string());
            }
            let value = &bytes[chunk_start..chunk_end];
            let audio_format = u16::from_le_bytes(value[0..2].try_into().unwrap());
            let parsed = PcmFormat {
                channels: u16::from_le_bytes(value[2..4].try_into().unwrap()),
                sample_rate: u32::from_le_bytes(value[4..8].try_into().unwrap()),
                byte_rate: u32::from_le_bytes(value[8..12].try_into().unwrap()),
                block_align: u16::from_le_bytes(value[12..14].try_into().unwrap()),
                bits_per_sample: u16::from_le_bytes(value[14..16].try_into().unwrap()),
            };
            if audio_format != 1
                || parsed.channels == 0
                || parsed.channels > 8
                || parsed.sample_rate == 0
                || !matches!(parsed.bits_per_sample, 8 | 16 | 24 | 32)
                || u32::from(parsed.block_align)
                    != u32::from(parsed.channels) * u32::from(parsed.bits_per_sample) / 8
                || parsed.byte_rate
                    != parsed
                        .sample_rate
                        .saturating_mul(u32::from(parsed.block_align))
            {
                return Err(
                    "朗读服务返回的 WAV 不是兼容的 PCM 音频，请检查后台语音服务配置。".to_string(),
                );
            }
            format = Some(parsed);
        } else if chunk_id == b"data" {
            if data.is_some() {
                return Err("朗读服务返回的 WAV 包含重复音频数据，无法安全合并。".to_string());
            }
            data = Some(&bytes[chunk_start..chunk_end]);
        }
        offset = chunk_end
            .checked_add(chunk_length % 2)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "朗读服务返回的 WAV 音频不完整，请重试。".to_string())?;
    }
    if offset != bytes.len() {
        return Err("朗读服务返回的 WAV 音频不完整，请重试。".to_string());
    }

    let format = format.ok_or_else(|| "朗读服务返回的 WAV 缺少格式信息，请重试。".to_string())?;
    let data = data
        .filter(|data| !data.is_empty())
        .ok_or_else(|| "朗读服务返回了空 WAV 音频，请重试。".to_string())?;
    if data.len() % usize::from(format.block_align) != 0 {
        return Err("朗读服务返回的 WAV 音频数据不完整，请重试。".to_string());
    }
    Ok(ParsedWav { format, data })
}

fn safe_audio_base(title: &str) -> String {
    let title = title.trim();
    let title = title
        .rsplit_once('.')
        .filter(|(_, extension)| {
            !extension.is_empty()
                && extension.len() <= 8
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map(|(base, _)| base)
        .unwrap_or(title);
    let mut cleaned = String::new();
    let mut separator = false;
    for character in title.chars() {
        let invalid = character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            );
        if invalid || character.is_whitespace() {
            if !cleaned.is_empty() {
                separator = true;
            }
            continue;
        }
        if separator && !cleaned.ends_with('-') {
            cleaned.push('-');
        }
        separator = false;
        cleaned.push(character);
        if cleaned.chars().count() >= AUDIO_BASE_MAX_CHARS {
            break;
        }
    }
    let mut cleaned = cleaned.trim_matches([' ', '.', '-']).to_string();
    if cleaned.is_empty() {
        cleaned = "EcholIKE-朗读".to_string();
    }
    if is_reserved_windows_file_base(&cleaned) {
        cleaned.push_str("-file");
    }
    cleaned
}

fn is_reserved_windows_file_base(value: &str) -> bool {
    let upper = value.trim_matches('.').to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper[3..]
                .chars()
                .all(|character| ('1'..='9').contains(&character)))
}

fn is_safe_wav_file_name(file_name: &str) -> bool {
    let path = Path::new(file_name);
    let mut components = path.components();
    let one_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    one_normal_component
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
}

fn cleanup_owned_part_files(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with(OWNED_PART_PREFIX) && file_name.ends_with(OWNED_PART_SUFFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn unique_audio_paths(
    directory: &Path,
    title: &str,
    lease_id: u64,
) -> Result<(PathBuf, PathBuf, String), String> {
    let base = safe_audio_base(title);
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for suffix in 0..1_000 {
        let discriminator = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let file_name = format!("{base}_{timestamp}{discriminator}.wav");
        let final_path = directory.join(&file_name);
        if final_path.exists() {
            continue;
        }
        let part_path = directory.join(format!(
            "{OWNED_PART_PREFIX}{}-{lease_id}-{suffix}{OWNED_PART_SUFFIX}",
            std::process::id()
        ));
        if !part_path.exists() {
            return Ok((part_path, final_path, file_name));
        }
    }
    Err("无法创建唯一的朗读音频文件名，请稍后重试。".to_string())
}

fn persist_merged_wav(
    manager: &MarkdownSpeechManager,
    key: &MarkdownSpeechKey,
    title: &str,
    lease_id: u64,
    merged: &MergedWav,
) -> Result<MarkdownSpeechAsset, String> {
    let directory = manager.audio_directory()?;
    fs::create_dir_all(directory)
        .map_err(|_| "无法创建朗读音频目录，请检查“文档”文件夹权限。".to_string())?;
    let (part_path, final_path, file_name) = unique_audio_paths(directory, title, lease_id)?;
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|_| "无法创建朗读音频临时文件，请检查文件夹权限。".to_string())?;
        file.write_all(&merged.bytes)
            .map_err(|_| "写入朗读音频失败，请检查磁盘空间。".to_string())?;
        file.flush()
            .map_err(|_| "保存朗读音频失败，请检查磁盘空间。".to_string())?;
        file.sync_all()
            .map_err(|_| "保存朗读音频失败，请检查磁盘空间。".to_string())?;
        drop(file);
        fs::rename(&part_path, &final_path)
            .map_err(|_| "完成朗读音频保存失败，请检查文件夹权限。".to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&part_path);
        return Err(error);
    }

    match manager.insert_asset(
        key,
        &file_name,
        merged.bytes.len() as u64,
        merged.duration_ms,
    ) {
        Ok(asset) => Ok(asset),
        Err(error) => {
            let _ = fs::remove_file(final_path);
            Err(error)
        }
    }
}

fn markdown_speech_chunk_key(parent_key: &str, index: usize, chunk: &str) -> String {
    let chunk_index = (index as u64).to_be_bytes();
    crate::idempotency::derived_key(
        "tts-chunk",
        &[parent_key.as_bytes(), &chunk_index, chunk.trim().as_bytes()],
    )
}

async fn generate_markdown_speech_asset(
    app: &tauri::AppHandle,
    manager: &MarkdownSpeechManager,
    client: &crate::network::NetworkClient,
    registry: &crate::idempotency::Registry,
    request: &StartMarkdownSpeechRequest,
    lease_id: u64,
) -> Result<MarkdownSpeechAsset, String> {
    let voice = (!request.key.voice_key.trim().is_empty())
        .then(|| request.key.voice_key.trim().to_string());
    let speed = request.key.speed_milli.to_be_bytes();
    let mut semantic_parts = vec![
        request.key.draft_id.as_bytes(),
        request.key.content_revision.as_bytes(),
        request.key.voice_key.as_bytes(),
        speed.as_slice(),
    ];
    semantic_parts.extend(request.chunks.iter().map(|chunk| chunk.trim().as_bytes()));
    let persistent_operation = registry.acquire_authenticated(
        "markdown-speech",
        &request.api_base_url,
        &request.token,
        &semantic_parts,
    )?;
    let mut accumulator = PcmWavAccumulator::new();
    for (index, chunk) in request.chunks.iter().enumerate() {
        let child_key = markdown_speech_chunk_key(persistent_operation.root(), index, chunk);
        let bytes = match crate::commands::backend::proxy_tts_wav_chunk(
            request.api_base_url.clone(),
            request.token.clone(),
            chunk.trim().to_string(),
            voice.clone(),
            request.key.speed_milli,
            child_key,
            client,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                if crate::idempotency::error_retires_operation(&error) {
                    persistent_operation.retire()?;
                }
                return Err(error);
            }
        };
        accumulator.append_chunk(&bytes)?;
        if let Some(snapshot) = manager.update_progress(lease_id, index + 1) {
            let _ = app.emit("markdown-speech:updated", &snapshot);
        }
    }
    let merged = accumulator.finish()?;
    let asset = persist_merged_wav(manager, &request.key, &request.title, lease_id, &merged)?;
    if let Err(error) = registry.acknowledge(persistent_operation.root()) {
        tracing::warn!(
            error,
            "Markdown speech operation remains pending after audio persistence"
        );
    }
    Ok(asset)
}

#[tauri::command]
pub fn get_markdown_speech_state(
    key: MarkdownSpeechKey,
    manager: tauri::State<'_, MarkdownSpeechManager>,
) -> Result<MarkdownSpeechStateSnapshot, String> {
    manager.state_for_key(key)
}

#[tauri::command]
pub async fn start_markdown_speech_generation(
    request: StartMarkdownSpeechRequest,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    manager: tauri::State<'_, MarkdownSpeechManager>,
    owners: tauri::State<'_, crate::process_ownership::ProcessOwners>,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<MarkdownSpeechTaskSnapshot, String> {
    validate_key(&request.key)?;
    validate_chunks(&request.chunks)?;
    if request.title.encode_utf16().count() > 512 {
        return Err("文稿标题过长，请缩短标题后重试。".to_string());
    }
    let directory = manager.audio_directory()?;
    fs::create_dir_all(directory)
        .map_err(|_| "无法创建朗读音频目录，请检查“文档”文件夹权限。".to_string())?;
    if let Some(existing) = manager.running_for_key(&request.key) {
        return Ok(existing);
    }
    let lease = owners
        .acquire_tts(window.label().to_string())
        .ok_or_else(|| "已有朗读或音频生成任务正在进行，请稍后再试。".to_string())?;
    if !owners.begin_tts_generation(lease.lease_id, window.label()) {
        let _ = owners.release_tts(lease.lease_id);
        return Err("朗读生成任务未能取得执行权，请稍后重试。".to_string());
    }
    let snapshot = match manager.begin_task(
        request.key.clone(),
        window.label().to_string(),
        lease.lease_id,
        request.chunks.len(),
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = owners.release_tts(lease.lease_id);
            return Err(error);
        }
    };
    let _ = app.emit("markdown-speech:updated", &snapshot);

    let handle = app.clone();
    let network_client = client.inner().clone();
    let idempotency_registry = registry.inner().clone();
    let lease_id = lease.lease_id;
    tauri::async_runtime::spawn(async move {
        let result = {
            let manager = handle.state::<MarkdownSpeechManager>();
            generate_markdown_speech_asset(
                &handle,
                &manager,
                &network_client,
                &idempotency_registry,
                &request,
                lease_id,
            )
            .await
        };
        let owners = handle.state::<crate::process_ownership::ProcessOwners>();
        if !owners.release_tts(lease_id) {
            tracing::warn!("Markdown speech TTS lease {lease_id} was stale at completion");
        }
        let manager = handle.state::<MarkdownSpeechManager>();
        if let Some(terminal) = manager.finish_task(lease_id, result) {
            let _ = handle.emit("markdown-speech:updated", &terminal);
        }
    });

    Ok(snapshot)
}

fn read_validated_markdown_speech_audio(path: PathBuf) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(&path).map_err(|_| "这份朗读音频已被移动或删除，请重新生成。".to_string())?;
    if metadata.len() > MAX_INLINE_PLAYBACK_WAV_BYTES as u64 {
        return Err("这份朗读音频过大，无法在应用内播放。请打开所在文件夹播放。".to_string());
    }
    let file =
        fs::File::open(path).map_err(|_| "无法打开朗读音频，请检查文件权限。".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_INLINE_PLAYBACK_WAV_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取朗读音频失败，请检查文件权限。".to_string())?;
    if bytes.len() > MAX_INLINE_PLAYBACK_WAV_BYTES {
        return Err("这份朗读音频过大，无法在应用内播放。请打开所在文件夹播放。".to_string());
    }
    parse_pcm_wav(&bytes)?;
    Ok(bytes)
}

#[tauri::command]
pub async fn read_markdown_speech_audio(
    asset_id: i64,
    manager: tauri::State<'_, MarkdownSpeechManager>,
) -> Result<tauri::ipc::Response, String> {
    let stored = manager.stored_asset_by_id(asset_id)?;
    let path = manager.controlled_asset_path(&stored.file_name, true)?;
    let bytes =
        tauri::async_runtime::spawn_blocking(move || read_validated_markdown_speech_audio(path))
            .await
            .map_err(|error| {
                tracing::error!(%error, "Markdown speech audio read task failed");
                "读取朗读音频失败，请稍后重试。".to_string()
            })??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn open_markdown_speech_directory(
    manager: tauri::State<'_, MarkdownSpeechManager>,
) -> Result<(), String> {
    let directory = manager.audio_directory()?;
    fs::create_dir_all(directory)
        .map_err(|_| "无法创建朗读音频目录，请检查“文档”文件夹权限。".to_string())?;
    spawn_open_command(open_directory_command(directory))
}

#[tauri::command]
pub fn reveal_markdown_speech_asset(
    asset_id: i64,
    manager: tauri::State<'_, MarkdownSpeechManager>,
) -> Result<(), String> {
    let stored = manager.stored_asset_by_id(asset_id)?;
    let path = manager.controlled_asset_path(&stored.file_name, true)?;
    spawn_open_command(reveal_file_command(&path))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenCommand {
    program: OsString,
    arguments: Vec<OsString>,
}

#[cfg(target_os = "windows")]
fn open_directory_command(directory: &Path) -> OpenCommand {
    OpenCommand {
        program: "explorer.exe".into(),
        arguments: vec![directory.as_os_str().to_owned()],
    }
}

#[cfg(target_os = "windows")]
fn reveal_file_command(path: &Path) -> OpenCommand {
    OpenCommand {
        program: "explorer.exe".into(),
        arguments: vec!["/select,".into(), path.as_os_str().to_owned()],
    }
}

#[cfg(target_os = "macos")]
fn open_directory_command(directory: &Path) -> OpenCommand {
    OpenCommand {
        program: "open".into(),
        arguments: vec![directory.as_os_str().to_owned()],
    }
}

#[cfg(target_os = "macos")]
fn reveal_file_command(path: &Path) -> OpenCommand {
    OpenCommand {
        program: "open".into(),
        arguments: vec!["-R".into(), path.as_os_str().to_owned()],
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_directory_command(directory: &Path) -> OpenCommand {
    OpenCommand {
        program: "xdg-open".into(),
        arguments: vec![directory.as_os_str().to_owned()],
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn reveal_file_command(path: &Path) -> OpenCommand {
    open_directory_command(path.parent().unwrap_or(path))
}

fn spawn_open_command(command: OpenCommand) -> Result<(), String> {
    Command::new(command.program)
        .args(command.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开朗读音频所在文件夹，请稍后重试。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn test_directory(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "echolike-markdown-speech-{label}-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn speech_key(revision: &str) -> MarkdownSpeechKey {
        MarkdownSpeechKey {
            draft_id: "draft-a".into(),
            content_revision: revision.into(),
            voice_key: "alloy".into(),
            speed_milli: 1_000,
        }
    }

    #[test]
    fn chunk_idempotency_keys_are_root_index_and_content_scoped() {
        let parent = "04d99516-4612-4bee-8d75-ecc72f69812e";
        assert_eq!(
            markdown_speech_chunk_key(&parent, 2, " same chunk "),
            markdown_speech_chunk_key(&parent, 2, "same chunk")
        );
        assert_ne!(
            markdown_speech_chunk_key(&parent, 2, "same chunk"),
            markdown_speech_chunk_key(&parent, 3, "same chunk")
        );
        assert_ne!(
            markdown_speech_chunk_key(&parent, 2, "same chunk"),
            markdown_speech_chunk_key(&parent, 2, "changed chunk")
        );
    }

    fn pcm_wav(format: PcmFormat, samples: &[u8]) -> Vec<u8> {
        let padding_length = samples.len() % 2;
        let mut bytes = Vec::with_capacity(44 + samples.len() + padding_length);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(
            &(36_u32 + samples.len() as u32 + padding_length as u32).to_le_bytes(),
        );
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&format.channels.to_le_bytes());
        bytes.extend_from_slice(&format.sample_rate.to_le_bytes());
        bytes.extend_from_slice(&format.byte_rate.to_le_bytes());
        bytes.extend_from_slice(&format.block_align.to_le_bytes());
        bytes.extend_from_slice(&format.bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        bytes.extend_from_slice(samples);
        if padding_length != 0 {
            bytes.push(0);
        }
        bytes
    }

    fn mono_pcm() -> PcmFormat {
        PcmFormat {
            channels: 1,
            sample_rate: 24_000,
            byte_rate: 48_000,
            block_align: 2,
            bits_per_sample: 16,
        }
    }

    #[test]
    fn validates_frontend_chunks_against_utf16_contract() {
        assert!(validate_chunks(&["hello".into(), "你好".into()]).is_ok());
        assert!(validate_chunks(&[]).is_err());
        assert!(validate_chunks(&["   ".into()]).is_err());
        assert!(validate_chunks(&["a".repeat(MAX_CHUNK_CHARS + 1)]).is_err());
        assert!(validate_chunks(&["😀".repeat((MAX_CHUNK_CHARS / 2) + 1)]).is_err());
    }

    #[test]
    fn merges_matching_pcm_wav_data_into_one_canonical_file() {
        let merged = merge_pcm_wav_chunks(&[
            pcm_wav(mono_pcm(), &[1, 0, 2, 0]),
            pcm_wav(mono_pcm(), &[3, 0, 4, 0]),
        ])
        .unwrap();

        assert_eq!(&merged.bytes[..4], b"RIFF");
        assert_eq!(&merged.bytes[8..12], b"WAVE");
        assert_eq!(
            u32::from_le_bytes(merged.bytes[40..44].try_into().unwrap()),
            8
        );
        assert_eq!(&merged.bytes[44..], &[1, 0, 2, 0, 3, 0, 4, 0]);
        assert_eq!(merged.duration_ms, 0);
    }

    #[test]
    fn accumulator_rejects_oversized_audio_before_copying_the_chunk() {
        let mut accumulator = PcmWavAccumulator::with_max_final_wav_bytes(48);
        accumulator
            .append_chunk(&pcm_wav(mono_pcm(), &[1, 0, 2, 0]))
            .unwrap();
        let accepted_bytes = accumulator.bytes.clone();

        let error = accumulator
            .append_chunk(&pcm_wav(mono_pcm(), &[3, 0]))
            .unwrap_err();

        assert!(error.contains("音频过大"));
        assert_eq!(accumulator.bytes, accepted_bytes);
        let merged = accumulator.finish().unwrap();
        assert_eq!(merged.bytes.len(), 48);
        assert_eq!(&merged.bytes[44..], &[1, 0, 2, 0]);
    }

    #[test]
    fn merged_wav_pads_odd_pcm_data_and_counts_padding_toward_the_limit() {
        let format = PcmFormat {
            channels: 1,
            sample_rate: 8_000,
            byte_rate: 8_000,
            block_align: 1,
            bits_per_sample: 8,
        };
        let chunk = pcm_wav(format, &[1, 2, 3]);

        let mut too_small = PcmWavAccumulator::with_max_final_wav_bytes(47);
        assert!(too_small.append_chunk(&chunk).is_err());
        assert!(too_small.bytes.is_empty());

        let merged = merge_pcm_wav_chunks(&[chunk]).unwrap();
        assert_eq!(merged.bytes.len(), 48);
        assert_eq!(
            u32::from_le_bytes(merged.bytes[4..8].try_into().unwrap()),
            40
        );
        assert_eq!(
            u32::from_le_bytes(merged.bytes[40..44].try_into().unwrap()),
            3
        );
        assert_eq!(&merged.bytes[44..47], &[1, 2, 3]);
        assert_eq!(merged.bytes[47], 0);
        let parsed = parse_pcm_wav(&merged.bytes).unwrap();
        assert_eq!(parsed.format, format);
        assert_eq!(parsed.data, &[1, 2, 3]);
    }

    #[test]
    fn rejects_non_wav_truncation_and_mismatched_pcm_formats() {
        assert!(merge_pcm_wav_chunks(&[b"ID3-not-wave".to_vec()]).is_err());
        assert!(merge_pcm_wav_chunks(&[b"RIFF".to_vec()]).is_err());

        let mut stereo = mono_pcm();
        stereo.channels = 2;
        stereo.block_align = 4;
        stereo.byte_rate = 96_000;
        assert!(merge_pcm_wav_chunks(&[
            pcm_wav(mono_pcm(), &[1, 0]),
            pcm_wav(stereo, &[1, 0, 2, 0]),
        ])
        .is_err());
    }

    #[test]
    fn blocking_audio_reader_returns_only_valid_pcm_wav_bytes() {
        let root = test_directory("read-audio");
        let valid_path = root.join("valid.wav");
        let valid = pcm_wav(mono_pcm(), &[1, 0, 2, 0]);
        fs::write(&valid_path, &valid).unwrap();
        assert_eq!(
            read_validated_markdown_speech_audio(valid_path).unwrap(),
            valid
        );

        let invalid_path = root.join("invalid.wav");
        fs::write(&invalid_path, b"not-a-wave").unwrap();
        assert!(read_validated_markdown_speech_audio(invalid_path).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sanitizes_audio_file_bases_without_windows_reserved_names() {
        assert_eq!(safe_audio_base("  bad:/  name?.md "), "bad-name");
        assert_eq!(safe_audio_base("CON"), "CON-file");
        assert_eq!(safe_audio_base("  "), "EcholIKE-朗读");
    }

    #[test]
    fn persists_atomic_wav_and_restores_current_asset_from_a_new_manager() {
        let root = test_directory("restart");
        let database = root.join("echo.db");
        let documents = root.join("Documents");
        let key = speech_key("rev-1");
        let merged = merge_pcm_wav_chunks(&[pcm_wav(mono_pcm(), &[1, 0, 2, 0])]).unwrap();
        let manager = MarkdownSpeechManager::new(database.clone(), Ok(documents.clone())).unwrap();
        let asset = persist_merged_wav(&manager, &key, "测试文稿", 17, &merged).unwrap();
        assert!(manager
            .audio_directory()
            .unwrap()
            .join(&asset.file_name)
            .is_file());
        assert!(fs::read_dir(manager.audio_directory().unwrap())
            .unwrap()
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .ends_with(OWNED_PART_SUFFIX)));
        drop(manager);

        let restarted = MarkdownSpeechManager::new(database, Ok(documents)).unwrap();
        let state = restarted.state_for_key(key).unwrap();
        assert_eq!(
            state.current_asset.as_ref().map(|asset| asset.id),
            Some(asset.id)
        );
        assert_eq!(
            state.latest_asset.as_ref().map(|asset| asset.id),
            Some(asset.id)
        );
        drop(restarted);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_newest_file_falls_back_to_an_older_matching_asset() {
        let root = test_directory("fallback");
        let manager =
            MarkdownSpeechManager::new(root.join("echo.db"), Ok(root.join("Documents"))).unwrap();
        let key = speech_key("rev-1");
        let merged = merge_pcm_wav_chunks(&[pcm_wav(mono_pcm(), &[1, 0])]).unwrap();
        let first = persist_merged_wav(&manager, &key, "测试文稿", 1, &merged).unwrap();
        let mut missing_files = Vec::new();
        for lease_id in 2..=18 {
            let missing =
                persist_merged_wav(&manager, &key, "测试文稿", lease_id, &merged).unwrap();
            missing_files.push(missing.file_name);
        }
        for file_name in missing_files {
            fs::remove_file(manager.audio_directory().unwrap().join(file_name)).unwrap();
        }

        let state = manager.state_for_key(key).unwrap();
        assert_eq!(
            state.current_asset.as_ref().map(|asset| asset.id),
            Some(first.id)
        );
        assert_eq!(
            state.latest_asset.as_ref().map(|asset| asset.id),
            Some(first.id)
        );
        drop(manager);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn state_keeps_exact_current_asset_separate_from_latest_draft_asset() {
        let root = test_directory("current-latest");
        let manager =
            MarkdownSpeechManager::new(root.join("echo.db"), Ok(root.join("Documents"))).unwrap();
        let merged = merge_pcm_wav_chunks(&[pcm_wav(mono_pcm(), &[1, 0])]).unwrap();
        let current_key = speech_key("rev-1");
        let current = persist_merged_wav(&manager, &current_key, "测试文稿", 1, &merged).unwrap();
        let latest =
            persist_merged_wav(&manager, &speech_key("rev-2"), "测试文稿", 2, &merged).unwrap();

        let state = manager.state_for_key(current_key).unwrap();
        assert_eq!(state.current_asset.map(|asset| asset.id), Some(current.id));
        assert_eq!(state.latest_asset.map(|asset| asset.id), Some(latest.id));
        drop(manager);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_state_is_process_wide_and_stale_progress_cannot_overwrite_terminal() {
        let root = test_directory("task");
        let manager =
            MarkdownSpeechManager::new(root.join("echo.db"), Ok(root.join("Documents"))).unwrap();
        let key = speech_key("rev-1");
        let running = manager
            .begin_task(key.clone(), "markdown-editor".into(), 41, 3)
            .unwrap();
        assert!(matches!(
            running.outcome,
            MarkdownSpeechOutcome::Running {
                completed_chunks: 0,
                total_chunks: 3,
                ..
            }
        ));
        assert!(manager
            .begin_task(speech_key("rev-2"), "main".into(), 42, 1)
            .is_err());
        let progress = manager.update_progress(41, 2).unwrap();
        assert!(matches!(
            progress.outcome,
            MarkdownSpeechOutcome::Running {
                completed_chunks: 2,
                ..
            }
        ));
        let terminal = manager.finish_task(41, Err("failed".into())).unwrap();
        assert!(matches!(
            terminal.outcome,
            MarkdownSpeechOutcome::Error { .. }
        ));
        assert!(manager.update_progress(41, 3).is_none());
        assert!(manager
            .begin_task(speech_key("rev-2"), "main".into(), 42, 1)
            .is_ok());
        drop(manager);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_cleanup_only_removes_owned_part_files() {
        let root = test_directory("cleanup");
        let documents = root.join("Documents");
        let audio = documents
            .join(AUDIO_DIRECTORY_PARENT)
            .join(AUDIO_DIRECTORY_NAME);
        fs::create_dir_all(&audio).unwrap();
        let owned = audio.join(format!("{OWNED_PART_PREFIX}123{OWNED_PART_SUFFIX}"));
        let unrelated = audio.join("user.part");
        fs::write(&owned, b"partial").unwrap();
        fs::write(&unrelated, b"keep").unwrap();

        let manager = MarkdownSpeechManager::new(root.join("echo.db"), Ok(documents)).unwrap();
        assert!(!owned.exists());
        assert!(unrelated.exists());
        drop(manager);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_reveal_passes_unicode_path_as_one_argument_without_a_shell() {
        let path = PathBuf::from(r"C:\Users\TestUser\Documents\EcholIKE\朗读音频\文稿.wav");
        let command = reveal_file_command(&path);
        assert_eq!(command.program, OsString::from("explorer.exe"));
        assert_eq!(
            command.arguments,
            vec![OsString::from("/select,"), path.into_os_string()]
        );
    }
}
