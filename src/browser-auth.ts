import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import open from 'open';
import { CliError, interrupted, isRecord, safeText } from './errors.js';
import { httpError, type RequestOptions } from './http.js';
import type { Context } from './runtime.js';

interface BrowserSession { token: string; account: { email?: string } }
interface BrowserOptions {
  signup: boolean;
  noBrowser: boolean;
  port: number;
  clientId: string;
  lifetimeMs?: number;
  twoFactorLifetimeMs?: number;
  onSession?: (session: BrowserSession) => Promise<void>;
}

const maxBody = 16 * 1024;
const headers = {
  'cache-control': 'no-store, max-age=0',
  pragma: 'no-cache',
  'content-security-policy': "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; img-src 'self' data: https://*.googleusercontent.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function json(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function protocolError(): CliError {
  return new CliError('MALFORMED_AUTH_RESPONSE', 'The service returned an inconsistent authentication response. Start a fresh login or contact support.');
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBody && !/\s|[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function identity(value: unknown, requireId = true): { email?: string } {
  if (!isRecord(value) || ((requireId || value._id !== undefined) && (typeof value._id !== 'string' || !value._id))) throw protocolError();
  if (value.email === undefined) return {};
  if (typeof value.email !== 'string' || !value.email || value.email.length > 320 || safeText(value.email) !== value.email) throw protocolError();
  return { email: value.email };
}

function fullSession(data: unknown, verified: boolean): BrowserSession {
  if (!isRecord(data) || data.success !== true || !secret(data.token)
    || (data.requiresTwoFactor !== undefined && data.requiresTwoFactor !== false) || data.tempToken !== undefined
    || (verified ? data.twoFactorSetup !== undefined && typeof data.twoFactorSetup !== 'boolean' : data.twoFactorSetup !== false)
    || (data.twoFactorVerified !== undefined && (verified ? data.twoFactorVerified !== true : typeof data.twoFactorVerified !== 'boolean'))) throw protocolError();
  return { token: data.token, account: verified && data.result === undefined ? {} : identity(data.result, !verified) };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) {
    throw new CliError('INVALID_CONTENT_TYPE', 'Use an uncompressed JSON request.', 2, 415);
  }
  if (Number(req.headers['content-length']) > maxBody) throw new CliError('BODY_TOO_LARGE', 'The local request exceeded the allowed size.', 2, 413);
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the socket on a size error: send a bounded static error first.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBody) throw new CliError('BODY_TOO_LARGE', 'The local request exceeded the allowed size.', 2, 413);
    chunks.push(part);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (isRecord(body)) return body;
  } catch { /* Invalid input has a static error, never a reflected body. */ }
  throw new CliError('INVALID_JSON', 'The local request must contain a JSON object.', 2, 400);
}

function safeFailure(error: unknown, context?: RequestOptions['context']): CliError {
  if (!(error instanceof CliError)) return new CliError('AUTH_FAILED', 'Authentication could not complete. Start a fresh login.');
  if (error.code === 'TWO_FACTOR_EXPIRED' || context === 'two-factor' && error.status === 410) return new CliError('TWO_FACTOR_EXPIRED', 'The temporary 2FA session expired. Start a fresh login.', 3, 410);
  if (error.status !== undefined && error.status >= 400) return httpError(error.status, context);
  const messages: Record<string, string> = {
    TIMEOUT: 'The authentication request timed out. Its outcome is uncertain; do not blindly retry signup or email delivery.',
    TRANSPORT_ERROR: 'The API could not be reached. Check the API origin and network access, then start a fresh login.',
    REDIRECT_REJECTED: 'An API redirect was rejected. Check the configured API origin.',
    API_REJECTED: 'The service rejected authentication. Check your code, required consents, or account policy.',
    INTERRUPTED: 'Operation interrupted.',
    MALFORMED_AUTH_RESPONSE: protocolError().message,
  };
  return new CliError(error.code, messages[error.code] ?? 'The service could not complete authentication. Start a fresh login or contact support.', error.exitCode);
}

export async function browserAuth(ctx: Context, options: BrowserOptions): Promise<BrowserSession> {
  if (!ctx.interactive && !options.noBrowser) throw new CliError('INTERACTIVE_REQUIRED', 'Noninteractive browser authentication requires --no-browser. Use an environment session or --token-stdin for remote automation.', 2);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new CliError('INVALID_PORT', 'Choose a port between 1 and 65535 already authorized for the Google Web Client ID.', 2);
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(options.clientId)) throw new CliError('GOOGLE_CONFIG_MISSING', 'Configure GEODD_GOOGLE_CLIENT_ID with the existing Google Web Client ID and authorize the exact localhost origin.', 2);
  for (const duration of [options.lifetimeMs, options.twoFactorLifetimeMs]) {
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) throw new CliError('INVALID_LIFETIME', 'Authentication lifetime must be positive and finite.', 2);
  }
  if (ctx.signal.aborted) throw interrupted();
  let assets: Map<string, { type: string; body: Buffer }>;
  try {
    assets = new Map(await Promise.all([
      ['/', 'index.html', 'text/html'], ['/auth.js', 'auth.js', 'text/javascript'], ['/auth.css', 'auth.css', 'text/css'],
    ].map(async ([path, file, type]) => [path!, { type: `${type}; charset=utf-8`, body: await readFile(new URL(`./assets/${file}`, import.meta.url)) }] as const)));
  } catch { throw new CliError('BROWSER_ASSETS_MISSING', 'Browser authentication assets are missing. Reinstall the CLI package.'); }
  const host = `localhost:${options.port}`;
  const origin = `http://${host}`;
  const nonce = randomBytes(32).toString('base64url');
  const url = `${origin}/#${nonce}`;
  const expiresAt = Date.now() + Math.min(options.lifetimeMs ?? 600_000, 600_000);

  return new Promise<BrowserSession>((resolve, reject) => {
    const requests = new AbortController();
    let settled = false;
    let phase: 'google' | 'exchange' | 'two-factor' | 'verify' | 'email' | 'persist' = 'google';
    let tempToken: string | undefined;
    let emailAfter = 0;
    let twoFactorTimer: NodeJS.Timeout | undefined;
    let flowTimer: NodeJS.Timeout | undefined;

    const server = createServer((req, res) => {
      res.on('error', () => {});
      void handle(req, res).catch(() => {
        json(res, 500, { success: false, message: 'The local authentication request failed. Start a fresh login.' });
        finish(new CliError('BROWSER_AUTH_FAILED', 'The local authentication request failed. Start a fresh login.'));
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 32;
    server.timeout = 30_000;
    server.on('timeout', socket => socket.destroy());

    function finish(error?: CliError, session?: BrowserSession): void {
      if (settled) return;
      settled = true;
      tempToken = undefined;
      requests.abort();
      clearTimeout(flowTimer);
      clearTimeout(twoFactorTimer);
      ctx.signal.removeEventListener('abort', abort);
      process.removeListener('SIGINT', abort);
      server.close();
      // Allow a queued final response to flush, but never wait on a browser acknowledgement.
      setImmediate(() => server.closeAllConnections());
      if (session) resolve(session);
      else reject(error ?? new CliError('AUTH_CANCELLED', 'Browser authentication was cancelled.', 4));
    }
    function abort(): void { finish(interrupted()); }
    async function complete(data: unknown, verified: boolean, res: ServerResponse): Promise<void> {
      const session = fullSession(data, verified);
      phase = 'persist';
      tempToken = undefined;
      // Authentication has finished. Let the atomic save finish before reporting its outcome.
      clearTimeout(flowTimer);
      clearTimeout(twoFactorTimer);
      ctx.signal.removeEventListener('abort', abort);
      process.removeListener('SIGINT', abort);
      try { await options.onSession?.(session); }
      catch (error) {
        const failure = error instanceof CliError ? error : new CliError('SESSION_SAVE_FAILED', 'Authentication completed but the session could not be saved. Check private session storage and authenticate again.');
        json(res, failure.status ?? 500, { success: false, code: failure.code, message: failure.message });
        finish(failure);
        return;
      }
      if (settled) return;
      json(res, 200, { success: true, state: 'complete' });
      finish(undefined, session);
    }
    async function exchange(path: string, body: unknown, context: RequestOptions['context']): Promise<unknown> {
      try { return await ctx.http.request(path, { method: 'POST', body, context: context!, mutation: true, signal: requests.signal }); }
      catch (error) { throw safeFailure(error, context); }
    }
    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (settled) { json(res, 410, { success: false, message: 'This authentication attempt has ended.' }); return; }
      if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== origin)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        json(res, 403, { success: false, message: 'The local request origin is not allowed.' }); return;
      }
      if (req.method === 'GET' && assets.has(req.url ?? '')) {
        const asset = assets.get(req.url!)!;
        res.writeHead(200, { ...headers, 'content-type': asset.type });
        res.end(asset.body);
        return;
      }
      if (req.method !== 'POST' || !['/api/config', '/api/google', '/api/verify', '/api/email', '/api/cancel', '/api/error'].includes(req.url ?? '')) {
        json(res, 404, { success: false, message: 'Unknown local authentication route.' }); return;
      }
      if (req.headers.origin !== origin) { json(res, 403, { success: false, message: 'An exact local Origin is required.' }); return; }
      let body: Record<string, unknown>;
      try { body = await readJson(req); }
      catch (error) {
        const failure = error instanceof CliError ? error : new CliError('INVALID_JSON', 'The local request was incomplete.', 2, 400);
        res.setHeader('connection', 'close');
        json(res, failure.status ?? 400, { success: false, message: failure.message });
        req.resume();
        return;
      }
      if (settled) return;
      if (typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.nonce) || !timingSafeEqual(Buffer.from(body.nonce), Buffer.from(nonce))) {
        json(res, 403, { success: false, message: 'Invalid authentication state. Use the original terminal URL.' }); return;
      }
      if (phase === 'persist') { json(res, 409, { success: false, message: 'The completed session is being saved. Check the terminal for its result.' }); return; }
      if (req.url === '/api/config') { json(res, 200, { success: true, clientId: options.clientId, signup: options.signup, origin: ctx.origin, expiresAt }); return; }
      if (req.url === '/api/cancel') { json(res, 200, { success: true, state: 'cancelled' }); finish(); return; }
      if (req.url === '/api/error') {
        const error = new CliError('GOOGLE_SCRIPT_FAILED', 'Google sign-in could not load. Check browser network access, script blockers, GEODD_GOOGLE_CLIENT_ID, and the authorized localhost origin.');
        json(res, 200, { success: false, message: error.message }); finish(error); return;
      }
      if (req.url === '/api/google') {
        if (phase !== 'google') { json(res, 409, { success: false, message: 'Google credentials have already been submitted. Start a fresh login if needed.' }); return; }
        if (!secret(body.credential) || (options.signup && (body.termsAgreed !== true || body.privacyAcknowledged !== true || typeof body.marketingConsent !== 'boolean'))) {
          json(res, 400, { success: false, message: 'A Google credential and, for signup, explicit terms and privacy consent are required.' }); return;
        }
        phase = 'exchange';
        const exchangeStarted = Date.now();
        const payload = options.signup
          ? { credential: body.credential, termsAgreed: true, privacyAcknowledged: true, marketingConsent: body.marketingConsent }
          : { credential: body.credential };
        try {
          const data = await exchange(options.signup ? '/auth/google/register' : '/auth/google/login', payload, options.signup ? 'google-signup' : 'google-login');
          if (settled) return;
          if (isRecord(data) && data.requiresTwoFactor === true) {
            if (data.success !== true || data.twoFactorSetup !== true || !secret(data.tempToken) || data.token !== undefined
              || (data.twoFactorVerified !== undefined && data.twoFactorVerified !== false)) throw protocolError();
            identity(data.result);
            tempToken = data.tempToken;
            phase = 'two-factor';
            const twoFactorExpiresAt = Math.min(expiresAt, exchangeStarted + Math.min(options.twoFactorLifetimeMs ?? 300_000, 300_000));
            const remaining = twoFactorExpiresAt - Date.now();
            if (remaining <= 0) throw new CliError('TWO_FACTOR_EXPIRED', 'The temporary 2FA session expired. Start a fresh login.', 3, 410);
            twoFactorTimer = setTimeout(() => finish(new CliError('TWO_FACTOR_EXPIRED', 'The temporary 2FA session expired. Start a fresh login.', 3)), remaining);
            json(res, 200, { success: true, state: 'two-factor', expiresAt: twoFactorExpiresAt });
          } else await complete(data, false, res);
        } catch (error) {
          const failure = safeFailure(error, options.signup ? 'google-signup' : 'google-login');
          json(res, failure.status ?? 502, { success: false, message: failure.message }); finish(failure);
        }
        return;
      }
      if (phase !== 'two-factor' || !tempToken) { json(res, 409, { success: false, message: 'Two-factor verification is not ready or another request is in progress.' }); return; }
      if (req.url === '/api/verify') {
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) { json(res, 400, { success: false, message: 'Enter the six-digit verification code, including leading zeros.' }); return; }
        phase = 'verify';
        try {
          const data = await exchange('/auth/2fa/verify', { tempToken, code: body.code }, 'two-factor');
          if (!settled) await complete(data, true, res);
        } catch (error) {
          const failure = safeFailure(error, 'two-factor');
          json(res, failure.status ?? 502, { success: false, message: failure.message });
          if (failure.code === 'MALFORMED_AUTH_RESPONSE' || failure.status === 410) finish(failure);
          else phase = 'two-factor';
        }
        return;
      }
      if (Date.now() < emailAfter) { json(res, 429, { success: false, message: 'Wait at least 30 seconds before requesting another email code.' }); return; }
      phase = 'email';
      emailAfter = Date.now() + 30_000;
      try {
        const data = await exchange('/auth/2fa/email/send', { tempToken }, 'two-factor');
        if (settled) return;
        if (!isRecord(data) || data.success !== true || data.token !== undefined || data.tempToken !== undefined) throw protocolError();
        json(res, 200, { success: true, state: 'email-sent' });
      } catch (error) {
        const failure = safeFailure(error, 'two-factor');
        json(res, failure.status ?? 502, { success: false, message: failure.message });
        if (failure.status === 410) finish(failure);
      } finally { phase = 'two-factor'; }
    }

    server.on('error', (error: NodeJS.ErrnoException) => finish(new CliError(error.code === 'EADDRINUSE' ? 'BROWSER_PORT_IN_USE' : 'BROWSER_START_FAILED', error.code === 'EADDRINUSE'
      ? `Port ${options.port} is already in use. Close its owner or choose --port with an origin already authorized in Google Cloud; no fallback port was selected.`
      : 'Could not start the loopback authentication server. Check local networking permissions.')));
    ctx.signal.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', abort);
    if (ctx.signal.aborted) { abort(); return; }
    flowTimer = setTimeout(() => finish(new CliError('BROWSER_AUTH_TIMEOUT', 'Browser authentication expired. Start a fresh login.', 3)), Math.max(0, expiresAt - Date.now()));
    server.listen(options.port, '127.0.0.1', () => {
      void (async () => {
        await ctx.warn(`Authenticate at ${url}\nThis URL works only on this computer. Google must authorize ${origin}.`);
        if (!options.noBrowser && !settled) {
          try {
            if (ctx.openBrowser) await ctx.openBrowser(url);
            else await open(url, { wait: false });
          } catch {
            finish(new CliError('BROWSER_OPEN_FAILED', 'Could not open a browser. Run again with --no-browser and open its localhost URL on this computer.'));
          }
        }
      })().catch(() => finish(new CliError('BROWSER_START_FAILED', 'Could not print the local browser instructions. Check terminal output and try again.')));
    });
  });
}
