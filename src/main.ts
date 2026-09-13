require('dotenv').config();

import Fastify from 'fastify';
import FastifyCors from '@fastify/cors';
import axios from 'axios';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { getProxyCandidatesSync, toAxiosProxyOptions } from './utils/outboundProxy';

// --- Global Axios Optimization ---
axios.defaults.httpsAgent = new https.Agent({ family: 4, keepAlive: true });
axios.defaults.headers.common['User-Agent'] =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/json, text/plain, */*';

// A background promise (e.g. an un-awaited page navigation) rejecting must not
// tear down the shared server. Log it and keep serving; pm2 restarts otherwise
// kill in-flight requests, leaving clients hanging.
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on('uncaughtException', (error: any) => {
  console.error('[uncaughtException]', error?.stack || error);
});

// Dedicated keep-alive agents for HLS segment streaming
const hlsHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64 });
const hlsHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64, family: 4 });

// Fresh (no keep-alive) agents for flaky direct-IP CDNs (hubstream etc.). Their
// nodes intermittently poison kept-alive TLS sockets, causing
// "write EPROTO ... packet length too long" on reuse. A fresh connection per
// request avoids that at a small TLS-handshake cost.
const hlsHttpsFreshAgent = new https.Agent({ family: 4, keepAlive: false });
const hlsHttpFreshAgent = new http.Agent({ keepAlive: false });

// --- HLS segment cache -------------------------------------------------------
// Serve previously-fetched segments instantly so seeks, replays and the
// parallel audio/video fragment streams don't re-hit the upstream CDN, which
// throttles concurrent bursts and intermittently returns 500. Entries are
// keyed by the full upstream URL (tokens are part of the URL), TTL-bounded and
// size-capped to keep memory sane under long sessions.
const HLS_SEGMENT_CACHE_TTL_MS = 10 * 60 * 1000;
const HLS_SEGMENT_CACHE_MAX_ENTRIES = 1600;
const HLS_SEGMENT_CACHE_MAX_BYTES = 240 * 1024 * 1024;
interface HlsSegmentCacheEntry {
  buf: Buffer;
  contentType: string;
  cachedAt: number;
}
const hlsSegmentCache = new Map<string, HlsSegmentCacheEntry>();
let hlsSegmentCacheBytes = 0;

function hlsSegmentCacheGet(key: string): HlsSegmentCacheEntry | undefined {
  const entry = hlsSegmentCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > HLS_SEGMENT_CACHE_TTL_MS) {
    hlsSegmentCache.delete(key);
    hlsSegmentCacheBytes -= entry.buf.length;
    return undefined;
  }
  return entry;
}

function hlsSegmentCacheSet(key: string, entry: HlsSegmentCacheEntry): void {
  const existing = hlsSegmentCache.get(key);
  if (existing) hlsSegmentCacheBytes -= existing.buf.length;
  hlsSegmentCache.set(key, entry);
  hlsSegmentCacheBytes += entry.buf.length;
  while (
    hlsSegmentCache.size > HLS_SEGMENT_CACHE_MAX_ENTRIES ||
    hlsSegmentCacheBytes > HLS_SEGMENT_CACHE_MAX_BYTES
  ) {
    const oldestKey = hlsSegmentCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = hlsSegmentCache.get(oldestKey);
    if (oldest) hlsSegmentCacheBytes -= oldest.buf.length;
    hlsSegmentCache.delete(oldestKey);
  }
}

// --- Upstream segment fetch concurrency limiter ------------------------------
// HLS.js fires up to ~8 parallel fragment requests on a seek (video+audio).
// Without a cap the CDN starts dropping/throttling and answers 500. Serialize
// the remaining requests through a FIFO queue.
const UPSTREAM_MAX_CONCURRENCY = 8;
const upstreamQueue: Array<() => void> = [];
let upstreamActive = 0;

function drainUpstreamQueue(): void {
  while (upstreamActive < UPSTREAM_MAX_CONCURRENCY && upstreamQueue.length > 0) {
    const next = upstreamQueue.shift();
    if (next) next();
  }
}

async function withUpstreamConcurrency<T>(
  fn: () => Promise<T>,
  shouldSkip?: () => boolean,
): Promise<T> {
  if (shouldSkip?.()) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  if (upstreamActive < UPSTREAM_MAX_CONCURRENCY) {
    upstreamActive += 1;
    try {
      return await fn();
    } finally {
      upstreamActive -= 1;
      drainUpstreamQueue();
    }
  }
  return new Promise<T>((resolve, reject) => {
    upstreamQueue.push(() => {
      if (shouldSkip?.()) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      upstreamActive += 1;
      fn().then(resolve, reject).finally(() => {
        upstreamActive -= 1;
        drainUpstreamQueue();
      });
    });
  });
}

const isAbortError = (err: unknown): boolean => {
  const e = err as any;
  return Boolean(e && (e.name === 'AbortError' || e.code === 'ERR_CANCELED'));
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- HubStream CDN node rotation -------------------------------------------
// HubStream signs its fragment/playlist URLs once and serves them from a pool
// of `{node}.{cdnDomain}` hosts. Both the node prefix and the CDN domain rotate
// over time (e.g. sd8g.auroradigitalworks.shop, sdqm.fusionhorizonworks.site).
// Nodes are unreliable (per-segment 502s, nginx bursts) and a node that starts
// failing usually fails every resource on it for a while. The k/kx signature
// tokens are global to the whole CDN, so the same signed URL can be retried
// verbatim on any other (node, domain) pair.
const HUBSTREAM_CDN_HOST_RE = /^([a-z0-9-]+)\.([a-z0-9-]+\.[a-z]{2,})$/i;
const HUBSTREAM_CDN_PATH_RE = /\/v4\/pl\/([a-z0-9-]+)\.([a-z0-9-]+\.[a-z]{2,})(\/.*)$/i;
const hubstreamNodePrefixes: string[] = ['s9r1', 'sd8g', 'sipt', 'sdqm'];
const hubstreamCdnDomains: string[] = ['auroradigitalworks.shop', 'fusionhorizonworks.site'];

// HubStream throttles downloads per (node, domain) edge: a sustained run of
// distinct segment fetches makes that domain crawl (multi-second per segment)
// while the other domains in the pool stay fast. The same signed token is valid
// across every (node, domain) pair, so the proxy prefers whichever host has
// served fastest recently instead of pinning the whole session to one domain.
const HUBSTREAM_SLOW_SUCCESS_MS = 1500;
const HUBSTREAM_SEGMENT_TIMEOUT_MS = 8000;
// Cap on how long we keep scanning rotated nodes after a slow 200 before
// serving the fastest one we already have. Bounds the pathological all-nodes-
// throttled case while still catching the common one: a fast node that answers
// right after the primary one turned slow.
const HUBSTREAM_SLOW_SCAN_DEADLINE_MS = 4000;

const hubstreamHostLatency = new Map<string, { va: number; n: number }>();

const recordHubstreamHostLatencyMs = (hostname: string, elapsedMs: number): void => {
  if (!hostname) return;
  const prev = hubstreamHostLatency.get(hostname);
  if (prev) {
    prev.va = prev.va * 0.7 + elapsedMs * 0.3;
    prev.n += 1;
  } else {
    hubstreamHostLatency.set(hostname, { va: elapsedMs, n: 1 });
  }
};

const hubstreamHostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// Reorders the rotation pool so the host that recently served fastest is tried
// first. Unknown hosts keep their original playlist order at the back.
const orderHubstreamVariants = (variants: string[]): string[] => {
  if (variants.length <= 1) return variants;
  const scored = variants.map((u, index) => ({
    u,
    index,
    va: hubstreamHostLatency.get(hubstreamHostnameOf(u))?.va ?? Number.POSITIVE_INFINITY,
  }));
  scored.sort((a, b) => {
    if (a.va !== b.va) return a.va - b.va;
    return a.index - b.index;
  });
  return scored.map((s) => s.u);
};

const addHubstreamNode = (hostname: string): void => {
  const match = String(hostname || '').toLowerCase().match(HUBSTREAM_CDN_HOST_RE);
  const prefix = match?.[1];
  const domain = match?.[2];
  if (!prefix || !domain) return;
  if (!hubstreamNodePrefixes.includes(prefix)) hubstreamNodePrefixes.push(prefix);
  if (!hubstreamCdnDomains.includes(domain)) hubstreamCdnDomains.push(domain);
};

/**
 * Return equivalent URLs for the given hubstream resource across the known
 * (node, domain) pool. The first entry is always the original URL. Hostname-form
 * (`{node}.{domain}/v4/...`) and path-form
 * (`hubstream.art/v4/pl/{node}.{domain}/...`) are both handled. Rotated
 * candidates prefer the original domain first, then the original prefix.
 */
const hubstreamNodeVariants = (url: string): string[] => {
  const variants = [url];
  try {
    const parsed = new URL(url);
    let originalPrefix = '';
    let originalDomain = '';
    let hostForm = false;

    const hostMatch = parsed.hostname.match(HUBSTREAM_CDN_HOST_RE);
    if (hostMatch && /^\/v4\//i.test(parsed.pathname)) {
      originalPrefix = hostMatch[1];
      originalDomain = hostMatch[2];
      hostForm = true;
      addHubstreamNode(parsed.hostname);
    } else {
      const pathMatch = parsed.pathname.match(HUBSTREAM_CDN_PATH_RE);
      if (pathMatch) {
        originalPrefix = pathMatch[1];
        originalDomain = pathMatch[2];
        addHubstreamNode(`${originalPrefix}.${originalDomain}`);
      }
    }

    if (!originalPrefix || !originalDomain) return variants;

    const domains = [originalDomain, ...hubstreamCdnDomains.filter((d) => d !== originalDomain)];
    const prefixes = [originalPrefix, ...hubstreamNodePrefixes.filter((p) => p !== originalPrefix)];

    for (const domain of domains) {
      for (const prefix of prefixes) {
        if (domain === originalDomain && prefix === originalPrefix) continue;
        const host = `${prefix}.${domain}`;
        const candidate = hostForm
          ? parsed.href.replace(parsed.host, host)
          : url.replace(`${originalPrefix}.${originalDomain}`, host);
        if (!variants.includes(candidate)) variants.push(candidate);
        // Cap the pool so a dead stream can't burn unbounded time.
        if (variants.length >= 9) return variants;
      }
    }
  } catch {
    // Not a valid URL — return the original unchanged.
  }
  return variants;
};

import anime from './routes/anime';
import lightnovels from './routes/light-novels';
import manga from './routes/manga';
import movies from './routes/movies';
import meta from './routes/meta';
import sports from './routes/sports';
import ghoulstreams from './routes/ghoulstreams';
import chalk from 'chalk';
import Utils from './utils';
import { normalizeStreamLinks } from './utils/streamable';
import { registerWatchTogether } from './utils/watchTogether';
import { sendStreamVersePasswordReset } from './utils/streamversePasswordReset';

export const redis = null;

export const REDIS_TTL = 3600;

const fastify = Fastify({
  maxParamLength: 1000,
  logger: true,
});

const MEDIA_PROXY_TOKEN_TTL_SECONDS = 600;
const createMediaProxyToken = (): string | null => {
  const secret = String(process.env.MEDIA_PROXY_TOKEN_SECRET || '').trim();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + MEDIA_PROXY_TOKEN_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

export const tmdbApi = process.env.TMDB_KEY && process.env.TMDB_KEY;
(async () => {
  const PORT = Number(process.env.PORT) || 3000;

  await fastify.register(FastifyCors, {
    origin: true, // Transparently reflect the request origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  fastify.get('/media-proxy/token', async (_request, reply) => {
    const token = createMediaProxyToken();
    if (!token) return reply.code(503).send({ error: 'Media proxy token service is not configured' });
    return reply.send({ token, expiresIn: MEDIA_PROXY_TOKEN_TTL_SECONDS });
  });

  fastify.post('/auth/password-reset', async (request: any, reply) => {
    try {
      await sendStreamVersePasswordReset(String(request.body?.email || ''));
      return reply.send({ ok: true });
    } catch (error: any) {
      request.log.error(error, 'custom password reset failed');
      return reply.code(400).send({ error: error?.message || 'Unable to send password reset email' });
    }
  });

  fastify.addHook('preSerialization', async (_request, _reply, payload) => {
    return normalizeStreamLinks(payload);
  });

  if (process.env.NODE_ENV === 'DEMO') {
    console.log(chalk.yellowBright('DEMO MODE ENABLED'));

    const map = new Map<string, { expiresIn: Date }>();
    // session duration in milliseconds (5 hours)
    const sessionDuration = 1000 * 60 * 60 * 5;

    fastify.addHook('onRequest', async (request, reply) => {
      const ip = request.ip;
      const session = map.get(ip);

      // check if the requester ip has a session (temporary access)
      if (session) {
        // if session is found, check if the session is expired
        const { expiresIn } = session;
        const currentTime = new Date();
        const sessionTime = new Date(expiresIn);

        // check if the session has been expired
        if (currentTime.getTime() > sessionTime.getTime()) {
          console.log('session expired');
          // if expired, delete the session and continue
          map.delete(ip);

          // redirect to the demo request page
          return reply.redirect('/apidemo');
        }
        console.log('session found. expires in', expiresIn);
        if (request.url === '/apidemo') return reply.redirect('/');
        return;
      }

      // if route is not /apidemo, redirect to the demo request page
      if (request.url === '/apidemo') return;

      console.log('session not found');
      reply.redirect('/apidemo');
    });

    fastify.post('/apidemo', async (request, reply) => {
      const { ip } = request;

      // check if the requester ip has a session (temporary access)
      const session = map.get(ip);

      if (session) return reply.redirect('/');

      // if no session, create a new session
      const expiresIn = new Date(Date.now() + sessionDuration);
      map.set(ip, { expiresIn });

      // redirect to the demo request page
      reply.redirect('/');
    });

    fastify.get('/apidemo', async (_, reply) => {
      return reply.type('application/json').send({
        message: 'Demo access page is disabled in this deployment.',
      });
    });

    // set interval to delete expired sessions every 1 hour
    setInterval(
      () => {
        const currentTime = new Date();
        for (const [ip, session] of map.entries()) {
          const { expiresIn } = session;
          const sessionTime = new Date(expiresIn);

          // check if the session is expired
          if (currentTime.getTime() > sessionTime.getTime()) {
            console.log('session expired for', ip);
            // if expired, delete the session and continue
            map.delete(ip);
          }
        }
      },
      1000 * 60 * 60,
    );
  }

  console.log(chalk.green(`Starting server on port ${PORT}... 🚀`));
  console.log(chalk.yellowBright('Redis removed. Cache disabled.'));

  if (!process.env.TMDB_KEY)
    console.warn(
      chalk.yellowBright('TMDB api key not found. the TMDB meta route may not work.'),
    );

  await fastify.register(anime, { prefix: '/anime' });
  await fastify.register(lightnovels, { prefix: '/light-novels' });
  await fastify.register(manga, { prefix: '/manga' });
  await fastify.register(movies, { prefix: '/movies' });
  await fastify.register(meta, { prefix: '/meta' });
  await fastify.register(sports, { prefix: '/sports' });
  await fastify.register(ghoulstreams);
  await fastify.register(Utils, { prefix: '/utils' });
  registerWatchTogether(fastify);

  const appendQueryParam = (path: string, key: string, value?: string): string => {
    const safeValue = String(value || '').trim();
    if (!safeValue) return path;

    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}${encodeURIComponent(key)}=${encodeURIComponent(safeValue)}`;
  };

  const appendRefererParam = (path: string, referer?: string): string => {
    const safeReferer = String(referer || '').trim();
    return appendQueryParam(path, 'referer', safeReferer);
  };

  const buildProxyPath = (
    targetUrl: string,
    referer?: string,
    isSegment = false,
    baseUrl?: string,
  ): string => {
    const raw = String(targetUrl || '').trim();
    if (!raw) return raw;
    if (/^\/proxy\/hls\//i.test(raw)) {
      const path = appendRefererParam(raw, referer);
      return baseUrl ? `${baseUrl}${path}` : path;
    }

    try {
      const parsed = new URL(raw);
      let path = `/proxy/hls/${parsed.host}${parsed.pathname}${parsed.search}`;
      path = appendRefererParam(path, referer);
      path = appendQueryParam(path, 'segment', isSegment ? '1' : '');
      return baseUrl ? `${baseUrl}${path}` : path;
    } catch {
      return raw;
    }
  };

  const isHubstreamSignedCdn = (u: URL): boolean =>
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname) && /^\/v4\//.test(u.pathname);

  const rewriteHlsManifest = (
    manifest: string,
    manifestUrl: string,
    referer?: string,
    baseUrl?: string,
  ): string => {
    const resolveAndProxy = (value: string, isSegment = false): string => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return trimmed;

      try {
        // Preserve the provider's page referer for child playlists and segments.
        // Using the parent manifest URL as Referer causes AnimeKai CDN requests to 403.
        const upstreamReferer = referer || manifestUrl;
        const resolved = new URL(trimmed, manifestUrl);
        // HubStream's direct-IP CDN signs every resource with the parent
        // playlist's query params (?v=...). Resolving relative references
        // drops that query, so re-inherit it or the CDN rejects the request
        // (502) and playback stalls.
        if (isHubstreamSignedCdn(new URL(manifestUrl))) {
          const parent = new URL(manifestUrl);
          for (const [key, value2] of parent.searchParams) {
            if (!resolved.searchParams.has(key)) {
              resolved.searchParams.set(key, value2);
            }
          }
        }
        return buildProxyPath(
          resolved.toString(),
          upstreamReferer,
          isSegment,
          baseUrl,
        );
      } catch {
        return trimmed;
      }
    };

    let output = String(manifest || '');

    output = output.replace(
      /URI="([^"]+)"/g,
      (_match, uri) => `URI="${resolveAndProxy(uri)}"`,
    );
    output = output.replace(
      /URI='([^']+)'/g,
      (_match, uri) => `URI='${resolveAndProxy(uri)}'`,
    );

    let previousTag = '';
    output = output
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
          previousTag = trimmed;
          return line;
        }
        if (/^(data:|blob:)/i.test(trimmed)) return line;
         // AnimeSalt subtitle URLs can be extensionless or end in .js. They may
         // follow an EXTINF line in the manifest, but must not receive the
         // segment marker or the HLS proxy will fetch them as media bytes.
         const isSubtitleResource = /(?:\/p\/|\.(?:vtt|srt|ass|js)(?:\?|$))/i.test(trimmed);
         const isSegment = /^#EXTINF\b/i.test(previousTag) && !isSubtitleResource;
        previousTag = '';
        return resolveAndProxy(trimmed, isSegment);
      })
      .join('\n');

      // AniKoto's shiora/mikora playlists use these CDN segment hosts as
      // playable media despite their ad-like names. The reference proxy
      // preserves them, so only apply the legacy cleanup to other manifests.
       if (!/(?:shiora|mikora|norami|akirax)\.|morencius\.com/i.test(manifestUrl)) {
        output = output.replace(
          /#EXTINF:[^\n]*(?:\n#[^\n]*)*\n[^\n]*(?:p1\.ipstatp\.com\/obj\/ad-site-i18n|p\d+-ad-sg\.ibyteimg\.com|p\d+-ad-site-sign-sg\.tiktokcdn\.com)[^\n]*/gi,
          '',
        );
      }

      // StreamVerse attaches external subtitle tracks itself. Some AnimeSalt
     // manifests advertise their subtitle file as an HLS playlist even though
     // it is a plain subtitle payload, which makes HLS.js abort video startup.
      output = output
        .split('\n')
        .filter((line) => !/^#EXT-X-MEDIA:/i.test(line) || !/TYPE=SUBTITLES/i.test(line))
        .join('\n');

      // Morencius audio playlists go through the proxy alongside video.
      // They are now reliably proxied so keep them available for
      // multi-language selection (English, Hindi, etc.) on the client.

      return output;
  };

  const isLikelyHlsManifest = (body: string, contentType?: string): boolean => {
    const text = String(body || '').trim();
    if (!text) return false;

    if (
      /application\/(vnd\.apple\.mpegurl|x-mpegURL)|audio\/x-mpegurl/i.test(
        String(contentType || ''),
      )
    ) {
      return true;
    }

    return /^#EXTM3U\b/m.test(text);
  };

  const decodeNumericHlsManifest = (body: unknown): string => {
    const text = String(body || '').trim();
    if (!text || /#EXTM3U\b/m.test(text)) return text;
    const tokens = text.split(/\s+/);
    if (tokens.length < 20 || tokens.some((token) => !/^\d{1,3}$/.test(token))) return text;
    const decoded = tokens.map((token) => String.fromCharCode(Number(token))).join('');
    return /^#EXTM3U\b/m.test(decoded) ? decoded : text;
  };

  const shouldTreatAsManifestRequest = (url: string, incomingRange: string): boolean => {
    if (/\.m3u8(?:$|\?)/i.test(url)) return true;
    if (incomingRange) return false;
    if (/(?:ok\.ru|okcdn\.ru)\/.*\/video\//i.test(url)) return true;
    return /\/(?:hls|oppai)\//i.test(url);
  };

  const fetchHlsResource = async (
    url: string,
    isManifest: boolean,
    incomingRange: string,
    referer: string,
    cookieHeader: string,
    signal?: AbortSignal,
  ) => {
    const isAnimeSaltCdn = /^https?:\/\/(?:as-cdn\d+|z\d+)\.(?:top|ac|pro|xyz|click|link|net|cc|org)\//i.test(url);
    // AnimeKai's Megaplay playlists can use a CDN for segments.
    // Those requests are reachable directly but commonly hang through the
    // configured outbound proxies, adding 15 seconds per segment retry.
    const isIbyteCdn = /^https?:\/\/[^/]*\.ibyteimg\.com\//i.test(url);
    const isTikTokCdn = /^https?:\/\/[^/]*\.tiktokcdn\.com\//i.test(url);
    // HubStream signs its URLs per-stream, not per-node, so a node that starts
    // 502ing or throttling can be swapped for another node in the same pool.
    // The original node keeps the full retry budget; rotated nodes use a smaller
    // one. Recognises both direct-IP hosts and the node pool hostnames.
    const nodeVariants = hubstreamNodeVariants(url);
    const isHubstreamCdn = nodeVariants.length > 1 && /\/v4\//i.test(url);
    const orderedHubstreamVariants = isHubstreamCdn
      ? orderHubstreamVariants(nodeVariants)
      : nodeVariants;
    const isShioraCdn = /^https?:\/\/(?:megap|vidtub)\.(?:shiora\.(?:top|site)|norami\.top|akirax\.buzz)\//i.test(url)
      || /^https?:\/\/[^/]*\.(?:mikora\.top|norami\.top|shiora\.(?:top|site))\//i.test(url)
      || /^https?:\/\/cdn\.watching\.onl\//i.test(url)
      || /^https?:\/\/[^/]*\.akirax\.buzz\//i.test(url)
      // AniKoto imgnex playlists are fast directly; outbound proxies add seconds per level.
      || /^https?:\/\/[^/]*\.imgnex\.top\//i.test(url)
      || /^https?:\/\/[^/]+\.livedns\.[^/]+\//i.test(url);
    const isMorencius = /^https?:\/\/morencius\.com\//i.test(url);
    const isAcekCdn = /^https?:\/\/[^/]*\.acek-cdn\.com\//i.test(url);
    const proxyCandidates = isAnimeSaltCdn || isIbyteCdn || isTikTokCdn || isHubstreamCdn || isShioraCdn || isMorencius
      ? ['']
      : isAcekCdn
        ? ['', ...getProxyCandidatesSync()]
        : [...getProxyCandidatesSync(), ''];
    let lastError: unknown = null;
    const effectiveReferer = (() => {
      const safeReferer = String(referer || '').trim();
      if (!safeReferer) return safeReferer;
      // AniKoto's shiora/kryntal CDNs reject the full Megaplay stream path and
      // only accept the provider origin as Referer. The kryntal.top hosts serve
      // Megaplay's video manifests and segments; requesting them with the exact
      // stream URL as Referer returns 403, while the megaplay origin works.
      if (
        /^https?:\/\/cdn\.mewstream\.[^/]+\//i.test(url) ||
        /^https?:\/\/cdn\.watching\.onl\//i.test(url) ||
        /^https?:\/\/[^/]+\.livedns\.[^/]+\//i.test(url) ||
        /^https?:\/\/[^/]*\.akirax\.buzz\//i.test(url) ||
        /^https?:\/\/vidtub\.(?:shiora\.(?:top|site)|akirax\.buzz)\//i.test(url) ||
        /^https?:\/\/(?:megap\.)?[^/]*\.(?:mikora\.top|norami\.top|shiora\.(?:top|site))\//i.test(url) ||
        /^https?:\/\/(?:megap\.mikora\.top|megap\.norami\.top|megap\.akirax\.buzz)\//i.test(url) ||
        /^https?:\/\/[^/]*\.kryntal\.top\//i.test(url) ||
        /^https?:\/\/[^/]*\.imgnex\.top\//i.test(url)
      ) {
        return 'https://megaplay.buzz/';
      }
      const isAnimeSaltSiteReferer = /^https?:\/\/animesalt\.(?:cx|ac|pro|xyz|click)(?:\/|$)/i.test(safeReferer);
      if (isAnimeSaltCdn && isAnimeSaltSiteReferer) {
        return safeReferer;
      }
      // Provider payloads occasionally return the CDN URL as the source
      // referer. AnimeSalt's current CDN (as-cdn*.top) expects the EXACT embed
      // page URL (https://as-cdn*.top/video/<id>) as the Referer, not the site
      // origin. Rewriting a valid CDN referer breaks the signed playlist.
      return safeReferer;
    })();

    // When a node responds 200 but has been throttled by HubStream, don't serve
    // that slow segment blindly: hold onto the fastest slow 200 and briefly scan
    // the rest of the pool for a healthier node before returning.
    const hubstreamScanStartedAt = Date.now();
    let bestSlowSuccess:
      | { response: import('axios').AxiosResponse; elapsedMs: number }
      | null = null;

    for (let nodeIdx = 0; nodeIdx < orderedHubstreamVariants.length; nodeIdx++) {
      const variantUrl = orderedHubstreamVariants[nodeIdx];
      const isPrimaryNode = nodeIdx === 0;

      for (const proxyUrl of proxyCandidates) {
        // When node rotation is available, burn the least time on a dead node:
        // two quick tries on the original, one on each rotated node. Keep the
        // full 5-attempt budget for non-rotated URLs (unchanged behavior).
        const maxAttempts = nodeVariants.length > 1
          ? (isPrimaryNode ? 2 : 1)
          : 5;
        let attempt = 0;
        let lastCandidateError: unknown = null;

        const throwIfAborted = () => {
          if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
        };

        while (attempt < maxAttempts) {
          attempt += 1;
          throwIfAborted();
          // HubStream's direct-IP nodes fail in bursts (nginx 502 / TLS resets).
          // A longer exponential backoff escapes those windows instead of retrying
          // straight into the same failure.
          const backoffMs = nodeVariants.length > 1
            ? 300
            : Math.min(3000, 300 * Math.pow(2, attempt - 1));
          try {
            const hubRequestStartedAt = Date.now();
            const response = await withUpstreamConcurrency(async () => {
              const proxyOptions = proxyUrl ? toAxiosProxyOptions(proxyUrl) : {};
              const omitOrigin = /^https?:\/\/(?:vidtub\.(?:shiora\.(?:top|site)|akirax\.buzz)|megap\.(?:mikora\.top|norami\.top|akirax\.buzz))\//i.test(url);
              const upstreamOrigin = (() => {
                if (omitOrigin) return '';
                try { return new URL(effectiveReferer).origin; } catch { return ''; }
              })();
              return await axios.get(variantUrl, {
                headers: {
                  Referer: effectiveReferer || 'https://streameeeeee.site/',
                  ...(upstreamOrigin ? { Origin: upstreamOrigin } : {}),
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
                  ...(incomingRange ? { Range: incomingRange } : {}),
                  ...(isManifest
                    ? {}
                    : { Accept: 'video/mp2t,video/mp4,application/octet-stream,*/*' }),
                  ...(isManifest ? {} : { 'Accept-Encoding': 'identity' }),
                },
                timeout: isAcekCdn ? 25000 : isIbyteCdn ? 30000 : isHubstreamCdn && !isManifest ? HUBSTREAM_SEGMENT_TIMEOUT_MS : 15000,
                 // Stream media segments as soon as upstream sends bytes. Buffering
                 // the full segment before replying can drain HLS.js on slower hosts.
                 responseType: isManifest ? 'text' : 'stream',
                validateStatus: (status: number) => status < 500,
                ...(proxyOptions as any),
                ...(signal ? { signal } : {}),
                // Flaky direct-IP CDNs (hubstream v4): avoid reusing poisoned
                // keep-alive TLS sockets that fail with `write EPROTO` on reuse.
                ...(isHubstreamCdn && !proxyUrl
                  ? { httpAgent: hlsHttpFreshAgent, httpsAgent: hlsHttpsFreshAgent }
                  : {}),
              });
            }, () => !!signal?.aborted);
            const hubElapsedMs = Date.now() - hubRequestStartedAt;

            const responseContentType = String(response.headers['content-type'] || '');

            if (isManifest) {
              response.data = decodeNumericHlsManifest(response.data);
            }

            if (response.status >= 400) {
              response.data?.destroy?.();
              lastCandidateError = Object.assign(new Error(`Upstream HLS response (${response.status})`), {
                statusCode: response.status,
              });
              // Deleted assets must reach the player without proxy/node retry amplification.
              if (response.status === 404 || response.status === 410) throw lastCandidateError;
              const isThrottled = response.status === 429;
              // A 429 means this specific node is rate-limiting us. Rotate to the
              // next node instead of hammering the throttled one; any node keeps a
              // fresh retry budget and the same signed URL is valid across the pool.
              if (isThrottled && nodeVariants.length > 1) break;
              // Transient 5xx and rate-limits benefit from a (longer) backoff.
              if ((response.status >= 500 || isThrottled) && attempt < maxAttempts) {
                const waitMs = isThrottled ? Math.max(backoffMs, 1500) : backoffMs;
                await sleep(waitMs);
                throwIfAborted();
                continue;
              }
              break;
            }

            if (
              isManifest &&
              !isLikelyHlsManifest(String(response.data || ''), responseContentType)
            ) {
              lastCandidateError = new Error(`Invalid HLS manifest response (${response.status})`);
              break;
            }

            if (isHubstreamCdn) {
              recordHubstreamHostLatencyMs(hubstreamHostnameOf(variantUrl), hubElapsedMs);
            }

            // A 200 that took a long time (a node being throttled) shouldn't be
            // served blindly when the CDN pool may have a faster node. Keep the
            // fastest slow 200, scan the rotated candidates briefly, then serve
            // whichever is quickest.
            if (
              isHubstreamCdn &&
              !isManifest &&
              hubElapsedMs > HUBSTREAM_SLOW_SUCCESS_MS &&
              orderedHubstreamVariants.length > 1
            ) {
              const wouldBump =
                Date.now() - hubstreamScanStartedAt > HUBSTREAM_SLOW_SCAN_DEADLINE_MS;
              if (!bestSlowSuccess || hubElapsedMs < bestSlowSuccess.elapsedMs) {
                bestSlowSuccess = { response, elapsedMs: hubElapsedMs };
              }
              if (!wouldBump) break;
              return bestSlowSuccess.response;
            }

            return response;
          } catch (error) {
            if (isAbortError(error)) throw error;
            lastCandidateError = error;
            const statusCode = Number((error as any)?.statusCode || (error as any)?.response?.status || 0);
            if (statusCode === 404 || statusCode === 410) throw error;
            const isTransient =
              (statusCode >= 500 && statusCode < 600) || statusCode === 0 || statusCode === 429;
            if (isTransient && attempt < maxAttempts) {
              await sleep(backoffMs);
              throwIfAborted();
              continue;
            }
            break;
          }
        }

        lastError = lastCandidateError;
      }
    }

    // If every candidate was slow but usable, serve the fastest one rather than
    // returning an error for bytes we already have.
    if (bestSlowSuccess) return bestSlowSuccess.response;

    throw lastError instanceof Error ? lastError : new Error('HLS proxy failed');
  };

  // HLS Proxy to work around CORS issues
  fastify.get('/proxy/hls/*', async (request, reply) => {
    const rawRequestUrl = String(request.url || '');
    const [rawPath, rawQuery = ''] = rawRequestUrl.split('?');
    const wildcardPath = rawPath.replace(/^\/proxy\/hls\//i, '').trim();
    const refererParam = String(
      new URLSearchParams(rawQuery).get('referer') || '',
    ).trim();
    const cookieParam = String(new URLSearchParams(rawQuery).get('cookie') || '').trim();
    const segmentParam =
      String(new URLSearchParams(rawQuery).get('segment') || '').trim() === '1';
    const passthroughQuery = rawQuery
      .split('&')
      .filter((part) => part && !/^(referer|segment|cookie)=/i.test(part))
      .join('&');

    let url = `https://${wildcardPath}${passthroughQuery ? `?${passthroughQuery}` : ''}`;
    // HubStream's hlsmod path wraps the real CDN host in the URL path. Decode
    // it before fetching; requesting the wrapper itself returns 404.
    const hlsmodMatch = url.match(/^https:\/\/hubstream\.(?:art|pw|cc|ink|foo|boo)\/hlsmod\/([^/]+)(\/.*)$/i);
    if (hlsmodMatch) {
      url = `https://${hlsmodMatch[1]}${hlsmodMatch[2]}${passthroughQuery ? `?${passthroughQuery}` : ''}`;
    }
    const incomingRange = String(request.headers.range || '');
    const isManifest = !segmentParam && shouldTreatAsManifestRequest(url, incomingRange);

    // Abort upstream fetches as soon as the client goes away (pausing, seeking
    // or retrying after a stall). Cancelling the CDN request frees the
    // concurrency slot and stops a phantom download that would otherwise land
    // in the throttling bucket and trigger more 429s upstream.
    const abortController = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });
    const incomingReferer = String(
      request.headers.referer || request.headers.referrer || '',
    )
      .trim()
      .replace(/#.*$/, '');
    let requestReferer = (
      refererParam || incomingReferer || 'https://streameeeeee.site/'
    ).replace(/#.*$/, '');
    if (
      /^https?:\/\/cdn\.mewstream\.[^/]+\//i.test(url) ||
      /^https?:\/\/cdn\.watching\.onl\//i.test(url) ||
      /^https?:\/\/[^/]+\.livedns\.[^/]+\//i.test(url) ||
      /^https?:\/\/[^/]*\.akirax\.buzz\//i.test(url) ||
      /^https?:\/\/(?:megap|vidtub)\.(?:shiora\.(?:top|site)|akirax\.buzz)\//i.test(url) ||
      /^https?:\/\/(?:megap\.mikora\.top|megap\.norami\.top|megap\.akirax\.buzz)\//i.test(url) ||
      /^https?:\/\/[^/]*\.imgnex\.top\//i.test(url)
    ) {
      requestReferer = 'https://megaplay.buzz/';
    }

    // Serve from Playwright-captured HLS manifest cache to avoid expired tokens.
    if (isManifest && !incomingRange) {
      try {
        const { getCachedHlsManifest } = await import('./utils/browserRuntimeExtractor');
        const cached = getCachedHlsManifest(url);
        if (cached) {
          const content = rewriteHlsManifest(cached.body, url, requestReferer, `${request.protocol}://${request.headers.host || 'localhost:3000'}`);
          reply.header('Content-Type', cached.contentType || 'application/vnd.apple.mpegurl');
          reply.header('Access-Control-Allow-Origin', '*');
          reply.header('Cache-Control', 'public, max-age=60');
          return reply.send(content);
        }
      } catch {
        // Cache lookup is best-effort.
      }
    }

    // Serve cached segments instantly: seeks back, replays and the parallel
    // audio/video fragment streams hit the CDN once instead of on every request.
    if (!isManifest && !incomingRange) {
      const cachedSegment = hlsSegmentCacheGet(url);
      if (cachedSegment) {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        reply.header('Content-Type', cachedSegment.contentType || 'application/octet-stream');
        reply.header('Content-Length', cachedSegment.buf.length);
        reply.header('Cache-Control', 'public, max-age=600');
        return reply.send(cachedSegment.buf);
      }
    }

    try {
      const response = await fetchHlsResource(
        url,
        isManifest,
        incomingRange,
        requestReferer,
        cookieParam,
        abortController.signal,
      );

      const responseContentType = String(response.headers['content-type'] || '');
      const responseBuffer = Buffer.isBuffer(response.data)
        ? response.data
        : response.data instanceof ArrayBuffer
          ? Buffer.from(response.data)
          : ArrayBuffer.isView(response.data)
            ? Buffer.from(
                response.data.buffer,
                response.data.byteOffset,
                response.data.byteLength,
              )
            : null;
      const responseText = responseBuffer
        ? responseBuffer.toString('utf8')
        : String(response.data || '');
      const isKeyResponse = /\/keys\/key\.bin(?:$|\?)/i.test(url);
      const responseIsManifest =
        isManifest || isLikelyHlsManifest(responseText, responseContentType);

      // If it's an M3U8 manifest, rewrite relative URLs to absolute/proxied URLs.
      // Some AnimeSalt variant playlists are extensionless /hls/<token> URLs, so
      // content sniffing is required instead of relying only on ".m3u8".
      if (responseIsManifest) {
        const hostHeader = request.headers.host || 'localhost:3000';
        const protocol = request.headers['x-forwarded-proto'] || request.protocol || 'https';
        const baseUrl = `${protocol}://${hostHeader}`;
        const content = rewriteHlsManifest(responseText, url, requestReferer, baseUrl);

        // Some Megaplay tokens currently return an ad-only playlist. After
        // removing those ad entries, fail it so the player can try a fallback
        // source instead of retrying an empty 200 response forever.
        const hasMediaUri = content
          .split('\n')
          .some((line) => line.trim() && !line.trim().startsWith('#'));
        if (!hasMediaUri && !/(?:shiora|mikora|norami|akirax)\./i.test(url)) {
          return reply.code(502).send({ error: 'Upstream HLS manifest contains no media segments' });
        }

        reply.header('Content-Type', 'application/vnd.apple.mpegurl');
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, Range',
        );
        reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        return reply.send(content);
      }

      // Do not wait for the complete segment buffer before sending it to the
      // player. This is especially important for AniKoto CDNs, where segment
      // download time can exceed the client's initial buffer.
      const upstreamStream = response.data as any;
      if (upstreamStream && typeof upstreamStream.pipe === 'function') {
        const streamHeaders: Record<string, string> = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Content-Type': responseContentType || 'application/octet-stream',
        };
        if (response.headers['content-length']) {
          streamHeaders['Content-Length'] = String(response.headers['content-length']);
        }
        if (response.headers['content-range']) {
          streamHeaders['Content-Range'] = String(response.headers['content-range']);
        }
        if (response.headers['accept-ranges']) {
          streamHeaders['Accept-Ranges'] = String(response.headers['accept-ranges']);
        }
        reply.raw.writeHead(response.status || 200, streamHeaders);
        upstreamStream.on('error', (err: Error) => {
          console.error('HLS segment stream error:', err.message);
          try { reply.raw.destroy(err); } catch { /* response already closed */ }
        });
        // Stop pulling the remaining segment from the CDN once the client is
        // gone; otherwise every stall-induced abort wastes a full segment of
        // upstream bandwidth and increases the chances of another 429.
        reply.raw.on('close', () => {
          if (!reply.raw.writableEnded) {
            try { upstreamStream.destroy(); } catch { /* already destroyed */ }
          }
        });
        upstreamStream.pipe(reply.raw);
        return reply;
      }

      // For segments (non-manifest), stream directly using keep-alive agents
      if (!responseIsManifest) {
        if (isKeyResponse && responseBuffer) {
          const trimmedKey = responseText.replace(/\s+/g, '');
          if (/^[A-Za-z0-9+/=]+$/.test(trimmedKey) && trimmedKey.length >= 24) {
            try {
              const decodedKey = Buffer.from(trimmedKey, 'base64');
              if (decodedKey.length >= 16 && decodedKey.length < responseBuffer.length) {
                reply.header('Access-Control-Allow-Origin', '*');
                reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
                reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
                reply.header('Content-Type', 'application/octet-stream');
                reply.header('Content-Length', decodedKey.length);
                return reply.send(decodedKey);
              }
            } catch {
              // Fall back to raw key payload when decoding fails.
            }
          }
        }

        // Serve the fully-downloaded segment buffer directly. The previous code
        // re-requested the same segment over the wire a second time to stream it,
        // doubling upstream latency/CDN load and amplifying throttling 500s.
        if (responseBuffer) {
          let contentType = responseContentType || 'application/octet-stream';
          // Some anime CDNs (e.g. livedns.my) return text/html for binary video
          // segments. Sniff the first bytes and override to prevent browser errors.
          if (/^text\/html/i.test(contentType) && responseBuffer.length > 16) {
            const magic = responseBuffer.subarray(0, 8);
            const head = magic.toString('ascii');
            if (head.startsWith('ID3') || head.startsWith('\x00\x00\x00')
              || magic[0] === 0x47 || magic[0] === 0x1A || magic[0] === 0x00) {
              contentType = 'video/mp2t';
            }
          }
          const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
          };

          if (!incomingRange) {
            hlsSegmentCacheSet(url, {
              buf: responseBuffer,
              contentType,
              cachedAt: Date.now(),
            });
            reply.header('Access-Control-Allow-Origin', '*');
            reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
            reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
            reply.header('Content-Type', contentType);
            reply.header('Content-Length', responseBuffer.length);
            reply.header('Cache-Control', 'public, max-age=600');
            return reply.send(responseBuffer);
          }

          // Honor byte ranges against the buffered segment.
          const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(incomingRange.trim());
          const total = responseBuffer.length;
          if (rangeMatch) {
            let start = rangeMatch[1] ? Number(rangeMatch[1]) : 0;
            const endRaw = rangeMatch[2] ? Number(rangeMatch[2]) : total - 1;
            if (!rangeMatch[1] && rangeMatch[2]) start = Math.max(0, total - Number(rangeMatch[2]));
            const end = Math.min(endRaw, total - 1);
            if (start <= end && start < total) {
              const slice = responseBuffer.subarray(start, end + 1);
              reply.header('Access-Control-Allow-Origin', '*');
              reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
              reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
              reply.header('Content-Type', contentType);
              reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
              reply.header('Content-Length', slice.length);
              reply.header('Accept-Ranges', 'bytes');
              reply.code(206);
              return reply.send(slice);
            }
            reply.code(416);
            return reply.send({ error: 'Range not satisfiable' });
          }
          void corsHeaders;
        }

        // Stream segment directly via keep-alive agents
        try {
          const upstreamUrl = new URL(url);
          const isHttps = upstreamUrl.protocol === 'https:';
          const transport = isHttps ? https : http;
          const agent = isHttps ? hlsHttpsAgent : hlsHttpAgent;

          const segmentReq = transport.request(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: upstreamUrl.pathname + upstreamUrl.search,
              method: 'GET',
              agent,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                Referer: requestReferer,
                ...(incomingRange ? { Range: incomingRange } : {}),
                ...(cookieParam ? { Cookie: cookieParam } : {}),
                Accept: 'video/mp2t,video/mp4,application/octet-stream,*/*',
                'Accept-Encoding': 'identity',
              },
            },
            (upstreamRes) => {
              const resHeaders: Record<string, string> = {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Content-Type':
                  upstreamRes.headers['content-type'] || 'application/octet-stream',
              };
              if (upstreamRes.headers['content-length'])
                resHeaders['Content-Length'] = upstreamRes.headers['content-length'] as string;
              if (upstreamRes.headers['content-range'])
                resHeaders['Content-Range'] = upstreamRes.headers['content-range'] as string;
              if (upstreamRes.headers['accept-ranges'])
                resHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'] as string;

              reply.raw.writeHead(upstreamRes.statusCode || 200, resHeaders);
              upstreamRes.pipe(reply.raw);
            },
          );

          segmentReq.on('error', (err: Error) => {
            console.error('HLS segment stream error:', err.message);
            if (!reply.sent) {
              reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
              reply.raw.end(JSON.stringify({ error: 'Segment proxy failed' }));
            }
          });

          segmentReq.end();
          return reply;
        } catch (err: any) {
          console.error('HLS segment stream error:', err.message);
          return reply.status(500).send({ error: 'Segment proxy failed' });
        }
      }

      // Should never reach here — all paths in the non-manifest block return above
      return reply.status(500).send({ error: 'Unexpected proxy state' });
    } catch (error: any) {
      // Client went away mid-fetch — nothing to reply to, just bail quietly.
      // A 502 here would be racing a destroyed socket anyway.
      if (isAbortError(error)) {
        if (!reply.raw.destroyed) {
          try { reply.raw.destroy(); } catch { /* already closed */ }
        }
        return reply;
      }
      console.error('HLS Proxy error:', error.message);
      const upstreamStatus = Number(error?.statusCode || error?.response?.status || 0);
      const status = upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502;
      return reply.header('Cache-Control', 'no-store').status(status).send({
        error: 'Proxy failed',
        ...(upstreamStatus ? { upstreamStatus } : {}),
      });
    }
  });

  try {
    fastify.get('/', (_, rp) => {
      rp.status(200).send(
        `Welcome to consumet api! 🎉 \n${
          process.env.NODE_ENV === 'DEMO'
            ? 'This is a demo of the api. You should only use this for testing purposes.'
            : ''
        }`,
      );
    });
    fastify.get('*', (request, reply) => {
      reply.status(404).send({
        message: '',
        error: 'page not found',
      });
    });

    const shouldUsePortFallback =
      String(process.env.ALLOW_PORT_FALLBACK || 'false').toLowerCase() === 'true';

    const startServer = async (initialPort: number, maxRetries = 5) => {
      if (!shouldUsePortFallback) {
        const address = await fastify.listen({ port: initialPort, host: '0.0.0.0' });
        console.log(`server listening on ${address}`);
        return;
      }

      for (let retry = 0; retry <= maxRetries; retry++) {
        const candidatePort = initialPort + retry;

        try {
          const address = await fastify.listen({ port: candidatePort, host: '0.0.0.0' });

          if (retry > 0) {
            console.warn(
              chalk.yellowBright(
                `Port ${initialPort} is busy. Started on fallback port ${candidatePort} instead.`,
              ),
            );
          }

          console.log(`server listening on ${address}`);
          return;
        } catch (error: any) {
          const isPortConflict = error?.code === 'EADDRINUSE';

          if (!isPortConflict || retry === maxRetries) {
            throw error;
          }
        }
      }
    };

    await startServer(PORT);
  } catch (err: any) {
    fastify.log.error(err);
    process.exit(1);
  }
})();
export default async function handler(req: any, res: any) {
  await fastify.ready();
  fastify.server.emit('request', req, res);
}
