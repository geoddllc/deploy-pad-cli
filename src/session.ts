import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readlink, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { configDirectory, normalizeOrigin, PRODUCTION_ORIGIN, type Environment } from './config.js';
import { CliError, interrupted, isRecord, safeText } from './errors.js';

export type AccountSummary = { email?: string };
export type SessionRecord = { version: 1; origin: string; token: string; account: AccountSummary; expiresAt?: string };
export type Credential = { token: string; source: 'environment' | 'file'; account: AccountSummary; expiresAt?: string };

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_SESSION_BYTES = 32 * 1024;
const execute = promisify(execFile);

export function validateToken(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_TOKEN_BYTES || Buffer.byteLength(value) > MAX_TOKEN_BYTES) {
    throw new CliError('INVALID_SESSION_TOKEN', 'Session token input must be at most 16384 bytes, including surrounding whitespace.', 2);
  }
  const token = value.trim();
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new CliError('INVALID_SESSION_TOKEN', 'Supply one nonempty session token without embedded whitespace, line breaks, or control characters.', 2);
  }
  return token;
}

export function tokenExpiry(token: string): string | undefined {
  if (token.length > MAX_TOKEN_BYTES) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return undefined;
  try {
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url')));
    if (!isRecord(payload) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined;
    // This is unverified display metadata, never a local authorization decision.
    return new Date(payload.exp * 1000).toISOString();
  } catch { return undefined; }
}

export function readTokenInput(input: Readable, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: CliError, value?: string): void => {
      if (settled) return;
      settled = true;
      input.pause();
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      chunks.length = 0;
      if (error) reject(error);
      else resolveInput(value!);
    };
    const onData = (chunk: unknown): void => {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        finish(new CliError('TOKEN_INPUT_ERROR', 'Could not read session token input as text.', 2));
        return;
      }
      const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      size += length;
      if (size > MAX_TOKEN_BYTES) {
        finish(new CliError('INVALID_SESSION_TOKEN', 'Session token input must be at most 16384 bytes, including surrounding whitespace.', 2));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        finish(undefined, validateToken(value));
      } catch (error) {
        finish(error instanceof CliError ? error : new CliError('INVALID_SESSION_TOKEN', 'Session token input must be valid UTF-8 text.', 2));
      }
    };
    const onError = (): void => finish(new CliError('TOKEN_INPUT_ERROR', 'Could not read session token input.', 2));
    const onClose = (): void => finish(new CliError('TOKEN_INPUT_ERROR', 'Session token input closed before completion.', 2));
    const onAbort = (): void => finish(interrupted());
    if (signal?.aborted) { onAbort(); return; }
    if (input.readableEnded) { onEnd(); return; }
    if (input.destroyed) { onClose(); return; }
    input.on('error', onError);
    input.on('end', onEnd);
    input.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    input.on('data', onData);
  });
}

function unsafeStorage(): CliError {
  return new CliError('SESSION_STORAGE_UNSAFE', 'Refusing unsafe session storage. Use a user-owned private config directory (0700), regular session files (0600), and no symlinks or hardlinks. Ancestors must not be writable by other users except trusted sticky directories. macOS allow ACLs are not accepted. Alternatively supply GEODD_SESSION_TOKEN and matching GEODD_SESSION_TOKEN_ORIGIN.', 2);
}

function storageError(error: unknown): CliError {
  return error instanceof CliError ? error : new CliError('SESSION_STORAGE_ERROR', 'Could not access private session storage. Check the config directory and permissions, or supply GEODD_SESSION_TOKEN and matching GEODD_SESSION_TOKEN_ORIGIN.', 2);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function existing(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
}

function privateFile(stat: Stats): void {
  // An atomic replacement can unlink an already opened inode; zero links is safe.
  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600 || stat.nlink > 1) throw unsafeStorage();
}

async function privateAcl(path: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  // Unlike Linux ACL masks, macOS allow ACEs can grant access beyond mode bits.
  // Accept only absent or deny-only ACLs; an unavailable inspector fails closed.
  const { stdout, stderr } = await execute('/bin/ls', ['-ldebn', '--', path], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
  const lines = stdout.trimEnd().split('\n');
  if (stderr || !/^[d-][rwxStTs-]{9}[+@ ]/.test(lines[0] ?? '') || (lines[0]?.[10] === '+' && lines.length === 1)
    || lines.slice(1).some(line => !/^ \d+: [0-9A-Fa-f-]{36}(?: inherited)? deny [a-z_,]+$/.test(line))) throw unsafeStorage();
}

async function sessionDirectory(env: Environment, create: boolean): Promise<string | undefined> {
  if (process.platform === 'win32' || !process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new CliError('SESSION_PERSISTENCE_UNSUPPORTED', 'Private session persistence is unsupported on this platform: user-private Windows ACL validation and inheritance have not been verified. No session file was accessed. Supply GEODD_SESSION_TOKEN and set GEODD_SESSION_TOKEN_ORIGIN to the selected API origin instead; environment sessions are not saved automatically.', 2);
  }
  const directory = resolve(configDirectory(env));
  const root = parse(directory).root;
  const parts = directory.slice(root.length).split(sep).filter(Boolean);
  if (!parts.length) throw unsafeStorage();
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let stat = await existing(current);
    if (!stat) {
      if (!create) return undefined;
      try {
        await mkdir(current, { mode: 0o700 });
        await chmod(current, 0o700);
      } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      stat = await lstat(current);
    }
    // macOS ships these root-controlled aliases, including the default temp path.
    // User-controlled symlinks, including the config directory itself, are refused.
    if (process.platform === 'darwin' && index < parts.length - 1 && stat.isSymbolicLink() && stat.uid === 0
      && (current === '/var' || current === '/tmp') && resolve(root, await readlink(current)) === `/private${current}`) {
      const parent = await lstat('/private');
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) throw unsafeStorage();
      await privateAcl('/private');
      current = `/private${current}`;
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid())) throw unsafeStorage();
    if (index === parts.length - 1) {
      if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw unsafeStorage();
    } else if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) throw unsafeStorage();
    await privateAcl(current);
  }
  return current;
}

function sessionPath(directory: string, origin: string): string {
  return join(directory, `session-${createHash('sha256').update(origin).digest('hex')}.json`);
}

function invalidRecord(): CliError {
  return new CliError('SESSION_RECORD_INVALID', 'The stored session record is invalid. Remove the local session and authenticate again, or supply an environment session.', 3);
}

function accountSummary(value: unknown): AccountSummary {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'email')) throw invalidRecord();
  if (value.email === undefined) return {};
  if (typeof value.email !== 'string' || !value.email || value.email.length > 320 || /\s/u.test(value.email)
    || safeText(value.email) !== value.email) throw invalidRecord();
  return { email: value.email };
}

function parseSession(value: unknown, origin: string): SessionRecord {
  if (!isRecord(value)) throw invalidRecord();
  if (value.version !== 1) {
    throw new CliError('SESSION_VERSION_UNSUPPORTED', 'The stored session format is missing or unsupported. Remove the local session and authenticate again.', 3);
  }
  if (value.origin !== origin) throw new CliError('SESSION_ORIGIN_MISMATCH', 'The stored session does not match the selected API origin. No credential was selected.', 3);
  if (Object.keys(value).some(key => !['version', 'origin', 'token', 'account', 'expiresAt'].includes(key))) throw invalidRecord();
  if (typeof value.token !== 'string') throw invalidRecord();
  try { if (validateToken(value.token) !== value.token) throw invalidRecord(); }
  catch { throw invalidRecord(); }
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== 'string') throw invalidRecord();
    const date = new Date(value.expiresAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.expiresAt) throw invalidRecord();
  }
  return { version: 1, origin, token: value.token, account: accountSummary(value.account),
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt as string } : {}) };
}

export async function readSession(origin: string, env: Environment = process.env): Promise<SessionRecord | undefined> {
  origin = normalizeOrigin(origin);
  try {
    const directory = await sessionDirectory(env, false);
    if (!directory) return undefined;
    const path = sessionPath(directory, origin);
    const stat = await existing(path);
    if (!stat) return undefined;
    privateFile(stat);
    await privateAcl(path);
    let file: FileHandle;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
    try {
      const opened = await file.stat();
      privateFile(opened);
      if (opened.size > MAX_SESSION_BYTES) throw invalidRecord();
      const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_SESSION_BYTES) throw invalidRecord();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
      catch { throw invalidRecord(); }
      return parseSession(value, origin);
    } finally { await file.close(); }
  } catch (error) { throw storageError(error); }
}

export async function loadCredential(origin: string, env: Environment = process.env): Promise<Credential> {
  origin = normalizeOrigin(origin);
  if (env.GEODD_SESSION_TOKEN !== undefined) {
    const boundOrigin = normalizeOrigin(env.GEODD_SESSION_TOKEN_ORIGIN ?? PRODUCTION_ORIGIN);
    if (boundOrigin !== origin) {
      throw new CliError('ENV_SESSION_ORIGIN_MISMATCH', 'GEODD_SESSION_TOKEN is bound to a different API origin. Set GEODD_SESSION_TOKEN_ORIGIN to the intended origin or unset the environment token. No stored credential was tried.', 3);
    }
    const token = validateToken(env.GEODD_SESSION_TOKEN);
    const expiresAt = tokenExpiry(token);
    return { token, source: 'environment', account: {}, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }
  const session = await readSession(origin, env);
  if (!session) throw new CliError('SESSION_MISSING', 'No session is available for the selected API origin. Authenticate or supply GEODD_SESSION_TOKEN with matching GEODD_SESSION_TOKEN_ORIGIN.', 3);
  return { token: session.token, source: 'file', account: session.account,
    ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}) };
}

export async function saveSession(origin: string, token: string, account: AccountSummary, env: Environment = process.env): Promise<void> {
  origin = normalizeOrigin(origin);
  token = validateToken(token);
  const expiresAt = tokenExpiry(token);
  const record: SessionRecord = { version: 1, origin, token, account: accountSummary(account),
    ...(expiresAt !== undefined ? { expiresAt } : {}) };
  const data = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(data) > MAX_SESSION_BYTES) throw invalidRecord();
  let temporary: string | undefined;
  try {
    const directory = (await sessionDirectory(env, true))!;
    const path = sessionPath(directory, origin);
    const previous = await existing(path);
    if (previous) { privateFile(previous); await privateAcl(path); }
    const candidate = join(directory, `.session-${randomUUID()}.tmp`);
    const file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporary = candidate;
    try {
      await file.chmod(0o600);
      privateFile(await file.stat());
      await privateAcl(temporary);
      await file.writeFile(data, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    const destination = await existing(path);
    if (destination) { privateFile(destination); await privateAcl(path); }
    await rename(temporary, path);
    temporary = undefined;
    const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await folder.sync(); } finally { await folder.close(); }
  } catch (error) { throw storageError(error); }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}

export async function removeSession(origin: string, env: Environment = process.env): Promise<boolean> {
  origin = normalizeOrigin(origin);
  try {
    const directory = await sessionDirectory(env, false);
    if (!directory) return false;
    const path = sessionPath(directory, origin);
    const stat = await existing(path);
    if (!stat) return false;
    privateFile(stat);
    await privateAcl(path);
    try { await unlink(path); }
    catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
    return true;
  } catch (error) { throw storageError(error); }
}
