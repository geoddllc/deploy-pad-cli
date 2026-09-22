import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { catalog, modelsList, modelsPricing, modelsShow, perMillion } from '../src/models.js';

const model = { id: 'Vendor/Model', future: { supported: true }, input_modalities: [{ type: 'text', supported_inputs: { max_context_length: { value: 4096, unit: 'token' } }, pricing: [{ type: 'prompt', unit: 'token', cost_usd: '0.000000039', future: 1 }] }, { type: 'image', pricing: [{ type: 'image', unit: 'image', cost_usd: '0.20' }] }], output_modalities: [{ type: 'text', max_length: { value: 512, unit: 'token' }, pricing: [{ type: 'completion', unit: 'token', cost_usd: '0.000000182' }] }], is_ready: false };
function http(data: unknown): HttpClient {
  return new HttpClient('https://api.example.com', { fetch: async (url, options) => {
    assert.equal(url, 'https://api.example.com/inference/v1/models');
    assert.equal(options?.method, 'GET');
    assert.equal(new Headers(options?.headers).has('secret_token'), false);
    return Response.json(data);
  } });
}

test('decimal conversion is exact and rejects non-decimal or non-string values', () => {
  for (const [input, expected] of [['0.000000039', '0.039'], ['0.000000182', '0.182'], ['0.0000000001', '0.0001'], ['123.456789123', '123456789.123'], ['0', '0'], ['000.0010', '1000'], ['1', '1000000']]) assert.equal(perMillion(input), expected);
  for (const value of [0.1, '-1', 'NaN', '1e-8', '.01', '1.', null]) assert.equal(perMillion(value), undefined);
});

test('catalog preserves backend model objects and empty catalogs', async () => {
  assert.deepEqual(await catalog(http({ data: [model] })), [model]);
  assert.deepEqual((await modelsList(http({ data: [] }))).data, []);
  assert.match((await modelsList(http({ data: [model, { id: 'missing' }] }))).text!, /false.*4096 token.*0\.039.*0\.182/);
  assert.match((await modelsList(http({ data: [{ id: 'missing' }] }))).text!, /unknown/);
});

test('show selects exact slash-containing ID without a detail endpoint', async () => {
  assert.deepEqual((await modelsShow(http({ data: [model] }), 'Vendor/Model')).data, model);
  await assert.rejects(modelsShow(http({ data: [model] }), 'vendor/model'), { code: 'MODEL_NOT_FOUND', exitCode: 2 });
  await assert.rejects(modelsPricing(http({ data: [] }), 'Vendor/Model'), { code: 'MODEL_NOT_FOUND' });
});

test('reject malformed catalogs but accept unknown fields', async () => {
  for (const data of [{}, { data: null }, { data: [null] }, { data: [{ id: '' }] }, { data: [{ id: 12 }] }]) await assert.rejects(catalog(http(data)), { code: 'MALFORMED_CATALOG' });
});

test('pricing preserves every modality, original price and unknown fields', async () => {
  const result = await modelsPricing(http({ data: [model, { id: 'unknown' }] }));
  assert.deepEqual(result.data, [{ id: model.id, pricing: [
    { direction: 'input', modality: 'text', price: { type: 'prompt', unit: 'token', cost_usd: '0.000000039', future: 1 }, usd_per_million: '0.039' },
    { direction: 'input', modality: 'image', price: { type: 'image', unit: 'image', cost_usd: '0.20' } },
    { direction: 'output', modality: 'text', price: { type: 'completion', unit: 'token', cost_usd: '0.000000182' }, usd_per_million: '0.182' },
  ] }, { id: 'unknown', pricing: [] }]);
});
