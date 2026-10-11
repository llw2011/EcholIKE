use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLease {
    pub lease_id: u64,
    pub owner_window: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TtsOwnerStage {
    Ready,
    Generating,
    Playback,
}

#[derive(Debug, Clone)]
struct TtsOwner {
    lease: ProcessLease,
    stage: TtsOwnerStage,
    owner_alive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsGenerationCompletion {
    Playback,
    Released,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkdownAiAction {
    Polish,
    Translate,
    Summarize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MarkdownRequestTarget {
    FullDocument,
    Selection { start: u32, end: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownRequestIdentity {
    pub action: MarkdownAiAction,
    pub target: MarkdownRequestTarget,
    pub draft_revision: String,
    pub semantic_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownAiKey {
    pub draft_id: String,
    pub request: MarkdownRequestIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum MarkdownAiOutcome {
    Running { lease_id: u64 },
    Success { lease_id: u64, output: String },
    Error { lease_id: u64, error: String },
}

impl MarkdownAiOutcome {
    fn lease_id(&self) -> u64 {
        match self {
            Self::Running { lease_id }
            | Self::Success { lease_id, .. }
            | Self::Error { lease_id, .. } => *lease_id,
        }
    }
}

#[derive(Debug, Clone)]
struct MarkdownTask {
    lease: ProcessLease,
    outcome: MarkdownAiOutcome,
    apply_context: Option<MarkdownAiApplyContext>,
    operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownAiTaskSnapshot {
    pub key: MarkdownAiKey,
    pub outcome: MarkdownAiOutcome,
    pub apply_context: Option<MarkdownAiApplyContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownAiApplyContext {
    pub full_text: String,
    pub text: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownAiPrompt {
    pub key: MarkdownAiKey,
    pub question: String,
    pub retry_question: Option<String>,
    pub source_text: String,
    pub context: Option<String>,
    pub apply_context: MarkdownAiApplyContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMarkdownAiRequest {
    #[serde(flatten)]
    pub prompt: MarkdownAiPrompt,
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileCommandKind {
    SaveMarkdown,
    ExportPdf,
    ExportDocx,
    ExportMarkdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommandKey {
    pub resource_id: String,
    pub command_kind: FileCommandKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum FileCommandOutcome {
    Running {
        lease_id: u64,
    },
    Success {
        lease_id: u64,
        path: String,
        message: String,
    },
    Cancelled {
        lease_id: u64,
    },
    Error {
        lease_id: u64,
        error: String,
    },
}

impl FileCommandOutcome {
    pub fn lease_id(&self) -> u64 {
        match self {
            Self::Running { lease_id }
            | Self::Success { lease_id, .. }
            | Self::Cancelled { lease_id }
            | Self::Error { lease_id, .. } => *lease_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommandSnapshot {
    pub key: FileCommandKey,
    pub owner_window: String,
    pub request_fingerprint: String,
    pub outcome: FileCommandOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsumeFileCommandResult {
    Consumed,
    AlreadyConsumed,
    Stale,
}

#[derive(Debug, Clone)]
struct FileCommandTask {
    active: Option<ProcessLease>,
    owner_window: String,
    request_fingerprint: String,
    latest: FileCommandOutcome,
}

#[derive(Default)]
struct Owners {
    next_lease_id: u64,
    tts: Option<TtsOwner>,
    markdown: HashMap<MarkdownAiKey, MarkdownTask>,
    files: HashMap<FileCommandKey, FileCommandTask>,
    consumed_files: HashMap<FileCommandKey, u64>,
}

#[derive(Default)]
pub struct ProcessOwners(Mutex<Owners>);

impl ProcessOwners {
    fn next(owners: &mut Owners, owner_window: String) -> ProcessLease {
        owners.next_lease_id = owners
            .next_lease_id
            .checked_add(1)
            .expect("lease id exhausted");
        ProcessLease {
            lease_id: owners.next_lease_id,
            owner_window,
        }
    }
    pub fn acquire_tts(&self, owner_window: String) -> Option<ProcessLease> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if owners.tts.is_some() {
            return None;
        }
        let lease = Self::next(&mut owners, owner_window);
        owners.tts = Some(TtsOwner {
            lease: lease.clone(),
            stage: TtsOwnerStage::Ready,
            owner_alive: true,
        });
        Some(lease)
    }
    pub fn begin_tts_generation(&self, lease_id: u64, owner_window: &str) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(owner) = owners.tts.as_mut() else {
            return false;
        };
        if owner.lease.lease_id != lease_id
            || owner.lease.owner_window != owner_window
            || !owner.owner_alive
            || !matches!(owner.stage, TtsOwnerStage::Ready | TtsOwnerStage::Playback)
        {
            return false;
        }
        owner.stage = TtsOwnerStage::Generating;
        true
    }
    #[cfg(test)]
    fn transition_tts_to_playback(&self, lease_id: u64, owner_window: &str) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(owner) = owners.tts.as_mut() else {
            return false;
        };
        if owner.lease.lease_id != lease_id
            || owner.lease.owner_window != owner_window
            || owner.stage != TtsOwnerStage::Generating
            || !owner.owner_alive
        {
            return false;
        }
        owner.stage = TtsOwnerStage::Playback;
        true
    }
    pub fn complete_tts_generation(&self, lease_id: u64) -> TtsGenerationCompletion {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(owner) = owners.tts.as_mut() else {
            return TtsGenerationCompletion::Stale;
        };
        if owner.lease.lease_id != lease_id || owner.stage != TtsOwnerStage::Generating {
            return TtsGenerationCompletion::Stale;
        }
        if owner.owner_alive {
            owner.stage = TtsOwnerStage::Playback;
            TtsGenerationCompletion::Playback
        } else {
            owners.tts = None;
            TtsGenerationCompletion::Released
        }
    }
    pub fn finish_tts_generation(&self, lease_id: u64, succeeded: bool) -> TtsGenerationCompletion {
        if succeeded {
            return self.complete_tts_generation(lease_id);
        }
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(owner) = owners.tts.as_ref() else {
            return TtsGenerationCompletion::Stale;
        };
        if owner.lease.lease_id != lease_id || owner.stage != TtsOwnerStage::Generating {
            return TtsGenerationCompletion::Stale;
        }
        owners.tts = None;
        TtsGenerationCompletion::Released
    }
    pub fn release_tts(&self, lease_id: u64) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if owners.tts.as_ref().map(|owner| owner.lease.lease_id) != Some(lease_id) {
            return false;
        }
        owners.tts = None;
        true
    }
    pub fn release_tts_by_owner(&self, lease_id: u64, owner_window: &str) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(owner) = owners.tts.as_ref() else {
            return false;
        };
        if owner.lease.lease_id != lease_id
            || owner.lease.owner_window != owner_window
            || !matches!(owner.stage, TtsOwnerStage::Ready | TtsOwnerStage::Playback)
        {
            return false;
        }
        owners.tts = None;
        true
    }
    fn markdown_snapshot(key: &MarkdownAiKey, task: &MarkdownTask) -> MarkdownAiTaskSnapshot {
        MarkdownAiTaskSnapshot {
            key: key.clone(),
            outcome: task.outcome.clone(),
            apply_context: task.apply_context.clone(),
        }
    }
    fn start_markdown_request(
        &self,
        key: MarkdownAiKey,
        owner_window: String,
    ) -> Result<ProcessLease, MarkdownAiTaskSnapshot> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = owners.markdown.get(&key) {
            return Err(Self::markdown_snapshot(&key, existing));
        }
        if let Some(running) = owners.markdown.iter().find_map(|(existing_key, task)| {
            (existing_key.draft_id == key.draft_id
                && matches!(task.outcome, MarkdownAiOutcome::Running { .. }))
            .then(|| Self::markdown_snapshot(existing_key, task))
        }) {
            return Err(running);
        }
        let lease = Self::next(&mut owners, owner_window);
        owners.markdown.insert(
            key,
            MarkdownTask {
                lease: lease.clone(),
                outcome: MarkdownAiOutcome::Running {
                    lease_id: lease.lease_id,
                },
                apply_context: None,
                operation_id: None,
            },
        );
        Ok(lease)
    }
    #[cfg(test)]
    fn acquire_markdown(&self, key: MarkdownAiKey, owner_window: String) -> Option<ProcessLease> {
        self.start_markdown_request(key, owner_window).ok()
    }
    pub fn set_markdown_apply_context(
        &self,
        key: &MarkdownAiKey,
        lease_id: u64,
        context: MarkdownAiApplyContext,
    ) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(task) = owners.markdown.get_mut(key) else {
            return false;
        };
        if task.lease.lease_id != lease_id {
            return false;
        }
        task.apply_context = Some(context);
        true
    }
    #[cfg(test)]
    fn release_markdown(&self, key: &MarkdownAiKey, lease_id: u64) -> bool {
        self.consume_markdown(key, lease_id).is_some()
    }
    fn consume_markdown(&self, key: &MarkdownAiKey, lease_id: u64) -> Option<Option<String>> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(task) = owners.markdown.get(key) else {
            return None;
        };
        if task.lease.lease_id != lease_id
            || matches!(task.outcome, MarkdownAiOutcome::Running { .. })
        {
            return None;
        }
        let operation_id = task.operation_id.clone();
        owners.markdown.remove(key);
        Some(operation_id)
    }
    #[cfg(test)]
    fn release_markdown_by_owner(
        &self,
        key: &MarkdownAiKey,
        lease_id: u64,
        owner_window: &str,
    ) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(task) = owners.markdown.get(key) else {
            return false;
        };
        if task.lease.lease_id != lease_id
            || task.lease.owner_window != owner_window
            || matches!(task.outcome, MarkdownAiOutcome::Running { .. })
        {
            return false;
        }
        owners.markdown.remove(key);
        true
    }
    fn complete_markdown_task(
        &self,
        key: &MarkdownAiKey,
        lease_id: u64,
        result: Result<String, String>,
        operation_id: Option<String>,
    ) -> Option<MarkdownAiTaskSnapshot> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(task) = owners.markdown.get_mut(key) else {
            return None;
        };
        if task.lease.lease_id != lease_id
            || !matches!(task.outcome, MarkdownAiOutcome::Running { .. })
        {
            return None;
        }
        task.operation_id = result.is_ok().then_some(operation_id).flatten();
        task.outcome = match result {
            Ok(output) => MarkdownAiOutcome::Success { lease_id, output },
            Err(error) => MarkdownAiOutcome::Error { lease_id, error },
        };
        Some(Self::markdown_snapshot(key, task))
    }
    #[cfg(test)]
    fn complete_markdown(
        &self,
        key: &MarkdownAiKey,
        lease_id: u64,
        result: Result<String, String>,
    ) -> bool {
        self.complete_markdown_task(key, lease_id, result, None)
            .is_some()
    }
    pub fn markdown_tasks(&self, draft_id: &str) -> Vec<MarkdownAiTaskSnapshot> {
        let owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut tasks = owners
            .markdown
            .iter()
            .filter(|(key, _)| key.draft_id == draft_id)
            .map(|(key, task)| Self::markdown_snapshot(key, task))
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| std::cmp::Reverse(task.outcome.lease_id()));
        tasks
    }
    pub fn acquire_file(&self, key: FileCommandKey, owner_window: String) -> Option<ProcessLease> {
        self.acquire_file_request(key, owner_window, String::new())
    }
    pub fn acquire_file_request(
        &self,
        key: FileCommandKey,
        owner_window: String,
        request_fingerprint: String,
    ) -> Option<ProcessLease> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if owners
            .files
            .get(&key)
            .and_then(|task| task.active.as_ref())
            .is_some()
        {
            return None;
        }
        let lease = Self::next(&mut owners, owner_window.clone());
        owners.files.insert(
            key,
            FileCommandTask {
                active: Some(lease.clone()),
                owner_window,
                request_fingerprint,
                latest: FileCommandOutcome::Running {
                    lease_id: lease.lease_id,
                },
            },
        );
        Some(lease)
    }
    pub fn complete_file(
        &self,
        key: &FileCommandKey,
        lease_id: u64,
        result: Result<(String, String), String>,
    ) -> Option<FileCommandSnapshot> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let task = owners.files.get_mut(key)?;
        if task.active.as_ref().map(|lease| lease.lease_id) != Some(lease_id) {
            return None;
        }
        task.active = None;
        task.latest = match result {
            Ok((path, message)) => FileCommandOutcome::Success {
                lease_id,
                path,
                message,
            },
            Err(error) => FileCommandOutcome::Error { lease_id, error },
        };
        Some(FileCommandSnapshot {
            key: key.clone(),
            owner_window: task.owner_window.clone(),
            request_fingerprint: task.request_fingerprint.clone(),
            outcome: task.latest.clone(),
        })
    }
    pub fn cancel_file(&self, key: &FileCommandKey, lease_id: u64) -> Option<FileCommandSnapshot> {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let task = owners.files.get_mut(key)?;
        if task.active.as_ref().map(|lease| lease.lease_id) != Some(lease_id) {
            return None;
        }
        task.active = None;
        task.latest = FileCommandOutcome::Cancelled { lease_id };
        Some(FileCommandSnapshot {
            key: key.clone(),
            owner_window: task.owner_window.clone(),
            request_fingerprint: task.request_fingerprint.clone(),
            outcome: task.latest.clone(),
        })
    }
    pub fn file_snapshots(&self) -> Vec<FileCommandSnapshot> {
        let owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        owners
            .files
            .iter()
            .map(|(key, task)| FileCommandSnapshot {
                key: key.clone(),
                owner_window: task.owner_window.clone(),
                request_fingerprint: task.request_fingerprint.clone(),
                outcome: task.latest.clone(),
            })
            .collect()
    }
    pub fn file_snapshots_for(&self, owner_window: &str) -> Vec<FileCommandSnapshot> {
        let owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        owners
            .files
            .iter()
            .filter(|(_, task)| task.owner_window == owner_window)
            .map(|(key, task)| FileCommandSnapshot {
                key: key.clone(),
                owner_window: task.owner_window.clone(),
                request_fingerprint: task.request_fingerprint.clone(),
                outcome: task.latest.clone(),
            })
            .collect()
    }
    pub fn file_snapshot(&self, key: &FileCommandKey) -> Option<FileCommandSnapshot> {
        let owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        owners.files.get(key).map(|task| FileCommandSnapshot {
            key: key.clone(),
            owner_window: task.owner_window.clone(),
            request_fingerprint: task.request_fingerprint.clone(),
            outcome: task.latest.clone(),
        })
    }
    pub fn consume_file(
        &self,
        key: &FileCommandKey,
        lease_id: u64,
        owner_window: &str,
    ) -> ConsumeFileCommandResult {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(task) = owners.files.get(key) else {
            return if owners.consumed_files.get(key).copied().unwrap_or(0) >= lease_id {
                ConsumeFileCommandResult::AlreadyConsumed
            } else {
                ConsumeFileCommandResult::Stale
            };
        };
        if task.owner_window != owner_window
            || task.active.is_some()
            || task.latest.lease_id() != lease_id
            || matches!(task.latest, FileCommandOutcome::Running { .. })
        {
            return ConsumeFileCommandResult::Stale;
        }
        owners.files.remove(key);
        owners.consumed_files.insert(key.clone(), lease_id);
        ConsumeFileCommandResult::Consumed
    }
    pub fn owner_window_destroyed(&self, owner_window: &str) -> bool {
        let mut owners = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(owner) = owners.tts.as_mut() else {
            return false;
        };
        if owner.lease.owner_window != owner_window {
            return false;
        }
        match owner.stage {
            TtsOwnerStage::Ready => {
                owners.tts = None;
                true
            }
            TtsOwnerStage::Generating => {
                owner.owner_alive = false;
                false
            }
            TtsOwnerStage::Playback => {
                owners.tts = None;
                true
            }
        }
    }
}

#[tauri::command]
pub fn acquire_tts_playback_owner(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ProcessOwners>,
) -> Option<ProcessLease> {
    state.acquire_tts(window.label().to_owned())
}
#[tauri::command]
pub fn release_tts_playback_owner(
    lease_id: u64,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ProcessOwners>,
) -> bool {
    state.release_tts_by_owner(lease_id, window.label())
}
#[tauri::command]
pub fn get_markdown_ai_tasks(
    draft_id: String,
    state: tauri::State<'_, ProcessOwners>,
) -> Vec<MarkdownAiTaskSnapshot> {
    state.markdown_tasks(&draft_id)
}
#[tauri::command]
pub fn consume_markdown_ai_task(
    key: MarkdownAiKey,
    lease_id: u64,
    state: tauri::State<'_, ProcessOwners>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> bool {
    consume_markdown_ai_task_inner(state.inner(), registry.inner(), &key, lease_id)
}

fn consume_markdown_ai_task_inner(
    state: &ProcessOwners,
    registry: &crate::idempotency::Registry,
    key: &MarkdownAiKey,
    lease_id: u64,
) -> bool {
    let Some(operation_id) = state.consume_markdown(key, lease_id) else {
        return false;
    };
    if let Some(operation_id) = operation_id {
        if let Err(error) = registry.acknowledge(&operation_id) {
            tracing::warn!(
                error,
                "Consumed Markdown AI result remains pending in the idempotency registry"
            );
        }
    }
    true
}

fn translation_needs_retry(source: &str, output: &str) -> bool {
    let source_chinese = source
        .chars()
        .filter(|c| ('\u{3400}'..='\u{9fff}').contains(c))
        .count();
    let source_latin = source.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let output_chinese = output
        .chars()
        .filter(|c| ('\u{3400}'..='\u{9fff}').contains(c))
        .count();
    let output_latin = output.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let normalized = |text: &str| {
        text.to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || ('\u{3400}'..='\u{9fff}').contains(c))
            .collect::<String>()
    };
    let a = normalized(source);
    let b = normalized(output);
    b.is_empty()
        || (a.len() >= 8 && a == b)
        || output.to_lowercase().contains("cannot translate")
        || output.contains("无法翻译")
        || (source_chinese >= std::cmp::max(2, (source_latin as f64 * 0.25).ceil() as usize)
            && output_latin < 4)
        || (source_chinese < std::cmp::max(2, (source_latin as f64 * 0.25).ceil() as usize)
            && source_latin >= 8
            && output_chinese < 2)
}

fn translation_retry_question<'a>(
    action: &MarkdownAiAction,
    source_text: &str,
    result: &Result<(String, Option<String>), String>,
    retry_question: Option<&'a str>,
) -> Option<&'a str> {
    if action == &MarkdownAiAction::Translate
        && result
            .as_ref()
            .is_ok_and(|(output, _)| translation_needs_retry(source_text, output))
    {
        retry_question
    } else {
        None
    }
}

async fn finish_markdown_request<F, Fut>(
    prompt: MarkdownAiPrompt,
    window: tauri::WebviewWindow,
    owners: tauri::State<'_, ProcessOwners>,
    registry: Option<crate::idempotency::Registry>,
    run: F,
) -> Result<MarkdownAiTaskSnapshot, String>
where
    F: Fn(String, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<(String, Option<String>), String>>,
{
    let lease_id =
        match owners.start_markdown_request(prompt.key.clone(), window.label().to_owned()) {
            Ok(lease) => lease.lease_id,
            Err(running) => return Ok(running),
        };
    owners.set_markdown_apply_context(&prompt.key, lease_id, prompt.apply_context.clone());
    use tauri::Emitter;
    if let Some(running) = owners
        .markdown_tasks(&prompt.key.draft_id)
        .into_iter()
        .find(|task| task.key == prompt.key)
    {
        let _ = window.app_handle().emit("markdown-ai:updated", &running);
    }
    let mut result = run(prompt.question, prompt.context.clone()).await;
    if let Some(retry_question) = translation_retry_question(
        &prompt.key.request.action,
        &prompt.source_text,
        &result,
        prompt.retry_question.as_deref(),
    )
    .map(str::to_owned)
    {
        if let Ok((_, Some(operation_id))) = &result {
            if let Some(registry) = &registry {
                if let Err(error) = registry.acknowledge(operation_id) {
                    tracing::warn!(
                        error,
                        "Rejected Markdown AI result remains pending after retry"
                    );
                }
            }
        }
        result = run(retry_question, prompt.context)
            .await
            .and_then(|output| {
                if translation_needs_retry(&prompt.source_text, &output.0) {
                    Err("本地模型连续两次未完成翻译，请稍后重试或换用更大的模型。".into())
                } else {
                    Ok(output)
                }
            });
    }
    let operation_id = result
        .as_ref()
        .ok()
        .and_then(|(_, operation_id)| operation_id.clone());
    let result = result.map(|(output, _)| output);
    let returned = result.clone();
    let snapshot = owners
        .complete_markdown_task(&prompt.key, lease_id, result, operation_id)
        .ok_or_else(|| {
            returned
                .err()
                .unwrap_or_else(|| "Markdown AI outcome missing".into())
        })?;
    let _ = window.app_handle().emit("markdown-ai:updated", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn run_proxy_markdown_ai(
    request: MarkdownAiPrompt,
    window: tauri::WebviewWindow,
    owners: tauri::State<'_, ProcessOwners>,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
    api_base_url: String,
    token: String,
) -> Result<MarkdownAiTaskSnapshot, String> {
    let key_bytes = serde_json::to_vec(&request.key).map_err(|error| error.to_string())?;
    let operation_scope = crate::idempotency::derived_key("markdown-ai", &[&key_bytes]);
    finish_markdown_request(
        request,
        window,
        owners,
        Some(registry.inner().clone()),
        |question, context| {
            let api_base_url = api_base_url.clone();
            let token = token.clone();
            let operation_scope = operation_scope.clone();
            let client = client.inner().clone();
            let registry = registry.inner().clone();
            async move {
                let result = crate::commands::backend::ask_proxy_llm_once_inner(
                    api_base_url,
                    token,
                    question,
                    context,
                    operation_scope,
                    &client,
                    &registry,
                )
                .await?;
                Ok((result.text, Some(result.operation_id)))
            }
        },
    )
    .await
}

#[tauri::command]
pub async fn run_local_markdown_ai(
    request: LocalMarkdownAiRequest,
    window: tauri::WebviewWindow,
    owners: tauri::State<'_, ProcessOwners>,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<MarkdownAiTaskSnapshot, String> {
    let LocalMarkdownAiRequest {
        prompt,
        provider,
        api_key,
        base_url,
        model,
    } = request;
    finish_markdown_request(prompt, window, owners, None, |question, context| {
        let provider = provider.clone();
        let api_key = api_key.clone();
        let base_url = base_url.clone();
        let model = model.clone();
        let client = client.inner().clone();
        async move {
            crate::commands::llm::ask_llm_once_inner(
                question, provider, api_key, base_url, model, context, &client,
            )
            .await
            .map(|text| (text, None))
        }
    })
    .await
}
#[tauri::command]
pub fn get_file_command_tasks(
    window: tauri::Window,
    owners: tauri::State<'_, ProcessOwners>,
) -> Vec<FileCommandSnapshot> {
    owners.file_snapshots_for(window.label())
}

#[tauri::command]
pub fn consume_file_command_task(
    window: tauri::Window,
    owners: tauri::State<'_, ProcessOwners>,
    key: FileCommandKey,
    lease_id: u64,
) -> ConsumeFileCommandResult {
    owners.consume_file(&key, lease_id, window.label())
}
#[tauri::command]
pub fn notify_owner_window_destroyed(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ProcessOwners>,
) -> bool {
    state.owner_window_destroyed(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(revision: &str, target: MarkdownRequestTarget) -> MarkdownAiKey {
        MarkdownAiKey {
            draft_id: "draft".into(),
            request: MarkdownRequestIdentity {
                action: MarkdownAiAction::Polish,
                target,
                draft_revision: revision.into(),
                semantic_fingerprint: "scope-a".into(),
            },
        }
    }
    fn file(resource_id: &str, command_kind: FileCommandKind) -> FileCommandKey {
        FileCommandKey {
            resource_id: resource_id.into(),
            command_kind,
        }
    }
    fn test_registry(label: &str) -> (crate::idempotency::Registry, std::path::PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "echolike-markdown-idempotency-{label}-{}-{nonce}.db",
            std::process::id()
        ));
        (
            crate::idempotency::Registry::new(path.clone()).unwrap(),
            path,
        )
    }

    #[test]
    fn tts_generation_destruction_stays_locked_until_matched_completion_release() {
        let owners = ProcessOwners::default();
        let lease = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(lease.lease_id, "owner"));
        assert!(!owners.owner_window_destroyed("owner"));
        assert!(owners.acquire_tts("other".into()).is_none());
        assert!(!owners.release_tts_by_owner(lease.lease_id, "owner"));
        assert!(!owners.release_tts(lease.lease_id + 1));
        assert_eq!(
            owners.complete_tts_generation(lease.lease_id),
            TtsGenerationCompletion::Released
        );
        assert!(owners.acquire_tts("other".into()).is_some());
    }
    #[test]
    fn live_generation_completion_transitions_and_stale_completion_cannot_touch_reuse() {
        let owners = ProcessOwners::default();
        let first = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(first.lease_id, "owner"));
        assert_eq!(
            owners.complete_tts_generation(first.lease_id),
            TtsGenerationCompletion::Playback
        );
        assert!(owners.release_tts_by_owner(first.lease_id, "owner"));
        let second = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(second.lease_id, "owner"));
        assert_eq!(
            owners.complete_tts_generation(first.lease_id),
            TtsGenerationCompletion::Stale
        );
        assert!(owners.acquire_tts("other".into()).is_none());
        assert_eq!(
            owners.complete_tts_generation(second.lease_id),
            TtsGenerationCompletion::Playback
        );
    }
    #[test]
    fn playback_destruction_is_owner_bound_and_stale_transition_cannot_mutate_reused_lease() {
        let owners = ProcessOwners::default();
        let first = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(first.lease_id, "owner"));
        assert!(!owners.transition_tts_to_playback(first.lease_id, "other"));
        assert!(owners.transition_tts_to_playback(first.lease_id, "owner"));
        assert!(!owners.owner_window_destroyed("other"));
        assert!(owners.owner_window_destroyed("owner"));
        let second = owners.acquire_tts("owner".into()).unwrap();
        assert!(second.lease_id > first.lease_id);
        assert!(!owners.transition_tts_to_playback(first.lease_id, "owner"));
        assert!(owners.begin_tts_generation(second.lease_id, "owner"));
        assert!(owners.transition_tts_to_playback(second.lease_id, "owner"));
        assert!(!owners.release_tts_by_owner(second.lease_id, "other"));
        assert!(owners.release_tts_by_owner(second.lease_id, "owner"));
    }
    #[test]
    fn tts_lease_reuses_generation_stage_for_multiple_chunks() {
        let owners = ProcessOwners::default();
        let lease = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(lease.lease_id, "owner"));
        assert!(!owners.begin_tts_generation(lease.lease_id, "owner"));
        assert_eq!(
            owners.complete_tts_generation(lease.lease_id),
            TtsGenerationCompletion::Playback
        );
        assert!(owners.begin_tts_generation(lease.lease_id, "owner"));
        assert_eq!(
            owners.complete_tts_generation(lease.lease_id),
            TtsGenerationCompletion::Playback
        );
        assert!(owners.release_tts_by_owner(lease.lease_id, "owner"));
    }
    #[test]
    fn ready_release_is_owner_matched_but_generation_cannot_be_frontend_released() {
        let owners = ProcessOwners::default();
        let ready = owners.acquire_tts("owner".into()).unwrap();
        assert!(!owners.release_tts_by_owner(ready.lease_id, "other"));
        assert!(owners.release_tts_by_owner(ready.lease_id, "owner"));

        let generating = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(generating.lease_id, "owner"));
        assert!(!owners.release_tts_by_owner(generating.lease_id, "owner"));
        assert_eq!(
            owners.finish_tts_generation(generating.lease_id, false),
            TtsGenerationCompletion::Released
        );

        let reused = owners.acquire_tts("owner".into()).unwrap();
        assert!(reused.lease_id > generating.lease_id);
        assert!(!owners.release_tts_by_owner(generating.lease_id, "owner"));
        assert!(owners.release_tts_by_owner(reused.lease_id, "owner"));
    }
    #[test]
    fn native_artifact_generation_releases_immediately_without_entering_playback() {
        let owners = ProcessOwners::default();
        let generation = owners.acquire_tts("markdown-editor".into()).unwrap();
        assert!(owners.begin_tts_generation(generation.lease_id, "markdown-editor"));

        assert!(owners.release_tts(generation.lease_id));
        assert!(owners.acquire_tts("main".into()).is_some());
    }
    #[test]
    fn generation_failure_releases_live_or_destroyed_owner_and_success_enters_playback() {
        let owners = ProcessOwners::default();
        let failed = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(failed.lease_id, "owner"));
        assert_eq!(
            owners.finish_tts_generation(failed.lease_id, false),
            TtsGenerationCompletion::Released
        );

        let success = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(success.lease_id, "owner"));
        assert_eq!(
            owners.finish_tts_generation(success.lease_id, true),
            TtsGenerationCompletion::Playback
        );
        assert!(owners.release_tts_by_owner(success.lease_id, "owner"));

        let destroyed = owners.acquire_tts("owner".into()).unwrap();
        assert!(owners.begin_tts_generation(destroyed.lease_id, "owner"));
        assert!(!owners.owner_window_destroyed("owner"));
        assert_eq!(
            owners.finish_tts_generation(destroyed.lease_id, true),
            TtsGenerationCompletion::Released
        );
    }
    #[test]
    fn markdown_serializes_any_running_action_per_draft_but_keeps_drafts_parallel() {
        let owners = ProcessOwners::default();
        let exact = request("rev-1", MarkdownRequestTarget::FullDocument);
        let first = owners
            .start_markdown_request(exact.clone(), "owner".into())
            .unwrap();
        let mut different_context = request("rev-1", MarkdownRequestTarget::FullDocument);
        different_context.request.semantic_fingerprint = "scope-b".into();
        let running = owners
            .start_markdown_request(different_context, "other".into())
            .unwrap_err();
        assert_eq!(running.key, exact);
        assert!(
            matches!(running.outcome, MarkdownAiOutcome::Running { lease_id } if lease_id == first.lease_id)
        );
        assert!(owners.acquire_markdown(exact, "other".into()).is_none());
        assert!(owners
            .acquire_markdown(
                request("rev-2", MarkdownRequestTarget::FullDocument),
                "other".into()
            )
            .is_none());
        assert!(owners
            .acquire_markdown(
                request(
                    "rev-1",
                    MarkdownRequestTarget::Selection { start: 2, end: 8 }
                ),
                "other".into()
            )
            .is_none());
        let mut other_draft = request("rev-1", MarkdownRequestTarget::FullDocument);
        other_draft.draft_id = "draft-b".into();
        assert!(owners
            .acquire_markdown(other_draft, "other".into())
            .is_some());
    }
    #[test]
    fn markdown_draft_acquisition_is_atomic_under_contention() {
        use std::sync::{Arc, Barrier};

        let owners = Arc::new(ProcessOwners::default());
        let barrier = Arc::new(Barrier::new(8));
        let contenders = (0..8)
            .map(|index| {
                let owners = Arc::clone(&owners);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let key = request(&format!("rev-{index}"), MarkdownRequestTarget::FullDocument);
                    barrier.wait();
                    owners.acquire_markdown(key, format!("owner-{index}"))
                })
            })
            .collect::<Vec<_>>();

        let acquired = contenders
            .into_iter()
            .filter_map(|contender| contender.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(acquired.len(), 1);
        assert_eq!(
            owners
                .markdown_tasks("draft")
                .into_iter()
                .filter(|task| matches!(task.outcome, MarkdownAiOutcome::Running { .. }))
                .count(),
            1
        );
    }
    #[test]
    fn markdown_tasks_are_stably_sorted_by_newest_lease() {
        let owners = ProcessOwners::default();
        let first_key = request("rev-1", MarkdownRequestTarget::FullDocument);
        let first = owners
            .acquire_markdown(first_key.clone(), "owner".into())
            .unwrap();
        assert!(owners.complete_markdown(&first_key, first.lease_id, Ok("first".into())));

        let second_key = request(
            "rev-2",
            MarkdownRequestTarget::Selection { start: 1, end: 2 },
        );
        let second = owners
            .acquire_markdown(second_key.clone(), "owner".into())
            .unwrap();
        assert!(second.lease_id > first.lease_id);

        let tasks = owners.markdown_tasks("draft");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].outcome.lease_id(), second.lease_id);
        assert_eq!(tasks[1].outcome.lease_id(), first.lease_id);
    }
    #[test]
    fn markdown_success_survives_cross_window_retry_until_consumed() {
        let owners = ProcessOwners::default();
        let key = request("rev", MarkdownRequestTarget::FullDocument);
        let first = owners.acquire_markdown(key.clone(), "main".into()).unwrap();
        assert!(!owners.owner_window_destroyed("main"));
        assert!(owners
            .acquire_markdown(key.clone(), "markdown-editor".into())
            .is_none());
        assert!(owners.complete_markdown(&key, first.lease_id, Ok("result".into())));
        let retry = owners
            .start_markdown_request(key.clone(), "markdown-editor".into())
            .unwrap_err();
        assert_eq!(retry.key, key);
        assert!(
            matches!(retry.outcome, MarkdownAiOutcome::Success { lease_id, ref output } if lease_id == first.lease_id && output == "result")
        );
        assert_eq!(owners.markdown_tasks("draft"), vec![retry]);
        assert!(!owners.release_markdown_by_owner(&key, first.lease_id, "markdown-editor"));
        assert!(owners.release_markdown(&key, first.lease_id));

        let second = owners
            .acquire_markdown(key.clone(), "markdown-editor".into())
            .unwrap();
        assert_eq!(second.lease_id, first.lease_id + 1);
        assert!(!owners.complete_markdown(&key, first.lease_id, Err("late".into())));
        assert!(!owners.release_markdown(&key, first.lease_id));
        assert!(!owners.release_markdown_by_owner(&key, first.lease_id, "main"));
        assert!(
            matches!(owners.markdown_tasks("draft")[0].outcome, MarkdownAiOutcome::Running { lease_id } if lease_id == second.lease_id)
        );
    }
    #[test]
    fn markdown_error_survives_direct_acquire_retry_until_consumed() {
        let owners = ProcessOwners::default();
        let key = request("rev", MarkdownRequestTarget::FullDocument);
        let first = owners.acquire_markdown(key.clone(), "main".into()).unwrap();
        assert!(owners.complete_markdown(&key, first.lease_id, Err("failed".into())));

        assert!(owners
            .acquire_markdown(key.clone(), "markdown-editor".into())
            .is_none());
        let tasks = owners.markdown_tasks("draft");
        assert_eq!(tasks.len(), 1);
        assert!(
            matches!(tasks[0].outcome, MarkdownAiOutcome::Error { lease_id, ref error } if lease_id == first.lease_id && error == "failed")
        );

        assert!(owners.release_markdown(&key, first.lease_id));
        let second = owners
            .acquire_markdown(key.clone(), "markdown-editor".into())
            .unwrap();
        assert_eq!(second.lease_id, first.lease_id + 1);
        assert!(!owners.complete_markdown(&key, first.lease_id, Ok("late".into())));
        assert!(
            matches!(owners.markdown_tasks("draft")[0].outcome, MarkdownAiOutcome::Running { lease_id } if lease_id == second.lease_id)
        );
    }
    #[test]
    fn markdown_consume_acknowledges_only_the_matching_terminal_operation() {
        let (registry, path) = test_registry("consume");
        let owners = ProcessOwners::default();
        let key = request("rev", MarkdownRequestTarget::FullDocument);
        let lease = owners.acquire_markdown(key.clone(), "main".into()).unwrap();
        let operation = registry.acquire("markdown-test", &[b"payload"]).unwrap();
        let operation_root = operation.root().to_string();
        let snapshot = owners
            .complete_markdown_task(
                &key,
                lease.lease_id,
                Ok("result".into()),
                Some(operation_root.clone()),
            )
            .unwrap();
        assert!(serde_json::to_value(snapshot)
            .unwrap()
            .get("operationId")
            .is_none());

        assert!(!consume_markdown_ai_task_inner(
            &owners,
            &registry,
            &key,
            lease.lease_id + 1
        ));
        assert_eq!(
            registry
                .acquire("markdown-test", &[b"payload"])
                .unwrap()
                .root(),
            operation_root
        );

        assert!(consume_markdown_ai_task_inner(
            &owners,
            &registry,
            &key,
            lease.lease_id
        ));
        assert_ne!(
            registry
                .acquire("markdown-test", &[b"payload"])
                .unwrap()
                .root(),
            operation_root
        );

        drop(operation);
        drop(registry);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn markdown_translation_only_publishes_a_valid_final_attempt() {
        assert!(translation_needs_retry(
            "Please send the final report tomorrow.",
            "Please send the final report tomorrow."
        ));
        assert!(translation_needs_retry(
            "Please send the final report tomorrow.",
            "无法翻译"
        ));
        assert!(!translation_needs_retry(
            "Please send the final report tomorrow.",
            "请明天发送最终报告。"
        ));
    }

    #[test]
    fn markdown_translation_without_a_retry_prompt_keeps_the_first_operation_pending() {
        let result = Ok((
            "Please send the final report tomorrow.".to_string(),
            Some("network-operation".to_string()),
        ));

        assert_eq!(
            translation_retry_question(
                &MarkdownAiAction::Translate,
                "Please send the final report tomorrow.",
                &result,
                None,
            ),
            None
        );
        assert_eq!(
            translation_retry_question(
                &MarkdownAiAction::Translate,
                "Please send the final report tomorrow.",
                &result,
                Some("Translate the text into Simplified Chinese."),
            ),
            Some("Translate the text into Simplified Chinese.")
        );
    }
    #[test]
    fn keyed_releases_are_lease_and_owner_matched() {
        let owners = ProcessOwners::default();
        let key = request("rev", MarkdownRequestTarget::FullDocument);
        let ai = owners
            .acquire_markdown(key.clone(), "owner".into())
            .unwrap();
        assert!(!owners.release_markdown_by_owner(&key, ai.lease_id, "other"));
        assert!(!owners.release_markdown_by_owner(&key, ai.lease_id + 1, "owner"));
        assert!(!owners.release_markdown_by_owner(&key, ai.lease_id, "owner"));
        assert!(owners.complete_markdown(&key, ai.lease_id, Ok("done".into())));
        assert!(owners.release_markdown_by_owner(&key, ai.lease_id, "owner"));
        let key = file("draft", FileCommandKind::ExportDocx);
        owners.acquire_file(key.clone(), "owner".into()).unwrap();
        assert!(matches!(
            owners.file_snapshots()[0].outcome,
            FileCommandOutcome::Running { .. }
        ));
    }
    #[test]
    fn file_exact_key_rejects_and_distinct_resource_or_kind_runs_in_parallel() {
        let owners = ProcessOwners::default();
        let exact = file("draft-a", FileCommandKind::ExportDocx);
        assert!(owners.acquire_file(exact.clone(), "owner".into()).is_some());
        assert!(owners.acquire_file(exact, "other".into()).is_none());
        assert!(owners
            .acquire_file(file("draft-b", FileCommandKind::ExportDocx), "other".into())
            .is_some());
        assert!(owners
            .acquire_file(
                file("draft-a", FileCommandKind::SaveMarkdown),
                "other".into()
            )
            .is_some());
    }
    #[test]
    fn destruction_keeps_file_and_markdown_futures_and_stale_release_cannot_clear_reuse() {
        let owners = ProcessOwners::default();
        let markdown = request("rev", MarkdownRequestTarget::FullDocument);
        let file = file("draft", FileCommandKind::ExportPdf);
        let old_ai = owners
            .acquire_markdown(markdown.clone(), "owner".into())
            .unwrap();
        let old_file = owners.acquire_file(file.clone(), "owner".into()).unwrap();
        assert!(!owners.owner_window_destroyed("owner"));
        assert!(owners
            .acquire_markdown(markdown.clone(), "other".into())
            .is_none());
        assert!(owners.acquire_file(file.clone(), "other".into()).is_none());
        assert!(!owners.release_markdown(&markdown, old_ai.lease_id));
        assert!(owners.complete_markdown(&markdown, old_ai.lease_id, Ok("done".into())));
        assert!(owners.release_markdown(&markdown, old_ai.lease_id));
        assert!(owners
            .complete_file(
                &file,
                old_file.lease_id,
                Ok(("saved".into(), "done".into()))
            )
            .is_some());
        let new_ai = owners
            .acquire_markdown(markdown.clone(), "owner".into())
            .unwrap();
        let new_file = owners.acquire_file(file.clone(), "owner".into()).unwrap();
        assert!(!owners.release_markdown(&markdown, old_ai.lease_id));
        assert!(!owners.release_markdown_by_owner(&markdown, old_ai.lease_id, "owner"));
        assert!(!owners.release_markdown_by_owner(&markdown, new_ai.lease_id, "other"));
        assert!(owners
            .complete_file(&file, old_file.lease_id, Err("late".into()))
            .is_none());
        assert!(
            matches!(owners.file_snapshots().into_iter().find(|item| item.key == file).unwrap().outcome, FileCommandOutcome::Running { lease_id } if lease_id == new_file.lease_id)
        );
    }
    #[test]
    fn file_terminal_can_be_consumed_or_reacquired_without_unlocking_new_running() {
        let owners = ProcessOwners::default();
        let key = file("draft", FileCommandKind::SaveMarkdown);
        let first = owners
            .acquire_file_request(key.clone(), "owner".into(), "rev-before-edit".into())
            .unwrap();
        assert!(owners
            .complete_file(&key, first.lease_id, Ok(("one.md".into(), "saved".into())))
            .is_some());
        assert_eq!(
            owners.file_snapshots()[0].request_fingerprint,
            "rev-before-edit"
        );
        let second = owners
            .acquire_file_request(key.clone(), "other".into(), "rev-after-edit".into())
            .unwrap();
        assert!(second.lease_id > first.lease_id);
        assert_eq!(
            owners.consume_file(&key, first.lease_id, "owner"),
            ConsumeFileCommandResult::Stale
        );
        assert!(owners
            .complete_file(&key, first.lease_id, Err("late".into()))
            .is_none());
        assert!(
            matches!(owners.file_snapshots()[0].outcome, FileCommandOutcome::Running { lease_id } if lease_id == second.lease_id)
        );
        assert_eq!(
            owners.file_snapshots()[0].request_fingerprint,
            "rev-after-edit"
        );
    }
    #[test]
    fn second_webview_reconciles_an_already_consumed_terminal() {
        let owners = ProcessOwners::default();
        let key = file("draft", FileCommandKind::ExportDocx);
        let lease = owners.acquire_file(key.clone(), "one".into()).unwrap();
        owners.complete_file(
            &key,
            lease.lease_id,
            Ok(("one.docx".into(), "saved".into())),
        );
        assert_eq!(
            owners.consume_file(&key, lease.lease_id, "one"),
            ConsumeFileCommandResult::Consumed
        );
        assert_eq!(
            owners.consume_file(&key, lease.lease_id, "two"),
            ConsumeFileCommandResult::AlreadyConsumed
        );
        assert_eq!(
            owners.consume_file(&key, lease.lease_id + 1, "two"),
            ConsumeFileCommandResult::Stale
        );
    }
    #[test]
    fn file_terminal_is_visible_and_consumable_only_by_its_owner_window() {
        let owners = ProcessOwners::default();
        let key = file("draft", FileCommandKind::SaveMarkdown);
        let lease = owners
            .acquire_file(key.clone(), "markdown-editor".into())
            .unwrap();
        owners.complete_file(&key, lease.lease_id, Ok(("note.md".into(), "saved".into())));

        assert!(owners.file_snapshots_for("main").is_empty());
        assert_eq!(
            owners.consume_file(&key, lease.lease_id, "main"),
            ConsumeFileCommandResult::Stale
        );
        let snapshots = owners.file_snapshots_for("markdown-editor");
        assert_eq!(snapshots.len(), 1);
        let serialized = serde_json::to_value(&snapshots[0]).unwrap();
        assert_eq!(serialized["ownerWindow"], "markdown-editor");
        assert_eq!(
            owners.consume_file(&key, lease.lease_id, "markdown-editor"),
            ConsumeFileCommandResult::Consumed
        );
    }
    #[test]
    fn cancelled_file_dialog_releases_only_the_matching_lease() {
        let owners = ProcessOwners::default();
        let key = file("ocr", FileCommandKind::ExportMarkdown);
        let first = owners.acquire_file(key.clone(), "one".into()).unwrap();
        let cancelled = owners.cancel_file(&key, first.lease_id).unwrap();
        assert!(matches!(
            cancelled.outcome,
            FileCommandOutcome::Cancelled { lease_id } if lease_id == first.lease_id
        ));
        assert_eq!(
            owners.consume_file(&key, first.lease_id, "one"),
            ConsumeFileCommandResult::Consumed
        );
        let second = owners.acquire_file(key.clone(), "two".into()).unwrap();
        assert!(second.lease_id > first.lease_id);
        assert!(owners.cancel_file(&key, first.lease_id).is_none());
        assert!(matches!(
            owners.file_snapshot(&key).unwrap().outcome,
            FileCommandOutcome::Running { lease_id } if lease_id == second.lease_id
        ));
    }
    #[test]
    fn task_outcomes_serialize_camel_case_lease_ids_for_tauri_clients() {
        let file = serde_json::to_value(FileCommandOutcome::Success {
            lease_id: 7,
            path: "note.md".into(),
            message: "saved".into(),
        })
        .unwrap();
        assert_eq!(file["leaseId"], 7);
        assert!(file.get("lease_id").is_none());

        let cancelled =
            serde_json::to_value(FileCommandOutcome::Cancelled { lease_id: 8 }).unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(cancelled["leaseId"], 8);

        let markdown = serde_json::to_value(MarkdownAiOutcome::Success {
            lease_id: 9,
            output: "done".into(),
        })
        .unwrap();
        assert_eq!(markdown["leaseId"], 9);
        assert!(markdown.get("lease_id").is_none());
    }
    #[test]
    fn restart_is_idle() {
        let owners = ProcessOwners::default();
        assert!(owners.file_snapshots().is_empty());
        assert!(owners.acquire_tts("owner".into()).is_some());
    }
}
