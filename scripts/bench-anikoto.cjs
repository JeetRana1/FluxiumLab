// Direct extraction bypasses the route's watch cache; never requests media bytes.
const { fetchCurrentAniKotoSources } = require('../dist/providers/custom/anikotoProvider');
const upstreamFetch = globalThis.fetch;
let requests = [];
globalThis.fetch = async (url, options) => {
  const start = performance.now();
  try { return await upstreamFetch(url, options); }
  finally { requests.push({ path: new URL(url).pathname, ms: Math.round(performance.now() - start) }); }
};
(async () => {
  for (const episode of [1, 2]) {
    requests = [];
    const start = performance.now();
    try {
      const result = await fetchCurrentAniKotoSources(`spy-x-family-6zlbz$episode$${episode}`);
      console.log(JSON.stringify({ episode, ms: Math.round(performance.now() - start),
        sub: result?.sub?.sources?.length || 0, dub: result?.dub?.sources?.length || 0, requests }));
    } catch (error) { console.log(JSON.stringify({ episode, ms: Math.round(performance.now() - start), error: error.message, requests })); process.exitCode = 1; }
  }
})();
