import { adminPanelDashboardScript } from './dashboard-script.js'

export function adminPanelDashboardPage(input: {
  nonce: string
  favicon: string
  stylesheet: string
  config: string
  providerPresets: string
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EcholIKE 管理台</title>
  ${input.favicon}
  ${input.stylesheet}
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand-row">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <p class="eyebrow">EcholIKE 管理台</p>
          <div id="status-bar" class="status-bar">正在连接...</div>
        </div>
      </div>
      <div class="topbar-actions">
        <button id="cmd-refresh" class="btn-icon" aria-label="刷新当前模块" title="刷新当前模块" type="button"><span aria-hidden="true">↻</span><span class="sr-only">刷新当前模块</span></button>
        <button id="cmd-signout" class="btn-icon" aria-label="退出管理台" title="退出管理台" type="button"><span aria-hidden="true">⏻</span><span class="sr-only">退出管理台</span></button>
      </div>
    </header>

    <nav class="module-nav" aria-label="管理模块">
      <button class="module-tab is-active" data-view="overview" type="button" aria-current="page">概览</button>
      <button class="module-tab" data-view="account" type="button">我的账号</button>
      <button class="module-tab" data-view="user" type="button">用户</button>
      <button class="module-tab" data-view="usage" type="button">用量</button>
      <button class="module-tab" data-view="provider" type="button">服务</button>
      <button class="module-tab" data-view="scene" type="button">场景</button>
      <button class="module-tab" data-view="publish" type="button">版本</button>
      <button class="module-tab" data-view="audit" type="button">审计</button>
      <button class="module-tab" data-view="system" type="button">系统</button>
    </nav>

    <p id="global-status" class="global-status" role="status" aria-live="polite"></p>

    <section class="workspace is-active" id="block-overview" data-workspace="overview" aria-labelledby="workspace-overview-title">
      <header class="workspace-head">
        <div><p class="eyebrow">Overview</p><h1 id="workspace-overview-title">平台概览</h1><p>查看平台规模、服务配置和按需诊断；页面不会自动调用模型。</p></div>
        <button class="btn-secondary" type="button" data-retry="overview">刷新概览</button>
      </header>
      <div id="overview-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="overview-content" class="workspace-content" hidden>
        <div class="metric-grid" id="overview-metrics"></div>
        <section class="diagnostic-panel" aria-labelledby="diagnostic-title">
          <div><h2 id="diagnostic-title">服务状态与真实诊断</h2><p class="hint">配置状态只说明后台已有服务参数；点击后才执行真实检查，其中 AI 润色会产生一次最小模型请求。</p></div>
          <div id="provider-status" class="status-cards"></div>
          <button id="run-checkup" class="btn-primary" type="button" data-capability="diagnostics:run">运行按需诊断</button>
          <div id="checkup-results" class="checkup-grid" role="status" aria-live="polite"></div>
        </section>
      </div>
    </section>

    <section class="workspace" id="block-publish" data-workspace="publish" aria-labelledby="workspace-publish-title" hidden>
      <header class="workspace-head">
        <div><p class="eyebrow">Releases</p><h1 id="workspace-publish-title">发布新版本与 OTA</h1><p>版本先保存为停用草稿，满足签名门禁后再明确启用。</p></div>
        <button class="btn-secondary" type="button" data-retry="publish">刷新版本</button>
      </header>
      <div id="publish-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div class="block-body" id="publish-content" hidden>
        <p class="hint">填写版本、安装包与签名；保存后客户端可在下次启动或手动检查时获取。</p>
        <form id="ota-form" class="compact-form ota-form" data-capability="releases:write">
          <input type="hidden" name="id" />
          <input type="hidden" name="expectedRevision" />
          <input type="hidden" name="channel" value="stable" />
          <input type="hidden" name="platform" value="all" />
          <input type="hidden" name="arch" value="all" />
          <input type="hidden" name="autoUpdate" value="false" />
          <input type="hidden" name="enabled" value="false" />
          <input type="hidden" name="forceUpdate" value="false" />
          <input type="hidden" name="minVersion" value="" />
          <label>版本号<input name="version" placeholder="如 0.2.0" required /></label>
          <label>安装包字节数<input name="artifactBytes" type="number" min="1" step="1" inputmode="numeric" placeholder="启用前必填；草稿可留空" /></label>
          <label>SHA-256<input name="sha256" inputmode="text" minlength="64" maxlength="64" pattern="[A-Fa-f0-9]{64}" placeholder="启用前必填；草稿可留空" /></label>
          <label class="ota-form-wide">更新签名<textarea name="signature" rows="3" placeholder="启用前粘贴 .sig 文件内容；草稿可留空"></textarea></label>
          <label class="ota-form-wide">安装包下载地址<input name="downloadUrl" type="url" placeholder="启用前必填；草稿可留空" /></label>
          <label class="ota-form-wide">更新说明<textarea name="releaseNotes" rows="2" placeholder="本次更新内容"></textarea></label>
          <div class="ota-form-actions">
            <p class="hint">保存动作永远不会启用版本；请在下方版本详情中单独验证并激活。</p>
            <button type="submit" data-submit-mode="draft" data-control="operator" data-capability="releases:write">保存停用草稿</button>
          </div>
        </form>
        <div id="ota-result" class="result-line" role="status" aria-live="polite"></div>
        <details class="ota-history">
          <summary><span>已有版本</span><small id="ota-history-meta">0 个版本</small></summary>
          <div class="ota-history-body">
            <div class="table-wrap ota-table-wrap" role="region" aria-label="已有版本" tabindex="0"><table id="ota-table"></table></div>
            <nav class="ota-pagination" aria-label="已有版本分页">
              <button class="btn-secondary" id="ota-prev" type="button">上一页</button>
              <span id="ota-page-label">第 1 / 1 页</span>
              <button class="btn-secondary" id="ota-next" type="button">下一页</button>
            </nav>
          </div>
        </details>
      </div>
    </section>

    <section class="workspace" id="block-provider" data-workspace="provider" aria-labelledby="workspace-provider-title" hidden>
      <header class="workspace-head">
        <div><p class="eyebrow">Services</p><h1 id="workspace-provider-title">云服务配置</h1><p>先从左侧选择能力，再编辑当前服务；配置状态不等于真实可用。</p></div>
        <button class="btn-secondary" type="button" data-retry="provider">刷新服务</button>
      </header>
      <div id="provider-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="provider-content" class="master-detail" hidden>
        <aside class="master-pane" aria-label="服务能力列表">
          <div id="provider-master" class="status-cards"></div>
        </aside>
        <section id="provider-detail" class="detail-pane" aria-labelledby="provider-detail-title">
          <header class="detail-head">
            <button class="detail-back" type="button" data-close-panel="provider-detail" aria-label="返回服务列表">←</button>
            <div><span class="detail-kicker">当前服务</span><h2 id="provider-detail-title">选择服务能力</h2></div>
          </header>
          <div class="detail-scroll">
          <form id="provider-form" class="compact-form" autocomplete="off" data-capability="providers:write">
          <div class="autofill-trap" aria-hidden="true">
            <input type="text" autocomplete="username" tabindex="-1" />
            <input type="password" autocomplete="current-password" tabindex="-1" />
          </div>
          <input type="hidden" name="id" />
          <input type="hidden" name="expectedRevision" />
          <input type="hidden" name="displayName" value="" />
          <input type="hidden" name="mode" value="proxy" />
          <input type="hidden" name="priority" value="0" />
          <div class="form-row">
            <label>类型
              <select name="kind">
                <option value="llm">文本润色 LLM</option>
                <option value="stt">语音转写 STT</option>
                <option value="tts">语音合成 TTS</option>
                <option value="ocr">视觉 OCR</option>
              </select>
            </label>
            <label>服务商<select name="providerId" id="provider-pick"><option value="">— 选择 —</option></select></label>
          </div>
          <label>后端服务地址<input name="endpoint" placeholder="留空使用服务预设；自定义时填写实际受控地址" autocomplete="off" spellcheck="false" /></label>
          <label>默认模型
            <div class="field-with-action">
              <input name="defaultModel" list="provider-model-options" placeholder="如 gemini-2.5-flash" autocomplete="off" spellcheck="false" />
               <button type="button" id="provider-read-models" data-control="operator" data-capability="providers:write">读取模型</button>
            </div>
            <datalist id="provider-model-options"></datalist>
          </label>
          <fieldset id="provider-capabilities" class="capability-fields" aria-describedby="provider-capabilities-hint">
            <legend>能力参数</legend>
            <p id="provider-capabilities-hint" class="hint">只读显示当前服务预设；保存时按原值提交，不在此处手工改写。</p>
            <dl id="provider-capability-fields"></dl>
          </fieldset>
          <label>API 密钥（留空不改）<input name="apiKey" type="password" placeholder="留空 = 不改" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" /></label>
          <label class="cb"><input name="enabled" type="checkbox" checked /> 启用后客户端可获取此服务</label>
          <div class="task-actions"><button type="submit" data-control="operator" data-capability="providers:write">保存服务配置</button></div>
        </form>
        <div id="provider-result" class="result-line" role="status" aria-live="polite"></div>
          </div>
        </section>
      </div>
    </section>

    <section class="workspace" id="block-scene" data-workspace="scene" aria-labelledby="workspace-scene-title" hidden>
      <header class="workspace-head">
        <div><p class="eyebrow">Scenes</p><h1 id="workspace-scene-title">场景模板</h1><p>选择模板后在右侧编辑；切换前会保护尚未保存的内容。</p></div>
        <button class="btn-secondary" type="button" data-retry="scene">刷新场景</button>
      </header>
      <div id="scene-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="scene-content" class="master-detail" hidden>
        <aside class="master-pane">
          <div class="master-actions"><button id="scene-new" class="btn-secondary" type="button">＋ 新建场景</button></div>
          <div class="table-wrap scene-table-wrap"><table id="scenes-table"><caption class="sr-only">场景模板列表</caption></table></div>
          <div id="scene-cards" class="scene-cards" aria-label="场景模板列表"></div>
        </aside>
        <section id="scene-detail" class="detail-pane" aria-labelledby="scene-editor-title">
          <header class="detail-head">
            <button class="detail-back" type="button" data-close-panel="scene-detail" aria-label="返回场景列表">←</button>
            <div><span class="detail-kicker">场景编辑</span><h2 id="scene-editor-title">新建场景</h2></div>
          </header>
          <div class="detail-scroll">
          <form id="scene-form" class="compact-form" data-capability="scenes:write">
          <input type="hidden" name="id" />
          <label>标识（英文）<input name="slug" placeholder="meeting-notes" required /></label>
          <label>名称<input name="name" placeholder="会议纪要" required /></label>
          <label>分类<input name="category" placeholder="办公" required /></label>
          <label>描述<textarea name="description" rows="2" required></textarea></label>
          <label>AI 指令<textarea name="promptTemplate" rows="4" required></textarea></label>
          <label>词典（每行一个词）<textarea name="dictionaryTerms" rows="3" placeholder="CNC"></textarea></label>
          <div class="form-row">
            <label class="cb"><input name="enabled" type="checkbox" checked /> 启用后客户端可获取</label>
            <label class="cb"><input name="isPro" type="checkbox" /> 仅 Pro</label>
          </div>
           <div class="task-actions"><button type="submit" data-control="operator" data-capability="scenes:write">保存场景</button></div>
        </form>
        <div id="scene-result" class="result-line" role="status" aria-live="polite"></div>
          </div>
        </section>
      </div>
    </section>

    <section class="workspace" id="block-account" data-workspace="account" aria-labelledby="workspace-account-title" hidden>
      <header class="workspace-head">
        <div><p class="eyebrow">Account</p><h1 id="workspace-account-title">我的账号</h1><p>查看当前后台身份并修改自己的登录密码；此入口不需要用户列表权限。</p></div>
      </header>
      <div class="workspace-content account-workspace">
        <section class="selected-user-card"><div class="selected-user-copy"><span>当前登录账号</span><strong id="account-email">正在读取…</strong><small>修改密码后，其他设备上的登录会话将退出。</small></div></section>
        <section class="operation-card">
          <h2>修改我的密码</h2>
          <form id="change-password-form" class="compact-form" autocomplete="off">
            <label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required /></label>
            <div class="form-row"><label>新密码<input name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required /></label><label>确认新密码<input name="confirmPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required /></label></div>
            <div class="task-actions"><button type="submit">修改我的密码</button></div>
          </form>
          <div id="change-password-result" class="result-line" role="status" aria-live="polite"></div>
        </section>
      </div>
    </section>

    <section class="workspace" id="block-user" data-workspace="user" aria-labelledby="workspace-user-title" hidden>
      <header class="workspace-head">
        <div><p class="eyebrow">Users</p><h1 id="workspace-user-title">用户与额度</h1><p>从列表选择唯一目标，再进入单项操作；提交时会冻结目标身份。</p></div>
        <button class="btn-secondary" type="button" data-retry="user">刷新用户</button>
      </header>
      <div id="user-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="user-content" class="master-detail user-master-detail" hidden>
        <aside class="master-pane user-master-pane">
          <div class="account-actions-grid master-actions">
             <button class="btn-secondary" type="button" data-user-task="create" data-task-capability="users:write">＋ 新建用户</button>
          </div>
          <form id="user-search-form" class="user-list-toolbar" role="search">
            <label class="user-search-field"><span>搜索邮箱、昵称或用户 ID</span><input id="user-search" name="q" type="search" maxlength="120" autocomplete="off" placeholder="输入关键词" /></label>
            <button class="btn-secondary user-search-submit" id="user-search-submit" type="submit">搜索</button>
            <button class="btn-secondary" id="user-search-clear" type="button">清除</button>
          </form>
          <div id="user-list-summary" class="user-list-summary" aria-live="polite"></div>
          <div class="table-wrap user-table-wrap"><table id="users-table"><caption class="sr-only">用户列表</caption></table></div>
          <div id="users-cards" class="user-cards" aria-label="用户列表"></div>
          <nav class="user-pagination" aria-label="用户列表分页">
            <button class="btn-secondary" id="users-prev" type="button">上一页</button><span id="users-page-label">第 1 页</span><button class="btn-secondary" id="users-next" type="button">下一页</button>
          </nav>
        </aside>

        <section id="user-detail" class="detail-pane user-detail-pane" aria-labelledby="user-detail-title">
          <header class="detail-head">
            <button class="detail-back" type="button" data-close-panel="user-detail" aria-label="返回用户列表">←</button>
            <div><span class="detail-kicker">当前任务</span><h2 id="user-detail-title">请选择用户或任务</h2></div>
          </header>
          <div class="detail-scroll">
            <section id="selected-user" class="selected-user-card" aria-live="polite">
              <div class="selected-user-copy"><span>当前操作用户</span><strong id="selected-user-email">请先从左侧列表选择用户</strong><small id="selected-user-id">选择后可设置额度、角色、配额或重置密码。</small></div>
              <button class="btn-secondary" id="selected-user-clear" type="button" disabled>清除选择</button>
            </section>
            <section id="user-sessions-panel" class="session-panel" hidden>
              <header><div><h3>登录会话</h3><p class="hint">仅显示当前所选用户的脱敏会话摘要。</p></div><button id="user-sessions-refresh" class="btn-secondary" type="button">刷新会话</button></header>
              <div id="user-sessions-resource" class="resource-banner" role="status" aria-live="polite"></div>
              <div id="user-sessions-list" class="session-list"></div>
            </section>
            <nav id="user-task-nav" class="task-nav" aria-label="用户操作" hidden>
               <button type="button" data-user-task="quota-level" data-task-capability="quota:write">额度等级</button><button type="button" data-user-task="admin" data-task-capability="users:write">管理员角色</button><button type="button" data-user-task="quota" data-task-capability="quota:write">调整配额</button><button type="button" data-user-task="reset-password" data-task-capability="users:write">重置密码</button>
            </nav>
            <div class="user-operation-grid">
              <section class="operation-card task-view" data-user-task-view="empty"><h3>选择一项任务</h3><p class="hint">桌面端从左侧选择用户；手机端选择用户卡片后会打开此任务面板。</p></section>
              <section class="operation-card task-view" data-user-task-view="create" hidden>
                <h3>新建用户</h3><form id="create-user-form" class="compact-form" autocomplete="off" data-capability="users:write"><div class="form-row"><label>邮箱<input name="email" type="email" autocomplete="off" required /></label><label>昵称<input name="name" autocomplete="off" placeholder="可留空" /></label></div><label>初始密码<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" required /></label><label class="cb"><input name="emailVerified" type="checkbox" checked /> 邮箱已验证</label><p class="hint">新建后，可在下方调整额度与用户权限。</p><div class="task-actions"><button type="submit" data-control="admin" data-capability="users:write">创建用户</button></div></form><div id="create-user-result" class="result-line" role="status" aria-live="polite"></div>
              </section>
              <section class="operation-card task-view" data-user-task-view="quota-level" hidden>
                <h3>额度等级</h3><form id="quota-level-form" class="compact-form" data-capability="quota:write"><input type="hidden" name="userId" /><div class="form-row"><label>等级<select name="quotaLevel" data-requires-user required disabled></select></label><label>当前倍率<span id="quota-level-preview" class="quota-level-preview">-</span></label></div><p class="hint">放大当前套餐月额度，不改变 free / pro 权限。</p><div class="task-actions"><button type="submit" data-control="operator" data-capability="quota:write" data-requires-user disabled>保存等级</button></div></form><div id="quota-level-result" class="result-line" role="status" aria-live="polite"></div>
              </section>
              <section class="operation-card task-view" data-user-task-view="admin" hidden>
                <h3>管理员角色</h3><form id="admin-form" class="compact-form" data-capability="users:write"><input type="hidden" name="userId" /><div class="form-row"><label>角色<select name="role" data-requires-user disabled><option value="viewer">viewer 只读</option><option value="operator">operator 操作</option><option value="admin">admin 管理</option><option value="owner">owner 最高</option></select></label><label>状态<select name="status" data-requires-user disabled><option value="active">启用</option><option value="disabled">禁用</option></select></label></div><p class="hint">设置后台访问权限；禁用后将无法进入管理台。</p><div class="task-actions"><button type="submit" data-control="admin" data-capability="users:write" data-requires-user disabled>保存角色</button></div></form><div id="admin-result" class="result-line" role="status" aria-live="polite"></div>
              </section>
              <section class="operation-card task-view" data-user-task-view="quota" hidden>
                <h3>调整配额</h3><form id="quota-form" class="compact-form" data-capability="quota:write"><input type="hidden" name="userId" /><div class="form-row quota-adjustment-row"><label>账期<input name="periodKey" type="month" data-requires-user required disabled /></label><label>操作<select name="mode" data-requires-user disabled><option value="grant">增加可用额度</option><option value="consume">扣减可用额度</option><option value="raw">高级：直接写账本</option></select></label><label>类型<select name="kind" data-requires-user disabled><option value="stt_seconds">语音（秒）</option><option value="llm_tokens">润色（tokens）</option><option value="ocr_images">OCR（张）</option><option value="tts_chars">朗读（字符）</option></select></label><label>数量<input name="amount" type="number" min="1" max="10000000" step="1" value="1000" data-requires-user required disabled /></label></div><label>原因 / 工单说明<input name="reason" maxlength="500" autocomplete="off" placeholder="说明本次调整的依据，便于审计" data-requires-user required disabled /></label><p class="hint">增减额度填正数；“直接写账本”仅用于历史纠错。若存在网络断响，原账期与操作身份会保留到结果确认。</p><div class="task-actions"><button type="submit" data-control="operator" data-capability="quota:write" data-requires-user disabled>提交调整</button></div></form><div id="quota-result" class="result-line" role="status" aria-live="polite"></div>
              </section>
              <section class="operation-card task-view" data-user-task-view="reset-password" hidden>
                <h3>重置用户密码</h3><form id="reset-password-form" class="compact-form" autocomplete="off" data-capability="users:write"><input type="hidden" name="userId" /><div class="form-row"><label>新密码<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" data-requires-user data-requires-other-user required disabled /></label><label>确认新密码<input name="confirmPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" data-requires-user data-requires-other-user required disabled /></label></div><p id="reset-password-hint" class="hint">重置后，该用户全部登录会话失效。</p><div class="task-actions"><button type="submit" data-control="admin" data-capability="users:write" data-requires-user data-requires-other-user disabled>重置密码</button></div></form><div id="reset-password-result" class="result-line" role="status" aria-live="polite"></div>
              </section>
            </div>
          </div>
        </section>
      </div>
    </section>

    <section class="workspace" id="block-usage" data-workspace="usage" aria-labelledby="workspace-usage-title" hidden>
      <header class="workspace-head"><div><p class="eyebrow">Usage</p><h1 id="workspace-usage-title">用量与计费操作</h1><p>按账期查看聚合用量和可核对的操作终态，不展示响应正文或幂等密钥。</p></div><button class="btn-secondary" type="button" data-retry="usage">刷新用量</button></header>
      <div id="usage-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="usage-content" class="workspace-content" hidden>
        <form id="usage-filter-form" class="filter-bar">
          <label>账期<input name="periodKey" type="month" required /></label>
          <label>类型<select name="kind"><option value="">全部类型</option><option value="stt_seconds">语音秒数</option><option value="llm_tokens">润色 tokens</option><option value="ocr_images">OCR 张数</option><option value="tts_chars">朗读字符</option></select></label>
          <label>状态<select name="status"><option value="">全部状态</option><option value="reserved">处理中</option><option value="completed">已完成</option><option value="released">已释放</option></select></label>
          <div class="usage-account-field">
            <span class="filter-label">账号</span>
            <button id="usage-account-trigger" class="usage-account-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="usage-account-menu">
              <span><strong id="usage-account-label">全部账号</strong><small id="usage-account-meta">显示所有账号</small></span><span aria-hidden="true">⌄</span>
            </button>
            <div id="usage-account-menu" class="usage-account-menu" hidden>
              <div class="usage-account-search">
                <label class="sr-only" for="usage-account-search">搜索账号</label>
                <input id="usage-account-search" type="search" maxlength="120" autocomplete="off" placeholder="邮箱、昵称或用户 ID" />
                <button id="usage-account-search-submit" class="btn-secondary" type="button">搜索</button>
              </div>
              <p id="usage-account-resource" class="usage-account-resource" role="status" aria-live="polite"></p>
              <div id="usage-account-options" class="usage-account-options" role="listbox" aria-label="选择用量账号"></div>
              <button id="usage-account-more" class="btn-secondary" type="button" hidden>加载更多账号</button>
            </div>
            <input name="userId" type="hidden" />
          </div>
          <button class="btn-secondary" type="submit">应用筛选</button>
        </form>
        <section class="usage-metric-section" aria-labelledby="usage-total-title">
          <header class="usage-metric-head"><div><h2 id="usage-total-title">账号用量</h2><p id="usage-context-label">全部账号 · 当前账期</p></div><small>本账期全部类型总量，不随下方明细的类型或状态筛选变化。</small></header>
          <div id="usage-usage-metrics" class="metric-grid compact-metrics"></div>
        </section>
        <section class="usage-metric-section" aria-labelledby="usage-health-title">
          <header class="usage-metric-head"><div><h2 id="usage-health-title">计费健康</h2><p>当前账号与账期的操作终态</p></div></header>
          <div id="usage-health-metrics" class="metric-grid compact-metrics"></div>
        </section>
        <div class="table-wrap insight-table-wrap"><table id="usage-table"><caption class="sr-only">计费操作列表</caption></table></div>
        <div id="usage-cards" class="insight-cards"></div>
        <nav class="cursor-pagination" aria-label="计费操作分页"><button id="usage-prev" class="btn-secondary" type="button">上一页</button><span id="usage-page-label">第 1 页</span><button id="usage-next" class="btn-secondary" type="button">下一页</button></nav>
      </div>
    </section>

    <section class="workspace" id="block-audit" data-workspace="audit" aria-labelledby="workspace-audit-title" hidden>
      <header class="workspace-head"><div><p class="eyebrow">Audit</p><h1 id="workspace-audit-title">审计记录</h1><p>按服务端脱敏契约查看控制操作与请求状态，不展示原始 metadata。</p></div><button class="btn-secondary" type="button" data-retry="audit">刷新审计</button></header>
      <div id="audit-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="audit-content" class="workspace-content" hidden>
        <form id="audit-filter-form" class="filter-bar">
          <label>搜索<input name="q" maxlength="120" autocomplete="off" placeholder="动作或请求 ID" /></label>
          <label>用户 ID<input name="userId" maxlength="180" autocomplete="off" placeholder="可留空" /></label>
          <label>最低状态码<input name="minimumStatus" type="number" min="100" max="599" step="1" placeholder="如 400" /></label>
          <button class="btn-secondary" type="submit">应用筛选</button>
        </form>
        <div class="table-wrap insight-table-wrap"><table id="audit-table"><caption class="sr-only">审计记录列表</caption></table></div>
        <div id="audit-cards" class="insight-cards"></div>
        <nav class="cursor-pagination" aria-label="审计记录分页"><button id="audit-prev" class="btn-secondary" type="button">上一页</button><span id="audit-page-label">第 1 页</span><button id="audit-next" class="btn-secondary" type="button">下一页</button></nav>
      </div>
    </section>

    <section class="workspace" id="block-system" data-workspace="system" aria-labelledby="workspace-system-title" hidden>
      <header class="workspace-head"><div><p class="eyebrow">System</p><h1 id="workspace-system-title">系统内部状态</h1><p>只读查看运行时与依赖信息。</p></div><button class="btn-secondary" type="button" data-retry="system">刷新系统状态</button></header>
      <div id="system-resource" class="resource-banner" role="status" aria-live="polite"></div>
      <div id="system-content" class="system-grid" hidden></div>
    </section>

    <section id="danger-confirm" class="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-copy" hidden>
      <div class="confirm-card">
        <p class="eyebrow">请确认高风险操作</p><h2 id="confirm-title">确认操作</h2><p id="confirm-copy"></p>
        <label id="confirm-input-wrap" hidden>输入确认文字<input id="confirm-input" autocomplete="off" /></label>
        <div class="confirm-actions"><button id="confirm-cancel" class="btn-secondary" type="button">取消</button><button id="confirm-accept" class="btn-danger" type="button">确认执行</button></div>
      </div>
    </section>

  </main>
  ${input.config}
  ${adminPanelDashboardScript({
    nonce: input.nonce,
    providerPresets: input.providerPresets,
  })}
</body>
</html>`
}
