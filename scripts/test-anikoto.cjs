const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const Fastify = require('fastify');

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
        return { sub: { sources: [{ url: 'https://cdn.example/stream.m3u8' }] } };
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
    await app.inject(route);
    assert.equal(watches, 1);
    assert.equal((await app.inject('/watch/' + encodeURIComponent('https://127.0.0.1$episode$1'))).statusCode, 400);
  } finally { await app.close(); }
});
