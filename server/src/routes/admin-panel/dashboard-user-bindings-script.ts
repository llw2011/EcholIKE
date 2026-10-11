export function adminPanelUserBindingsScript(): string {
  return `    // ===== 用户列表与任务 =====
    $('#user-search-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.usersLoading) return;
      const query = named(event.currentTarget, 'q').value.trim();
      await navigateUsers(() => {
        state.userQuery = query;
        state.userCursor = null;
        state.userNextCursor = null;
        state.userCursorStack = [];
      });
    });

    $('#user-search-clear').addEventListener('click', async () => {
      if (state.usersLoading) return;
      named($('#user-search-form'), 'q').value = '';
      await navigateUsers(() => {
        state.userQuery = '';
        state.userCursor = null;
        state.userNextCursor = null;
        state.userCursorStack = [];
      });
    });

    $('#users-next').addEventListener('click', async () => {
      if (!state.userNextCursor || state.usersLoading) return;
      const nextCursor = state.userNextCursor;
      await navigateUsers(() => {
        state.userCursorStack.push(state.userCursor);
        state.userCursor = nextCursor;
        state.userNextCursor = null;
      });
    });

    $('#users-prev').addEventListener('click', async () => {
      if (!state.userCursorStack.length || state.usersLoading) return;
      await navigateUsers(() => {
        state.userCursor = state.userCursorStack.pop() || null;
        state.userNextCursor = null;
      });
    });

    $('#users-table').addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest('[data-user-id]') : null;
      if (row) selectUser(row.getAttribute('data-user-id'), row);
    });
    $('#users-cards').addEventListener('click', (event) => {
      const card = event.target instanceof Element ? event.target.closest('[data-user-id]') : null;
      if (card) selectUser(card.getAttribute('data-user-id'), card);
    });
    $('#selected-user-clear').addEventListener('click', async () => {
      if (blockDuringMutation($('#user-list-summary'))) return;
      if (hasPendingQuotaOperation()) { showPendingQuotaBlock('请先恢复并核对当前未确认的配额调整，不能清除目标用户。', $('#user-list-summary')); return; }
      if (state.userFormDirty && !(await confirmAction({ title: '放弃未保存的用户操作？', copy: '清除当前用户会丢弃尚未提交的表单内容。' }))) return;
      clearSelectedUser();
    });
    $$('[data-user-task]').forEach((button) => button.addEventListener('click', () => { switchUserTask(button.dataset.userTask, button); }));
    ['#create-user-form', '#quota-level-form', '#admin-form', '#quota-form', '#reset-password-form'].forEach((selector) => {
      $(selector).addEventListener('input', () => { state.userFormDirty = true; });
      $(selector).addEventListener('change', () => { state.userFormDirty = true; });
    });

    $('#create-user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      if (!button || button.disabled) return;
      const body = formValue(form);
      await runMutation({
        key: 'user-create', form, button, result: $('#create-user-result'), pending: '正在创建用户…',
        write: () => api('/admin/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        success: (response) => '用户 ' + (response.user && response.user.email || body.email) + ' 已创建，可以继续设置额度或角色。',
        afterWrite: (response) => {
          form.reset();
          state.userFormDirty = false;
          if (response.user) { state.selectedUserId = response.user.id; state.selectedUser = response.user; state.selectedFormsUserId = null; }
          state.userQuery = ''; state.userCursor = null; state.userNextCursor = null; state.userCursorStack = [];
        },
        refresh: loadUsersPage,
      });
    });

    $('#change-password-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = $('#change-password-result');
      const button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      try {
        const newPassword = matchingPassword(form, 'newPassword');
        const body = {
          currentPassword: named(form, 'currentPassword').value,
          newPassword,
          revokeOtherSessions: true,
        };
        await runMutation({
          key: 'own-password', form, button, result, pending: '正在修改密码…',
          write: () => changeOwnPassword(body),
          success: () => '密码已修改，其他设备上的登录已注销。',
          afterWrite: () => form.reset(),
        });
      } catch (error) { showErr(result, error); }
    });

    $('#reset-password-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const result = $('#reset-password-result');
      const button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      try {
        const target = state.selectedUser;
        if (!target) throw new Error('请先从用户列表选择要重置密码的用户');
        const body = { userId: target.id, password: matchingPassword(form, 'password') };
        if (!(await confirmAction({ title: '确认重置用户密码？', copy: '将重置 ' + target.email + ' 的密码，并立即注销该用户全部会话。', phrase: target.email }))) return;
        await runMutation({
          key: 'user-password-reset', form, button, result, pending: '正在重置密码…',
          write: () => api('/admin/user-passwords', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          success: () => target.email + ' 的密码已重置，全部登录会话已注销。',
          afterWrite: () => { state.userFormDirty = false; if (state.selectedUserId === target.id) { form.reset(); named(form, 'userId').value = target.id; } },
        });
      } catch (error) { showErr(result, error); }
    });

    $('#admin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = e.currentTarget.querySelector('button[type="submit"]');
      if (button.disabled) return;
      const form = e.currentTarget;
      const target = state.selectedUser;
      if (!target) { showErr($('#admin-result'), new Error('请先选择用户')); return; }
      const body = formValue(form);
      body.userId = target.id;
      const highRisk = body.role === 'owner' || body.status === 'disabled' || target.adminRole === 'owner';
      if (!(await confirmAction({
        title: '确认修改管理员权限？',
        copy: target.email + '：' + (target.adminRole || '无后台角色') + '/' + (target.adminStatus || 'active') + ' → ' + body.role + '/' + body.status + '。',
        phrase: highRisk ? target.email : '',
      }))) return;
      await runMutation({
        key: 'admin-account-save', form, button, result: $('#admin-result'), pending: '正在保存管理员权限…',
        write: () => api('/admin/admin-accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        success: () => target.email + ' 的管理员权限已保存。',
        afterWrite: () => { state.userFormDirty = false; state.selectedFormsUserId = null; },
        refresh: loadUsersPage,
      });
    });

    named($('#quota-level-form'), 'quotaLevel').addEventListener('change', syncQuotaLevelPreview);
    $('#quota-level-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = e.currentTarget.querySelector('button[type="submit"]');
      if (button.disabled) return;
      const form = e.currentTarget;
      const target = state.selectedUser;
      if (!target) { showErr($('#quota-level-result'), new Error('请先选择用户')); return; }
      const body = formValue(form);
      body.userId = target.id;
      body.quotaLevel = Number(body.quotaLevel);
      if (!(await confirmAction({ title: '确认调整额度等级？', copy: target.email + '：Lv.' + (target.quotaLevel || 1) + ' → Lv.' + body.quotaLevel + '。套餐权限不会改变。' }))) return;
      await runMutation({
        key: 'quota-level-save', form, button, result: $('#quota-level-result'), pending: '正在保存额度等级…',
        write: () => api('/admin/user-quota-levels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        success: () => target.email + ' 的额度等级已保存为 Lv.' + body.quotaLevel + '。',
        afterWrite: () => { state.userFormDirty = false; state.selectedFormsUserId = null; },
        refresh: loadUsersPage,
      });
    });

    $('#quota-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const button = f.querySelector('button[type="submit"]');
      if (button.disabled) return;
      const target = state.selectedUser;
      if (!target) { showErr($('#quota-result'), new Error('请先选择用户')); return; }
      if (!named(f, 'periodKey').value) named(f, 'periodKey').value = currentPeriodKey();
      const body = formValue(f);
      body.userId = target.id;
      body.amount = Number(body.amount);
      body.reason = String(body.reason || '').trim();
      if (!body.reason) { showErr($('#quota-result'), new Error('请填写本次调整的原因或工单说明')); return; }
      const unresolvedOperation = readPendingQuotaOperation();
      if (unresolvedOperation && unresolvedOperation.identity !== quotaOperationIdentity(body)) {
        showErr($('#quota-result'), new Error('已有一笔配额调整的响应尚未确认；请恢复原用户、账期与内容后重试核对，不能开始另一笔调整。'));
        return;
      }
      const projection = quotaProjection(target, body);
      if (!(await confirmAction({
        title: body.mode === 'raw' ? '确认直接写入额度账本？' : '确认调整用户额度？',
        copy: '目标：' + target.email + '；账期：' + body.periodKey + '；类型：' + projection.label + '；方向：' + projection.direction + '；数量：' + body.amount + '；预计已用：' + projection.before + ' → ' + projection.after + '。原因：' + body.reason,
        phrase: body.mode === 'raw' ? target.email : '',
      }))) return;
      try {
        await withQuotaOperationLock(async () => {
          const operation = quotaOperationFor(body);
          await runMutation({
            key: 'quota-adjustment', form: f, button, result: $('#quota-result'), pending: '正在提交配额调整…',
            write: async () => {
              try {
                return await api('/admin/quota-adjustments', { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': operation.key }, body: JSON.stringify(body) });
              } catch (error) {
                const safelyRejected = error && !operation.uncertain && [400, 404, 405, 413, 415, 422].includes(error.status);
                if (safelyRejected) clearPendingQuotaOperation(operation.key);
                else if (error && (error.status === 0 || error.status >= 500)) {
                  markPendingQuotaUncertain(operation.key);
                  error.message = '本次配额调整的响应未完整到达，但操作身份已保留；不要修改表单，再次提交会核对同一笔结果。';
                } else if (error && (error.status === 401 || error.status === 403 || error.status === 409 || error.status === 428 || error.status === 429)) {
                  error.message = '当前请求未能安全确认，原操作身份仍已保留；请恢复原管理员账号和权限后重试核对。';
                }
                throw error;
              }
            },
            success: (response) => target.email + ' 的配额调整已成功' + (response.replayed ? '（已恢复此前结果）' : '') + '；已用 ' + response.usageBefore + ' → ' + response.usageAfter + '。',
            afterWrite: () => {
              if (!clearPendingQuotaOperation(operation.key)) throw new Error('pending quota acknowledgement could not be persisted');
              state.userFormDirty = false;
              state.selectedFormsUserId = null;
              if (state.selectedUserId === target.id) named(f, 'reason').value = '';
            },
            refresh: loadUsersPage,
          });
        });
      } catch (error) {
        showErr($('#quota-result'), error);
      }
    });`
}
