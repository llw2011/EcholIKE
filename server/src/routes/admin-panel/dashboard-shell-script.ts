export function adminPanelDashboardShellScript(): string {
  return `    // ===== 顶部按钮 =====
    $('#run-checkup').addEventListener('click', runCheckup);
    $('#cmd-refresh').addEventListener('click', async () => {
      const button = $('#cmd-refresh');
      if (button.disabled) return;
      if (!(await prepareActiveRefresh())) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      show($('#global-status'), '正在刷新当前模块…');
      try {
        const loaded = await loadActiveView();
        show($('#global-status'), loaded ? '当前模块已刷新。' : '刷新失败；当前内容与错误说明已保留。');
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
    $('#cmd-signout').addEventListener('click', async () => {
      const button = $('#cmd-signout');
      if (button.disabled) return;
      if (blockDuringMutation($('#global-status'))) return;
      if (hasUnsavedPageChanges() && !(await confirmAction({ title: '放弃未保存的修改并退出？', copy: '服务配置、场景、用户操作或 OTA 草稿中尚未持久化的输入将丢失；已保存的未确认调账身份会保留。' }))) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      show($('#global-status'), '正在退出…');
      try { localStorage.removeItem('echoPanelToken'); } catch {}
      try {
        const response = await fetch(base + '/auth/sign-out', {
          method: 'POST',
          credentials: 'include',
          headers: { [adminActorHeader]: pageActorUserId },
        });
        if (response.status === 409 || response.status === 428) {
          markActorMismatch();
          return;
        }
        if (!response.ok && response.status !== 401) throw new Error('退出请求失败');
        state.providerDirty = false;
        state.sceneDirty = false;
        state.otaDirty = false;
        window.location.href = '/echo-panel/login';
      } catch {
        show($('#global-status'), '退出失败，请检查网络后重试。');
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });

    // ===== 启动 =====
    showWorkspace('overview');
    applyCapabilityState();
    applyRoleState();
    loadOverview();`
}
