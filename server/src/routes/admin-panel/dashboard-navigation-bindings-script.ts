export function adminPanelNavigationBindingsScript(): string {
  return `    // ===== 导航、面板与确认 =====
    $$('.module-tab').forEach((tab) => tab.addEventListener('click', () => activateView(tab.dataset.view)));
    $$('[data-retry]').forEach((button) => button.addEventListener('click', async () => {
      if (button.dataset.retry !== state.activeView || button.disabled) return;
      if (!(await prepareActiveRefresh())) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await loadActiveView();
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }));
    $$('[data-close-panel]').forEach((button) => button.addEventListener('click', () => closeTaskPanel(button.dataset.closePanel)));
    $('#confirm-cancel').addEventListener('click', () => finishConfirm(false));
    $('#confirm-accept').addEventListener('click', () => finishConfirm(true));
    $('#confirm-input').addEventListener('input', (event) => { $('#confirm-accept').disabled = event.currentTarget.value !== confirmPhrase; });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (confirmResolver) { event.preventDefault(); finishConfirm(false); return; }
        const panel = activeTaskPanel();
        if (panel) { event.preventDefault(); closeTaskPanel(panel.id); }
        else if (state.usageAccountOpen) { event.preventDefault(); setUsageAccountMenu(false); $('#usage-account-trigger').focus(); }
        return;
      }
      if (event.key !== 'Tab') return;
      if (confirmResolver) trapFocus(event, $('#danger-confirm'));
      else {
        const panel = activeTaskPanel();
        if (panel) trapFocus(event, panel);
      }
    });
    mobileQuery.addEventListener('change', (event) => {
      if (!event.matches) {
        // The task remains visible in the desktop detail pane, so only release mobile modal ownership.
        $$('.detail-pane.is-open').forEach((panel) => closeTaskPanel(panel.id, true));
        return;
      }
      const draftPanel = state.activeView === 'provider' && state.providerDirty
        ? 'provider-detail'
        : state.activeView === 'scene' && state.sceneDirty
          ? 'scene-detail'
          : state.activeView === 'user' && (state.userFormDirty || hasPendingQuotaOperation())
            ? 'user-detail'
            : null;
      if (draftPanel) openTaskPanel(draftPanel, document.activeElement);
    });
    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedPageChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    });`
}
