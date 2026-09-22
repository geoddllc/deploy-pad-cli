#!/usr/bin/env node
import { runCli } from './app.js';

const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
// Stream failures are reported by write callbacks rather than uncaught events.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
