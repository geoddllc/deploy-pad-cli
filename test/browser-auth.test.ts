import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { browserAuth } from '../src/browser-auth.js';
import { CliError } from '../src/errors.js';
import { HttpClient } from '../src/http.js';
import type { Context } from '../src/runtime.js';

const clientId = 'synthetic-test.apps.googleusercontent.com';
const full = { success: true, result: { _id: 'customer-id', email: 'test@example.com', accountType: 'standard', isEnterprise: false }, token: 'synthetic-full-session', twoFactorSetup: false };
const twoFactor = { success: true, requiresTwoFactor: true, twoFactorSetup: true, tempToken: 'synthetic-temp-session', result: { _id: 'customer-id', email: 'test@example.com' } };
type Options = Parameters<typeof browserAuth>[1];
type Session = Awaited<ReturnType<typeof browserAuth>>;
type Outcome = { session: Session; error?: never } | { error: unknown; session?: never };
interface Call { path: string; body: unknown; method: string | undefined; headers: Headers }

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function local(port: number, path: string, options: { body?: unknown; raw?: string; method?: string; headers?: Record<string, string | undefined>; chunked?: boolean } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string; data: Record<string, unknown> }> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | undefined> = { host: `localhost:${port}`, origin: `http://localhost:${port}`, ...options.headers };
    if (payload !== undefined) {
      headers['content-type'] ??= 'application/json';
      if (!options.chunked) headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: '127.0.0.1', port, path, agent: false, method: options.method ?? (payload === undefined ? 'GET' : 'POST'), headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)) }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* Assets are not JSON. */ }
        resolve({ status: res.statusCode!, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Local test request timed out')));
    if (options.chunked && payload) { req.write(payload.slice(0, 100)); req.end(payload.slice(100)); }
    else req.end(payload);
  });
}

async function start(t: TestContext, response: (call: Call) => Promise<Response> | Response = () => Response.json(full), overrides: Partial<Options> = {}, context: Partial<Context> = {}) {
  const port = overrides.port ?? await freePort();
  const controller = new AbortController();
  const calls: Call[] = [];
  const warnings: string[] = [];
  let opened = 0;
  let ready!: (url: string) => void;
  const urlPromise = new Promise<string>(resolve => { ready = resolve; });
  const ctx: Context = {
    origin: 'https://api.example.com', env: {}, stdin: new PassThrough(), stderr: new PassThrough(), interactive: true, signal: controller.signal,
    http: new HttpClient('https://api.example.com', { fetch: async (input, init) => {
      const call = { path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) as unknown, method: init?.method, headers: new Headers(init?.headers) };
      calls.push(call);
      return response(call);
    } }),
    warn: async message => {
      warnings.push(message);
      if (overrides.noBrowser) ready(message.match(/http:\/\/localhost:\d+\/#\S+/)![0]);
    },
    openBrowser: async url => { opened++; ready(url); },
    ...context,
  };
  const result: Promise<Outcome> = browserAuth(ctx, { signup: false, noBrowser: false, port, clientId, ...overrides }).then(session => ({ session }), error => ({ error }));
  t.after(async () => { controller.abort(); await result; });
  const startResult = await Promise.race([urlPromise.then(url => ({ url })), result.then(outcome => ({ outcome }))]);
  if (!('url' in startResult)) throw startResult.outcome.error ?? new Error('Authentication completed before opening');
  const url = new URL(startResult.url);
  const nonce = url.hash.slice(1);
  return {
    port, ctx, calls, warnings, result, controller, url, nonce, opened: () => opened,
    post: (path: string, body: Record<string, unknown> = {}) => local(port, `/api/${path}`, { body: { nonce, ...body } }),
  };
}

function errorCode(outcome: Outcome): string {
  assert(outcome.error instanceof Error && 'code' in outcome.error);
  return String(outcome.error.code);
}

test('serves packaged assets with restrictive GIS-compatible headers and authenticates without browser secrets', async t => {
  let saved: Session | undefined;
  const h = await start(t, undefined, { onSession: async session => { saved = session; } });
  assert.equal(h.url.hostname, 'localhost');
  assert.equal(h.url.port, String(h.port));
  assert.equal(h.url.search, '');
  assert.match(h.nonce, /^[A-Za-z0-9_-]{43}$/);
  for (const path of ['/', '/auth.js', '/auth.css']) {
    const asset = await local(h.port, path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'no-store, max-age=0');
    assert.equal(asset.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(asset.headers['cross-origin-opener-policy'], 'same-origin-allow-popups');
    assert.equal(asset.headers['x-frame-options'], 'DENY');
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    assert.equal(asset.headers['access-control-allow-origin'], undefined);
    assert.match(String(asset.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.match(String(asset.headers['content-security-policy']), /https:\/\/accounts.google.com\/gsi\/client/);
    const policy = String(asset.headers['content-security-policy']);
    assert.doesNotMatch(policy.match(/(?:^|;\s*)script-src [^;]+/)![0], /unsafe-inline|unsafe-eval|nonce-/);
    assert.doesNotMatch(policy.match(/(?:^|;\s*)style-src [^;]+/)![0], /unsafe-inline/);
    assert.match(policy, /style-src-attr 'unsafe-inline'/);
    assert.match(policy, /font-src https:\/\/fonts.gstatic.com/);
    for (const value of [h.nonce, full.token, twoFactor.tempToken, clientId]) assert(!asset.text.includes(value));
  }
  const config = await h.post('config');
  assert.deepEqual(config.data, { success: true, clientId, signup: false, origin: h.ctx.origin, expiresAt: config.data.expiresAt });
  assert.equal(typeof config.data.expiresAt, 'number');
  assert(Number(config.data.expiresAt) > Date.now());
  assert(Number(config.data.expiresAt) <= Date.now() + 600_000);
  const acknowledgement = await h.post('google', { credential: 'synthetic-google-credential' });
  assert.deepEqual(acknowledgement.data, { success: true, state: 'complete' });
  assert.deepEqual(saved, { token: full.token, account: { email: 'test@example.com' } });
  assert.deepEqual((await h.result).session, saved);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.path, '/auth/google/login');
  assert.equal(h.calls[0]!.method, 'POST');
  assert.deepEqual(h.calls[0]!.body, { credential: 'synthetic-google-credential' });
  assert.equal(h.calls[0]!.headers.has('secret_token'), false);
  assert(!h.warnings.join('').includes(full.token));
});

test('GIS stylesheet nonce is per-flow, propagated by HTML, and cannot authorize authentication requests', async t => {
  const first = await start(t);
  const second = await start(t);
  const nonces: string[] = [];
  for (const h of [first, second]) {
    const html = await local(h.port, '/');
    const styleNonce = html.text.match(/<script src="\/auth.js" nonce="([A-Za-z0-9+/=]+)" defer>/)?.[1];
    assert.ok(styleNonce);
    assert.match(styleNonce, /^[A-Za-z0-9+/]{22}==$/);
    assert.ok(String(html.headers['content-security-policy']).includes(`'nonce-${styleNonce}'`));
    assert.doesNotMatch(html.text, /__GEODD_STYLE_NONCE__/);
    assert.notEqual(styleNonce, h.nonce);
    assert.equal((await h.post('google', { nonce: styleNonce, credential: 'synthetic-google' })).status, 403);
    assert.equal(h.calls.length, 0);
    nonces.push(styleNonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
});

test('signup requires separate explicit boolean consents and never forwards enterprise fields', async t => {
  const h = await start(t, undefined, { signup: true });
  const html = (await local(h.port, '/')).text;
  assert.match(html, /https:\/\/geodd.io\/legal\/terms-of-service/);
  assert.match(html, /https:\/\/geodd.io\/legal\/privacy-policy/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /\schecked[\s=>]/);
  for (const body of [
    { credential: 'google' },
    { credential: 'google', termsAgreed: true, privacyAcknowledged: false, marketingConsent: false },
    { credential: 'google', termsAgreed: 'true', privacyAcknowledged: true, marketingConsent: false },
    { credential: 'google', termsAgreed: true, privacyAcknowledged: true },
  ]) assert.equal((await h.post('google', body)).status, 400);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.post('google', { credential: 'google', termsAgreed: true, privacyAcknowledged: true, marketingConsent: false, isEnterprise: true, company: 'ignored' })).status, 200);
  assert.equal(h.calls[0]!.path, '/auth/google/register');
  assert.deepEqual(h.calls[0]!.body, { credential: 'google', termsAgreed: true, privacyAcknowledged: true, marketingConsent: false });
  assert((await h.result).session);
});

test('local Host, Origin, nonce, content type, body bounds, and routes are enforced before HTTP', async t => {
  const h = await start(t);
  for (const headers of [
    { host: `127.0.0.1:${h.port}` }, { host: `localhost:${h.port + 1}` }, { host: `LOCALHOST:${h.port}` },
    { origin: 'https://attacker.example' }, { origin: 'null' }, { origin: undefined }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await local(h.port, '/api/google', { body: { nonce: h.nonce, credential: 'google' }, headers })).status, 403);
  for (const nonce of ['', 'wrong', 'A'.repeat(43), '\u00e9'.repeat(43)]) assert.equal((await h.post('google', { nonce, credential: 'google' })).status, 403);
  assert.equal((await local(h.port, '/api/google', { raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await local(h.port, '/api/google', { raw: '{}', headers: { 'content-encoding': 'gzip' } })).status, 415);
  for (const raw of ['[1]', 'null', '{broken']) assert.equal((await local(h.port, '/api/google', { raw })).status, 400);
  for (const chunked of [false, true]) assert.equal((await local(h.port, '/api/google', { raw: 'x'.repeat(17 * 1024), chunked })).status, 413);
  for (const path of ['/api/google?nonce=bad', '/unknown', '/auth.js?nonce=bad']) assert.equal((await local(h.port, path, { body: { nonce: h.nonce } })).status, 404);
  assert.equal((await local(h.port, '/', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.post('config')).status, 200);
});

test('rejects Google replay during exchange and two-factor state without duplicate API calls', async t => {
  let release!: (response: Response) => void;
  let seen!: () => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { seen = resolve; });
  const h = await start(t, () => { seen(); return pending; });
  const first = h.post('google', { credential: 'google' });
  await requested;
  assert.equal((await h.post('google', { credential: 'replay' })).status, 409);
  release(Response.json(twoFactor));
  assert.equal((await first).data.state, 'two-factor');
  assert.equal((await h.post('google', { credential: 'replay' })).status, 409);
  assert.equal(h.calls.length, 1);
});

test('2FA keeps temporary state server-side, sends email only explicitly, and preserves leading zeros', async t => {
  const h = await start(t, call => {
    if (call.path === '/auth/google/login') return Response.json(twoFactor);
    if (call.path === '/auth/2fa/email/send') return Response.json({ success: true });
    assert.deepEqual(call.body, { tempToken: twoFactor.tempToken, code: '001234' });
    return Response.json({ ...full, twoFactorVerified: true });
  });
  const initial = await h.post('google', { credential: 'google' });
  assert.deepEqual(initial.data, { success: true, state: 'two-factor', expiresAt: initial.data.expiresAt });
  assert.equal(typeof initial.data.expiresAt, 'number');
  assert(Number(initial.data.expiresAt) <= Date.now() + 300_000);
  assert.equal(h.calls.length, 1);
  for (const code of [123456, '12345', '1234567', ' 123456', '12e345']) assert.equal((await h.post('verify', { code })).status, 400);
  assert.equal(h.calls.length, 1);
  assert.deepEqual((await h.post('email', { tempToken: 'browser-must-not-control-token' })).data, { success: true, state: 'email-sent' });
  assert.deepEqual(h.calls[1]!.body, { tempToken: twoFactor.tempToken });
  assert.equal((await h.post('email')).status, 429);
  const verified = await h.post('verify', { code: '001234', tempToken: 'ignored' });
  assert.deepEqual(verified.data, { success: true, state: 'complete' });
  assert.equal((await h.result).session?.token, full.token);
  assert.deepEqual(h.calls.map(call => call.path), ['/auth/google/login', '/auth/2fa/email/send', '/auth/2fa/verify']);
});

test('invalid 2FA can be retried manually but concurrent verification and email are rejected', async t => {
  let release!: (response: Response) => void;
  let seen!: () => void;
  const requested = new Promise<void>(resolve => { seen = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let attempts = 0;
  const h = await start(t, call => {
    if (call.path === '/auth/google/login') return Response.json(twoFactor);
    attempts++;
    if (attempts === 1) { seen(); return pending; }
    return Response.json({ ...full, twoFactorVerified: true });
  });
  await h.post('google', { credential: 'google' });
  const first = h.post('verify', { code: '000000' });
  await requested;
  assert.equal((await h.post('verify', { code: '111111' })).status, 409);
  assert.equal((await h.post('email')).status, 409);
  release(Response.json({ error: 'synthetic-secret-must-not-leak' }, { status: 401 }));
  const invalid = await first;
  assert.equal(invalid.status, 401);
  assert.doesNotMatch(invalid.text, /synthetic-secret/);
  assert.equal(attempts, 1);
  assert.equal((await h.post('verify', { code: '001234' })).status, 200);
  assert.equal(attempts, 2);
  assert((await h.result).session);
});

test('completed verification accepts unspecified metadata but rejects explicit verification contradictions', async t => {
  for (const flags of [{ twoFactorSetup: true, twoFactorVerified: true }, { twoFactorSetup: undefined, twoFactorVerified: undefined }]) {
    const h = await start(t, call => Response.json(call.path === '/auth/google/login' ? twoFactor : { ...full, ...flags }));
    await h.post('google', { credential: 'google' });
    assert.equal((await h.post('verify', { code: '001234' })).status, 200);
    assert((await h.result).session);
  }
  const minimal = await start(t, call => Response.json(call.path === '/auth/google/login' ? twoFactor : { success: true, token: full.token }));
  await minimal.post('google', { credential: 'google' });
  assert.equal((await minimal.post('verify', { code: '001234' })).status, 200);
  assert.deepEqual((await minimal.result).session, { token: full.token, account: {} });
  const h = await start(t, call => Response.json(call.path === '/auth/google/login' ? twoFactor : { ...full, twoFactorVerified: false }));
  await h.post('google', { credential: 'google' });
  assert.equal((await h.post('verify', { code: '001234' })).status, 502);
  assert.equal(errorCode(await h.result), 'MALFORMED_AUTH_RESPONSE');
});

test('explicit expired 2FA responses end the attempt, and email errors do not resend', async t => {
  for (const route of ['email', 'verify']) {
    const h = await start(t, call => call.path === '/auth/google/login' ? Response.json(twoFactor) : Response.json({ message: 'synthetic-temp-session' }, { status: 410 }));
    await h.post('google', { credential: 'google' });
    const expired = await h.post(route, { code: '001234' });
    assert.equal(expired.status, 410);
    assert.match(expired.text, /expired.*fresh login/);
    assert.doesNotMatch(expired.text, /synthetic-temp-session/);
    assert.equal(errorCode(await h.result), 'TWO_FACTOR_EXPIRED');
    assert.equal(h.calls.length, 2);
  }
  const h = await start(t, call => call.path === '/auth/google/login' ? Response.json(twoFactor) : Response.json({}, { status: 429 }));
  await h.post('google', { credential: 'google' });
  assert.equal((await h.post('email')).status, 429);
  assert.equal((await h.post('email')).status, 429);
  assert.equal(h.calls.length, 2);
});

test('upstream errors are static, actionable, never register automatically, and are not retried', async t => {
  for (const [status, expected] of [[404, /signup explicitly/], [409, /conflict/], [401, /Google rejected/], [400, /required values/], [429, /rate limit/], [503, /configuration/]] as const) {
    const h = await start(t, () => Response.json({ message: 'synthetic-google-credential synthetic-temp-session synthetic-full-session' }, { status }));
    const response = await h.post('google', { credential: 'synthetic-google-credential' });
    assert.equal(response.status, status);
    assert.match(response.text, expected);
    assert.doesNotMatch(response.text, /synthetic-/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.path, '/auth/google/login');
    assert((await h.result).error);
  }
});

test('rejects malformed and contradictory auth responses without persistence', async t => {
  for (const data of [
    {}, { ...full, success: false }, { ...full, token: '' }, { ...full, token: 'bad token' },
    { ...full, tempToken: 'temp' }, { ...full, requiresTwoFactor: true }, { ...full, twoFactorSetup: true },
    { ...full, twoFactorSetup: undefined }, { ...full, result: null }, { ...full, result: { email: 'x@example.com' } },
    { ...full, result: { _id: 'id', email: 'evil\n@example.com' } },
    { ...twoFactor, token: full.token }, { ...twoFactor, tempToken: undefined }, { ...twoFactor, twoFactorSetup: false },
    { ...twoFactor, twoFactorVerified: true },
  ]) {
    let persisted = false;
    const h = await start(t, () => Response.json(data), { onSession: async () => { persisted = true; } });
    assert.equal((await h.post('google', { credential: 'google' })).data.success, false);
    assert((await h.result).error);
    assert.equal(persisted, false);
  }
  const h = await start(t, call => Response.json(call.path === '/auth/google/login' ? twoFactor : { ...full, twoFactorVerified: 'true' }));
  await h.post('google', { credential: 'google' });
  assert.equal((await h.post('verify', { code: '001234' })).status, 502);
  assert.equal(errorCode(await h.result), 'MALFORMED_AUTH_RESPONSE');
});

test('persistence finishes before final acknowledgement and failure never claims browser success', async t => {
  let release!: () => void;
  let saving!: () => void;
  const saveStarted = new Promise<void>(resolve => { saving = resolve; });
  const saveFinished = new Promise<void>(resolve => { release = resolve; });
  const h = await start(t, undefined, { onSession: async () => { saving(); await saveFinished; } });
  let acknowledged = false;
  const response = h.post('google', { credential: 'google' }).then(value => { acknowledged = true; return value; });
  await saveStarted;
  assert.equal(acknowledged, false);
  assert.equal((await h.post('cancel')).status, 409);
  release();
  assert.equal((await response).data.state, 'complete');
  assert((await h.result).session);
  const failed = await start(t, undefined, { onSession: async () => { throw new Error('synthetic-full-session secret filesystem error'); } });
  const acknowledgement = await failed.post('google', { credential: 'google' });
  assert.equal(acknowledgement.status, 500);
  assert.doesNotMatch(acknowledgement.text, /synthetic-full-session|secret filesystem/);
  assert.equal(errorCode(await failed.result), 'SESSION_SAVE_FAILED');
  const denied = await start(t, undefined, { onSession: async () => { throw new CliError('AUTH_FORBIDDEN', 'Complete required 2FA with a fresh login.', 3, 403); } });
  assert.equal((await denied.post('google', { credential: 'google' })).status, 403);
  const outcome = await denied.result;
  assert.equal(errorCode(outcome), 'AUTH_FORBIDDEN');
  assert(outcome.error instanceof CliError);
  assert.equal(outcome.error.exitCode, 3);
});

test('a lost final browser connection cannot undo a completed saved session', async t => {
  let saving!: () => void;
  let release!: () => void;
  const saveStarted = new Promise<void>(resolve => { saving = resolve; });
  const saveFinished = new Promise<void>(resolve => { release = resolve; });
  const h = await start(t, undefined, { onSession: async () => { saving(); await saveFinished; } });
  const payload = JSON.stringify({ nonce: h.nonce, credential: 'google' });
  const req = request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/api/google', headers: { host: `localhost:${h.port}`, origin: h.url.origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } });
  req.on('error', () => {});
  req.end(payload);
  await saveStarted;
  req.destroy();
  release();
  assert.equal((await h.result).session?.token, full.token);
});

test('explicit no-browser works noninteractively without opening a browser', async t => {
  const h = await start(t, undefined, { noBrowser: true }, { interactive: false });
  assert.equal(h.opened(), 0);
  assert.equal((await h.post('google', { credential: 'google' })).status, 200);
  assert((await h.result).session);
});

test('rejects non-TTY implicit browser opening, invalid ports and missing client configuration', async t => {
  const h = await start(t);
  for (const [options, context, code] of [
    [{}, { interactive: false }, 'INTERACTIVE_REQUIRED'],
    [{ port: 0 }, {}, 'INVALID_PORT'], [{ port: 65536 }, {}, 'INVALID_PORT'],
    [{ clientId: '' }, {}, 'GOOGLE_CONFIG_MISSING'], [{ lifetimeMs: 0 }, {}, 'INVALID_LIFETIME'],
  ] as const) await assert.rejects(browserAuth({ ...h.ctx, ...context }, { signup: false, noBrowser: false, port: h.port, clientId, ...options }), { code });
});

test('port collisions fail without choosing a random fallback port', async t => {
  const h = await start(t);
  await assert.rejects(browserAuth(h.ctx, { signup: false, noBrowser: false, port: h.port, clientId }), { code: 'BROWSER_PORT_IN_USE' });
  assert.equal(h.opened(), 1);
});

test('browser opener failures and GIS failure reports are actionable and clean up', async t => {
  const h = await start(t);
  const port = await freePort();
  await assert.rejects(browserAuth({ ...h.ctx, openBrowser: async () => { throw new Error('unsafe opener detail'); } }, { signup: false, noBrowser: false, port, clientId }), { code: 'BROWSER_OPEN_FAILED', message: /--no-browser/ });
  const response = await h.post('error', { message: 'unsafe browser detail' });
  assert.match(response.text, /script blockers/);
  assert.doesNotMatch(response.text, /unsafe browser detail/);
  assert.equal(errorCode(await h.result), 'GOOGLE_SCRIPT_FAILED');
});

test('cancellation, abort and lifetime expiration close the exact port and discard active state', async t => {
  for (const mode of ['cancel', 'abort', 'timeout', 'two-factor'] as const) {
    const h = await start(t, () => Response.json(twoFactor), mode === 'timeout' ? { lifetimeMs: 80 } : mode === 'two-factor' ? { twoFactorLifetimeMs: 80 } : {});
    if (mode === 'cancel') await h.post('cancel');
    if (mode === 'abort') h.controller.abort();
    if (mode === 'two-factor') await h.post('google', { credential: 'google' });
    assert.equal(errorCode(await h.result), { cancel: 'AUTH_CANCELLED', abort: 'INTERRUPTED', timeout: 'BROWSER_AUTH_TIMEOUT', 'two-factor': 'TWO_FACTOR_EXPIRED' }[mode]);
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(local(h.port, '/'), { code: 'ECONNREFUSED' });
  }
});

test('late upstream success after abort is never persisted', async t => {
  let release!: (response: Response) => void;
  let seen!: () => void;
  const requestStarted = new Promise<void>(resolve => { seen = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let persisted = false;
  const h = await start(t, () => { seen(); return pending; }, { onSession: async () => { persisted = true; } });
  const requestResult = h.post('google', { credential: 'google' }).catch(() => undefined);
  await requestStarted;
  h.controller.abort();
  assert.equal(errorCode(await h.result), 'INTERRUPTED');
  release(Response.json(full));
  await requestResult;
  assert.equal(persisted, false);
});

test('authentication lifetime overrides cannot exceed ten minutes or five minutes for 2FA', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = await start(t, undefined, { lifetimeMs: 900_000 });
  t.mock.timers.tick(600_000);
  assert.equal(errorCode(await h.result), 'BROWSER_AUTH_TIMEOUT');
  const two = await start(t, () => Response.json(twoFactor), { twoFactorLifetimeMs: 900_000 });
  await two.post('google', { credential: 'google' });
  t.mock.timers.tick(300_000);
  assert.equal(errorCode(await two.result), 'TWO_FACTOR_EXPIRED');
});

test('a real SIGINT closes the listener and exits with a safe interruption result', async () => {
  const port = await freePort();
  const script = `
    import { browserAuth } from ${JSON.stringify(new URL('../src/browser-auth.js', import.meta.url).href)};
    const controller = new AbortController();
    try {
      await browserAuth({
        interactive: true, signal: controller.signal, origin: 'https://api.example.com',
        warn: async () => {}, openBrowser: async () => { process.kill(process.pid, 'SIGINT'); }
      }, { signup: false, noBrowser: false, port: ${port}, clientId: ${JSON.stringify(clientId)} });
    } catch (error) { console.log(JSON.stringify({ code: error.code, exitCode: error.exitCode })); }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), { code: 'INTERRUPTED', exitCode: 130 });
  assert.equal(stderr, '');
  await assert.rejects(local(port, '/'), { code: 'ECONNREFUSED' });
});

test('cancellation aborts the real in-flight API transport rather than waiting for its timeout', async t => {
  let started!: () => void;
  let closed!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const api = createServer(req => {
    req.socket.once('close', closed);
    req.resume();
    started();
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => { api.close(); api.closeAllConnections(); });
  const address = api.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const h = await start(t, undefined, {}, { origin, http: new HttpClient(origin) });
  const pending = h.post('google', { credential: 'synthetic-google' }).catch(() => undefined);
  await received;
  await h.post('cancel');
  assert.equal(errorCode(await h.result), 'AUTH_CANCELLED');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([disconnected, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancelled API transport remained open')), 1000); })]);
  } finally { clearTimeout(timer); }
  await pending;
});

test('HTTP transport integrates against a real local mock API without production credentials', async t => {
  const api = createServer((req, res) => {
    assert.equal(req.url, '/auth/google/login');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.secret_token, undefined);
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { credential: 'local-mock-credential' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(full));
    });
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => { api.close(); api.closeAllConnections(); });
  const address = api.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const h = await start(t, undefined, {}, { origin, http: new HttpClient(origin) });
  assert.equal((await h.post('google', { credential: 'local-mock-credential' })).status, 200);
  assert.equal((await h.result).session?.token, full.token);
});
