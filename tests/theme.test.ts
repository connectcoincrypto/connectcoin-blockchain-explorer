import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const STORAGE_KEY = 'connectcoin-explorer-theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';
const bootstrap = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
type Preference = 'system' | 'light' | 'dark';
interface ThemeAPI {
  getPreference(): Preference;
  setPreference(value: unknown): void;
  subscribe(listener: () => void): () => void;
}

function browser(
  options: {
    systemDark?: boolean;
    stored?: Map<string, string>;
    throwOnRead?: boolean;
    throwOnWrite?: boolean;
    inaccessibleStorage?: boolean;
  } = {},
) {
  const stored = options.stored ?? new Map<string, string>();
  const writes: [string, string][] = [];
  const documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: '' } };
  const mediaListeners = new Set<(event: { matches: boolean; media: string }) => void>();
  const storageListeners = new Set<(event: { key: string | null; storageArea: unknown }) => void>();
  const media = {
    matches: options.systemDark ?? false,
    media: MEDIA_QUERY,
    addEventListener(type: string, listener: (event: { matches: boolean; media: string }) => void) {
      assert.equal(type, 'change');
      mediaListeners.add(listener);
    },
  };
  const storage = {
    getItem(key: string): string | null {
      if (options.throwOnRead) throw new Error('Storage access blocked');
      return stored.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (options.throwOnWrite) throw new Error('Storage quota or access denied');
      writes.push([key, value]);
      stored.set(key, value);
    },
  };
  const window = {
    get localStorage() {
      if (options.inaccessibleStorage) throw new Error('Storage object unavailable');
      return storage;
    },
    matchMedia(query: string) {
      assert.equal(query, MEDIA_QUERY);
      return media;
    },
    addEventListener(type: string, listener: (event: { key: string | null; storageArea: unknown }) => void) {
      assert.equal(type, 'storage');
      storageListeners.add(listener);
    },
    connectcoinTheme: undefined as ThemeAPI | undefined,
  };
  runInNewContext(
    bootstrap,
    { window, document: { documentElement } },
    {
      filename: 'public/theme.js',
      timeout: 1000,
    },
  );
  const api = window.connectcoinTheme;
  assert.ok(api, 'the parser-blocking script must initialize its public API immediately');
  return {
    api,
    stored,
    writes,
    expectTheme(expected: 'light' | 'dark') {
      assert.equal(documentElement.dataset.theme, expected);
      assert.equal(documentElement.style.colorScheme, expected);
    },
    changeSystem(dark: boolean) {
      media.matches = dark;
      for (const listener of mediaListeners) listener({ matches: dark, media: MEDIA_QUERY });
    },
    storageEvent(key: string | null) {
      for (const listener of storageListeners) listener({ key, storageArea: storage });
    },
  };
}

test('theme bootstrap defaults to the OS preference without storing an explicit choice', () => {
  for (const systemDark of [false, true]) {
    const page = browser({ systemDark });
    assert.equal(page.api.getPreference(), 'system');
    page.expectTheme(systemDark ? 'dark' : 'light');
    assert.equal(page.stored.has(STORAGE_KEY), false);
    assert.deepEqual(page.writes, []);
  }
});

test('stored explicit themes override the OS, while stored system follows it', () => {
  const dark = browser({ systemDark: false, stored: new Map([[STORAGE_KEY, 'dark']]) });
  assert.equal(dark.api.getPreference(), 'dark');
  dark.expectTheme('dark');
  const light = browser({ systemDark: true, stored: new Map([[STORAGE_KEY, 'light']]) });
  assert.equal(light.api.getPreference(), 'light');
  light.expectTheme('light');
  const system = browser({ systemDark: true, stored: new Map([[STORAGE_KEY, 'system']]) });
  assert.equal(system.api.getPreference(), 'system');
  system.expectTheme('dark');
});

test('theme choice is applied synchronously, persisted and restored on the next page load', () => {
  const page = browser();
  page.api.setPreference('dark');
  page.expectTheme('dark');
  assert.equal(page.api.getPreference(), 'dark');
  assert.equal(page.stored.get(STORAGE_KEY), 'dark');
  assert.deepEqual(page.writes, [[STORAGE_KEY, 'dark']]);
  const reloaded = browser({ systemDark: false, stored: page.stored });
  assert.equal(reloaded.api.getPreference(), 'dark');
  reloaded.expectTheme('dark');
  reloaded.api.setPreference('system');
  assert.equal(page.stored.get(STORAGE_KEY), 'system');
  reloaded.expectTheme('light');
  browser({ systemDark: true, stored: page.stored }).expectTheme('dark');
});

test('OS changes update the page only while the preference is system', () => {
  const page = browser();
  page.changeSystem(true);
  page.expectTheme('dark');
  assert.equal(page.api.getPreference(), 'system');
  assert.equal(page.stored.has(STORAGE_KEY), false);
  page.api.setPreference('light');
  page.changeSystem(false);
  page.changeSystem(true);
  page.expectTheme('light');
  assert.equal(page.api.getPreference(), 'light');
  page.api.setPreference('dark');
  page.changeSystem(false);
  page.expectTheme('dark');
  page.api.setPreference('system');
  page.expectTheme('light');
  page.changeSystem(true);
  page.expectTheme('dark');
});

test('cross-tab preference updates and storage.clear are reflected without writing back', () => {
  const page = browser();
  let notifications = 0;
  page.api.subscribe(() => notifications++);
  page.stored.set(STORAGE_KEY, 'dark');
  page.storageEvent(STORAGE_KEY);
  assert.equal(page.api.getPreference(), 'dark');
  page.expectTheme('dark');
  assert.equal(notifications, 1);
  page.stored.set(STORAGE_KEY, 'light');
  page.storageEvent('unrelated-preference');
  assert.equal(page.api.getPreference(), 'dark');
  page.expectTheme('dark');
  assert.equal(notifications, 1);
  page.storageEvent(STORAGE_KEY);
  page.expectTheme('light');
  page.changeSystem(true);
  page.stored.clear();
  page.storageEvent(null);
  assert.equal(page.api.getPreference(), 'system');
  page.expectTheme('dark');
  assert.equal(notifications, 3);
  assert.deepEqual(page.writes, [], 'storage events must not create a cross-tab write loop');
});

test('blocked storage reads fall back to system and blocked writes still change the current page', () => {
  const blockedRead = browser({
    systemDark: true,
    stored: new Map([[STORAGE_KEY, 'light']]),
    throwOnRead: true,
  });
  assert.equal(blockedRead.api.getPreference(), 'system');
  blockedRead.expectTheme('dark');
  const stored = new Map([[STORAGE_KEY, 'light']]);
  const blockedWrite = browser({ stored, throwOnWrite: true });
  let notifications = 0;
  blockedWrite.api.subscribe(() => notifications++);
  assert.doesNotThrow(() => blockedWrite.api.setPreference('dark'));
  assert.equal(blockedWrite.api.getPreference(), 'dark');
  blockedWrite.expectTheme('dark');
  assert.equal(notifications, 1);
  assert.equal(stored.get(STORAGE_KEY), 'light');
  blockedWrite.changeSystem(false);
  blockedWrite.expectTheme('dark');
  browser({ stored }).expectTheme('light');
});

test('an inaccessible localStorage object cannot prevent bootstrap or local theme switching', () => {
  const page = browser({ systemDark: true, inaccessibleStorage: true });
  assert.equal(page.api.getPreference(), 'system');
  page.expectTheme('dark');
  assert.doesNotThrow(() => page.api.setPreference('light'));
  assert.equal(page.api.getPreference(), 'light');
  page.expectTheme('light');
  assert.doesNotThrow(() => page.storageEvent(null));
  assert.equal(page.api.getPreference(), 'system');
  page.expectTheme('dark');
});

test('invalid stored, assigned and cross-tab values normalize to system', () => {
  for (const invalid of ['', 'sepia', 'DARK', 'null']) {
    const page = browser({ systemDark: true, stored: new Map([[STORAGE_KEY, invalid]]) });
    assert.equal(page.api.getPreference(), 'system');
    page.expectTheme('dark');
  }
  const page = browser();
  for (const invalid of ['sepia', '', 'DARK', null, undefined, 1, {}]) {
    page.api.setPreference('dark');
    page.api.setPreference(invalid);
    assert.equal(page.api.getPreference(), 'system');
    assert.equal(page.stored.get(STORAGE_KEY), 'system');
    page.expectTheme('light');
  }
  page.api.setPreference('dark');
  page.stored.set(STORAGE_KEY, 'broken');
  page.storageEvent(STORAGE_KEY);
  assert.equal(page.api.getPreference(), 'system');
  page.expectTheme('light');
});

test('subscribers observe the applied preference and can unsubscribe independently', () => {
  const page = browser();
  const seen: Preference[] = [];
  let secondListenerCalls = 0;
  const unsubscribe = page.api.subscribe(() => {
    seen.push(page.api.getPreference());
    page.expectTheme(page.api.getPreference() === 'dark' ? 'dark' : 'light');
  });
  const unsubscribeSecond = page.api.subscribe(() => secondListenerCalls++);
  page.api.setPreference('dark');
  page.api.setPreference('light');
  assert.deepEqual(seen, ['dark', 'light']);
  assert.equal(secondListenerCalls, 2);
  unsubscribe();
  unsubscribe();
  page.api.setPreference('system');
  assert.deepEqual(seen, ['dark', 'light']);
  assert.equal(secondListenerCalls, 3);
  unsubscribeSecond();
  page.api.setPreference('dark');
  assert.equal(secondListenerCalls, 3);
});

test('HTML runs the external theme bootstrap in the head before the application module', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = /<script\b[^>]*\bsrc=["']\/theme\.js["'][^>]*>\s*<\/script>/i.exec(html);
  assert.ok(match, 'theme bootstrap must be an external script');
  assert.ok(match.index > html.indexOf('<head>') && match.index < html.indexOf('</head>'));
  assert.ok(match.index < html.indexOf('/src/client/main.tsx'));
  assert.doesNotMatch(
    match[0],
    /\b(?:async|defer)\b|\btype=["']module["']/i,
    'theme selection must run before the first application paint',
  );
});
