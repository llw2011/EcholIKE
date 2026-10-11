use tauri::{PhysicalSize, Runtime, WebviewWindow};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

const MAIN_WINDOW_CORNER_RADIUS_LOGICAL: f64 = 18.0;
const MARKDOWN_EDITOR_CORNER_RADIUS_LOGICAL: f64 = 8.0;

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
struct RoundRectRegionSpec {
    right: i32,
    bottom: i32,
    ellipse_width: i32,
    ellipse_height: i32,
}

fn corner_radius_for_window_label(label: &str) -> Option<f64> {
    match label {
        "main" => Some(MAIN_WINDOW_CORNER_RADIUS_LOGICAL),
        "markdown-editor" => Some(MARKDOWN_EDITOR_CORNER_RADIUS_LOGICAL),
        _ => None,
    }
}

fn round_rect_region_spec(
    width: u32,
    height: u32,
    scale_factor: f64,
    corner_radius_logical: f64,
) -> RoundRectRegionSpec {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let ellipse = (corner_radius_logical * 2.0 * scale_factor)
        .round()
        .clamp(1.0, i32::MAX as f64) as i32;

    RoundRectRegionSpec {
        // GDI excludes the right and bottom coordinates from the region.
        right: width.min((i32::MAX - 1) as u32) as i32 + 1,
        bottom: height.min((i32::MAX - 1) as u32) as i32 + 1,
        ellipse_width: ellipse,
        ellipse_height: ellipse,
    }
}

fn apply_window_rounding<R: Runtime>(
    window: &WebviewWindow<R>,
    size: PhysicalSize<u32>,
    scale_factor: f64,
    window_label: &str,
    corner_radius_logical: f64,
) -> Result<(), String> {
    if size.width == 0 || size.height == 0 {
        return Err(format!(
            "Could not apply the {window_label} window region to a zero-sized window"
        ));
    }

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Could not get the {window_label} window handle: {error}"))?;
    let spec = round_rect_region_spec(size.width, size.height, scale_factor, corner_radius_logical);

    // SAFETY: the HWND belongs to this live Tauri window. The region is transferred to Windows
    // after a successful SetWindowRgn call; on failure it remains ours and is deleted below.
    unsafe {
        let region = CreateRoundRectRgn(
            0,
            0,
            spec.right,
            spec.bottom,
            spec.ellipse_width,
            spec.ellipse_height,
        );
        if region.is_null() {
            return Err(format!(
                "Could not create the {window_label} window region: {}",
                std::io::Error::last_os_error()
            ));
        }

        if SetWindowRgn(hwnd.0 as _, region, 1) == 0 {
            let error = std::io::Error::last_os_error();
            let _ = DeleteObject(region);
            return Err(format!(
                "Could not apply the {window_label} window region: {error}"
            ));
        }
    }

    Ok(())
}

fn clear_window_region(hwnd: HWND) -> Result<(), String> {
    // SAFETY: a null HRGN removes the live HWND's custom region and restores its full rectangle.
    if unsafe { SetWindowRgn(hwnd, std::ptr::null_mut(), 1) } == 0 {
        return Err(format!(
            "Could not clear the stale window region: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(())
}

fn clear_window_rounding<R: Runtime>(
    window: &WebviewWindow<R>,
    window_label: &str,
) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Could not get the {window_label} window handle: {error}"))?;
    clear_window_region(hwnd.0 as _)
}

fn sync_window_rounding<R: Runtime>(
    window: &WebviewWindow<R>,
    expected_label: &str,
) -> Result<(), String> {
    let corner_radius_logical = corner_radius_for_window_label(expected_label)
        .ok_or_else(|| format!("Window {expected_label:?} has no configured native shape"))?;

    if window.label() != expected_label {
        return Err(format!(
            "Cannot synchronize the {expected_label} window shape from window {:?}",
            window.label(),
        ));
    }

    let result = (|| {
        let size = window
            .inner_size()
            .map_err(|error| format!("Could not read the {expected_label} inner size: {error}"))?;
        let scale_factor = window.scale_factor().map_err(|error| {
            format!("Could not read the {expected_label} scale factor: {error}")
        })?;

        apply_window_rounding(
            window,
            size,
            scale_factor,
            expected_label,
            corner_radius_logical,
        )
    })();

    if let Err(sync_error) = result {
        return match clear_window_rounding(window, expected_label) {
            Ok(()) => Err(format!(
                "{sync_error}; cleared the stale {expected_label} window region as a fail-open fallback"
            )),
            Err(clear_error) => Err(format!("{sync_error}; {clear_error}")),
        };
    }

    Ok(())
}

pub fn sync_main_window_rounding<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    sync_window_rounding(window, "main")
}

pub fn sync_markdown_editor_rounding<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    sync_window_rounding(window, "markdown-editor")
}

#[cfg(test)]
mod tests {
    use super::{
        clear_window_region, corner_radius_for_window_label, round_rect_region_spec,
        MAIN_WINDOW_CORNER_RADIUS_LOGICAL, MARKDOWN_EDITOR_CORNER_RADIUS_LOGICAL,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        CreateRectRgn, CreateRoundRectRgn, DeleteObject, GetWindowRgn, PtInRegion, SetWindowRgn,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow};

    #[test]
    fn main_window_rounding_tracks_physical_size_and_dpi() {
        let standard = round_rect_region_spec(520, 340, 1.0, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);
        assert_eq!(standard.right, 521);
        assert_eq!(standard.bottom, 341);
        assert_eq!(standard.ellipse_width, 36);
        assert_eq!(standard.ellipse_height, 36);

        let laptop = round_rect_region_spec(650, 425, 1.25, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);
        assert_eq!(laptop.right, 651);
        assert_eq!(laptop.bottom, 426);
        assert_eq!(laptop.ellipse_width, 45);
        assert_eq!(laptop.ellipse_height, 45);

        let high_dpi = round_rect_region_spec(780, 510, 1.5, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);
        assert_eq!(high_dpi.ellipse_width, 54);
        assert_eq!(high_dpi.ellipse_height, 54);

        let doubled = round_rect_region_spec(1040, 680, 2.0, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);
        assert_eq!(doubled.ellipse_width, 72);
        assert_eq!(doubled.ellipse_height, 72);
    }

    #[test]
    fn main_window_rounding_falls_back_to_standard_dpi_for_invalid_scale_factors() {
        for scale_factor in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let spec =
                round_rect_region_spec(520, 340, scale_factor, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);
            assert_eq!(
                spec.ellipse_width,
                (MAIN_WINDOW_CORNER_RADIUS_LOGICAL * 2.0) as i32
            );
            assert_eq!(spec.ellipse_height, spec.ellipse_width);
        }
    }

    #[test]
    fn markdown_editor_rounding_tracks_supported_dpi_scales() {
        for (scale_factor, expected_ellipse) in [(1.0, 16), (1.25, 20), (1.5, 24), (2.0, 32)] {
            let spec = round_rect_region_spec(
                1120,
                780,
                scale_factor,
                MARKDOWN_EDITOR_CORNER_RADIUS_LOGICAL,
            );
            assert_eq!(spec.right, 1121);
            assert_eq!(spec.bottom, 781);
            assert_eq!(spec.ellipse_width, expected_ellipse);
            assert_eq!(spec.ellipse_height, expected_ellipse);
        }
    }

    #[test]
    fn native_shape_radius_is_label_scoped() {
        assert_eq!(corner_radius_for_window_label("main"), Some(18.0));
        assert_eq!(corner_radius_for_window_label("markdown-editor"), Some(8.0));
        assert_eq!(corner_radius_for_window_label("capsule"), None);
    }

    #[test]
    fn native_round_rect_excludes_only_the_window_corners() {
        let spec = round_rect_region_spec(520, 340, 1.0, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);

        // SAFETY: the test owns this standalone GDI region and always deletes it.
        unsafe {
            let region = CreateRoundRectRgn(
                0,
                0,
                spec.right,
                spec.bottom,
                spec.ellipse_width,
                spec.ellipse_height,
            );
            assert!(!region.is_null());
            assert_eq!(PtInRegion(region, 0, 0), 0);
            assert_ne!(PtInRegion(region, 260, 0), 0);
            assert_ne!(PtInRegion(region, 260, 170), 0);
            assert_ne!(DeleteObject(region), 0);
        }
    }

    #[test]
    fn native_round_rect_boundary_contract_preserves_the_last_window_pixels() {
        let spec = round_rect_region_spec(520, 340, 1.0, MAIN_WINDOW_CORNER_RADIUS_LOGICAL);

        // CreateRoundRectRgn rasterizes the right and bottom bounds so an exact width/height
        // spec drops the final real column and row. The +1 contract includes those pixels while
        // still excluding coordinates outside the window.
        unsafe {
            let expanded = CreateRoundRectRgn(
                0,
                0,
                spec.right,
                spec.bottom,
                spec.ellipse_width,
                spec.ellipse_height,
            );
            let exact = CreateRoundRectRgn(0, 0, 520, 340, spec.ellipse_width, spec.ellipse_height);
            assert!(!expanded.is_null());
            assert!(!exact.is_null());

            for (x, y) in [(260, 339), (519, 170)] {
                assert_ne!(PtInRegion(expanded, x, y), 0);
                assert_eq!(PtInRegion(exact, x, y), 0);
            }
            assert_eq!(PtInRegion(expanded, 260, 340), 0);
            assert_eq!(PtInRegion(expanded, 520, 170), 0);

            assert_ne!(DeleteObject(expanded), 0);
            assert_ne!(DeleteObject(exact), 0);
        }
    }

    #[test]
    fn markdown_native_round_rect_keeps_full_edge_centers_without_corner_pixels() {
        let spec = round_rect_region_spec(1120, 780, 1.0, MARKDOWN_EDITOR_CORNER_RADIUS_LOGICAL);

        // SAFETY: the test owns this standalone GDI region and always deletes it.
        unsafe {
            let region = CreateRoundRectRgn(
                0,
                0,
                spec.right,
                spec.bottom,
                spec.ellipse_width,
                spec.ellipse_height,
            );
            assert!(!region.is_null());
            assert_eq!(PtInRegion(region, 0, 0), 0);
            assert_ne!(PtInRegion(region, 560, 0), 0);
            assert_ne!(PtInRegion(region, 0, 390), 0);
            assert_ne!(PtInRegion(region, 560, 390), 0);
            assert_ne!(DeleteObject(region), 0);
        }
    }

    #[test]
    fn replacing_a_small_region_exposes_the_current_resized_window() {
        let class_name = "STATIC\0".encode_utf16().collect::<Vec<_>>();
        let window_name = "EcholIKE resize region test\0"
            .encode_utf16()
            .collect::<Vec<_>>();

        // SAFETY: the test owns this hidden system-class window and the standalone probe object.
        // Successful SetWindowRgn calls transfer both source regions to Windows.
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                window_name.as_ptr(),
                0,
                0,
                0,
                1120,
                780,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());

            let stale_region = CreateRoundRectRgn(0, 0, 721, 521, 16, 16);
            assert!(!stale_region.is_null());
            assert_ne!(SetWindowRgn(hwnd, stale_region, 0), 0);

            let current_region = CreateRoundRectRgn(0, 0, 1121, 781, 16, 16);
            assert!(!current_region.is_null());
            assert_ne!(SetWindowRgn(hwnd, current_region, 0), 0);

            let probe = CreateRectRgn(0, 0, 1, 1);
            assert!(!probe.is_null());
            assert_ne!(GetWindowRgn(hwnd, probe), 0);
            assert_eq!(PtInRegion(probe, 0, 0), 0);
            assert_ne!(PtInRegion(probe, 1000, 700), 0);

            assert_ne!(DeleteObject(probe), 0);
            assert_ne!(DestroyWindow(hwnd), 0);
        }
    }

    #[test]
    fn fail_open_clears_a_stale_native_window_region() {
        let class_name = "STATIC\0".encode_utf16().collect::<Vec<_>>();
        let window_name = "EcholIKE region test\0".encode_utf16().collect::<Vec<_>>();

        // SAFETY: the test owns this hidden system-class window and both standalone probe objects.
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                window_name.as_ptr(),
                0,
                0,
                0,
                520,
                340,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());

            let stale_region = CreateRoundRectRgn(0, 0, 521, 341, 36, 36);
            assert!(!stale_region.is_null());
            assert_ne!(SetWindowRgn(hwnd, stale_region, 0), 0);

            let probe = CreateRectRgn(0, 0, 1, 1);
            assert!(!probe.is_null());
            assert_ne!(GetWindowRgn(hwnd, probe), 0);

            assert!(clear_window_region(hwnd).is_ok());
            assert_eq!(GetWindowRgn(hwnd, probe), 0);

            assert_ne!(DeleteObject(probe), 0);
            assert_ne!(DestroyWindow(hwnd), 0);
        }
    }
}
