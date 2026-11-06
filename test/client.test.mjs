/**
 * Client-surface tests for dsh-token-usage-stats.
 *
 * The bundle is loaded exactly as the Host loads it (`window.__ModuleLoader__`)
 * against a stub Cordis context, then rendered with `react-dom/server`. The
 * React shim only exists to seed `useState` with a chosen payload, so the
 * populated, empty, error, and loading states can all be rendered without a
 * DOM: `useEffect` never runs under server rendering.
 *
 * React is a dev-only test dependency resolved from the surrounding workspace;
 * the plugin itself stays dependency-free, so the suite skips when it is absent.
 *
 * Usage: node --test test/client.test.mjs   (from the plugin directory)
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const workspaceRequire = createRequire(import.meta.url);
let React;
let renderToStaticMarkup;
try {
  React = workspaceRequire('react');
  ({ renderToStaticMarkup } = workspaceRequire('react-dom/server'));
} catch {
  React = undefined;
}

const SKIP = React === undefined ? 'react is not resolvable from this workspace' : false;
const CLIENT_URL = new URL('../client.js', import.meta.url);

/**
 * A stand-in for the Host locale service with the behaviour that matters here:
 * a second registration of the same namespace/locale throws, and an unknown
 * key resolves to the key itself (which is how the real translate() behaves).
 */
function createLocaleService(language = 'zh-CN') {
  const dictionaries = new Map();
  return {
    language,
    register(namespace, value) {
      const existing = dictionaries.get(namespace);
      for (const locale of Object.keys(value)) {
        if (existing !== undefined && existing[locale] !== undefined) {
          throw new Error(`locale namespace "${namespace}" already has locale "${locale}"`);
        }
      }
      dictionaries.set(namespace, { ...(existing ?? {}), ...value });
      return () => {
        for (const locale of Object.keys(value)) {
          if (dictionaries.get(namespace)?.[locale] === value[locale]) delete dictionaries.get(namespace)[locale];
        }
      };
    },
    bind(namespace) {
      return (key) => {
        const table = dictionaries.get(namespace);
        if (table === undefined) return key;
        const active = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
        const value = table[active] === undefined ? undefined : table[active][key];
        return value === undefined ? key : value;
      };
    },
  };
}

/**
 * Load the bundle and apply it to a fake context.
 * @param {{ state?: object, language?: string, locale?: object, context?: object }} [options]
 *   seeded hook state; `context` re-applies onto an existing fake context
 *   (which is how HMR re-imports a plugin fiber).
 */
async function mount({ state, language = 'zh-CN', locale = null, context = null } = {}) {
  const service = locale ?? createLocaleService(language);
  const target = context ?? { registrations: [], disposers: [] };
  let definition = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  // A fresh query is a fresh module instance: every call re-runs apply().
  await import(`${CLIENT_URL.href}?tick=${Math.random()}`);
  assert.ok(definition, 'the bundle must call window.__ModuleLoader__.load');
  assert.equal(definition.id, 'dsh-token-usage-stats');

  // Only the summary/session `useState` is seeded — recognized by its
  // `{ loading: true, … }` initial shape, exactly the hook the Host fills
  // before paint. Auxiliary hook state (pager page, segmented range, hover)
  // keeps its default. `createElement`/`Fragment` stay genuine so the markup
  // is the real markup the Host would produce.
  const seeded = {
    createElement: React.createElement,
    Fragment: React.Fragment,
    useState(initial) {
      const isDataHook = state !== undefined
        && initial !== null && typeof initial === 'object'
        && initial.loading === true;
      return [isDataHook ? state : initial, () => {}];
    },
    useCallback(fn) {
      return fn;
    },
    useEffect() {},
  };

  const ctx = {
    registrations: target.registrations,
    disposers: target.disposers,
    slots: {
      inject(name, factory) {
        factory();
      },
      register(descriptor, render) {
        ctx.registrations.push({ descriptor, render });
        return () => {};
      },
    },
    locale: service,
    layout: { selectPanel() {} },
    effect(factory) {
      ctx.disposers.push(factory());
      return () => {};
    },
  };
  definition.factory((id) => {
    assert.equal(id, 'react', `unexpected require(${id})`);
    return seeded;
  }).apply(ctx);
  return ctx;
}

/** The newest conversation-view registration. */
function tabOf(context) {
  const matches = context.registrations.filter((entry) => entry.descriptor.name === 'conversation.view');
  return matches[matches.length - 1];
}

/** Render the session tab with one seeded state. */
async function renderTab(state, { language = 'zh-CN', sessionId = 'session-1' } = {}) {
  const context = await mount({ state, language });
  const tab = tabOf(context);
  assert.ok(tab, 'the session tab must be registered');
  return renderToStaticMarkup(tab.render({ sessionId }));
}

const BASE = new Date(2026, 10, 5, 21, 0, 0).getTime();

test('registers the session tab between 轨迹 and 上下文', { skip: SKIP }, async () => {
  const context = await mount({});
  const names = context.registrations.map((entry) => entry.descriptor.name);
  // The pre-existing surfaces must not move.
  assert.ok(names.includes('shell.bottom'));
  assert.ok(names.includes('main'));

  const tab = tabOf(context);
  assert.equal(tab.descriptor.id, 'token-usage-stats-session');
  assert.equal(tab.descriptor.order, 15, 'trajectory is 10 and context is 20');
  assert.equal(tab.descriptor.label(), '用量');

  const english = await mount({ language: 'en-US' });
  assert.equal(tabOf(english).descriptor.label(), 'Usage');
});

test('a duplicate locale registration (HMR re-import) still translates', { skip: SKIP }, async () => {
  // The same context and locale service re-applied without disposing the first
  // generation: the second `locale.register` throws exactly like the Host's.
  const locale = createLocaleService('zh-CN');
  const context = await mount({ locale });
  const first = tabOf(context).descriptor.label();
  // The expected duplicate-registration warning is noise here.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await mount({ locale, context });
  } finally {
    console.warn = originalWarn;
  }
  const second = tabOf(context).descriptor.label();
  assert.equal(first, '用量');
  assert.equal(second, '用量', 'a stale namespace must not leak raw keys into the UI');
  // The bottom bar label resolves through the same helper.
  assert.doesNotMatch(second, /^tab\./);
});

test('renders the loading state before the first payload', { skip: SKIP }, async () => {
  const html = await renderTab(undefined);
  assert.match(html, /本会话 Token 用量/);
  assert.match(html, /正在读取本会话用量/);
  assert.doesNotMatch(html, /dst-card-value/, 'no cards before data arrives');
});

test('renders this session’s totals, title, and per-turn rows', { skip: SKIP }, async () => {
  const state = {
    sessionId: 'session-1',
    loading: false,
    error: null,
    data: {
      by: 'turn',
      rows: [
        { sessionId: 'session-1', project: 'E:\\project\\demo', projectTitle: 'demo', sessionTitle: '查看节省Token的界面', turn: 3, startTs: BASE, endTs: BASE + 65000, durationMs: 65000, requests: 4, input: 1200, cacheRead: 80000, cacheWrite: 300, output: 900, reasoning: 100, total: 82400 },
        { sessionId: 'session-1', project: 'E:\\project\\demo', projectTitle: 'demo', sessionTitle: '查看节省Token的界面', turn: 2, startTs: BASE - 3600000, endTs: BASE - 3500000, durationMs: 100000, requests: 3, input: 800, cacheRead: 70000, cacheWrite: 200, output: 600, reasoning: 50, total: 71600 },
      ],
      totals: { requests: 7, input: 2000, cacheRead: 150000, cacheWrite: 500, output: 1500, reasoning: 150, total: 154000 },
    },
  };
  const html = await renderTab(state);
  assert.match(html, /仅当前会话/);
  assert.match(html, /项目 <b>demo<\/b>/, 'the project title comes from the turn rows');
  assert.match(html, /会话 <b>查看节省Token的界面<\/b>/);
  // Chinese compact formatting: 154,000 -> 15.4万.
  assert.match(html, /<div class="dst-card-value">15\.4万<\/div>/);
  assert.match(html, /<div class="dst-card-label">累计 Token<\/div>/);
  assert.match(html, /<div class="dst-card-label">计费请求<\/div>/);
  assert.match(html, /<div class="dst-card-value">7<\/div>/);
  assert.match(html, /逐轮明细/);
  assert.match(html, /#3/);
  assert.match(html, /1 分 05 秒/);
  assert.match(html, /只统计当前会话/);
  assert.equal((html.match(/class="dst-row"/g) ?? []).length, 2, 'one row per turn');
});

test('renders the empty state without inventing zero cards', { skip: SKIP }, async () => {
  const html = await renderTab({
    sessionId: 'session-1',
    loading: false,
    error: null,
    data: { by: 'turn', rows: [], totals: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 } },
  });
  assert.match(html, /本会话还没有用量记录/);
  assert.doesNotMatch(html, /dst-card-value/);
});

test('renders a retryable error state', { skip: SKIP }, async () => {
  const html = await renderTab({ sessionId: 'session-1', loading: false, data: null, error: 'HTTP 500' });
  assert.match(html, /本会话用量加载失败/);
  assert.match(html, /HTTP 500/);
  assert.match(html, /重试/);
});

test('survives a session-less render', { skip: SKIP }, async () => {
  const context = await mount({});
  const html = renderToStaticMarkup(tabOf(context).render({}));
  assert.match(html, /本会话 Token 用量/);
});

test('falls back to the inline dictionary when the locale service is absent', { skip: SKIP }, async () => {
  // No `locale` service at all: the flat inline dictionary must still resolve.
  const registrations = [];
  const bare = {
    slots: {
      inject(name, factory) {
        factory();
      },
      register(descriptor, render) {
        registrations.push({ descriptor, render });
        return () => {};
      },
    },
    layout: {},
  };
  let definition = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  await import(`${CLIENT_URL.href}?tick=${Math.random()}`);
  const seeded = {
    createElement: React.createElement,
    Fragment: React.Fragment,
    useState(initial) {
      return [initial, () => {}];
    },
    useCallback(fn) {
      return fn;
    },
    useEffect() {},
  };
  definition.factory((id) => {
    assert.equal(id, 'react');
    return seeded;
  }).apply(bare);
  const tab = registrations.find((entry) => entry.descriptor.name === 'conversation.view');
  // Which language wins depends on navigator.language; the raw key must not.
  assert.match(tab.descriptor.label(), /^(用量|Usage)$/);
});
