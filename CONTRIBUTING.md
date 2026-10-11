# Contributing to EcholIKE

Thanks for helping improve EcholIKE. This guide covers the local development
checks expected before a pull request.

## Contribution License

This independent 0.2.31 source snapshot is distributed under AGPL-3.0-only.
Unless explicitly stated and agreed otherwise, contributions are submitted under
the same project license. Retain the copyright and license notices of any
third-party material and identify its source. This statement does not transfer
copyright or grant a proprietary commercial licensing exception.

## Development Setup

1. Install Node.js 20+, Rust stable, and the Tauri prerequisites for your OS.
2. Run `npm install`.
3. Start the desktop app with `npm run tauri dev`.

For local agent and dev UI workflow rules, read
[`docs/project-guidelines.md`](docs/project-guidelines.md) before changing the
project.

## Making Changes

1. Create a feature branch.
2. Keep changes focused on the requested product surface.
3. Run the relevant checks before committing.
4. Use a Conventional Commit style message, for example `fix: close stale tts state`.

## Pre-Submit Checklist

```powershell
npm test
npm run build
npm test --prefix server
npm run typecheck --prefix server
npm run build --prefix server
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Do not run automatic dependency remediation commands unless the maintainer
explicitly asks for them.

## Code Style

- TypeScript uses strict mode.
- React UI should follow the existing component and store patterns.
- Rust changes should be small, typed, and covered by targeted tests where risk
  warrants it.
- Product-facing text should describe the current EcholIKE surface. Do not add
  account, checkout, subscription, or cloud backup desktop copy unless the full
  desktop flow is implemented.
