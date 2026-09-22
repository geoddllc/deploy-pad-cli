import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'node:net';
import { runCli, type Runtime } from '../src/app.js';

export async function invoke(args: string[], runtime: Runtime = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(chunk, _encoding, callback) { out += chunk.toString(); callback(); } });
  const stderr = new Writable({ write(chunk, _encoding, callback) { err += chunk.toString(); callback(); } });
  const code = await runCli(args, { env: {}, stdin: Readable.from([]), interactive: false, stdoutIsTTY: false, ...runtime, stdout, stderr });
  return { code, out, err };
}

test('root/subcommand help and version are ordinary text', async () => {
  for (const args of [[], ['--help'], ['models', '--help'], ['auth', 'login', '--help'], ['keys', '--help'], ['--version', '--json']]) {
    const result = await invoke(args);
    assert.equal(result.code, 0, result.out);
    assert.ok(result.out.length > 0);
    assert.doesNotMatch(result.out, /"success"/);
  }
});

test('invalid arguments produce one safe usage envelope and exit 2', async () => {
  for (const args of [['unknown-secret-command'], ['models', 'show'], ['models', 'list', 'unexpected'], ['models', 'list', '--unknown-secret-flag'], ['--json', '--text', 'models', 'list'], ['auth', 'signup', '--yes'], ['auth', 'login', '--token', 'synthetic-secret']]) {
    const result = await invoke(args);
    assert.equal(result.code, 2, result.out);
    const output = JSON.parse(result.out);
    assert.deepEqual(output, { success: false, error: { code: 'USAGE', message: 'Invalid, missing, conflicting, or unknown command arguments. Run geodd --help or the subcommand with --help.' } });
    assert.doesNotMatch(result.out + result.err, /synthetic-secret|unknown-secret/);
    assert.equal(result.out.trim().split('\n').length, 1);
  }
});

test('public models ignore environment credentials and select formats', async () => {
  let calls = 0;
  const mock: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).has('secret_token'), false);
    return Response.json({ data: [{ id: 'Vendor/Model', unknown: 1 }] });
  };
  const runtime = { fetch: mock, env: { GEODD_SESSION_TOKEN: 'synthetic-session' } };
  const piped = await invoke(['models', 'list'], runtime);
  assert.deepEqual(JSON.parse(piped.out), { success: true, data: [{ id: 'Vendor/Model', unknown: 1 }] });
  assert.equal(piped.err, '');
  const terminal = await invoke(['models', 'list'], { ...runtime, stdoutIsTTY: true });
  assert.match(terminal.out, /ID.*READY/);
  const json = await invoke(['models', 'list', '--json'], { ...runtime, stdoutIsTTY: true });
  assert.equal(JSON.parse(json.out).success, true);
  const text = await invoke(['--text', 'models', 'list'], runtime);
  assert.match(text.out, /unknown/);
  assert.equal(calls, 4);
});

test('errors have stable exit codes, no raw API diagnostic strings or ANSI', async () => {
  const result = await invoke(['models', 'list'], { fetch: async () => Response.json({ secret: 'private-upstream-value\u001b[31m' }, { status: 429 }) });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).error.code, 'THROTTLED');
  assert.equal(JSON.parse(result.out).error.status, 429);
  assert.doesNotMatch(result.out + result.err, /private-upstream-value|\u001b/);
});

test('browser flow requires explicit local opt-in and valid configuration', async () => {
  assert.equal(JSON.parse((await invoke(['auth', 'login'])).out).error.code, 'BROWSER_REQUIRES_INTERACTIVE');
  assert.equal(JSON.parse((await invoke(['auth', 'login', '--no-browser'])).out).error.code, 'GOOGLE_NOT_CONFIGURED');
  for (const port of ['0', '-1', '65536', '1.5', 'garbage']) assert.equal(JSON.parse((await invoke(['auth', 'login', '--no-browser', '--port', port])).out).error.code, 'INVALID_PORT');
});

test('session import validates supplied token directly, discards PII, and status uses environment precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geodd-cli-'));
  try {
    const env = { GEODD_CONFIG_DIR: directory, GEODD_SESSION_TOKEN: 'environment-session' };
    const imported = 'imported-session';
    const tokens: string[] = [];
    const paths: string[] = [];
    const mock: typeof fetch = async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      tokens.push(new Headers(init?.headers).get('secret_token')!);
      return Response.json(String(url).endsWith('customer-info')
        ? { success: true, address: 'private-address', token: 'private-response-token' }
        : { enabled: true, setupComplete: true, email: 'test@example.com', unrelated: 'private-field' });
    };
    const login = await invoke(['auth', 'login', '--token-stdin'], { env, stdin: Readable.from([` ${imported}\n`]), fetch: mock });
    assert.equal(login.code, 0, login.out);
    assert.deepEqual(tokens, [imported, imported]);
    assert.deepEqual(paths, ['/console/customer-info', '/console/2fa/status']);
    assert.equal(JSON.parse(login.out).data.email, 'test@example.com');
    assert.match(login.err, /still takes precedence/);
    assert.doesNotMatch(login.out + login.err, /private-address|private-response-token|private-field|imported-session|environment-session/);
    const status = await invoke(['auth', 'status'], { env, fetch: mock });
    assert.equal(status.code, 0, status.out);
    assert.equal(JSON.parse(status.out).data.source, 'environment');
    assert.deepEqual(tokens.slice(2), ['environment-session', 'environment-session']);
    const logout = await invoke(['auth', 'logout'], { env });
    assert.equal(JSON.parse(logout.out).data.removed, true);
    assert.equal(JSON.parse(logout.out).data.remoteRevoked, false);
    assert.match(logout.err, /cannot unset/);
    assert.equal(JSON.parse((await invoke(['auth', 'logout'], { env })).out).data.removed, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('status does not trust 2fa bypass route without protected authorization', async () => {
  let calls = 0;
  const result = await invoke(['auth', 'status'], { env: { GEODD_SESSION_TOKEN: 'session' }, fetch: async url => {
    calls++;
    assert.match(String(url), /customer-info$/);
    return Response.json({ secret: 'no-leak' }, { status: 403 });
  } });
  assert.equal(result.code, 3);
  assert.equal(calls, 1);
  assert.doesNotMatch(result.out, /no-leak/);
});

test('failed session import never persists or implicitly falls back to environment credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'geodd-invalid-import-'));
  try {
    for (const response of [Response.json({ message: 'synthetic-private-value' }, { status: 401 }), Response.json({ success: false, token: 'synthetic-private-value' }), Response.json({ requiresTwoFactor: true }), Response.json(null)]) {
      let calls = 0;
      const result = await invoke(['auth', 'login', '--token-stdin'], {
        env: { GEODD_CONFIG_DIR: dir, GEODD_SESSION_TOKEN: 'overriding-environment-token' }, stdin: Readable.from(['supplied-token']),
        fetch: async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get('secret_token'), 'supplied-token'); return response; },
      });
      assert.notEqual(result.code, 0);
      assert.equal(calls, 1);
      assert.doesNotMatch(result.out + result.err, /synthetic-private-value|supplied-token|overriding-environment-token/);
      assert.equal((await invoke(['auth', 'status'], { env: { GEODD_CONFIG_DIR: dir } })).code, 3);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit origin wins over environment and console credentials never cross origins', async () => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async url => { seen.push(String(url)); return Response.json({ data: [] }); };
  assert.equal((await invoke(['models', 'list', '--api-url', 'https://explicit.example/'], { env: { GEODD_API_URL: 'https://environment.example' }, fetch: fetcher })).code, 0);
  assert.deepEqual(seen, ['https://explicit.example/inference/v1/models']);
  let called = false;
  const rejected = await invoke(['auth', 'status', '--api-url', 'https://staging.example'], { env: { GEODD_SESSION_TOKEN: 'production-token' }, fetch: async () => { called = true; return Response.json({}); } });
  assert.equal(rejected.code, 3);
  assert.equal(called, false);
  assert.doesNotMatch(rejected.out + rejected.err, /production-token/);
});

test('local validation and missing authentication do not send API requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'geodd-no-auth-'));
  try {
    const runtime = { env: { GEODD_CONFIG_DIR: dir }, fetch: async () => { throw new Error('must not fetch'); } };
    assert.equal((await invoke(['auth', 'status'], runtime)).code, 3);
    assert.equal((await invoke(['auth', 'login', '--token-stdin', '--no-browser'], runtime)).code, 2);
    assert.equal((await invoke(['models', 'list', '--api-url', 'http://evil.example'], runtime)).code, 2);
    const invalid = await invoke(['auth', 'login', '--token-stdin'], { ...runtime, stdin: Readable.from(['one\ntwo']) });
    assert.equal(invalid.code, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser CLI validates full authorization before saving, without printing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'geodd-browser-cli-'));
  try {
    for (const authorized of [true, false]) {
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const address = reservation.address();
      assert.ok(address && typeof address === 'object');
      const port = address.port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const origin = authorized ? 'https://allowed.example' : 'https://forbidden.example';
      const env = { GEODD_CONFIG_DIR: dir, GEODD_API_URL: origin, GEODD_GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com' };
      const paths: string[] = [];
      const result = await invoke(['auth', 'login', '--port', String(port)], {
        env, interactive: true,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          paths.push(path);
          if (path === '/auth/google/login') {
            assert.equal(new Headers(init?.headers).has('secret_token'), false);
            assert.deepEqual(JSON.parse(init?.body as string), { credential: 'synthetic-google-credential' });
            return Response.json({ success: true, token: 'synthetic-completed-session', result: { _id: 'user', email: 'person@example.com' }, twoFactorSetup: false });
          }
          assert.equal(path, '/console/customer-info');
          assert.equal(new Headers(init?.headers).get('secret_token'), 'synthetic-completed-session');
          return Response.json({ success: authorized, privateData: 'discard-customer-data' }, { status: authorized ? 200 : 403 });
        },
        openBrowser: async value => {
          const url = new URL(value);
          const response = await fetch(`${url.origin}/api/google`, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ nonce: url.hash.slice(1), credential: 'synthetic-google-credential' }) });
          assert.equal(response.status, authorized ? 200 : 403);
        },
      });
      assert.equal(result.code, authorized ? 0 : 3, result.out);
      assert.deepEqual(paths, ['/auth/google/login', '/console/customer-info']);
      assert.doesNotMatch(result.out + result.err, /synthetic-google-credential|synthetic-completed-session|discard-customer-data/);
      assert.match(result.err, /http:\/\/localhost:\d+\/#/);
      assert.equal(result.out.trim().split('\n').length, 1);
      const logout = await invoke(['auth', 'logout'], { env });
      assert.equal(JSON.parse(logout.out).data.removed, authorized);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
