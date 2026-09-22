import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { PRODUCTION_ORIGIN, type Environment } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { loadCredential, readSession, readTokenInput, removeSession, saveSession, tokenExpiry, validateToken } from '../src/session.js';

const staging = 'https://staging.example.test';
const posix = { skip: process.platform === 'win32' ? 'POSIX filesystem checks; Windows persistence is unsupported.' : false };
const syntheticToken = 'synthetic-session-secret';
const execute = promisify(execFile);

function code(expected: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(syntheticToken));
    assert.ok(!error.message.includes('secret-path-marker'));
    return true;
  };
}

function jwt(payload: unknown): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic-signature`;
}

async function fixture(t: TestContext): Promise<{ root: string; directory: string; env: Environment }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'geodd-session-'));
  await chmod(root, 0o700);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'secret-path-marker');
  return { root, directory, env: { GEODD_CONFIG_DIR: directory } };
}

function recordPath(directory: string, origin = PRODUCTION_ORIGIN): string {
  return join(directory, `session-${createHash('sha256').update(origin).digest('hex')}.json`);
}

test('tokens are bounded before trimming and reject embedded whitespace or unsafe header text', () => {
  assert.equal(validateToken(` \t${syntheticToken}\r\n`), syntheticToken);
  assert.equal(validateToken('not-a-jwt'), 'not-a-jwt');
  assert.equal(validateToken('a'.repeat(16384)), 'a'.repeat(16384));
  for (const token of ['', ' \n\t', 'first\nsecond', 'first\rsecond', 'first second', 'first\tsecond', 'a\0b', 'a\x7fb', 'a\x1bb', 'é', 'a\u00a0b', 'a\u200bb', 'a'.repeat(16385), ' '.repeat(16384) + 'a']) {
    assert.throws(() => validateToken(token), code('INVALID_SESSION_TOKEN'));
  }
});

test('JWT expiry is advisory and tolerates non-JWT or malformed payloads', () => {
  assert.equal(tokenExpiry(jwt({ exp: 0 })), '1970-01-01T00:00:00.000Z');
  assert.equal(tokenExpiry(jwt({ exp: 1.5 })), '1970-01-01T00:00:01.500Z');
  for (const token of [syntheticToken, 'a.b.c.d', 'a.%%%.c', 'a._w.c', 'a..c', jwt({}), jwt({ exp: '123' }), jwt({ exp: null }), jwt([]), jwt({ exp: 1e100 }), 'a'.repeat(16385)]) {
    assert.equal(tokenExpiry(token), undefined);
  }
});

test('stdin reads bounded byte and string chunks and trims the outer newline', async () => {
  assert.equal(await readTokenInput(Readable.from([Buffer.from(' synthe'), Buffer.from('tic-session-secret\n')])), syntheticToken);
  assert.equal(await readTokenInput(Readable.from(['token\r\n'])), 'token');
  assert.equal((await readTokenInput(Readable.from(['a'.repeat(16384)]))).length, 16384);
  await assert.rejects(readTokenInput(Readable.from(['first\nsecond'])), code('INVALID_SESSION_TOKEN'));
  await assert.rejects(readTokenInput(Readable.from([])), code('INVALID_SESSION_TOKEN'));
  await assert.rejects(readTokenInput(Readable.from([Buffer.from([0xff])])), code('INVALID_SESSION_TOKEN'));
  await assert.rejects(readTokenInput(Readable.from([{}])), code('TOKEN_INPUT_ERROR'));
});

test('stdin rejects oversized data without waiting for EOF and cleans up listeners', async () => {
  const input = new PassThrough();
  const reading = readTokenInput(input);
  const rejected = assert.rejects(reading, code('INVALID_SESSION_TOKEN'));
  input.write('a'.repeat(16000));
  input.write('b'.repeat(385));
  await rejected;
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(input.isPaused(), true);
  input.destroy();
});

test('stdin aborts before input and while blocked, without leaking abort reasons', async () => {
  const already = AbortSignal.abort(new Error(syntheticToken));
  await assert.rejects(readTokenInput(new PassThrough(), already), error => {
    code('INTERRUPTED')(error);
    assert.equal((error as CliError).exitCode, 130);
    return true;
  });
  const input = new PassThrough();
  const controller = new AbortController();
  const reading = readTokenInput(input, controller.signal);
  const rejected = assert.rejects(reading, code('INTERRUPTED'));
  input.write('partial');
  controller.abort(new Error(syntheticToken));
  await rejected;
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('close'), 0);
  input.destroy();
});

test('stdin handles failures and premature close using static errors', async () => {
  const failed = new PassThrough();
  const reading = assert.rejects(readTokenInput(failed), code('TOKEN_INPUT_ERROR'));
  failed.destroy(new Error(syntheticToken));
  await reading;
  const closed = new PassThrough();
  const premature = assert.rejects(readTokenInput(closed), code('TOKEN_INPUT_ERROR'));
  closed.destroy();
  await premature;
  await assert.rejects(readTokenInput(closed), code('TOKEN_INPUT_ERROR'));
});

test('environment sessions are origin-bound and need no storage', async () => {
  const env: Environment = { GEODD_CONFIG_DIR: '', GEODD_SESSION_TOKEN: ` ${syntheticToken}\n` };
  assert.deepEqual(await loadCredential('https://API.GEODD.IO:443/', env), { token: syntheticToken, source: 'environment', account: {} });
  await assert.rejects(loadCredential(staging, env), code('ENV_SESSION_ORIGIN_MISMATCH'));
  env.GEODD_SESSION_TOKEN_ORIGIN = staging + ':443/';
  assert.equal((await loadCredential(staging, env)).source, 'environment');
  await assert.rejects(loadCredential(PRODUCTION_ORIGIN, env), code('ENV_SESSION_ORIGIN_MISMATCH'));
  env.GEODD_SESSION_TOKEN_ORIGIN = 'https://secret-path-marker.invalid/path';
  await assert.rejects(loadCredential(staging, env), code('INVALID_ORIGIN'));
});

test('expired environment sessions remain selected for backend validation', async () => {
  const token = jwt({ exp: 0 });
  assert.deepEqual(await loadCredential(PRODUCTION_ORIGIN, { GEODD_SESSION_TOKEN: token }), {
    token, source: 'environment', account: {}, expiresAt: '1970-01-01T00:00:00.000Z',
  });
});

test('sessions use canonical origin names, versioned records, and private POSIX modes', posix, async t => {
  const { directory, env } = await fixture(t);
  const token = jwt({ exp: 0 });
  await saveSession('https://API.GEODD.IO:443/', token, { email: 'person@example.test' }, env);
  assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  const path = recordPath(directory);
  assert.equal((await lstat(path)).mode & 0o7777, 0o600);
  assert.equal((await lstat(path)).nlink, 1);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1, origin: PRODUCTION_ORIGIN, token, account: { email: 'person@example.test' }, expiresAt: '1970-01-01T00:00:00.000Z',
  });
  assert.deepEqual(await loadCredential(PRODUCTION_ORIGIN, env), {
    token, source: 'file', account: { email: 'person@example.test' }, expiresAt: '1970-01-01T00:00:00.000Z',
  });
  assert.equal((await readSession(PRODUCTION_ORIGIN, env))?.version, 1);
  assert.deepEqual(await readdir(directory), [path.slice(directory.length + 1)]);
});

test('replacement is atomic, retains private modes, and leaves no temporary files', posix, async t => {
  const { directory, env } = await fixture(t);
  await saveSession(PRODUCTION_ORIGIN, 'old-token', {}, env);
  const old = await open(recordPath(directory), 'r');
  try {
    await saveSession(PRODUCTION_ORIGIN, 'new-token', {}, env);
    assert.equal(JSON.parse(await old.readFile('utf8')).token, 'old-token');
    assert.equal((await readSession(PRODUCTION_ORIGIN, env))?.token, 'new-token');
    assert.notEqual((await old.stat()).ino, (await lstat(recordPath(directory))).ino);
  } finally { await old.close(); }
  await Promise.all(Array.from({ length: 8 }, (_, index) => saveSession(PRODUCTION_ORIGIN, `token-${index}`, {}, env)));
  assert.match((await loadCredential(PRODUCTION_ORIGIN, env)).token, /^token-[0-7]$/);
  assert.equal((await readdir(directory)).length, 1);
  assert.equal((await lstat(recordPath(directory))).mode & 0o7777, 0o600);
});

test('new directories and files have exact private permissions despite a restrictive umask', posix, async t => {
  const { directory, env } = await fixture(t);
  const mask = process.umask(0o777);
  try { await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env); }
  finally { process.umask(mask); }
  assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  assert.equal((await lstat(recordPath(directory))).mode & 0o7777, 0o600);
});

test('origins are isolated and environment precedence never saves or falls back', posix, async t => {
  const { directory, env } = await fixture(t);
  await saveSession(PRODUCTION_ORIGIN, 'production-file', {}, env);
  await saveSession(staging, 'staging-file', {}, env);
  assert.equal((await loadCredential(PRODUCTION_ORIGIN, env)).token, 'production-file');
  assert.equal((await loadCredential(staging, env)).token, 'staging-file');
  const before = await readFile(recordPath(directory));
  const injected = { ...env, GEODD_SESSION_TOKEN: syntheticToken };
  assert.equal((await loadCredential(PRODUCTION_ORIGIN, injected)).token, syntheticToken);
  await assert.rejects(loadCredential(staging, injected), code('ENV_SESSION_ORIGIN_MISMATCH'));
  await assert.rejects(loadCredential(PRODUCTION_ORIGIN, { ...injected, GEODD_SESSION_TOKEN: '' }), code('INVALID_SESSION_TOKEN'));
  await assert.rejects(loadCredential(PRODUCTION_ORIGIN, { ...injected, GEODD_SESSION_TOKEN: 'one\ntwo' }), code('INVALID_SESSION_TOKEN'));
  assert.equal((await loadCredential(staging, { ...injected, GEODD_SESSION_TOKEN_ORIGIN: staging })).token, syntheticToken);
  assert.deepEqual(await readFile(recordPath(directory)), before);
  assert.equal((await readdir(directory)).length, 2);
  await assert.rejects(loadCredential('https://other.example.test', env), code('SESSION_MISSING'));
});

test('explicit saving persists only its supplied token, never an overriding environment token', posix, async t => {
  const { env } = await fixture(t);
  const injected = { ...env, GEODD_SESSION_TOKEN: syntheticToken };
  await saveSession(staging, 'explicit-import-token', {}, injected);
  assert.equal((await readSession(staging, env))?.token, 'explicit-import-token');
  assert.equal(await readSession(PRODUCTION_ORIGIN, env), undefined);
  await assert.rejects(loadCredential(staging, injected), code('ENV_SESSION_ORIGIN_MISMATCH'));
  assert.equal((await loadCredential(staging, { ...env, GEODD_SESSION_TOKEN_ORIGIN: PRODUCTION_ORIGIN })).token, 'explicit-import-token');
});

test('missing session reads and logout do not create configuration directories', posix, async t => {
  const { directory, env } = await fixture(t);
  assert.equal(await readSession(PRODUCTION_ORIGIN, env), undefined);
  assert.equal(await removeSession(PRODUCTION_ORIGIN, env), false);
  await assert.rejects(loadCredential(PRODUCTION_ORIGIN, env), code('SESSION_MISSING'));
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});

test('logout removes only the selected local origin and remains idempotent', posix, async t => {
  const { env } = await fixture(t);
  await saveSession(PRODUCTION_ORIGIN, 'production-file', {}, env);
  await saveSession(staging, 'staging-file', {}, env);
  const injected = { ...env, GEODD_SESSION_TOKEN: syntheticToken };
  assert.equal(await removeSession('https://api.geodd.io:443/', injected), true);
  assert.equal(await removeSession(PRODUCTION_ORIGIN, injected), false);
  assert.equal((await loadCredential(PRODUCTION_ORIGIN, injected)).source, 'environment');
  assert.equal(injected.GEODD_SESSION_TOKEN, syntheticToken);
  assert.equal((await loadCredential(staging, env)).token, 'staging-file');
});

test('invalid records fail closed without exposing content', posix, async t => {
  const { directory, env } = await fixture(t);
  await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env);
  const valid = { version: 1, origin: PRODUCTION_ORIGIN, token: syntheticToken, account: {} };
  const cases: Array<[unknown, string]> = [
    [null, 'SESSION_RECORD_INVALID'], [[], 'SESSION_RECORD_INVALID'],
    [{ ...valid, version: 2 }, 'SESSION_VERSION_UNSUPPORTED'], [{}, 'SESSION_VERSION_UNSUPPORTED'],
    [{ ...valid, origin: staging }, 'SESSION_ORIGIN_MISMATCH'],
    [{ ...valid, origin: PRODUCTION_ORIGIN + '/' }, 'SESSION_ORIGIN_MISMATCH'],
    [{ ...valid, token: 'one\ntwo' }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, token: ' spaced ' }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, token: null }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, token: 'a'.repeat(16385) }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, account: null }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, account: { email: 1 } }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, account: { email: 'person\n@example.test' } }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, account: { password: syntheticToken } }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, expiresAt: 123 }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, expiresAt: 'not-a-date' }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, expiresAt: '2026-01-01' }, 'SESSION_RECORD_INVALID'],
    [{ ...valid, other: syntheticToken }, 'SESSION_RECORD_INVALID'],
  ];
  for (const [record, expected] of cases) {
    await writeFile(recordPath(directory), JSON.stringify(record));
    await assert.rejects(loadCredential(PRODUCTION_ORIGIN, env), code(expected));
  }
  for (const data of ['{invalid ' + syntheticToken, 'a'.repeat(32769), Buffer.from([0xff])]) {
    await writeFile(recordPath(directory), data);
    await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_RECORD_INVALID'));
  }
  assert.equal(await removeSession(PRODUCTION_ORIGIN, env), true);
});

test('broadly accessible directories and files are refused without changing modes', posix, async t => {
  const { directory, env } = await fixture(t);
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(removeSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  assert.equal((await lstat(directory)).mode & 0o7777, 0o755);
  assert.deepEqual(await readdir(directory), []);
  await chmod(directory, 0o700);
  await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env);
  await chmod(recordPath(directory), 0o644);
  await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, 'replacement', {}, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(removeSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  assert.equal((await lstat(recordPath(directory))).mode & 0o7777, 0o644);
});

test('unsafe writable ancestors are refused even when the config directory is private', posix, async t => {
  const { root, env } = await fixture(t);
  await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env);
  await chmod(root, 0o777);
  try {
    await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
    await assert.rejects(saveSession(PRODUCTION_ORIGIN, 'replacement', {}, env), code('SESSION_STORAGE_UNSAFE'));
  } finally { await chmod(root, 0o700); }
});

test('config and ancestor symlinks are refused without touching their targets', posix, async t => {
  const { root, directory, env } = await fixture(t);
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, directory);
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(removeSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, { GEODD_CONFIG_DIR: join(directory, 'nested') }), code('SESSION_STORAGE_UNSAFE'));
  assert.deepEqual(await readdir(target), []);
});

test('session symlinks and hardlinks cannot be read, replaced, or removed', posix, async t => {
  const { root, directory, env } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const target = join(root, 'target');
  await writeFile(target, syntheticToken, { mode: 0o600 });
  const path = recordPath(directory);
  for (const kind of ['symlink', 'hardlink'] as const) {
    if (kind === 'symlink') await symlink(target, path);
    else await link(target, path);
    await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
    await assert.rejects(saveSession(PRODUCTION_ORIGIN, 'replacement', {}, env), code('SESSION_STORAGE_UNSAFE'));
    await assert.rejects(removeSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
    assert.equal(await readFile(target, 'utf8'), syntheticToken);
    await rm(path);
  }
  await symlink(join(root, 'missing'), path);
  await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
});

test('nonregular session paths and config files are refused', posix, async t => {
  const { directory, env } = await fixture(t);
  await writeFile(directory, 'not a directory', { mode: 0o600 });
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env), code('SESSION_STORAGE_UNSAFE'));
  await rm(directory);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(recordPath(directory), { mode: 0o700 });
  await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env), code('SESSION_STORAGE_UNSAFE'));
  await assert.rejects(removeSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
});

test('validation failures do not create session storage', posix, async t => {
  const { directory, env } = await fixture(t);
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, 'one\ntwo', {}, env), code('INVALID_SESSION_TOKEN'));
  await assert.rejects(saveSession(PRODUCTION_ORIGIN, syntheticToken, { email: '\x1bsecret-path-marker' }, env), code('SESSION_RECORD_INVALID'));
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});

test('macOS trusted /var temp alias works without permitting user symlinks', { skip: process.platform !== 'darwin' }, async t => {
  const { directory } = await fixture(t);
  assert.ok(directory.startsWith('/private/var/'));
  const env = { GEODD_CONFIG_DIR: directory.replace(/^\/private\/var\//, '/var/') };
  await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env);
  assert.equal((await loadCredential(PRODUCTION_ORIGIN, env)).token, syntheticToken);
});

test('macOS allow ACLs cannot silently broaden mode-private storage', { skip: process.platform !== 'darwin' }, async t => {
  const { root, directory, env } = await fixture(t);
  await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env);
  for (const [path, permission] of [[root, 'add_subdirectory'], [directory, 'list,search'], [recordPath(directory), 'read']] as const) {
    await execute('/bin/chmod', ['+a', `everyone allow ${permission}`, path]);
    try {
      assert.equal((await lstat(path)).mode & 0o777, path === recordPath(directory) ? 0o600 : 0o700);
      await assert.rejects(readSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
      await assert.rejects(saveSession(PRODUCTION_ORIGIN, 'replacement', {}, env), code('SESSION_STORAGE_UNSAFE'));
      await assert.rejects(removeSession(PRODUCTION_ORIGIN, env), code('SESSION_STORAGE_UNSAFE'));
    } finally { await execute('/bin/chmod', ['-N', path]); }
  }
});

test('macOS deny-only default ACLs do not prevent private storage', { skip: process.platform !== 'darwin' }, async t => {
  const { directory, env } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  await execute('/bin/chmod', ['+a', 'everyone deny delete', directory]);
  try {
    await saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, env);
    assert.equal((await loadCredential(PRODUCTION_ORIGIN, env)).token, syntheticToken);
  } finally { await execute('/bin/chmod', ['-N', directory]); }
});

test('Windows persistence fails closed with the environment-session alternative', { skip: process.platform !== 'win32' ? 'Requires actual Windows; ACL behavior is not claimed tested.' : false }, async () => {
  for (const operation of [() => readSession(PRODUCTION_ORIGIN, {}), () => saveSession(PRODUCTION_ORIGIN, syntheticToken, {}, {}), () => removeSession(PRODUCTION_ORIGIN, {})]) {
    await assert.rejects(operation(), error => {
      code('SESSION_PERSISTENCE_UNSUPPORTED')(error);
      assert.match((error as CliError).message, /GEODD_SESSION_TOKEN_ORIGIN/);
      assert.match((error as CliError).message, /not been verified/);
      return true;
    });
  }
});
