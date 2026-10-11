export function adminPanelUsersScript(): string {
  return `    function renderUsers() {
      const rows = state.users.map((user) => {
        const selected = user.id === state.selectedUserId;
        return '<tr class="user-row' + (selected ? ' selected' : '') + '" data-user-id="' + esc(user.id) + '"><td><button class="row-select" type="button" data-user-id="' + esc(user.id) + '" aria-pressed="' + String(selected) + '"><strong>' + esc(user.email) + '</strong><small>' + esc(user.name || '未设置昵称') + '</small><small>' + esc(user.id) + '</small></button></td><td><strong>' + esc(user.adminRole || '-') + '</strong><small>' + esc(subscriptionLabel(user)) + '</small></td><td>' + quotaLevelCell(user) + userQuotaSummary(user) + '</td></tr>';
      }).join('');
      const emptyRow = '<tr><td colspan="3" class="empty-state">' + (state.usersLoading ? '正在加载用户…' : '没有找到符合条件的用户。') + '</td></tr>';
      $('#users-table').innerHTML = '<caption class="sr-only">用户、角色、订阅、等级、语音 已用 / 剩余、润色 已用 / 剩余、OCR 已用 / 剩余、朗读 已用 / 剩余</caption>' + thead(['用户', '权限与套餐', '额度摘要']) + '<tbody>' + (rows || emptyRow) + '</tbody>';
      $('#users-cards').innerHTML = state.users.length ? state.users.map(userCard).join('') : '<p class="empty-state">' + (state.usersLoading ? '正在加载用户…' : '没有找到符合条件的用户。') + '</p>';
      renderSelectedUser();
      renderUserPagination();
    }

    function userCard(user) {
      const selected = user.id === state.selectedUserId;
      return '<button class="user-card' + (selected ? ' selected' : '') + '" type="button" data-user-id="' + esc(user.id) + '" aria-pressed="' + String(selected) + '"><span class="user-card-head"><span><strong>' + esc(user.email) + '</strong><small>' + esc(user.name || '未设置昵称') + '</small></span><span class="level-badge">Lv.' + esc(user.quotaLevel || 1) + '</span></span><small class="user-card-id">' + esc(user.id) + '</small><span class="user-card-meta"><span>角色 <strong>' + esc(user.adminRole || '-') + '</strong></span><span>订阅 <strong>' + esc(subscriptionLabel(user)) + '</strong></span></span><span class="user-card-quotas"><span>语音 <strong>' + quotaValues(user, 'sttSecondsUsed', 'sttSecondsLimit') + '</strong></span><span>润色 <strong>' + quotaValues(user, 'llmTokensUsed', 'llmTokensLimit') + '</strong></span><span>OCR <strong>' + quotaValues(user, 'ocrImagesUsed', 'ocrImagesLimit') + '</strong></span><span>朗读 <strong>' + quotaValues(user, 'ttsCharsUsed', 'ttsCharsLimit') + '</strong></span></span></button>';
    }

    function userQuotaSummary(user) {
      return '<span class="quota-summary"><small>语音 ' + quotaValues(user, 'sttSecondsUsed', 'sttSecondsLimit') + '</small><small>润色 ' + quotaValues(user, 'llmTokensUsed', 'llmTokensLimit') + '</small><small>OCR ' + quotaValues(user, 'ocrImagesUsed', 'ocrImagesLimit') + '</small><small>朗读 ' + quotaValues(user, 'ttsCharsUsed', 'ttsCharsLimit') + '</small></span>';
    }

    function quotaValues(user, usedKey, limitKey) {
      const used = Number(user[usedKey] || 0);
      const remaining = Math.max(0, quotaLimit(user, limitKey) - used);
      return esc(used) + ' / ' + esc(remaining);
    }

    function renderUserPagination() {
      const page = state.userCursorStack.length + 1;
      const summary = state.usersLoading
        ? '正在加载用户…'
        : state.userQuery
          ? '找到 ' + state.userTotal + ' 位匹配用户，本页显示 ' + state.users.length + ' 位。'
          : '共 ' + state.userTotal + ' 位用户，本页显示 ' + state.users.length + ' 位。';
      $('#user-list-summary').textContent = summary;
      $('#users-page-label').textContent = '第 ' + page + ' 页';
      $('#users-prev').disabled = state.usersLoading || state.userCursorStack.length === 0;
      $('#users-next').disabled = state.usersLoading || !state.userNextCursor;
      $('#user-search-submit').disabled = state.usersLoading;
      $('#user-search-clear').disabled = state.usersLoading;
      $('#user-search').value = state.userQuery;
    }

    async function selectUser(userId, origin) {
      if (blockDuringMutation($('#user-list-summary'))) return;
      if (state.usersLoading) { show($('#user-list-summary'), '用户列表仍在刷新，请等待当前页面稳定后再选择。'); return; }
      const user = state.users.find((item) => item.id === userId);
      if (!user) return;
      if (user.id === state.selectedUserId) { openTaskPanel('user-detail', origin); return; }
      const pending = readPendingQuotaOperation();
      if ((pending && pending.body && pending.body.userId !== user.id) || (!pending && state.pendingQuotaStorageCorrupt)) {
        showPendingQuotaBlock('只能恢复未确认配额调整的原目标用户，不能切换到其他用户。', $('#user-list-summary'));
        return;
      }
      if (state.userFormDirty && !(await confirmAction({ title: '放弃未保存的用户操作？', copy: '切换用户会覆盖当前尚未提交的表单内容。' }))) return;
      if (state.userFormDirty && !discardUserEdits()) return;
      state.selectedUserId = user.id;
      state.selectedUser = user;
      state.selectedFormsUserId = null;
      clearUserOperationResults();
      renderUsers();
      applyRoleState();
      const restoredOrigin = Array.from($$('button[data-user-id]')).find((item) => item.dataset.userId === user.id && item.getClientRects().length > 0);
      setUserTask(pending ? 'quota' : 'quota-level', restoredOrigin || origin);
      loadUserSessions(user.id);
    }

    function clearSelectedUser(shouldRender = true) {
      state.selectedUserId = null;
      state.selectedUser = null;
      state.selectedFormsUserId = null;
      state.userTask = 'empty';
      state.requestEpoch.sessions += 1;
      state.userSessions = [];
      state.userSessionsForId = null;
      $('#create-user-form').reset();
      resetUserTaskForms(null);
      clearUserOperationResults();
      if (shouldRender) {
        renderUsers();
        setUserTask('empty');
        applyRoleState();
      }
    }

    function setUserTask(task, origin) {
      const requiresUser = ['quota-level', 'admin', 'quota', 'reset-password'].includes(task);
      if (requiresUser && !state.selectedUser) return;
      const taskButton = Array.from($$('[data-user-task]')).find((button) => button.dataset.userTask === task && button.dataset.taskCapability);
      if (taskButton && !hasCapability(taskButton.dataset.taskCapability)) return;
      state.userTask = task;
      const titles = { empty: '请选择用户或任务', create: '新建用户', 'own-password': '修改我的密码', 'quota-level': '额度等级', admin: '管理员角色', quota: '调整配额', 'reset-password': '重置用户密码' };
      $('#user-detail-title').textContent = requiresUser && state.selectedUser ? titles[task] + ' · ' + state.selectedUser.email : titles[task];
      $$('.task-view').forEach((view) => { view.hidden = view.dataset.userTaskView !== task; });
      $$('#user-task-nav [data-user-task]').forEach((button) => { button.classList.toggle('is-active', button.dataset.userTask === task); });
      $('#user-task-nav').hidden = !state.selectedUser;
      openTaskPanel('user-detail', origin);
    }

    function clearUserOperationResults() {
      ['#create-user-result', '#quota-level-result', '#admin-result', '#quota-result', '#reset-password-result'].forEach((selector) => show($(selector), ''));
    }

    function discardUserEdits() {
      if (hasPendingQuotaOperation()) {
        showPendingQuotaBlock('仍有一笔配额调整的响应尚未确认；请保持原表单重试核对，不能直接放弃操作身份。');
        return false;
      }
      $('#create-user-form').reset();
      clearUserOperationResults();
      resetUserTaskForms(state.selectedUser);
      renderSelectedUser();
      applyRoleState();
      return true;
    }

    function resetUserTaskForms(user) {
      const forms = ['#quota-level-form', '#admin-form', '#quota-form', '#reset-password-form'].map((selector) => $(selector));
      forms.forEach((form) => form.reset());
      forms.forEach((form) => { named(form, 'userId').value = user ? user.id : ''; });
      if (user) {
        named($('#quota-level-form'), 'quotaLevel').value = String(user.quotaLevel || 1);
        named($('#admin-form'), 'role').value = user.adminRole || 'viewer';
        named($('#admin-form'), 'status').value = user.adminStatus || 'active';
        restorePendingQuotaForm(user);
      }
      state.selectedFormsUserId = user ? user.id : null;
      state.userFormDirty = false;
      syncQuotaLevelPreview();
    }

    function renderSelectedUser() {
      const user = state.selectedUser;
      $('#selected-user-email').textContent = user ? user.email : '请先从上方列表选择用户';
      $('#selected-user-id').textContent = user ? (user.name ? user.name + ' · ' : '') + user.id : '选择后可设置额度、角色、配额或重置密码。';
      $('#selected-user-clear').disabled = !user;
      $('#selected-user').hidden = !user && (state.userTask === 'create' || state.userTask === 'own-password');
      const selectedSelf = Boolean(user && user.id === state.summary?.admin?.userId);
      $('#reset-password-hint').textContent = selectedSelf
        ? '当前账号请在上方修改自己的密码。'
        : '重置后，该用户全部登录会话失效。';
      ['#quota-level-form', '#admin-form', '#quota-form', '#reset-password-form'].forEach((selector) => {
        named($(selector), 'userId').value = user ? user.id : '';
      });

      if (state.selectedFormsUserId !== (user && user.id)) {
        resetUserTaskForms(user);
      }
      syncQuotaLevelPreview();
      renderUserSessions();
    }

    function subscriptionLabel(user) {
      return (effectivePlan(user) || 'free') + (user.subscriptionStatus ? '/' + user.subscriptionStatus : '');
    }

    function effectivePlan(user) {
      const end = user.subscriptionEnd ? Date.parse(user.subscriptionEnd) : null;
      const active = user.plan === 'pro' && (user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing') && (!end || end > Date.now());
      return active ? 'pro' : 'free';
    }

    function quotaCell(user, usedKey, limitKey) {
      const used = Number(user[usedKey] || 0);
      const limit = quotaLimit(user, limitKey);
      const remaining = limit - used;
      const displayRemaining = remaining >= 0 ? remaining : 0;
      return '<span class="quota-number" title="账本已用：' + esc(used) + '，周期上限：' + esc(limit) + '，等级倍率：' + esc(quotaMultiplier(user)) + 'x">' + esc(used) + ' / ' + esc(displayRemaining) + '</span>';
    }

    function quotaLimit(user, limitKey) {
      const explicit = Number(user[limitKey] || 0);
      if (explicit > 0) return explicit;
      const baseLimit = Number((state.planLimits[effectivePlan(user)] || {})[limitKey] || 0);
      return baseLimit * quotaMultiplier(user);
    }

    function quotaMultiplier(user) {
      const multiplier = Number(user.quotaMultiplier || user.quotaLevel || 1);
      return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    }

    function quotaLevelCell(user) {
      const level = Number(user.quotaLevel || 1);
      return '<span class="level-badge">Lv.' + esc(level) + '</span><small>' + esc(quotaMultiplier(user)) + 'x 月额度</small>';
    }

    function quotaLevelOptions() {
      return state.quotaLevels.length ? state.quotaLevels : [1, 2, 3, 4, 5].map((level) => ({ quotaLevel: level, quotaMultiplier: level, label: 'Lv.' + level }));
    }

    function fillQuotaLevelPick() {
      const form = $('#quota-level-form');
      if (!form) return;
      const select = named(form, 'quotaLevel');
      const current = select.value;
      select.innerHTML = quotaLevelOptions().map((item) => '<option value="' + esc(item.quotaLevel) + '">' + esc(item.label) + ' · ' + esc(item.quotaMultiplier) + 'x</option>').join('');
      if (current) select.value = current;
      syncQuotaLevelPreview();
    }

    function syncQuotaLevelPreview() {
      const form = $('#quota-level-form');
      const preview = $('#quota-level-preview');
      if (!form || !preview) return;
      const option = quotaLevelOptions().find((item) => String(item.quotaLevel) === String(named(form, 'quotaLevel').value));
      preview.textContent = option ? option.label + ' · ' + option.quotaMultiplier + 'x 月额度' : '-';
    }`
}
