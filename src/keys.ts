import { createInterface } from 'node:readline/promises';
import { CliError, interrupted } from './errors.js';
import type { CommandResult } from './output.js';
import type { Context } from './runtime.js';
import { loadCredential } from './session.js';

export interface KeyOptions { name?: string; model?: string[]; monthlyVolume?: string; yes?: boolean }
type Operation = 'create' | 'update' | 'rotate' | 'delete';

function keyIdentifier(id: string | undefined): string {
  if (!id?.trim() || id !== id.trim() || id.length > 2048) throw new CliError('INVALID_KEY_ID', 'Supply a nonempty key ID, not its secret.', 2);
  let decoded = id;
  for (let round = 0; round < 4; round++) {
    if (/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(decoded) || decoded.split(/[\\/]/).some(part => part === '.' || part === '..')) {
      throw new CliError('INVALID_KEY_ID', 'Key IDs must not contain control characters or path-navigation components. Supply an ID, not a key secret.', 2);
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (round === 3) throw new CliError('INVALID_KEY_ID', 'Key ID contains excessive nested path encoding.', 2);
    } catch (error) {
      if (error instanceof CliError) throw error;
      break;
    }
  }
  return id;
}

function modelIdentifiers(values: string[] | undefined): string[] {
  if (!values?.length || values.some(value => !value.trim() || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/.test(value))) {
    throw new CliError('INVALID_MODELS', 'Provide at least one nonempty exact public model ID with --model. IDs are case-sensitive; repeat --model for each ID.', 2);
  }
  return [...new Set(values)];
}

async function approve(ctx: Context, summary: string, yes?: boolean): Promise<void> {
  if (ctx.signal.aborted) throw interrupted();
  if (!yes && !ctx.interactive) throw new CliError('CONFIRMATION_REQUIRED', 'Noninteractive key mutations require explicit --yes. Review the origin, operation, identifiers, and billing/capacity defaults first.', 4);
  await ctx.warn(summary);
  if (yes) return;
  let accepted: boolean;
  if (ctx.confirm) accepted = await ctx.confirm('Approve this mutation? [y/N] ');
  else {
    const readline = createInterface({ input: ctx.stdin, output: ctx.stderr });
    try {
      accepted = /^(y|yes)$/i.test((await readline.question('Approve this mutation? [y/N] ', { signal: ctx.signal })).trim());
    } catch {
      if (ctx.signal.aborted) throw interrupted();
      throw new CliError('CONFIRMATION_REJECTED', 'Confirmation was unavailable. No mutation was sent.', 4);
    } finally { readline.close(); }
  }
  if (ctx.signal.aborted) throw interrupted();
  if (!accepted) throw new CliError('CONFIRMATION_REJECTED', 'Confirmation rejected. No mutation was sent.', 4);
}

export async function mutateKey(ctx: Context, operation: Operation, options: KeyOptions, id?: string): Promise<CommandResult> {
  let path: string;
  let body: Record<string, unknown> | undefined;
  let summary = `Origin: ${ctx.origin}\nOperation: keys ${operation}`;
  if (operation === 'create') {
    if (!options.name || !/^[A-Za-z0-9-]{1,32}$/.test(options.name)) throw new CliError('INVALID_KEY_NAME', 'Key names must be 1-32 letters, numbers, or dashes. Names are globally unique.', 2);
    const models = modelIdentifiers(options.model);
    let monthlyVolume: number | undefined;
    if (options.monthlyVolume !== undefined) {
      monthlyVolume = Number(options.monthlyVolume);
      if (!/^\d+$/.test(options.monthlyVolume) || !Number.isSafeInteger(monthlyVolume) || monthlyVolume <= 0) throw new CliError('INVALID_MONTHLY_VOLUME', 'Monthly volume must be a positive safe integer.', 2);
    }
    path = '/console/api-keys/generate';
    body = { name: options.name, models, ...(monthlyVolume !== undefined ? { monthlyVolume } : {}) };
    summary += `\nName (globally unique): ${options.name}\nModels: ${models.join(', ')}\nBilling: PostPaid (backend default)\nMonthly capacity: ${monthlyVolume ?? '3,000,000,000 (backend default)'} tokens`;
  } else {
    const keyId = keyIdentifier(id);
    summary += `\nKey ID: ${JSON.stringify(keyId)} (must be an ID, not a secret)`;
    if (operation === 'update') {
      const models = modelIdentifiers(options.model);
      path = '/console/api-keys/update';
      body = { keyId, models };
      summary += `\nREPLACE the entire model set with: ${models.join(', ')}. This is not an addition.`;
    } else {
      path = `/console/api-keys/${encodeURIComponent(keyId)}${operation === 'rotate' ? '/regenerate' : ''}`;
      summary += operation === 'rotate' ? '\nThe previous secret stops working immediately after rotation.' : '\nPermanently delete this key and its backend mapping.';
    }
  }
  const credential = await loadCredential(ctx.origin, ctx.env);
  await approve(ctx, summary, options.yes);
  if (operation === 'create' || operation === 'rotate') await ctx.warn('The successful stdout result contains a one-time key secret. Store it securely; the CLI never saves it.');
  const data = await ctx.http.request(path, {
    method: operation === 'delete' ? 'DELETE' : 'POST', token: credential.token, context: 'console', mutation: true,
    allowEmpty: operation === 'update' || operation === 'delete',
    ...(body !== undefined ? { body } : {}),
  });
  return { data, mutation: true };
}
