use anyhow::Result;

#[derive(Debug)]
pub struct SystemAudioMuteGuard {
    previous_muted: bool,
    active: bool,
}

impl SystemAudioMuteGuard {
    pub fn mute_for_recording() -> Result<Self> {
        let previous_muted = platform::get_system_output_muted()?;
        platform::set_system_output_muted(true)?;

        Ok(Self {
            previous_muted,
            active: true,
        })
    }

    pub fn restore(mut self) -> Result<()> {
        self.active = false;
        platform::set_system_output_muted(self.previous_muted)
    }

    pub fn previous_muted(&self) -> bool {
        self.previous_muted
    }
}

impl Drop for SystemAudioMuteGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = platform::set_system_output_muted(self.previous_muted);
            self.active = false;
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use anyhow::Context;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    struct ComInit {
        should_uninitialize: bool,
    }

    impl ComInit {
        fn new() -> Result<Self> {
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if result == RPC_E_CHANGED_MODE {
                return Ok(Self {
                    should_uninitialize: false,
                });
            }
            result.ok().context("initialize COM for system audio")?;
            Ok(Self {
                should_uninitialize: true,
            })
        }
    }

    impl Drop for ComInit {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn with_endpoint_volume<T>(
        operation: impl FnOnce(&IAudioEndpointVolume) -> Result<T>,
    ) -> Result<T> {
        let _com = ComInit::new()?;
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .context("create audio endpoint enumerator")?;
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .context("get default output audio endpoint")?;
        let volume = unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) }
            .context("activate endpoint volume control")?;
        operation(&volume)
    }

    pub fn get_system_output_muted() -> Result<bool> {
        with_endpoint_volume(|volume| {
            let muted = unsafe { volume.GetMute() }.context("read system output mute state")?;
            Ok(muted.as_bool())
        })
    }

    pub fn set_system_output_muted(muted: bool) -> Result<()> {
        with_endpoint_volume(|volume| {
            unsafe { volume.SetMute(muted, std::ptr::null()) }
                .context("set system output mute state")
        })
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::*;
    use anyhow::bail;

    pub fn get_system_output_muted() -> Result<bool> {
        bail!("system output mute is only implemented on Windows")
    }

    pub fn set_system_output_muted(_muted: bool) -> Result<()> {
        bail!("system output mute is only implemented on Windows")
    }
}
