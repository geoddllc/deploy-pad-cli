import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

test('late email success cannot replace expired browser guidance', async () => {
  class Element {
    textContent = '';
    hidden = false;
    disabled = false;
    checked = false;
    value = '';
    listeners = new Map<string, (...args: unknown[]) => unknown>();
    addEventListener(event: string, callback: (...args: unknown[]) => unknown) { this.listeners.set(event, callback); }
    focus() {}
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 0;
  let credential: ((value: { credential: string }) => Promise<void>) | undefined;
  let resolveEmail!: (value: unknown) => void;
  const pendingEmail = new Promise(resolve => { resolveEmail = resolve; });
  const requests: string[] = [];
  const script = await readFile(new URL('../src/assets/auth.js', import.meta.url), 'utf8');
  runInNewContext(script, {
    document: {
      getElementById: element,
      createElement: () => new Element(),
      head: { append: (script: Element) => queueMicrotask(() => script.listeners.get('load')?.()) },
    },
    location: { hash: '#' + 'a'.repeat(43) }, history: { replaceState() {} },
    Date: { now: () => 1000 },
    setTimeout(callback: () => void, delay: number) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    google: { accounts: { id: {
      initialize(options: { callback: typeof credential }) { credential = options.callback; },
      renderButton() {},
    } } },
    fetch: async (route: string) => {
      requests.push(route);
      if (route === '/api/config') return { ok: true, json: async () => ({ success: true, signup: false, origin: 'https://mock.invalid', clientId: 'synthetic.apps.googleusercontent.com', expiresAt: 601000 }) };
      if (route === '/api/google') return { ok: true, json: async () => ({ success: true, state: 'two-factor', expiresAt: 301000 }) };
      assert.equal(route, '/api/email');
      return pendingEmail;
    },
  });
  await nextTurn();
  assert.ok(credential);
  await credential({ credential: 'synthetic-google-token' });
  const sending = element('email').listeners.get('click')?.();
  const expiry = [...timers.values()].find(timer => timer.delay === 300000);
  assert.ok(expiry);
  expiry.callback();
  const expiredMessage = element('status').textContent;
  assert.match(expiredMessage, /expired.*fresh login/);
  resolveEmail({ ok: true, json: async () => ({ success: true, state: 'email-sent' }) });
  await sending;
  assert.equal(element('status').textContent, expiredMessage);
  assert.equal(element('title').textContent, 'Authentication expired.');
  assert.equal(element('email').disabled, true);
  assert.equal(element('two-factor').hidden, true);
  assert.deepEqual(requests, ['/api/config', '/api/google', '/api/email']);
});
