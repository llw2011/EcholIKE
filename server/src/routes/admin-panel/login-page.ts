export function adminPanelLoginPage(input: {
  nonce: string
  favicon: string
  stylesheet: string
  config: string
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
  <main class="login-shell">
    <section class="login-panel">
      <div class="brand-row">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <p class="eyebrow">EcholIKE</p>
          <h1>管理台</h1>
        </div>
      </div>
      <form id="login-form" class="stack">
        <label>邮箱<input id="email" type="email" autocomplete="email" required /></label>
        <label>密码<input id="password" type="password" autocomplete="current-password" required /></label>
        <button id="login-submit" type="submit">登录</button>
        <p id="message" class="message" role="status" aria-live="polite"></p>
      </form>
    </section>
  </main>
  ${input.config}
  <script nonce="${input.nonce}">
    const form = document.querySelector('#login-form');
    const message = document.querySelector('#message');
    const submit = document.querySelector('#login-submit');
    let loginCompleted = false;
    try { localStorage.removeItem('echoPanelToken'); } catch {}
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      submit.textContent = '正在登录…';
      message.textContent = '正在登录...';
      try {
        const response = await fetch(window.__ECHO_PANEL__.apiBasePath + '/auth/sign-in/email', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: document.querySelector('#email').value,
            password: document.querySelector('#password').value,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          message.textContent = body.error || body.message || '登录失败';
          return;
        }
        message.textContent = '登录成功，正在进入管理台…';
        loginCompleted = true;
        window.location.href = '/echo-panel/';
      } catch {
        message.textContent = '网络连接失败，请检查网络后重试。';
      } finally {
        if (!loginCompleted) {
          submit.disabled = false;
          submit.removeAttribute('aria-busy');
          submit.textContent = '登录';
        }
      }
    });
  </script>
</body>
</html>`
}
