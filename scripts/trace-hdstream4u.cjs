// Cold provider timing without restarting the API or printing signed URLs/cookies.
require('ts-node/register/transpile-only');
const axios = require('axios');
const { chromium } = require('playwright');
const started = Date.now();
const log = (stage, ms, extra = {}) => console.log(JSON.stringify({ stage, ms, elapsed: Date.now() - started, ...extra }));
const get = axios.get.bind(axios);
axios.get = async (url, ...args) => {
  const t = Date.now();
  try { return await get(url, ...args); }
  finally { log('http', Date.now() - t, { host: new URL(url).hostname }); }
};
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async (...args) => {
      const page = await newPage(...args);
      for (const method of ['goto', 'evaluate', 'waitForTimeout']) {
        const original = page[method].bind(page);
        page[method] = async (...args) => {
          const t = Date.now();
          try { return await original(...args); }
          finally {
            const prefetch = method === 'evaluate' && /credentials: ['"]include/.test(String(args[0]));
            if (prefetch || Date.now() - t > 500) log(prefetch ? 'manifest-prefetch' : method, Date.now() - t);
          }
        };
      }
      return page;
    };
    return context;
  };
  return browser;
};
// Third-party error objects can include request credentials.
console.error = () => log('extractor-error', 0);
(async () => {
  const { HdStream4uProvider } = require('../src/providers/custom/hdstream4uProvider');
  const [query, id, type = 'movie'] = process.argv.slice(2);
  if (query && id) {
    for (const state of ['cold', 'warm']) {
      let t = Date.now();
      const search = await HdStream4uProvider.search(query);
      log(`search-${state}`, Date.now() - t, { query, results: search.results?.length });
      t = Date.now();
      const info = await HdStream4uProvider.fetchMediaInfo(id, type);
      log(`info-${state}`, Date.now() - t, { id, episodes: info.episodes?.length, servers: info.servers?.length, error: !!info.error });
      if (info.error) continue;
      t = Date.now();
      const watchId = type === 'tv' ? info.episodes?.[0]?.episodeId : id;
      const result = await HdStream4uProvider.fetchSources(watchId, 'hdstream4u', false, { mediaId: id });
      log(`watch-${state}`, Date.now() - t, { sources: result.sources?.length || 0, subtitles: result.subtitles?.length || 0, error: !!result.error });
    }
    process.exit(0);
  }
  const t = Date.now();
  const result = await HdStream4uProvider.fetchSources('https://hubstream.art/#ucp5r8');
  log('watch', Date.now() - t, {
    sources: result.sources?.map(s => ({ host: new URL(s.url).hostname, quality: s.quality, hls: s.isM3U8 })),
    subtitles: result.subtitles?.length,
    error: !!result.error,
  });
  process.exit(result.sources?.length ? 0 : 1);
})().catch(() => { log('failed', 0); process.exit(1); });
