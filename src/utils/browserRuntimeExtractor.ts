const DIRECT_MEDIA_REGEX =
  /(https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4|mkv|mpd)(?:\?[^\s"'<>]*)?)/gi;

const HLS_PROXY_REGEX =
  /(https?:\/\/[^\s"'<>]+?\/m3u8-proxy\?[^\s"'<>]+|https?:\/\/[^\s"'<>]+?\/getm3u8\/[^\s"'<>]+)/gi;
const SUBTITLE_REGEX = /(https?:\/\/[^\s"'<>]+?\.(?:vtt|srt|ass)(?:\?[^\s"'<>]*)?)/gi;
const subtitleTextCache = new Map<string, { value: string; expiresAt: number }>();
const SUBTITLE_TEXT_CACHE_MS = 30 * 60 * 1000;

// HLS manifest cache populated during Playwright extraction so the HLS proxy
// can serve the manifest without re-fetching from upstream (avoids short-lived
// token expiration on hubstream.art and similar hosts).
const hlsManifestCache = new Map<string, { body: string; contentType: string; expiresAt: number }>();
const HLS_MANIFEST_CACHE_MS = 2 * 60 * 1000; // 2 minutes

export const getCachedHlsManifest = (url: string): { body: string; contentType: string } | undefined => {
  const entry = hlsManifestCache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    hlsManifestCache.delete(url);
    return undefined;
  }
  return { body: entry.body, contentType: entry.contentType };
};

export const setCachedHlsManifest = (url: string, body: string, contentType: string): void => {
  if (!url || !body) return;
  hlsManifestCache.set(url, {
    body,
    contentType,
    expiresAt: Date.now() + HLS_MANIFEST_CACHE_MS,
  });
};

const PLAYWRIGHT_DEBUG = false;

// --- Shared Playwright browser ----------------------------------------------
// Launching Chromium is expensive (~2-4s cold). Provider extraction (e.g.
// hdstream4u) can fire several Playwright navigations in one request; a fresh
// browser per call is what turned a fast extraction into a 30s+ wait locally.
// Reuse a single browser instance, serializing work through a semaphore so the
// concurrent extractions don't overwhelm a shared Chromium process.
let sharedBrowser: any = undefined;
let sharedBrowserConnecting: Promise<any> | null = null;
let sharedBrowserLastUsed = 0;

const SHARED_BROWSER_IDLE_MS = 60 * 1000;

const getSharedBrowser = async (): Promise<any> => {
  if (sharedBrowser && sharedBrowser.isConnected && !sharedBrowser.isConnected()) {
    try { await sharedBrowser.close().catch(() => {}); } catch { /* ignore */ }
    sharedBrowser = undefined;
  }
  if (sharedBrowser) {
    sharedBrowserLastUsed = Date.now();
    return sharedBrowser;
  }
  if (!sharedBrowserConnecting) {
    sharedBrowserConnecting = (async () => {
      let chromium: any;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        return null;
      }
      const playwrightProxy = getPlaywrightProxy();
      const browser = await chromium.launch({
        headless: true,
        ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      sharedBrowser = browser;
      sharedBrowserLastUsed = Date.now();
      return browser;
    })().finally(() => {
      sharedBrowserConnecting = null;
    });
  }
  sharedBrowserLastUsed = Date.now();
  return sharedBrowserConnecting;
};

// Semaphore so concurrent extraction calls reuse the shared browser instead of
// stepping on each other's pages.
let browserSlots = 0;
const BROWSER_MAX_CONCURRENCY = 2;
const browserWaiters: Array<() => void> = [];

const acquireBrowserSlot = async (): Promise<void> => {
  if (browserSlots < BROWSER_MAX_CONCURRENCY) {
    browserSlots += 1;
    return;
  }
  return new Promise<void>((resolve) => browserWaiters.push(resolve));
};

const releaseBrowserSlot = (): void => {
  browserSlots = Math.max(0, browserSlots - 1);
  const next = browserWaiters.shift();
  if (next) {
    browserSlots += 1;
    next();
  }
};

// Public helpers so providers can reuse the same shared Chromium instance
// instead of launching a fresh browser per extraction.
export const acquireSharedBrowser = async (): Promise<any> => {
  const browser = await getSharedBrowser();
  if (browser) await acquireBrowserSlot();
  return browser;
};

export const releaseSharedBrowser = (): void => {
  releaseBrowserSlot();
};

// Reclaim the shared browser after a period of inactivity to avoid leaking it.
setInterval(() => {
  if (sharedBrowser && Date.now() - sharedBrowserLastUsed > SHARED_BROWSER_IDLE_MS && browserSlots === 0) {
    try { sharedBrowser.close().catch(() => {}); } catch { /* ignore */ }
    sharedBrowser = undefined;
  }
}, 30 * 1000).unref?.();

const isDirectMediaUrl = (value: string): boolean => {
  const normalized = String(value || '');
  if (!isUsableMediaUrl(normalized)) return false;
  if (/\.(m3u8|mp4|mkv|mpd)(\?|$)/i.test(normalized)) return true;
  if (/\/m3u8-proxy\?/i.test(normalized)) return true;
  if (/m3u8-proxy/i.test(normalized) && /[?&]url=/i.test(normalized)) return true;
  if (/\/getm3u8\//i.test(normalized)) return true;
  return false;
};

const isUsableMediaUrl = (value: string): boolean => {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (/^blob:/i.test(normalized)) return false;

  try {
    const parsed = new URL(
      normalized.startsWith('//') ? `https:${normalized}` : normalized,
    );
    const host = parsed.hostname.toLowerCase();
    if (host === 'cdn.plyr.io' && /\/blank\.mp4$/i.test(parsed.pathname)) return false;
    if (host === 'example.com' || host.endsWith('.example.com')) return false;
    if (host === 'voorbeeld.com' || host.endsWith('.voorbeeld.com')) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (host.includes('placeholder') || host.includes('dummy')) return false;
    if (
      /\/video\.mp4$/i.test(parsed.pathname) &&
      /voorbeeld|sample|placeholder|dummy/i.test(normalized)
    )
      return false;
  } catch {
    return false;
  }

  return true;
};

const dropDuplicateHlsVariants = (urls: string[]): string[] => {
  const hasMasterForBase = new Set(
    urls
      .filter((url) => /\/master\.m3u8(?:\?|$)/i.test(url))
      .map((url) => url.replace(/\/master\.m3u8(?:\?.*)?$/i, '')),
  );

  return urls.filter((url) => {
    const base = url.replace(/\/index-[^/]+\.m3u8(?:\?.*)?$/i, '');
    return !hasMasterForBase.has(base) || /\/master\.m3u8(?:\?|$)/i.test(url);
  });
};

const normalizeUrl = (value?: string): string | undefined => {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
};

const absoluteUrl = (value?: string, baseUrl?: string): string | undefined => {
  const normalized = normalizeUrl(value);
  if (!normalized) return undefined;
  try {
    return new URL(normalized, baseUrl || normalized).toString();
  } catch {
    return normalized;
  }
};

const inferSubtitleLang = (value?: string): string => {
  const raw = String(value || '').toLowerCase();
  if (!raw) return 'Unknown';
  if (/(^|[^a-z])(en|eng|english)([^a-z]|$)/i.test(raw)) return 'English';
  if (/(^|[^a-z])(ja|jpn|japanese)([^a-z]|$)/i.test(raw)) return 'Japanese';
  if (/(^|[^a-z])(hi|hin|hindi)([^a-z]|$)/i.test(raw)) return 'Hindi';
  if (/(^|[^a-z])(ta|tam|tamil)([^a-z]|$)/i.test(raw)) return 'Tamil';
  if (/(^|[^a-z])(te|tel|telugu)([^a-z]|$)/i.test(raw)) return 'Telugu';
  return 'Unknown';
};

const normalizeSubtitleLang = (value?: string, fallbackHint?: string): string => {
  const raw = String(value || '').trim();
  const normalized = inferSubtitleLang(raw);
  if (normalized !== 'Unknown') return normalized;
  const fallback = inferSubtitleLang(fallbackHint);
  if (fallback !== 'Unknown') return fallback;
  return raw || 'Unknown';
};

const getPlaywrightProxy = ():
  | { server: string; username?: string; password?: string }
  | undefined => {
  const raw = String(
    process.env.PLAYWRIGHT_PROXY || process.env.OUTBOUND_PROXY || process.env.PROXY || '',
  )
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)[0];
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw);
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    parsed.username = '';
    parsed.password = '';
    return {
      server: parsed.toString(),
      ...(username ? { username, password } : {}),
    };
  } catch {
    return { server: raw };
  }
};

const getSubtitleCacheKeys = (url: string): string[] => {
  const normalized = normalizeUrl(url);
  if (!normalized) return [];
  const keys = new Set<string>([normalized]);
  try {
    const parsed = new URL(normalized);
    keys.add(`${parsed.origin}${parsed.pathname}`);
  } catch {
    // ignore
  }
  return [...keys];
};

export const getCachedSubtitleText = (url: string): string | undefined => {
  for (const key of getSubtitleCacheKeys(url)) {
    const cached = subtitleTextCache.get(key);
    if (!cached) continue;
    if (cached.expiresAt <= Date.now()) {
      subtitleTextCache.delete(key);
      continue;
    }
    return cached.value;
  }
  return undefined;
};

const setCachedSubtitleText = (url: string, value: string) => {
  if (!value || !getSubtitleCacheKeys(url).length) return;
  for (const key of getSubtitleCacheKeys(url)) {
    subtitleTextCache.set(key, {
      value,
      expiresAt: Date.now() + SUBTITLE_TEXT_CACHE_MS,
    });
  }
};

const parseUrlsFromText = (text: string): string[] => {
  const found = new Set<string>();
  // Decrypted payloads (e.g. hubstream.art) are JSON text with backslash-escaped
  // slashes ("https:\/\/host\/..."). Unescape before regex matching so URL
  // patterns can see the slashes.
  const input = String(text || '').replace(/\\\//g, '/');
  let match: RegExpExecArray | null;
  DIRECT_MEDIA_REGEX.lastIndex = 0;
  while ((match = DIRECT_MEDIA_REGEX.exec(input)) !== null) {
    const url = normalizeUrl(match[1]);
    if (url && isDirectMediaUrl(url)) found.add(url);
  }

  HLS_PROXY_REGEX.lastIndex = 0;
  while ((match = HLS_PROXY_REGEX.exec(input)) !== null) {
    const url = normalizeUrl(match[1]);
    if (url && isDirectMediaUrl(url)) found.add(url);
  }

  return [...found];
};

const extractSubtitleInfoUrls = (value: string): string[] => {
  const found = new Set<string>();
  const addCandidate = (candidate?: string | null) => {
    const decoded = normalizeUrl(candidate ? decodeURIComponent(String(candidate)) : '');
    if (decoded && /^https?:\/\//i.test(decoded)) found.add(decoded);
  };

  try {
    const parsed = new URL(value);
    addCandidate(parsed.searchParams.get('sub.info'));
    addCandidate(parsed.searchParams.get('sub'));
    addCandidate(parsed.searchParams.get('subtitles'));
  } catch {
    // Fall through to regex parsing.
  }

  const regex = /[?&](?:sub\.info|subtitles?|tracks?)=([^&"'<>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) addCandidate(match[1]);

  return [...found];
};

const parseSubtitlesFromText = (
  text: string,
): Array<{ url: string; lang: string; kind?: string; default?: boolean }> => {
  const found = new Map<
    string,
    { url: string; lang: string; kind?: string; default?: boolean }
  >();

  const add = (url?: string, lang?: string, kind?: string, isDefault?: boolean) => {
    const normalized = normalizeUrl(url);
    if (!normalized || !isUsableMediaUrl(normalized)) return;
    const baseKey = normalized.replace(/#.*$/, '');
    if (!/\.(vtt|srt|ass)(\?|$)/i.test(baseKey)) return;
    if (/\/thumbnail(?:s)?\.vtt(?:\?|$)/i.test(baseKey)) return;
    const resolvedLang = normalizeSubtitleLang(lang, baseKey);
    const existing = found.get(baseKey);
    if (existing && resolvedLang === 'Unknown') return;
    found.set(baseKey, {
      url: baseKey,
      lang: resolvedLang,
      kind,
      default: Boolean(isDefault),
    });
  };

  try {
    const parsed = JSON.parse(text);
    const visit = (value: any, depth = 0) => {
      if (!value || depth > 4) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === 'string') {
        add(value);
        return;
      }
      if (typeof value !== 'object') return;

      const url = value.file || value.url || value.src || value.link;
      const kind = String(value.kind || value.type || '').toLowerCase();
      if (
        url &&
        (!kind || ['caption', 'captions', 'subtitle', 'subtitles', 'sub'].includes(kind))
      ) {
        add(
          url,
          value.label || value.lang || value.language || value.name || value.title,
          value.kind,
          value.default,
        );
      }

      visit(value.tracks, depth + 1);
      visit(value.subtitles, depth + 1);
      visit(value.captions, depth + 1);
      visit(value.cc, depth + 1);
      visit(value.closedCaptions, depth + 1);
      visit(value.closed_captions, depth + 1);
      visit(value.data, depth + 1);
      visit(value.result, depth + 1);
    };
    visit(parsed);
  } catch {
    // Fall back to regex parsing below.
  }

  let match: RegExpExecArray | null;
  SUBTITLE_REGEX.lastIndex = 0;
  while ((match = SUBTITLE_REGEX.exec(text)) !== null) {
    add(match[1]);
  }

  return [...found.values()];
};

const parseSubtitlesFromValue = (
  value: any,
  baseUrl: string,
): Array<{ url: string; lang: string; kind?: string; default?: boolean }> => {
  const found = new Map<
    string,
    { url: string; lang: string; kind?: string; default?: boolean }
  >();

  const add = (url?: string, lang?: string, kind?: string, isDefault?: boolean) => {
    const absolute = absoluteUrl(url, baseUrl);
    if (!absolute || !isUsableMediaUrl(absolute)) return;
    const baseKey = absolute.replace(/#.*$/, '');
    if (!/\.(vtt|srt|ass)(\?|$)/i.test(baseKey)) return;
    if (/\/thumbnail(?:s)?\.vtt(?:\?|$)/i.test(baseKey)) return;
    const resolvedLang = normalizeSubtitleLang(lang, baseKey);
    const existing = found.get(baseKey);
    if (existing && resolvedLang === 'Unknown') return;
    found.set(baseKey, {
      url: baseKey,
      lang: resolvedLang,
      kind,
      default: Boolean(isDefault),
    });
  };

  const visit = (node: any, depth = 0, parentKey = '') => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, parentKey);
      return;
    }
    if (typeof node === 'string') {
      if (/subtitle|caption|track|cc/i.test(parentKey)) add(node, parentKey);
      return;
    }
    if (typeof node !== 'object') return;

    const url = node.file || node.url || node.src || node.link;
    const kind = String(node.kind || node.type || '').toLowerCase();
    if (
      url &&
      (!kind || ['caption', 'captions', 'subtitle', 'subtitles', 'sub'].includes(kind))
    ) {
      add(
        url,
        node.label || node.lang || node.language || node.name || node.title,
        node.kind,
        node.default,
      );
    }

    const nestedKeys = [
      'tracks',
      'track',
      'subtitle',
      'subtitles',
      'captions',
      'caption',
      'cc',
      'closedCaptions',
      'closed_captions',
      'data',
      'result',
    ];
    for (const key of nestedKeys) visit(node[key], depth + 1, key);

    if (/subtitle|caption|track|cc/i.test(parentKey)) {
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === 'string') add(child, key);
      }
    }
  };

  visit(value);
  return [...found.values()];
};

export const extractPlaybackWithPlaywright = async (
  embedUrl: string,
  referer?: string,
  timeoutMs = 12000,
  options: { preferredMirror?: string } = {},
): Promise<{
  sources: Array<{ url: string; quality: string; isM3U8: boolean; isEmbed: false }>;
  subtitles: Array<{ url: string; lang: string; kind?: string; default?: boolean }>;
  cookieHeader?: string;
}> => {
  const normalizedEmbed = normalizeUrl(embedUrl);
  if (!normalizedEmbed) return { sources: [], subtitles: [] };

  let chromium: any;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { sources: [], subtitles: [] };
  }

  const discovered = new Map<string, string>();
  const subtitles = new Map<
    string,
    { url: string; lang: string; kind?: string; default?: boolean }
  >();
  const subtitleInfoUrls = new Set<string>(extractSubtitleInfoUrls(normalizedEmbed));
  let cookieHeader = '';
  let browser: any;
  const timeout = Math.max(4000, timeoutMs);
  const isVidkingEmbed = /vidking/i.test(normalizedEmbed);
  const isVideasyEmbed = /videasy/i.test(normalizedEmbed);
  const isTpeadEmbed = /tpead\.net\/(?:v|e)\//i.test(normalizedEmbed);
  const isHubstreamEmbed = /hubstream\.(?:art|pw|cc|ink|foo|boo)|watchhd\.upns\.live/i.test(
    normalizedEmbed,
  );
  const wantsSubtitles = /[?&]sub\.info=/i.test(normalizedEmbed);
  const preferredMirror = String(options.preferredMirror || '').trim();
  let activeMirrorLabel = '';

  // hubstream.art rotates between config variants (ads-only vs real payload) and
  // sometimes delays serving the real payload. From datacenter IPs it is often
  // blocked/slow (Cloudflare bot detection), so a full multi-attempt budget can
  // burn ~20s before the parallel hdstream4u/morencius path wins. Keep a single,
  // short attempt so a blocked hubstream fails fast and the reliable hdstream4u
  // path returns sources quickly.
  const MAX_HUBSTREAM_ATTEMPTS = isHubstreamEmbed ? 1 : 1;
  const attemptTimeout = isHubstreamEmbed
    ? Math.min(4000, Math.max(2500, Math.floor(timeout / 5)))
    : Math.max(4500, Math.floor(timeout / MAX_HUBSTREAM_ATTEMPTS));

  const addDiscovered = (url?: string, label?: string) => {
    const normalized = normalizeUrl(url);
    if (!normalized || !isDirectMediaUrl(normalized)) return;
    const cleanLabel = String(label || activeMirrorLabel || '').trim();
    if (!discovered.has(normalized) || cleanLabel) discovered.set(normalized, cleanLabel);
  };

  const addSubtitles = (
    items: Array<{ url: string; lang: string; kind?: string; default?: boolean }>,
  ) => {
    for (const item of items) {
      const baseKey = String(item.url || '').replace(/#.*$/, '');
      if (!baseKey || !/\.(vtt|srt|ass)(\?|$)/i.test(baseKey)) continue;
      if (/\/thumbnail(?:s)?\.vtt/i.test(baseKey)) continue;
      const existing = subtitles.get(baseKey);
      if (existing && (existing.lang !== 'Unknown' || item.lang === 'Unknown')) continue;
      subtitles.set(baseKey, {
        ...item,
        url: baseKey,
        lang: normalizeSubtitleLang(item.lang, baseKey),
      });
    }
  };

  const addSubtitleUrl = (url?: string, lang = 'Unknown') => {
    const normalized = absoluteUrl(url, normalizedEmbed);
    if (!normalized || !isUsableMediaUrl(normalized)) return;
    const baseKey = normalized.replace(/#.*$/, '');
    if (!/\.(vtt|srt|ass)(\?|$)/i.test(baseKey)) return;
    if (/\/thumbnail(?:s)?\.vtt(?:\?|$)/i.test(baseKey)) return;
    subtitles.set(baseKey, {
      url: baseKey,
      lang: normalizeSubtitleLang(lang, baseKey),
    });
  };

  const collectSubtitleInfoUrls = (value?: string) => {
    for (const url of extractSubtitleInfoUrls(String(value || '')))
      subtitleInfoUrls.add(url);
  };

  for (let attempt = 0; attempt < MAX_HUBSTREAM_ATTEMPTS; attempt++) {
  let context: any;
  let ownsSlot = false;
  let notifyManifestReady: () => void = () => {};
  const manifestReady = new Promise<void>((resolve) => { notifyManifestReady = resolve; });
  try {
    browser = await getSharedBrowser();
    if (!browser) {
      return { sources: [], subtitles: [] };
    }
    await acquireBrowserSlot();
    ownsSlot = true;
    context = await browser.newContext({
      extraHTTPHeaders: referer ? { Referer: referer } : undefined,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.route('**/*', (route: any) => {
      const type = route.request().resourceType?.() || '';
      const url = route.request().url() || '';
      if (['image', 'font', 'stylesheet'].includes(type) || url.includes('google-analytics') || url.includes('googletagmanager') || url.includes('doubleclick')) {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      try {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands: [
              { brand: 'Chromium', version: '131' },
              { brand: 'Google Chrome', version: '131' },
              { brand: 'Not/A)Brand', version: '99' },
            ],
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: async () => ({
              brands: [
                { brand: 'Chromium', version: '131' },
                { brand: 'Google Chrome', version: '131' },
                { brand: 'Not/A)Brand', version: '99' },
              ],
              mobile: false,
              platform: 'Windows',
              architecture: 'x86',
              bitness: '64',
              model: '',
              platformVersion: '10.0.0',
              uaFullVersion: '131.0.0.0',
            }),
          }),
        });
      } catch {
        // Some browser builds expose userAgentData as non-configurable.
      }
      (window as any).chrome = { runtime: {} };

      const OriginalTextDecoder = window.TextDecoder;
      const originalDecode = OriginalTextDecoder.prototype.decode;
      (window as any).__playbackPayloads = [];
      OriginalTextDecoder.prototype.decode = function (...args) {
        const out = originalDecode.apply(this, args as any);
        try {
          if (
            typeof out === 'string' &&
            (out.includes('.m3u8') ||
              out.includes('master.m3u8') ||
              out.includes('hlsVideo') ||
              out.includes('cfNative') ||
              out.includes('swarmId') ||
              out.includes('torrentTrackers') ||
              out.includes('subtitle') ||
              out.includes('tracks'))
          ) {
            const store = (window as any).__playbackPayloads;
            if (Array.isArray(store) && store.length < 40) store.push(out);
          }
        } catch {
          // ignore hook failures
        }
        return out;
      };
    });

    if (PLAYWRIGHT_DEBUG) {
      page.on('console', (message: any) => {
        const text = String(message.text?.() || '');
        if (text)
          console.log(
            `[Playwright console:${message.type?.() || 'log'}] ${normalizedEmbed} ${text.slice(0, 500)}`,
          );
      });
      page.on('requestfailed', (request: any) => {
        const failure = request.failure?.();
        console.log(
          `[Playwright request failed] ${request.url()} ${failure?.errorText || ''}`.trim(),
        );
      });
      page.on('response', (response: any) => {
        const status = Number(response.status?.() || 0);
        if (status >= 400)
          console.log(`[Playwright response ${status}] ${response.url()}`);
      });
    }

    page.on('request', (request: any) => {
      const url = request.url();
      addDiscovered(url);
      addSubtitleUrl(url);
      collectSubtitleInfoUrls(url);
    });

    page.on('response', async (response: any) => {
      try {
        const u = normalizeUrl(response.url());
        addDiscovered(u);
        addSubtitleUrl(u);
        collectSubtitleInfoUrls(u);

        const headers = response.headers() || {};
        const contentType = String(headers['content-type'] || '').toLowerCase();
        const shouldReadBody =
          contentType.includes('json') ||
          contentType.includes('javascript') ||
          contentType.includes('text') ||
          /\.(m3u8|vtt|srt|ass)(?:$|\?)/i.test(String(u || ''));
        if (!shouldReadBody) return;
        const body = await response.text().catch(() => '');
        for (const parsed of parseUrlsFromText(String(body || '')))
          addDiscovered(parsed);
        addSubtitles(parseSubtitlesFromText(String(body || '')));
        try {
          addSubtitles(parseSubtitlesFromValue(JSON.parse(String(body || '')), u || normalizedEmbed));
        } catch {
          // Non-JSON text responses are handled by regex fallback above.
        }
        if (u && /\.(vtt|srt|ass)(\?|$)/i.test(u) && String(body || '').trim()) {
          setCachedSubtitleText(u, String(body || ''));
        }
        // Capture HLS manifest bodies — they expire quickly on some hosts.
        if (u && /\.m3u8(?:$|\?)/i.test(u) && String(body || '').trim().startsWith('#EXTM3U')) {
          hlsManifestCache.set(u, {
            body: String(body || ''),
            contentType,
            expiresAt: Date.now() + HLS_MANIFEST_CACHE_MS,
          });
          notifyManifestReady();
        }
      } catch {
        // Ignore individual response parse failures.
      }
    });

    try {
      const navigation = page.goto(normalizedEmbed, { waitUntil: 'domcontentloaded', timeout: attemptTimeout });
      // A valid manifest is stronger readiness evidence than DOMContentLoaded.
      // Ad/peripheral scripts can hold that event after the player is ready.
      await (isHubstreamEmbed ? Promise.race([navigation, manifestReady]) : navigation);
    } catch (error: any) {
      // A slow peripheral script can hold DOMContentLoaded after HubStream's
      // player has already started. Keep inspecting that document on timeout.
      if (!isHubstreamEmbed || error?.name !== 'TimeoutError') throw error;
    }

    // Trigger player/network activity in common embed pages.
    const triggerPlayerActivity = async () =>
      page
        .evaluate(() => {
          const trigger = (el: HTMLElement | null | undefined) => {
            if (!el) return;
            try {
              el.scrollIntoView({ block: 'center', inline: 'center' });
            } catch {
              // ignore
            }
            try {
              const clickHandler = (el as any).onclick;
              if (typeof clickHandler === 'function') {
                clickHandler.call(
                  el,
                  new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                  }),
                );
              }
            } catch {
              // ignore
            }
            try {
              el.dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                }),
              );
            } catch {
              // ignore
            }
            try {
              el.click();
            } catch {
              // ignore
            }
          };

          trigger(document.querySelector('#player-button-container') as HTMLElement | null);
          trigger(document.querySelector('#player-button') as HTMLElement | null);
          trigger(document.querySelector('media-player') as HTMLElement | null);
          trigger(document.querySelector('[data-media-player]') as HTMLElement | null);

          const tpeadLinkEl =
            document.querySelector('#captchalink') ||
            document.querySelector('#norobotlink') ||
            document.querySelector('#ideoooolink');
          const tpeadVideo = document.querySelector('video') as HTMLVideoElement | null;
          let tpeadLink = String(
            tpeadLinkEl?.textContent || tpeadLinkEl?.innerHTML || '',
          ).trim();
          if (tpeadVideo && tpeadLink) {
            if (tpeadLink.startsWith('//')) tpeadLink = `https:${tpeadLink}`;
            else if (tpeadLink.startsWith('/')) tpeadLink = new URL(tpeadLink, location.href).toString();
            if (!/[?&]stream=1(?:&|$)/i.test(tpeadLink)) {
              tpeadLink += `${tpeadLink.includes('?') ? '&' : '?'}stream=1`;
            }
            try {
              tpeadVideo.src = tpeadLink;
              tpeadVideo.load();
            } catch {
              // ignore
            }
          }

          const clickables = Array.from(
            document.querySelectorAll(
              '#adv, .adblock, .rek, #player-button-container, #player-button, media-player, [data-media-player], button, [role="button"], .jw-icon-playback, .jw-display-icon-container, .play, .vjs-big-play-button, .vjs-play-control, video',
            ),
          ) as HTMLElement[];
          for (const el of clickables) {
            trigger(el);
          }

          const video = document.querySelector('video') as HTMLVideoElement | null;
          if (video) {
            video.muted = true;
            video.play().catch(() => undefined);
          }
        })
        .catch(() => undefined);

    if (!isVidkingEmbed) await triggerPlayerActivity();
    if (isHubstreamEmbed) {
      const collectDecodedPayloads = async () => {
        const payloads = await page.evaluate(() => (window as any).__playbackPayloads || []).catch(() => []);
        for (const payload of payloads) {
          for (const parsed of parseUrlsFromText(String(payload || ''))) addDiscovered(parsed);
          try { addSubtitles(parseSubtitlesFromValue(JSON.parse(String(payload || '')), normalizedEmbed)); }
          catch { addSubtitles(parseSubtitlesFromText(String(payload || ''))); }
        }
      };
      await collectDecodedPayloads();
      // Already-decoded sources do not need another activation delay. The
      // manifest prefetch below still captures their short-lived playlists
      // in this browser session before it is closed.
      const activationDeadline = Date.now() + 800;
      while (!discovered.size && Date.now() < activationDeadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([manifestReady, new Promise<void>(resolve => { timer = setTimeout(resolve, 50); })]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await collectDecodedPayloads();
      }
      if (!discovered.size) await triggerPlayerActivity();
      // Read decoded sources/tracks before polling. Some HubStream variants
      // expose their payload without issuing a media request until user play.
      await collectDecodedPayloads();
    }
    if (isTpeadEmbed) await page.waitForTimeout(600).catch(() => undefined);
    if (isTpeadEmbed) await triggerPlayerActivity();

    if (isVidkingEmbed || isVideasyEmbed) {
      const defaultMirrors = isVideasyEmbed
        ? ['Yoru', 'Cypher', 'Sage', 'Breach', 'Vyse', 'Killjoy', 'Fade', 'Omen', 'Raze']
        : ['Hydrogen', 'Lithium', 'Helium', 'Oxygen'];
      const mirrors = preferredMirror
        ? [
            ...defaultMirrors.filter(
              (mirror) => mirror.toLowerCase() === preferredMirror.toLowerCase(),
            ),
            ...defaultMirrors.filter(
              (mirror) => mirror.toLowerCase() !== preferredMirror.toLowerCase(),
            ),
          ]
        : defaultMirrors;
      for (const mirror of mirrors) {
        activeMirrorLabel = mirror;
        await page
          .evaluate((target: string) => {
            const norm = (value: string) =>
              value.replace(/\s+/g, ' ').trim().toLowerCase();
            const wanted = norm(target);
            const candidates = Array.from(
              document.querySelectorAll(
                'button, [role="button"], [aria-label], [title], .server, .source, .server-item, .source-item, a, li, div',
              ),
            ) as HTMLElement[];
            const ranked = candidates
              .map((el) => {
                const text = norm(
                  el.innerText ||
                    el.textContent ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('title') ||
                    '',
                );
                const rect = el.getBoundingClientRect();
                return { el, text, area: Math.max(1, rect.width * rect.height) };
              })
              .filter(({ text, area }) => {
                if (!text || area <= 1) return false;
                if (text === wanted) return true;
                return text.includes(wanted) && text.length <= wanted.length + 24;
              })
              .sort((a, b) => {
                const exactDelta = Number(b.text === wanted) - Number(a.text === wanted);
                if (exactDelta) return exactDelta;
                return a.text.length - b.text.length || a.area - b.area;
              });
            const hit = ranked[0]?.el;
            if (!hit) return false;
            const text = norm(
              hit.innerText ||
                hit.textContent ||
                hit.getAttribute('aria-label') ||
                hit.getAttribute('title') ||
                '',
            );
            if (!text.includes(wanted)) return false;
            hit.scrollIntoView({ block: 'center', inline: 'center' });
            hit.click();
            return true;
          }, mirror)
          .catch(() => false);
        await triggerPlayerActivity();
        await page.waitForTimeout(isVideasyEmbed ? 2400 : 1600).catch(() => undefined);
        if (
          !isVideasyEmbed &&
          discovered.size > 0 &&
          (!wantsSubtitles || subtitles.size > 0)
        )
          break;
      }
      activeMirrorLabel = '';
    }

    const startedAt = Date.now();
    const finalWaitMs = isVideasyEmbed
      ? Math.min(7000, Math.max(3500, attemptTimeout - 2000))
      : Math.min(4500, Math.max(1800, attemptTimeout - 2000));
    while (Date.now() - startedAt < finalWaitMs) {
      if (
        !isVideasyEmbed &&
        discovered.size > 0 &&
        (!wantsSubtitles || subtitles.size > 0)
      )
        break;
      if (isVideasyEmbed && Date.now() - startedAt > 1200) await triggerPlayerActivity();
      if (isHubstreamEmbed && Date.now() - startedAt > 900) await triggerPlayerActivity();
      await page.waitForTimeout(250);
    }

    try {
      const cookies = await context.cookies().catch(() => [] as any[]);
      const sourceHosts = new Set<string>();
      for (const candidate of [normalizedEmbed, ...discovered.keys()]) {
        try {
          sourceHosts.add(new URL(candidate).hostname.toLowerCase());
        } catch {
          // ignore
        }
      }
      const matchingCookies = cookies.filter((cookie: any) => {
        const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
        if (!domain) return false;
        for (const host of sourceHosts) {
          if (host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`)) return true;
        }
        return false;
      });
      cookieHeader = matchingCookies
        .map((cookie: any) => `${cookie.name}=${cookie.value}`)
        .filter(Boolean)
        .join('; ');
    } catch {
      // ignore cookie extraction failures
    }

    const domTracks = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('track')).map((track) => ({
          url:
            (track as HTMLTrackElement).src ||
            track.getAttribute('src') ||
            '',
          lang:
            track.getAttribute('label') ||
            track.getAttribute('srclang') ||
            'Unknown',
          kind: track.getAttribute('kind') || undefined,
          default: track.hasAttribute('default'),
        })),
      )
      .catch(() => [] as Array<{ url: string; lang: string; kind?: string; default?: boolean }>);
    addSubtitles(
      domTracks
        .map((track: { url: string; lang: string; kind?: string; default?: boolean }) => ({
          ...track,
          url: absoluteUrl(track.url, normalizedEmbed) || '',
        }))
        .filter((track: { url: string }) => {
        const trackUrl = String(track.url || '').replace(/#.*$/, '');
        return /\.(vtt|srt|ass)(\?|$)/i.test(trackUrl) && !/\/thumbnail(?:s)?\.vtt/i.test(trackUrl);
      }),
    );

    const decodedPayloads = await page
      .evaluate(() => (window as any).__playbackPayloads || [])
      .catch(() => [] as string[]);
    for (const payload of decodedPayloads) {
      for (const parsed of parseUrlsFromText(String(payload || ''))) addDiscovered(parsed);
      try {
        addSubtitles(parseSubtitlesFromValue(JSON.parse(String(payload || '')), normalizedEmbed));
      } catch {
        addSubtitles(parseSubtitlesFromText(String(payload || '')));
      }
    }

    for (const subtitleInfoUrl of [...subtitleInfoUrls]) {
      if (subtitles.size > 0) break;
      try {
        const response = await context.request.get(subtitleInfoUrl, {
          headers: {
            Referer: normalizedEmbed,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          timeout: Math.min(6000, Math.max(2500, attemptTimeout - (Date.now() - startedAt))),
        });
        if (!response.ok()) continue;
        const body = await response.text();
        addSubtitles(parseSubtitlesFromText(body));
        if (/\.(vtt|srt|ass)(\?|$)/i.test(subtitleInfoUrl) && body.trim()) {
          setCachedSubtitleText(subtitleInfoUrl, body);
        }
      } catch {
        // Subtitle manifests are best-effort; playback should not depend on them.
      }
    }

    for (const subtitleInfoUrl of [...subtitleInfoUrls]) {
      if (subtitles.size > 0) break;
      let subtitlePage: any;
      try {
        subtitlePage = await context.newPage();
        await subtitlePage.goto(subtitleInfoUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(9000, Math.max(4000, attemptTimeout - (Date.now() - startedAt))),
        });
        await subtitlePage.waitForTimeout(1500).catch(() => undefined);
        const body = await subtitlePage.evaluate(
          () => document.body?.innerText || document.documentElement?.textContent || '',
        );
        addSubtitles(parseSubtitlesFromText(String(body || '')));
        if (/\.(vtt|srt|ass)(\?|$)/i.test(subtitleInfoUrl) && String(body || '').trim()) {
          setCachedSubtitleText(subtitleInfoUrl, String(body || ''));
        }
      } catch {
        // Some subtitle token hosts require challenges we cannot always solve server-side.
      } finally {
        if (subtitlePage) await subtitlePage.close().catch(() => undefined);
      }
    }

    // Actively fetch browser-session HLS manifests so the proxy can serve from cache.
    // Using page.evaluate(fetch) ensures browser cookies/session are included.
    const hubstreamM3uUrls = [...discovered.keys()].filter(
      (u) =>
        /hubstream\.(?:art|pw|cc|ink|foo|boo)|as-cdn\d+\.(?:top|ac|pro|xyz|click|link|net|cc|org)/i.test(u) &&
        /\.m3u8(?:\?|$)/i.test(u),
    );
    // Prefetch is optional: one slow CDN must not serialize or stall extraction.
    await Promise.all(hubstreamM3uUrls.map(async (m3u8Url) => {
      if (getCachedHlsManifest(m3u8Url)) return;
      try {
        const body = await page
          .evaluate(
            async (url: string) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 4000);
              try {
                const r = await fetch(url, {
                  signal: controller.signal,
                  credentials: 'include',
                  headers: { Referer: document.location.href },
                });
                if (!r.ok) return null;
                return await r.text();
              } catch {
                return null;
              } finally {
                clearTimeout(timer);
              }
            },
            m3u8Url,
          )
          .catch(() => null);
        if (body && String(body).trim().startsWith('#EXTM3U')) {
          hlsManifestCache.set(m3u8Url, {
            body: String(body),
            contentType: 'application/vnd.apple.mpegurl',
            expiresAt: Date.now() + HLS_MANIFEST_CACHE_MS,
          });
        }
      } catch {
        // Best-effort; playback should not block on manifest prefetch.
      }
    }));

  } catch (err) {
    console.error(`[Playwright extractor failed] ${normalizedEmbed}`, err);
  } finally {
    // Failed navigation and response parsing must not leave live player pages
    // downloading media indefinitely in the shared browser.
    if (context) await context.close().catch(() => undefined);
    if (ownsSlot) releaseBrowserSlot();
  }

    if (discovered.size > 0 || !isHubstreamEmbed) break;
    if (attempt + 1 < MAX_HUBSTREAM_ATTEMPTS) {
      console.log(
        `[Playwright] hubstream retry ${attempt + 1}/${MAX_HUBSTREAM_ATTEMPTS} for ${normalizedEmbed}`,
      );
    }
  }

  const sourceEntries = dropDuplicateHlsVariants([...discovered.keys()])
    .filter((u) => isDirectMediaUrl(u))
    .sort((a, b) => {
      const score = (url: string) => {
        const label = String(discovered.get(url) || '').toLowerCase();
        return (
          (/\.m3u8(?:\?|$)/i.test(url) ? 80 : 0) +
          (/\/master\.m3u8(?:\?|$)/i.test(url) ? 25 : 0) +
          (/\/index\.m3u8(?:\?|$)/i.test(url) ? 15 : 0) +
          (/\.mp4(?:\?|$)/i.test(url) ? 20 : 0) +
          (/yoru/.test(label) ? 45 : 0) +
          (/neon/.test(label) ? 40 : 0) +
          (/cypher/.test(label) ? 30 : 0) +
          (/sage/.test(label) ? 20 : 0) +
          (/hydrogen/.test(label) ? 35 : 0) +
          (/lithium/.test(label) ? 30 : 0) +
          (/helium/.test(label) ? 15 : 0) -
          (/oxygen/.test(label) ? 40 : 0)
        );
      };
      return score(b) - score(a);
    });

  const sources = sourceEntries.map((url) => ({
    url,
    quality: discovered.get(url) ? `auto (${discovered.get(url)})` : 'auto',
    server: discovered.get(url) || undefined,
    isM3U8:
      /\.m3u8(\?|$)/i.test(url) ||
      /\/m3u8-proxy\?/i.test(url) ||
      /\/getm3u8\//i.test(url),
    isEmbed: false as const,
  }));

  if (PLAYWRIGHT_DEBUG) {
    console.log(
      `[Playwright extractor result] ${normalizedEmbed} sources=${sources.length} subtitles=${subtitles.size}`,
    );
  }

    return { sources, subtitles: [...subtitles.values()], ...(cookieHeader ? { cookieHeader } : {}) };
};

export const extractDirectSourcesWithPlaywright = async (
  embedUrl: string,
  referer?: string,
  timeoutMs = 12000,
): Promise<Array<{ url: string; quality: string; isM3U8: boolean; isEmbed: false }>> => {
  const playback = await extractPlaybackWithPlaywright(embedUrl, referer, timeoutMs);
  return playback.sources;
};
