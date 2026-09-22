(() => {
  'use strict';
  const element = id => document.getElementById(id);
  const nonce = location.hash.slice(1);
  history.replaceState(null, '', '/');
  let signup = false;
  let submitted = false;
  let busy = false;
  let finished = false;
  let emailAfter = 0;
  let emailTimer;
  let expiryTimer;
  const status = message => { element('status').textContent = message; };
  async function post(route, body = {}) {
    const response = await fetch(`/api/${route}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, nonce }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'Authentication failed. Return to the terminal and start a fresh login.');
    return result;
  }
  function controls() {
    element('verify').disabled = busy || finished;
    element('code').disabled = busy || finished;
    element('email').disabled = busy || finished || Date.now() < emailAfter;
    element('cancel').disabled = busy || finished;
    for (const id of ['terms', 'privacy', 'marketing']) element(id).disabled = submitted || finished;
  }
  function expiresAt(deadline) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      clearTimeout(emailTimer);
      controls();
      element('google-panel').hidden = true;
      element('two-factor').hidden = true;
      element('cancel').hidden = true;
      element('title').textContent = 'Authentication expired.';
      status('This authentication attempt expired. Check your terminal for the result. If authentication did not complete, start a fresh login.');
    }, Math.max(0, deadline - Date.now()));
  }
  function advance(result) {
    element('google-panel').hidden = true;
    if (result.state === 'two-factor' && !finished) {
      expiresAt(result.expiresAt);
      element('two-factor').hidden = false;
      element('title').textContent = 'One more security check.';
      status('Your temporary verification session lasts at most five minutes.');
      element('code').focus();
    } else if (result.state === 'complete') {
      finished = true;
      clearTimeout(emailTimer);
      clearTimeout(expiryTimer);
      element('two-factor').hidden = true;
      element('cancel').hidden = true;
      element('title').textContent = 'Account connected.';
      status('Authentication completed. Return to your terminal. You can close this tab.');
    }
  }
  function consentReady() {
    return !signup || (element('terms').checked && element('privacy').checked);
  }
  function updateButton() {
    element('google-button').hidden = !consentReady() || submitted;
  }
  async function credential(response) {
    if (submitted || finished || !consentReady()) return;
    submitted = true;
    busy = true;
    updateButton();
    controls();
    status('Completing Google authentication...');
    try {
      const body = { credential: response.credential };
      if (signup) Object.assign(body, { termsAgreed: element('terms').checked, privacyAcknowledged: element('privacy').checked, marketingConsent: element('marketing').checked });
      advance(await post('google', body));
    } catch (error) { if (!finished) status(`${error.message} Check the terminal before retrying; the session may already have been saved.`); }
    finally { busy = false; controls(); if (!element('two-factor').hidden) element('code').focus(); }
  }
  element('terms').addEventListener('change', updateButton);
  element('privacy').addEventListener('change', updateButton);
  element('code-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || finished) return;
    const code = element('code').value;
    if (!/^\d{6}$/.test(code)) { status('Enter exactly six digits, including leading zeros.'); return; }
    busy = true;
    controls();
    status('Verifying your code...');
    try { advance(await post('verify', { code })); }
    catch (error) { if (!finished) status(`${error.message} If this page disconnected, check the terminal before retrying.`); }
    finally { element('code').value = ''; busy = false; controls(); }
  });
  element('email').addEventListener('click', async () => {
    if (busy || finished || Date.now() < emailAfter) return;
    busy = true;
    emailAfter = Date.now() + 30_000;
    controls();
    emailTimer = setTimeout(controls, 30_000);
    try { await post('email'); if (!finished) status('Email code requested. Check your inbox and enter its six digits.'); }
    catch (error) { if (!finished) status(error.message); }
    finally { busy = false; controls(); }
  });
  element('cancel').addEventListener('click', async () => {
    if (busy || finished) return;
    finished = true;
    clearTimeout(emailTimer);
    clearTimeout(expiryTimer);
    controls();
    try { await post('cancel'); status('Authentication cancelled. You can close this tab.'); }
    catch { status('The local authentication server is unavailable. Return to the terminal.'); }
    element('google-panel').hidden = true;
    element('two-factor').hidden = true;
  });
  async function initialize() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('This page needs the complete URL from your terminal. Restart authentication instead of reloading the page.');
    const config = await post('config');
    expiresAt(config.expiresAt);
    signup = config.signup;
    element('origin').textContent = `API: ${config.origin}`;
    element('consents').hidden = !signup;
    if (signup) {
      element('title').textContent = 'Create your Geodd account.';
      element('description').textContent = 'Register a standard account using Google. Legal consent is your choice, not a CLI flag.';
    }
    updateButton();
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => reject(new Error('Google sign-in did not load. Check network access and script blockers.')), 20_000);
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
      script.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Google sign-in could not load. Check network access and script blockers.')); }, { once: true });
      document.head.append(script);
    });
    if (finished) return;
    google.accounts.id.initialize({ client_id: config.clientId, callback: credential, auto_select: false, ux_mode: 'popup' });
    google.accounts.id.renderButton(element('google-button'), { type: 'standard', theme: 'outline', size: 'large', text: signup ? 'signup_with' : 'signin_with', width: 280 });
    status(signup ? 'Review the consent choices, then continue with Google.' : 'Continue with Google to sign in to an existing account.');
  }
  initialize().catch(async error => {
    if (finished) return;
    status(`${error.message} Check GEODD_GOOGLE_CLIENT_ID and authorize this exact localhost origin in Google Cloud.`);
    try { await post('error'); } catch { /* The terminal may already have closed the server. */ }
  });
})();
