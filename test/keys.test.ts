import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { runCli, type Runtime } from '../src/app.js';
import { PRODUCTION_ORIGIN } from '../src/config.js';

const sessionToken = 'synthetic-key-test-session';
const keySecret = 'synthetic-key-test-one-time-secret';
const remoteSecret = 'synthetic-key-test-error-secret';
const modelId = '0123456789abcdef01234567';
const otherModelId = 'abcdef0123456789abcdef01';
const createArgs = ['keys', 'create', '--name', 'Agent-123', '--model', modelId];
const operations = [
  { name: 'create', args: createArgs, path: '/console/api-keys/generate', method: 'POST', body: { name: 'Agent-123', models: [modelId] } },
  { name: 'update', args: ['keys', 'update', 'opaque-id', '--model', modelId], path: '/console/api-keys/update', method: 'POST', body: { keyId: 'opaque-id', models: [modelId] } },
  { name: 'rotate', args: ['keys', 'rotate', 'opaque-id'], path: '/console/api-keys/opaque-id/regenerate', method: 'POST', body: undefined },
  { name: 'delete', args: ['keys', 'delete', 'opaque-id'], path: '/console/api-keys/opaque-id', method: 'DELETE', body: undefined },
] as const;

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: BodyInit | null | undefined;
  redirect: RequestRedirect | undefined;
}

async function invokeKeys(args: readonly string[], runtime: Runtime = {}) {
  let out = '';
  let err = '';
  const requests: CapturedRequest[] = [];
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) { out += chunk.toString(); callback(); } });
  const stderr = new Writable({ write(chunk: Buffer, _encoding, callback) { err += chunk.toString(); callback(); } });
  const fetchMock: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input), method: init?.method, headers: new Headers(init?.headers),
      body: init?.body, redirect: init?.redirect,
    });
    return runtime.fetch ? runtime.fetch(input, init) : Response.json({ accepted: true });
  };
  const code = await runCli([...args], {
    env: { GEODD_SESSION_TOKEN: sessionToken }, stdin: Readable.from([]),
    interactive: false, stdoutIsTTY: false, ...runtime,
    stdout: runtime.stdout ?? stdout, stderr: runtime.stderr ?? stderr, fetch: fetchMock,
  });
  return { code, out, err, requests };
}

type Invocation = Awaited<ReturnType<typeof invokeKeys>>;

function secretFree(text: string): void {
  for (const secret of [sessionToken, keySecret, remoteSecret]) assert.ok(!text.includes(secret), 'diagnostics must not disclose credentials');
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
}

function failure(result: Invocation, code: string, exitCode: number, status?: number): string {
  assert.equal(result.code, exitCode, result.out);
  const parsed = JSON.parse(result.out) as { success: boolean; error: { code: string; message: string; status?: number } };
  assert.equal(typeof parsed.error.message, 'string');
  assert.deepEqual(parsed, {
    success: false,
    error: { code, message: parsed.error.message, ...(status === undefined ? {} : { status }) },
  });
  assert.equal(result.out.trim().split('\n').length, 1);
  secretFree(result.out + result.err);
  return parsed.error.message;
}

function success(result: Invocation, data: unknown): void {
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(JSON.parse(result.out), { success: true, data });
  assert.equal(result.out.trim().split('\n').length, 1);
  secretFree(result.err);
  assert.ok(!result.out.includes(sessionToken));
}

describe('key CLI routes and payloads', () => {
  for (const operation of operations) {
    test(`${operation.name} sends exactly its documented request, with no catalog lookup`, async () => {
      const data = { arbitrary: { retained: [1, null, 'value'] }, backendVersion: 'future' };
      const result = await invokeKeys([...operation.args, '--yes', '--json'], { fetch: async () => Response.json(data) });
      success(result, data);
      assert.equal(result.requests.length, 1);
      const request = result.requests[0]!;
      assert.equal(request.url, `${PRODUCTION_ORIGIN}${operation.path}`);
      assert.equal(request.method, operation.method);
      assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.get('secret_token'), sessionToken);
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('cookie'), null);
      assert.equal(request.headers.get('accept'), 'application/json');
      if (operation.body === undefined) {
        assert.equal(request.body, undefined);
        assert.equal(request.headers.get('content-type'), null);
      } else {
        assert.equal(request.body, JSON.stringify(operation.body));
        assert.equal(request.headers.get('content-type'), 'application/json');
        const body: unknown = JSON.parse(String(request.body));
        assert.ok(body && typeof body === 'object');
        assert.equal(Object.hasOwn(body, 'billing'), false);
        assert.equal(Object.hasOwn(body, 'monthlyVolume'), false);
      }
      assert.match(result.err, new RegExp(`Origin: ${PRODUCTION_ORIGIN}\\nOperation: keys ${operation.name}`));
      if (operation.name !== 'create') assert.match(result.err, /Key ID: "opaque-id".*ID, not a secret/);
    });
  }

  test('create explains globally unique names, PostPaid billing and omitted default capacity', async () => {
    const result = await invokeKeys([...createArgs, '--yes']);
    success(result, { accepted: true });
    assert.match(result.err, /Name \(globally unique\): Agent-123/);
    assert.match(result.err, new RegExp(`Models: ${modelId}`));
    assert.match(result.err, /Billing: PostPaid \(backend default\)/);
    assert.match(result.err, /Monthly capacity: 3,000,000,000 \(backend default\) tokens/);
    assert.match(result.err, /one-time key secret.*never saves it/);
  });

  for (const volume of ['1', '3000000000', '9007199254740991', '00042']) {
    test(`create sends explicit positive safe monthly volume ${volume}, without billing`, async () => {
      const result = await invokeKeys([...createArgs, '--monthly-volume', volume, '--yes']);
      success(result, { accepted: true });
      assert.equal(result.requests.length, 1);
      assert.deepEqual(JSON.parse(String(result.requests[0]!.body)), {
        name: 'Agent-123', models: [modelId], monthlyVolume: Number(volume),
      });
      assert.match(result.err, new RegExp(`Monthly capacity: ${Number(volume)} tokens`));
    });
  }

  for (const operation of ['create', 'update'] as const) {
    test(`${operation} lowercases and deduplicates model database IDs without requiring discovery`, async () => {
      const start = operation === 'create' ? ['keys', 'create', '--name', 'Agent-123'] : ['keys', 'update', 'opaque-id'];
      const result = await invokeKeys([...start,
        '--model', modelId.toUpperCase(), '--model', modelId,
        '--model', modelId.toUpperCase(), '--model', otherModelId.toUpperCase(), '--model', otherModelId, '--yes',
      ]);
      success(result, { accepted: true });
      assert.equal(result.requests.length, 1);
      const body = JSON.parse(String(result.requests[0]!.body)) as { models: string[] };
      assert.deepEqual(body.models, [modelId, otherModelId]);
      assert.ok(result.err.includes(`${modelId}, ${otherModelId}`));
      assert.ok(!result.err.includes(modelId.toUpperCase()));
      assert.ok(!result.requests[0]!.url.includes('/inference/'));
    });
  }

  test('update warns that the entire model set is replaced, not appended', async () => {
    const result = await invokeKeys(['keys', 'update', 'opaque-id', '--model', otherModelId, '--yes']);
    success(result, { accepted: true });
    assert.ok(result.err.includes(`REPLACE the entire model set with: ${otherModelId}. This is not an addition`));
    assert.deepEqual(JSON.parse(String(result.requests[0]!.body)), { keyId: 'opaque-id', models: [otherModelId] });
    assert.doesNotMatch(result.err, /stdout result contains a one-time/);
  });

  test('rotate warns that the previous secret stops working and delete warns about the mapping', async () => {
    const rotate = await invokeKeys(['keys', 'rotate', 'opaque-id', '--yes']);
    success(rotate, { accepted: true });
    assert.match(rotate.err, /previous secret stops working immediately after rotation/);
    assert.match(rotate.err, /one-time key secret/);
    const remove = await invokeKeys(['keys', 'delete', 'opaque-id', '--yes']);
    success(remove, { accepted: true });
    assert.match(remove.err, /Permanently delete this key and its backend mapping/);
    assert.doesNotMatch(remove.err, /stdout result contains a one-time/);
  });

  test('honors an explicitly bound nonproduction origin and never forwards to production', async () => {
    const origin = 'https://staging.example:8443';
    const result = await invokeKeys([...createArgs, '--yes', '--api-url', `${origin}/`], {
      env: { GEODD_SESSION_TOKEN: sessionToken, GEODD_SESSION_TOKEN_ORIGIN: origin },
    });
    success(result, { accepted: true });
    assert.equal(result.requests[0]!.url, `${origin}/console/api-keys/generate`);
    assert.match(result.err, /Origin: https:\/\/staging\.example:8443/);
  });
});

describe('opaque key IDs and local validation', () => {
  for (const operation of ['rotate', 'delete'] as const) {
    test(`${operation} encodes an opaque ID as one path component`, async () => {
      const id = 'opaque/part ?#%+\\segment:\u00e9';
      const result = await invokeKeys(['keys', operation, id, '--yes']);
      success(result, { accepted: true });
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0]!.url, `${PRODUCTION_ORIGIN}/console/api-keys/${encodeURIComponent(id)}${operation === 'rotate' ? '/regenerate' : ''}`);
      const url = new URL(result.requests[0]!.url);
      assert.equal(url.search, '');
      assert.equal(url.hash, '');
      assert.ok(!url.pathname.includes('/part'));
    });
  }

  test('update preserves an opaque ID in JSON instead of path encoding or guessing a database format', async () => {
    const id = 'opaque/part ?#%+\\segment:\u00e9';
    const result = await invokeKeys(['keys', 'update', id, '--model', modelId, '--yes']);
    success(result, { accepted: true });
    assert.deepEqual(JSON.parse(String(result.requests[0]!.body)), { keyId: id, models: [modelId] });
    assert.equal(result.requests[0]!.url, `${PRODUCTION_ORIGIN}/console/api-keys/update`);
  });

  const invalidIds = [
    '', ' ', ' id', 'id ', '.', '..', 'prefix/../suffix', 'prefix/./suffix', 'prefix\\..\\suffix',
    '%2e%2e', '%2e/child', 'prefix%2f..%2fsuffix', '%252e%252e%252fchild', '%255c..%255cchild',
    'id\u0000', 'id\nvalue', 'id\u007f', 'id\u009b', 'id\u202e', 'id\u2066', 'id%00', 'id%250a', 'x'.repeat(2049),
  ];
  for (const operation of ['update', 'rotate', 'delete'] as const) {
    test(`${operation} rejects empty, navigation, encoded-navigation, control and oversized IDs before approval`, async () => {
      let confirmations = 0;
      for (const id of invalidIds) {
        const args = ['keys', operation, id, ...(operation === 'update' ? ['--model', modelId] : [])];
        const result = await invokeKeys(args, { interactive: true, confirm: async () => { confirmations++; return true; } });
        failure(result, 'INVALID_KEY_ID', 2);
        assert.equal(result.requests.length, 0);
        assert.equal(result.err, '');
      }
      assert.equal(confirmations, 0);
    });
  }

  test('create accepts names at the documented boundaries without checking global uniqueness locally', async () => {
    for (const name of ['A', '-', 'a'.repeat(32), 'AbC-123']) {
      const result = await invokeKeys(['keys', 'create', '--name', name, '--model', modelId, '--yes']);
      success(result, { accepted: true });
      assert.equal(result.requests.length, 1);
      assert.equal((JSON.parse(String(result.requests[0]!.body)) as { name: string }).name, name);
    }
  });

  test('create rejects invalid global names before credential lookup, approval or requests', async () => {
    let confirmations = 0;
    for (const name of ['', 'a'.repeat(33), 'has space', 'bad_name', 'bad.name', 'bad/name', 'caf\u00e9', 'bad\nname']) {
      const result = await invokeKeys(['keys', 'create', '--name', name, '--model', modelId], {
        env: {}, interactive: true, confirm: async () => { confirmations++; return true; },
      });
      assert.match(failure(result, 'INVALID_KEY_NAME', 2), /globally unique/);
      assert.equal(result.requests.length, 0);
      assert.equal(result.err, '');
    }
    assert.equal(confirmations, 0);
  });

  for (const operation of ['create', 'update'] as const) {
    test(`${operation} rejects malformed model database IDs before credentials, approval or requests`, async () => {
      const start = operation === 'create' ? ['keys', 'create', '--name', 'Agent-123'] : ['keys', 'update', 'opaque-id'];
      let confirmations = 0;
      for (const model of [
        '', ' ', 'a'.repeat(23), 'a'.repeat(25), 'g'.repeat(24), 'abcdefghijkl',
        ` ${modelId}`, `${modelId} `, `${modelId}\n`, `${modelId}\r\n`,
        `${modelId.slice(0, 12)} ${modelId.slice(13)}`, `${modelId.slice(0, 23)}\u0000`,
        `${modelId.slice(0, 23)}\u009b`, `${modelId.slice(0, 23)}\u202e`,
        'Vendor/Model', `ObjectId("${modelId}")`, `0x${modelId}`, '\uff41'.repeat(24),
      ]) {
        const result = await invokeKeys([...start, '--model', modelId, '--model', model], {
          env: {}, interactive: true, confirm: async () => { confirmations++; return true; },
        });
        const message = failure(result, 'INVALID_MODELS', 2);
        assert.match(message, /24-character hexadecimal model database ID/);
        assert.match(message, /geodd models list --for-keys/);
        assert.match(message, /public inference model IDs are not accepted/);
        assert.equal(result.requests.length, 0);
        assert.equal(result.err, '');
      }
      assert.equal(confirmations, 0);
    });
  }

  test('the reported openai/gpt-oss-120b create command fails locally before credentials, confirmation or fetch', async () => {
    let confirmations = 0;
    for (const flags of [[], ['--yes', '--json']]) {
      const result = await invokeKeys(['keys', 'create', '--name', 'Agent-123', '--model', 'openai/gpt-oss-120b', ...flags], {
        env: {}, interactive: true, confirm: async () => { confirmations++; return true; },
      });
      const message = failure(result, 'INVALID_MODELS', 2);
      assert.match(message, /geodd models list --for-keys/);
      assert.match(message, /public inference model IDs are not accepted/);
      assert.equal(result.requests.length, 0);
      assert.equal(result.err, '');
    }
    assert.equal(confirmations, 0);
  });

  test('rejects zero, nondecimal, fractional, negative, whitespace and unsafe monthly volumes locally', async () => {
    for (const volume of ['', '0', '-1', '+1', '1.5', '1e6', 'Infinity', 'NaN', '0x10', ' 1', '1 ', '9007199254740992']) {
      const result = await invokeKeys([...createArgs, `--monthly-volume=${volume}`, '--yes'], { env: {} });
      failure(result, 'INVALID_MONTHLY_VOLUME', 2);
      assert.equal(result.requests.length, 0);
      assert.equal(result.err, '');
    }
  });

  test('CLI registrations require documented arguments and reject unsupported options or commands', async () => {
    const invalid = [
      ['keys', 'create', '--model', modelId, '--yes'],
      ['keys', 'create', '--name', 'Agent-123', '--yes'],
      ['keys', 'update', '--model', modelId, '--yes'],
      ['keys', 'update', 'opaque-id', '--yes'],
      ['keys', 'rotate', '--yes'], ['keys', 'delete', '--yes'], ['keys', 'list'],
      [...createArgs, '--billing', 'PrePaid', '--yes'],
      ['keys', 'update', 'opaque-id', '--model', modelId, '--monthly-volume', '1', '--yes'],
      ['keys', 'rotate', 'opaque-id', '--token', sessionToken, '--yes'],
      ['keys', 'delete', 'opaque-id', 'unexpected', '--yes'],
    ];
    for (const args of invalid) {
      const result = await invokeKeys(args);
      failure(result, 'USAGE', 2);
      assert.equal(result.requests.length, 0);
    }
  });

  test('subcommand help documents mutation consequences without selecting credentials or sending requests', async () => {
    for (const [operation, warning] of [
      ['create', /globally.*PostPaid|PostPaid.*globally/s],
      ['update', /REPLACE.*not add/s], ['rotate', /previous secret.*new secret once/s], ['delete', /Permanently delete.*backend mapping/s],
    ] as const) {
      const result = await invokeKeys(['keys', operation, '--help'], { env: {} });
      assert.equal(result.code, 0);
      assert.match(result.out, warning);
      assert.match(result.out, /--yes/);
      assert.equal(result.requests.length, 0);
      assert.equal(result.err, '');
    }
  });
});

describe('key credentials and approval', () => {
  test('missing credentials fail before prompting or sending any mutation', async (t) => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'geodd-keys-missing-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let confirmations = 0;
    for (const operation of operations) {
      const result = await invokeKeys(operation.args, {
        env: { GEODD_CONFIG_DIR: directory }, interactive: true, confirm: async () => { confirmations++; return true; },
      });
      failure(result, process.platform === 'win32' ? 'SESSION_PERSISTENCE_UNSUPPORTED' : 'SESSION_MISSING', process.platform === 'win32' ? 2 : 3);
      assert.equal(result.requests.length, 0);
      assert.equal(result.err, '');
    }
    assert.equal(confirmations, 0);
  });

  test('origin-mismatched environment credentials fail before approval with no fallback request', async () => {
    let confirmations = 0;
    for (const operation of operations) {
      const result = await invokeKeys([...operation.args, '--api-url', 'https://staging.example'], {
        interactive: true, confirm: async () => { confirmations++; return true; },
      });
      assert.match(failure(result, 'ENV_SESSION_ORIGIN_MISMATCH', 3), /No stored credential was tried/);
      assert.equal(result.requests.length, 0);
      assert.equal(result.err, '');
    }
    assert.equal(confirmations, 0);
  });

  for (const operation of operations) {
    test(`${operation.name} requires --yes noninteractively and never prompts`, async () => {
      let confirmations = 0;
      const result = await invokeKeys(operation.args, { confirm: async () => { confirmations++; return true; } });
      assert.match(failure(result, 'CONFIRMATION_REQUIRED', 4), /--yes/);
      assert.equal(result.requests.length, 0);
      assert.equal(confirmations, 0);
      assert.equal(result.err, '');
    });

    test(`${operation.name} waits for an interactive approval before making one request`, async () => {
      const events: string[] = [];
      const result = await invokeKeys(operation.args, {
        interactive: true,
        confirm: async (message) => { assert.match(message, /Approve.*\[y\/N\]/); events.push('confirm'); return true; },
        fetch: async () => { events.push('request'); return Response.json({ approved: true }); },
      });
      success(result, { approved: true });
      assert.deepEqual(events, ['confirm', 'request']);
      assert.equal(result.requests.length, 1);
    });

    test(`${operation.name} sends nothing after interactive rejection`, async () => {
      let confirmations = 0;
      const result = await invokeKeys(operation.args, {
        interactive: true, confirm: async () => { confirmations++; return false; },
      });
      failure(result, 'CONFIRMATION_REJECTED', 4);
      assert.equal(confirmations, 1);
      assert.equal(result.requests.length, 0);
      assert.doesNotMatch(result.err, /stdout result contains a one-time/);
    });
  }

  test('--yes is explicit approval in both interactive and noninteractive use, with warnings but no prompt', async () => {
    for (const interactive of [true, false]) {
      let confirmations = 0;
      const result = await invokeKeys([...createArgs, '--yes'], {
        interactive, confirm: async () => { confirmations++; return false; },
      });
      success(result, { accepted: true });
      assert.equal(confirmations, 0);
      assert.equal(result.requests.length, 1);
      assert.match(result.err, /PostPaid/);
    }
  });

  test('real readline accepts yes and defaults empty/no responses to rejection', { timeout: 5_000 }, async () => {
    for (const answer of ['YeS', '', 'no']) {
      const stdin = new PassThrough();
      let prompts = 0;
      let diagnostics = '';
      const stderr = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          diagnostics += chunk.toString();
          if (chunk.toString().includes('Approve this mutation?')) {
            prompts++;
            queueMicrotask(() => stdin.end(`${answer}\n`));
          }
          callback();
        },
      });
      const result = await invokeKeys(createArgs, { interactive: true, stdin, stderr });
      assert.equal(prompts, 1);
      secretFree(diagnostics);
      assert.match(diagnostics, /PostPaid/);
      if (answer === 'YeS') { success(result, { accepted: true }); assert.equal(result.requests.length, 1); }
      else { failure(result, 'CONFIRMATION_REJECTED', 4); assert.equal(result.requests.length, 0); }
    }
  });

  test('interrupting before or during approval sends no mutation', async () => {
    for (const before of [true, false]) {
      const controller = new AbortController();
      let confirmations = 0;
      if (before) controller.abort();
      const result = await invokeKeys(createArgs, {
        signal: controller.signal, interactive: true,
        confirm: async () => { confirmations++; controller.abort(); return true; },
      });
      failure(result, 'INTERRUPTED', 130);
      assert.equal(confirmations, before ? 0 : 1);
      assert.equal(result.requests.length, 0);
    }
  });
});

describe('key results, failures and mutation uncertainty', () => {
  for (const operation of [operations[0], operations[2]]) {
    test(`${operation.name} preserves arbitrary successful backend shapes without guessing secret paths`, async () => {
      for (const data of [
        { success: true, future: { credentialValue: keySecret, opaque: [null, 1] }, metadata: 'retained' },
        [keySecret, { unknown: true }], keySecret, null,
      ]) {
        const result = await invokeKeys([...operation.args, '--yes', '--json'], { fetch: async () => Response.json(data) });
        success(result, data);
        assert.equal(result.requests.length, 1);
        if (data !== null) assert.equal(result.out.split(keySecret).length - 1, 1);
        assert.match(result.err, /one-time key secret/);
      }
    });

    test(`${operation.name} prints the one-time secret once in text mode and never in diagnostics`, async () => {
      const data = { unknownSecretLocation: { value: keySecret }, extra: [1, 2] };
      const result = await invokeKeys([...operation.args, '--yes', '--text'], { fetch: async () => Response.json(data) });
      assert.equal(result.code, 0);
      assert.equal(result.out, `${JSON.stringify(data, null, 2)}\n`);
      assert.equal(result.out.split(keySecret).length - 1, 1);
      secretFree(result.err);
      assert.ok(!result.out.includes(sessionToken));
    });
  }

  test('injected sessions and returned key secrets are never persisted by a successful mutation', async (t) => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'geodd-keys-no-persist-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await invokeKeys([...createArgs, '--yes'], {
      env: { GEODD_CONFIG_DIR: directory, GEODD_SESSION_TOKEN: sessionToken },
      fetch: async () => Response.json({ secret: keySecret }),
    });
    success(result, { secret: keySecret });
    assert.deepEqual(await readdir(directory), []);
  });

  for (const operation of operations) {
    test(`${operation.name} ${operation.name === 'update' || operation.name === 'delete' ? 'accepts' : 'rejects'} an empty 204 response without retrying`, async () => {
      const result = await invokeKeys([...operation.args, '--yes'], { fetch: async () => new Response(null, { status: 204 }) });
      if (operation.name === 'update' || operation.name === 'delete') success(result, null);
      else assert.match(failure(result, 'MALFORMED_RESPONSE', 1), /outcome is uncertain.*Do not blindly retry/);
      assert.equal(result.requests.length, 1);
    });
  }

  for (const [status, code, exitCode] of [
    [400, 'API_VALIDATION', 2], [401, 'AUTH_INVALID', 3], [403, 'AUTH_FORBIDDEN', 3],
    [409, 'CONFLICT', 1], [422, 'API_VALIDATION', 2],
    [429, 'THROTTLED', 1], [503, 'SERVICE_UNAVAILABLE', 1],
  ] as const) {
    test(`reports ${status} safely without retrying, credential fallback or browser login`, async () => {
      let browserOpens = 0;
      const result = await invokeKeys([...createArgs, '--yes'], {
        fetch: async () => Response.json({ message: `\u001b[31m${remoteSecret}`, secret: keySecret, token: sessionToken }, { status, headers: { 'retry-after': '0' } }),
        openBrowser: async () => { browserOpens++; },
      });
      const message = failure(result, code, exitCode, status);
      assert.equal(result.requests.length, 1);
      assert.equal(browserOpens, 0);
      if (status === 409) assert.match(message, /globally unique/);
      if (status === 403) assert.match(message, /2FA.*ownership/);
    });
  }

  test('model existence remains a backend check without a catalog lookup or retry', async () => {
    const unknownModelId = '0'.repeat(24);
    for (const operation of ['create', 'update'] as const) {
      const start = operation === 'create' ? ['keys', 'create', '--name', 'Agent-123'] : ['keys', 'update', 'opaque-id'];
      const result = await invokeKeys([...start, '--model', unknownModelId, '--yes'], {
        fetch: async () => Response.json({ error: 'One or more model IDs do not exist', token: sessionToken, input: remoteSecret }, { status: 400 }),
      });
      failure(result, 'API_VALIDATION', 2, 400);
      assert.equal(result.requests.length, 1);
      assert.deepEqual((JSON.parse(String(result.requests[0]!.body)) as { models: string[] }).models, [unknownModelId]);
    }
  });

  test('rejects HTTP 200 logical failures without exposing their secret fields or retrying', async () => {
    const result = await invokeKeys(['keys', 'rotate', 'opaque-id', '--yes'], {
      fetch: async () => Response.json({ success: false, message: remoteSecret, secret: keySecret, token: sessionToken }),
    });
    failure(result, 'API_REJECTED', 1, 200);
    assert.equal(result.requests.length, 1);
  });

  test('explicit unresolved 2FA is distinct from a generic mutation failure', async () => {
    const result = await invokeKeys(['keys', 'rotate', 'opaque-id', '--yes'], {
      fetch: async () => Response.json({ success: false, requiresTwoFactor: true, tempToken: sessionToken }),
    });
    failure(result, 'TWO_FACTOR_REQUIRED', 3, 200);
    assert.equal(result.requests.length, 1);
  });

  test('malformed successful responses and transport failures report uncertainty without retrying', async () => {
    for (const malformed of [true, false]) {
      const result = await invokeKeys([...createArgs, '--yes'], {
        fetch: async () => {
          if (malformed) return new Response(`not-json ${remoteSecret} ${keySecret}`);
          throw new Error(`${remoteSecret} ${sessionToken}`);
        },
      });
      assert.match(failure(result, malformed ? 'MALFORMED_RESPONSE' : 'TRANSPORT_ERROR', 1), /outcome is uncertain.*Do not blindly retry/);
      assert.equal(result.requests.length, 1);
    }
  });

  test('create and rotate timeouts leave an uncertain outcome and are never retried', { timeout: 5_000 }, async (t) => {
    let received = 0;
    const server = createServer(() => { received++; });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const operation of [operations[0], operations[2]]) {
      const result = await invokeKeys([...operation.args, '--yes', '--api-url', origin], {
        env: { GEODD_SESSION_TOKEN: sessionToken, GEODD_SESSION_TOKEN_ORIGIN: origin },
        fetch, timeoutMs: 200,
      });
      assert.match(failure(result, 'TIMEOUT', 1), /outcome is uncertain.*Do not blindly retry/);
      assert.equal(result.requests.length, 1);
    }
    assert.equal(received, 2);
  });

  test('a failed stdout after a successful mutation reports recovery needs without reprinting the secret', async () => {
    let writes = 0;
    let attempted = '';
    const stdout = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writes++;
        attempted += chunk.toString();
        callback(new Error(`${remoteSecret} ${keySecret}`));
      },
    });
    stdout.on('error', () => {});
    const result = await invokeKeys(['keys', 'rotate', 'opaque-id', '--yes'], {
      stdout, fetch: async () => Response.json({ arbitrarySecret: keySecret }),
    });
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(writes, 1);
    assert.equal(result.out, '');
    assert.equal(attempted, `${JSON.stringify({ success: true, data: { arbitrarySecret: keySecret } })}\n`);
    assert.match(result.err, /MUTATION_OUTPUT_FAILED:.*mutation succeeded.*one-time key secret may be lost.*Do not blindly retry/);
    secretFree(result.err);
  });
});
