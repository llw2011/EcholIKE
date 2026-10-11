export function adminPanelQuotaScript(): string {
  return `    function quotaOperationIdentity(body) {
      return JSON.stringify({
        actorUserId: state.summary && state.summary.admin && state.summary.admin.userId,
        userId: body.userId,
        periodKey: body.periodKey,
        kind: body.kind,
        mode: body.mode,
        amount: body.amount,
        reason: body.reason,
      });
    }

    function currentAdminUserId() {
      return pageActorUserId;
    }

    function quotaPendingStorageKey(actorUserId = currentAdminUserId()) {
      return actorUserId ? quotaPendingStoragePrefix + encodeURIComponent(actorUserId) : null;
    }

    function readPendingQuotaOperation() {
      const actorUserId = currentAdminUserId();
      if (!actorUserId) return null;
      state.pendingQuotaOperation = null;
      const storageKey = quotaPendingStorageKey(actorUserId);
      let raw = null;
      try {
        raw = storageKey && localStorage.getItem(storageKey);
        state.quotaStorageUnavailable = false;
      } catch {
        state.quotaStorageUnavailable = true;
        return null;
      }
      if (!raw) { state.pendingQuotaStorageCorrupt = false; return null; }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.schema === 3 && parsed.apiBasePath === base && parsed.actorUserId === actorUserId && typeof parsed.key === 'string' && typeof parsed.identity === 'string' && parsed.body && typeof parsed.body === 'object') {
          state.pendingQuotaOperation = parsed;
          state.pendingQuotaStorageCorrupt = false;
        } else {
          state.pendingQuotaStorageCorrupt = true;
        }
      } catch {
        state.pendingQuotaStorageCorrupt = true;
      }
      return state.pendingQuotaOperation;
    }

    function quotaOperationFor(body) {
      const identity = quotaOperationIdentity(body);
      const pending = readPendingQuotaOperation();
      if (pending && pending.identity === identity) return pending;
      if (pending) throw new Error('已有一笔配额调整的响应尚未确认；请恢复原用户、账期与内容后重试核对，不能开始另一笔调整。');
      if (state.pendingQuotaStorageCorrupt) throw new Error('本会话中有无法解析的未确认配额操作；请停止调账并由维护人员核对，不能覆盖原操作身份。');
      if (state.quotaStorageUnavailable) throw new Error('浏览器无法安全保存配额操作身份，本次未提交；请恢复会话存储后重试。');
      const actorUserId = currentAdminUserId();
      if (!actorUserId) throw new Error('当前管理员身份尚未确认，请刷新后重试');
      const operation = { schema: 3, apiBasePath: base, key: crypto.randomUUID(), identity, actorUserId, uncertain: false, body: { ...body } };
      const storageKey = quotaPendingStorageKey(actorUserId);
      const serialized = JSON.stringify(operation);
      try {
        if (!storageKey) throw new Error('missing storage key');
        localStorage.setItem(storageKey, serialized);
        if (localStorage.getItem(storageKey) !== serialized) throw new Error('storage verification failed');
      } catch {
        state.quotaStorageUnavailable = true;
        throw new Error('浏览器无法安全保存配额操作身份，本次未提交；请恢复会话存储后重试。');
      }
      state.pendingQuotaOperation = operation;
      state.pendingQuotaStorageCorrupt = false;
      state.quotaStorageUnavailable = false;
      return operation;
    }

    function clearPendingQuotaOperation(key) {
      const pending = readPendingQuotaOperation();
      if (!pending || pending.key !== key) return false;
      const storageKey = quotaPendingStorageKey(pending.actorUserId);
      try {
        if (!storageKey) return false;
        localStorage.removeItem(storageKey);
        if (localStorage.getItem(storageKey) !== null) return false;
      } catch { return false; }
      state.pendingQuotaOperation = null;
      state.pendingQuotaStorageCorrupt = false;
      state.quotaStorageUnavailable = false;
      return true;
    }

    function markPendingQuotaUncertain(key) {
      const pending = readPendingQuotaOperation();
      if (!pending || pending.key !== key) return false;
      const storageKey = quotaPendingStorageKey(pending.actorUserId);
      const next = { ...pending, uncertain: true };
      const serialized = JSON.stringify(next);
      try {
        if (!storageKey) return false;
        localStorage.setItem(storageKey, serialized);
        if (localStorage.getItem(storageKey) !== serialized) return false;
      } catch { return false; }
      state.pendingQuotaOperation = next;
      return true;
    }

    async function withQuotaOperationLock(operation) {
      const storageKey = quotaPendingStorageKey();
      if (!storageKey || !navigator.locks || typeof navigator.locks.request !== 'function') {
        throw new Error('当前浏览器无法提供跨窗口调账锁，本次未提交；请使用受支持的浏览器后重试。');
      }
      return await navigator.locks.request(storageKey, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('另一个管理台窗口正在处理配额调整；本次未提交，请等待该窗口完成后再核对。');
        return await operation();
      });
    }

    function restorePendingQuotaForm(user) {
      const form = $('#quota-form');
      const pending = readPendingQuotaOperation();
      const actorUserId = currentAdminUserId();
      if (pending && pending.body && pending.body.userId === user.id && pending.actorUserId === actorUserId) {
        for (const field of ['periodKey', 'mode', 'kind', 'amount', 'reason']) {
          if (pending.body[field] !== undefined) named(form, field).value = String(pending.body[field]);
        }
        show($('#quota-result'), '发现一笔响应尚未确认的调整；保持原账期与内容后再次提交，将复用同一操作身份。');
        return;
      }
      named(form, 'periodKey').value = currentPeriodKey();
    }

    function quotaProjection(user, body) {
      const fields = { stt_seconds: 'sttSecondsUsed', llm_tokens: 'llmTokensUsed', ocr_images: 'ocrImagesUsed', tts_chars: 'ttsCharsUsed' };
      const labels = { stt_seconds: '语音秒数', llm_tokens: '润色 tokens', ocr_images: 'OCR 张数', tts_chars: '朗读字符' };
      const before = Number(user[fields[body.kind]] || 0);
      const magnitude = Math.abs(Number(body.amount));
      const delta = body.mode === 'grant' ? -magnitude : body.mode === 'consume' ? magnitude : Number(body.amount);
      const direction = body.mode === 'grant' ? '增加可用额度' : body.mode === 'consume' ? '扣减可用额度' : '直接账本修正';
      return { before, after: before + delta, label: labels[body.kind] || body.kind, direction };
    }`
}
