export function adminPanelDirtyStateScript(): string {
  return `    function discardProviderEdits() {
      const form = $('#provider-form');
      form.reset();
      named(form, 'kind').value = state.selectedProviderKind;
      named(form, 'defaultModel').dataset.fromPreset = 'true';
      named(form, 'endpoint').dataset.fromPreset = 'true';
      fillProviderPick();
      show($('#provider-result'), '');
    }

    function discardOtaEdits() {
      const form = $('#ota-form');
      const release = state.otaReleases.find((item) => item.id === named(form, 'id').value);
      if (release) fillOtaForm(release);
      else form.reset();
      state.otaDirty = false;
      show($('#ota-result'), '');
    }

    function clearOwnPasswordForm() {
      const form = $('#change-password-form');
      if (form) form.reset();
      show($('#change-password-result'), '');
    }

    function blockDuringMutation(result = $('#global-status')) {
      if (!state.mutationLocks.size) return false;
      show(result, '当前任务正在确认，不能切换、刷新或退出；请等待结果返回。');
      return true;
    }

    function markActorMismatch() {
      state.actorMismatch = true;
      show($('#global-status'), '登录账号已在其他窗口切换。为避免操作到错误账号，本页写入已冻结；请重新加载管理台。');
      applyRoleState();
    }

    function hasPendingQuotaOperation() {
      return Boolean(readPendingQuotaOperation()) || state.pendingQuotaStorageCorrupt;
    }

    function showPendingQuotaBlock(message, result = $('#quota-result')) {
      show($('#global-status'), message);
      if (result !== $('#global-status')) show(result, message);
    }

    function hasUnsavedPageChanges() {
      const persistedQuotaOperation = Boolean(readPendingQuotaOperation());
      return state.mutationLocks.size > 0 || state.providerDirty || state.sceneDirty || state.otaDirty || (state.userFormDirty && !persistedQuotaOperation);
    }`
}

export function adminPanelInteractionScript(): string {
  return `    function renderSystem() {
      const sys = state.system;
      if (!sys) return;
      $('#system-content').innerHTML = kv('运行时', sys.runtime) + kv('依赖', sys.dependencies);
    }

    function kv(title, obj) {
      return '<article class="sys-card"><h4>' + esc(title) + '</h4><div class="kv">' + Object.entries(obj || {}).map(([k, v]) => '<div><span>' + esc(k) + '</span><strong>' + esc(String(v)) + '</strong></div>').join('') + '</div></article>';
    }

    function thead(cols) { return '<thead><tr>' + cols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead>'; }
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    function capabilities() {
      return state.summary && state.summary.admin && Array.isArray(state.summary.admin.capabilities) ? state.summary.admin.capabilities : [];
    }

    function hasCapability(capability) {
      return !capability || capabilities().includes(capability);
    }

    function applyCapabilityState() {
      const viewCapabilities = { overview: 'overview:read', user: 'users:read', usage: 'usage:read', provider: 'services:read', scene: 'scenes:read', publish: 'releases:read', audit: 'audit:read', system: 'system:read' };
      const loaded = Boolean(state.summary);
      $$('.module-tab').forEach((tab) => {
        const allowed = loaded ? hasCapability(viewCapabilities[tab.dataset.view]) : tab.dataset.view === 'overview';
        tab.hidden = !allowed;
        tab.disabled = !allowed;
      });
      $$('[data-task-capability]').forEach((button) => { button.hidden = !hasCapability(button.dataset.taskCapability); });
      $$('button[data-capability]').forEach((button) => { button.hidden = !hasCapability(button.dataset.capability); });
      const actorRole = state.summary && state.summary.admin && state.summary.admin.role;
      $$('[data-owner-only-container]').forEach((container) => { container.hidden = actorRole !== 'owner'; });
      const ownerOption = named($('#admin-form'), 'role').querySelector('option[value="owner"]');
      if (ownerOption) ownerOption.disabled = actorRole !== 'owner';
      $('#run-checkup').hidden = !hasCapability('diagnostics:run');
      const diagnosticPanel = $('.diagnostic-panel');
      if (diagnosticPanel) diagnosticPanel.hidden = !hasCapability('services:read');
      const currentCapability = viewCapabilities[state.activeView];
      if (currentCapability && !hasCapability(currentCapability)) showWorkspace('overview');
    }

    function applyRoleState() {
      $$('button, input, select, textarea').forEach((control) => {
        if (control.dataset.mutationLocked === 'true') { control.disabled = true; return; }
        if (control.getAttribute('aria-busy') === 'true') { control.disabled = true; return; }
        const workspace = control.closest('[data-workspace]');
        const resource = workspace && state.resources[workspace.dataset.workspace];
        const usageAccountControl = workspace && workspace.dataset.workspace === 'usage' && control.closest('.usage-account-field');
        if (resource && resource.status === 'loading' && !usageAccountControl) {
          if (control.dataset.resourceLocked !== 'true') {
            control.dataset.resourceWasDisabled = String(control.disabled);
            control.dataset.resourceLocked = 'true';
          }
          control.disabled = true;
          return;
        }
        if (control.dataset.resourceLocked === 'true') {
          control.disabled = control.dataset.resourceWasDisabled === 'true';
          delete control.dataset.resourceWasDisabled;
          delete control.dataset.resourceLocked;
        }
        const form = control.closest('form[data-capability]');
        const requiredCapability = control.dataset.capability || (form && form.dataset.capability) || '';
        const managed = Boolean(requiredCapability || control.hasAttribute('data-requires-user') || control.hasAttribute('data-requires-other-user') || control.hasAttribute('data-owner-only'));
        if (!managed) {
          if (state.actorMismatch && control.closest('#change-password-form')) control.disabled = true;
          return;
        }
        let disabled = Boolean(requiredCapability && !hasCapability(requiredCapability));
        if (state.actorMismatch && requiredCapability && !requiredCapability.endsWith(':read')) disabled = true;
        if (control.hasAttribute('data-owner-only') && state.summary?.admin?.role !== 'owner') disabled = true;
        if (control.hasAttribute('data-requires-user') && !state.selectedUser) disabled = true;
        const selectedSelf = Boolean(state.selectedUser && state.selectedUser.id === state.summary?.admin?.userId);
        if (control.hasAttribute('data-requires-other-user') && (!state.selectedUser || selectedSelf)) disabled = true;
        const protectedOwner = Boolean(state.selectedUser && state.selectedUser.adminRole === 'owner' && state.summary?.admin?.role !== 'owner');
        if (protectedOwner && (form && (form.id === 'admin-form' || form.id === 'reset-password-form'))) disabled = true;
        control.disabled = disabled;
      });
      const selectedSelf = Boolean(state.selectedUser && state.selectedUser.id === state.summary?.admin?.userId);
      $$('[data-requires-other-user]').forEach((control) => {
        control.disabled = control.disabled || !state.selectedUser || selectedSelf || control.dataset.mutationLocked === 'true';
      });
    }

    function named(form, name) { return form.elements.namedItem(name); }
    function show(el, msg) { if (el) el.textContent = msg; }
    function showErr(el, e) { if (el) el.textContent = (e && e.message) || '失败'; }

    function formValue(form) {
      const obj = {};
      form.querySelectorAll('input, select, textarea').forEach((field) => {
        if (!field.name) return;
        if (field.type === 'checkbox') {
          obj[field.name] = field.checked;
          return;
        }
        if (field.name === 'enabled' || field.name === 'isPro' || field.name === 'forceUpdate' || field.name === 'autoUpdate') {
          obj[field.name] = field.value === 'true' || field.value === 'on';
          return;
        }
        if (typeof field.value === 'string' && field.value !== '') obj[field.name] = field.value;
      });
      return obj;
    }

    function providerFormValue(form) {
      const body = formValue(form);
      if (body.priority !== undefined) body.priority = Number(body.priority);
      if (body.expectedRevision !== undefined) body.expectedRevision = Number(body.expectedRevision);
      body.capabilities = collectCapabilityFields();
      return body;
    }

    function lockForm(form, locked) {
      if (!form) return;
      form.querySelectorAll('button, input, select, textarea').forEach((control) => {
        if (locked) {
          control.dataset.mutationWasDisabled = String(control.disabled);
          control.dataset.mutationLocked = 'true';
          control.disabled = true;
        } else {
          control.disabled = control.dataset.mutationWasDisabled === 'true';
          delete control.dataset.mutationWasDisabled;
          delete control.dataset.mutationLocked;
        }
      });
      applyRoleState();
    }

    async function runMutation({ key, form, button, result, pending, write, success, afterWrite, refresh }) {
      if (state.mutationLocks.has(key)) return null;
      state.mutationLocks.add(key);
      const actionFocusTarget = captureFocusTarget(document.activeElement || button);
      const originalText = button ? button.textContent : '';
      lockForm(form, true);
      if (button) { button.setAttribute('aria-busy', 'true'); button.textContent = pending; }
      show(result, pending);
      try {
        const response = await write();
        let successMessage = '写入已成功。';
        try {
          if (afterWrite) afterWrite(response);
          successMessage = success(response);
        } catch {
          show(result, '写入已成功，但本地页面状态更新失败。请刷新当前模块核对结果，不要重复提交。');
          return response;
        }
        show(result, successMessage);
        if (refresh) {
          let refreshed = false;
          try { refreshed = await refresh(); } catch {}
          if (!refreshed) show(result, successMessage + ' 后续列表刷新失败，写入结果已经生效，请使用模块右上角重试刷新，不要重复提交。');
        }
        return response;
      } catch (error) {
        showErr(result, error);
        return null;
      } finally {
        state.mutationLocks.delete(key);
        lockForm(form, false);
        if (button) { button.removeAttribute('aria-busy'); button.textContent = originalText; }
        applyRoleState();
        restoreFocusTarget(actionFocusTarget, button);
      }
    }

    let confirmResolver = null;
    let confirmPhrase = '';
    let confirmOrigin = null;

    function captureFocusTarget(element) {
      if (!(element instanceof Element)) return null;
      const attributes = ['data-provider-kind', 'data-user-id', 'data-scene-id', 'data-ota-key', 'data-ota-action', 'data-ota-id', 'data-user-task', 'data-submit-mode', 'data-retry']
        .filter((name) => element.hasAttribute(name))
        .map((name) => [name, element.getAttribute(name)]);
      const form = element.closest('form');
      return {
        element,
        id: element.id || '',
        attributes,
        formId: form && form.id || '',
        controlName: 'name' in element ? element.name || '' : '',
        controlType: 'type' in element ? element.type || '' : '',
        controlText: element.tagName === 'BUTTON' ? element.textContent : '',
      };
    }

    function focusCandidate(snapshot) {
      if (!snapshot) return null;
      const candidates = [];
      if (snapshot.element && snapshot.element.isConnected) candidates.push(snapshot.element);
      if (snapshot.id) candidates.push(document.getElementById(snapshot.id));
      if (snapshot.attributes.length) {
        const selector = snapshot.attributes.map(([name]) => '[' + name + ']').join('');
        candidates.push(...Array.from($$(selector)).filter((candidate) => snapshot.attributes.every(([name, value]) => candidate.getAttribute(name) === value)));
      }
      if (snapshot.formId) {
        const form = document.getElementById(snapshot.formId);
        if (form) {
          candidates.push(...Array.from(form.querySelectorAll('button, input, select, textarea')).filter((candidate) =>
            (!snapshot.controlName || candidate.name === snapshot.controlName) &&
            (!snapshot.controlType || candidate.type === snapshot.controlType) &&
            (!snapshot.controlText || candidate.tagName !== 'BUTTON' || candidate.textContent === snapshot.controlText)));
        }
      }
      return candidates.find((candidate) => candidate && candidate.isConnected && !candidate.disabled && !candidate.closest('[hidden], [inert]') && candidate.getClientRects().length > 0) || null;
    }

    function restoreFocusTarget(snapshot, fallback = null) {
      const target = focusCandidate(snapshot) || (fallback && fallback.isConnected && !fallback.disabled && !fallback.closest('[hidden], [inert]') ? fallback : null);
      if (target && typeof target.focus === 'function') target.focus();
    }

    function clearModalIsolation() {
      for (const [element, previous] of modalIsolation.entries()) {
        element.inert = previous.inert;
        if (previous.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', previous.ariaHidden);
      }
      modalIsolation.clear();
    }

    function syncModalIsolation() {
      clearModalIsolation();
      const confirmPanel = $('#danger-confirm');
      let owner = confirmPanel && !confirmPanel.hidden ? confirmPanel : activeTaskPanel();
      while (owner && owner !== document.body) {
        const parent = owner.parentElement;
        if (!parent) break;
        for (const sibling of parent.children) {
          if (sibling === owner || sibling.contains(owner)) continue;
          modalIsolation.set(sibling, { inert: sibling.inert, ariaHidden: sibling.getAttribute('aria-hidden') });
          sibling.inert = true;
          sibling.setAttribute('aria-hidden', 'true');
        }
        owner = parent;
      }
    }

    function confirmAction({ title, copy, phrase = '' }) {
      if (confirmResolver) return Promise.resolve(false);
      const panel = $('#danger-confirm');
      confirmPhrase = phrase;
      confirmOrigin = captureFocusTarget(document.activeElement);
      $('#confirm-title').textContent = title;
      $('#confirm-copy').textContent = copy;
      $('#confirm-input-wrap').hidden = !phrase;
      $('#confirm-input-wrap').firstChild.textContent = phrase ? '输入“' + phrase + '”确认' : '';
      $('#confirm-input').value = '';
      $('#confirm-accept').disabled = Boolean(phrase);
      panel.hidden = false;
      document.body.classList.add('panel-open');
      syncModalIsolation();
      (phrase ? $('#confirm-input') : $('#confirm-cancel')).focus();
      return new Promise((resolve) => { confirmResolver = resolve; });
    }

    function finishConfirm(value) {
      if (!confirmResolver) return;
      const resolve = confirmResolver;
      confirmResolver = null;
      $('#danger-confirm').hidden = true;
      if (!$$('.detail-pane.is-open').length) document.body.classList.remove('panel-open');
      syncModalIsolation();
      restoreFocusTarget(confirmOrigin);
      confirmOrigin = null;
      resolve(value);
    }

    function openTaskPanel(id, origin) {
      const panel = $('#' + id);
      if (!panel) return;
      if (!mobileQuery.matches) {
        restoreFocusTarget(captureFocusTarget(origin));
        return;
      }
      if (!panel.classList.contains('is-open')) state.panelOrigin = captureFocusTarget(origin || document.activeElement);
      panel.classList.add('is-open');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      document.body.classList.add('panel-open');
      syncModalIsolation();
      const focusable = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')).find((control) => !control.closest('[hidden]'));
      if (focusable) focusable.focus();
    }

    function closeTaskPanel(id, allowDuringMutation = false) {
      const panel = $('#' + id);
      if (!panel) return false;
      if (!allowDuringMutation && blockDuringMutation(panel.querySelector('.result-line') || $('#global-status'))) return false;
      panel.classList.remove('is-open');
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      if (!confirmResolver) document.body.classList.remove('panel-open');
      syncModalIsolation();
      restoreFocusTarget(state.panelOrigin);
      state.panelOrigin = null;
      return true;
    }

    function activeTaskPanel() {
      return Array.from($$('.detail-pane.is-open')).pop() || null;
    }

    function trapFocus(event, container) {
      const focusable = Array.from(container.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((control) => !control.closest('[hidden]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!container.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    async function switchUserTask(task, origin) {
      if (blockDuringMutation($('#global-status'))) return;
      if (task !== state.userTask && hasPendingQuotaOperation()) {
        showPendingQuotaBlock('请先恢复并核对当前未确认的配额调整，不能切换任务。');
        return;
      }
      if (task !== state.userTask && state.userFormDirty) {
        if (!(await confirmAction({ title: '放弃未保存的用户操作？', copy: '切换任务会丢弃当前尚未提交的表单内容。' }))) return;
        if (!discardUserEdits()) return;
      }
      setUserTask(task, origin);
    }

    function matchingPassword(form, passwordName) {
      const password = named(form, passwordName).value;
      const confirmation = named(form, 'confirmPassword').value;
      if (password.length < 8 || password.length > 128) throw new Error('密码长度需要在 8 到 128 个字符之间');
      if (password !== confirmation) throw new Error('两次输入的新密码不一致');
      return password;
    }

    async function navigateUsers(update) {
      if (blockDuringMutation($('#user-list-summary'))) return false;
      if (hasPendingQuotaOperation()) {
        showPendingQuotaBlock('请先恢复并核对当前未确认的配额调整，不能切换用户列表。', $('#user-list-summary'));
        return false;
      }
      const previous = {
        query: state.userQuery,
        cursor: state.userCursor,
        nextCursor: state.userNextCursor,
        cursorStack: state.userCursorStack.slice(),
      };
      const hadDirtyForm = state.userFormDirty;
      if (hadDirtyForm && !(await confirmAction({ title: '放弃未保存的用户操作？', copy: '切换用户列表位置可能会关闭当前用户表单。' }))) return false;
      if (hadDirtyForm && !discardUserEdits()) return false;
      update();
      const loaded = await loadUsersPage();
      if (!loaded) {
        state.userQuery = previous.query;
        state.userCursor = previous.cursor;
        state.userNextCursor = previous.nextCursor;
        state.userCursorStack = previous.cursorStack;
        renderUsers();
        applyRoleState();
        show($('#user-list-summary'), '用户列表加载失败；已恢复到之前的列表位置。');
      }
    }

    function showWorkspace(view) {
      if (view !== 'account') clearOwnPasswordForm();
      state.activeView = view;
      $$('.workspace').forEach((workspace) => {
        const active = workspace.dataset.workspace === view;
        workspace.hidden = !active;
        workspace.classList.toggle('is-active', active);
      });
      $$('.module-tab').forEach((tab) => {
        const active = tab.dataset.view === view;
        tab.classList.toggle('is-active', active);
        if (active) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      });
      show($('#global-status'), '');
    }

    async function activateView(view) {
      const tab = Array.from($$('.module-tab')).find((item) => item.dataset.view === view);
      if (!tab || tab.hidden || tab.disabled) return;
      if (view !== state.activeView && blockDuringMutation($('#global-status'))) return;
      if (view !== state.activeView) {
        const persistedQuotaOperation = state.activeView === 'user' ? Boolean(readPendingQuotaOperation()) : false;
        let confirmation = null;
        if (state.activeView === 'provider' && state.providerDirty) confirmation = { title: '放弃未保存的服务配置？', copy: '离开服务模块会丢弃当前尚未保存的输入。' };
        else if (state.activeView === 'scene' && state.sceneDirty) confirmation = { title: '放弃未保存的场景修改？', copy: '离开场景模块会丢弃当前尚未保存的输入。' };
        else if (state.activeView === 'publish' && state.otaDirty) confirmation = { title: '放弃未保存的 OTA 草稿？', copy: '离开版本模块会丢弃当前尚未保存的输入。' };
        else if (state.activeView === 'user' && state.userFormDirty && !persistedQuotaOperation) confirmation = { title: '放弃未保存的用户操作？', copy: '离开用户模块会丢弃当前尚未提交的表单。' };
        if (confirmation && !(await confirmAction(confirmation))) return;
        if (state.activeView === 'provider' && state.providerDirty) discardProviderEdits();
        if (state.activeView === 'scene' && state.sceneDirty) discardSceneEdits();
        if (state.activeView === 'publish' && state.otaDirty) discardOtaEdits();
        if (state.activeView === 'user' && !persistedQuotaOperation && !discardUserEdits()) return;
      }
      const activePanel = activeTaskPanel();
      if (activePanel) closeTaskPanel(activePanel.id);
      if (view === 'usage' && state.activeView === 'user') seedUsageAccountFromSelectedUser();
      showWorkspace(view);
      const resource = state.resources[view];
      if (resource && !resource.hasData) await loadActiveView();
    }

    async function prepareActiveRefresh() {
      if (blockDuringMutation($('#global-status'))) return false;
      const persistedQuotaOperation = state.activeView === 'user' ? Boolean(readPendingQuotaOperation()) : false;
      let title = '';
      let copy = '';
      if (state.activeView === 'provider' && state.providerDirty) {
        title = '放弃未保存的服务配置？';
        copy = '刷新服务模块会用服务器配置覆盖当前输入。';
      } else if (state.activeView === 'scene' && state.sceneDirty) {
        title = '放弃未保存的场景修改？';
        copy = '刷新场景模块会用服务器内容覆盖当前输入。';
      } else if (state.activeView === 'user' && state.userFormDirty && !persistedQuotaOperation) {
        title = '放弃未保存的用户操作？';
        copy = '刷新用户模块可能会覆盖当前尚未提交的表单。';
      } else if (state.activeView === 'publish' && state.otaDirty) {
        title = '放弃未保存的 OTA 草稿？';
        copy = '刷新版本模块会用服务器内容覆盖当前输入。';
      }
      if (title && !(await confirmAction({ title, copy }))) return false;
      if (state.activeView === 'provider') discardProviderEdits();
      if (state.activeView === 'scene') discardSceneEdits();
      if (state.activeView === 'publish') discardOtaEdits();
      if (state.activeView === 'user' && !persistedQuotaOperation && !discardUserEdits()) return false;
      return true;
    }`
}

export function adminPanelConfirmationScript(): string {
  return `    function providerSaveConfirmation(body) {
      const current = state.providers.find((provider) => provider.kind === body.kind);
      const switching = Boolean(current && current.providerId !== body.providerId);
      const disabling = body.enabled === false;
      let endpointChanged = false;
      if (current && String(current.endpoint || '') !== String(body.endpoint || '')) {
        try {
          endpointChanged = new URL(current.endpoint).origin !== new URL(body.endpoint).origin;
        } catch { endpointChanged = true; }
      }
      if (!switching && !disabling && !endpointChanged) return null;
      const changes = [];
      if (switching) changes.push('将 ' + providerKindLabel(body.kind) + ' 从 ' + current.providerId + ' 切换为 ' + body.providerId);
      if (endpointChanged) changes.push('服务地址来源发生变化，旧 API 密钥不会带到新来源');
      if (disabling) changes.push('保存后该能力将被停用');
      return {
        title: switching || endpointChanged ? '确认切换服务来源？' : '确认停用服务？',
        copy: changes.join('；') + '。现有客户端可能在下次启动时失去该能力。',
        phrase: body.providerId,
      };
    }

    function sceneSaveConfirmation(body) {
      const current = state.scenes.find((scene) => scene.id === body.id);
      if (!current) return null;
      const visibilityChanged = Boolean(current.enabled) !== Boolean(body.enabled);
      const planChanged = Boolean(current.isPro) !== Boolean(body.isPro);
      if (!visibilityChanged && !planChanged) return null;
      return {
        title: '确认修改场景可见范围？',
        copy: '场景“' + current.name + '”将保存为' + (body.enabled ? '可见' : '停用') + '、' + (body.isPro ? '仅 Pro' : 'Free 可用') + '。',
        phrase: current.slug,
      };
    }`
}
