import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { describe, test, type TestContext } from 'node:test';
import { apiOrigin, configDirectory, googleClientId, normalizeOrigin, PRODUCTION_ORIGIN } from '../src/config.js';
import { asCliError, CliError, interrupted, isRecord, safeText } from '../src/errors.js';
import { HttpClient, httpError, type RequestOptions } from '../src/http.js';
import { outputMode, printResult, writeOutput } from '../src/output.js';

const secrets = ['synthetic-session-secret', 'synthetic-google-credential', 'synthetic-key-secret', 'synthetic-temp-token', '001234'];
const hostileBody = JSON.stringify({
  success: false,
  message: `\u001b[31m${secrets.join(' ')}\u001b[0m`,
  secret_token: secrets[0],
  credential: secrets[1],
  key: secrets[2],
  tempToken: secrets[3],
  code: secrets[4],
});

function cliFailure(code: string, exitCode = 1, status?: number): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    assert.equal(error.status, status);
    for (const secret of secrets) assert.ok(!String(error).includes(secret), 'diagnostics must not contain credentials');
    assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
    return true;
  };
}

async function localServer(t: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function captureOutput(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

describe('origin configuration', () => {
  const valid = [
    ['https://api.geodd.io', PRODUCTION_ORIGIN],
    ['https://api.geodd.io/', PRODUCTION_ORIGIN],
    ['HTTPS://API.GEODD.IO:443/', PRODUCTION_ORIGIN],
    ['https://staging.example:8443/', 'https://staging.example:8443'],
    ['https://remote.example/', 'https://remote.example'],
    ['http://localhost', 'http://localhost'],
    ['HTTP://LOCALHOST:80/', 'http://localhost'],
    ['http://localhost:43187/', 'http://localhost:43187'],
    ['http://127.0.0.1:80/', 'http://127.0.0.1'],
    ['http://127.0.0.1:43187', 'http://127.0.0.1:43187'],
    ['http://[::1]:80/', 'http://[::1]'],
    ['http://[::1]:43187/', 'http://[::1]:43187'],
  ] as const;
  for (const [input, expected] of valid) {
    test(`canonicalizes ${input}`, () => assert.equal(normalizeOrigin(input), expected));
  }

  const invalid = [
    '', 'api.geodd.io', '//api.geodd.io', 'ftp://api.geodd.io',
    ' https://api.geodd.io', 'https://api.geodd.io ', 'https://api.geodd.io\n',
    'https://api.geodd.io/path', 'https://api.geodd.io//', 'https://api.geodd.io/.',
    'https://api.geodd.io/%2e', 'https://api.geodd.io?token=hidden', 'https://api.geodd.io?',
    'https://api.geodd.io#hidden', 'https://api.geodd.io#', 'https://api.geodd.io\\path',
    'https://user:password@api.geodd.io', 'https://user@api.geodd.io',
    'https://:password@api.geodd.io', 'https://@api.geodd.io', 'https://:@api.geodd.io',
    'https://api.geodd.io:65536', 'https://[::1',
    'http://api.geodd.io', 'http://0.0.0.0', 'http://127.0.0.2',
    'http://localhost.example', 'http://sub.localhost', 'http://localhost.',
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://[0:0:0:0:0:0:0:1]', 'http://[::ffff:127.0.0.1]',
  ];
  for (const input of invalid) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      assert.throws(() => normalizeOrigin(input), cliFailure('INVALID_ORIGIN', 2));
    });
  }

  test('uses explicit origin, then environment, then production', () => {
    assert.equal(apiOrigin(undefined, {}), PRODUCTION_ORIGIN);
    assert.equal(apiOrigin(undefined, { GEODD_API_URL: 'https://ENV.example:443/' }), 'https://env.example');
    assert.equal(apiOrigin('http://localhost:8080/', { GEODD_API_URL: 'https://env.example' }), 'http://localhost:8080');
    assert.equal(apiOrigin(PRODUCTION_ORIGIN, { GEODD_API_URL: 'invalid' }), PRODUCTION_ORIGIN);
  });

  test('does not silently fall back from an invalid selected origin', () => {
    assert.throws(() => apiOrigin('', { GEODD_API_URL: PRODUCTION_ORIGIN }), cliFailure('INVALID_ORIGIN', 2));
    assert.throws(() => apiOrigin(undefined, { GEODD_API_URL: '' }), cliFailure('INVALID_ORIGIN', 2));
    assert.throws(() => apiOrigin(undefined, { GEODD_API_URL: 'http://remote.example' }), cliFailure('INVALID_ORIGIN', 2));
  });
});

describe('local and Google configuration', () => {
  test('resolves an explicit config directory before platform defaults', () => {
    const env = { GEODD_CONFIG_DIR: './isolated-config', XDG_CONFIG_HOME: '/ignored-xdg', LOCALAPPDATA: '/ignored-local' };
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      assert.equal(configDirectory(env, platform), resolve('./isolated-config'));
    }
    assert.equal(configDirectory({ GEODD_CONFIG_DIR: resolve('absolute-config') }), resolve('absolute-config'));
  });

  test('rejects empty config overrides rather than using the current directory', () => {
    for (const value of ['', ' ', '\t\n']) {
      assert.throws(() => configDirectory({ GEODD_CONFIG_DIR: value }), cliFailure('INVALID_CONFIG_DIR', 2));
    }
  });

  test('uses platform-specific per-user config defaults', () => {
    assert.equal(configDirectory({}, 'darwin'), join(homedir(), 'Library', 'Application Support', 'geodd'));
    assert.equal(configDirectory({ XDG_CONFIG_HOME: '/ignored' }, 'darwin'), join(homedir(), 'Library', 'Application Support', 'geodd'));
    assert.equal(configDirectory({}, 'linux'), join(homedir(), '.config', 'geodd'));
    assert.equal(configDirectory({ XDG_CONFIG_HOME: '/isolated-xdg' }, 'linux'), join('/isolated-xdg', 'geodd'));
    assert.equal(configDirectory({ LOCALAPPDATA: '/isolated-local' }, 'win32'), join('/isolated-local', 'geodd'));
    assert.equal(configDirectory({}, 'win32'), join(homedir(), 'AppData', 'Local', 'geodd'));
  });

  test('accepts a configured Google Web Client ID without modifying it', () => {
    const id = '1234567890-test_Client.apps.googleusercontent.com';
    assert.equal(googleClientId({ GEODD_GOOGLE_CLIENT_ID: id }), id);
  });

  test('fails browser configuration clearly without requiring it for other config', () => {
    assert.throws(() => googleClientId({}), (error) => {
      cliFailure('GOOGLE_NOT_CONFIGURED', 2)(error);
      assert.ok(error instanceof CliError);
      assert.match(error.message, /GEODD_GOOGLE_CLIENT_ID/);
      assert.match(error.message, /localhost.*port/);
      assert.match(error.message, /Supplied sessions and public models do not need/);
      return true;
    });
    assert.equal(apiOrigin(undefined, { GEODD_GOOGLE_CLIENT_ID: 'invalid' }), PRODUCTION_ORIGIN);
    assert.equal(configDirectory({ GEODD_GOOGLE_CLIENT_ID: 'invalid' }, 'linux'), join(homedir(), '.config', 'geodd'));
  });

  test('rejects empty, malformed, secret-like and whitespace Google overrides', () => {
    for (const id of ['', ' ', secrets[1]!, '123.apps.googleusercontent.com.attacker.example',
      '.apps.googleusercontent.com', 'https://123.apps.googleusercontent.com',
      '123.apps.googleusercontent.com\n', ' 123.apps.googleusercontent.com']) {
      assert.throws(() => googleClientId({ GEODD_GOOGLE_CLIENT_ID: id }), cliFailure('GOOGLE_NOT_CONFIGURED', 2));
    }
  });
});

describe('safe errors', () => {
  test('preserves known CLI errors and defaults', () => {
    const failure = new CliError('KNOWN', 'Safe explanation.', 3, 401);
    assert.equal(asCliError(failure), failure);
    assert.equal(failure.name, 'CliError');
    const defaultFailure = new CliError('DEFAULT', 'Safe default.');
    assert.equal(defaultFailure.exitCode, 1);
    assert.equal(defaultFailure.status, undefined);
    cliFailure('INTERRUPTED', 130)(interrupted());
  });

  test('replaces unknown exceptions without exposing their contents', () => {
    for (const error of [new Error(hostileBody), hostileBody, { message: hostileBody }, undefined, null]) {
      cliFailure('UNEXPECTED_ERROR')(asCliError(error));
    }
  });

  test('recognizes JSON object records without accepting arrays or primitives', () => {
    for (const value of [{}, { success: false }, Object.create(null) as unknown]) assert.equal(isRecord(value), true);
    for (const value of [null, undefined, [], ['value'], 'value', 0, false]) assert.equal(isRecord(value), false);
  });

  test('removes terminal controls and bidi controls while retaining printable Unicode', () => {
    const controls = [
      ...Array.from({ length: 32 }, (_, index) => index),
      ...Array.from({ length: 33 }, (_, index) => 0x7f + index),
      ...Array.from({ length: 7 }, (_, index) => 0x2028 + index),
      ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
    ].map((code) => String.fromCharCode(code)).join('');
    assert.equal(safeText(`before${controls}after caf\u00e9 \u65e5\u672c`), 'beforeafter caf\u00e9 \u65e5\u672c');
    assert.equal(safeText('\u001b[31mred\u001b[0m'), '[31mred[0m');
  });
});

describe('HTTP requests and credential isolation', () => {
  test('sends JSON with secret_token exactly as supplied and never a Bearer header', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ accepted: true });
    };
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: mockFetch });
    const body = { name: 'test-key', models: ['Example/Exact-ID'] };
    assert.deepEqual(await client.request('/console/api-keys/generate', {
      method: 'POST', token: secrets[0]!, body, mutation: true, context: 'console',
    }), { accepted: true });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${PRODUCTION_ORIGIN}/console/api-keys/generate`);
    assert.ok(call.init);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'manual');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.body, JSON.stringify(body));
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('secret_token'), secrets[0]);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('cookie'), null);
  });

  test('public requests do not acquire a credential from previous requests', async () => {
    const calls: RequestInit[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      assert.ok(init);
      calls.push(init);
      return Response.json({ data: [] });
    };
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: mockFetch });
    await client.request('/inference/v1/models');
    await client.request('/console/customer-info', { token: secrets[0]! });
    await client.request('/inference/v1/models');
    await client.request('/inference/v1/models', { token: secrets[0]! });
    for (const index of [0, 2]) {
      const init = calls[index]!;
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.deepEqual([...new Headers(init.headers)], [['accept', 'application/json']]);
    }
    for (const index of [1, 3]) assert.equal(new Headers(calls[index]!.headers).get('secret_token'), secrets[0]);
  });

  test('Google exchanges use an explicit JSON credential, not a console or Bearer header', async () => {
    const mockFetch: typeof fetch = async (_input, init) => {
      assert.ok(init);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('secret_token'), null);
      assert.equal(headers.get('authorization'), null);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.body, JSON.stringify({ credential: secrets[1] }));
      return Response.json({ token: secrets[0] });
    };
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: mockFetch });
    assert.deepEqual(await client.request('/auth/google/login', {
      method: 'POST', body: { credential: secrets[1] }, context: 'google-login',
    }), { token: secrets[0] });
  });

  test('refuses foreign or non-absolute routes before calling fetch', async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => { calls++; return Response.json({}); };
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: mockFetch });
    for (const path of ['', 'console/customer-info', 'https://attacker.example/path', '//attacker.example/path', '/\\attacker.example/path']) {
      await assert.rejects(client.request(path, { token: secrets[0]! }), cliFailure('INVALID_ROUTE', 2));
    }
    assert.equal(calls, 0);
  });

  test('preserves DELETE and does not invent an absent JSON body', async () => {
    const mockFetch: typeof fetch = async (_input, init) => {
      assert.ok(init);
      assert.equal(init.method, 'DELETE');
      assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).get('content-type'), null);
      return new Response(null, { status: 204 });
    };
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: mockFetch });
    assert.equal(await client.request('/console/api-keys/test-id', { method: 'DELETE', allowEmpty: true, mutation: true }), null);
  });
});

describe('HTTP response validation', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`rejects ${status} redirects without following or leaking credentials`, async (t) => {
      let originalRequests = 0;
      let redirectedRequests = 0;
      const destination = await localServer(t, (_request, response) => {
        redirectedRequests++;
        response.end('{}');
      });
      const origin = await localServer(t, (_request, response) => {
        originalRequests++;
        response.writeHead(status, { location: `${destination}/credential-sink` });
        response.end(hostileBody);
      });
      const client = new HttpClient(origin);
      await assert.rejects(client.request('/auth/google/login', {
        method: 'POST', token: secrets[0]!, body: { credential: secrets[1] }, context: 'google-login',
      }), cliFailure('REDIRECT_REJECTED', 1, status));
      assert.equal(originalRequests, 1);
      assert.equal(redirectedRequests, 0);
    });
  }

  test('rejects same-origin redirects as well as cross-origin redirects', async (t) => {
    const paths: (string | undefined)[] = [];
    const origin = await localServer(t, (request, response) => {
      paths.push(request.url);
      if (request.url === '/target') response.end('{}');
      else { response.writeHead(302, { location: '/target' }); response.end(); }
    });
    await assert.rejects(new HttpClient(origin).request('/start'), cliFailure('REDIRECT_REJECTED', 1, 302));
    assert.deepEqual(paths, ['/start']);
  });

  test('preserves valid JSON values and unknown response fields', async () => {
    for (const payload of [{ data: [], extension: { preserved: true } }, [1, 'value'], null, false, 'value', 42]) {
      const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: async () => Response.json(payload) });
      assert.deepEqual(await client.request('/resource'), payload);
    }
  });

  test('accepts an empty 204 only when the operation explicitly allows it', async () => {
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: async () => new Response(null, { status: 204 }) });
    assert.equal(await client.request('/resource', { allowEmpty: true }), null);
    await assert.rejects(client.request('/resource'), cliFailure('MALFORMED_RESPONSE'));
    await assert.rejects(client.request('/resource', { mutation: true }), (error) => {
      cliFailure('MALFORMED_RESPONSE')(error);
      assert.ok(error instanceof CliError);
      assert.match(error.message, /outcome is uncertain.*Do not blindly retry/);
      return true;
    });
  });

  test('rejects malformed or empty JSON without quoting remote content', async () => {
    for (const body of ['', ' ', '{"broken":', '<html>synthetic-session-secret</html>', '{"x":1} trailing']) {
      const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: async () => new Response(body) });
      await assert.rejects(client.request('/resource', { allowEmpty: true }), cliFailure('MALFORMED_RESPONSE'));
    }
  });

  test('cancels a response whose declared size exceeds the limit', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const client = new HttpClient(PRODUCTION_ORIGIN, {
      maxBytes: 16,
      fetch: async () => new Response(stream, { headers: { 'content-length': '17' } }),
    });
    await assert.rejects(client.request('/resource'), cliFailure('RESPONSE_TOO_LARGE'));
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });

  for (const declaredLength of [undefined, '1']) {
    test(`bounds streamed bytes with ${declaredLength === undefined ? 'absent' : 'dishonest'} content-length`, async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('"1234567'));
          controller.enqueue(Buffer.from('89"'));
        },
        cancel() { cancelled = true; },
      });
      const client = new HttpClient(PRODUCTION_ORIGIN, {
        maxBytes: 10,
        fetch: async () => new Response(stream, declaredLength === undefined ? {} : { headers: { 'content-length': declaredLength } }),
      });
      await assert.rejects(client.request('/resource', { mutation: true }), (error) => {
        cliFailure('RESPONSE_TOO_LARGE')(error);
        assert.ok(error instanceof CliError);
        assert.match(error.message, /outcome is uncertain.*Do not blindly retry/);
        return true;
      });
      assert.equal(cancelled, true);
      assert.equal(stream.locked, false);
    });
  }

  test('accepts the exact byte limit and UTF-8 split across chunks', async () => {
    const payload = { value: 'caf\u00e9' };
    const encoded = Buffer.from(JSON.stringify(payload));
    const client = new HttpClient(PRODUCTION_ORIGIN, {
      maxBytes: encoded.byteLength,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }), { headers: { 'content-length': String(encoded.byteLength) } }),
    });
    assert.deepEqual(await client.request('/resource'), payload);
    const tooSmall = new HttpClient(PRODUCTION_ORIGIN, {
      maxBytes: JSON.stringify(payload).length,
      fetch: async () => new Response(encoded),
    });
    await assert.rejects(tooSmall.request('/resource'), cliFailure('RESPONSE_TOO_LARGE'));
  });

  for (const context of [undefined, 'console', 'two-factor', 'google-login', 'google-signup'] as const) {
    test(`rejects HTTP 200 success:false for ${context ?? 'public'} requests`, async () => {
      let calls = 0;
      const client = new HttpClient(PRODUCTION_ORIGIN, {
        fetch: async () => { calls++; return new Response(hostileBody); },
      });
      const options: RequestOptions = context === undefined ? {} : { context };
      await assert.rejects(client.request('/resource', options), cliFailure('API_REJECTED', context === 'console' || context === 'two-factor' ? 3 : 1, 200));
      assert.equal(calls, 1);
    });
  }
});

describe('HTTP status errors and no retries', () => {
  const cases = [
    [400, 'API_VALIDATION', 2], [401, 'AUTH_INVALID', 3], [403, 'AUTH_FORBIDDEN', 3],
    [404, 'NOT_FOUND', 1], [409, 'CONFLICT', 1], [422, 'API_VALIDATION', 2],
    [429, 'THROTTLED', 1], [500, 'API_ERROR', 1], [503, 'SERVICE_UNAVAILABLE', 1],
  ] as const;
  for (const [status, code, exitCode] of cases) {
    test(`maps ${status} safely, cancels its body, and never retries a mutation`, async () => {
      let calls = 0;
      let cancelled = false;
      const client = new HttpClient(PRODUCTION_ORIGIN, {
        fetch: async () => {
          calls++;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(Buffer.from(hostileBody)); },
            cancel() { cancelled = true; },
          }), { status, headers: { 'retry-after': '0' } });
        },
      });
      await assert.rejects(client.request('/console/api-keys/generate', {
        method: 'POST', token: secrets[0]!, body: { name: 'test-key' }, mutation: true, context: 'console',
      }), cliFailure(code, exitCode, status));
      assert.equal(calls, 1);
      assert.equal(cancelled, true);
    });
  }

  test('distinguishes reauthentication, 2FA policy, Google conflicts and missing backend config', () => {
    assert.match(httpError(401, 'console').message, /invalid or expired.*no other credential was tried/);
    assert.match(httpError(403, 'console').message, /2FA.*policy and ownership/);
    assert.doesNotMatch(httpError(403, 'console').message, /session is invalid or expired/);
    assert.match(httpError(401, 'two-factor').message, /verification code or temporary session/);
    for (const context of ['google-login', 'google-signup'] as const) {
      assert.match(httpError(401, context).message, /Web Client ID and backend audience/);
      assert.match(httpError(409, context).message, /account or Google identity conflict/);
      assert.match(httpError(503, context).message, /backend Google client configuration/);
    }
    assert.match(httpError(404, 'google-login').message, /signup explicitly.*never registers automatically/);
    assert.match(httpError(409, 'console').message, /globally unique/);
    assert.match(httpError(429).message, /no automatic retry/);
  });

  test('reports mutation transport uncertainty without leaking a thrown network error or retrying', async () => {
    let calls = 0;
    const client = new HttpClient(PRODUCTION_ORIGIN, {
      fetch: async () => { calls++; throw new Error(hostileBody); },
    });
    await assert.rejects(client.request('/console/api-keys/test-id/regenerate', { method: 'POST', mutation: true }), (error) => {
      cliFailure('TRANSPORT_ERROR')(error);
      assert.ok(error instanceof CliError);
      assert.match(error.message, /mutation outcome is uncertain.*Do not blindly retry/);
      return true;
    });
    assert.equal(calls, 1);
  });

  test('reports a failed response stream safely and releases its reader without retrying', async () => {
    let calls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(hostileBody)); },
    });
    const client = new HttpClient(PRODUCTION_ORIGIN, {
      fetch: async () => { calls++; return new Response(stream); },
    });
    await assert.rejects(client.request('/mutation', { method: 'POST', mutation: true }), (error) => {
      cliFailure('TRANSPORT_ERROR')(error);
      assert.ok(error instanceof CliError);
      assert.match(error.message, /outcome is uncertain.*Do not blindly retry/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(stream.locked, false);
  });

  test('does not label public transport errors as uncertain mutations', async () => {
    const client = new HttpClient(PRODUCTION_ORIGIN, { fetch: async () => { throw new Error(hostileBody); } });
    await assert.rejects(client.request('/inference/v1/models'), (error) => {
      cliFailure('TRANSPORT_ERROR')(error);
      assert.ok(error instanceof CliError);
      assert.doesNotMatch(error.message, /mutation|uncertain/);
      return true;
    });
  });

  test('does not retry a malformed successful mutation response', async () => {
    let calls = 0;
    const client = new HttpClient(PRODUCTION_ORIGIN, {
      fetch: async () => { calls++; return new Response('synthetic-key-secret'); },
    });
    await assert.rejects(client.request('/console/api-keys/generate', { method: 'POST', mutation: true }), (error) => {
      cliFailure('MALFORMED_RESPONSE')(error);
      assert.ok(error instanceof CliError);
      assert.match(error.message, /outcome is uncertain.*Do not blindly retry/);
      return true;
    });
    assert.equal(calls, 1);
  });
});

describe('HTTP timeout and cancellation', () => {
  for (const phase of ['headers', 'body'] as const) {
    test(`bounds time waiting for ${phase} and reports mutation uncertainty without retries`, { timeout: 5_000 }, async (t) => {
      let calls = 0;
      const origin = await localServer(t, (_request, response) => {
        calls++;
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{"incomplete":');
        }
      });
      const client = new HttpClient(origin, { timeoutMs: 200 });
      await assert.rejects(client.request('/mutation', { method: 'POST', mutation: true }), (error) => {
        cliFailure('TIMEOUT')(error);
        assert.ok(error instanceof CliError);
        assert.match(error.message, /outcome is uncertain.*Do not blindly retry/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }

  test('rejects an already-aborted operation without dispatching a request', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error(hostileBody));
    const client = new HttpClient(PRODUCTION_ORIGIN, {
      signal: controller.signal,
      fetch: async () => { calls++; return Response.json({}); },
    });
    await assert.rejects(client.request('/resource'), cliFailure('INTERRUPTED', 130));
    assert.equal(calls, 0);
  });

  for (const mutation of [false, true]) {
    test(`interrupts an in-flight ${mutation ? 'mutation' : 'read'} with exit 130`, { timeout: 5_000 }, async (t) => {
      let calls = 0;
      let markArrived!: () => void;
      const arrived = new Promise<void>((resolveArrived) => { markArrived = resolveArrived; });
      const origin = await localServer(t, (_request, response) => {
        calls++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"incomplete":');
        markArrived();
      });
      const controller = new AbortController();
      const client = new HttpClient(origin, { signal: controller.signal, timeoutMs: 2_000 });
      const rejected = assert.rejects(client.request('/resource', { mutation }), (error) => {
        cliFailure('INTERRUPTED', 130)(error);
        assert.ok(error instanceof CliError);
        if (mutation) assert.match(error.message, /outcome is uncertain.*Do not blindly retry/);
        else assert.doesNotMatch(error.message, /uncertain/);
        return true;
      });
      await arrived;
      controller.abort(new Error(hostileBody));
      await rejected;
      assert.equal(calls, 1);
    });
  }
});

describe('output modes and envelopes', () => {
  test('defaults to text on a TTY and JSON when piped, honoring explicit flags', () => {
    assert.equal(outputMode([], true), false);
    assert.equal(outputMode([], false), true);
    for (const tty of [true, false]) {
      assert.equal(outputMode(['models', 'list', '--json'], tty), true);
      assert.equal(outputMode(['--text', 'models', 'list'], tty), false);
      assert.equal(outputMode(['models', 'show', '--', '--json'], tty), !tty);
      assert.equal(outputMode(['--json', 'models', 'show', '--', '--text'], tty), true);
      assert.equal(outputMode(['--text', 'models', 'show', '--', '--json'], tty), false);
    }
  });

  test('prints exactly one JSON success envelope preserving backend fields and one-time secrets', async () => {
    const output = captureOutput();
    const data = { success: true, unknownField: { key: secrets[2], token: secrets[0] }, models: ['Vendor/Exact'], cost: '0.000000039' };
    await printResult(output.stream, { data, text: 'This human-only text must not appear.', mutation: true }, true);
    assert.equal(output.text(), `${JSON.stringify({ success: true, data })}\n`);
    assert.deepEqual(JSON.parse(output.text()), { success: true, data });
    assert.equal(output.text().split('\n').length, 2);
    assert.equal(output.text().split(secrets[2]!).length - 1, 1);
  });

  test('JSON escapes controls without changing the successful backend data', async () => {
    const output = captureOutput();
    const data = { label: '\u001b[31muntrusted\u001b[0m\n\t\u0000\u009b\u009d\u009c\u2028\u202e\u2066' };
    await printResult(output.stream, { data }, true);
    assert.doesNotMatch(output.text().slice(0, -1), /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
    assert.deepEqual(JSON.parse(output.text()), { success: true, data });
  });

  test('text output removes remote control sequences while preserving deliberate line breaks', async () => {
    const output = captureOutput();
    await printResult(output.stream, { data: {}, text: 'first\u001b[31m\r\t\u0000\nsecond\u202e\u2066\u009b' }, false);
    assert.equal(output.text(), 'first[31m\nsecond\n');
  });

  test('text output can pretty-print unknown backend objects and null', async () => {
    for (const data of [{ unexpected: { secret: secrets[2] } }, null]) {
      const output = captureOutput();
      await printResult(output.stream, { data }, false);
      assert.equal(output.text(), `${JSON.stringify(data, null, 2)}\n`);
    }
  });

  test('writeOutput waits for the destination callback', async () => {
    let callback: ((error?: Error | null) => void) | undefined;
    let finished = false;
    const stream = new Writable({ write(_chunk, _encoding, done) { callback = done; } });
    const writing = writeOutput(stream, 'result').then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.ok(callback);
    callback();
    await writing;
    assert.equal(finished, true);
  });

  for (const mutation of [false, true]) {
    test(`reports a safe ${mutation ? 'mutation recovery' : 'output'} error on a failed destination`, async () => {
      let writes = 0;
      const stream = new Writable({
        write(_chunk, _encoding, callback) {
          writes++;
          callback(new Error(hostileBody));
        },
      });
      stream.on('error', () => {});
      await assert.rejects(printResult(stream, { data: { key: secrets[2] }, mutation }, true), (error) => {
        cliFailure(mutation ? 'MUTATION_OUTPUT_FAILED' : 'OUTPUT_FAILED')(error);
        assert.ok(error instanceof CliError);
        if (mutation) assert.match(error.message, /mutation succeeded.*one-time key secret may be lost.*Do not blindly retry/);
        else assert.doesNotMatch(error.message, /mutation/);
        return true;
      });
      assert.equal(writes, 1);
    });
  }
});
