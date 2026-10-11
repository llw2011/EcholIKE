export function adminPanelSceneBindingsScript(): string {
  return `    // ===== 场景 =====
    $('#scenes-table').addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest('[data-scene-id]') : null;
      if (row) selectScene(row.getAttribute('data-scene-id'), row);
    });
    $('#scene-cards').addEventListener('click', (event) => {
      const card = event.target instanceof Element ? event.target.closest('[data-scene-id]') : null;
      if (card) selectScene(card.getAttribute('data-scene-id'), card);
    });
    $('#scene-new').addEventListener('click', (event) => resetSceneForm(event.currentTarget));
    $('#scene-form').addEventListener('input', () => { state.sceneDirty = true; });
    $('#scene-form').addEventListener('change', () => { state.sceneDirty = true; });

    $('#scene-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      if (!button || button.disabled) return;
      const terms = named(form, 'dictionaryTerms').value.split('\\n').map((line) => line.trim()).filter(Boolean).map((line) => { const parts = line.split('|'); return { word: parts[0].trim(), pronunciation: (parts[1] || '').trim() || undefined }; });
      const body = formValue(form);
      body.dictionaryTerms = terms;
      const confirmation = sceneSaveConfirmation(body);
      if (confirmation && !(await confirmAction(confirmation))) return;
      await runMutation({
        key: 'scene-save', form, button, result: $('#scene-result'), pending: '正在保存场景…',
        write: () => api('/admin/scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        success: () => '场景“' + body.name + '”已保存。',
        afterWrite: (response) => { state.selectedSceneId = response.scene && response.scene.id || body.id || state.selectedSceneId; state.sceneDirty = false; },
        refresh: loadScenes,
      });
    });`
}
