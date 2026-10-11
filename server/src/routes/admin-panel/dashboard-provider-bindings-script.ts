export function adminPanelProviderBindingsScript(): string {
  return `    // ===== 服务 =====
    $('#provider-master').addEventListener('click', (event) => {
      const card = event.target instanceof Element ? event.target.closest('[data-provider-kind]') : null;
      if (card) selectProviderKind(card.dataset.providerKind, card);
    });
    $('#provider-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      if (!button || button.disabled) return;
      const pick = $('#provider-pick');
      if (pick.selectedIndex > 0) named(form, 'displayName').value = pick.options[pick.selectedIndex].dataset.name;
      const body = providerFormValue(form);
      if (!body.providerId) { showErr($('#provider-result'), new Error('请先选择服务商')); return; }
      const confirmation = providerSaveConfirmation(body);
      if (confirmation && !(await confirmAction(confirmation))) return;
      invalidateProviderModelRead();
      await runMutation({
        key: 'provider-save', form, button, result: $('#provider-result'), pending: '正在保存服务配置…',
        write: () => api('/admin/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        success: () => providerKindLabel(body.kind) + ' 已保存' + (body.enabled ? '并启用。' : '为停用状态。'),
        afterWrite: (response) => {
          state.providerDirty = false;
          if (named(form, 'kind').value === body.kind && named(form, 'providerId').value === body.providerId) {
            named(form, 'apiKey').value = '';
            if (response.provider) {
              named(form, 'id').value = response.provider.id || '';
              named(form, 'expectedRevision').value = String(response.provider.revision ?? '');
            }
          }
        },
        refresh: loadProviders,
      });
    });
    named($('#provider-form'), 'kind').addEventListener('change', () => {
      selectProviderKind(named($('#provider-form'), 'kind').value, named($('#provider-form'), 'kind'));
    });
    $('#provider-pick').addEventListener('change', (event) => { selectProviderChoice(event.currentTarget); });
    $('#provider-read-models').addEventListener('click', readProviderModels);
    $('#provider-form').addEventListener('input', (event) => {
      if (event.target !== $('#provider-pick') && event.target !== named($('#provider-form'), 'kind')) state.providerDirty = true;
    });
    $('#provider-form').addEventListener('change', (event) => {
      if (event.target !== $('#provider-pick') && event.target !== named($('#provider-form'), 'kind')) state.providerDirty = true;
    });
    named($('#provider-form'), 'defaultModel').addEventListener('input', (event) => {
      event.currentTarget.dataset.fromPreset = 'false';
    });
    named($('#provider-form'), 'endpoint').addEventListener('input', (event) => {
      event.currentTarget.dataset.fromPreset = 'false';
      invalidateProviderModelRead();
    });
    named($('#provider-form'), 'apiKey').addEventListener('input', invalidateProviderModelRead);`
}
