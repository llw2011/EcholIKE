export function adminPanelOtaRenderScript(): string {
  return `    function renderOta() {
      const pageCount = Math.max(1, Math.ceil(state.otaReleases.length / state.otaPageSize));
      state.otaPage = Math.min(Math.max(0, state.otaPage), pageCount - 1);
      const pageStart = state.otaPage * state.otaPageSize;
      const pageReleases = state.otaReleases.slice(pageStart, pageStart + state.otaPageSize);
      const rows = pageReleases.map((r) => {
        const key = otaKey(r);
        const open = state.expandedOta.has(key);
        const detailId = 'ota-detail-' + domId(key);
        const downloadUrl = r.downloadUrl || (r.downloadUrlPreview === 'set' ? '已配置，未返回明文地址' : '未配置');
        const canWrite = hasCapability('releases:write');
        const isOwner = state.summary && state.summary.admin && state.summary.admin.role === 'owner';
        const actions = !canWrite ? '' : r.enabled
          ? '<button class="btn-secondary" type="button" data-capability="releases:write" data-ota-action="deactivate" data-ota-id="' + esc(r.id) + '">停用此版本</button>'
          : '<button class="btn-secondary" type="button" data-capability="releases:write" data-ota-action="load" data-ota-id="' + esc(r.id) + '">载入草稿</button><button class="btn-secondary" type="button" data-capability="releases:write" data-ota-action="validate" data-ota-id="' + esc(r.id) + '">验证安装包</button><button class="btn-secondary" type="button" data-capability="releases:write" data-ota-action="activate" data-ota-id="' + esc(r.id) + '">启用（非强制）</button>' + (isOwner ? '<button class="btn-danger" type="button" data-capability="releases:write" data-owner-only data-ota-action="force-activate" data-ota-id="' + esc(r.id) + '">强制启用</button>' : '');
        return '<tr class="ota-row' + (open ? ' open' : '') + '">' +
          '<td><div class="ota-version-cell"><button class="row-toggle" type="button" data-ota-toggle data-ota-key="' + esc(key) + '" aria-expanded="' + String(open) + '" aria-controls="' + esc(detailId) + '" title="' + esc(open ? '收起详情' : '展开详情') + '">' + (open ? '-' : '+') + '</button><div><strong>v' + esc(r.version) + '</strong><small>' + esc(r.platform || 'all') + ' / ' + esc(r.arch || 'all') + '</small></div></div></td>' +
          '<td>' + esc(r.channel) + '</td><td>' + (r.enabled ? '启用' : '停用') + '</td><td>' + (r.forceUpdate ? '强制' : '-') + '</td></tr>' +
          '<tr id="' + esc(detailId) + '" class="ota-detail-row"' + (open ? '' : ' hidden') + '><td colspan="4"><div class="ota-detail-panel">' +
            '<section class="ota-detail-notes"><span>更新说明</span><p>' + esc(r.releaseNotes || '未填写更新说明') + '</p></section>' +
            '<section class="ota-detail-item wide"><span>下载地址</span><code>' + esc(downloadUrl) + '</code></section>' +
            '<div class="ota-detail-grid">' +
               otaDetail('SHA256', r.sha256 || '-') +
              otaDetail('安装包字节数', r.artifactBytes || '-') +
              otaDetail('Updater signature', r.signature ? '已签名' : '未签名') +
              otaDetail('自动更新', r.autoUpdate ? '开' : '关') +
              otaDetail('最低版本', r.minVersion || '-') +
              otaDetail('发布时间', formatDate(r.publishedAt)) +
              otaDetail('创建时间', formatDate(r.createdAt)) +
            '</div>' + (actions ? '<div class="ota-detail-actions">' + actions + '</div>' : '') + '</div></td></tr>';
      }).join('');
      $('#ota-table').innerHTML = thead(['版本', '通道', '状态', '强制']) +
        '<tbody>' + (rows || '<tr><td colspan="4" class="empty-state">暂无版本记录。</td></tr>') + '</tbody>';
      const latest = state.otaReleases[0];
      $('#ota-history-meta').textContent = state.otaReleases.length + ' 个版本' + (latest ? ' · 最新 v' + latest.version : '');
      $('#ota-page-label').textContent = '第 ' + (state.otaPage + 1) + ' / ' + pageCount + ' 页';
      $('#ota-prev').disabled = state.otaPage === 0;
      $('#ota-next').disabled = state.otaPage >= pageCount - 1;
      bindOtaToggles();
      applyRoleState();
    }

    function otaKey(r) {
      return [r.id || '', r.version || '', r.channel || '', r.platform || '', r.arch || ''].join('|');
    }

    function domId(value) {
      return String(value).replace(/[^a-z0-9_-]+/gi, '-');
    }

    function otaDetail(label, value) {
      return '<section class="ota-detail-item"><span>' + esc(label) + '</span><code>' + esc(value) + '</code></section>';
    }

    function formatDate(value) {
      if (!value) return '-';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    }

    function bindOtaToggles() {
      $$('#ota-table [data-ota-toggle]').forEach((button) => {
        button.addEventListener('click', () => {
          if (blockDuringMutation($('#ota-result'))) return;
          const key = button.getAttribute('data-ota-key');
          if (!key) return;
          const focusTarget = captureFocusTarget(button);
          if (state.expandedOta.has(key)) state.expandedOta.delete(key);
          else {
            state.expandedOta.clear();
            state.expandedOta.add(key);
          }
          renderOta();
          const restored = Array.from($$('#ota-table [data-ota-toggle]')).find((item) => item.getAttribute('data-ota-key') === key);
          restoreFocusTarget(focusTarget, restored);
        });
      });
    }`
}

export function adminPanelOtaActionsScript(): string {
  return `    function otaDraftBody(form) {
      const body = formValue(form);
      body.enabled = false;
      body.forceUpdate = false;
      if (body.artifactBytes !== undefined) body.artifactBytes = Number(body.artifactBytes);
      if (body.expectedRevision !== undefined) body.expectedRevision = Number(body.expectedRevision);
      return body;
    }

    function otaNullable(value) {
      if (value === undefined || value === null || String(value).trim() === '') return null;
      return String(value).trim();
    }

    function otaDraftMatches(release, body) {
      const expectedSavedRevision = body.id
        ? (Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision + 1 : null)
        : 0;
      return release && expectedSavedRevision !== null && Number(release.revision) === expectedSavedRevision && release.enabled === false &&
        release.appName === (otaNullable(body.appName) || 'EcholIKE') &&
        release.version === String(body.version || '').trim().replace(/^v/i, '') &&
        release.channel === (otaNullable(body.channel) || 'stable') &&
        release.platform === (otaNullable(body.platform) || 'all') &&
        release.arch === (otaNullable(body.arch) || 'all') &&
        Boolean(release.autoUpdate) === false && Boolean(release.forceUpdate) === false &&
        otaNullable(release.minVersion) === otaNullable(body.minVersion) &&
        (release.artifactBytes === null ? null : Number(release.artifactBytes)) === (body.artifactBytes === undefined ? null : Number(body.artifactBytes)) &&
        otaNullable(release.downloadUrl) === otaNullable(body.downloadUrl) &&
        otaNullable(release.sha256) === otaNullable(body.sha256) &&
        otaNullable(release.signature) === otaNullable(body.signature) &&
        otaNullable(release.releaseNotes) === otaNullable(body.releaseNotes);
    }

    function findOtaDraftCandidate(body) {
      if (body.id) return state.otaReleases.find((item) => item.id === body.id) || null;
      return state.otaReleases.find((item) =>
        item.appName === (otaNullable(body.appName) || 'EcholIKE') &&
        item.version === String(body.version || '').trim().replace(/^v/i, '') &&
        item.channel === (otaNullable(body.channel) || 'stable') &&
        item.platform === (otaNullable(body.platform) || 'all') &&
        item.arch === (otaNullable(body.arch) || 'all')) || null;
    }

    function fillOtaForm(release) {
      const form = $('#ota-form');
      for (const field of ['id', 'version', 'channel', 'platform', 'arch', 'minVersion', 'sha256', 'signature', 'downloadUrl', 'releaseNotes']) {
        named(form, field).value = release[field] || '';
      }
      named(form, 'artifactBytes').value = release.artifactBytes || '';
      named(form, 'expectedRevision').value = String(release.revision);
      named(form, 'autoUpdate').value = 'false';
      named(form, 'enabled').value = 'false';
      named(form, 'forceUpdate').value = 'false';
      form.scrollIntoView({ block: 'start', behavior: 'auto' });
      show($('#ota-result'), '已载入 v' + release.version + ' 的停用草稿；修改后仍需重新验证才能启用。');
    }

    async function runOtaRecordAction(action, release, button) {
      if (!release || !hasCapability('releases:write')) return;
      if (blockDuringMutation($('#ota-result'))) return;
      if (action === 'load') {
        if (state.otaDirty && !(await confirmAction({ title: '放弃未保存的 OTA 草稿？', copy: '载入另一条草稿会覆盖当前尚未保存的输入。' }))) return;
        fillOtaForm(release);
        state.otaDirty = false;
        return;
      }
      const forceActivate = action === 'force-activate';
      const activating = action === 'activate' || forceActivate;
      if (!activating && action !== 'validate' && action !== 'deactivate') return;
      if (forceActivate && (!state.summary || state.summary.admin.role !== 'owner')) return;
      if ((activating || action === 'deactivate') && !(await confirmAction({
        title: forceActivate ? '确认强制启用此版本？' : activating ? '确认启用此版本？' : '确认停用此版本？',
        copy: '目标版本 v' + release.version + (forceActivate ? ' 将重新验证安装包并作为强制更新启用。' : activating ? ' 将重新验证安装包后以非强制策略启用。' : ' 停用后将不再下发给客户端。'),
        phrase: String(release.version || ''),
      }))) return;
      const endpointAction = forceActivate ? 'activate' : action;
      const previousRevision = Number(release.revision);
      if (!Number.isSafeInteger(previousRevision)) { showErr($('#ota-result'), new Error('当前版本 revision 无效，请刷新列表后再操作')); return; }
      const key = 'ota-write';
      if (state.mutationLocks.has(key)) { show($('#ota-result'), '另一项版本写操作正在执行，请等待结果确认。'); return; }
      const actionFocusTarget = captureFocusTarget(button);
      state.mutationLocks.add(key);
      const result = $('#ota-result');
      const originalText = button ? button.textContent : '';
      const pending = action === 'validate' ? '正在重新验证安装包…' : forceActivate ? '正在验证并强制启用…' : activating ? '正在验证并启用…' : '正在停用版本…';
      if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = pending; }
      show(result, pending);
      try {
        let response;
        let recovered = false;
        try {
          response = await api('/admin/ota-releases/' + endpointAction, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(activating
              ? { id: release.id, expectedRevision: previousRevision, forceUpdate: forceActivate }
              : { id: release.id, expectedRevision: previousRevision }),
          });
        } catch (error) {
          const uncertain = error && (error.status === 0 || error.code === 'response_incomplete');
          if (!uncertain) throw error;
          state.otaPage = 0;
          state.expandedOta.clear();
          const refreshed = await loadReleases();
          const current = refreshed ? state.otaReleases.find((item) => item.id === release.id) : null;
          const reachedTarget = otaActionReachedTarget(action, current, previousRevision, forceActivate);
          if (!reachedTarget) {
            const stateUnknown = new Error(refreshed
              ? '写入响应未完整到达；已重新读取版本状态，但 revision 与目标状态不能证明是本次操作。请先核对当前记录，不要直接重试。'
              : '写入响应未完整到达，且版本列表刷新失败；请先手动刷新版本列表，再决定是否重试。');
            stateUnknown.code = 'response_incomplete';
            throw stateUnknown;
          }
          response = { release: current };
          recovered = true;
        }

        state.otaPage = 0;
        state.expandedOta.clear();
        const successMessage = action === 'validate'
          ? 'v' + release.version + ' 验证通过，仍保持停用。'
          : forceActivate
            ? 'v' + release.version + ' 已强制启用。'
            : activating
              ? 'v' + release.version + ' 已启用。'
              : 'v' + release.version + ' 已停用。';
        show(result, successMessage + (recovered ? ' 已通过重新读取服务器状态确认结果。' : ''));
        if (!recovered) {
          const refreshed = await loadReleases();
          if (!refreshed) show(result, successMessage + ' 后续列表刷新失败；写入结果已经确认，请手动刷新版本列表。');
        }
      } catch (error) {
        showErr(result, error);
      } finally {
        state.mutationLocks.delete(key);
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = originalText; }
        applyRoleState();
        const fallback = Array.from($$('#ota-table [data-ota-toggle]')).find((item) => item.getAttribute('data-ota-key') === otaKey(release));
        restoreFocusTarget(actionFocusTarget, fallback);
      }
    }

    function otaActionReachedTarget(action, current, previousRevision, forceActivate) {
      if (!current || Number(current.revision) !== previousRevision + 1) return false;
      if (action === 'validate') return current.enabled === false && Boolean(current.forceUpdate) === false;
      if (action === 'activate' || action === 'force-activate') return current.enabled === true && Boolean(current.forceUpdate) === forceActivate;
      return action === 'deactivate' && current.enabled === false && Boolean(current.forceUpdate) === false;
    }`
}
