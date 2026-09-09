const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const Fastify = require('fastify');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main.ts'), 'utf8');

test('HLS missing responses bypass retries, preserve status, release bodies and are not cached', async () => {
  let status = 404, calls = 0, destroyed = 0, proxyLookups = 0;
  let target = 'https://ncdn.imgnex.top/seg-new-f2-00000.png';
  const headers = [];
  const context = {
    URL, Buffer, AbortController, DOMException, console: { error() {} },
    hubstreamNodeVariants: url => [url], getProxyCandidatesSync: () => { proxyLookups++; return ['proxy-a', 'proxy-b']; },
    toAxiosProxyOptions: () => ({}), withUpstreamConcurrency: fn => fn(),
    isAbortError: () => false, sleep: async () => {},
    axios: { get: async (url, config) => {
      calls++;
      headers.push(config.headers);
      if (status === 0) throw new Error('timeout');
      return { status, headers: {}, data: { destroy() { destroyed++; } } };
    } },
  };
  const fetchStart = source.indexOf('  const fetchHlsResource = async (');
  const fetchEnd = source.indexOf('  // HLS Proxy to work around', fetchStart);
  vm.createContext(context);
  vm.runInContext(transformSync(source.slice(fetchStart, fetchEnd) + '\nglobalThis.fetchResource = fetchHlsResource;', { loader: 'ts' }).code, context);
  const catchStart = source.indexOf('      const upstreamStatus = Number(error?.statusCode');
  const catchEnd = source.indexOf('\n    }', catchStart);
  vm.runInContext(transformSync(`globalThis.sendError = (error, reply) => { ${source.slice(catchStart, catchEnd)} };`, { loader: 'ts' }).code, context);
  const app = Fastify();
  app.get('/', async (request, reply) => {
    try {
      await context.fetchResource(target, false, '', 'https://anikoto.cz/', 'private-cookie');
      return 'ok';
    } catch (error) { return context.sendError(error, reply); }
  });
  try {
    for (const code of [404, 410, 404]) {
      status = code;
      const before = calls;
      const response = await app.inject('/');
      assert.equal(response.statusCode, code);
      assert.equal(calls - before, 1);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), { error: 'Proxy failed', upstreamStatus: code });
    }
    assert.equal(destroyed, 3);
    assert.equal(proxyLookups, 0, 'imgnex uses the measured fast direct path');
    assert.ok(headers.every(h => h.Referer === 'https://megaplay.buzz/' && h.Cookie === 'private-cookie'));
    target = 'https://other.example/segment.ts';
    for (const code of [404, 410]) {
      status = code;
      const before = calls;
      assert.equal((await app.inject('/')).statusCode, code);
      assert.equal(calls - before, 1, 'missing does not try other configured proxies');
    }
    for (const code of [403, 429, 503, 0]) {
      status = code;
      const before = calls;
      const response = await app.inject('/');
      assert.equal(response.statusCode, code || 502);
      assert.ok(calls - before > 1, 'transient/authorization failures retain proxy fallback');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(!response.body.includes('private-cookie'));
    }
  } finally { await app.close(); }
});
