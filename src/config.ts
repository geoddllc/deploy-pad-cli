import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliError } from './errors.js';

export const PRODUCTION_ORIGIN = 'https://api.geodd.io';
// The build fills this compiled constant from GEODD_GOOGLE_CLIENT_ID, never a secret.
const BUNDLED_GOOGLE_CLIENT_ID = '';
export type Environment = NodeJS.ProcessEnv;

export function normalizeOrigin(value: string): string {
  const invalid = () => new CliError('INVALID_ORIGIN', 'API URL must be an HTTPS origin, or HTTP on exactly localhost, 127.0.0.1, or [::1], without credentials, paths, query, or fragment.', 2);
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
  const authority = value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)) throw invalid();
  if (!['https:', 'http:'].includes(url.protocol)) throw invalid();
  return url.origin;
}

export function apiOrigin(explicit?: string, env: Environment = process.env): string {
  return normalizeOrigin(explicit ?? env.GEODD_API_URL ?? PRODUCTION_ORIGIN);
}

export function googleClientId(env: Environment = process.env): string {
  const id = env.GEODD_GOOGLE_CLIENT_ID ?? BUNDLED_GOOGLE_CLIENT_ID;
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new CliError('GOOGLE_NOT_CONFIGURED', 'Browser authentication requires GEODD_GOOGLE_CLIENT_ID set to the existing Google Web Client ID. Authorize http://localhost and the exact localhost port in Google Cloud; backend audiences must match. Supplied sessions and public models do not need this setting.', 2);
  }
  return id;
}

export function configDirectory(env: Environment = process.env, platform = process.platform): string {
  if (env.GEODD_CONFIG_DIR !== undefined) {
    if (!env.GEODD_CONFIG_DIR.trim()) throw new CliError('INVALID_CONFIG_DIR', 'GEODD_CONFIG_DIR must not be empty.', 2);
    return resolve(env.GEODD_CONFIG_DIR);
  }
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'geodd');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'geodd');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'geodd');
}
