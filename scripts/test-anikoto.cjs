const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const Fastify = require('fastify');

test('encrypted MegaPlay responses retain subtitles and timings; malformed envelopes are ignored', () => {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/providers/custom/anikotoProvider.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require, Buffer });
  const decode = module.exports.decodeAniKotoSourceResponse;
  const enc = 'wdeBruh3qqn_i5wUNnyaPcXqidp1UWP84FfPHzGyKXCJBhAWuEiHR0hChNQM0wmZ_WRn_pUAgif1NXV9FxvRL9tHJUZ5-8nZnH1C0aScaGqs978NXUJ9C6_HoE52v-_fHDZrNEbCR5FnbpMkr1yWF5g5ct_qBwXJVFsJa3nTaRc';
  const payload = { enc, tracks: [{ file: 'https://example.com/sub.vtt' }], intro: { start: 5, end: 90 } };
  const decoded = decode(payload);
  assert.match(decoded.sources.file, /^https:\/\/.*\/master\.m3u8$/);
  assert.equal(decoded.tracks, payload.tracks);
  assert.equal(decoded.intro, payload.intro);
  const malformed = { enc: 'broken' };
  assert.equal(decode(malformed), malformed);
  const legacy = { sources: { file: 'https://example.com/video.m3u8' } };
  assert.equal(decode(legacy), legacy);
});

test('discovery removes two next-episode requests, coalesces, expires and isolates title snapshots', async () => {
  const module = { exports: {} };
  const requests = [];
  let now = 0, count = 2, fail = false;
  const mockFetch = async url => {
    const u = new URL(url);
    requests.push(u.pathname);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (fail) throw new Error('offline');
    if (u.pathname.startsWith('/watch/')) return new Response(`<div id="watch-main" data-id="${u.pathname.slice(7)}"></div>`);
    if (u.pathname.includes('/episode/list/')) return Response.json({ result: Array.from({ length: count }, (_, i) =>
      `<a data-num="${i + 1}" data-ids="${u.pathname.split('/').pop()}-${i + 1}"></a>`).join('') });
    if (u.pathname === '/ajax/server/list') return Response.json({ result: `<li data-link-id="${u.searchParams.get('servers')}">Default</li>` });
    if (u.pathname === '/ajax/server') return Response.json({ url: 'https://embed.example/' + u.searchParams.get('get') });
    if (u.hostname === 'embed.example' && !u.pathname.includes('getSources')) return new Response('<div data-id="1"></div>');
    return Response.json({ sources: { file: 'https://cdn.example/fresh.m3u8' } });
  };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/providers/custom/anikotoProvider.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require, URL, AbortSignal, Date: { now: () => now }, globalThis: { fetch: mockFetch } });
  const extract = module.exports.fetchCurrentAniKotoSources;
  const discoveryCount = () => requests.filter(p => p.startsWith('/watch/')).length;
  await Promise.all([extract('show$episode$1'), extract('show$episode$2')]);
  assert.equal(discoveryCount(), 1, 'concurrent episodes share discovery, not extraction');
  const before = requests.length;
  const start = performance.now();
  await extract('show$episode$2');
  assert.equal(requests.length - before, 4, 'next extraction needs only server/list, server, embed, sources');
  console.log(`Cached-discovery extraction: ${Math.round(performance.now() - start)}ms, 4 requests (uncached: 6 requests at 5ms each)`);
  assert.equal(discoveryCount(), 1);
  count = 3;
  assert.ok(await extract('show$episode$3'), 'refresh missing newly released episode');
  assert.equal(discoveryCount(), 2);
  await extract('other-season$episode$1');
  assert.equal(discoveryCount(), 3, 'season slug is a separate namespace');
  now += 30 * 60 * 1000 + 1;
  fail = true;
  await assert.rejects(extract('show$episode$1'), /offline/);
  fail = false;
  await extract('show$episode$1');
  assert.equal(discoveryCount(), 5, 'expired data and rejected pending promises are not reused');
  count = 0;
  assert.equal(await extract('empty$episode$1'), null);
  count = 2;
  assert.ok(await extract('empty$episode$1'), 'empty snapshots are not cached');
  assert.equal(discoveryCount(), 7);
});

test('AniKoto extraction preserves language IDs and alternate CDN selectors', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/custom/anikotoProvider.ts'), 'utf8');
  const module = { exports: {} };
  const requests = [];
  const mockFetch = async (url) => {
    const u = new URL(url);
    requests.push(u);
    if (u.pathname.startsWith('/watch/')) return new Response('<div id="watch-main" data-id="1"></div>');
    if (u.pathname.includes('/episode/list')) return Response.json({ result: '<a data-num="1" data-ids="episodes"></a>' });
    if (u.pathname === '/ajax/server/list') return Response.json({ result: '<div class="servers">' + ['sub', 'dub'].map(mode =>
      `<div class="type" data-type="${mode}"><ul><li data-link-id="${mode}" data-sv-id="1">Default</li><li data-link-id="${mode}-alt" data-sv-id="2">Alternate</li></ul></div>`).join('') + '</div>' });
    if (u.pathname === '/ajax/server') {
      const [mode, alt] = u.searchParams.get('get').split('-');
      return Response.json({ result: { url: `https://megaplay.buzz/embed/${mode}${alt ? '?s=tcdn' : ''}` } });
    }
    if (u.pathname.startsWith('/embed/')) return new Response(`<div id="megaplay-player" data-id="${u.pathname.endsWith('dub') ? '20' : '10'}"></div>`);
    if (u.pathname.includes('/getSources')) return Response.json({ sources: { file: `https://cdn.example/${u.searchParams.get('id')}/${u.searchParams.get('s') || 'default'}.m3u8` } });
    throw new Error('Unexpected URL: ' + url);
  };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require, URL, AbortSignal, globalThis: { fetch: mockFetch },
  });
  const result = await module.exports.fetchCurrentAniKotoSources('show$episode$1');
  for (const [mode, id] of [['sub', '10'], ['dub', '20']]) {
    assert.equal(result[mode].sources.length, 2);
    assert.ok(result[mode].sources.every(s => s.url.includes('/' + id + '/') && s.isDub === (mode === 'dub')));
    assert.ok(result[mode].sources.some(s => s.url.endsWith('/tcdn.m3u8')));
    assert.ok(result[mode].sources.some(s => s.url.endsWith('/default.m3u8')));
  }
  assert.equal(requests.filter(u => u.pathname.includes('/getSources') && u.searchParams.get('s') === 'tcdn').length, 2);
});

test('AniKoto route validates hosts, coalesces requests and retries empty catalogs', async () => {
  let infos = 0, watches = 0, searches = 0;
  let empty = false;
  class Provider {
    client = { defaults: {} };
    toString = { baseUrl: 'https://anikoto.cz' };
    async search(query) {
      searches++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { results: [{ id: query }] };
    }
    async fetchAnimeInfo(id) {
      infos++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { id, episodes: empty ? [] : [{ id: id + '$episode$1' }] };
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/anime/anikoto.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, URL, console,
    require(id) {
      if (id === '@consumet/extensions') return { ANIME: { AniKoto: Provider } };
      if (id.includes('anikotoProvider')) return { fetchCurrentAniKotoSources: async () => {
        watches++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { sub: { sources: [{ url: 'https://cdn.example/stream.m3u8', intro: { start: 0, end: 101 } }] } };
      } };
      return require(id);
    },
  });
  const app = Fastify();
  await app.register(module.exports.default);
  try {
    for (const id of ['http://127.0.0.1/admin', 'https://anikoto.cz.evil.test/watch/show', 'https://user@anikoto.cz/watch/show', '../private', '//127.0.0.1']) {
      assert.equal((await app.inject('/info?id=' + encodeURIComponent(id))).statusCode, 400);
    }
    assert.equal(infos, 0);
    await Promise.all(Array.from({ length: 4 }, () => app.inject('/show')));
    assert.equal(searches, 1);
    assert.equal((await app.inject('/show?page=-1')).statusCode, 400);
    await Promise.all(Array.from({ length: 4 }, () => app.inject('/info?id=show-one')));
    assert.equal(infos, 1);
    await app.inject('/info?id=' + encodeURIComponent('https://anikoto.cz/watch/show-one/ep-1'));
    assert.equal(infos, 1);
    empty = true;
    await app.inject('/info?id=show-two');
    empty = false;
    const retry = await app.inject('/info?id=show-two');
    assert.equal(retry.json().episodes.length, 1);
    assert.equal(infos, 3);
    const route = '/watch/' + encodeURIComponent('show-one$episode$1');
    await Promise.all(Array.from({ length: 4 }, () => app.inject(route)));
    assert.equal(watches, 1);
    const cachedWatch = await app.inject(route);
    assert.deepEqual(cachedWatch.json().sub.sources[0].intro, { start: 0, end: 101 });
    assert.equal(watches, 1);
    await app.inject('/watch/' + encodeURIComponent('show-one$episode$2'));
    assert.equal(watches, 2, 'watch cache must be episode-specific');
    assert.equal((await app.inject('/watch/' + encodeURIComponent('https://127.0.0.1$episode$1'))).statusCode, 400);
  } finally { await app.close(); }
});

test('AniKoto watch API retains source-specific seconds, rejects invalid ranges and isolates episodes', async () => {
  const module = { exports: {} };
  let episode = 1;
  const mockFetch = async url => {
    const u = new URL(url);
    if (u.pathname.startsWith('/watch/')) return new Response('<div id="watch-main" data-id="1"></div>');
    if (u.pathname.includes('/episode/list')) return Response.json({ result: `<a data-num="${episode}" data-ids="ids"></a>` });
    if (u.pathname === '/ajax/server/list') return Response.json({ result: '<div class="servers">' + ['sub', 'dub'].map(mode =>
      `<div class="type" data-type="${mode}"><li data-link-id="${mode}" data-sv-id="1">Default</li><li data-link-id="${mode}-alt" data-sv-id="2">Alternate</li></div>`).join('') + '</div>' });
    if (u.pathname === '/ajax/server') return Response.json({ result: {
      url: `https://megaplay.buzz/embed/${u.searchParams.get('get')}`,
      skip_data: { intro: [0, 101], outro: [1295, 1385] },
    } });
    if (u.pathname.startsWith('/embed/')) return new Response(`<div data-id="${['sub', 'sub-alt', 'dub', 'dub-alt'].indexOf(u.pathname.slice(7)) + 1}"></div>`);
    if (u.pathname.includes('/getSources')) {
      const id = Number(u.searchParams.get('id'));
      // Same file can still carry distinct per-embed timelines.
      const invalid = [[0, 0], [-1, 90], [90, 5], [null, 90], ['', 90], [false, 90], [NaN, Infinity]][episode - 2];
      const timings = invalid ? { intro: invalid, outro: { start: invalid[0], end: invalid[1] } }
        : [null, {}, { intro: { start: 5, end: 95 } }, { intro: { start: 20, end: 110 }, outro: { start: 1300, end: 1390 } }, { intro: { start: 0, end: 0 }, outro: { start: 5, end: 5 } }][id];
      return Response.json({ sources: { file: 'https://cdn.example/shared.m3u8' }, ...timings });
    }
    throw new Error(url);
  };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/providers/custom/anikotoProvider.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require, URL, AbortSignal, globalThis: { fetch: mockFetch } });
  const app = Fastify();
  app.get('/watch/:id', async request => module.exports.fetchCurrentAniKotoSources(request.params.id));
  try {
    const first = (await app.inject('/watch/show$episode$1')).json();
    assert.deepEqual(first.sub.sources.map(s => s.intro), [{ start: 0, end: 101 }, { start: 5, end: 95 }]);
    assert.deepEqual(first.dub.sources[0].intro, { start: 20, end: 110 });
    assert.deepEqual(first.dub.sources[0].outro, { start: 1300, end: 1390 });
    assert.equal(first.dub.sources[1].intro, undefined, 'explicit 0,0 must not inherit link timing');
    assert.equal(first.dub.sources[1].outro, undefined);
    assert.equal(first.intro, undefined, 'do not publish episode-global ranges');
    for (episode = 2; episode <= 8; episode++) {
      const second = (await app.inject(`/watch/show$episode$${episode}`)).json();
      for (const mode of ['sub', 'dub']) for (const source of second[mode].sources) {
        assert.equal(source.intro, undefined);
        assert.equal(source.outro, undefined);
      }
    }
  } finally { await app.close(); }
});
