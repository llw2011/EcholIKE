export function adminPanelUsageBindingsScript(): string {
  return `    // ===== 用量、审计与会话 =====
    $('#usage-account-trigger').addEventListener('click', () => setUsageAccountMenu(!state.usageAccountOpen));
    $('#usage-account-search-submit').addEventListener('click', () => {
      state.usageAccountQuery = $('#usage-account-search').value.trim();
      loadUsageAccounts(true);
    });
    $('#usage-account-search').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      state.usageAccountQuery = event.currentTarget.value.trim();
      loadUsageAccounts(true);
    });
    $('#usage-account-options').addEventListener('click', (event) => {
      const option = event.target.closest('[data-usage-user-id]');
      if (!option) return;
      const userId = option.dataset.usageUserId || '';
      const user = userId
        ? (state.usageAccount && state.usageAccount.id === userId ? state.usageAccount : state.usageAccountItems.find((item) => item.id === userId))
        : null;
      if (userId && !user) return;
      selectUsageAccount(user);
    });
    $('#usage-account-more').addEventListener('click', async () => {
      if (!state.usageAccountNextCursor || state.usageAccountsLoading) return;
      const previousCursor = state.usageAccountCursor;
      const requestedCursor = state.usageAccountNextCursor;
      const query = state.usageAccountQuery;
      state.usageAccountCursor = requestedCursor;
      state.usageAccountNextCursor = null;
      const loaded = await loadUsageAccounts(false);
      if (!loaded && state.usageAccountQuery === query && state.usageAccountCursor === requestedCursor) {
        state.usageAccountCursor = previousCursor;
        state.usageAccountNextCursor = requestedCursor;
        renderUsageAccountPicker();
      }
    });
    document.addEventListener('click', (event) => {
      if (!state.usageAccountOpen || event.target.closest('.usage-account-field')) return;
      setUsageAccountMenu(false);
    });
    $('#usage-filter-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.resources.usage.status === 'loading') return;
      const form = event.currentTarget;
      await navigateUsage(() => {
        state.usageFilters = {
          periodKey: named(form, 'periodKey').value || currentPeriodKey(),
          kind: named(form, 'kind').value,
          status: named(form, 'status').value,
          userId: named(form, 'userId').value.trim(),
        };
        state.usageCursor = null; state.usageNextCursor = null; state.usageCursorStack = [];
      });
    });
    $('#usage-next').addEventListener('click', () => {
      if (!state.usageNextCursor || state.resources.usage.status === 'loading') return;
      const next = state.usageNextCursor;
      navigateUsage(() => { state.usageCursorStack.push(state.usageCursor); state.usageCursor = next; state.usageNextCursor = null; });
    });
    $('#usage-prev').addEventListener('click', () => {
      if (!state.usageCursorStack.length || state.resources.usage.status === 'loading') return;
      navigateUsage(() => { state.usageCursor = state.usageCursorStack.pop() || null; state.usageNextCursor = null; });
    });
    $('#audit-filter-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.resources.audit.status === 'loading') return;
      const form = event.currentTarget;
      await navigateAudit(() => {
        state.auditFilters = {
          q: named(form, 'q').value.trim(),
          userId: named(form, 'userId').value.trim(),
          minimumStatus: named(form, 'minimumStatus').value,
        };
        state.auditCursor = null; state.auditNextCursor = null; state.auditCursorStack = [];
      });
    });
    $('#audit-next').addEventListener('click', () => {
      if (!state.auditNextCursor || state.resources.audit.status === 'loading') return;
      const next = state.auditNextCursor;
      navigateAudit(() => { state.auditCursorStack.push(state.auditCursor); state.auditCursor = next; state.auditNextCursor = null; });
    });
    $('#audit-prev').addEventListener('click', () => {
      if (!state.auditCursorStack.length || state.resources.audit.status === 'loading') return;
      navigateAudit(() => { state.auditCursor = state.auditCursorStack.pop() || null; state.auditNextCursor = null; });
    });
    $('#user-sessions-refresh').addEventListener('click', () => {
      if (blockDuringMutation($('#user-sessions-resource'))) return;
      if (state.selectedUserId) loadUserSessions(state.selectedUserId);
    });`
}
