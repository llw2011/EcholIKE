export function adminPanelCoreScript(input: { providerPresets: string }): string {
  return `    const state = {
      activeView: 'overview',
      summary: null,
      operationsOverview: null,
      system: null,
      proxy: null,
      desktopPolicy: null,
      users: [],
      userTotal: 0,
      userLimit: 25,
      userQuery: '',
      userCursor: null,
      userNextCursor: null,
      userCursorStack: [],
      usersLoading: false,
      selectedUserId: null,
      selectedUser: null,
      selectedFormsUserId: null,
      planLimits: {},
      quotaLevels: [],
      scenes: [],
      selectedSceneId: null,
      providers: [],
      otaReleases: [],
      otaPage: 0,
      otaPageSize: 5,
      expandedOta: new Set(),
      usageOverview: null,
      usageOverviewContext: null,
      usageItems: [],
      usageItemsContext: null,
      usageCursor: null,
      usageNextCursor: null,
      usageCursorStack: [],
      usageFilters: { periodKey: '', kind: '', status: '', userId: '' },
      usageAccount: null,
      usageAccountSelectionExplicit: false,
      usageAccountOpen: false,
      usageAccountQuery: '',
      usageAccountItems: [],
      usageAccountCursor: null,
      usageAccountNextCursor: null,
      usageAccountsLoading: false,
      usageAccountError: '',
      auditItems: [],
      auditCursor: null,
      auditNextCursor: null,
      auditCursorStack: [],
      auditFilters: { q: '', userId: '', minimumStatus: '' },
      userSessions: [],
      userSessionsForId: null,
      pendingQuotaOperation: null,
      pendingQuotaStorageCorrupt: false,
      quotaStorageUnavailable: false,
      actorMismatch: false,
      selectedProviderKind: 'llm',
      userTask: 'empty',
      sceneDirty: false,
      otaDirty: false,
      providerDirty: false,
      providerSelection: '',
      providerCapabilities: {},
      providerModelRequestEpoch: 0,
      userFormDirty: false,
      panelOrigin: null,
      requestEpoch: { overview: 0, user: 0, usage: 0, usageAccounts: 0, provider: 0, scene: 0, publish: 0, audit: 0, system: 0, sessions: 0 },
      resources: {
        overview: { status: 'idle', hasData: false },
        user: { status: 'idle', hasData: false },
        usage: { status: 'idle', hasData: false },
        provider: { status: 'idle', hasData: false },
        scene: { status: 'idle', hasData: false },
        publish: { status: 'idle', hasData: false },
        audit: { status: 'idle', hasData: false },
        system: { status: 'idle', hasData: false },
      },
      mutationLocks: new Set(),
    };
    const providerPresets = ${input.providerPresets};
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    const base = window.__ECHO_PANEL__.apiBasePath;
    const pageActorUserId = window.__ECHO_PANEL__.actorUserId || '';
    const adminActorHeader = window.__ECHO_PANEL__.adminActorHeader;
    const mobileQuery = window.matchMedia('(max-width: 760px)');
    const quotaPendingStoragePrefix = 'echolike.admin.quota.pending.v3.' + encodeURIComponent(base) + '.';
    const modalIsolation = new Map();
    try { localStorage.removeItem('echoPanelToken'); } catch {}

    async function api(path, options = {}) {
      let res;
      try {
        const headers = new Headers(options.headers || {});
        if (pageActorUserId) headers.set(adminActorHeader, pageActorUserId);
        res = await fetch(base + path, { credentials: 'include', ...options, headers });
      } catch {
        const error = new Error('网络连接失败，请检查网络后重试。');
        error.status = 0;
        throw error;
      }
      let body = {};
      try {
        const text = await res.text();
        if (text) body = JSON.parse(text);
        else if (res.ok) throw new Error('empty response');
      } catch {
        if (res.ok) {
          const error = new Error('服务器响应未完整到达；若这是写操作，请先刷新对应模块核对服务器状态，不要直接重复提交。');
          error.status = 0;
          error.code = 'response_incomplete';
          throw error;
        }
      }
      if (res.status === 401) {
        window.location.href = '/echo-panel/login';
        const error = new Error('登录已失效，请重新登录。');
        error.status = 401;
        throw error;
      }
      if (!res.ok) {
        const error = new Error(body.error || body.message || (res.status === 403 ? '权限不足' : '请求失败 ' + res.status));
        error.status = res.status;
        error.code = body.code || '';
        if (error.code === 'admin_actor_changed') markActorMismatch();
        throw error;
      }
      const responseActorUserId = body && body.admin && body.admin.userId;
      if (responseActorUserId && pageActorUserId && responseActorUserId !== pageActorUserId) {
        markActorMismatch();
        const error = new Error('管理台登录账号已在其他窗口切换；请重新加载当前页面。');
        error.status = 409;
        error.code = 'admin_actor_changed';
        throw error;
      }
      return body;
    }

    async function changeOwnPassword(body) {
      const res = await fetch(base + '/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', [adminActorHeader]: pageActorUserId },
        body: JSON.stringify(body),
      });
      if (res.status === 401) { window.location.href = '/echo-panel/login'; throw new Error('当前密码不正确或登录已失效'); }
      const response = await res.json().catch(() => ({}));
      if (res.status === 409 && response.code === 'admin_actor_changed') {
        markActorMismatch();
        throw new Error(response.error || '管理台登录账号已切换，请重新加载后再修改密码');
      }
      if (res.status === 403) throw new Error(response.message || '当前账号不能修改密码');
      if (!res.ok) {
        const code = String(response.code || '').toUpperCase();
        if (code === 'INVALID_PASSWORD') throw new Error('当前密码不正确，请重新输入');
        if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') throw new Error('新密码长度需要在 8 到 128 个字符之间');
        if (code === 'CREDENTIAL_ACCOUNT_NOT_FOUND') throw new Error('当前账号没有可修改的密码登录方式');
        if (res.status === 429) throw new Error('操作过于频繁，请稍后再试');
        throw new Error('密码修改失败，请确认当前密码后重试');
      }
      return response;
    }

    async function publicApi(path) {
      const res = await fetch(base + path, { credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    // ===== 体检引擎 =====
    const checks = [
      { id: 'healthz', label: '基础服务', icon: '🏥', fn: async () => { const r = await publicApi('/healthz'); return r.status === 200; } },
      { id: 'readyz', label: '数据库', icon: '🗄️', fn: async () => { const r = await publicApi('/readyz'); return r.status === 200; } },
      { id: 'llm', label: 'AI 润色', icon: '✍️', fn: async () => { const b = await api('/admin/checkup/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return b.ok; } },
      { id: 'stt', label: '语音转写', icon: '🎤', fn: async () => Boolean(state.proxy && state.proxy.stt && state.proxy.stt.configured) },
      { id: 'tts', label: '语音合成', icon: '🔊', fn: async () => Boolean(state.desktopPolicy && state.desktopPolicy.providerStatus && state.desktopPolicy.providerStatus.tts.configured) },
      { id: 'ocr', label: '视觉 OCR', icon: '👁️', fn: async () => Boolean(state.desktopPolicy && state.desktopPolicy.providerStatus && state.desktopPolicy.providerStatus.ocr.configured) },
      { id: 'sub', label: '订阅系统', icon: '💳', fn: async () => { await api('/subscription/status'); return true; } },
    ];

    async function runCheckup() {
      if (state.mutationLocks.has('checkup')) return;
      if (!hasCapability('diagnostics:run')) { show($('#global-status'), '当前角色没有运行诊断的权限。'); return; }
      state.mutationLocks.add('checkup');
      const grid = $('#checkup-results');
      grid.innerHTML = '';
      $('#run-checkup').disabled = true;
      $('#run-checkup').setAttribute('aria-busy', 'true');
      $('#run-checkup').textContent = '诊断中…';
      let pass = 0;
      try {
        if (!state.proxy || !state.desktopPolicy) await loadOverview();
        for (const check of checks) {
          const card = document.createElement('div');
          card.className = 'checkup-card running';
          card.innerHTML = '<span class="cu-icon" aria-hidden="true">' + check.icon + '</span><span class="cu-label">' + check.label + '</span><span class="cu-status">正在检查</span>';
          grid.appendChild(card);
          try {
            const ok = await check.fn();
            card.className = 'checkup-card ' + (ok ? 'pass' : 'fail');
            card.querySelector('.cu-status').textContent = ok ? '通过' : '未通过';
            if (ok) pass++;
          } catch (error) {
            card.className = 'checkup-card fail';
            const message = (error && error.message) || '诊断失败';
            card.querySelector('.cu-status').textContent = '失败：' + message;
            card.title = message;
          }
        }
      } finally {
        state.mutationLocks.delete('checkup');
        $('#run-checkup').removeAttribute('aria-busy');
        $('#run-checkup').textContent = '一键全链路体检（' + pass + '/' + checks.length + ' 通过）';
        applyRoleState();
      }
    }

    // ===== 数据加载 =====
    function currentPeriodKey() { return new Date().toISOString().slice(0, 7); }

    function usersPath() {
      const params = new URLSearchParams({
        periodKey: currentPeriodKey(),
        limit: String(state.userLimit),
      });
      if (state.userQuery) params.set('q', state.userQuery);
      if (state.userCursor) params.set('cursor', state.userCursor);
      return '/admin/users?' + params.toString();
    }

    function applyUsersPayload(payload) {
      state.users = Array.isArray(payload.users) ? payload.users : [];
      state.userTotal = Number.isFinite(Number(payload.total)) ? Number(payload.total) : state.users.length;
      state.userLimit = Number.isFinite(Number(payload.limit)) && Number(payload.limit) > 0 ? Number(payload.limit) : 25;
      state.userQuery = typeof payload.query === 'string' ? payload.query : state.userQuery;
      state.userNextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null;
      state.planLimits = payload.planLimits || state.planLimits;
      state.quotaLevels = Array.isArray(payload.quotaLevels) ? payload.quotaLevels : state.quotaLevels;
      const selectedOnPage = state.users.find((user) => user.id === state.selectedUserId);
      if (selectedOnPage) {
        state.selectedUser = selectedOnPage;
        if (!state.userFormDirty) state.selectedFormsUserId = null;
      }
      else if (state.selectedUserId) clearSelectedUser(false);
    }

    function setResource(name, status, message) {
      const resource = state.resources[name];
      resource.status = status;
      const banner = $('#' + name + '-resource');
      const content = $('#' + name + '-content');
      if (banner) {
        banner.className = 'resource-banner ' + status;
        banner.textContent = message || '';
        banner.hidden = status === 'ready' && !message;
      }
      if (content) content.hidden = !resource.hasData;
      applyRoleState();
    }

    async function runResource(name, loader, renderReady) {
      const resource = state.resources[name];
      const epoch = ++state.requestEpoch[name];
      setResource(name, 'loading', resource.hasData ? '正在刷新，当前内容仍可查看。' : '正在加载…');
      try {
        const value = await loader();
        if (epoch !== state.requestEpoch[name]) return false;
        renderReady(value);
        resource.hasData = true;
        setResource(name, 'ready', '');
        return true;
      } catch (error) {
        if (epoch !== state.requestEpoch[name]) return false;
        const message = (error && error.message) || '加载失败';
        setResource(name, resource.hasData ? 'stale' : 'error', resource.hasData ? '刷新失败，当前显示的是上次成功数据：' + message : '加载失败：' + message);
        return false;
      }
    }

    async function loadOverview() {
      return runResource('overview', async () => {
        const summary = await api('/admin/summary');
        const capabilities = summary.admin && Array.isArray(summary.admin.capabilities) ? summary.admin.capabilities : [];
        const optionalRequests = [api('/admin/operations-overview?periodKey=' + encodeURIComponent(currentPeriodKey()))];
        if (capabilities.includes('services:read')) optionalRequests.push(api('/admin/proxy-status'), api('/admin/desktop-policy'));
        const optional = await Promise.allSettled(optionalRequests);
        const operationsOverview = optional[0].status === 'fulfilled' ? optional[0].value.overview || null : null;
        const proxy = capabilities.includes('services:read') && optional[1] && optional[1].status === 'fulfilled' ? optional[1].value : null;
        const desktopPolicy = capabilities.includes('services:read') && optional[2] && optional[2].status === 'fulfilled' ? optional[2].value : null;
        const warningCount = optional.filter((entry) => entry.status === 'rejected').length;
        return { summary, operationsOverview, proxy, desktopPolicy, warningCount };
      }, (value) => {
        Object.assign(state, value);
        renderStatus();
        renderOverview();
        renderProviderStatus();
        applyCapabilityState();
        if (value.warningCount) show($('#global-status'), '概览已加载；' + value.warningCount + ' 项辅助状态暂时无法刷新。');
      });
    }

    async function loadUsersPage() {
      const loadEpoch = state.requestEpoch.user + 1;
      state.usersLoading = true;
      renderUsers();
      try {
        return await runResource('user', async () => {
          const summary = state.summary || await api('/admin/summary');
          state.summary = summary;
          const pending = readPendingQuotaOperation();
          if (pending && pending.body && pending.body.userId && !state.selectedUserId && !state.userQuery) {
            state.userQuery = String(pending.body.userId);
            state.userCursor = null;
            state.userNextCursor = null;
            state.userCursorStack = [];
          }
          const users = await api(usersPath());
          return { summary, users };
        }, ({ summary, users }) => {
          state.summary = summary;
          applyUsersPayload(users);
          fillQuotaLevelPick();
        });
      } finally {
        if (state.requestEpoch.user === loadEpoch) {
          state.usersLoading = false;
          renderUsers();
          applyRoleState();
        }
      }
    }

    function usageSnapshot() {
      return {
        filters: {
          periodKey: state.usageFilters.periodKey || currentPeriodKey(),
          kind: state.usageFilters.kind,
          status: state.usageFilters.status,
          userId: state.usageFilters.userId,
        },
        cursor: state.usageCursor,
      };
    }

    function usageSnapshotMatches(snapshot) {
      const current = usageSnapshot();
      return current.cursor === snapshot.cursor
        && current.filters.periodKey === snapshot.filters.periodKey
        && current.filters.kind === snapshot.filters.kind
        && current.filters.status === snapshot.filters.status
        && current.filters.userId === snapshot.filters.userId;
    }

    function usageOverviewContext(snapshot = usageSnapshot()) {
      return snapshot.filters.periodKey + '|' + snapshot.filters.userId;
    }

    function usageItemsContext(snapshot = usageSnapshot()) {
      return usageOverviewContext(snapshot) + '|' + snapshot.filters.kind + '|' + snapshot.filters.status + '|' + (snapshot.cursor || '');
    }

    function usagePath(snapshot) {
      const filters = snapshot.filters;
      const params = new URLSearchParams({ limit: '25', periodKey: filters.periodKey });
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.status) params.set('status', filters.status);
      if (filters.userId) params.set('userId', filters.userId);
      if (snapshot.cursor) params.set('cursor', snapshot.cursor);
      return '/admin/quota-operations?' + params.toString();
    }

    function usageOverviewPath(snapshot) {
      const params = new URLSearchParams({ periodKey: snapshot.filters.periodKey });
      if (snapshot.filters.userId) params.set('userId', snapshot.filters.userId);
      return '/admin/usage-overview?' + params.toString();
    }

    function usageAccountSearchPath(query, cursor) {
      const params = new URLSearchParams({
        periodKey: state.usageFilters.periodKey || currentPeriodKey(),
        limit: '10',
      });
      if (query) params.set('q', query);
      if (cursor) params.set('cursor', cursor);
      return '/admin/users?' + params.toString();
    }

    async function loadUsageAccounts(reset) {
      if (reset) {
        state.usageAccountItems = [];
        state.usageAccountCursor = null;
        state.usageAccountNextCursor = null;
      }
      const epoch = ++state.requestEpoch.usageAccounts;
      const snapshot = { query: state.usageAccountQuery, cursor: state.usageAccountCursor };
      state.usageAccountsLoading = true;
      state.usageAccountError = '';
      renderUsageAccountPicker();
      try {
        const payload = await api(usageAccountSearchPath(snapshot.query, snapshot.cursor));
        if (epoch !== state.requestEpoch.usageAccounts
          || snapshot.query !== state.usageAccountQuery
          || snapshot.cursor !== state.usageAccountCursor) return false;
        const incoming = Array.isArray(payload.users) ? payload.users : [];
        const combined = snapshot.cursor ? state.usageAccountItems.concat(incoming) : incoming;
        state.usageAccountItems = [...new Map(combined.map((user) => [user.id, user])).values()];
        state.usageAccountNextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null;
        state.usageAccountError = '';
        return true;
      } catch (error) {
        if (epoch !== state.requestEpoch.usageAccounts) return false;
        state.usageAccountError = '账号搜索失败：' + ((error && error.message) || '请稍后重试');
        return false;
      } finally {
        if (epoch === state.requestEpoch.usageAccounts) {
          state.usageAccountsLoading = false;
          renderUsageAccountPicker();
        }
      }
    }

    async function loadUsage() {
      const resource = state.resources.usage;
      const epoch = ++state.requestEpoch.usage;
      const snapshot = usageSnapshot();
      setResource('usage', 'loading', resource.hasData ? '正在刷新当前账号与账期，旧数据不会混入。' : '正在加载…');
      try {
        const [operations, overviewResult] = await Promise.all([
          api(usagePath(snapshot)),
          api(usageOverviewPath(snapshot)).catch((error) => ({ overview: null, error })),
        ]);
        if (epoch !== state.requestEpoch.usage || !usageSnapshotMatches(snapshot)) return false;
        if (overviewResult && overviewResult.error && overviewResult.error.status === 404) throw overviewResult.error;
        state.usageOverview = overviewResult && overviewResult.overview || null;
        if (snapshot.filters.userId && state.usageOverview && state.usageOverview.subject) {
          state.usageAccount = minimalUsageAccount(state.usageOverview.subject);
        }
        state.usageOverviewContext = state.usageOverview ? usageOverviewContext(snapshot) : null;
        state.usageItems = Array.isArray(operations.items) ? operations.items : [];
        state.usageItemsContext = usageItemsContext(snapshot);
        state.usageNextCursor = typeof operations.nextCursor === 'string' && operations.nextCursor ? operations.nextCursor : null;
        resource.hasData = true;
        renderUsage();
        if (state.usageOverview) setResource('usage', 'ready', '');
        else setResource('usage', 'stale', '计费明细已加载；汇总指标暂时无法读取，不会用 0 代替未知值。');
        return true;
      } catch (error) {
        if (epoch !== state.requestEpoch.usage || !usageSnapshotMatches(snapshot)) return false;
        const message = (error && error.message) || '加载失败';
        setResource('usage', resource.hasData ? 'stale' : 'error', resource.hasData ? '当前筛选加载失败，未展示其他账号的旧数据：' + message : '加载失败：' + message);
        return false;
      }
    }

    function auditPath() {
      const filters = state.auditFilters;
      const params = new URLSearchParams({ limit: '25' });
      if (filters.q) params.set('q', filters.q);
      if (filters.userId) params.set('userId', filters.userId);
      if (filters.minimumStatus) params.set('minimumStatus', filters.minimumStatus);
      if (state.auditCursor) params.set('cursor', state.auditCursor);
      return '/admin/audit?' + params.toString();
    }

    async function loadAudit() {
      return runResource('audit', () => api(auditPath()), (payload) => {
        state.auditItems = Array.isArray(payload.items) ? payload.items : [];
        state.auditNextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null;
        renderAudit();
      });
    }

    async function loadUserSessions(userId) {
      const epoch = ++state.requestEpoch.sessions;
      $('#user-sessions-refresh').disabled = true;
      state.userSessions = [];
      state.userSessionsForId = userId;
      setSessionResource('loading', '正在加载会话…');
      renderUserSessions();
      try {
        const payload = await api('/admin/user-sessions?userId=' + encodeURIComponent(userId) + '&limit=25');
        if (epoch !== state.requestEpoch.sessions || state.selectedUserId !== userId) return false;
        state.userSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        setSessionResource('ready', '');
        renderUserSessions();
        $('#user-sessions-refresh').disabled = false;
        return true;
      } catch (error) {
        if (epoch !== state.requestEpoch.sessions || state.selectedUserId !== userId) return false;
        state.userSessions = [];
        setSessionResource('error', '会话加载失败：' + ((error && error.message) || '请稍后重试'));
        renderUserSessions();
        $('#user-sessions-refresh').disabled = false;
        return false;
      }
    }

    async function loadProviders() {
      return runResource('provider', async () => {
        const summary = state.summary || await api('/admin/summary');
        const providers = await api('/admin/providers');
        const optional = await Promise.allSettled([api('/admin/proxy-status'), api('/admin/desktop-policy')]);
        return {
          summary,
          providers: providers.providers || [],
          proxy: optional[0].status === 'fulfilled' ? optional[0].value : state.proxy,
          desktopPolicy: optional[1].status === 'fulfilled' ? optional[1].value : state.desktopPolicy,
        };
      }, (value) => {
        Object.assign(state, value);
        renderProviderMaster();
        fillProviderPick();
      });
    }

    async function loadScenes() {
      return runResource('scene', async () => {
        const [summary, scenes] = await Promise.all([state.summary || api('/admin/summary'), api('/admin/scenes')]);
        return { summary, scenes: scenes.scenes || [] };
      }, (value) => {
        state.summary = value.summary;
        state.scenes = value.scenes;
        renderScenes();
      });
    }

    async function loadReleases() {
      return runResource('publish', async () => {
        const [summary, releases] = await Promise.all([state.summary || api('/admin/summary'), api('/admin/ota-releases')]);
        return { summary, releases: releases.releases || [] };
      }, (value) => {
        state.summary = value.summary;
        state.otaReleases = value.releases;
        renderOta();
      });
    }

    async function loadSystem() {
      return runResource('system', async () => {
        const [summary, system] = await Promise.all([state.summary || api('/admin/summary'), api('/admin/system')]);
        return { summary, system };
      }, (value) => {
        Object.assign(state, value);
        renderSystem();
      });
    }

    function loadActiveView() {
      const loaders = { overview: loadOverview, user: loadUsersPage, usage: loadUsage, provider: loadProviders, scene: loadScenes, publish: loadReleases, audit: loadAudit, system: loadSystem };
      const loader = loaders[state.activeView];
      return loader ? loader() : Promise.resolve(true);
    }

    function render() {
      renderStatus();
      renderOverview();
      renderProviderStatus();
      fillQuotaLevelPick();
      renderUsers();
      renderUsage();
      renderScenes();
      renderOta();
      renderAudit();
      renderSystem();
      fillProviderPick();
      applyCapabilityState();
      applyRoleState();
    }

    function renderStatus() {
      if (!state.summary) return;
      const o = state.summary.overview || {};
      const r = state.summary.admin && state.summary.admin.role || 'viewer';
      $('#status-bar').innerHTML = '<strong>已连接</strong> · ' + esc(o.userCount || 0) + ' 用户 · ' + esc(o.subscriptionCount || 0) + ' 订阅 · ' + esc(r);
      $('#account-email').textContent = window.__ECHO_PANEL__.userEmail || '当前账号';
    }

    function renderOverview() {
      if (!state.summary) return;
      const o = state.summary.overview;
      const operations = state.operationsOverview;
      $('#overview-metrics').innerHTML = [
        m('注册用户', o.userCount),
        m('付费订阅', o.subscriptionCount),
        m('Pro 订阅', o.proSubscriptionCount),
        m('场景模板', o.scenePackCount),
        m('用量记录', o.usageLedgerCount),
        m('失败请求', operations ? operations.failedRequests : '—'),
        m('过期预占', operations ? operations.expiredReservations : '—'),
        m('待核对操作', operations ? operations.unreconciledOperations : '—'),
        m('审计事件', operations ? operations.auditedRequests : '—'),
      ].join('');
    }

    function m(label, val) {
      return '<article class="metric"><span>' + esc(label) + '</span><strong>' + esc(val) + '</strong></article>';
    }`
}
