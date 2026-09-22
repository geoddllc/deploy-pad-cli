import { browserAuth } from './browser-auth.js';
import { googleClientId } from './config.js';
import { CliError, isRecord, safeText } from './errors.js';
import type { CommandResult } from './output.js';
import type { Context } from './runtime.js';
import { loadCredential, readTokenInput, removeSession, saveSession, tokenExpiry, type AccountSummary } from './session.js';

function email(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value) ? safeText(value) : undefined;
}

async function authorizeSession(ctx: Context, token: string): Promise<void> {
  // This route enforces the full console policy; /2fa/status alone is not proof.
  const customer = await ctx.http.request('/console/customer-info', { token, context: 'console' });
  if (!isRecord(customer)) throw new CliError('MALFORMED_RESPONSE', 'The service returned an invalid session-validation response.');
}

async function validateSession(ctx: Context, token: string): Promise<{ account: AccountSummary; twoFactor: { enabled: boolean | null; setupComplete: boolean | null } }> {
  await authorizeSession(ctx, token);
  const metadata = await ctx.http.request('/console/2fa/status', { token, context: 'console' });
  if (!isRecord(metadata)) throw new CliError('MALFORMED_RESPONSE', 'The service returned invalid authentication metadata.');
  const status = isRecord(metadata.result) ? metadata.result : isRecord(metadata.data) ? metadata.data : metadata;
  const accountEmail = email(status.email);
  return {
    account: accountEmail ? { email: accountEmail } : {},
    twoFactor: {
      enabled: typeof status.enabled === 'boolean' ? status.enabled : null,
      setupComplete: typeof status.setupComplete === 'boolean' ? status.setupComplete : null,
    },
  };
}

export interface LoginOptions { tokenStdin?: boolean; browser?: boolean; port?: string }

export async function authLogin(ctx: Context, options: LoginOptions, signup = false): Promise<CommandResult> {
  if (options.tokenStdin) {
    if (signup || options.browser === false || options.port !== undefined) throw new CliError('USAGE', 'Session stdin import cannot be combined with signup or browser options.', 2);
    const token = await readTokenInput(ctx.stdin, ctx.signal);
    const validated = await validateSession(ctx, token);
    await saveSession(ctx.origin, token, validated.account, ctx.env);
    if (ctx.env.GEODD_SESSION_TOKEN !== undefined) await ctx.warn('The supplied session was saved, but GEODD_SESSION_TOKEN still takes precedence in this shell.');
    return { data: { origin: ctx.origin, source: 'file', authenticated: true, ...validated.account, expiresAt: tokenExpiry(token) ?? null, twoFactor: validated.twoFactor }, text: `Session validated and saved privately for ${ctx.origin}. Session files contain plaintext credentials; do not share them.` };
  }
  if (!ctx.interactive && options.browser !== false) throw new CliError('BROWSER_REQUIRES_INTERACTIVE', 'Noninteractive browser authentication requires --no-browser explicitly. Agents should use an origin-bound GEODD_SESSION_TOKEN or auth login --token-stdin. A localhost URL on a remote machine is not a hosted/device login.', 2);
  const portText = options.port ?? '43187';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new CliError('INVALID_PORT', 'Browser port must be an integer from 1 to 65535 and must already be authorized in Google Cloud.', 2);
  const session = await browserAuth(ctx, {
    signup, noBrowser: options.browser === false, port: Number(portText), clientId: googleClientId(ctx.env),
    onSession: async session => {
      await authorizeSession(ctx, session.token);
      await saveSession(ctx.origin, session.token, session.account, ctx.env);
    },
  });
  if (ctx.env.GEODD_SESSION_TOKEN !== undefined) await ctx.warn('The new session was saved, but GEODD_SESSION_TOKEN still takes precedence in this shell.');
  return { data: { origin: ctx.origin, source: 'file', authenticated: true, ...session.account, expiresAt: tokenExpiry(session.token) ?? null }, text: `Authenticated${session.account.email ? ` as ${session.account.email}` : ''}. Session saved privately for ${ctx.origin}. Session files contain plaintext credentials; do not share them.` };
}

export async function authStatus(ctx: Context): Promise<CommandResult> {
  const credential = await loadCredential(ctx.origin, ctx.env);
  const validated = await validateSession(ctx, credential.token);
  const account = { ...credential.account, ...validated.account };
  const data = { origin: ctx.origin, source: credential.source, authenticated: true, consoleAuthorized: true, ...account, expiresAt: credential.expiresAt ?? null, twoFactor: validated.twoFactor };
  return { data, text: `Origin: ${ctx.origin}\nCredential: ${credential.source}\nAccount: ${account.email ?? 'unknown'}\nExpiry (advisory): ${credential.expiresAt ?? 'unknown'}\nConsole authorization: validated\n2FA enabled: ${validated.twoFactor.enabled ?? 'unknown'}\n2FA setup complete: ${validated.twoFactor.setupComplete ?? 'unknown'}` };
}

export async function authLogout(ctx: Context): Promise<CommandResult> {
  const removed = await removeSession(ctx.origin, ctx.env);
  const environmentTokenPresent = ctx.env.GEODD_SESSION_TOKEN !== undefined;
  const message = `Local session ${removed ? 'removed' : 'already absent'} for ${ctx.origin}. Backend sessions are not revoked.${environmentTokenPresent ? ' GEODD_SESSION_TOKEN remains set and may remain active; this command cannot unset the calling shell environment.' : ''}`;
  if (environmentTokenPresent) await ctx.warn('GEODD_SESSION_TOKEN remains set. Logout only deletes the selected origin\'s local session and cannot unset your shell environment.');
  return { data: { origin: ctx.origin, removed, remoteRevoked: false, environmentTokenPresent, message }, text: message };
}
