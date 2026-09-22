import { CliError, interrupted, isRecord } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  body?: unknown;
  allowEmpty?: boolean;
  mutation?: boolean;
  context?: 'console' | 'keys' | 'google-login' | 'google-signup' | 'two-factor';
  signal?: AbortSignal;
}

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export function httpError(status: number, context?: RequestOptions['context']): CliError {
  if (status === 401) return new CliError('AUTH_INVALID', context === 'two-factor'
    ? 'The verification code or temporary session is invalid or expired. Retry a valid code, or start a fresh login.'
    : context?.startsWith('google') ? 'Google rejected this identity token. Sign in again; check the configured Web Client ID and backend audience.'
    : 'The session is invalid or expired. Authenticate again; no other credential was tried.', 3, status);
  if (status === 403) return new CliError('AUTH_FORBIDDEN', 'Authorization was denied. Complete required 2FA with a fresh login or check account policy and ownership.', 3, status);
  if (status === 404) return new CliError('NOT_FOUND', context === 'google-login'
    ? 'No matching account. Run geodd auth signup explicitly to register; login never registers automatically.'
    : 'The requested resource was not found.', 1, status);
  if (status === 409) return new CliError('CONFLICT', context?.startsWith('google')
    ? 'An account or Google identity conflict prevents authentication. Use the existing account or contact support.'
    : 'The request conflicts with existing state. Key names are globally unique; check the resource before retrying.', 1, status);
  if (status === 429) return new CliError('THROTTLED', 'The service rate limit was reached. Wait before manually retrying; no automatic retry was made.', 1, status);
  if (status === 503) return new CliError('SERVICE_UNAVAILABLE', context?.startsWith('google')
    ? 'Google authentication is unavailable. The backend Google client configuration may be missing; contact the service operator.'
    : 'The service is temporarily unavailable.', 1, status);
  if (status === 400 || status === 422) return new CliError('API_VALIDATION', context === 'keys'
    ? 'The key API rejected the supplied input. Check the key name or ID, and use console model IDs from geodd models list --for-keys, not public inference IDs.'
    : 'The service rejected the supplied input. Check required values and, for signup, explicit terms and privacy consent.', 2, status);
  return new CliError('API_ERROR', 'The service could not complete the request.', 1, status);
}

// Only these literal errors from the key route are safe to expose. Never reflect
// arbitrary backend messages, field values, or other users' existingKeyId values.
const keyMessages = new Map([
  ['Key name is required', 'Key name is required. Supply --name with a globally unique key name.'],
  ['Key name must be 32 characters or less', 'Key name must be 32 characters or less.'],
  ['Key name must contain only letters, numbers, and dashes (no other special characters or spaces)', 'Key name must contain only letters, numbers, and dashes (no other special characters or spaces).'],
  ['At least one model is required', 'At least one model is required. Select a model ID from geodd models list --for-keys.'],
  ['Invalid model ID format', 'Invalid model ID format. The key API requires 24-character hexadecimal model IDs from geodd models list --for-keys, not inference IDs such as openai/gpt-oss-120b.'],
  ['One or more model IDs do not exist', 'One or more model IDs do not exist. Refresh geodd models list --for-keys for the selected API origin and choose an ID from that catalog.'],
  ['A key with this name already exists. Please use a different name.', 'A key with this name already exists. Please use a different name.'],
]);

function keyMessage(data: unknown): string | undefined {
  return isRecord(data) && typeof data.error === 'string' ? keyMessages.get(data.error) : undefined;
}

async function readKeyError(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (!response.body) return;
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body.cancel().catch(() => {});
    return;
  }
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  try {
    const deadline = new Promise<undefined>(resolve => {
      stop = () => resolve(undefined);
      timer = setTimeout(stop, 250);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      // Bound empty chunks as well as bytes so a stream cannot starve the timer.
      for (let count = 0; count < 1024; count++) {
        const { done, value } = await reader.read();
        if (done) return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        bytes += value.byteLength;
        if (bytes > limit) return;
        chunks.push(value);
      }
    };
    return await Promise.race([read().catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class HttpClient {
  constructor(public readonly origin: string, private readonly options: HttpOptions = {}) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, this.origin).origin !== this.origin) {
      throw new CliError('INVALID_ROUTE', 'Refusing a request outside the selected API origin.', 2);
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([timeout, ...[this.options.signal, options.signal].filter((value): value is AbortSignal => value !== undefined)]);
    const uncertain = options.mutation ? ' The mutation outcome is uncertain. Do not blindly retry; inspect backend state or contact support first.' : '';
    let responseFailure: CliError | undefined;
    try {
      signal.throwIfAborted();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.token) headers.secret_token = options.token;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const response = await (this.options.fetch ?? fetch)(`${this.origin}${path}`, {
        method: options.method ?? 'GET', headers, redirect: 'manual', signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new CliError('REDIRECT_REJECTED', 'API redirects are not followed. Check the configured origin.', 1, response.status);
      }
      if (!response.ok) {
        responseFailure = httpError(response.status, options.context);
        if (options.context === 'keys' && [400, 409, 422].includes(response.status)) {
          const data = await readKeyError(response, signal, Math.min(16 * 1024, this.options.maxBytes ?? 16 * 1024));
          const message = keyMessage(data);
          if (message) responseFailure = new CliError(responseFailure.code, message, responseFailure.exitCode, response.status);
        } else await response.body?.cancel();
        throw responseFailure;
      }
      if (response.status === 204 && options.allowEmpty) return null;
      const limit = this.options.maxBytes ?? 8 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new CliError('RESPONSE_TOO_LARGE', 'The service response exceeded the allowed size.' + uncertain);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) {
              await reader.cancel();
              throw new CliError('RESPONSE_TOO_LARGE', 'The service response exceeded the allowed size.' + uncertain);
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new CliError('MALFORMED_RESPONSE', 'The service returned an invalid or empty JSON response.' + uncertain); }
      if ((options.context === 'console' || options.context === 'keys') && isRecord(data) && data.requiresTwoFactor === true) {
        throw new CliError('TWO_FACTOR_REQUIRED', 'This session still requires 2FA verification. Complete a fresh browser login before using console commands.', 3, response.status);
      }
      if (isRecord(data) && data.success === false) {
        const validatingSession = options.context === 'console' && !options.mutation;
        throw new CliError('API_REJECTED', (options.context === 'keys' ? keyMessage(data) : undefined) ?? 'The service reported an unsuccessful operation. Check input, session verification, and account policy.', validatingSession || options.context === 'two-factor' ? 3 : 1, response.status);
      }
      return data;
    } catch (error) {
      if (this.options.signal?.aborted || options.signal?.aborted) {
        const failure = interrupted();
        if (options.mutation) throw new CliError(failure.code, failure.message + uncertain, 130);
        throw failure;
      }
      // Diagnostic parsing must never replace an already received HTTP failure
      // with a body-read timeout or transport error. Explicit cancellation wins.
      if (responseFailure) throw responseFailure;
      if (timeout.aborted) throw new CliError('TIMEOUT', 'The service request timed out.' + uncertain);
      if (error instanceof CliError) throw error;
      throw new CliError('TRANSPORT_ERROR', 'Could not communicate securely with the API. Check network access and the API origin.' + uncertain);
    }
  }
}
