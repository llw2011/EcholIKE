export function adminPanelUsageScript(): string {
  return `    function renderUsageAccountPicker() {
      const selected = state.usageAccount;
      $('#usage-account-label').textContent = selected ? selected.email : '全部账号';
      $('#usage-account-meta').textContent = selected
        ? (selected.name ? selected.name + ' · ' : '') + '用户 ID ' + selected.id
        : '显示所有账号';
      const trigger = $('#usage-account-trigger');
      trigger.setAttribute('aria-expanded', String(state.usageAccountOpen));
      $('#usage-account-menu').hidden = !state.usageAccountOpen;
      const search = $('#usage-account-search');
      if (document.activeElement !== search) search.value = state.usageAccountQuery;

      const choices = [...new Map(
        (selected ? [selected] : []).concat(state.usageAccountItems).map((user) => [user.id, user]),
      ).values()];
      const allSelected = !selected;
      const allOption = '<button class="usage-account-option' + (allSelected ? ' selected' : '') + '" type="button" role="option" aria-selected="' + String(allSelected) + '" data-usage-user-id=""><span><strong>全部账号</strong><small>汇总当前账期所有账号</small></span><span class="status-pill ' + (allSelected ? 'ok' : '') + '">' + (allSelected ? '当前' : '选择') + '</span></button>';
      const userOptions = choices.map((user) => {
        const active = Boolean(selected && selected.id === user.id);
        return '<button class="usage-account-option' + (active ? ' selected' : '') + '" type="button" role="option" aria-selected="' + String(active) + '" data-usage-user-id="' + esc(user.id) + '"><span><strong>' + esc(user.email || user.id) + '</strong><small>' + esc((user.name ? user.name + ' · ' : '') + '用户 ID ' + user.id) + '</small></span><span class="status-pill ' + (active ? 'ok' : '') + '">' + (active ? '当前' : '选择') + '</span></button>';
      }).join('');
      $('#usage-account-options').innerHTML = allOption + userOptions;
      const resource = $('#usage-account-resource');
      resource.textContent = state.usageAccountsLoading
        ? '正在搜索账号…'
        : state.usageAccountError
          ? state.usageAccountError
          : state.usageAccountQuery
            ? '当前显示 ' + state.usageAccountItems.length + ' 个匹配账号。'
            : '每次只读取 10 个账号，可继续加载。';
      $('#usage-account-search-submit').disabled = state.usageAccountsLoading;
      const more = $('#usage-account-more');
      more.hidden = !state.usageAccountNextCursor;
      more.disabled = state.usageAccountsLoading;
    }

    function usageAccountCell(item) {
      return '<strong>' + esc(item.userEmail || item.userId || '-') + '</strong>'
        + '<small>' + esc((item.userName ? item.userName + ' · ' : '') + '用户 ID ' + (item.userId || '-')) + '</small>'
        + '<small>请求 ID ' + esc(item.requestId || '-') + '</small>';
    }

    function renderUsage() {
      const currentSnapshot = usageSnapshot();
      const overview = state.usageOverviewContext === usageOverviewContext(currentSnapshot) ? state.usageOverview : null;
      const visibleItems = state.usageItemsContext === usageItemsContext(currentSnapshot) ? state.usageItems : [];
      const usage = overview && overview.usage;
      const operations = overview && overview.operations;
      const periodKey = state.usageFilters.periodKey || currentPeriodKey();
      $('#usage-context-label').textContent = (state.usageAccount ? state.usageAccount.email : '全部账号') + ' · ' + periodKey;
      $('#usage-usage-metrics').innerHTML = [
        m('语音秒数', usage ? usage.stt_seconds : '—'),
        m('润色 tokens', usage ? usage.llm_tokens : '—'),
        m('OCR 张数', usage ? usage.ocr_images : '—'),
        m('朗读字符', usage ? usage.tts_chars : '—'),
      ].join('');
      $('#usage-health-metrics').innerHTML = [
        m('处理中', operations ? operations.reserved : '—'),
        m('已完成', operations ? operations.completed : '—'),
        m('已释放', operations ? operations.released : '—'),
        m('过期预占', overview ? overview.expiredReservations : '—'),
        m('待核对操作', overview ? overview.unreconciledOperations : '—'),
        m('人工调整', overview ? overview.adjustments : '—'),
      ].join('');
      const rows = visibleItems.map((item) => '<tr><td><strong>' + esc(operationStatusLabel(item.status)) + '</strong><small>' + esc(item.periodKey || '-') + '</small></td><td>' + esc(quotaKindLabel(item.kind)) + '<small>' + esc(item.source || '-') + '</small></td><td>' + usageAccountCell(item) + '</td><td>' + esc(item.reservedAmount ?? '-') + ' → ' + esc(item.actualAmount ?? '-') + '<small>账本净值 ' + esc(item.ledgerNetAmount ?? '-') + '</small></td><td>' + (item.reconciled ? '已核对' : '待核对') + '<small>' + esc(item.ledgerEventCount ?? 0) + ' 条账本事件</small></td><td>' + esc(formatDate(item.updatedAt || item.createdAt)) + '</td></tr>').join('');
      $('#usage-table').innerHTML = thead(['状态', '类型', '账号 / 请求', '预占 → 实际', '核对', '更新时间']) + '<tbody>' + (rows || '<tr><td colspan="6" class="empty-state">当前筛选没有计费操作。</td></tr>') + '</tbody>';
      $('#usage-cards').innerHTML = visibleItems.length ? visibleItems.map((item) => '<article class="insight-card"><header><strong>' + esc(quotaKindLabel(item.kind)) + '</strong><span class="status-pill ' + (item.status === 'completed' ? 'ok' : item.status === 'released' ? 'off' : 'warn') + '">' + esc(operationStatusLabel(item.status)) + '</span></header><dl><div><dt>账号</dt><dd><strong>' + esc(item.userEmail || item.userId || '-') + '</strong>' + (item.userName ? '<small>' + esc(item.userName) + '</small>' : '') + '</dd></div><div><dt>账期</dt><dd>' + esc(item.periodKey || '-') + '</dd></div><div><dt>用户 ID</dt><dd>' + esc(item.userId || '-') + '</dd></div><div><dt>请求 ID</dt><dd>' + esc(item.requestId || '-') + '</dd></div><div><dt>预占 / 实际</dt><dd>' + esc(item.reservedAmount ?? '-') + ' / ' + esc(item.actualAmount ?? '-') + '</dd></div><div><dt>账本核对</dt><dd>' + (item.reconciled ? '已核对' : '待核对') + '</dd></div><div><dt>更新时间</dt><dd>' + esc(formatDate(item.updatedAt || item.createdAt)) + '</dd></div></dl></article>').join('') : '<p class="empty-state">当前筛选没有计费操作。</p>';
      const page = state.usageCursorStack.length + 1;
      $('#usage-page-label').textContent = '第 ' + page + ' 页';
      $('#usage-prev').disabled = state.usageCursorStack.length === 0;
      $('#usage-next').disabled = !state.usageNextCursor;
      const form = $('#usage-filter-form');
      named(form, 'periodKey').value = state.usageFilters.periodKey || currentPeriodKey();
      named(form, 'kind').value = state.usageFilters.kind;
      named(form, 'status').value = state.usageFilters.status;
      named(form, 'userId').value = state.usageFilters.userId;
      renderUsageAccountPicker();
    }

    function operationStatusLabel(status) {
      return ({ reserved: '处理中', completed: '已完成', released: '已释放' })[status] || status || '-';
    }

    function quotaKindLabel(kind) {
      return ({ stt_seconds: '语音秒数', llm_tokens: '润色 tokens', ocr_images: 'OCR 张数', tts_chars: '朗读字符' })[kind] || kind || '-';
    }

    function renderAudit() {
      const rows = state.auditItems.map((item) => '<tr><td><strong>' + esc(item.action || '-') + '</strong><small>' + esc(item.requestId || '-') + '</small></td><td><code>' + esc(item.userId || '-') + '</code></td><td>' + esc(item.status ?? '-') + '<small>' + esc(item.durationMs ?? '-') + ' ms</small></td><td>' + esc(formatDate(item.createdAt)) + '</td></tr>').join('');
      $('#audit-table').innerHTML = thead(['动作 / 请求', '用户', '状态 / 耗时', '时间']) + '<tbody>' + (rows || '<tr><td colspan="4" class="empty-state">当前筛选没有审计记录。</td></tr>') + '</tbody>';
      $('#audit-cards').innerHTML = state.auditItems.length ? state.auditItems.map((item) => '<article class="insight-card"><header><strong>' + esc(item.action || '-') + '</strong><span class="status-pill ' + (Number(item.status) >= 400 ? 'off' : 'ok') + '">' + esc(item.status ?? '-') + '</span></header><dl><div><dt>用户</dt><dd>' + esc(item.userId || '-') + '</dd></div><div><dt>请求 ID</dt><dd>' + esc(item.requestId || '-') + '</dd></div><div><dt>耗时</dt><dd>' + esc(item.durationMs ?? '-') + ' ms</dd></div><div><dt>时间</dt><dd>' + esc(formatDate(item.createdAt)) + '</dd></div></dl></article>').join('') : '<p class="empty-state">当前筛选没有审计记录。</p>';
      const page = state.auditCursorStack.length + 1;
      $('#audit-page-label').textContent = '第 ' + page + ' 页';
      $('#audit-prev').disabled = state.auditCursorStack.length === 0;
      $('#audit-next').disabled = !state.auditNextCursor;
      const form = $('#audit-filter-form');
      named(form, 'q').value = state.auditFilters.q;
      named(form, 'userId').value = state.auditFilters.userId;
      named(form, 'minimumStatus').value = state.auditFilters.minimumStatus;
    }

    function setSessionResource(status, message) {
      const banner = $('#user-sessions-resource');
      banner.className = 'resource-banner ' + status;
      banner.textContent = message || '';
      banner.hidden = status === 'ready' && !message;
    }

    function renderUserSessions() {
      const panel = $('#user-sessions-panel');
      panel.hidden = !state.selectedUser;
      if (!state.selectedUser) { $('#user-sessions-list').innerHTML = ''; return; }
      const sessions = state.userSessionsForId === state.selectedUser.id ? state.userSessions : [];
      $('#user-sessions-list').innerHTML = sessions.length ? sessions.map((session) => '<article class="session-card"><header><strong>' + (session.active ? '有效会话' : '已过期会话') + '</strong><span class="status-pill ' + (session.active ? 'ok' : 'off') + '">' + (session.active ? '有效' : '过期') + '</span></header><dl><div><dt>创建</dt><dd>' + esc(formatDate(session.createdAt)) + '</dd></div><div><dt>到期</dt><dd>' + esc(formatDate(session.expiresAt)) + '</dd></div><div><dt>IP 指纹</dt><dd>' + esc(session.ipFingerprint || '未记录') + '</dd></div><div><dt>设备指纹</dt><dd>' + esc(session.userAgentFingerprint || '未记录') + '</dd></div></dl></article>').join('') : '<p class="empty-state">该用户当前没有有效会话。</p>';
    }`
}

export function adminPanelUsageNavigationScript(): string {
  return `    function minimalUsageAccount(user) {
      return user ? { id: String(user.id), email: String(user.email || user.id), name: user.name ? String(user.name) : null } : null;
    }

    function setUsageAccountMenu(open) {
      state.usageAccountOpen = Boolean(open);
      renderUsageAccountPicker();
      if (state.usageAccountOpen && !state.usageAccountItems.length && !state.usageAccountsLoading) {
        loadUsageAccounts(true);
      }
    }

    function seedUsageAccountFromSelectedUser() {
      if (!state.selectedUser || state.usageAccountSelectionExplicit || state.resources.usage.hasData) return;
      state.usageAccount = minimalUsageAccount(state.selectedUser);
      state.usageAccountSelectionExplicit = true;
      state.usageFilters.userId = state.usageAccount.id;
      state.usageCursor = null;
      state.usageNextCursor = null;
      state.usageCursorStack = [];
    }

    async function selectUsageAccount(user) {
      const account = minimalUsageAccount(user);
      const currentId = state.usageAccount && state.usageAccount.id || '';
      const nextId = account && account.id || '';
      state.usageAccountSelectionExplicit = true;
      state.usageAccount = account;
      state.usageFilters.userId = nextId;
      setUsageAccountMenu(false);
      if (currentId === nextId) {
        renderUsage();
        return true;
      }
      state.requestEpoch.usage += 1;
      state.usageCursor = null;
      state.usageNextCursor = null;
      state.usageCursorStack = [];
      state.usageOverview = null;
      state.usageOverviewContext = null;
      state.usageItems = [];
      state.usageItemsContext = null;
      state.resources.usage.hasData = true;
      renderUsage();
      return loadUsage();
    }

    async function navigateUsage(update) {
      if (blockDuringMutation($('#global-status'))) return false;
      const previous = { cursor: state.usageCursor, nextCursor: state.usageNextCursor, cursorStack: state.usageCursorStack.slice(), filters: { ...state.usageFilters } };
      update();
      const loaded = await loadUsage();
      if (!loaded) {
        state.usageCursor = previous.cursor;
        state.usageNextCursor = previous.nextCursor;
        state.usageCursorStack = previous.cursorStack;
        state.usageFilters = previous.filters;
        renderUsage();
      }
    }

    async function navigateAudit(update) {
      if (blockDuringMutation($('#global-status'))) return false;
      const previous = { cursor: state.auditCursor, nextCursor: state.auditNextCursor, cursorStack: state.auditCursorStack.slice(), filters: { ...state.auditFilters } };
      update();
      const loaded = await loadAudit();
      if (!loaded) {
        state.auditCursor = previous.cursor;
        state.auditNextCursor = previous.nextCursor;
        state.auditCursorStack = previous.cursorStack;
        state.auditFilters = previous.filters;
        renderAudit();
      }
    }`
}
