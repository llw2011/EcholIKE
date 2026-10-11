export function adminPanelOtaBindingsScript(): string {
  return `    // ===== 版本 =====
    $('#ota-prev').addEventListener('click', () => {
      if (blockDuringMutation($('#ota-result'))) return;
      if (state.otaPage <= 0) return;
      state.otaPage -= 1;
      state.expandedOta.clear();
      renderOta();
    });
    $('#ota-next').addEventListener('click', () => {
      if (blockDuringMutation($('#ota-result'))) return;
      const pageCount = Math.max(1, Math.ceil(state.otaReleases.length / state.otaPageSize));
      if (state.otaPage >= pageCount - 1) return;
      state.otaPage += 1;
      state.expandedOta.clear();
      renderOta();
    });
    $('#ota-table').addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-ota-action]') : null;
      if (!button || button.disabled) return;
      const release = state.otaReleases.find((item) => item.id === button.dataset.otaId);
      if (release) runOtaRecordAction(button.dataset.otaAction, release, button);
    });
    $('#ota-form').addEventListener('input', () => { state.otaDirty = true; });
    $('#ota-form').addEventListener('change', () => { state.otaDirty = true; });
    $('#ota-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = e.submitter || form.querySelector('[data-submit-mode="draft"]');
      if (!button || button.disabled) return;
      if (state.mutationLocks.has('ota-write')) { show($('#ota-result'), '另一项版本写操作正在执行，请等待结果确认。'); return; }
      try {
        const body = otaDraftBody(form);
        let draftRecovered = false;
        await runMutation({
          key: 'ota-write', form, button, result: $('#ota-result'), pending: '正在保存停用草稿…',
          write: async () => {
            try {
              return await api('/admin/ota-releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            } catch (error) {
              const uncertain = error && (error.status === 0 || error.code === 'response_incomplete');
              if (!uncertain && error.status !== 409) throw error;
              state.otaPage = 0;
              state.expandedOta.clear();
              const refreshed = await loadReleases();
              const candidate = refreshed ? findOtaDraftCandidate(body) : null;
              if (uncertain && candidate && otaDraftMatches(candidate, body)) {
                draftRecovered = true;
                return { release: candidate };
              }
              const conflict = new Error(uncertain
                ? (refreshed
                  ? '草稿保存响应未完整到达；版本列表已刷新，但无法确认当前草稿与本次提交完全一致。表单仍保留，请先对比后再载入或重试。'
                  : '草稿保存响应未完整到达，且版本列表刷新失败。表单仍保留，请先手动刷新并核对后再操作。')
                : error.message + (refreshed ? ' 版本列表已刷新，当前表单仍保留，请对比后再载入最新草稿。' : ' 当前表单仍保留，请刷新版本列表后核对。'));
              conflict.code = uncertain ? 'response_incomplete' : error.code;
              conflict.status = error.status;
              throw conflict;
            }
          },
          success: (response) => 'v' + ((response.release && response.release.version) || body.version) + ' 已保存为停用草稿。' + (draftRecovered ? ' 已通过重新读取服务器状态恢复确认。' : ''),
          afterWrite: (response) => {
            state.otaPage = 0; state.expandedOta.clear();
            named(form, 'id').value = response.release && response.release.id || '';
            named(form, 'expectedRevision').value = response.release ? String(response.release.revision) : '';
            state.otaDirty = false;
          },
          refresh: () => draftRecovered ? Promise.resolve(true) : loadReleases(),
        });
      } catch (error) { showErr($('#ota-result'), error); }
    });`
}
