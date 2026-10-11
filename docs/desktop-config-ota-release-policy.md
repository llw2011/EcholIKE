# Desktop Config and OTA Release Policy

This file is a compatibility entry for older plans and links. The authoritative
rules are now maintained in:

- [Project Guidelines](project-guidelines.md), sections 3 and 8;
- [Desktop OTA Release Tool](desktop-ota-release-tool.md);
- [Source Tree and Change Routing](source-tree.md), for current code ownership.

If this summary conflicts with those documents or current source, follow the
project guidelines and source, then update this compatibility entry.

## Remote Configuration Delivery

Desktop configuration is delivered one way from the Server. Provider keys stay
on the Server. The fixed delivery contract remains:

```json
{
  "policy": {
    "remoteConfigDelivery": "startup",
    "activation": "next_start",
    "backgroundPolling": false
  }
}
```

Do not add WebSocket push, background polling, or silent provider/model/key
replacement during an active session. Authentication generation/authority CAS,
package identity, runtime confirmation and fail-closed cache handling are
defined only by the project guidelines and their current implementation; do
not reconstruct them from this summary.

## OTA Release Rule

Distributable Windows updates use the signed Tauri updater chain and the fixed
public artifact prefix:

```text
https://api.example.com/echo-panel/ota/
```

The corresponding nginx directory is
`/srv/echolike/ota/`. Do not publish artifacts under another public
prefix.

The supported workflow is the repository release tool:

```powershell
# Prepare locally; no production write.
npm.cmd run release:desktop:ota -- -Version <x.y.z> -ReleaseNotesFile <utf8-no-bom.local>

# Resume the same bound artifact and perform publish, disabled draft,
# validation, revision-CAS activation, convergence and public verification.
npm.cmd run release:desktop:ota -- -Version <x.y.z> -ReleaseNotesFile <utf8-no-bom.local> -Stage All -Publish -Resume
```

Production writes require explicit `-Publish`. Do not replace this workflow
with manual artifact upload plus hand-created echo-panel records. Every live
release requires declared length, SHA-256, valid Tauri Minisign signatures,
Windows NSIS/PE version validation, a disabled draft, revision-CAS activation
and convergence checks.

## Operational Checks

Before a release is considered live, verify at least:

- `/echo-api/healthz` succeeds;
- an older version receives the expected signed Tauri manifest;
- the current version receives no update;
- the artifact is reachable at the fixed public prefix and matches the bound
  length, SHA-256 and signature;
- `/echo-api/app/update` preserves the intended Chinese release notes;
- `/echo-api/desktop/bootstrap` exposes only permitted OTA availability and
  does not reveal provider credentials or backend download-management details.

The OTA worktree/commit gate, version synchronization, release-note encoding,
production authorization and no-Git-push rules remain in the project guidelines
and red-line card; this file does not relax them.
