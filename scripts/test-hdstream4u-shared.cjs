// Offline request-count regressions. --baseline uses the pre-build dist snapshot.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
require('ts-node/register/transpile-only');
process.env.TMDB_KEY = 'offline-fixture';
const baseline = process.argv.includes('--baseline');
const root = baseline || process.argv.includes('--dist') ? '../dist' : '../src';
const axios = require('axios');
const runtime = require(`${root}/utils/browserRuntimeExtractor`);
runtime.extractPlaybackWithPlaywright = async () => ({ sources: [], subtitles: [] });
const { HdStream4uProvider: provider } = require(`${root}/providers/custom/hdstream4uProvider`);
const delay = () => new Promise(resolve => setTimeout(resolve, 50));
const page = '<h1>Fixture (2025)</h1><article><a href="https://hdstream4u.com/file/fixture">Watch Online</a></article>';

test('concurrent search shares one request and preserves results; pages stay distinct', async () => {
  let requests = 0;
  axios.get = async () => {
    requests++;
    await delay();
    return { data: { hits: [{ document: { post_title: 'Fixture', permalink: 'https://new5.hdhub4u.cl/fixture/' } }], found: 20 } };
  };
  const results = await Promise.all(Array.from({ length: 4 }, () => provider.search('Fixture')));
  results.forEach(result => assert.deepEqual(result, results[0]));
  assert.equal(results[0].results.length, 1);
  console.log(JSON.stringify({ case: 'concurrent-search', baseline, requests }));
  assert.equal(requests, baseline ? 4 : 1);
  await provider.search('Fixture');
  assert.equal(requests, baseline ? 4 : 1);
  await provider.search('Fixture', 2);
  assert.equal(requests, baseline ? 5 : 2);
});

test('numeric info reuses metadata across resolution and warm calls', async () => {
  let metadata = 0;
  let pages = 0;
  axios.get = async url => {
    await delay();
    if (url.includes('themoviedb')) {
      metadata++;
      return { data: { id: 123, title: 'Fixture', release_date: '2025-01-01' } };
    }
    pages++;
    return { data: page };
  };
  const t = performance.now();
  const first = await provider.fetchMediaInfo('123');
  const coldMs = Math.round(performance.now() - t);
  const warmStart = performance.now();
  const second = await provider.fetchMediaInfo('123');
  const warmMs = Math.round(performance.now() - warmStart);
  assert.deepEqual(first, second);
  assert.equal(first.servers.length, 1);
  console.log(JSON.stringify({ case: 'numeric-info', baseline, metadata, pages, coldMs, warmMs }));
  assert.equal(metadata, baseline ? 4 : 1);
  assert.equal(pages, 1);
});

test('concurrent info shares errors but retries after failure', async () => {
  let requests = 0;
  axios.get = async () => { requests++; await delay(); throw new Error('offline'); };
  const errors = await Promise.all(Array.from({ length: 4 }, () => provider.fetchMediaInfo('retry-fixture')));
  assert.ok(errors.every(result => result.error));
  assert.equal(requests, baseline ? 4 : 1);
  axios.get = async () => { requests++; return { data: page }; };
  const retry = await provider.fetchMediaInfo('retry-fixture');
  assert.equal(retry.servers.length, 1);
  assert.equal(requests, baseline ? 5 : 2);
});

test('site search fallback survives an unavailable index', async () => {
  let requests = 0;
  axios.get = async url => {
    requests++;
    await delay();
    if (url.includes('pingora')) throw new Error('offline');
    return { data: '<article><h2><a href="https://new5.hdhub4u.cl/fallback/">Fallback</a></h2></article>' };
  };
  const results = await Promise.all([provider.search('Fallback'), provider.search('Fallback')]);
  assert.equal(results[0].results[0].id, 'fallback');
  assert.deepEqual(results[0], results[1]);
  assert.equal(requests, baseline ? 4 : 2);
});

test('TMDB movie and TV metadata remain separate and alternate-type fallback survives', async () => {
  let movie = 0;
  let tv = 0;
  axios.get = async url => {
    if (url.includes('/movie/456')) { movie++; throw new Error('not found'); }
    if (url.includes('/tv/456')) { tv++; return { data: { id: 456, name: 'Fixture', first_air_date: '2025-01-01' } }; }
    return { data: page };
  };
  const result = await provider.fetchMediaInfo('456');
  assert.equal(result.error, undefined);
  assert.equal(movie, 2); // Failures are deliberately not cached.
  assert.equal(tv, baseline ? 2 : 1);
});

test('terminal player HTML is fetched once without losing streams or subtitles', async () => {
  let requests = 0;
  axios.get = async () => {
    requests++;
    await delay();
    // Relative setup source is parsed by extractStreams, not URL navigation.
    return { data: '<script>sources: [{"file": "/video.mp4", label: "720p"}]; tracks: [{file: "/en.vtt", label: "English"}];</script>' };
  };
  const t = performance.now();
  const result = await provider.fetchSources('https://player.example/fixture');
  console.log(JSON.stringify({ case: 'terminal-player', baseline, requests, ms: Math.round(performance.now() - t) }));
  assert.equal(requests, baseline ? 2 : 1);
  assert.equal(result.sources[0].url, 'https://player.example/video.mp4');
  assert.equal(result.subtitles[0].url, 'https://player.example/en.vtt');
});

test('concurrent watch shares extraction and verification; failures remain retryable', async () => {
  const original = provider.fetchSourcesUncached;
  let extractions = 0;
  let probes = 0;
  const source = { url: 'https://hubstream.art/shared/master.m3u8', isM3U8: true };
  provider.fetchSourcesUncached = async () => {
    extractions++;
    await delay();
    return { sources: [source], subtitles: [{ url: 'https://example.com/en.vtt', lang: 'English' }] };
  };
  axios.get = async () => { probes++; await delay(); throw new Error('timeout'); };
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => provider.fetchSources('shared-watch')));
    results.forEach(result => {
      assert.deepEqual(result.sources, [source]);
      assert.equal(result.subtitles.length, 1);
    });
    console.log(JSON.stringify({ case: 'concurrent-watch', baseline, extractions, probes }));
    assert.equal(extractions, baseline ? 4 : 1);
    assert.equal(probes, baseline ? 4 : 1);
    await provider.fetchSources('shared-watch');
    assert.equal(extractions, baseline ? 4 : 1);
    provider.fetchSourcesUncached = async () => { extractions++; await delay(); return { error: 'offline' }; };
    const before = extractions;
    await Promise.all([provider.fetchSources('retry-watch'), provider.fetchSources('retry-watch')]);
    await provider.fetchSources('retry-watch');
    assert.equal(extractions - before, baseline ? 3 : 2);
    const distinct = extractions;
    await Promise.all([
      provider.fetchSources('separate', 'one', false, { mediaId: 'a' }),
      provider.fetchSources('separate', 'two', false, { mediaId: 'a' }),
      provider.fetchSources('separate', 'one', false, { mediaId: 'b' }),
    ]);
    assert.equal(extractions - distinct, 3);
  } finally {
    provider.fetchSourcesUncached = original;
  }
});
