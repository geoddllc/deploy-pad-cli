import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const [html, css, script] = await Promise.all([
  readFile(new URL('../src/assets/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/assets/auth.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/assets/auth.js', import.meta.url), 'utf8'),
]);
const nonce = 'a'.repeat(43);
const styleNonce = 'synthetic-style-nonce';
const clientId = 'synthetic-presentation.apps.googleusercontent.com';

function attributes(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
    .map(match => [match[1]!, match[2] ?? match[3] ?? match[4] ?? '']));
}

class Element {
  textContent = '';
  value = '';
  src = '';
  nonce = '';
  async = false;
  disabled = false;
  hidden: boolean;
  checked: boolean;
  dataset: Record<string, string> = {};
  clientWidth = 320;
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  classList = {
    contains: (name: string) => this.classes.has(name),
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
  };
  private classes: Set<string>;
  constructor(readonly tagName: string, private attrs: Record<string, string> = {}) {
    this.hidden = 'hidden' in attrs;
    this.checked = 'checked' in attrs;
    this.classes = new Set(attrs.class?.split(/\s+/) ?? []);
    if (attrs['data-theme']) this.dataset.theme = attrs['data-theme'];
  }
  getAttribute(name: string) { return name === 'data-theme' ? this.dataset.theme ?? null : this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name === 'data-theme') this.dataset.theme = value;
  }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
  }
  async dispatch(name: string) {
    for (const listener of this.listeners.get(name) ?? []) await listener({ preventDefault() {} });
  }
  getBoundingClientRect() { return { width: this.clientWidth }; }
  focus() {}
}

interface PresentationOptions {
  signup?: boolean;
  dataTheme?: string;
  rootClass?: string;
  savedTheme?: string;
  prefersDark?: boolean;
  storageUnavailable?: boolean;
  twoFactor?: boolean;
}
type CredentialCallback = (response: { credential: string }) => Promise<void>;

// Synthetic DOM tests check contracts, not layout or live GIS rendering.
async function presentation(options: PresentationOptions = {}) {
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^<>]*)>/gi)) {
    const attrs = attributes(match[2]!);
    if (attrs.id) elements.set(attrs.id, new Element(match[1]!.toUpperCase(), attrs));
  }
  const element = (id: string) => {
    const result = elements.get(id);
    assert.ok(result, `Expected existing HTML element #${id}`);
    return result;
  };
  const root = new Element('HTML', { class: options.rootClass ?? '' });
  if (options.dataTheme !== undefined) root.dataset.theme = options.dataTheme;
  const storageReads: string[] = [];
  const storageWrites: string[] = [];
  const storage = (name: string) => new Proxy({
    getItem(key: string) {
      storageReads.push(`${name}.${key}`);
      if (options.storageUnavailable) throw new Error('Storage unavailable');
      return name === 'localStorage' && key === 'theme' ? options.savedTheme ?? null : null;
    },
    setItem(...args: unknown[]) { storageWrites.push(`${name}.setItem:${JSON.stringify(args)}`); },
    removeItem(...args: unknown[]) { storageWrites.push(`${name}.removeItem:${JSON.stringify(args)}`); },
    clear() { storageWrites.push(`${name}.clear`); },
  }, {
    get(target, key, receiver) {
      if (key === 'theme') return target.getItem('theme');
      return Reflect.get(target, key, receiver);
    },
    set(_target, key, value) { storageWrites.push(`${name}.${String(key)}=${String(value)}`); return true; },
    defineProperty(_target, key) { storageWrites.push(`${name}.defineProperty:${String(key)}`); return true; },
    deleteProperty(_target, key) { storageWrites.push(`${name}.delete:${String(key)}`); return true; },
  });
  const initializations: Record<string, unknown>[] = [];
  const renders: Array<{ target: Element; options: Record<string, unknown> }> = [];
  const unwantedSdkCalls: string[] = [];
  const requests: Array<{ route: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const loadedScripts: Element[] = [];
  const document = {
    documentElement: root,
    currentScript: { nonce: styleNonce } as { nonce: string } | null,
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tagName: string) => new Element(tagName.toUpperCase()),
    head: { append: (node: Element) => {
      loadedScripts.push(node);
      queueMicrotask(() => { void node.dispatch('load'); });
    } },
  };
  Object.defineProperty(document, 'cookie', { get: () => '', set: value => { storageWrites.push(`cookie=${String(value)}`); } });
  const context: Record<string, unknown> = {
    document, location: { hash: `#${nonce}` }, history: { replaceState() {} },
    localStorage: storage('localStorage'), sessionStorage: storage('sessionStorage'),
    matchMedia: () => ({ matches: options.prefersDark ?? false, addEventListener() {}, removeEventListener() {} }),
    Date: { now: () => 1000 },
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    google: { accounts: {
      id: {
        initialize(config: Record<string, unknown>) { initializations.push(config); },
        renderButton(target: Element, config: Record<string, unknown>) { renders.push({ target, options: config }); },
        prompt() { unwantedSdkCalls.push('One Tap'); },
      },
      oauth2: {
        initTokenClient() { unwantedSdkCalls.push('access token'); },
        initCodeClient() { unwantedSdkCalls.push('authorization code'); },
      },
    } },
    fetch: async (route: string, init: RequestInit) => {
      requests.push({ route, body: JSON.parse(String(init.body)) as Record<string, unknown>, init });
      assert.ok(['/api/config', '/api/google', '/api/verify', '/api/email', '/api/cancel', '/api/error'].includes(route), `Unexpected request: ${route}`);
      const result = route === '/api/config'
        ? { success: true, signup: options.signup ?? false, origin: 'https://mock.invalid', clientId, expiresAt: 601000 }
        : { success: true, state: route === '/api/google' && options.twoFactor ? 'two-factor' : route === '/api/email' ? 'email-sent' : 'complete', expiresAt: 301000 };
      return { ok: true, json: async () => result };
    },
  };
  context.window = context;
  context.self = context;
  runInNewContext(script, context);
  document.currentScript = null;
  await nextTurn();
  assert.equal(initializations.length, 1, `GIS initialization failed: ${element('status').textContent}`);
  assert.equal(renders.length, 1);
  assert.equal(typeof initializations[0]!.callback, 'function');
  return {
    element, root, initializations, renders, loadedScripts, requests, storageReads, storageWrites, unwantedSdkCalls,
    credential: initializations[0]!.callback as CredentialCallback,
  };
}

test('GIS owns a medium standard rectangular button and preserves popup credential exchange', async t => {
  for (const signup of [false, true]) await t.test(signup ? 'signup' : 'login', async () => {
    const h = await presentation({ signup });
    const config = h.initializations[0]!;
    assert.equal(config.client_id, clientId);
    assert.equal(config.auto_select, false);
    assert.equal(config.ux_mode, 'popup');
    const rendered = h.renders[0]!;
    assert.equal(rendered.target, h.element('google-button'));
    assert.equal(rendered.options.type, 'standard');
    assert.equal(rendered.options.size, 'medium');
    assert.equal(rendered.options.shape, 'rectangular');
    assert.equal(rendered.options.theme, 'outline');
    assert.equal(rendered.options.text, signup ? 'signup_with' : 'signin_with');
    assert.equal(String(rendered.options.width), '240');
    assert.equal(h.loadedScripts.length, 1);
    assert.equal(h.loadedScripts[0]!.src, 'https://accounts.google.com/gsi/client');
    assert.equal(h.loadedScripts[0]!.async, true);
    assert.equal(h.loadedScripts[0]!.nonce, styleNonce);
    assert.deepEqual(h.requests.map(request => request.route), ['/api/config']);
    assert.deepEqual(h.requests[0]!.body, { nonce });
    if (!signup) {
      assert.equal(h.element('consents').hidden, true);
      await h.credential({ credential: 'synthetic-google-credential' });
      assert.deepEqual(h.requests.map(request => request.route), ['/api/config', '/api/google']);
      assert.deepEqual(h.requests[1]!.body, { credential: 'synthetic-google-credential', nonce });
    }
    for (const request of h.requests) {
      assert.equal(request.init.method, 'POST');
      assert.equal(request.init.credentials, 'omit');
      assert.equal(request.init.cache, 'no-store');
      assert.equal(request.init.redirect, 'error');
      assert.deepEqual(request.body.nonce, nonce);
    }
    assert.deepEqual(h.unwantedSdkCalls, []);
    assert.deepEqual(h.storageWrites, []);
  });
});

test('unchecked signup consents gate even direct SDK callbacks and marketing stays optional', async t => {
  for (const marketing of [false, true]) await t.test(`marketing ${marketing}`, async () => {
    const h = await presentation({ signup: true });
    assert.equal(h.element('consents').hidden, false);
    for (const id of ['terms', 'privacy', 'marketing']) assert.equal(h.element(id).checked, false);
    const attempt = () => h.credential({ credential: 'synthetic-signup-credential' });
    for (const [terms, privacy, optional] of [[false, false, false], [false, false, true], [true, false, false], [false, true, false]]) {
      h.element('terms').checked = terms!;
      h.element('privacy').checked = privacy!;
      h.element('marketing').checked = optional!;
      await h.element('terms').dispatch('change');
      await h.element('privacy').dispatch('change');
      assert.equal(h.element('google-button').hidden, true);
      await attempt();
      assert.deepEqual(h.requests.map(request => request.route), ['/api/config']);
    }
    h.element('terms').checked = true;
    h.element('privacy').checked = true;
    h.element('marketing').checked = marketing;
    await h.element('terms').dispatch('change');
    assert.equal(h.element('google-button').hidden, false);
    await attempt();
    assert.deepEqual(h.requests[1]!.body, {
      credential: 'synthetic-signup-credential', termsAgreed: true, privacyAcknowledged: true, marketingConsent: marketing, nonce,
    });
    for (const id of ['terms', 'privacy', 'marketing']) assert.equal(h.element(id).disabled, true);
    await attempt();
    assert.deepEqual(h.requests.map(request => request.route), ['/api/config', '/api/google']);
    assert.deepEqual(h.storageWrites, []);
  });
});

test('theme preferences are read without storing authentication state through 2FA', async () => {
  const h = await presentation({ savedTheme: 'dark', twoFactor: true });
  await h.credential({ credential: 'synthetic-google-credential' });
  assert.equal(h.element('two-factor').hidden, false);
  assert.deepEqual(h.requests.map(request => request.route), ['/api/config', '/api/google']);
  await h.element('email').dispatch('click');
  h.element('code').value = '001234';
  await h.element('code-form').dispatch('submit');
  assert.deepEqual(h.requests.map(request => request.route), ['/api/config', '/api/google', '/api/email', '/api/verify']);
  assert.deepEqual(h.requests[2]!.body, { nonce });
  assert.deepEqual(h.requests[3]!.body, { code: '001234', nonce });
  assert.equal(h.element('code').value, '');
  assert.ok(h.storageReads.includes('localStorage.theme'));
  assert.ok(h.storageReads.every(key => key === 'localStorage.theme'));
  assert.deepEqual(h.storageWrites, []);
  assert.deepEqual(h.unwantedSdkCalls, []);
});

test('explicit root light and dark preferences take priority without reading or writing storage', async t => {
  for (const theme of ['light', 'dark']) {
    for (const source of ['data-theme', 'class']) await t.test(`${source} ${theme}`, async () => {
      const h = await presentation({
        ...(source === 'data-theme' ? { dataTheme: theme } : { rootClass: theme }),
        savedTheme: theme === 'dark' ? 'light' : 'dark',
        prefersDark: theme === 'light',
      });
      assert.equal(h.root.dataset.theme, source === 'data-theme' ? theme : undefined);
      assert.equal(h.root.classList.contains(theme), source === 'class');
      assert.deepEqual(h.storageReads, []);
      assert.deepEqual(h.storageWrites, []);
    });
  }
});

test('saved light and dark preferences are applied read-only when the root has no preference', async t => {
  for (const theme of ['light', 'dark']) await t.test(theme, async () => {
    const h = await presentation({ savedTheme: theme, prefersDark: theme === 'light' });
    assert.equal(h.root.dataset.theme, theme);
    assert.ok(h.storageReads.includes('localStorage.theme'));
    assert.ok(h.storageReads.every(key => key === 'localStorage.theme'));
    assert.deepEqual(h.storageWrites, []);
  });
});

test('missing, invalid and unavailable theme storage leave system fallback to CSS', async t => {
  for (const [name, options] of [
    ['missing', {}], ['unknown', { savedTheme: 'system' }], ['unavailable', { storageUnavailable: true }],
  ] as const) await t.test(name, async () => {
    const h = await presentation({ ...options, prefersDark: true });
    assert.equal(h.root.dataset.theme, undefined);
    assert.equal(h.root.classList.contains('light'), false);
    assert.equal(h.root.classList.contains('dark'), false);
    assert.deepEqual(h.storageWrites, []);
    assert.deepEqual(h.requests.map(request => request.route), ['/api/config']);
  });
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
});

test('auth markup has one heading, native consent labels and unchanged legal destinations', () => {
  assert.equal([...html.matchAll(/<h1\b/gi)].length, 1);
  assert.match(html, /<h1\b[^>]*\bid="title"/);
  const inputs = [...html.matchAll(/<input\b([^>]*)>/gi)].map(match => attributes(match[1]!));
  assert.equal(inputs.filter(input => input.type === 'checkbox').length, 3);
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)];
  for (const [id, destination] of [
    ['terms', 'https://geodd.io/legal/terms-of-service'],
    ['privacy', 'https://geodd.io/legal/privacy-policy'],
    ['marketing', undefined],
  ]) {
    const input = inputs.find(candidate => candidate.id === id);
    assert.ok(input);
    assert.equal(input.type, 'checkbox');
    assert.equal('checked' in input, false);
    const label = labels.find(candidate => attributes(candidate[1]!).for === id
      || [...candidate[2]!.matchAll(/<input\b([^>]*)>/gi)].some(match => attributes(match[1]!).id === id));
    assert.ok(label, `Missing native label for ${id}`);
    if (destination) {
      const link = [...label[2]!.matchAll(/<a\b([^>]*)>/gi)].map(match => attributes(match[1]!)).find(candidate => candidate.href === destination);
      assert.ok(link, `Missing legal destination for ${id}`);
      assert.equal(link.target, '_blank');
      assert.ok(link.rel?.split(/\s+/).includes('noopener'));
      assert.ok(link.rel?.split(/\s+/).includes('noreferrer'));
    } else assert.match(label[2]!, /optional/i);
  }
});

test('auth presentation leaves Google artwork SDK-owned and scopes native button styles', () => {
  assert.match(html, /<div\b[^>]*\bid="google-button"[^>]*>\s*<\/div>/);
  assert.doesNotMatch(html, /<(?:img|picture|svg)\b/i);
  for (const match of html.matchAll(/\b(?:class|id)="([^"]*)"/g)) {
    assert.doesNotMatch(match[1]!, /(?:^|\s)(?:brand|logo|artwork|hero)(?:$|[\s-])/i);
  }
  for (const match of html.matchAll(/<button\b([^>]*)>/gi)) {
    assert.ok(attributes(match[1]!).class?.split(/\s+/).includes('auth-button'));
  }
  assert.match(css, /\.auth-button\b/);
  assert.match(css, /#google-button\s*\{[^}]*color-scheme:\s*light\s*;/);
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    assert.doesNotMatch(match[1]!, /(^|[\s>+~,(])button(?![\w-]|\.auth-button\b)/, 'Native button rules must not style SDK-owned buttons');
  }
  assert.match(css, /:focus-visible\b/);
});

test('semantic color tokens have light defaults, explicit dark values and an unforced system fallback', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.trim(), body: match[2]! }));
  const light = rules.find(rule => rule.selector === ':root');
  const dark = rules.find(rule => rule.selector.includes(':root[data-theme="dark"]') && rule.selector.includes(':root.dark'));
  const system = rules.find(rule => rule.selector.startsWith(':root:not('));
  assert.ok(light);
  assert.ok(dark);
  assert.ok(system);
  assert.match(light.body, /color-scheme:\s*light\s*;/);
  for (const rule of [dark, system]) assert.match(rule.body, /color-scheme:\s*dark\s*;/);
  for (const name of ['canvas', 'paper', 'text', 'secondary', 'line', 'accent', 'focus', 'input', 'cta', 'cta-copy']) {
    for (const rule of [light, dark, system]) assert.match(rule.body, new RegExp(`--auth-${name}:\\s*[^;]+;`));
  }
  for (const theme of ['light', 'dark']) {
    assert.ok(system.selector.includes(`:not([data-theme="${theme}"])`));
    assert.ok(system.selector.includes(`:not(.${theme})`));
  }
  const focus = rules.find(rule => rule.selector === ':focus-visible');
  assert.ok(focus);
  assert.match(focus.body, /outline:\s*[^;]*var\(--auth-focus\)/);
});

test('auth loads Plus Jakarta Sans and IBM Plex Mono through a Google Fonts stylesheet', () => {
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)].map(match => attributes(match[1]!));
  const fontLinks = links.filter(link => link.rel === 'stylesheet' && link.href?.startsWith('https://fonts.googleapis.com/'));
  assert.ok(fontLinks.length > 0);
  const families = fontLinks.flatMap(link => new URL(link.href!.replaceAll('&amp;', '&')).searchParams.getAll('family'));
  for (const family of ['Plus Jakarta Sans', 'IBM Plex Mono']) {
    assert.ok(families.some(value => value.split(':')[0] === family), `Missing Google Fonts family ${family}`);
    assert.ok(css.includes(`"${family}"`) || css.includes(`'${family}'`), `Missing CSS family ${family}`);
  }
});
