const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
let mode = 'ready', closed = 0, created = 0;
require('playwright').chromium.launch = async () => ({
  isConnected: () => true,
  newContext: async () => {
    created++;
    const handlers = {};
    return {
      close: async () => { closed++; }, cookies: async () => [],
      newPage: async () => ({
        route: async () => {}, addInitScript: async () => {},
        on: (event, fn) => { handlers[event] = fn; },
        goto: async () => {
          if (mode === 'failed') throw new Error('navigation failed');
          const url = `https://hubstream.art/${mode}/master.m3u8`;
          handlers.request({url: () => url});
           await handlers.response({url: () => url, headers: () => ({'content-type':'application/vnd.apple.mpegurl'}), text: async () => '#EXTM3U\n#EXT-X-ENDLIST'});
           if (mode === 'pending-dom') return new Promise(() => {});
          if (mode === 'timeout') { const e = new Error('slow DOMContentLoaded'); e.name = 'TimeoutError'; throw e; }
        },
        waitForTimeout: async () => { throw new Error('ready source must not poll'); },
        evaluate: async fn => String(fn).includes('__playbackPayloads')
          ? [JSON.stringify({tracks:[{file:'https://hubstream.art/english.vtt',label:'English'}]})] : [],
      }),
    };
  },
});
const {extractPlaybackWithPlaywright, getCachedHlsManifest} = require('../src/utils/browserRuntimeExtractor');
test('HubStream returns ready manifests without fixed activation delay and retains sources after DOM timeout', async () => {
  for (mode of ['ready','timeout','pending-dom']) {
    const started = Date.now();
    const result = await extractPlaybackWithPlaywright(`https://hubstream.art/#${mode}`);
    assert.ok(Date.now()-started < 700, 'ready manifest should bypass 800ms wait');
    assert.equal(result.sources.length,1);
    assert.equal(result.subtitles[0].lang,'English');
    assert.ok(getCachedHlsManifest(result.sources[0].url));
    assert.equal(closed,created);
  }
});
test('failed navigations close their contexts and release slots for subsequent calls', async () => {
  mode = 'failed';
  const original = console.error;
  console.error = () => {};
  try {
    for (let i=0;i<3;i++) {
      const result = await extractPlaybackWithPlaywright('https://hubstream.art/#failed');
      assert.equal(result.sources.length,0);
      assert.equal(closed,created);
    }
  } finally { console.error = original; }
  mode = 'ready';
  assert.equal((await extractPlaybackWithPlaywright('https://hubstream.art/#ready')).sources.length,1);
  assert.equal(closed,created);
});
