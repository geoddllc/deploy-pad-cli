import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CliError } from '../src/errors.js';
import { HttpClient, httpError } from '../src/http.js';

const origin = 'https://mock.invalid';
const secret = 'synthetic-private-error-value';
const known = 'Invalid model ID format';
const options = { method: 'POST', context: 'keys', mutation: true, token: secret } as const;

async function fails(response: Response, status = response.status, maxBytes?: number): Promise<CliError> {
  let calls = 0;
  const client = new HttpClient(origin, { fetch: async () => { calls++; return response; }, ...(maxBytes !== undefined ? { maxBytes } : {}) });
  let failure: CliError | undefined;
  await assert.rejects(client.request('/console/api-keys/generate', options), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.status, status);
    assert.equal(error.code, status === 409 ? 'CONFLICT' : status === 200 ? 'API_REJECTED' : 'API_VALIDATION');
    assert.equal(error.exitCode, status === 409 || status === 200 ? 1 : 2);
    assert.ok(!error.message.includes(secret));
    failure = error;
    return true;
  });
  assert.equal(calls, 1);
  return failure!;
}

test('known route errors have useful messages without exposing the rest of the body', async () => {
  for (const error of [
    'Key name is required', 'Key name must be 32 characters or less',
    'Key name must contain only letters, numbers, and dashes (no other special characters or spaces)',
    'At least one model is required', known, 'One or more model IDs do not exist',
    'A key with this name already exists. Please use a different name.',
  ]) {
    const status = error.includes('already exists') ? 409 : 400;
    const result = await fails(Response.json({ success: false, error, token: secret, existingKeyId: secret, nested: { secret } }, { status }));
    assert.ok(result.message.startsWith(error));
    assert.doesNotMatch(result.message, /signup|privacy consent/);
  }
});

test('unrecognized messages and arbitrary JSON never leak private values', async () => {
  for (const status of [400, 409, 422]) {
    for (const body of [
      '', '{broken', 'null', '[]', JSON.stringify(secret),
      JSON.stringify({ error: secret, existingKeyId: secret }),
      JSON.stringify({ error: `${known} ${secret}` }),
      JSON.stringify({ error: `\u001b[31m${known}` }),
      JSON.stringify({ error: { message: known, secret }, message: secret }),
    ]) {
      const result = await fails(new Response(body, { status }));
      assert.equal(result.message, httpError(status, 'keys').message);
    }
  }
});

test('known logical failures keep the existing status, exit code, and 2FA precedence', async () => {
  const result = await fails(Response.json({ success: false, error: known, token: secret }));
  assert.match(result.message, /24-character.*models list --for-keys/);
  const client = new HttpClient(origin, { fetch: async () => Response.json({ success: false, requiresTwoFactor: true, error: known, token: secret }) });
  await assert.rejects(client.request('/console/api-keys/generate', options), { code: 'TWO_FACTOR_REQUIRED', exitCode: 3, status: 200 });
});

test('diagnostic reads honor exact byte limits and split UTF-8 without exposing unknown fields', async () => {
  const bytes = Buffer.from(JSON.stringify({ error: known, extra: 'caf\u00e9' }));
  const response = () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { status: 400 });
  assert.match((await fails(response(), 400, bytes.length)).message, /Invalid model ID format/);
  assert.equal((await fails(response(), 400, bytes.length - 1)).message, httpError(400, 'keys').message);
});

test('declared and actual oversize errors fall back to the known HTTP failure and cancel', async () => {
  for (const contentLength of [undefined, '1', String(16 * 1024 + 1)]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('x'.repeat(16 * 1024 + 1))); }, cancel() { cancelled = true; } });
    const result = await fails(new Response(body, { status: 400, ...(contentLength !== undefined ? { headers: { 'content-length': contentLength } } : {}) }));
    assert.equal(result.message, httpError(400, 'keys').message);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test('unreadable streams retain the HTTP error, not a transport error', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } });
  assert.equal((await fails(new Response(body, { status: 422 }))).message, httpError(422, 'keys').message);
  assert.equal(body.locked, false);
});

test('stalled diagnostics have a deadline even if stream cancellation fails or never resolves', { timeout: 5_000 }, async () => {
  for (const cancellation of ['normal', 'reject', 'never']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"error":')); },
      cancel() {
        cancelled = true;
        if (cancellation === 'reject') return Promise.reject(new Error(secret));
        if (cancellation === 'never') return new Promise<void>(() => {});
      },
    });
    const result = await fails(new Response(body, { status: 400 }));
    assert.equal(result.message, httpError(400, 'keys').message);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test('an empty-chunk flood is bounded and releases its reader', { timeout: 5_000 }, async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } });
  await fails(new Response(body, { status: 409 }));
  assert.ok(pulls <= 1025);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('request timeout after error headers preserves 400 while explicit interruption still wins', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({});
    const client = new HttpClient(origin, { timeoutMs: abort ? 10_000 : 10, fetch: async () => new Response(body, { status: 400 }) });
    const pending = client.request('/console/api-keys/generate', { ...options, signal: controller.signal });
    if (abort) { await nextTurn(); controller.abort(new Error(secret)); }
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, abort ? 'INTERRUPTED' : 'API_VALIDATION');
      assert.equal(error.exitCode, abort ? 130 : 2);
      assert.ok(!error.message.includes(secret));
      if (!abort) assert.equal(error.status, 400);
      return true;
    });
    assert.equal(body.locked, false);
  }
});

test('successful key responses retain their normal size budget and unmodified fields', async () => {
  const data = { success: true, data: { apiKey: secret }, extra: 'x'.repeat(17 * 1024) };
  const client = new HttpClient(origin, { fetch: async () => Response.json(data) });
  assert.deepEqual(await client.request('/console/api-keys/generate', options), data);
});
