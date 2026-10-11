# EcholIKE Design System

Version: appearance-authority-2026-08-01

EcholIKE is a local-first desktop voice input utility. The product should feel like a fast system tool: quiet, precise, always ready, and honest about which capabilities are wired.

This file follows the design-md practice used by the VoltAgent awesome-design-md references: define tokens, component rules, and explicit do/don't constraints so future agents do not drift the UI back into a rejected showcase skin.

## Product Voice

- Primary job: press a shortcut, speak, get text.
- Secondary job: optionally polish, translate, or ask an LLM through explicit BYOK configuration.
- The UI should look like a working desktop control surface, not a marketing landing page.
- Do not expose login, upgrade, verification, Pro, or subscription surfaces in the client chrome.
- Do not claim screen reading or OCR is available until the backend is actually connected.

## Visual Principles

- Use a restrained surface ladder: app background, sidebar/titlebar, panel, nested field.
- Use 1px hairline borders for structure. Shadows must be minimal and never become decoration.
- Keep cards and panels at 8px radius unless the element is a pill, switch, or capsule.
- Make the yellow lightning mark the brand cue. Do not turn the whole app yellow.
- Accent colors are scarce: primary buttons, selected navigation, focus, and live meters.
- Avoid gradient-orb, bokeh, decorative glass blobs, oversized hero sections, and nested cards.
- Text density should suit a desktop utility. Headings stay compact inside panels.

## Theme Profiles

Theme profile is stored as `theme_profile`. Dark/light/system mode is stored separately as `theme`.

- `echo`: default crisp productivity skin; blue action, yellow brand.
- `pearl`: system-like clean light surface; Apple-inspired restraint.
- `mint`: calm low-noise green for long sessions.
- `graphite`: neutral gray with stronger contrast.
- `ray`: command-palette feel; near-black surfaces, hairline borders, rare yellow.
- `linear`: deep surface ladder with a sparse lavender action color.
- `command`: high-contrast black and white with a restrained amber signal.
- `ember`: charcoal-red material with warm edge feedback.
- `carbon`: technical carbon surfaces with a cool cyan action color.

Echo, Pearl, Mint, and Graphite are adaptive light/dark profiles. Ray, Linear,
Command, Ember, and Carbon are fixed-dark profiles; selecting light mode must
not initialize their editor or native color scheme as a light appearance.

All profiles must resolve these CSS tokens:

- `--echo-app-bg`
- `--echo-shell-bg`
- `--echo-titlebar-bg`
- `--echo-surface`
- `--echo-surface-2`
- `--echo-surface-3`
- `--echo-surface-hover`
- `--echo-input-bg`
- `--echo-text`
- `--echo-muted`
- `--echo-muted-strong`
- `--echo-subtle`
- `--echo-border-strong`
- `--echo-border-soft`
- `--echo-accent`
- `--echo-on-accent`
- `--echo-accent-soft`
- `--echo-accent-warm`
- `--echo-nav-active-bg`
- `--echo-nav-active-text`
- `--echo-nav-idle-bg`
- `--echo-sidebar-text`
- `--echo-sidebar-muted`
- `--echo-sidebar-card-bg`
- `--echo-sidebar-card-border`
- `--echo-sidebar-accent`
- `--echo-panel-accent`
- `--echo-hover-bg`
- `--echo-hover-border`
- `--echo-hover-text`
- `--echo-sidebar-hover-bg`
- `--echo-sidebar-hover-border`
- `--echo-sidebar-hover-text`
- `--echo-ok`
- `--echo-warn`
- `--echo-danger`
- `--echo-shadow-panel`
- `--echo-shadow-float`

## Capsule Styles

Capsule style is stored as `capsule_style`.

- `classic`: default rounded capsule with a clean border and no shadow.
- `compact`: same behavior, visually smaller for distraction-free work.
- `glass`: translucent system feel, still readable and not decorative.
- `ink`: dark high-contrast capsule for screen recording and dark desktops.
- `command`: Raycast-inspired command-palette capsule: near-black surface ladder, 1px hairline, scarce warm accent.
- `signal`: voice-feedback capsule: dark blue-green surface, compact waveform glyph, no exterior glow.
- `pulse`: warm radar-like capsule with a contained scanning pulse; motion stays inside the bubble.
- `orbit`: cool night capsule with two restrained orbital traces for an always-ready motion cue.

The capsule is functional chrome, not an illustration. Idle, recording, processing, polishing, complete, and error states must remain readable in every capsule style.
Every style must preserve its own recording, processing, completion, and error identity instead of falling back to a shared Pulse-like waveform or a shared danger-filled shell. Semantic errors may change the border and message, but must retain the selected skin's material, geometry, glyph, accent, and contained motion. Capsule surfaces use borders, fill, blur, waveform geometry, and contained motion for separation; inset and exterior shadows are both forbidden.
All capsule styles must share the same flush transparent-window contract: the window frame matches the visible capsule body unless the context menu is open, and styles must not use exterior shadows or scaled shells that create opaque-looking borders.
Selection-card previews stay static; the current preview and live capsule may animate. `prefers-reduced-motion` stops waveform, glyph, state, scan, and orbit motion.

## Components

Buttons:

- Height: 36-40px.
- Radius: 8px.
- Primary uses `--echo-accent`.
- Secondary uses `--echo-surface`.
- Disabled state lowers opacity and keeps layout stable.

Panels:

- Use `--echo-surface` and `--echo-border-strong`.
- Nested rows use `--echo-surface-2` and `--echo-border-soft`.
- Do not put page sections inside decorative floating cards.

Settings rows:

- Left icon, center copy, right control.
- Wide controls may span from copy column to the row end.
- Theme choices must be compact swatches, not a large theme marketplace.

Navigation:

- Sidebar is a stable desktop rail.
- Active item uses `--echo-accent`.
- Brand mark uses `--echo-accent-warm`.

## Implementation Rules

- `useTheme` is the single place that atomically writes `document.documentElement.classList.dark`, `data-theme-profile`, and the native `color-scheme`.
- Capsule style is intentionally not a root theme concern. `CapsuleFrame` is the only runtime/preview surface that writes `data-capsule-style`.
- `appearanceProfiles.ts` is the single catalog for nine theme profiles and eight capsule styles. `themes.css` owns all theme-profile tokens and theme picker visuals; `capsules.css` owns the capsule picker, runtime skins, glyphs, and capsule motion. `globals.css` owns only shared component and layout behavior.
- New theme work must add or adjust tokens first, then component CSS.
- Theme selection cards must show the sidebar, titlebar, surface ladder, accent, and material character rather than a flat color swatch. Keep the compact 3/2/1 responsive grid.
- Do not hard-code new colors in components unless it is a one-off semantic asset.
- Do not revive the legacy commented showcase UI in `src/components/Settings/index.tsx`.
- If a capability is not connected end to end, label it as pending or unavailable.
- Desktop release artifacts must be built through `npm run build:desktop`. It pins Cargo output to `src-tauri/target-codex-check` and prints the MSI/EXE paths.
- Do not treat files under the default `src-tauri/target` as canonical build output.

## Rejected Directions

- Heavy decorative showcase/dashboard skins.
- Complex theme stores with many noisy options.
- Fake "AI sees screen" stickers or mock results.
- Login/account/upgrade/pro flows in the desktop client.
- Purple-blue gradient-dominant app surfaces.
- Jelly-heavy controls with exaggerated highlights and inner glow.

## Reference Translation

The 2026-08 appearance authority borrows only the product-density, hairline,
surface-ladder, and restrained-motion principles of the local `linear-app`
design reference. EcholIKE keeps its own nine materials, yellow lightning cue,
Chinese desktop-tool density, capsule identities, and product behavior; no
third-party brand assets, typography, or layout are copied.
