// Offline regression: execute the real page callbacks with slow browser fetches.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
require('ts-node/register/transpile-only');
const baseline = process.argv.includes('--baseline');
const root = baseline ? '../dist' : '../src';
let payload;
let active = 0;
let peak = 0;
let aborted = 0;
let closed = 0;
let prefetchStarted = 0;
const fetchOptions = [];
require('playwright').chromium.launch = async () => ({
  isConnected: () => true,
  newContext: async () => ({
    cookies: async () => [],
    close: async () => { closed++; },
    newPage: async () => ({
      route: async () => {},
      on: () => {},
      addInitScript: async () => {},
      goto: async () => {},
      waitForTimeout: async () => {},
      evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn})(...args)`, {
        args, AbortController, setTimeout, clearTimeout,
        window: { __playbackPayloads: [JSON.stringify(payload)], __watchhdDecodedPayloads: [JSON.stringify(payload)] },
        document: { location: { href: 'https://hubstream.art/' }, querySelectorAll: () => [], querySelector: () => null },
        fetch: async (url, options) => {
          if (!fetchOptions.length) prefetchStarted = Date.now();
          fetchOptions.push(options);
          if (url.includes('/unavailable/')) return { ok: false };
          // Headers arrive immediately; the timeout must cover the body too.
          return { ok: true, text: () => new Promise((resolve, reject) => {
            active++;
            peak = Math.max(peak, active);
            const slow = url.includes('/slow/');
            const finish = () => {
              active--;
              options.signal?.removeEventListener('abort', abort);
              resolve('#EXTM3U\n#EXT-X-ENDLIST');
            };
            const timer = setTimeout(finish, slow ? 6000 : 1200);
            const abort = () => {
              clearTimeout(timer);
              active--;
              aborted++;
              reject(new Error('aborted'));
            };
            options.signal?.addEventListener('abort', abort, { once: true });
          }) };
        },
      }),
    }),
  }),
});
const runtime = require(`${root}/utils/browserRuntimeExtractor`);
const { HdStream4uProvider } = require(`${root}/providers/custom/hdstream4uProvider`);

test('manifest prefetch stays bounded without losing sources or subtitles', async () => {
  for (const kind of ['hubstream', 'hdstream4u']) {
    peak = aborted = 0;
    fetchOptions.length = 0;
    const urls = ['one', 'two', 'slow'].map(name => `https://hubstream.art/${kind}/${name}/master.m3u8`);
    payload = { cf: urls[0], google: urls[1], source: urls[2], tracks: [{ file: `https://hubstream.art/${kind}/english.vtt`, label: 'English' }] };
    const t = Date.now();
    const result = kind === 'hubstream'
      ? await runtime.extractPlaybackWithPlaywright('https://hubstream.art/#fixture', undefined, 20000)
      : await HdStream4uProvider.extractHdstream4uFileWithManifestPrefetch('https://hdstream4u.com/file/fixture', 'hdstream4u');
    const ms = Date.now() - t;
    const prefetchMs = Date.now() - prefetchStarted;
    console.log(JSON.stringify({ kind, baseline, ms, prefetchMs, peak, aborted }));
    assert.deepEqual(result.sources.map(s => s.url).sort(), [...urls].sort());
    assert.equal(result.subtitles.length, 1);
    assert.equal(result.subtitles[0].lang, 'English');
    assert.equal(runtime.getCachedHlsManifest(urls[0])?.body.startsWith('#EXTM3U'), true);
    assert.equal(runtime.getCachedHlsManifest(urls[1])?.body.startsWith('#EXTM3U'), true);
    assert.equal(active, 0);
    assert.equal(fetchOptions.length, 3);
    assert.ok(fetchOptions.every(o => o.credentials === 'include' && o.headers.Referer));
    if (!baseline) {
      assert.ok(prefetchMs < 5000, `prefetch exceeded budget: ${prefetchMs}ms`);
      assert.equal(peak, 3);
      assert.equal(aborted, 1);
      assert.equal(runtime.getCachedHlsManifest(urls[2]), undefined);
    }
  }
  assert.equal(closed, 2);
});

test('cached manifests are reused and prefetch failure does not discard extraction', async () => {
  fetchOptions.length = 0;
  const cached = 'https://hubstream.art/hubstream/one/master.m3u8';
  const unavailable = 'https://hubstream.art/unavailable/master.m3u8';
  payload = { cf: cached, source: unavailable };
  const result = await runtime.extractPlaybackWithPlaywright('https://hubstream.art/#fixture', undefined, 20000);
  assert.deepEqual(result.sources.map(s => s.url).sort(), [cached, unavailable].sort());
  assert.equal(fetchOptions.length, 1);
  assert.equal(runtime.getCachedHlsManifest(unavailable), undefined);
  assert.equal(active, 0);
  assert.equal(closed, 3);
});
