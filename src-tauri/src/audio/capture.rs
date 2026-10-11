use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CaptureState {
    Idle,
    Starting,
    Recording,
}

#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub chunk_duration_ms: u32,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16000,
            channels: 1,
            chunk_duration_ms: 20,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioCaptureFault {
    Stream(String),
    QueueFull,
    ConsumerClosed,
    BufferLimit,
    WorkerPanicked,
}

impl std::fmt::Display for AudioCaptureFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stream(message) => formatter.write_str(message),
            Self::QueueFull => formatter.write_str("audio capture queue is full"),
            Self::ConsumerClosed => {
                formatter.write_str("audio capture consumer closed unexpectedly")
            }
            Self::BufferLimit => formatter.write_str("audio capture exceeded its bounded buffer"),
            Self::WorkerPanicked => {
                formatter.write_str("audio capture worker stopped unexpectedly")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioCaptureStats {
    pub input_frames: u64,
    pub pcm_bytes_delivered: u64,
    pub peak_amplitude: u16,
    pub dropped_chunks: u64,
    pub fault: Option<AudioCaptureFault>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCaptureQuality {
    NoFrames,
    Silent,
    Valid,
}

impl AudioCaptureStats {
    pub fn quality(&self) -> AudioCaptureQuality {
        if self.input_frames == 0 || self.pcm_bytes_delivered == 0 {
            AudioCaptureQuality::NoFrames
        } else if self.peak_amplitude <= SILENCE_PEAK_AMPLITUDE {
            AudioCaptureQuality::Silent
        } else {
            AudioCaptureQuality::Valid
        }
    }
}

/// A peak below roughly -54 dBFS is treated as a silent input device. This deliberately leaves
/// ordinary room noise above the native gate so that the STT provider remains the speech judge.
const SILENCE_PEAK_AMPLITUDE: u16 = 64;
const METER_FLOOR_DBFS: f32 = -60.0;
const METER_CEILING_DBFS: f32 = -6.0;
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
/// Maximum PCM accepted by the existing file-based providers (about 12.5 minutes at 16 kHz).
const MAX_PCM_BYTES: u64 = 24 * 1024 * 1024;
static CAPTURE_WORKER_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub struct AudioCaptureStartupTimeout {
    timeout: Duration,
}

impl std::fmt::Display for AudioCaptureStartupTimeout {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Audio capture did not receive a microphone frame within {}ms",
            self.timeout.as_millis()
        )
    }
}

impl std::error::Error for AudioCaptureStartupTimeout {}

struct CaptureWorkerLease;

impl CaptureWorkerLease {
    fn acquire() -> Result<Self> {
        CAPTURE_WORKER_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| {
                anyhow::anyhow!(
                    "A previous audio capture worker is still shutting down; please try again"
                )
            })
    }
}

impl Drop for CaptureWorkerLease {
    fn drop(&mut self) {
        CAPTURE_WORKER_ACTIVE.store(false, Ordering::SeqCst);
    }
}

fn run_capture_worker(shared: Arc<CaptureShared>, work: impl FnOnce() -> Result<()>) {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::error!("Audio capture thread error: {}", error);
            shared.fail(AudioCaptureFault::Stream(error.to_string()));
        }
        Err(_) => {
            tracing::error!("Audio capture worker panicked");
            shared.fail(AudioCaptureFault::WorkerPanicked);
        }
    }
    *shared
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = CaptureState::Idle;
}

struct CaptureShared {
    sender: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    startup: Mutex<Option<oneshot::Sender<std::result::Result<(), String>>>>,
    meter_window_peak: Mutex<f32>,
    state: Arc<Mutex<CaptureState>>,
    pcm_buffer: Mutex<Vec<i16>>,
    samples_per_chunk: usize,
    input_frames: AtomicU64,
    pcm_bytes_delivered: AtomicU64,
    peak_amplitude: AtomicU64,
    dropped_chunks: AtomicU64,
    fault: Mutex<Option<AudioCaptureFault>>,
}

impl CaptureShared {
    fn new(
        sender: mpsc::Sender<Vec<u8>>,
        startup: oneshot::Sender<std::result::Result<(), String>>,
        state: Arc<Mutex<CaptureState>>,
        samples_per_chunk: usize,
    ) -> Self {
        Self {
            sender: Mutex::new(Some(sender)),
            startup: Mutex::new(Some(startup)),
            meter_window_peak: Mutex::new(0.0),
            state,
            pcm_buffer: Mutex::new(Vec::with_capacity(samples_per_chunk)),
            samples_per_chunk,
            input_frames: AtomicU64::new(0),
            pcm_bytes_delivered: AtomicU64::new(0),
            peak_amplitude: AtomicU64::new(0),
            dropped_chunks: AtomicU64::new(0),
            fault: Mutex::new(None),
        }
    }

    fn snapshot(&self) -> AudioCaptureStats {
        AudioCaptureStats {
            input_frames: self.input_frames.load(Ordering::SeqCst),
            pcm_bytes_delivered: self.pcm_bytes_delivered.load(Ordering::SeqCst),
            peak_amplitude: self.peak_amplitude.load(Ordering::SeqCst) as u16,
            dropped_chunks: self.dropped_chunks.load(Ordering::SeqCst),
            fault: self
                .fault
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        }
    }

    fn fault(&self) -> Option<AudioCaptureFault> {
        self.fault
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn close_output(&self) {
        self.sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }

    fn record_fault(&self, fault: AudioCaptureFault) {
        let mut current = self.fault.lock().unwrap_or_else(|error| error.into_inner());
        if current.is_none() {
            *current = Some(fault);
        }
    }

    fn fail(&self, fault: AudioCaptureFault) {
        let message = fault.to_string();
        self.record_fault(fault);
        if let Some(startup) = self
            .startup
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = startup.send(Err(message));
        }
    }

    fn mark_first_frame(&self) {
        if self.fault().is_some() {
            return;
        }
        if let Some(startup) = self
            .startup
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            *self.state.lock().unwrap_or_else(|error| error.into_inner()) = CaptureState::Recording;
            let _ = startup.send(Ok(()));
        }
    }

    fn update_peak(&self, peak: u16) {
        let peak = u64::from(peak);
        let mut current = self.peak_amplitude.load(Ordering::Relaxed);
        while peak > current {
            match self.peak_amplitude.compare_exchange_weak(
                current,
                peak,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }

    fn record_meter_level(&self, level: f32) {
        let level = sanitize_unit_level(level);
        let mut window_peak = self
            .meter_window_peak
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *window_peak = (*window_peak).max(level);
    }

    fn take_meter_level(&self) -> f32 {
        let mut window_peak = self
            .meter_window_peak
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        std::mem::take(&mut *window_peak)
    }

    fn send_pcm(&self, samples: Vec<i16>) -> bool {
        if samples.is_empty() {
            return true;
        }
        let byte_count = (samples.len() * std::mem::size_of::<i16>()) as u64;
        let next_total = self.pcm_bytes_delivered.load(Ordering::Relaxed) + byte_count;
        if next_total > MAX_PCM_BYTES {
            self.record_fault(AudioCaptureFault::BufferLimit);
            return false;
        }
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        let send_result = self
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|sender| sender.try_send(bytes));
        match send_result {
            Some(Ok(())) => {
                self.pcm_bytes_delivered
                    .fetch_add(byte_count, Ordering::Relaxed);
                true
            }
            Some(Err(mpsc::error::TrySendError::Full(_))) => {
                self.dropped_chunks.fetch_add(1, Ordering::Relaxed);
                self.record_fault(AudioCaptureFault::QueueFull);
                false
            }
            None | Some(Err(mpsc::error::TrySendError::Closed(_))) => {
                self.record_fault(AudioCaptureFault::ConsumerClosed);
                false
            }
        }
    }

    fn flush_partial(&self) {
        let samples = {
            let mut buffer = self
                .pcm_buffer
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *buffer)
        };
        if self.fault().is_none() {
            self.send_pcm(samples);
        }
    }

    fn process_f32(&self, data: &[f32], device_sample_rate: u32, device_channels: u16) {
        if data.is_empty() || device_channels == 0 || self.fault().is_some() {
            return;
        }

        let input_frames = data.len() / usize::from(device_channels);
        if input_frames == 0 {
            return;
        }
        self.input_frames
            .fetch_add(input_frames as u64, Ordering::Relaxed);

        let mono = to_mono(data, device_channels);
        let resampled = downsample(&mono, device_sample_rate, 16_000);
        if resampled.is_empty() {
            return;
        }

        let converted = resampled
            .into_iter()
            .map(|sample| (sample * 32767.0).clamp(-32768.0, 32767.0) as i16)
            .collect::<Vec<_>>();
        self.record_meter_level(meter_level_from_pcm(&converted));
        let peak = converted
            .iter()
            .map(|sample| sample.unsigned_abs())
            .max()
            .unwrap_or(0);
        self.update_peak(peak);

        let mut buffer = self
            .pcm_buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        buffer.extend_from_slice(&converted);
        self.mark_first_frame();

        while buffer.len() >= self.samples_per_chunk {
            let chunk = buffer.drain(..self.samples_per_chunk).collect::<Vec<_>>();
            if !self.send_pcm(chunk) {
                break;
            }
        }
    }
}

/// Handle to control audio capture running on a dedicated thread.
pub struct AudioCaptureHandle {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
    shared: Arc<CaptureShared>,
}

impl AudioCaptureHandle {
    /// Start capture and wait until the device stream has produced its first non-empty frame.
    /// A successfully spawned thread is not sufficient evidence that a microphone is usable.
    pub async fn start(config: AudioConfig) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
        let worker_lease = CaptureWorkerLease::acquire()?;
        let samples_per_chunk =
            (config.sample_rate * config.chunk_duration_ms / 1000).max(1) as usize;
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(200);
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (startup_tx, startup_rx) = oneshot::channel();
        let state = Arc::new(Mutex::new(CaptureState::Starting));
        let shared = Arc::new(CaptureShared::new(
            audio_tx,
            startup_tx,
            state,
            samples_per_chunk,
        ));

        let worker_shared = shared.clone();
        let worker = std::thread::Builder::new()
            .name("echolike-audio-capture".to_string())
            .spawn(move || {
                let _worker_lease = worker_lease;
                run_capture_worker(worker_shared.clone(), || {
                    run_capture(config, stop_rx, worker_shared.clone())
                });
            })?;

        let mut handle = Self {
            stop_tx: Some(stop_tx),
            worker: Some(worker),
            shared,
        };
        if let Err(error) = await_capture_startup(startup_rx, FIRST_FRAME_TIMEOUT).await {
            handle.request_stop();
            // Initialization can be blocked inside a platform driver. Dropping a still-running
            // JoinHandle detaches only this failed worker; it owns no Pipeline state and observes
            // the closed stop channel as soon as the driver call returns.
            if handle
                .worker
                .as_ref()
                .is_some_and(std::thread::JoinHandle::is_finished)
            {
                let _ = handle.worker.take().expect("worker checked above").join();
            } else {
                handle.worker.take();
            }
            return Err(error);
        }

        Ok((handle, audio_rx))
    }

    fn request_stop(&mut self) {
        self.stop_tx.take();
        self.shared.take_meter_level();
    }

    pub fn stop(&mut self) -> AudioCaptureStats {
        self.request_stop();
        if self
            .worker
            .take()
            .is_some_and(|worker| worker.join().is_err())
        {
            self.shared.record_fault(AudioCaptureFault::WorkerPanicked);
        }
        // The callback sender lives in CaptureShared so capture statistics remain readable after
        // the worker exits. Release it explicitly here; otherwise STT collectors cannot observe
        // EOF until the entire handle is dropped, which can deadlock stop() behind their finalize.
        self.shared.close_output();
        *self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = CaptureState::Idle;
        self.shared.snapshot()
    }

    pub fn take_meter_level(&self) -> f32 {
        self.shared.take_meter_level()
    }

    pub fn state(&self) -> CaptureState {
        *self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn fault(&self) -> Option<AudioCaptureFault> {
        self.shared.fault()
    }
}

impl Drop for AudioCaptureHandle {
    fn drop(&mut self) {
        self.request_stop();
        // Normal Pipeline paths call stop() and join. Drop remains non-blocking so a platform
        // driver stalled during startup cannot freeze application shutdown.
        self.worker.take();
    }
}

async fn await_capture_startup(
    startup: oneshot::Receiver<std::result::Result<(), String>>,
    timeout: Duration,
) -> Result<()> {
    match tokio::time::timeout(timeout, startup).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(anyhow::anyhow!(message)),
        Ok(Err(_)) => Err(anyhow::anyhow!(
            "Audio capture worker stopped before the microphone became ready"
        )),
        Err(_) => Err(AudioCaptureStartupTimeout { timeout }.into()),
    }
}

fn sanitize_unit_level(level: f32) -> f32 {
    if level.is_finite() {
        level.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn meter_level_from_rms(rms: f32) -> f32 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0.0;
    }
    let dbfs = 20.0 * rms.min(1.0).log10();
    sanitize_unit_level((dbfs - METER_FLOOR_DBFS) / (METER_CEILING_DBFS - METER_FLOOR_DBFS))
}

fn meter_level_from_pcm(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_square = samples
        .iter()
        .map(|sample| {
            let normalized = f64::from(*sample) / 32768.0;
            normalized * normalized
        })
        .sum::<f64>()
        / samples.len() as f64;
    meter_level_from_rms(mean_square.sqrt() as f32)
}

/// Downsample audio from `from_rate` to `to_rate` (simple linear interpolation, mono).
fn downsample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if samples.is_empty() || from_rate == 0 || to_rate == 0 {
        return Vec::new();
    }
    if from_rate == to_rate {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = (samples.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = i as f64 * ratio;
        let idx = src_idx as usize;
        let frac = src_idx - idx as f64;
        let sample = if idx + 1 < samples.len() {
            samples[idx] as f64 * (1.0 - frac) + samples[idx + 1] as f64 * frac
        } else {
            samples[idx.min(samples.len() - 1)] as f64
        };
        out.push(sample as f32);
    }
    out
}

fn to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(usize::from(channels))
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

fn build_input_stream<T>(
    device: &cpal::Device,
    stream_config: &cpal::StreamConfig,
    shared: Arc<CaptureShared>,
    device_sample_rate: u32,
    device_channels: u16,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let data_shared = shared.clone();
    let error_shared = shared;
    Ok(device.build_input_stream(
        stream_config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let normalized = data
                .iter()
                .copied()
                .map(f32::from_sample)
                .collect::<Vec<_>>();
            data_shared.process_f32(&normalized, device_sample_rate, device_channels);
        },
        move |error| {
            tracing::error!("Audio capture error: {}", error);
            error_shared.fail(AudioCaptureFault::Stream(error.to_string()));
        },
        None,
    )?)
}

fn run_capture(
    config: AudioConfig,
    stop_rx: std::sync::mpsc::Receiver<()>,
    shared: Arc<CaptureShared>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow::anyhow!("No input device available"))?;
    tracing::info!("Using input device: {:?}", device.name());

    let default_config = device.default_input_config()?;
    let device_sample_rate = default_config.sample_rate().0;
    let device_channels = default_config.channels();
    let sample_format = default_config.sample_format();
    tracing::info!(
        "Device default config: {}Hz, {} channels, format: {:?}",
        device_sample_rate,
        device_channels,
        sample_format
    );

    let stream_config = cpal::StreamConfig {
        channels: device_channels,
        sample_rate: cpal::SampleRate(device_sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };
    let stream = match sample_format {
        SampleFormat::F32 => build_input_stream::<f32>(
            &device,
            &stream_config,
            shared.clone(),
            device_sample_rate,
            device_channels,
        )?,
        SampleFormat::I16 => build_input_stream::<i16>(
            &device,
            &stream_config,
            shared.clone(),
            device_sample_rate,
            device_channels,
        )?,
        SampleFormat::U16 => build_input_stream::<u16>(
            &device,
            &stream_config,
            shared.clone(),
            device_sample_rate,
            device_channels,
        )?,
        unsupported => {
            anyhow::bail!("Unsupported microphone sample format: {unsupported}");
        }
    };

    stream.play()?;
    tracing::info!(
        "Audio capture stream started (device: {}Hz {}ch -> target: {}Hz {}ch)",
        device_sample_rate,
        device_channels,
        config.sample_rate,
        config.channels
    );

    let _ = stop_rx.recv();
    drop(stream);
    shared.flush_partial();
    tracing::info!("Audio capture stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_near(actual: f32, expected: f32, tolerance: f32) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {actual} to be within {tolerance} of {expected}"
        );
    }

    fn rms_at_dbfs(dbfs: f32) -> f32 {
        10.0f32.powf(dbfs / 20.0)
    }

    fn test_shared(
        capacity: usize,
        samples_per_chunk: usize,
    ) -> (
        Arc<CaptureShared>,
        mpsc::Receiver<Vec<u8>>,
        oneshot::Receiver<std::result::Result<(), String>>,
    ) {
        let (audio_tx, audio_rx) = mpsc::channel(capacity);
        let (startup_tx, startup_rx) = oneshot::channel();
        let shared = Arc::new(CaptureShared::new(
            audio_tx,
            startup_tx,
            Arc::new(Mutex::new(CaptureState::Starting)),
            samples_per_chunk,
        ));
        (shared, audio_rx, startup_rx)
    }

    #[tokio::test]
    async fn first_frame_handshake_requires_real_callback_data() {
        let (shared, _audio_rx, startup_rx) = test_shared(2, 4);
        shared.process_f32(&[], 16_000, 1);
        assert!(tokio::time::timeout(Duration::from_millis(5), startup_rx)
            .await
            .is_err());
        assert_eq!(shared.snapshot().input_frames, 0);
    }

    #[tokio::test]
    async fn startup_error_and_timeout_are_bounded() {
        let (failure_tx, failure_rx) = oneshot::channel();
        failure_tx.send(Err("no input device".to_string())).unwrap();
        assert!(await_capture_startup(failure_rx, Duration::from_secs(1))
            .await
            .unwrap_err()
            .to_string()
            .contains("no input device"));

        let (_held_tx, timeout_rx) = oneshot::channel();
        let timeout_error = await_capture_startup(timeout_rx, Duration::from_millis(5))
            .await
            .unwrap_err();
        assert!(timeout_error
            .downcast_ref::<AudioCaptureStartupTimeout>()
            .is_some());
        assert!(timeout_error.to_string().contains("within 5ms"));
    }

    #[test]
    fn meter_mapping_is_finite_clamped_and_monotonic() {
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1.0, 0.0] {
            assert_eq!(meter_level_from_rms(invalid), 0.0);
        }
        assert_near(
            meter_level_from_rms(rms_at_dbfs(METER_FLOOR_DBFS)),
            0.0,
            0.000_1,
        );
        assert_near(meter_level_from_rms(rms_at_dbfs(-33.0)), 0.5, 0.000_1);
        assert_near(
            meter_level_from_rms(rms_at_dbfs(-30.0)),
            30.0 / 54.0,
            0.000_1,
        );
        assert_near(
            meter_level_from_rms(rms_at_dbfs(METER_CEILING_DBFS)),
            1.0,
            0.000_1,
        );
        assert_eq!(meter_level_from_rms(1.0), 1.0);

        let levels = [-70.0, -60.0, -50.0, -40.0, -30.0, -20.0, -6.0, 0.0]
            .map(|dbfs| meter_level_from_rms(rms_at_dbfs(dbfs)));
        assert!(levels.iter().all(|level| level.is_finite()));
        assert!(levels.iter().all(|level| (0.0..=1.0).contains(level)));
        assert!(levels.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn meter_window_keeps_the_maximum_and_resets_after_take() {
        let (shared, _audio_rx, _startup_rx) = test_shared(4, 32);
        shared.record_meter_level(0.2);
        shared.record_meter_level(0.8);
        shared.record_meter_level(0.4);
        assert_near(shared.take_meter_level(), 0.8, f32::EPSILON);
        assert_eq!(shared.take_meter_level(), 0.0);

        shared.record_meter_level(f32::NAN);
        shared.record_meter_level(-1.0);
        shared.record_meter_level(2.0);
        assert_eq!(shared.take_meter_level(), 1.0);
    }

    #[tokio::test]
    async fn worker_panics_become_immediate_terminal_capture_faults() {
        let (shared, _audio_rx, startup_rx) = test_shared(2, 4);
        run_capture_worker(shared.clone(), || panic!("simulated capture panic"));

        assert!(startup_rx.await.unwrap().is_err());
        assert_eq!(shared.fault(), Some(AudioCaptureFault::WorkerPanicked));
        assert_eq!(
            *shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            CaptureState::Idle
        );
    }

    #[test]
    fn only_one_capture_worker_can_own_the_device_during_slow_shutdown() {
        let lease = CaptureWorkerLease::acquire().unwrap();
        assert!(CaptureWorkerLease::acquire().is_err());
        drop(lease);
        assert!(CaptureWorkerLease::acquire().is_ok());
    }

    #[tokio::test]
    async fn f32_i16_and_u16_samples_produce_equivalent_pcm() {
        let mut outputs = Vec::new();
        let mut meter_levels = Vec::new();
        for normalized in [
            vec![-0.5f32, 0.0, 0.5, 0.25],
            [-16384i16, 0, 16384, 8192]
                .into_iter()
                .map(f32::from_sample)
                .collect(),
            [16384u16, 32768, 49152, 40960]
                .into_iter()
                .map(f32::from_sample)
                .collect(),
        ] {
            let (shared, mut audio_rx, startup_rx) = test_shared(2, 4);
            shared.process_f32(&normalized, 16_000, 1);
            assert_eq!(startup_rx.await.unwrap(), Ok(()));
            let bytes = audio_rx.recv().await.unwrap();
            assert_eq!(bytes.len(), 8);
            let output = bytes
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
                .collect::<Vec<_>>();
            let stats = shared.snapshot();
            assert_eq!(stats.input_frames, 4);
            assert_eq!(stats.pcm_bytes_delivered, 8);
            assert_eq!(
                stats.peak_amplitude,
                output
                    .iter()
                    .map(|sample| sample.unsigned_abs())
                    .max()
                    .unwrap()
            );
            assert_eq!(stats.quality(), AudioCaptureQuality::Valid);
            meter_levels.push(shared.take_meter_level());
            outputs.push(output);
        }

        for pair in outputs.windows(2) {
            for (left, right) in pair[0].iter().zip(&pair[1]) {
                assert!((i32::from(*left) - i32::from(*right)).abs() <= 1);
            }
        }
        for pair in meter_levels.windows(2) {
            assert_near(pair[0], pair[1], 0.000_1);
        }
    }

    #[tokio::test]
    async fn stereo_input_counts_frames_and_downmixes_to_mono() {
        let (shared, mut audio_rx, startup_rx) = test_shared(2, 2);
        shared.process_f32(&[0.5, -0.5, 0.25, 0.25], 16_000, 2);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        let bytes = audio_rx.recv().await.unwrap();
        let output = bytes
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
            .collect::<Vec<_>>();

        assert_eq!(shared.snapshot().input_frames, 2);
        assert_eq!(output.len(), 2);
        assert_eq!(output[0], 0);
        assert!((8_190..=8_192).contains(&output[1]));
        assert_near(
            shared.take_meter_level(),
            meter_level_from_pcm(&output),
            f32::EPSILON,
        );
    }

    #[tokio::test]
    async fn phase_opposed_channels_are_silent_for_pcm_and_meter() {
        let (shared, mut audio_rx, startup_rx) = test_shared(2, 2);
        shared.process_f32(&[0.5, -0.5, 0.25, -0.25], 16_000, 2);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        let bytes = audio_rx.recv().await.unwrap();
        let output = bytes
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
            .collect::<Vec<_>>();

        assert_eq!(output, vec![0, 0]);
        assert_eq!(shared.take_meter_level(), 0.0);
    }

    #[tokio::test]
    async fn single_active_stereo_channel_meter_matches_the_downmixed_pcm() {
        let (shared, mut audio_rx, startup_rx) = test_shared(2, 2);
        shared.process_f32(&[0.5, 0.0, -0.5, 0.0], 16_000, 2);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        let bytes = audio_rx.recv().await.unwrap();
        let output = bytes
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
            .collect::<Vec<_>>();

        assert!((8_190..=8_192).contains(&output[0]));
        assert!((-8_192..=-8_190).contains(&output[1]));
        assert_near(
            shared.take_meter_level(),
            meter_level_from_pcm(&output),
            f32::EPSILON,
        );
    }

    #[tokio::test]
    async fn meter_window_retains_a_loud_callback_until_polled() {
        let (shared, _audio_rx, startup_rx) = test_shared(8, 4);
        shared.process_f32(&[0.05; 4], 16_000, 1);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        shared.process_f32(&[0.5; 4], 16_000, 1);
        shared.process_f32(&[0.1; 4], 16_000, 1);

        let loud_pcm = vec![(0.5 * 32767.0) as i16; 4];
        assert_near(
            shared.take_meter_level(),
            meter_level_from_pcm(&loud_pcm),
            0.000_1,
        );
        assert_eq!(shared.take_meter_level(), 0.0);
    }

    #[tokio::test]
    async fn silent_frames_are_distinct_from_no_frames() {
        let (shared, mut audio_rx, startup_rx) = test_shared(2, 4);
        shared.process_f32(&[0.0; 4], 16_000, 1);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        assert_eq!(audio_rx.recv().await.unwrap().len(), 8);
        assert_eq!(shared.snapshot().quality(), AudioCaptureQuality::Silent);

        let (empty, _audio_rx, _startup_rx) = test_shared(2, 4);
        assert_eq!(empty.snapshot().quality(), AudioCaptureQuality::NoFrames);
    }

    #[tokio::test]
    async fn stop_flushes_a_partial_callback_instead_of_reporting_no_frames() {
        let (shared, mut audio_rx, startup_rx) = test_shared(2, 4);
        shared.process_f32(&[0.5; 2], 16_000, 1);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        assert_eq!(audio_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty));

        shared.flush_partial();
        assert_eq!(audio_rx.recv().await.unwrap().len(), 4);
        let stats = shared.snapshot();
        assert_eq!(stats.input_frames, 2);
        assert_eq!(stats.pcm_bytes_delivered, 4);
        assert_eq!(stats.quality(), AudioCaptureQuality::Valid);
    }

    #[tokio::test]
    async fn full_consumer_queue_is_a_terminal_capture_fault() {
        let (shared, mut audio_rx, startup_rx) = test_shared(1, 4);
        shared.process_f32(&[0.5; 4], 16_000, 1);
        assert_eq!(startup_rx.await.unwrap(), Ok(()));
        shared.process_f32(&[0.5; 4], 16_000, 1);
        let stats = shared.snapshot();
        assert_eq!(stats.fault, Some(AudioCaptureFault::QueueFull));
        assert_eq!(stats.dropped_chunks, 1);
        assert!(audio_rx.recv().await.is_some());
    }

    #[test]
    fn stop_joins_the_owned_worker_before_returning_stats() {
        let (audio_tx, mut audio_rx) = mpsc::channel(1);
        let (startup_tx, _startup_rx) = oneshot::channel();
        let shared = Arc::new(CaptureShared::new(
            audio_tx,
            startup_tx,
            Arc::new(Mutex::new(CaptureState::Starting)),
            4,
        ));
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_exited = exited.clone();
        let worker = std::thread::spawn(move || {
            let _ = stop_rx.recv();
            worker_exited.store(true, Ordering::SeqCst);
        });
        let mut handle = AudioCaptureHandle {
            stop_tx: Some(stop_tx),
            worker: Some(worker),
            shared,
        };

        let stats = handle.stop();
        assert!(exited.load(Ordering::SeqCst));
        assert_eq!(stats.quality(), AudioCaptureQuality::NoFrames);
        assert_eq!(
            audio_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        );
    }
}
