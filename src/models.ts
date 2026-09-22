import { CliError, isRecord, safeText } from './errors.js';
import { HttpClient } from './http.js';
import type { CommandResult } from './output.js';

type Model = Record<string, unknown> & { id: string };

export async function catalog(http: HttpClient): Promise<Model[]> {
  const response = await http.request('/inference/v1/models');
  if (!isRecord(response) || !Array.isArray(response.data) || response.data.some(model => !isRecord(model) || typeof model.id !== 'string' || !model.id.trim())) {
    throw new CliError('MALFORMED_CATALOG', 'The service returned an invalid model catalog. Expected a data array containing nonempty model IDs.');
  }
  return response.data as Model[];
}

export function perMillion(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = whole + fraction.padEnd(6, '0');
  const position = whole.length + 6;
  const integer = digits.slice(0, position).replace(/^0+(?=\d)/, '');
  const decimal = digits.slice(position).replace(/0+$/, '');
  return integer + (decimal ? `.${decimal}` : '');
}

interface Price {
  direction: 'input' | 'output';
  modality: unknown;
  price: unknown;
  usd_per_million?: string;
}

export function prices(model: Model): Price[] {
  const entries: Price[] = [];
  for (const direction of ['input', 'output'] as const) {
    const modalities = model[`${direction}_modalities`];
    if (!Array.isArray(modalities)) continue;
    for (const modality of modalities) {
      if (!isRecord(modality) || !Array.isArray(modality.pricing)) continue;
      for (const price of modality.pricing) {
        const derived = isRecord(price) && price.unit === 'token' ? perMillion(price.cost_usd) : undefined;
        entries.push({ direction, modality: modality.type ?? null, price, ...(derived !== undefined ? { usd_per_million: derived } : {}) });
      }
    }
  }
  return entries;
}

function select(models: Model[], id: string): Model {
  const model = models.find(model => model.id === id);
  if (!model) throw new CliError('MODEL_NOT_FOUND', 'No model has the exact requested ID. Run geodd models list; IDs are case-sensitive.', 2);
  return model;
}

function contextLimit(model: Model): string {
  if (!Array.isArray(model.input_modalities)) return 'unknown';
  const limits = model.input_modalities.flatMap(modality => {
    if (!isRecord(modality) || !isRecord(modality.supported_inputs)) return [];
    const limit = modality.supported_inputs.max_context_length;
    return isRecord(limit) && typeof limit.value === 'number' && typeof limit.unit === 'string'
      ? [`${modality.type ?? 'unknown'}:${limit.value} ${limit.unit}`] : [];
  });
  return limits.join(', ') || 'unknown';
}

function textPrice(model: Model, direction: Price['direction']): string {
  const matching = prices(model).filter(price => price.direction === direction && price.modality === 'text' && price.usd_per_million !== undefined);
  return matching.map(price => `${isRecord(price.price) ? price.price.type ?? 'unknown' : 'unknown'}:$${price.usd_per_million}`).join(', ') || 'unknown';
}

export async function modelsList(http: HttpClient): Promise<CommandResult> {
  const models = await catalog(http);
  const rows = [['ID', 'READY', 'CONTEXT', 'TEXT INPUT USD/1M TOKENS', 'TEXT OUTPUT USD/1M TOKENS'], ...models.map(model => [
    model.id, typeof model.is_ready === 'boolean' ? String(model.is_ready) : 'unknown', contextLimit(model), textPrice(model, 'input'), textPrice(model, 'output'),
  ])];
  const widths = rows[0]!.map((_, index) => Math.max(...rows.map(row => safeText(row[index]!).length)));
  return { data: models, text: models.length ? rows.map(row => row.map((cell, index) => safeText(cell).padEnd(widths[index]!)).join('  ').trimEnd()).join('\n') : 'No models available.' };
}

export async function modelsForKeys(http: HttpClient, token: string): Promise<CommandResult> {
  const response = await http.request('/console/models', { method: 'GET', token, context: 'keys' });
  const malformed = new CliError('MALFORMED_KEY_MODELS', 'The service returned an invalid key model catalog. Expected a models array containing 24-character hexadecimal console model IDs.');
  if (!isRecord(response) || response.success !== true || !isRecord(response.data) || !Array.isArray(response.data.models)) throw malformed;
  const models = response.data.models.map(model => {
    if (!isRecord(model) || typeof model._id !== 'string' || model._id.length !== 24 || !/^[a-f0-9]{24}$/i.test(model._id)) throw malformed;
    return { id: model._id.toLowerCase(), name: typeof model.name === 'string' ? model.name : null };
  });
  return {
    data: models,
    text: models.length ? [
      `${'ID'.padEnd(24)}  NAME`,
      ...models.map(model => `${model.id}  ${safeText(model.name ?? 'unknown')}`.trimEnd()),
    ].join('\n') : 'No models available for API keys.',
  };
}

export async function modelsShow(http: HttpClient, id: string): Promise<CommandResult> {
  const model = select(await catalog(http), id);
  return { data: model, text: JSON.stringify(model, null, 2) };
}

export async function modelsPricing(http: HttpClient, id?: string): Promise<CommandResult> {
  const models = await catalog(http);
  const selected = id === undefined ? models : [select(models, id)];
  const data = selected.map(model => ({ id: model.id, pricing: prices(model) }));
  const text = data.map(model => `${model.id}\n${model.pricing.length ? model.pricing.map(entry => {
    const price = isRecord(entry.price) ? entry.price : {};
    return `  ${entry.direction}/${entry.modality ?? 'unknown'}/${price.type ?? 'unknown'}: ${entry.usd_per_million !== undefined ? `$${entry.usd_per_million} USD / 1M tokens` : `${price.cost_usd ?? 'unknown'} USD / ${price.unit ?? 'unknown'}`} (original: ${price.cost_usd ?? 'unknown'} USD / ${price.unit ?? 'unknown'})`;
  }).join('\n') : '  Pricing unknown.'}`).join('\n');
  return { data, text: text || 'No models available.' };
}
