const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

test('HubStream verification reuses valid browser manifests but probes uncached, invalid and expired ones', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/custom/hdstream4uProvider.ts'), 'utf8');
  const start = source.indexOf('const verifyHubstreamSourceState =');
  const end = source.indexOf('// Probe every hubstream source', start);
  let cached = { body: '#EXTM3U\n#EXT-X-ENDLIST' }, expired = false, calls = 0;
  const c = vm.createContext({
    getCachedHlsManifest: () => cached, hubstreamTokenIsExpired: () => expired,
    USER_AGENT: 'test', axios: { get: async () => { calls++; return { status: 403 }; } },
  });
  vm.runInContext(ts.transpile(source.slice(start, end) + '\nglobalThis.probe = verifyHubstreamSourceState;', { target: ts.ScriptTarget.ES2020 }), c);
  assert.equal(await c.probe('https://hubstream.art/master.m3u8'), 'ok');
  assert.equal(calls, 0);
  expired = true;
  assert.equal(await c.probe('https://hubstream.art/master.m3u8'), 'dead');
  expired = false; cached = undefined;
  assert.equal(await c.probe('https://hubstream.art/master.m3u8'), 'dead');
  cached = { body: '<html>error</html>' };
  assert.equal(await c.probe('https://hubstream.art/master.m3u8'), 'dead');
  assert.equal(calls, 3);
});

test('TV mapping uses supplied title metadata and preserves shifted episode identity', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/meta/tmdb.ts'), 'utf8');
  const start = source.indexOf('const HDSTREAM_TV_EPISODE_SHIFTS:');
  const end = source.indexOf('const IS_PRODUCTION', start);
  const requests = [];
  const c = vm.createContext({
    getTitleCandidatesFromMedia: info => [info.title], normalizeText: s => s.toLowerCase(),
    titleMatchScore: () => 1000, safeJsonParse: JSON.parse,
    searchHdhub4uByTitle: async () => [{title: 'Latent season 2', url: 'https://hdhub4u.test/latent-season-2'}],
  });
  vm.runInContext(ts.transpile(source.slice(start, end) + '\nglobalThis.resolveEpisode = resolveHdstream4uTvEpisodeId;', { target: ts.ScriptTarget.ES2020 }), c);
  const request = {server: {inject: async ({url}) => {
    requests.push(url);
    assert.match(url, /^\/movies\/hdstream4u\/info/);
    return {statusCode: 200, body: JSON.stringify({episodes: [
      {episodeNumber: 6, seasonNumber: 0, category: 'bonus', episodeId: 'wrong-special'},
      {episodeNumber: 7, seasonNumber: 2, episodeId: 'https://hubstream.art/#correct'},
    ]})};
  }}};
  const result = await c.resolveEpisode(request, '262838', 'tv', 2, 6, {title: 'Latent'});
  assert.equal(result, 'https://hubstream.art/#correct');
  assert.equal(requests.length, 1, 'no full TMDB info/season/trailer hydration');
});
