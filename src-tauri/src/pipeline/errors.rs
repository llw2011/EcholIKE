use super::{AudioCaptureFault, AudioCaptureQuality, AudioCaptureStats};

pub(super) fn no_speech_user_error() -> crate::error::UserError {
    crate::error::UserError {
        code: "stt_no_speech_detected".to_string(),
        details: None,
        retry_count: 0,
    }
}

pub(super) fn stt_timeout_user_error() -> crate::error::UserError {
    crate::error::UserError {
        code: "stt_timeout".to_string(),
        details: None,
        retry_count: 0,
    }
}

pub(super) fn audio_user_error(code: &str, details: Option<String>) -> crate::error::UserError {
    crate::error::UserError {
        code: code.to_string(),
        details,
        retry_count: 0,
    }
}

pub(super) fn config_load_user_error(details: String) -> crate::error::UserError {
    crate::error::UserError {
        code: "config_unavailable".to_string(),
        details: Some(details),
        retry_count: 0,
    }
}

pub(super) fn audio_capture_fault_user_error(fault: &AudioCaptureFault) -> crate::error::UserError {
    let code = match fault {
        AudioCaptureFault::QueueFull | AudioCaptureFault::BufferLimit => "audio_overrun",
        AudioCaptureFault::Stream(_)
        | AudioCaptureFault::ConsumerClosed
        | AudioCaptureFault::WorkerPanicked => "audio_failed",
    };
    audio_user_error(code, Some(fault.to_string()))
}

pub(super) fn audio_capture_completion_error(
    stats: Option<&AudioCaptureStats>,
) -> Option<crate::error::UserError> {
    let Some(stats) = stats else {
        return Some(audio_user_error(
            "audio_failed",
            Some("audio capture ownership was missing at stop".to_string()),
        ));
    };
    if let Some(fault) = stats.fault.as_ref() {
        return Some(audio_capture_fault_user_error(fault));
    }
    match stats.quality() {
        AudioCaptureQuality::NoFrames => Some(audio_user_error("audio_no_frames", None)),
        AudioCaptureQuality::Silent => Some(audio_user_error("audio_silent", None)),
        AudioCaptureQuality::Valid => None,
    }
}

pub(super) fn llm_polish_user_error(error: &crate::error::AppError) -> crate::error::UserError {
    if matches!(error, crate::error::AppError::LlmQuota(_)) {
        return error.to_user_error();
    }

    crate::error::UserError {
        code: "llm_failed".to_string(),
        details: Some(error.to_string()),
        retry_count: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_speech_user_error_has_localizable_code() {
        let err = no_speech_user_error();
        assert_eq!(err.code, "stt_no_speech_detected");
        assert_eq!(err.retry_count, 0);
    }

    #[test]
    fn stt_timeout_user_error_has_localizable_code() {
        let err = stt_timeout_user_error();
        assert_eq!(err.code, "stt_timeout");
        assert_eq!(err.retry_count, 0);
    }

    #[test]
    fn unavailable_config_fails_closed_with_a_localizable_code() {
        let err = config_load_user_error("disk read failed".to_string());
        assert_eq!(err.code, "config_unavailable");
        assert_eq!(err.retry_count, 0);
    }

    fn capture_stats(
        input_frames: u64,
        pcm_bytes_delivered: u64,
        peak_amplitude: u16,
        fault: Option<AudioCaptureFault>,
    ) -> AudioCaptureStats {
        AudioCaptureStats {
            input_frames,
            pcm_bytes_delivered,
            peak_amplitude,
            dropped_chunks: u64::from(fault == Some(AudioCaptureFault::QueueFull)),
            fault,
        }
    }

    #[test]
    fn capture_completion_distinguishes_missing_silent_and_valid_pcm() {
        assert_eq!(
            audio_capture_completion_error(Some(&capture_stats(0, 0, 0, None)))
                .unwrap()
                .code,
            "audio_no_frames"
        );
        assert_eq!(
            audio_capture_completion_error(Some(&capture_stats(320, 640, 0, None)))
                .unwrap()
                .code,
            "audio_silent"
        );
        assert!(
            audio_capture_completion_error(Some(&capture_stats(320, 640, 2_000, None))).is_none()
        );
    }

    #[test]
    fn capture_completion_keeps_runtime_and_queue_faults_distinct() {
        assert_eq!(
            audio_capture_completion_error(Some(&capture_stats(
                320,
                640,
                2_000,
                Some(AudioCaptureFault::QueueFull),
            )))
            .unwrap()
            .code,
            "audio_overrun"
        );
        assert_eq!(
            audio_capture_completion_error(Some(&capture_stats(
                320,
                640,
                2_000,
                Some(AudioCaptureFault::Stream("device removed".to_string())),
            )))
            .unwrap()
            .code,
            "audio_failed"
        );
    }

    #[test]
    fn llm_polish_user_error_keeps_quota_code() {
        let err = llm_polish_user_error(&crate::error::AppError::LlmQuota(
            "quota exceeded".to_string(),
        ));
        assert_eq!(err.code, "llm_quota_exceeded");
        assert_eq!(err.details.as_deref(), Some("quota exceeded"));
    }

    #[test]
    fn llm_polish_user_error_uses_localizable_fallback_code() {
        let err = llm_polish_user_error(&crate::error::AppError::Auth(
            "Cloud LLM access denied".to_string(),
        ));
        assert_eq!(err.code, "llm_failed");
        assert_eq!(
            err.details.as_deref(),
            Some("Auth error: Cloud LLM access denied")
        );
    }
}
