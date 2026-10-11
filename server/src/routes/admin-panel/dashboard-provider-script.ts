export function adminPanelProviderScript(): string {
  return `    function renderProviderStatus() {
      const panel = $('.diagnostic-panel');
      if (panel) panel.hidden = !hasCapability('services:read');
      if (!state.proxy || !state.desktopPolicy) {
        $('#provider-status').innerHTML = '';
        return;
      }
      const items = [
        { label: '语音转写 STT', info: state.proxy.stt },
        { label: '文本润色 LLM', info: state.proxy.llm },
        { label: '语音合成 TTS', info: state.desktopPolicy.providerStatus.tts },
        { label: '视觉 OCR', info: state.desktopPolicy.providerStatus.ocr },
      ];
      $('#provider-status').innerHTML = items.map((item) => {
        var ok = item.info && item.info.configured;
        var detail = item.info ? (item.info.provider || '未配置') + (item.info.model ? ' · ' + item.info.model : '') : '未配置';
        return '<div class="sc-card ' + (ok ? 'ok' : 'off') + '"><span class="sc-dot">' + (ok ? '🟢' : '🔴') + '</span><span class="sc-label">' + esc(item.label) + '</span><span class="sc-detail">' + esc(detail) + '</span></div>';
      }).join('');
    }

    function providerStatusInfo(kind) {
      if (kind === 'stt') return state.proxy && state.proxy.stt;
      if (kind === 'llm') return state.proxy && state.proxy.llm;
      return state.desktopPolicy && state.desktopPolicy.providerStatus && state.desktopPolicy.providerStatus[kind];
    }

    function providerKindLabel(kind) {
      return ({ llm: '文本润色 LLM', stt: '语音转写 STT', tts: '语音合成 TTS', ocr: '视觉 OCR' })[kind] || kind;
    }

    function renderProviderMaster() {
      const kinds = ['llm', 'stt', 'tts', 'ocr'];
      $('#provider-master').innerHTML = kinds.map((kind) => {
        const info = providerStatusInfo(kind);
        const configured = Boolean(info && info.configured);
        const selected = state.selectedProviderKind === kind;
        const detail = info ? (info.provider || '未配置') + (info.model ? ' · ' + info.model : '') : '未配置';
        return '<button class="provider-master-card' + (selected ? ' selected' : '') + '" type="button" data-provider-kind="' + kind + '" aria-pressed="' + String(selected) + '"><span><strong>' + esc(providerKindLabel(kind)) + '</strong><small>' + esc(detail) + '</small></span><span class="status-pill ' + (configured ? 'ok' : 'off') + '">' + (configured ? '已配置' : '未配置') + '</span></button>';
      }).join('');
      $('#provider-detail-title').textContent = providerKindLabel(state.selectedProviderKind);
    }

    function providerChoices(kind) {
      const choices = new Map();
      for (const preset of providerPresets[kind] || []) choices.set(preset.providerId, { ...preset, enabled: true, source: 'preset' });
      for (const provider of state.providers.filter((p) => p.kind === kind)) {
        choices.set(provider.providerId, {
          id: provider.id || '',
          providerId: provider.providerId,
          displayName: provider.displayName || provider.providerId,
          defaultModel: provider.defaultModel || '',
          endpoint: provider.endpoint || '',
          models: provider.models || [],
          capabilities: provider.capabilities || {},
          revision: provider.revision,
          enabled: Boolean(provider.enabled),
          source: provider.enabled ? 'configured' : 'disabled',
        });
      }
      return [...choices.values()];
    }

    function syncProviderDefaults(replaceOwnedFields = false, selectionIsDirty = false) {
      const form = $('#provider-form');
      const pick = $('#provider-pick');
      if (!form || !pick || pick.selectedIndex < 0) return;
      invalidateProviderModelRead();
      const option = pick.options[pick.selectedIndex];
      const model = named(form, 'defaultModel');
      const endpoint = named(form, 'endpoint');
      named(form, 'displayName').value = option.dataset.name || '';
      named(form, 'id').value = option.dataset.id || '';
      named(form, 'expectedRevision').value = option.dataset.revision || '';
      named(form, 'enabled').checked = option.dataset.enabled !== 'false';
      named(form, 'apiKey').value = '';
      fillModelOptions(option.dataset.models || '[]');
      if (model && (replaceOwnedFields || !model.value || model.dataset.fromPreset === 'true')) {
        model.value = option.dataset.model || '';
        model.dataset.fromPreset = model.value ? 'true' : '';
      }
      if (endpoint && (replaceOwnedFields || !endpoint.value || endpoint.dataset.fromPreset === 'true')) {
        endpoint.value = option.dataset.endpoint || '';
        endpoint.dataset.fromPreset = endpoint.value ? 'true' : '';
      }
      renderCapabilityFields(option.dataset.capabilities || '{}');
      state.providerSelection = pick.value;
      state.providerDirty = selectionIsDirty;
    }

    function fillProviderPick() {
      const form = $('#provider-form');
      const pick = $('#provider-pick');
      if (!form || !pick) return;
      const kind = state.selectedProviderKind || named(form, 'kind')?.value || 'llm';
      named(form, 'kind').value = kind;
      const configured = state.providers.find((provider) => provider.kind === kind);
      const opts = '<option value="">— 选择 —</option>' + providerChoices(kind).map((p) => {
        const suffix = p.source === 'configured' ? ' · 已配置' : (p.source === 'disabled' ? ' · 已停用' : '');
        const endpoint = p.endpoint || p.baseUrl || '';
        const capabilities = JSON.stringify(p.capabilities || {});
        const models = JSON.stringify(p.models || []);
        return '<option value="' + esc(p.providerId) + '" data-id="' + esc((configured && configured.id) || p.id || '') + '" data-revision="' + esc(configured && configured.revision !== undefined ? configured.revision : (p.revision ?? '')) + '" data-name="' + esc(p.displayName) + '" data-model="' + esc(p.defaultModel || '') + '" data-endpoint="' + esc(endpoint) + '" data-models="' + esc(models) + '" data-capabilities="' + esc(capabilities) + '" data-enabled="' + String(p.enabled !== false) + '">' + esc(p.displayName || p.providerId) + suffix + '</option>';
      }).join('');
      pick.innerHTML = opts;
      if (configured) pick.value = configured.providerId;
      if (!pick.value && pick.options.length > 1) pick.selectedIndex = 1;
      syncProviderDefaults(true);
    }

    async function selectProviderKind(kind, origin) {
      if (!['llm', 'stt', 'tts', 'ocr'].includes(kind)) return;
      if (blockDuringMutation($('#provider-result'))) return;
      if (kind === state.selectedProviderKind) { openTaskPanel('provider-detail', origin); return; }
      if (state.providerDirty && !(await confirmAction({ title: '放弃未保存的服务配置？', copy: '切换服务类型会覆盖当前尚未保存的输入。' }))) {
        named($('#provider-form'), 'kind').value = state.selectedProviderKind;
        return;
      }
      state.providerDirty = false;
      state.selectedProviderKind = kind;
      const form = $('#provider-form');
      form.reset();
      named(form, 'kind').value = kind;
      named(form, 'defaultModel').dataset.fromPreset = 'true';
      named(form, 'endpoint').dataset.fromPreset = 'true';
      show($('#provider-result'), '');
      renderProviderMaster();
      fillProviderPick();
      const restoredOrigin = Array.from($$('#provider-master [data-provider-kind]')).find((item) => item.dataset.providerKind === kind);
      openTaskPanel('provider-detail', restoredOrigin || origin);
    }

    async function selectProviderChoice(origin) {
      if (blockDuringMutation($('#provider-result'))) return;
      const pick = $('#provider-pick');
      if (state.providerDirty && !(await confirmAction({ title: '放弃未保存的服务配置？', copy: '选择另一服务商会覆盖当前尚未保存的输入。' }))) {
        pick.value = state.providerSelection;
        return;
      }
      state.providerDirty = false;
      const configured = state.providers.find((provider) => provider.kind === state.selectedProviderKind);
      syncProviderDefaults(true, !configured || configured.providerId !== pick.value);
      openTaskPanel('provider-detail', origin);
    }

    function capabilityLabel(key) {
      return ({ requiresApiKey: '需要 API 密钥', supportsStreaming: '支持流式输出', supportsTranslate: '支持翻译', supportsPartialStt: '支持实时转写', imageAvailable: '支持图片', pdfAvailable: '支持 PDF', acceptedMimeTypes: '图片格式', maxInputBytes: '最大输入字节', maxPdfPages: '最大 PDF 页数', processingRoutes: '处理路径', pdfMode: 'PDF 模式', voice: '默认音色' })[key] || key;
    }

    function renderCapabilityFields(value) {
      let capabilities = {};
      try { capabilities = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}); } catch { capabilities = {}; }
      state.providerCapabilities = { ...capabilities };
      const entries = Object.entries(capabilities);
      $('#provider-capability-fields').innerHTML = entries.length ? entries.map(([key, item]) => {
        const shown = typeof item === 'boolean' ? (item ? '是' : '否') : Array.isArray(item) ? item.join('、') : String(item ?? '');
        return '<div class="capability-item"><dt>' + esc(capabilityLabel(key)) + '</dt><dd>' + esc(shown || '—') + '</dd></div>';
      }).join('') : '<p class="hint">当前服务没有额外能力参数。</p>';
    }

    function collectCapabilityFields() {
      return { ...state.providerCapabilities };
    }

    function fillModelOptions(modelsJson) {
      const list = $('#provider-model-options');
      if (!list) return;
      let models = [];
      try { models = JSON.parse(modelsJson || '[]'); } catch {}
      list.innerHTML = models.map((model) => {
        const id = typeof model === 'string' ? model : model && model.id;
        const label = typeof model === 'string' ? model : model && (model.label || model.id);
        return id ? '<option value="' + esc(id) + '">' + esc(label || id) + '</option>' : '';
      }).join('');
    }

    function providerModelFingerprint(form) {
      return JSON.stringify([
        named(form, 'kind').value,
        named(form, 'providerId').value,
        named(form, 'endpoint').value.trim(),
      ]);
    }

    function invalidateProviderModelRead() {
      state.providerModelRequestEpoch += 1;
      const button = $('#provider-read-models');
      if (!button) return;
      button.removeAttribute('aria-busy');
      button.textContent = '读取模型';
      applyRoleState();
    }

    async function readProviderModels() {
      const form = $('#provider-form');
      const result = $('#provider-result');
      const button = $('#provider-read-models');
      const endpoint = named(form, 'endpoint').value.trim();
      const providerId = named(form, 'providerId').value;
      if (!providerId) { showErr(result, new Error('请先选择服务商')); return; }
      if (!endpoint) { showErr(result, new Error('请先填写后端服务地址')); return; }

      const requestEpoch = ++state.providerModelRequestEpoch;
      const requestFingerprint = providerModelFingerprint(form);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = '读取中...';
      try {
        const body = {
          kind: named(form, 'kind').value,
          providerId,
          endpoint,
          apiKey: named(form, 'apiKey').value || undefined,
        };
        const data = await api('/admin/provider-models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (requestEpoch !== state.providerModelRequestEpoch || requestFingerprint !== providerModelFingerprint(form)) return;
        fillModelOptions(JSON.stringify(data.models || []));
        if (data.models && data.models.length) {
          const model = named(form, 'defaultModel');
          if (!model.value || model.dataset.fromPreset === 'true') {
            model.value = data.models[0].id;
            model.dataset.fromPreset = 'false';
            state.providerDirty = true;
          }
        }
        show(result, '已读取 ' + ((data.models && data.models.length) || 0) + ' 个模型。');
      } catch (err) {
        if (requestEpoch !== state.providerModelRequestEpoch || requestFingerprint !== providerModelFingerprint(form)) return;
        showErr(result, err);
      } finally {
        if (requestEpoch === state.providerModelRequestEpoch) {
          button.removeAttribute('aria-busy');
          button.textContent = '读取模型';
          applyRoleState();
        }
      }
    }`
}
