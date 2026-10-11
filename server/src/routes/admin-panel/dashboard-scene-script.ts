export function adminPanelSceneScript(): string {
  return `    function renderScenes() {
      if (state.selectedSceneId && !state.scenes.some((scene) => scene.id === state.selectedSceneId)) {
        state.selectedSceneId = null;
      }
      $('#scenes-table').innerHTML = thead(['场景', '分类', '状态', '可见']) +
        '<tbody>' + state.scenes.map((s) => {
          const selected = s.id === state.selectedSceneId;
          return '<tr class="scene-row' + (selected ? ' selected' : '') + '"><td><button class="row-select" type="button" data-scene-id="' + esc(s.id) + '" aria-pressed="' + String(selected) + '" aria-selected="' + String(selected) + '"><strong>' + esc(s.name) + '</strong><small>' + esc(s.slug) + '</small></button></td><td>' + esc(s.category) + '</td><td>' + (s.enabled ? '可见' : '停用') + '</td><td>' + esc(s.isPro ? 'Pro' : 'Free') + '</td></tr>';
        }).join('') + '</tbody>';
      $('#scene-cards').innerHTML = state.scenes.length ? state.scenes.map((scene) => '<button class="scene-card' + (scene.id === state.selectedSceneId ? ' selected' : '') + '" type="button" data-scene-id="' + esc(scene.id) + '" aria-pressed="' + String(scene.id === state.selectedSceneId) + '" aria-selected="' + String(scene.id === state.selectedSceneId) + '"><span><strong>' + esc(scene.name) + '</strong><small>' + esc(scene.slug) + ' · ' + esc(scene.category) + '</small></span><span class="status-pill ' + (scene.enabled ? 'ok' : 'off') + '">' + (scene.enabled ? (scene.isPro ? 'Pro' : 'Free') : '停用') + '</span></button>').join('') : '<p class="empty-state">暂无场景模板。</p>';

      const selectedScene = state.scenes.find((scene) => scene.id === state.selectedSceneId);
      if (selectedScene && !state.sceneDirty) fillSceneForm(selectedScene);
      else updateSceneEditorTitle();
    }

    async function selectScene(id, origin) {
      if (blockDuringMutation($('#scene-result'))) return;
      const scene = state.scenes.find((item) => item.id === id);
      if (!scene) return;
      if (scene.id === state.selectedSceneId) { openTaskPanel('scene-detail', origin); return; }
      if (state.sceneDirty && !(await confirmAction({ title: '放弃未保存的场景修改？', copy: '切换到“' + scene.name + '”会丢弃当前尚未保存的输入。' }))) return;
      state.selectedSceneId = scene.id;
      state.sceneDirty = false;
      fillSceneForm(scene);
      show($('#scene-result'), '');
      renderScenes();
      const restoredOrigin = Array.from($$('button[data-scene-id]')).find((item) => item.dataset.sceneId === scene.id && item.getClientRects().length > 0);
      openTaskPanel('scene-detail', restoredOrigin || origin);
    }

    function fillSceneForm(scene) {
      const form = $('#scene-form');
      named(form, 'id').value = scene.id || '';
      named(form, 'slug').value = scene.slug || '';
      named(form, 'name').value = scene.name || '';
      named(form, 'category').value = scene.category || '';
      named(form, 'description').value = scene.description || '';
      named(form, 'promptTemplate').value = scene.promptTemplate || '';
      named(form, 'dictionaryTerms').value = serializeDictionaryTerms(scene.dictionaryTerms);
      named(form, 'enabled').checked = Boolean(scene.enabled);
      named(form, 'isPro').checked = Boolean(scene.isPro);
      state.sceneDirty = false;
      updateSceneEditorTitle(scene);
    }

    function serializeDictionaryTerms(terms) {
      return (Array.isArray(terms) ? terms : []).map((term) => {
        if (typeof term === 'string') return term;
        if (!term || !term.word) return '';
        return term.word + (term.pronunciation ? '|' + term.pronunciation : '');
      }).filter(Boolean).join('\\n');
    }

    async function resetSceneForm(origin) {
      if (blockDuringMutation($('#scene-result'))) return;
      if (state.selectedSceneId === null && state.sceneDirty) { openTaskPanel('scene-detail', origin); return; }
      if (state.sceneDirty && !(await confirmAction({ title: '放弃未保存的场景修改？', copy: '新建场景会清空当前尚未保存的输入。' }))) return;
      state.selectedSceneId = null;
      $('#scene-form').reset();
      named($('#scene-form'), 'id').value = '';
      state.sceneDirty = false;
      show($('#scene-result'), '');
      updateSceneEditorTitle();
      renderScenes();
      openTaskPanel('scene-detail', origin);
    }

    function updateSceneEditorTitle(scene) {
      $('#scene-editor-title').textContent = scene ? '编辑场景：' + scene.name : '新建场景';
    }

    function discardSceneEdits() {
      const selected = state.scenes.find((scene) => scene.id === state.selectedSceneId);
      if (selected) {
        fillSceneForm(selected);
        return;
      }
      const form = $('#scene-form');
      form.reset();
      named(form, 'id').value = '';
      state.sceneDirty = false;
      updateSceneEditorTitle();
    }`
}
