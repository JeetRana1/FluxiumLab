const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

test('season handler fetches one season and preserves raw episode identity and votes', async () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/routes/meta/tmdb.ts'), 'utf8');
  const start = source.indexOf('  const getRequestedSeason =');
  const end = source.indexOf("  fastify.get('/info'", start);
  const calls = [];
  const episodes = [77, 0, null].map((vote_count, i) => ({ id: i + 1, show_id: 125988, season_number: 0, episode_number: i + 1, vote_average: i ? null : 6.987, vote_count }));
  const c = vm.createContext({ tmdbApi: 'test-key', axios: { get: async (...args) => { calls.push(args); return { data: { season_number: 0, episodes } }; } } });
  vm.runInContext(ts.transpile(source.slice(start, end) + '\nglobalThis.handler = getRequestedSeason;', { target: ts.ScriptTarget.ES2020 }), c);
  const reply = { code: 200, status(code) { this.code = code; return this; }, send(data) { this.data = data; } };
  assert.equal(await c.handler({ query: { type: 'tv', season: '0', details: 'true' } }, reply, '125988'), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/tv\/125988\/season\/0$/);
  assert.equal(reply.data.tmdb_id, '125988');
  assert.deepEqual(reply.data.episodes, episodes);
  for (const season of ['-1', '1.5', '', 'NaN']) {
    await c.handler({ query: { type: 'tv', season, details: 'true' } }, reply, '125988');
    assert.equal(reply.code, 400);
  }
  assert.equal(calls.length, 1);
  assert.equal(await c.handler({ query: { type: 'tv', season: '1', details: 'true', provider: 'animesalt' } }, reply, '7'), false);
  assert.equal(await c.handler({ query: { type: 'movie', season: '1', details: 'true' } }, reply, '7'), false);
  c.axios.get = async () => { throw new Error('upstream unavailable'); };
  assert.equal(await c.handler({ query: { type: 'tv', season: '3', details: 'true' } }, reply, '125988'), true);
  assert.equal(reply.code, 502);
  assert.equal(reply.data.episodes, undefined);
});
