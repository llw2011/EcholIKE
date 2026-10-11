export function style(nonce: string): string {
  return `<style nonce="${nonce}">
    :root {
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0f1117;
      color: #e4e4e7;
      --bg: #0f1117;
      --surface: #181b24;
      --surface2: #1e2230;
      --border: #2a2f3d;
      --ink: #e4e4e7;
      --muted: #8b8fa3;
      --faint: #83899e;
      --green: #3ecf8e;
      --green-bg: rgba(62,207,142,0.12);
      --red: #f87171;
      --red-bg: rgba(248,113,113,0.12);
      --yellow: #fbbf24;
      --radius: 10px;
      --radius-sm: 6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scrollbar-width: thin; scrollbar-color: var(--faint) var(--bg); }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-button { width: 0; height: 0; display: none; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { border: 2px solid var(--bg); border-radius: 999px; background: var(--faint); }
    ::-webkit-scrollbar-thumb:hover { background: var(--green); }
    ::-webkit-scrollbar-corner { background: var(--bg); }
    body { min-height: 100vh; background: var(--bg); color: var(--ink); font-size: 14px; line-height: 1.5; }
    input[type="checkbox"] { accent-color: var(--green); }
    a { color: var(--green); text-decoration: none; }
    code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }

    /* ===== Shell layout ===== */
    .shell { width: min(1240px, 100%); margin: 0 auto; padding: 20px 24px 64px; display: grid; gap: 16px; }

    /* ===== Topbar ===== */
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border); }
    .brand-row { display: flex; align-items: center; gap: 12px; }
    .brand-mark { width: 32px; height: 32px; border-radius: 8px; background: var(--green); flex-shrink: 0; }
    .eyebrow { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .status-bar { font-size: 14px; color: var(--muted); margin-top: 2px; }
    .status-bar strong { color: var(--green); }
    .topbar-actions { display: flex; gap: 8px; }
    .btn-icon { width: 36px; height: 36px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted); font-size: 16px; cursor: pointer; display: grid; place-items: center; transition: all 120ms; }
    .btn-icon:hover { background: var(--surface2); color: var(--ink); border-color: var(--faint); }

    /* ===== Checkup ===== */
    .health-section { display: grid; gap: 12px; }
    .btn-primary { border: 0; border-radius: var(--radius); background: var(--green); color: #0f1117; font-weight: 700; font-size: 15px; padding: 14px 20px; cursor: pointer; transition: all 150ms; }
    .btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); }
    .btn-primary:disabled { opacity: 0.5; cursor: wait; transform: none; }
    .btn-large { font-size: 16px; padding: 16px; }
    .checkup-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
    .checkup-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 8px; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--border); transition: all 200ms; }
    .checkup-card.running { border-color: var(--yellow); }
    .checkup-card.pass { border-color: var(--green); background: var(--green-bg); }
    .checkup-card.fail { border-color: var(--red); background: var(--red-bg); }
    .cu-icon { font-size: 20px; }
    .cu-label { font-size: 12px; color: var(--muted); }
    .cu-status { max-width: 100%; color: var(--muted); font-size: 12px; text-align: center; overflow-wrap: anywhere; }
    .checkup-card.pass .cu-status { color: var(--green); }
    .checkup-card.fail .cu-status { color: var(--red); }

    /* ===== Action cards ===== */
    .actions-section { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
    .action-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 16px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); color: var(--ink); cursor: pointer; transition: all 150ms; text-align: left; }
    .action-card:hover { background: var(--surface2); border-color: var(--green); transform: translateY(-2px); }
    .action-icon { font-size: 24px; }
    .action-label { font-weight: 600; font-size: 14px; }
    .action-hint { font-size: 12px; color: var(--faint); }

    /* ===== Collapsible blocks ===== */
    .data-block { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
    .data-block > summary { padding: 14px 16px; cursor: pointer; font-weight: 600; font-size: 14px; user-select: none; list-style: none; display: flex; align-items: center; gap: 8px; }
    .data-block > summary::-webkit-details-marker { display: none; }
    .data-block > summary::before { content: '▸'; color: var(--faint); transition: transform 150ms; font-size: 12px; }
    .data-block[open] > summary::before { transform: rotate(90deg); }
    .data-block[open] > summary { border-bottom: 1px solid var(--border); }
    .block-body { padding: 16px; display: grid; gap: 12px; }
    .hint { font-size: 12px; color: var(--muted); }
    .subhead { font-size: 13px; font-weight: 600; color: var(--muted); margin-top: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }

    /* ===== Metrics ===== */
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; padding: 16px; }
    .metric { padding: 12px; border-radius: var(--radius-sm); background: var(--surface2); }
    .metric span { font-size: 11px; color: var(--faint); display: block; }
    .metric strong { font-size: 22px; font-weight: 700; color: var(--green); }

    /* ===== Forms ===== */
    .compact-form { display: grid; gap: 10px; }
    .ota-form { grid-template-columns: minmax(130px, 0.5fr) minmax(0, 1.5fr); gap: 10px 12px; align-items: end; }
    .ota-form-wide, .ota-form-actions { grid-column: 1 / -1; }
    .ota-form-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .ota-form-actions .form-row { display: flex; align-items: center; gap: 16px; }
    .ota-form-actions button[type="submit"] { min-width: 160px; padding-inline: 20px; }
    .autofill-trap { position: fixed; left: -100vw; top: -100vh; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; }
    .compact-form label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
    .compact-form input, .compact-form select, .compact-form textarea {
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink);
      padding: 8px 10px; font-size: 13px; font-family: inherit; width: 100%;
    }
    .field-with-action { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .field-with-action button {
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface2); color: var(--ink);
      padding: 8px 12px; font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer;
    }
    .field-with-action button:hover:not(:disabled) { border-color: var(--green); color: var(--green); }
    .field-with-action button:disabled { opacity: 0.55; cursor: wait; }
    .compact-form input:focus, .compact-form select:focus, .compact-form textarea:focus { outline: none; border-color: var(--green); }
    .compact-form textarea { resize: vertical; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .cb { flex-direction: row !important; align-items: center; gap: 8px !important; display: flex !important; }
    .cb input { width: auto !important; }
    .quota-level-preview {
      min-height: 35px; display: flex; align-items: center; border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); padding: 8px 10px;
      font-size: 13px; font-weight: 600;
    }
    .compact-form button[type="submit"] {
      border: 0; border-radius: var(--radius-sm); background: var(--green); color: #0f1117;
      font-weight: 700; padding: 10px; cursor: pointer; font-size: 14px; transition: all 120ms;
    }
    .compact-form button[type="submit"]:hover { filter: brightness(1.1); }
    .compact-form button[type="submit"]:disabled { opacity: 0.4; cursor: not-allowed; }
    .result-line { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); min-height: 20px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; }
    .account-actions-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: stretch; }
    .user-operation-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: stretch; }
    .operation-card { min-width: 0; height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface2); }
    .operation-card .subhead { margin-top: 0; color: var(--ink); }
    .operation-card > .compact-form { flex: 1; display: flex; flex-direction: column; }
    .operation-card > .compact-form > button[type="submit"] { margin-top: auto; }
    .operation-card .result-line { margin-top: auto; }
    .user-list-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: end; }
    .user-search-field { min-width: 0; display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    .user-search-field input {
      width: 100%; min-width: 0; min-height: 38px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg); color: var(--ink); padding: 8px 10px; font: inherit;
    }
    .user-search-field input:focus { outline: none; border-color: var(--green); }
    .user-list-toolbar .btn-secondary { min-height: 38px; }
    .user-list-summary { min-height: 20px; color: var(--muted); font-size: 12px; }
    .user-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .user-pagination span, .ota-pagination span { min-width: 72px; color: var(--muted); font-size: 12px; text-align: center; }
    .user-pagination .btn-secondary:disabled, .ota-pagination .btn-secondary:disabled, .btn-secondary:disabled { opacity: 0.45; cursor: not-allowed; border-color: var(--border); color: var(--muted); }
    .selected-user-card {
      min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px;
      border: 1px solid var(--green); border-radius: var(--radius-sm); background: var(--green-bg);
    }
    .selected-user-copy { min-width: 0; display: grid; gap: 2px; }
    .selected-user-copy span { color: var(--green); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .selected-user-copy strong, .selected-user-copy small { overflow-wrap: anywhere; word-break: break-word; }
    .selected-user-copy strong { font-size: 14px; }
    .selected-user-copy small { color: var(--muted); font-size: 11px; }
    .user-cards { display: none; }
    .scene-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .scene-editor-head strong { font-size: 13px; font-weight: 600; color: var(--ink); }
    .btn-secondary { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface2); color: var(--ink); padding: 7px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn-secondary:hover { border-color: var(--green); color: var(--green); }

    /* ===== Status cards (provider) ===== */
    .status-cards { display: grid; gap: 8px; }
    .sc-card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg); border: 1px solid var(--border); }
    .sc-card.ok { border-color: var(--green); }
    .sc-card.off { border-color: var(--red); }
    .sc-label { font-weight: 600; font-size: 13px; min-width: 100px; }
    .sc-detail { font-size: 12px; color: var(--muted); }

    /* ===== Tables ===== */
    .table-wrap { max-width: 100%; overflow-x: auto; border-radius: var(--radius-sm); border: 1px solid var(--border); }
    .user-table-wrap { overflow-x: auto; }
    .user-table-wrap table { min-width: 0; table-layout: fixed; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 8px 10px; background: var(--surface2); color: var(--faint); font-weight: 600; }
    td { padding: 8px 10px; border-top: 1px solid var(--border); vertical-align: top; }
    td strong { font-weight: 600; }
    td small { display: block; font-size: 10px; color: var(--faint); }
    .scene-row { cursor: pointer; outline: none; }
    .scene-row td { transition: background 120ms, box-shadow 120ms; }
    .scene-row:hover td, .scene-row:focus-visible td { background: var(--surface2); }
    .scene-row:focus-visible td:first-child { box-shadow: inset 3px 0 var(--green); }
    .scene-row.selected td { background: var(--green-bg); }
    .scene-row.selected td:first-child { box-shadow: inset 3px 0 var(--green); }
    .user-row { cursor: pointer; outline: none; }
    .user-row td { transition: background 120ms, box-shadow 120ms; }
    .user-row:hover td, .user-row:focus-visible td { background: var(--surface2); }
    .user-row:focus-visible td:first-child, .user-row.selected td:first-child { box-shadow: inset 3px 0 var(--green); }
    .user-row.selected td { background: var(--green-bg); }
    .user-row td:first-child { max-width: 250px; overflow-wrap: anywhere; word-break: break-word; }
    .empty-state { padding: 20px; color: var(--muted); text-align: center; }
    .level-badge { display: inline-flex; align-items: center; border: 1px solid var(--green); border-radius: var(--radius-sm); color: var(--green); background: var(--green-bg); padding: 2px 6px; font-weight: 700; white-space: nowrap; }
    .quota-number { white-space: nowrap; }
    .ota-history { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); overflow: hidden; }
    .ota-history > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; cursor: pointer; list-style: none; color: var(--ink); font-size: 13px; font-weight: 600; }
    .ota-history > summary::-webkit-details-marker { display: none; }
    .ota-history > summary::before { content: '▸'; color: var(--faint); font-size: 11px; transition: transform 150ms; }
    .ota-history[open] > summary::before { transform: rotate(90deg); }
    .ota-history > summary small { margin-left: auto; color: var(--faint); font-size: 11px; font-weight: 500; }
    .ota-history[open] > summary { border-bottom: 1px solid var(--border); }
    .ota-history-body { display: grid; gap: 8px; padding: 10px; }
    .ota-pagination { display: grid; grid-template-columns: auto minmax(72px, 1fr) auto; align-items: center; gap: 8px; }
    #ota-result:empty { display: none; }
    .ota-version-cell { display: flex; align-items: center; gap: 8px; min-width: 120px; }
    .row-toggle { width: 24px; height: 24px; flex: 0 0 24px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface2); color: var(--ink); font-weight: 700; line-height: 1; cursor: pointer; }
    .row-toggle:hover { border-color: var(--green); color: var(--green); }
    .ota-row.open td { background: rgba(62,207,142,0.04); }
    .ota-detail-row[hidden] { display: none; }
    .ota-detail-row td { padding: 0; background: var(--bg); }
    .ota-detail-panel { display: grid; gap: 10px; padding: 12px 14px 14px 42px; border-top: 1px solid var(--border); }
    .ota-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
    .ota-detail-item, .ota-detail-notes { display: grid; gap: 4px; min-width: 0; }
    .ota-detail-item.wide { grid-column: 1 / -1; }
    .ota-detail-item span, .ota-detail-notes span { color: var(--faint); font-size: 11px; font-weight: 600; }
    .ota-detail-item code, .ota-detail-notes p { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }

    .system-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .sys-card { padding: 12px; border-radius: var(--radius-sm); background: var(--bg); }
    .sys-card h4 { font-size: 12px; color: var(--faint); margin-bottom: 8px; }
    .kv div { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
    .kv div:last-child { border: 0; }
    .kv span { color: var(--faint); }
    .kv strong { font-weight: 600; }

    /* ===== Workspace navigation and resource states ===== */
    .sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
    [hidden] { display: none !important; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
    .module-nav { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow-x: auto; scrollbar-width: none; }
    .module-nav::-webkit-scrollbar { display: none; }
    .module-tab { min-height: 38px; flex: 1 0 auto; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); padding: 8px 14px; font: inherit; font-weight: 650; cursor: pointer; }
    .module-tab:hover { color: var(--ink); background: var(--surface2); }
    .module-tab.is-active { color: #07140f; background: var(--green); }
    .global-status:empty { display: none; }
    .global-status { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted); }
    .workspace { min-width: 0; display: grid; gap: 14px; }
    .workspace-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding: 4px 2px; }
    .workspace-head h1 { margin-top: 2px; font-size: clamp(22px, 3vw, 30px); line-height: 1.15; }
    .workspace-head p:not(.eyebrow) { max-width: 720px; margin-top: 5px; color: var(--muted); }
    .workspace-content, .block-body { min-width: 0; display: grid; gap: 14px; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
    .resource-banner { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--muted); background: var(--surface); }
    .resource-banner.loading { border-color: rgba(251,191,36,.55); color: var(--yellow); }
    .resource-banner.error { border-color: rgba(248,113,113,.7); color: var(--red); background: var(--red-bg); }
    .resource-banner.stale { border-color: rgba(251,191,36,.7); color: var(--yellow); }
    .diagnostic-panel { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
    .diagnostic-panel h2 { font-size: 16px; }

    /* ===== Master-detail workspaces ===== */
    .master-detail { min-width: 0; display: grid; grid-template-columns: minmax(390px, .92fr) minmax(480px, 1.08fr); gap: 14px; align-items: start; }
    .master-pane, .detail-pane { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
    .master-pane { display: grid; gap: 12px; padding: 14px; }
    .detail-pane { overflow: hidden; }
    .detail-head { min-height: 64px; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface2); }
    .detail-head h2 { font-size: 16px; overflow-wrap: anywhere; }
    .detail-kicker { display: block; color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .detail-back { display: none; width: 38px; height: 38px; flex: 0 0 38px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); cursor: pointer; }
    .detail-scroll { min-width: 0; display: grid; gap: 12px; padding: 16px; }
    .master-actions { display: flex; gap: 8px; }
    .master-actions > * { flex: 1; }
    .provider-master-card, .scene-card { width: 100%; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); text-align: left; font: inherit; cursor: pointer; }
    .provider-master-card > span:first-child, .scene-card > span:first-child { min-width: 0; display: grid; gap: 2px; }
    .provider-master-card small, .scene-card small { color: var(--muted); overflow-wrap: anywhere; }
    .provider-master-card:hover, .provider-master-card.selected, .scene-card:hover, .scene-card.selected { border-color: var(--green); background: var(--green-bg); }
    .scene-cards { display: none; gap: 8px; }
    .row-select { width: 100%; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
    .quota-summary { display: grid; gap: 2px; margin-top: 5px; }
    .task-nav { display: flex; flex-wrap: wrap; gap: 6px; }
    .task-nav button { min-height: 36px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--muted); padding: 7px 10px; cursor: pointer; }
    .task-nav button:hover, .task-nav button.is-active { border-color: var(--green); color: var(--green); background: var(--green-bg); }
    .task-actions { display: flex; justify-content: flex-end; margin-top: auto; padding-top: 6px; }
    .task-actions button { min-width: 160px; }
    .capability-fields { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
    .capability-fields legend { padding: 0 6px; color: var(--muted); font-size: 12px; }
    #provider-capability-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .capability-item { min-width: 0; display: grid; gap: 3px; padding: 9px 10px; border-radius: var(--radius-sm); background: var(--bg); }
    .capability-item dt { color: var(--faint); font-size: 10px; font-weight: 700; }
    .capability-item dd { color: var(--ink); font-size: 12px; overflow-wrap: anywhere; }
    .account-workspace { width: min(720px, 100%); }

    /* ===== Operational insight views ===== */
    .filter-bar { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)) auto; gap: 10px; align-items: end; }
    .filter-bar label { min-width: 0; display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    .filter-bar input, .filter-bar select { width: 100%; min-width: 0; min-height: 38px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); padding: 8px 10px; font: inherit; }
    .filter-bar button { min-height: 38px; }
    .usage-account-field { position: relative; min-width: 0; display: grid; gap: 4px; }
    .filter-label { color: var(--muted); font-size: 12px; }
    .usage-account-trigger {
      width: 100%; min-width: 0; min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); padding: 6px 10px; font: inherit; text-align: left; cursor: pointer;
    }
    .usage-account-trigger > span:first-child { min-width: 0; display: grid; gap: 1px; }
    .usage-account-trigger strong, .usage-account-trigger small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .usage-account-trigger strong { font-size: 13px; }
    .usage-account-trigger small { color: var(--faint); font-size: 10px; }
    .usage-account-trigger:hover, .usage-account-trigger[aria-expanded="true"] { border-color: var(--green); }
    .usage-account-menu {
      position: absolute; z-index: 30; top: calc(100% + 6px); right: 0; width: min(440px, calc(100vw - 40px));
      display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); box-shadow: 0 18px 48px rgba(0,0,0,.42);
    }
    .usage-account-search { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .usage-account-resource { min-height: 18px; color: var(--faint); font-size: 11px; overflow-wrap: anywhere; }
    .usage-account-options { max-height: 280px; display: grid; gap: 6px; overflow-y: auto; overscroll-behavior: contain; }
    .usage-account-option {
      width: 100%; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); text-align: left; font: inherit; cursor: pointer;
    }
    .usage-account-option > span:first-child { min-width: 0; display: grid; gap: 2px; }
    .usage-account-option strong, .usage-account-option small { overflow-wrap: anywhere; word-break: break-word; }
    .usage-account-option strong { font-size: 12px; }
    .usage-account-option small { color: var(--faint); font-size: 10px; }
    .usage-account-option:hover, .usage-account-option.selected { border-color: var(--green); background: var(--green-bg); }
    .usage-metric-section { min-width: 0; display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); }
    .usage-metric-head { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .usage-metric-head h2 { font-size: 14px; }
    .usage-metric-head p, .usage-metric-head small { color: var(--faint); font-size: 11px; overflow-wrap: anywhere; }
    .usage-metric-head > small { max-width: 440px; text-align: right; }
    .compact-metrics { padding: 0; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
    .insight-table-wrap { overflow-x: auto; }
    .insight-table-wrap table { min-width: 760px; }
    .insight-cards { display: none; gap: 8px; }
    .insight-card, .session-card { min-width: 0; display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); }
    .insight-card header, .session-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .insight-card dl, .session-card dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
    .insight-card dl div, .session-card dl div { min-width: 0; }
    .insight-card dt, .session-card dt { color: var(--faint); font-size: 10px; }
    .insight-card dd, .session-card dd { overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }
    .cursor-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .cursor-pagination span { min-width: 72px; color: var(--muted); text-align: center; font-size: 12px; }
    .session-panel { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); }
    .session-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .session-panel h3 { font-size: 14px; }
    .session-list { display: grid; gap: 8px; }
    .status-pill { flex: 0 0 auto; display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--muted); font-size: 10px; font-weight: 700; }
    .status-pill.ok { border-color: var(--green); color: var(--green); background: var(--green-bg); }
    .status-pill.off { border-color: var(--red); color: var(--red); background: var(--red-bg); }
    .status-pill.warn { border-color: var(--yellow); color: var(--yellow); }

    /* ===== Confirmation and modal ownership ===== */
    body.panel-open { overflow: hidden; }
    .confirm-panel { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgba(4, 6, 10, .78); }
    .confirm-card { width: min(480px, 100%); display: grid; gap: 14px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: 0 20px 60px rgba(0,0,0,.45); }
    .confirm-card h2 { font-size: 19px; }
    .confirm-card > p:not(.eyebrow) { color: var(--muted); overflow-wrap: anywhere; }
    .confirm-card label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    .confirm-card input { min-height: 42px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); padding: 9px 10px; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .confirm-actions button { min-height: 40px; min-width: 110px; }
    .btn-danger { border: 1px solid var(--red); border-radius: var(--radius-sm); background: var(--red); color: #160707; padding: 8px 12px; font-weight: 750; cursor: pointer; }
    .btn-danger:disabled { opacity: .4; cursor: not-allowed; }
    .submit-group { display: flex; gap: 8px; justify-content: flex-end; }
    .ota-form-actions .submit-group button { min-width: 150px; }
    .ota-form-actions .submit-group .btn-secondary { border: 1px solid var(--border); background: var(--surface2); color: var(--ink); }
    .ota-detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .ota-detail-actions button { min-height: 38px; }

    .login-shell { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .login-panel { width: min(380px, 100%); display: grid; gap: 20px; padding: 28px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); }
    .login-panel h1 { font-size: 20px; font-weight: 700; }
    .stack { display: grid; gap: 12px; }
    .login-panel label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
    .login-panel input { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); padding: 10px; font-size: 14px; }
    .login-panel input:focus { outline: none; border-color: var(--green); }
    .login-panel button { border: 0; border-radius: var(--radius-sm); background: var(--green); color: #0f1117; font-weight: 700; padding: 12px; cursor: pointer; font-size: 14px; }
    .login-panel button:hover { filter: brightness(1.1); }
    .message { font-size: 12px; color: var(--muted); min-height: 18px; }

    @media (max-width: 1040px) {
      .shell { padding-inline: 16px; }
      .master-detail { grid-template-columns: minmax(300px, .82fr) minmax(0, 1.18fr); }
      .filter-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filter-bar button { min-height: 38px; }
      #provider-capability-fields { grid-template-columns: 1fr; }
    }

    @media (max-width: 760px) {
      body { overflow-x: hidden; }
      .shell { width: 100%; min-width: 0; padding: 12px 10px 40px; }
      .data-block, .block-body { min-width: 0; }
      .block-body { padding: 12px; }
      .actions-section { grid-template-columns: 1fr 1fr; }
      .system-grid { grid-template-columns: 1fr; }
      .form-row { grid-template-columns: 1fr; }
      .ota-form { grid-template-columns: 1fr; }
      .ota-form-actions { align-items: stretch; flex-direction: column; }
      .ota-form-actions .form-row { width: 100%; flex-wrap: wrap; }
      .account-actions-grid, .user-operation-grid { grid-template-columns: 1fr; align-items: start; }
      .operation-card { height: auto; padding: 11px; }
      .user-list-toolbar { grid-template-columns: 1fr; }
      .user-list-toolbar .btn-secondary, .user-pagination .btn-secondary, .selected-user-card .btn-secondary, .compact-form button[type="submit"] { min-height: 44px; width: 100%; }
      .user-table-wrap { display: none; }
      .user-cards { display: grid; gap: 8px; min-width: 0; }
      .user-card {
        width: 100%; min-width: 0; display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border);
        border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); text-align: left; font: inherit; cursor: pointer;
      }
      .user-card:focus-visible { outline: 2px solid var(--green); outline-offset: 1px; }
      .user-card.selected { border-color: var(--green); background: var(--green-bg); }
      .user-card-head { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .user-card-head > span:first-child { min-width: 0; display: grid; gap: 2px; }
      .user-card-head strong, .user-card-id { overflow-wrap: anywhere; word-break: break-word; }
      .user-card-head strong { font-size: 13px; }
      .user-card small { color: var(--faint); font-size: 10px; }
      .user-card-meta, .user-card-quotas { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
      .user-card-meta span, .user-card-quotas span { min-width: 0; color: var(--muted); font-size: 11px; }
      .user-card-meta strong, .user-card-quotas strong { display: block; color: var(--ink); font-size: 11px; overflow-wrap: anywhere; }
      .user-pagination { display: grid; grid-template-columns: 1fr; justify-items: stretch; }
      .user-pagination span { order: -1; min-width: 0; }
      .selected-user-card { display: grid; grid-template-columns: 1fr; }
      .ota-detail-panel { padding-left: 12px; }
      .ota-detail-grid { grid-template-columns: 1fr; }
      .topbar { align-items: flex-start; }
      .topbar-actions { flex: 0 0 auto; }
      .module-nav { margin-inline: -2px; }
      .module-tab { min-height: 44px; padding-inline: 15px; }
      button { min-height: 44px; }
      input:not([type="hidden"]):not([type="checkbox"]), select { min-height: 44px; }
      .cb { min-height: 44px; align-items: center; }
      .btn-icon, .row-toggle, .detail-back { min-width: 44px; min-height: 44px; }
      .workspace-head { align-items: stretch; flex-direction: column; gap: 10px; }
      .workspace-head > button { min-height: 44px; width: 100%; }
      .workspace-content, .block-body { padding: 12px; }
      .master-detail { display: block; }
      .master-pane { padding: 11px; }
      .detail-pane { display: none; }
      .detail-pane.is-open { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; border: 0; border-radius: 0; background: var(--surface); }
      .detail-head { flex: 0 0 auto; padding: calc(10px + env(safe-area-inset-top)) 12px 10px; }
      .detail-back { display: grid; place-items: center; min-width: 44px; min-height: 44px; }
      .detail-scroll { flex: 1 1 auto; min-height: 0; display: grid; align-content: start; gap: 12px; overflow-y: auto; overscroll-behavior: contain; padding: 12px 12px calc(16px + env(safe-area-inset-bottom)); }
      .task-actions { position: sticky; bottom: calc(-12px - env(safe-area-inset-bottom)); z-index: 2; margin-inline: -12px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border); background: var(--surface); }
      .task-actions button { width: 100%; min-height: 44px; }
      .provider-master-card, .scene-card, .task-nav button, .btn-secondary, .field-with-action button { min-height: 44px; }
      .scene-table-wrap { display: none; }
      .scene-cards { display: grid; }
      #provider-capability-fields { grid-template-columns: 1fr; }
      .filter-bar { grid-template-columns: 1fr; }
      .filter-bar button, .filter-bar input, .filter-bar select { min-height: 44px; }
      .usage-account-menu { position: static; width: 100%; box-shadow: none; }
      .usage-account-search { grid-template-columns: 1fr; }
      .usage-account-search .btn-secondary, #usage-account-more { width: 100%; }
      .usage-account-options { max-height: min(44vh, 320px); }
      .usage-metric-head { display: grid; gap: 4px; }
      .usage-metric-head > small { max-width: none; text-align: left; }
      .insight-table-wrap { display: none; }
      .insight-cards { display: grid; }
      .insight-card dl, .session-card dl { grid-template-columns: 1fr; }
      .cursor-pagination { display: grid; grid-template-columns: 1fr auto 1fr; }
      .cursor-pagination button { min-height: 44px; }
      .user-pagination { grid-template-columns: 1fr auto 1fr; align-items: center; }
      .user-pagination span { order: 0; }
      .session-panel > header { align-items: stretch; flex-direction: column; }
      .confirm-panel { padding: 12px; }
      .confirm-card { max-height: calc(100dvh - 24px); overflow-y: auto; padding: 16px; }
      .confirm-actions { display: grid; grid-template-columns: 1fr 1fr; }
      .confirm-actions button { min-height: 44px; min-width: 0; }
      .ota-form-actions .submit-group, .submit-group { width: 100%; display: grid; grid-template-columns: 1fr; }
      .ota-form-actions .submit-group button { width: 100%; min-height: 44px; }
      .ota-detail-actions { display: grid; grid-template-columns: 1fr; }
      .ota-detail-actions button { width: 100%; min-height: 44px; }
      .ota-history > summary { min-height: 44px; }
    }
  </style>`
}
