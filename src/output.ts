import { Writable } from 'node:stream';
import { CliError, safeText } from './errors.js';

export interface CommandResult { data: unknown; text?: string; mutation?: boolean }

export function jsonLine(value: unknown): string {
  // Preserve JSON values while preventing terminal control/bidi interpretation.
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function outputMode(args: string[], stdoutIsTTY: boolean): boolean {
  const flags = args.slice(0, args.indexOf('--') === -1 ? args.length : args.indexOf('--'));
  return flags.includes('--json') || (!flags.includes('--text') && !stdoutIsTTY);
}

export async function writeOutput(stream: Writable, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

export async function printResult(stream: Writable, result: CommandResult, json: boolean): Promise<void> {
  const value = json ? jsonLine({ success: true, data: result.data }) : result.text ?? JSON.stringify(result.data, null, 2);
  try {
    await writeOutput(stream, (json ? value : value.split('\n').map(safeText).join('\n')) + '\n');
  } catch {
    throw new CliError(result.mutation ? 'MUTATION_OUTPUT_FAILED' : 'OUTPUT_FAILED', result.mutation
      ? 'The API mutation succeeded, but its result could not be written. A one-time key secret may be lost. Do not blindly retry; recovery requires checking backend state.'
      : 'Could not write the command result. Check the output destination.');
  }
}
