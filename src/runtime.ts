import type { Readable, Writable } from 'node:stream';
import type { Environment } from './config.js';
import type { HttpClient } from './http.js';

export interface Context {
  origin: string;
  env: Environment;
  http: HttpClient;
  stdin: Readable;
  stderr: Writable;
  interactive: boolean;
  signal: AbortSignal;
  warn(message: string): Promise<void>;
  openBrowser?: (url: string) => Promise<void>;
  confirm?: (message: string) => Promise<boolean>;
}
