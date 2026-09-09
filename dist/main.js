"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  REDIS_TTL: () => REDIS_TTL,
  default: () => handler,
  redis: () => redis,
  tmdbApi: () => tmdbApi
});
module.exports = __toCommonJS(main_exports);
var import_fastify = __toESM(require("fastify"));
var import_cors = __toESM(require("@fastify/cors"));
var import_axios = __toESM(require("axios"));
var import_http = __toESM(require("http"));
var import_https = __toESM(require("https"));
var import_crypto = __toESM(require("crypto"));
var import_outboundProxy = require("./utils/outboundProxy");
var import_anime = __toESM(require("./routes/anime"));
var import_light_novels = __toESM(require("./routes/light-novels"));
var import_manga = __toESM(require("./routes/manga"));
var import_movies = __toESM(require("./routes/movies"));
var import_meta = __toESM(require("./routes/meta"));
var import_sports = __toESM(require("./routes/sports"));
var import_ghoulstreams = __toESM(require("./routes/ghoulstreams"));
var import_chalk = __toESM(require("chalk"));
var import_utils = __toESM(require("./utils"));
var import_streamable = require("./utils/streamable");
var import_watchTogether = require("./utils/watchTogether");
var import_streamversePasswordReset = require("./utils/streamversePasswordReset");
require("dotenv").config();
import_axios.default.defaults.httpsAgent = new import_https.default.Agent({ family: 4, keepAlive: true });
import_axios.default.defaults.headers.common["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
import_axios.default.defaults.headers.common["Accept"] = "application/json, text/plain, */*";
const hlsHttpAgent = new import_http.default.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64 });
const hlsHttpsAgent = new import_https.default.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64, family: 4 });
const hlsHttpsFreshAgent = new import_https.default.Agent({ family: 4, keepAlive: false });
const hlsHttpFreshAgent = new import_http.default.Agent({ keepAlive: false });
const HLS_SEGMENT_CACHE_TTL_MS = 10 * 60 * 1e3;
const HLS_SEGMENT_CACHE_MAX_ENTRIES = 1600;
const HLS_SEGMENT_CACHE_MAX_BYTES = 240 * 1024 * 1024;
const hlsSegmentCache = /* @__PURE__ */ new Map();
let hlsSegmentCacheBytes = 0;
function hlsSegmentCacheGet(key) {
  const entry = hlsSegmentCache.get(key);
  if (!entry)
    return void 0;
  if (Date.now() - entry.cachedAt > HLS_SEGMENT_CACHE_TTL_MS) {
    hlsSegmentCache.delete(key);
    hlsSegmentCacheBytes -= entry.buf.length;
    return void 0;
  }
  return entry;
}
function hlsSegmentCacheSet(key, entry) {
  const existing = hlsSegmentCache.get(key);
  if (existing)
    hlsSegmentCacheBytes -= existing.buf.length;
  hlsSegmentCache.set(key, entry);
  hlsSegmentCacheBytes += entry.buf.length;
  while (hlsSegmentCache.size > HLS_SEGMENT_CACHE_MAX_ENTRIES || hlsSegmentCacheBytes > HLS_SEGMENT_CACHE_MAX_BYTES) {
    const oldestKey = hlsSegmentCache.keys().next().value;
    if (!oldestKey)
      break;
    const oldest = hlsSegmentCache.get(oldestKey);
    if (oldest)
      hlsSegmentCacheBytes -= oldest.buf.length;
    hlsSegmentCache.delete(oldestKey);
  }
}
const UPSTREAM_MAX_CONCURRENCY = 8;
const upstreamQueue = [];
let upstreamActive = 0;
function drainUpstreamQueue() {
  while (upstreamActive < UPSTREAM_MAX_CONCURRENCY && upstreamQueue.length > 0) {
    const next = upstreamQueue.shift();
    if (next)
      next();
  }
}
async function withUpstreamConcurrency(fn, shouldSkip) {
  if (shouldSkip?.()) {
    throw new DOMException("The operation was aborted.", "AbortError");
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
  return new Promise((resolve, reject) => {
    upstreamQueue.push(() => {
      if (shouldSkip?.()) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
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
const isAbortError = (err) => {
  const e = err;
  return Boolean(e && (e.name === "AbortError" || e.code === "ERR_CANCELED"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUBSTREAM_CDN_HOST_RE = /^([a-z0-9-]+)\.([a-z0-9-]+\.[a-z]{2,})$/i;
const HUBSTREAM_CDN_PATH_RE = /\/v4\/pl\/([a-z0-9-]+)\.([a-z0-9-]+\.[a-z]{2,})(\/.*)$/i;
const hubstreamNodePrefixes = ["s9r1", "sd8g", "sipt", "sdqm"];
const hubstreamCdnDomains = ["auroradigitalworks.shop", "fusionhorizonworks.site"];
const HUBSTREAM_SLOW_SUCCESS_MS = 1500;
const HUBSTREAM_SEGMENT_TIMEOUT_MS = 8e3;
const HUBSTREAM_SLOW_SCAN_DEADLINE_MS = 4e3;
const hubstreamHostLatency = /* @__PURE__ */ new Map();
const recordHubstreamHostLatencyMs = (hostname, elapsedMs) => {
  if (!hostname)
    return;
  const prev = hubstreamHostLatency.get(hostname);
  if (prev) {
    prev.va = prev.va * 0.7 + elapsedMs * 0.3;
    prev.n += 1;
  } else {
    hubstreamHostLatency.set(hostname, { va: elapsedMs, n: 1 });
  }
};
const hubstreamHostnameOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
const orderHubstreamVariants = (variants) => {
  if (variants.length <= 1)
    return variants;
  const scored = variants.map((u, index) => ({
    u,
    index,
    va: hubstreamHostLatency.get(hubstreamHostnameOf(u))?.va ?? Number.POSITIVE_INFINITY
  }));
  scored.sort((a, b) => {
    if (a.va !== b.va)
      return a.va - b.va;
    return a.index - b.index;
  });
  return scored.map((s) => s.u);
};
const addHubstreamNode = (hostname) => {
  const match = String(hostname || "").toLowerCase().match(HUBSTREAM_CDN_HOST_RE);
  const prefix = match?.[1];
  const domain = match?.[2];
  if (!prefix || !domain)
    return;
  if (!hubstreamNodePrefixes.includes(prefix))
    hubstreamNodePrefixes.push(prefix);
  if (!hubstreamCdnDomains.includes(domain))
    hubstreamCdnDomains.push(domain);
};
const hubstreamNodeVariants = (url) => {
  const variants = [url];
  try {
    const parsed = new URL(url);
    let originalPrefix = "";
    let originalDomain = "";
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
    if (!originalPrefix || !originalDomain)
      return variants;
    const domains = [originalDomain, ...hubstreamCdnDomains.filter((d) => d !== originalDomain)];
    const prefixes = [originalPrefix, ...hubstreamNodePrefixes.filter((p) => p !== originalPrefix)];
    for (const domain of domains) {
      for (const prefix of prefixes) {
        if (domain === originalDomain && prefix === originalPrefix)
          continue;
        const host = `${prefix}.${domain}`;
        const candidate = hostForm ? parsed.href.replace(parsed.host, host) : url.replace(`${originalPrefix}.${originalDomain}`, host);
        if (!variants.includes(candidate))
          variants.push(candidate);
        if (variants.length >= 9)
          return variants;
      }
    }
  } catch {
  }
  return variants;
};
const redis = null;
const REDIS_TTL = 3600;
const fastify = (0, import_fastify.default)({
  maxParamLength: 1e3,
  logger: true
});
const MEDIA_PROXY_TOKEN_TTL_SECONDS = 600;
const createMediaProxyToken = () => {
  const secret = String(process.env.MEDIA_PROXY_TOKEN_SECRET || "").trim();
  if (!secret)
    return null;
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1e3) + MEDIA_PROXY_TOKEN_TTL_SECONDS
  })).toString("base64url");
  const signature = import_crypto.default.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};
const tmdbApi = process.env.TMDB_KEY && process.env.TMDB_KEY;
(async () => {
  const PORT = Number(process.env.PORT) || 3e3;
  await fastify.register(import_cors.default, {
    origin: true,
    // Transparently reflect the request origin
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
  });
  fastify.get("/media-proxy/token", async (_request, reply) => {
    const token = createMediaProxyToken();
    if (!token)
      return reply.code(503).send({ error: "Media proxy token service is not configured" });
    return reply.send({ token, expiresIn: MEDIA_PROXY_TOKEN_TTL_SECONDS });
  });
  fastify.post("/auth/password-reset", async (request, reply) => {
    try {
      await (0, import_streamversePasswordReset.sendStreamVersePasswordReset)(String(request.body?.email || ""));
      return reply.send({ ok: true });
    } catch (error) {
      request.log.error(error, "custom password reset failed");
      return reply.code(400).send({ error: error?.message || "Unable to send password reset email" });
    }
  });
  fastify.addHook("preSerialization", async (_request, _reply, payload) => {
    return (0, import_streamable.normalizeStreamLinks)(payload);
  });
  if (process.env.NODE_ENV === "DEMO") {
    console.log(import_chalk.default.yellowBright("DEMO MODE ENABLED"));
    const map = /* @__PURE__ */ new Map();
    const sessionDuration = 1e3 * 60 * 60 * 5;
    fastify.addHook("onRequest", async (request, reply) => {
      const ip = request.ip;
      const session = map.get(ip);
      if (session) {
        const { expiresIn } = session;
        const currentTime = /* @__PURE__ */ new Date();
        const sessionTime = new Date(expiresIn);
        if (currentTime.getTime() > sessionTime.getTime()) {
          console.log("session expired");
          map.delete(ip);
          return reply.redirect("/apidemo");
        }
        console.log("session found. expires in", expiresIn);
        if (request.url === "/apidemo")
          return reply.redirect("/");
        return;
      }
      if (request.url === "/apidemo")
        return;
      console.log("session not found");
      reply.redirect("/apidemo");
    });
    fastify.post("/apidemo", async (request, reply) => {
      const { ip } = request;
      const session = map.get(ip);
      if (session)
        return reply.redirect("/");
      const expiresIn = new Date(Date.now() + sessionDuration);
      map.set(ip, { expiresIn });
      reply.redirect("/");
    });
    fastify.get("/apidemo", async (_, reply) => {
      return reply.type("application/json").send({
        message: "Demo access page is disabled in this deployment."
      });
    });
    setInterval(
      () => {
        const currentTime = /* @__PURE__ */ new Date();
        for (const [ip, session] of map.entries()) {
          const { expiresIn } = session;
          const sessionTime = new Date(expiresIn);
          if (currentTime.getTime() > sessionTime.getTime()) {
            console.log("session expired for", ip);
            map.delete(ip);
          }
        }
      },
      1e3 * 60 * 60
    );
  }
  console.log(import_chalk.default.green(`Starting server on port ${PORT}... \u{1F680}`));
  console.log(import_chalk.default.yellowBright("Redis removed. Cache disabled."));
  if (!process.env.TMDB_KEY)
    console.warn(
      import_chalk.default.yellowBright("TMDB api key not found. the TMDB meta route may not work.")
    );
  await fastify.register(import_anime.default, { prefix: "/anime" });
  await fastify.register(import_light_novels.default, { prefix: "/light-novels" });
  await fastify.register(import_manga.default, { prefix: "/manga" });
  await fastify.register(import_movies.default, { prefix: "/movies" });
  await fastify.register(import_meta.default, { prefix: "/meta" });
  await fastify.register(import_sports.default, { prefix: "/sports" });
  await fastify.register(import_ghoulstreams.default);
  await fastify.register(import_utils.default, { prefix: "/utils" });
  (0, import_watchTogether.registerWatchTogether)(fastify);
  const appendQueryParam = (path, key, value) => {
    const safeValue = String(value || "").trim();
    if (!safeValue)
      return path;
    const joiner = path.includes("?") ? "&" : "?";
    return `${path}${joiner}${encodeURIComponent(key)}=${encodeURIComponent(safeValue)}`;
  };
  const appendRefererParam = (path, referer) => {
    const safeReferer = String(referer || "").trim();
    return appendQueryParam(path, "referer", safeReferer);
  };
  const buildProxyPath = (targetUrl, referer, isSegment = false, baseUrl) => {
    const raw = String(targetUrl || "").trim();
    if (!raw)
      return raw;
    if (/^\/proxy\/hls\//i.test(raw)) {
      const path = appendRefererParam(raw, referer);
      return baseUrl ? `${baseUrl}${path}` : path;
    }
    try {
      const parsed = new URL(raw);
      let path = `/proxy/hls/${parsed.host}${parsed.pathname}${parsed.search}`;
      path = appendRefererParam(path, referer);
      path = appendQueryParam(path, "segment", isSegment ? "1" : "");
      return baseUrl ? `${baseUrl}${path}` : path;
    } catch {
      return raw;
    }
  };
  const isHubstreamSignedCdn = (u) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname) && /^\/v4\//.test(u.pathname);
  const rewriteHlsManifest = (manifest, manifestUrl, referer, baseUrl) => {
    const resolveAndProxy = (value, isSegment = false) => {
      const trimmed = String(value || "").trim();
      if (!trimmed)
        return trimmed;
      try {
        const upstreamReferer = referer || manifestUrl;
        const resolved = new URL(trimmed, manifestUrl);
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
          baseUrl
        );
      } catch {
        return trimmed;
      }
    };
    let output = String(manifest || "");
    output = output.replace(
      /URI="([^"]+)"/g,
      (_match, uri) => `URI="${resolveAndProxy(uri)}"`
    );
    output = output.replace(
      /URI='([^']+)'/g,
      (_match, uri) => `URI='${resolveAndProxy(uri)}'`
    );
    let previousTag = "";
    output = output.split("\n").map((line) => {
      const trimmed = line.trim();
      if (!trimmed)
        return line;
      if (trimmed.startsWith("#")) {
        previousTag = trimmed;
        return line;
      }
      if (/^(data:|blob:)/i.test(trimmed))
        return line;
      const isSubtitleResource = /(?:\/p\/|\.(?:vtt|srt|ass|js)(?:\?|$))/i.test(trimmed);
      const isSegment = /^#EXTINF\b/i.test(previousTag) && !isSubtitleResource;
      previousTag = "";
      return resolveAndProxy(trimmed, isSegment);
    }).join("\n");
    if (!/(?:shiora|mikora|norami|akirax)\.|morencius\.com/i.test(manifestUrl)) {
      output = output.replace(
        /#EXTINF:[^\n]*(?:\n#[^\n]*)*\n[^\n]*(?:p1\.ipstatp\.com\/obj\/ad-site-i18n|p\d+-ad-sg\.ibyteimg\.com|p\d+-ad-site-sign-sg\.tiktokcdn\.com)[^\n]*/gi,
        ""
      );
    }
    output = output.split("\n").filter((line) => !/^#EXT-X-MEDIA:/i.test(line) || !/TYPE=SUBTITLES/i.test(line)).join("\n");
    return output;
  };
  const isLikelyHlsManifest = (body, contentType) => {
    const text = String(body || "").trim();
    if (!text)
      return false;
    if (/application\/(vnd\.apple\.mpegurl|x-mpegURL)|audio\/x-mpegurl/i.test(
      String(contentType || "")
    )) {
      return true;
    }
    return /^#EXTM3U\b/m.test(text);
  };
  const decodeNumericHlsManifest = (body) => {
    const text = String(body || "").trim();
    if (!text || /#EXTM3U\b/m.test(text))
      return text;
    const tokens = text.split(/\s+/);
    if (tokens.length < 20 || tokens.some((token) => !/^\d{1,3}$/.test(token)))
      return text;
    const decoded = tokens.map((token) => String.fromCharCode(Number(token))).join("");
    return /^#EXTM3U\b/m.test(decoded) ? decoded : text;
  };
  const shouldTreatAsManifestRequest = (url, incomingRange) => {
    if (/\.m3u8(?:$|\?)/i.test(url))
      return true;
    if (incomingRange)
      return false;
    if (/(?:ok\.ru|okcdn\.ru)\/.*\/video\//i.test(url))
      return true;
    return /\/(?:hls|oppai)\//i.test(url);
  };
  const fetchHlsResource = async (url, isManifest, incomingRange, referer, cookieHeader, signal) => {
    const isAnimeSaltCdn = /^https?:\/\/(?:as-cdn\d+|z\d+)\.(?:top|ac|pro|xyz|click|link|net|cc|org)\//i.test(url);
    const isIbyteCdn = /^https?:\/\/[^/]*\.ibyteimg\.com\//i.test(url);
    const isTikTokCdn = /^https?:\/\/[^/]*\.tiktokcdn\.com\//i.test(url);
    const nodeVariants = hubstreamNodeVariants(url);
    const isHubstreamCdn = nodeVariants.length > 1 && /\/v4\//i.test(url);
    const orderedHubstreamVariants = isHubstreamCdn ? orderHubstreamVariants(nodeVariants) : nodeVariants;
    const isShioraCdn = /^https?:\/\/(?:megap|vidtub)\.(?:shiora\.(?:top|site)|norami\.top|akirax\.buzz)\//i.test(url) || /^https?:\/\/[^/]*\.(?:mikora\.top|norami\.top|shiora\.(?:top|site))\//i.test(url) || /^https?:\/\/cdn\.watching\.onl\//i.test(url) || /^https?:\/\/[^/]*\.akirax\.buzz\//i.test(url) || /^https?:\/\/[^/]+\.livedns\.[^/]+\//i.test(url);
    const isMorencius = /^https?:\/\/morencius\.com\//i.test(url);
    const isAcekCdn = /^https?:\/\/[^/]*\.acek-cdn\.com\//i.test(url);
    const proxyCandidates = isAnimeSaltCdn || isIbyteCdn || isTikTokCdn || isHubstreamCdn || isShioraCdn || isMorencius ? [""] : isAcekCdn ? ["", ...(0, import_outboundProxy.getProxyCandidatesSync)()] : [...(0, import_outboundProxy.getProxyCandidatesSync)(), ""];
    let lastError = null;
    const effectiveReferer = (() => {
      const safeReferer = String(referer || "").trim();
      if (!safeReferer)
        return safeReferer;
      if (/^https?:\/\/cdn\.mewstream\.[^/]+\//i.test(url) || /^https?:\/\/cdn\.watching\.onl\//i.test(url) || /^https?:\/\/[^/]+\.livedns\.[^/]+\//i.test(url) || /^https?:\/\/[^/]*\.akirax\.buzz\//i.test(url) || /^https?:\/\/vidtub\.(?:shiora\.(?:top|site)|akirax\.buzz)\//i.test(url) || /^https?:\/\/(?:megap\.)?[^/]*\.(?:mikora\.top|norami\.top|shiora\.(?:top|site))\//i.test(url) || /^https?:\/\/(?:megap\.mikora\.top|megap\.norami\.top|megap\.akirax\.buzz)\//i.test(url) || /^https?:\/\/[^/]*\.kryntal\.top\//i.test(url) || /^https?:\/\/[^/]*\.imgnex\.top\//i.test(url)) {
        return "https://megaplay.buzz/";
      }
      const isAnimeSaltSiteReferer = /^https?:\/\/animesalt\.(?:cx|ac|pro|xyz|click)(?:\/|$)/i.test(safeReferer);
      if (isAnimeSaltCdn && isAnimeSaltSiteReferer) {
        return safeReferer;
      }
      return safeReferer;
    })();
    const hubstreamScanStartedAt = Date.now();
    let bestSlowSuccess = null;
    for (let nodeIdx = 0; nodeIdx < orderedHubstreamVariants.length; nodeIdx++) {
      const variantUrl = orderedHubstreamVariants[nodeIdx];
      const isPrimaryNode = nodeIdx === 0;
      for (const proxyUrl of proxyCandidates) {
        const maxAttempts = nodeVariants.length > 1 ? isPrimaryNode ? 2 : 1 : 5;
        let attempt = 0;
        let lastCandidateError = null;
        const throwIfAborted = () => {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
        };
        while (attempt < maxAttempts) {
          attempt += 1;
          throwIfAborted();
          const backoffMs = nodeVariants.length > 1 ? 300 : Math.min(3e3, 300 * Math.pow(2, attempt - 1));
          try {
            const hubRequestStartedAt = Date.now();
            const response = await withUpstreamConcurrency(async () => {
              const proxyOptions = proxyUrl ? (0, import_outboundProxy.toAxiosProxyOptions)(proxyUrl) : {};
              const omitOrigin = /^https?:\/\/(?:vidtub\.(?:shiora\.(?:top|site)|akirax\.buzz)|megap\.(?:mikora\.top|norami\.top|akirax\.buzz))\//i.test(url);
              const upstreamOrigin = (() => {
                if (omitOrigin)
                  return "";
                try {
                  return new URL(effectiveReferer).origin;
                } catch {
                  return "";
                }
              })();
              return await import_axios.default.get(variantUrl, {
                headers: {
                  Referer: effectiveReferer || "https://streameeeeee.site/",
                  ...upstreamOrigin ? { Origin: upstreamOrigin } : {},
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                  ...cookieHeader ? { Cookie: cookieHeader } : {},
                  ...incomingRange ? { Range: incomingRange } : {},
                  ...isManifest ? {} : { Accept: "video/mp2t,video/mp4,application/octet-stream,*/*" },
                  ...isManifest ? {} : { "Accept-Encoding": "identity" }
                },
                timeout: isAcekCdn ? 25e3 : isIbyteCdn ? 3e4 : isHubstreamCdn && !isManifest ? HUBSTREAM_SEGMENT_TIMEOUT_MS : 15e3,
                // Stream media segments as soon as upstream sends bytes. Buffering
                // the full segment before replying can drain HLS.js on slower hosts.
                responseType: isManifest ? "text" : "stream",
                validateStatus: (status) => status < 500,
                ...proxyOptions,
                ...signal ? { signal } : {},
                // Flaky direct-IP CDNs (hubstream v4): avoid reusing poisoned
                // keep-alive TLS sockets that fail with `write EPROTO` on reuse.
                ...isHubstreamCdn && !proxyUrl ? { httpAgent: hlsHttpFreshAgent, httpsAgent: hlsHttpsFreshAgent } : {}
              });
            }, () => !!signal?.aborted);
            const hubElapsedMs = Date.now() - hubRequestStartedAt;
            const responseContentType = String(response.headers["content-type"] || "");
            if (isManifest) {
              response.data = decodeNumericHlsManifest(response.data);
            }
            if (response.status >= 400) {
              lastCandidateError = new Error(`Upstream HLS response (${response.status})`);
              const isThrottled = response.status === 429;
              if (isThrottled && nodeVariants.length > 1)
                break;
              if ((response.status >= 500 || isThrottled) && attempt < maxAttempts) {
                const waitMs = isThrottled ? Math.max(backoffMs, 1500) : backoffMs;
                await sleep(waitMs);
                throwIfAborted();
                continue;
              }
              break;
            }
            if (isManifest && !isLikelyHlsManifest(String(response.data || ""), responseContentType)) {
              lastCandidateError = new Error(`Invalid HLS manifest response (${response.status})`);
              break;
            }
            if (isHubstreamCdn) {
              recordHubstreamHostLatencyMs(hubstreamHostnameOf(variantUrl), hubElapsedMs);
            }
            if (isHubstreamCdn && !isManifest && hubElapsedMs > HUBSTREAM_SLOW_SUCCESS_MS && orderedHubstreamVariants.length > 1) {
              const wouldBump = Date.now() - hubstreamScanStartedAt > HUBSTREAM_SLOW_SCAN_DEADLINE_MS;
              if (!bestSlowSuccess || hubElapsedMs < bestSlowSuccess.elapsedMs) {
                bestSlowSuccess = { response, elapsedMs: hubElapsedMs };
              }
              if (!wouldBump)
                break;
              return bestSlowSuccess.response;
            }
            return response;
          } catch (error) {
            if (isAbortError(error))
              throw error;
            lastCandidateError = error;
            const statusCode = Number(error?.response?.status || 0);
            const isTransient = statusCode >= 500 && statusCode < 600 || statusCode === 0 || statusCode === 429;
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
    if (bestSlowSuccess)
      return bestSlowSuccess.response;
    throw lastError instanceof Error ? lastError : new Error("HLS proxy failed");
  };
  fastify.get("/proxy/hls/*", async (request, reply) => {
    const rawRequestUrl = String(request.url || "");
    const [rawPath, rawQuery = ""] = rawRequestUrl.split("?");
    const wildcardPath = rawPath.replace(/^\/proxy\/hls\//i, "").trim();
    const refererParam = String(
      new URLSearchParams(rawQuery).get("referer") || ""
    ).trim();
    const cookieParam = String(new URLSearchParams(rawQuery).get("cookie") || "").trim();
    const segmentParam = String(new URLSearchParams(rawQuery).get("segment") || "").trim() === "1";
    const passthroughQuery = rawQuery.split("&").filter((part) => part && !/^(referer|segment|cookie)=/i.test(part)).join("&");
    let url = `https://${wildcardPath}${passthroughQuery ? `?${passthroughQuery}` : ""}`;
    const hlsmodMatch = url.match(/^https:\/\/hubstream\.(?:art|pw|cc|ink|foo|boo)\/hlsmod\/([^/]+)(\/.*)$/i);
    if (hlsmodMatch) {
      url = `https://${hlsmodMatch[1]}${hlsmodMatch[2]}${passthroughQuery ? `?${passthroughQuery}` : ""}`;
    }
    const incomingRange = String(request.headers.range || "");
    const isManifest = !segmentParam && shouldTreatAsManifestRequest(url, incomingRange);
    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });
    const incomingReferer = String(
      request.headers.referer || request.headers.referrer || ""
    ).trim().replace(/#.*$/, "");
    let requestReferer = (refererParam || incomingReferer || "https://streameeeeee.site/").replace(/#.*$/, "");
    if (/^https?:\/\/cdn\.mewstream\.[^/]+\//i.test(url) || /^https?:\/\/cdn\.watching\.onl\//i.test(url) || /^https?:\/\/[^/]+\.livedns\.[^/]+\//i.test(url) || /^https?:\/\/[^/]*\.akirax\.buzz\//i.test(url) || /^https?:\/\/(?:megap|vidtub)\.(?:shiora\.(?:top|site)|akirax\.buzz)\//i.test(url) || /^https?:\/\/(?:megap\.mikora\.top|megap\.norami\.top|megap\.akirax\.buzz)\//i.test(url) || /^https?:\/\/[^/]*\.imgnex\.top\//i.test(url)) {
      requestReferer = "https://megaplay.buzz/";
    }
    if (isManifest && !incomingRange) {
      try {
        const { getCachedHlsManifest } = await import("./utils/browserRuntimeExtractor");
        const cached = getCachedHlsManifest(url);
        if (cached) {
          const content = rewriteHlsManifest(cached.body, url, requestReferer, `${request.protocol}://${request.headers.host || "localhost:3000"}`);
          reply.header("Content-Type", cached.contentType || "application/vnd.apple.mpegurl");
          reply.header("Access-Control-Allow-Origin", "*");
          reply.header("Cache-Control", "public, max-age=60");
          return reply.send(content);
        }
      } catch {
      }
    }
    if (!isManifest && !incomingRange) {
      const cachedSegment = hlsSegmentCacheGet(url);
      if (cachedSegment) {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
        reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
        reply.header("Content-Type", cachedSegment.contentType || "application/octet-stream");
        reply.header("Content-Length", cachedSegment.buf.length);
        reply.header("Cache-Control", "public, max-age=600");
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
        abortController.signal
      );
      const responseContentType = String(response.headers["content-type"] || "");
      const responseBuffer = Buffer.isBuffer(response.data) ? response.data : response.data instanceof ArrayBuffer ? Buffer.from(response.data) : ArrayBuffer.isView(response.data) ? Buffer.from(
        response.data.buffer,
        response.data.byteOffset,
        response.data.byteLength
      ) : null;
      const responseText = responseBuffer ? responseBuffer.toString("utf8") : String(response.data || "");
      const isKeyResponse = /\/keys\/key\.bin(?:$|\?)/i.test(url);
      const responseIsManifest = isManifest || isLikelyHlsManifest(responseText, responseContentType);
      if (responseIsManifest) {
        const hostHeader = request.headers.host || "localhost:3000";
        const protocol = request.headers["x-forwarded-proto"] || request.protocol || "https";
        const baseUrl = `${protocol}://${hostHeader}`;
        const content = rewriteHlsManifest(responseText, url, requestReferer, baseUrl);
        const hasMediaUri = content.split("\n").some((line) => line.trim() && !line.trim().startsWith("#"));
        if (!hasMediaUri && !/(?:shiora|mikora|norami|akirax)\./i.test(url)) {
          return reply.code(502).send({ error: "Upstream HLS manifest contains no media segments" });
        }
        reply.header("Content-Type", "application/vnd.apple.mpegurl");
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, Range"
        );
        reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
        return reply.send(content);
      }
      const upstreamStream = response.data;
      if (upstreamStream && typeof upstreamStream.pipe === "function") {
        const streamHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Content-Type": responseContentType || "application/octet-stream"
        };
        if (response.headers["content-length"]) {
          streamHeaders["Content-Length"] = String(response.headers["content-length"]);
        }
        if (response.headers["content-range"]) {
          streamHeaders["Content-Range"] = String(response.headers["content-range"]);
        }
        if (response.headers["accept-ranges"]) {
          streamHeaders["Accept-Ranges"] = String(response.headers["accept-ranges"]);
        }
        reply.raw.writeHead(response.status || 200, streamHeaders);
        upstreamStream.on("error", (err) => {
          console.error("HLS segment stream error:", err.message);
          try {
            reply.raw.destroy(err);
          } catch {
          }
        });
        reply.raw.on("close", () => {
          if (!reply.raw.writableEnded) {
            try {
              upstreamStream.destroy();
            } catch {
            }
          }
        });
        upstreamStream.pipe(reply.raw);
        return reply;
      }
      if (!responseIsManifest) {
        if (isKeyResponse && responseBuffer) {
          const trimmedKey = responseText.replace(/\s+/g, "");
          if (/^[A-Za-z0-9+/=]+$/.test(trimmedKey) && trimmedKey.length >= 24) {
            try {
              const decodedKey = Buffer.from(trimmedKey, "base64");
              if (decodedKey.length >= 16 && decodedKey.length < responseBuffer.length) {
                reply.header("Access-Control-Allow-Origin", "*");
                reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
                reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
                reply.header("Content-Type", "application/octet-stream");
                reply.header("Content-Length", decodedKey.length);
                return reply.send(decodedKey);
              }
            } catch {
            }
          }
        }
        if (responseBuffer) {
          let contentType = responseContentType || "application/octet-stream";
          if (/^text\/html/i.test(contentType) && responseBuffer.length > 16) {
            const magic = responseBuffer.subarray(0, 8);
            const head = magic.toString("ascii");
            if (head.startsWith("ID3") || head.startsWith("\0\0\0") || magic[0] === 71 || magic[0] === 26 || magic[0] === 0) {
              contentType = "video/mp2t";
            }
          }
          const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
            "Access-Control-Allow-Methods": "GET, OPTIONS"
          };
          if (!incomingRange) {
            hlsSegmentCacheSet(url, {
              buf: responseBuffer,
              contentType,
              cachedAt: Date.now()
            });
            reply.header("Access-Control-Allow-Origin", "*");
            reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
            reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
            reply.header("Content-Type", contentType);
            reply.header("Content-Length", responseBuffer.length);
            reply.header("Cache-Control", "public, max-age=600");
            return reply.send(responseBuffer);
          }
          const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(incomingRange.trim());
          const total = responseBuffer.length;
          if (rangeMatch) {
            let start = rangeMatch[1] ? Number(rangeMatch[1]) : 0;
            const endRaw = rangeMatch[2] ? Number(rangeMatch[2]) : total - 1;
            if (!rangeMatch[1] && rangeMatch[2])
              start = Math.max(0, total - Number(rangeMatch[2]));
            const end = Math.min(endRaw, total - 1);
            if (start <= end && start < total) {
              const slice = responseBuffer.subarray(start, end + 1);
              reply.header("Access-Control-Allow-Origin", "*");
              reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
              reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
              reply.header("Content-Type", contentType);
              reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
              reply.header("Content-Length", slice.length);
              reply.header("Accept-Ranges", "bytes");
              reply.code(206);
              return reply.send(slice);
            }
            reply.code(416);
            return reply.send({ error: "Range not satisfiable" });
          }
        }
        try {
          const upstreamUrl = new URL(url);
          const isHttps = upstreamUrl.protocol === "https:";
          const transport = isHttps ? import_https.default : import_http.default;
          const agent = isHttps ? hlsHttpsAgent : hlsHttpAgent;
          const segmentReq = transport.request(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: upstreamUrl.pathname + upstreamUrl.search,
              method: "GET",
              agent,
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                Referer: requestReferer,
                ...incomingRange ? { Range: incomingRange } : {},
                ...cookieParam ? { Cookie: cookieParam } : {},
                Accept: "video/mp2t,video/mp4,application/octet-stream,*/*",
                "Accept-Encoding": "identity"
              }
            },
            (upstreamRes) => {
              const resHeaders = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Content-Type": upstreamRes.headers["content-type"] || "application/octet-stream"
              };
              if (upstreamRes.headers["content-length"])
                resHeaders["Content-Length"] = upstreamRes.headers["content-length"];
              if (upstreamRes.headers["content-range"])
                resHeaders["Content-Range"] = upstreamRes.headers["content-range"];
              if (upstreamRes.headers["accept-ranges"])
                resHeaders["Accept-Ranges"] = upstreamRes.headers["accept-ranges"];
              reply.raw.writeHead(upstreamRes.statusCode || 200, resHeaders);
              upstreamRes.pipe(reply.raw);
            }
          );
          segmentReq.on("error", (err) => {
            console.error("HLS segment stream error:", err.message);
            if (!reply.sent) {
              reply.raw.writeHead(500, { "Content-Type": "application/json" });
              reply.raw.end(JSON.stringify({ error: "Segment proxy failed" }));
            }
          });
          segmentReq.end();
          return reply;
        } catch (err) {
          console.error("HLS segment stream error:", err.message);
          return reply.status(500).send({ error: "Segment proxy failed" });
        }
      }
      return reply.status(500).send({ error: "Unexpected proxy state" });
    } catch (error) {
      if (isAbortError(error)) {
        if (!reply.raw.destroyed) {
          try {
            reply.raw.destroy();
          } catch {
          }
        }
        return reply;
      }
      console.error("HLS Proxy error:", error.message);
      const upstreamStatus = Number(error?.statusCode || error?.response?.status || 0);
      const status = upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502;
      return reply.status(status).send({
        error: "Proxy failed",
        ...upstreamStatus ? { upstreamStatus } : {}
      });
    }
  });
  try {
    fastify.get("/", (_, rp) => {
      rp.status(200).send(
        `Welcome to consumet api! \u{1F389} 
${process.env.NODE_ENV === "DEMO" ? "This is a demo of the api. You should only use this for testing purposes." : ""}`
      );
    });
    fastify.get("*", (request, reply) => {
      reply.status(404).send({
        message: "",
        error: "page not found"
      });
    });
    const shouldUsePortFallback = String(process.env.ALLOW_PORT_FALLBACK || "false").toLowerCase() === "true";
    const startServer = async (initialPort, maxRetries = 5) => {
      if (!shouldUsePortFallback) {
        const address = await fastify.listen({ port: initialPort, host: "0.0.0.0" });
        console.log(`server listening on ${address}`);
        return;
      }
      for (let retry = 0; retry <= maxRetries; retry++) {
        const candidatePort = initialPort + retry;
        try {
          const address = await fastify.listen({ port: candidatePort, host: "0.0.0.0" });
          if (retry > 0) {
            console.warn(
              import_chalk.default.yellowBright(
                `Port ${initialPort} is busy. Started on fallback port ${candidatePort} instead.`
              )
            );
          }
          console.log(`server listening on ${address}`);
          return;
        } catch (error) {
          const isPortConflict = error?.code === "EADDRINUSE";
          if (!isPortConflict || retry === maxRetries) {
            throw error;
          }
        }
      }
    };
    await startServer(PORT);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
})();
async function handler(req, res) {
  await fastify.ready();
  fastify.server.emit("request", req, res);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  REDIS_TTL,
  redis,
  tmdbApi
});
