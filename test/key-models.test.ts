import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { runCli, type Runtime } from '../src/app.js';
import { CliError } from '../src/errors.js';
import { HttpClient } from '../src/http.js';
import { modelsForKeys } from '../src/models.js';

const origin = 'https://key-models.invalid';
const token = 'synthetic-key-models-session';
const firstId = 'ABCDEF0123456789ABCDEF01';
const secondId = '0123456789abcdef01234567';
const secret = 'synthetic-private-console-field';
const env = { GEODD_API_URL: origin, GEODD_SESSION_TOKEN: token, GEODD_SESSION_TOKEN_ORIGIN: origin };
const envelope = (models: unknown[]) => ({ success: true, data: { models } });

async function invoke(args: string[], runtime: Runtime = {}) {
  let out = ''; let err = ''; let calls = 0;
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) { out += chunk.toString(); callback(); } });
  const stderr = new Writable({ write(chunk: Buffer, _encoding, callback) { err += chunk.toString(); callback(); } });
  const code = await runCli(args, {
    env, stdin: Readable.from([]), interactive: false, stdoutIsTTY: false, ...runtime, stdout, stderr,
    fetch: async (url, init) => {
      calls++;
      return runtime.fetch ? runtime.fetch(url, init) : Response.json(envelope([{ _id: firstId, name: 'First model' }]));
    },
  });
  return { code, out, err, calls };
}

test('key models uses the keys context and only the authenticated console GET', async t => {
  const http = new HttpClient(origin, { fetch: async (url, init) => {
    assert.equal(String(url), `${origin}/console/models`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('secret_token'), token);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('content-type'), null);
    return Response.json(envelope([{ _id: firstId, name: 'First model' }]));
  } });
  const request = t.mock.method(http, 'request');
  const result = await modelsForKeys(http, token);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(request.mock.calls[0]!.arguments, ['/console/models', { method: 'GET', token, context: 'keys' }]);
  assert.deepEqual(result.data, [{ id: firstId.toLowerCase(), name: 'First model' }]);
  assert.equal(result.mutation, undefined);
});

test('key models projects only normalized IDs and names in backend order without guessing or deduplication', async () => {
  const response = {
    ...envelope([
      { _id: firstId, id: 'public/not-the-key-id', name: 'First model', deployment: { url: secret }, token: secret },
      { _id: secondId, apiKey: secret },
      { _id: firstId.toLowerCase(), name: null },
      { _id: secondId.toUpperCase(), name: { secret } },
    ]),
    secret,
  };
  const result = await modelsForKeys(new HttpClient(origin, { fetch: async () => Response.json(response) }), token);
  assert.deepEqual(result.data, [
    { id: firstId.toLowerCase(), name: 'First model' },
    { id: secondId, name: null },
    { id: firstId.toLowerCase(), name: null },
    { id: secondId, name: null },
  ]);
  assert.equal(result.text, [
    `${'ID'.padEnd(24)}  NAME`, `${firstId.toLowerCase()}  First model`,
    `${secondId}  unknown`, `${firstId.toLowerCase()}  unknown`, `${secondId}  unknown`,
  ].join('\n'));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-|public\/not-the-key-id|deployment|apiKey/);
});

test('key models accepts an empty confirmed catalog', async () => {
  const result = await modelsForKeys(new HttpClient(origin, { fetch: async () => Response.json(envelope([])) }), token);
  assert.deepEqual(result, { data: [], text: 'No models available for API keys.' });
});

test('key models rejects malformed envelopes without disclosing backend values', async () => {
  for (const response of [
    null, [], { data: { models: [] } }, { success: 'true', data: { models: [] } },
    { success: true }, { success: true, data: null }, { success: true, data: [] },
    { success: true, data: { models: secret } }, { success: true, data: { models: {} } },
    { success: true, data: [{ _id: firstId }] },
  ]) {
    let calls = 0;
    const http = new HttpClient(origin, { fetch: async () => { calls++; return Response.json(response); } });
    await assert.rejects(modelsForKeys(http, token), error => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'MALFORMED_KEY_MODELS');
      assert.equal(error.exitCode, 1);
      assert.doesNotMatch(error.message, /synthetic-/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('key models rejects every malformed entry and never substitutes public IDs', async () => {
  const ids = [undefined, null, 123, {}, [], '', 'a'.repeat(23), 'a'.repeat(25), 'g'.repeat(24),
    'openai/gpt-oss-120b', ` ${firstId}`, `${firstId}\n`, `${firstId}\u0000`, 'a'.repeat(23) + '\u202e'];
  for (const entry of [null, [], 'model', ...ids.map(_id => ({ _id, id: secondId, name: secret }))]) {
    const http = new HttpClient(origin, { fetch: async () => Response.json(envelope([{ _id: firstId }, entry])) });
    await assert.rejects(modelsForKeys(http, token), error => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'MALFORMED_KEY_MODELS');
      assert.doesNotMatch(error.message, /synthetic-|openai\/|ABCDEF/);
      return true;
    });
  }
});

test('key models sanitizes table controls without changing the name data', async () => {
  const name = 'First\tmodel\n\u001b[31m\r\u007f\u009b\u202e\u2066';
  const result = await modelsForKeys(new HttpClient(origin, { fetch: async () => Response.json(envelope([{ _id: firstId, name }])) }), token);
  assert.deepEqual(result.data, [{ id: firstId.toLowerCase(), name }]);
  assert.equal(result.text, `${'ID'.padEnd(24)}  NAME\n${firstId.toLowerCase()}  Firstmodel[31m`);
});

test('key models preserves safe HTTP, logical, protocol and transport failures without retries', async () => {
  const cases = [
    { fetch: async () => Response.json({ error: secret }, { status: 401 }), code: 'AUTH_INVALID', status: 401 },
    { fetch: async () => Response.json({ error: secret }, { status: 403 }), code: 'AUTH_FORBIDDEN', status: 403 },
    { fetch: async () => Response.json({ error: secret }, { status: 500 }), code: 'API_ERROR', status: 500 },
    { fetch: async () => Response.json({ success: false, error: secret }), code: 'API_REJECTED', status: 200 },
    { fetch: async () => Response.json({ requiresTwoFactor: true, error: secret }), code: 'TWO_FACTOR_REQUIRED', status: 200 },
    { fetch: async () => new Response(secret), code: 'MALFORMED_RESPONSE', status: undefined },
    { fetch: async () => { throw new Error(secret); }, code: 'TRANSPORT_ERROR', status: undefined },
  ];
  for (const fixture of cases) {
    let calls = 0;
    const http = new HttpClient(origin, { fetch: async () => { calls++; return fixture.fetch(); } });
    await assert.rejects(modelsForKeys(http, token), error => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.status, fixture.status);
      assert.doesNotMatch(error.message, /synthetic-/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('models list --for-keys outputs only projected data and never asks for mutation approval', async () => {
  const name = 'Model\u009b\u202e';
  const result = await invoke(['models', 'list', '--for-keys', '--json'], {
    confirm: async () => { assert.fail('read-only discovery must not ask for mutation approval'); },
    fetch: async (url, init) => {
      assert.equal(String(url), `${origin}/console/models`);
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('secret_token'), token);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return Response.json(envelope([{ _id: firstId, name, deployment: secret, apiKey: secret }]));
    },
  });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(JSON.parse(result.out), { success: true, data: [{ id: firstId.toLowerCase(), name }] });
  assert.equal(result.out.trim().split('\n').length, 1);
  assert.equal(result.err, '');
  assert.equal(result.calls, 1);
  assert.doesNotMatch(result.out, /synthetic-|[\u009b\u202e]/);
  const text = await invoke(['models', 'list', '--for-keys', '--text']);
  assert.equal(text.code, 0, text.err);
  assert.equal(text.out, `${'ID'.padEnd(24)}  NAME\n${firstId.toLowerCase()}  First model\n`);
  assert.equal(text.err, '');
});

test('models list --for-keys rejects missing or origin-mismatched credentials before any request', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'geodd-key-models-'));
  try {
    const missing = await invoke(['models', 'list', '--for-keys'], {
      env: { GEODD_API_URL: origin, GEODD_CONFIG_DIR: directory },
    });
    assert.equal(JSON.parse(missing.out).error.code, process.platform === 'win32' ? 'SESSION_PERSISTENCE_UNSUPPORTED' : 'SESSION_MISSING');
    assert.equal(missing.calls, 0);
    const mismatch = await invoke(['models', 'list', '--for-keys', '--api-url', 'https://other.invalid']);
    assert.equal(mismatch.code, 3);
    assert.equal(JSON.parse(mismatch.out).error.code, 'ENV_SESSION_ORIGIN_MISMATCH');
    assert.equal(mismatch.calls, 0);
    assert.doesNotMatch(missing.out + missing.err + mismatch.out + mismatch.err, /synthetic-/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
