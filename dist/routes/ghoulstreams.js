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
var ghoulstreams_exports = {};
__export(ghoulstreams_exports, {
  default: () => ghoulstreams_default
});
module.exports = __toCommonJS(ghoulstreams_exports);
var import_axios = __toESM(require("axios"));
var import_node_http = __toESM(require("node:http"));
var import_node_https = __toESM(require("node:https"));
var import_buffstreams = require("../providers/sports/buffstreams");
var import_racing = require("../providers/sports/racing");
var import_livesport_helper = require("../providers/sports/livesport-helper");
var import_cheerio = __toESM(require("cheerio"));
const httpAgent = new import_node_http.default.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64 });
const httpsAgent = new import_node_https.default.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64, maxCachedSessions: 512 });
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AVAILABILITY_TTL_MS = 1e3 * 60 * 45;
const WATCH_LOOKUP_TTL_MS = 1e3 * 20;
const streamAvailability = /* @__PURE__ */ new Map();
const watchLookupCache = /* @__PURE__ */ new Map();
const watchLookupInFlight = /* @__PURE__ */ new Map();
const proxyCache = /* @__PURE__ */ new Map();
const PROXY_CACHE_TTL_MS = 1e4;
const PROXY_CACHE_MAX = 500;
const pruneProxyCache = () => {
  const now = Date.now();
  let count = 0;
  for (const [key, entry] of proxyCache) {
    if (entry.expiresAt <= now) {
      proxyCache.delete(key);
      count++;
    }
    if (count > 100)
      break;
  }
};
setInterval(pruneProxyCache, 3e4);
const isAbsoluteHttpUrl = (value) => /^https?:\/\//i.test(String(value || "").trim());
const getQueryValue = (query, ...keys) => {
  const map = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(query || {}))
    map.set(String(key).toLowerCase(), value);
  for (const key of keys) {
    const value = map.get(String(key).toLowerCase());
    if (value !== void 0 && value !== null)
      return String(value).trim();
  }
  return "";
};
const dropConditionalHeaders = (headers) => {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "if-none-match" || lower === "if-modified-since" || lower === "if-match" || lower === "if-unmodified-since") {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
};
const setCorsHeaders = (reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Range, Origin, Referer, User-Agent, Accept, Accept-Encoding"
  );
  reply.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  reply.header(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  );
};
const streamUpstreamToReply = async (targetUrl, headers, reply) => {
  const url = new URL(targetUrl);
  const client = url.protocol === "https:" ? import_node_https.default : import_node_http.default;
  const cacheKey = targetUrl;
  const cached = proxyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    reply.hijack();
    reply.raw.writeHead(cached.status, cached.headers);
    reply.raw.end(cached.body);
    return;
  }
  return await new Promise((resolve, reject) => {
    const req = client.request(
      targetUrl,
      {
        method: "GET",
        headers,
        agent: url.protocol === "https:" ? httpsAgent : httpAgent
      },
      (res) => {
        reply.hijack();
        reply.status(res.statusCode || 200);
        const responseHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, Origin, Referer, User-Agent, Accept, Accept-Encoding",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type"
        };
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === void 0)
            continue;
          const lower = key.toLowerCase();
          if (lower === "transfer-encoding")
            continue;
          if (lower.startsWith("access-control-"))
            continue;
          responseHeaders[key] = String(value);
        }
        const shouldCache = proxyCache.size < PROXY_CACHE_MAX && !responseHeaders["content-range"];
        let cacheBuf = shouldCache ? [] : null;
        if (shouldCache) {
          res.on("data", (chunk) => cacheBuf.push(chunk));
        }
        reply.raw.writeHead(res.statusCode || 200, responseHeaders);
        res.pipe(reply.raw);
        res.on("error", reject);
        res.on("end", () => {
          if (shouldCache && cacheBuf.length > 0) {
            proxyCache.set(cacheKey, { body: Buffer.concat(cacheBuf), headers: responseHeaders, status: res.statusCode || 200, expiresAt: Date.now() + PROXY_CACHE_TTL_MS });
          }
          resolve();
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
};
const pruneAvailability = () => {
  const now = Date.now();
  for (const [id, value] of streamAvailability.entries()) {
    if (!value?.updatedAt || now - value.updatedAt > AVAILABILITY_TTL_MS) {
      streamAvailability.delete(id);
    }
  }
};
const getAvailabilitySnapshot = () => {
  pruneAvailability();
  const snapshot = {};
  for (const [id, value] of streamAvailability.entries())
    snapshot[id] = value;
  return snapshot;
};
const setStreamAvailability = (id, isLive, reason = "") => {
  const key = String(id || "").trim();
  if (!key)
    return;
  streamAvailability.set(key, {
    isLive: Boolean(isLive),
    reason: String(reason || ""),
    updatedAt: Date.now()
  });
};
const getCachedLookup = async (key, fetcher, ttlMs = WATCH_LOOKUP_TTL_MS) => {
  const cacheKey = String(key || "").trim();
  const now = Date.now();
  const cached = watchLookupCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inflight = watchLookupInFlight.get(cacheKey);
  if (inflight)
    return inflight;
  const promise = (async () => {
    try {
      const value = await fetcher();
      watchLookupCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
      return value;
    } finally {
      watchLookupInFlight.delete(cacheKey);
    }
  })();
  watchLookupInFlight.set(cacheKey, promise);
  return promise;
};
const buildHlsProxyPath = (targetUrl, referer = "") => {
  const hostEnd = targetUrl.indexOf("/", targetUrl.indexOf("://") + 3);
  if (hostEnd === -1)
    return `/proxy/hls/${new URL(targetUrl).host}/`;
  const qsStart = targetUrl.indexOf("?", hostEnd);
  const rawPath = qsStart >= 0 ? targetUrl.slice(hostEnd, qsStart) : targetUrl.slice(hostEnd);
  const rawQuery = qsStart >= 0 ? targetUrl.slice(qsStart + 1) : "";
  const host = new URL(targetUrl).host;
  const newQuery = referer ? `${rawQuery}${rawQuery ? "&" : ""}referer=${encodeURIComponent(referer)}` : rawQuery;
  return `/proxy/hls/${host}${rawPath}${newQuery ? `?${newQuery}` : ""}`;
};
const noStoreHeaders = async (_request, reply) => {
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
  reply.header("Surrogate-Control", "no-store");
};
const routes = async (fastify, _options) => {
  const buffstreams = new import_buffstreams.BuffStreams();
  const racing = new import_racing.Racing();
  fastify.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      await noStoreHeaders(request, reply);
    }
  });
  fastify.post("/api/search", async (request, reply) => {
    try {
      const { query, date } = request.body || {};
      let results = await buffstreams.search(String(query || ""), {
        date: String(date || "") || void 0
      });
      for (const result of results || []) {
        if (result?.isLive === true) {
          setStreamAvailability(
            String(result.id || result.url || ""),
            true,
            "source_available"
          );
        }
      }
      return reply.send({ success: true, data: results });
    } catch (error) {
      return reply.send({ success: false, error: error?.message || "search_failed" });
    }
  });
  fastify.get("/api/stream-statuses", async (_request, reply) => {
    return reply.send({ success: true, data: getAvailabilitySnapshot() });
  });
  fastify.post(
    "/api/report-stream-status",
    async (request, reply) => {
      try {
        const { id, isLive, reason } = request.body || {};
        setStreamAvailability(
          String(id || ""),
          Boolean(isLive),
          String(reason || "reported")
        );
        return reply.send({ success: true });
      } catch (error) {
        return reply.send({ success: false, error: error?.message || "report_failed" });
      }
    }
  );
  fastify.post("/api/fetchInfo", async (request, reply) => {
    try {
      const { id } = request.body || {};
      const target = String(id || "").trim();
      const cacheKey = `fetchInfo:${target}`;
      const isRacing = /fullraces|formula-1|nascar|indycar|motogp|racing/i.test(target);
      const info = await getCachedLookup(
        cacheKey,
        async () => isRacing ? await racing.fetchMediaInfo(target) : await buffstreams.fetchMediaInfo(target)
      );
      return reply.send({ success: true, data: info });
    } catch (error) {
      return reply.send({ success: false, error: error?.message || "fetch_info_failed" });
    }
  });
  fastify.post(
    "/api/fetchSources",
    async (request, reply) => {
      try {
        const { eventUrl, embedUrl } = request.body || {};
        const target = String(eventUrl || embedUrl || "").trim();
        const cacheKey = `fetchSources:${target}`;
        const isRacing = /fullraces|formula-1|nascar|indycar|motogp|racing/i.test(target);
        let data = await getCachedLookup(
          cacheKey,
          async () => isRacing ? await racing.fetchEpisodeSources(target) : await buffstreams.fetchEpisodeSources(target)
        );
        const resolvedEmbedUrl = String(data?.embedUrl || "").trim();
        if (!isRacing && resolvedEmbedUrl && isAbsoluteHttpUrl(resolvedEmbedUrl)) {
          data.sources = [
            {
              url: resolvedEmbedUrl,
              server: "Embed",
              quality: "auto",
              isM3U8: false,
              isDirect: false,
              engine: "iframe",
              headers: data?.headers || {}
            }
          ];
        }
        if (Array.isArray(data?.sources) && data.sources.length > 0) {
          setStreamAvailability(target, true, "source_available");
        } else if (!Array.isArray(data?.sources) || data.sources.length === 0) {
          const fallbackEmbed = String(data?.embedUrl || "").trim();
          if (fallbackEmbed) {
            data.sources = [
              {
                url: fallbackEmbed,
                server: "Embed",
                quality: "auto",
                isM3U8: false,
                engine: "iframe",
                headers: data?.headers || {}
              }
            ];
          }
        }
        return reply.send({ success: true, data });
      } catch (error) {
        return reply.send({
          success: false,
          error: error?.message || "fetch_sources_failed"
        });
      }
    }
  );
  fastify.post(
    "/api/matchDetails",
    async (request, reply) => {
      try {
        const { title, sport } = request.body || {};
        if (!title)
          return reply.send({ success: false, error: "title required" });
        const client = import_axios.default.create();
        const cacheKey = `matchDetails:${String(title || "").trim()}:${String(
          sport || "sports"
        ).trim().toLowerCase()}`;
        const data = await getCachedLookup(
          cacheKey,
          async () => import_livesport_helper.LiveSportHelper.getLiveStats(client, String(title), String(sport || "sports"))
        );
        return reply.send({ success: true, data: data || null });
      } catch (error) {
        return reply.send({
          success: true,
          data: null,
          error: error?.message || "match_details_failed"
        });
      }
    }
  );
  fastify.get(
    "/api/livesport-directory",
    async (_request, reply) => {
      try {
        const client = import_axios.default.create();
        const data = await import_livesport_helper.LiveSportHelper.getGlobalDirectory(client);
        const matches = data?.matches || [];
        if (matches.length > 0) {
          return reply.send({ success: true, data: { matches } });
        }
        throw new Error("empty directory");
      } catch (error) {
        return reply.send({
          success: true,
          data: { matches: [] },
          error: error?.message || "livesport_directory_failed"
        });
      }
    }
  );
  fastify.get(
    "/api/racing/catalog",
    async (request, reply) => {
      try {
        const category = String(
          request.query?.category || ""
        ).trim();
        const data = await racing.fetchCatalogLatest({
          query: category === "racing" ? "" : category,
          forceRefresh: false
        });
        return reply.send({ success: true, data });
      } catch (error) {
        return reply.send({
          success: true,
          data: [],
          error: error?.message || "racing_catalog_failed"
        });
      }
    }
  );
  fastify.get(
    "/api/racing/watch",
    async (request, reply) => {
      try {
        const episodeId = String(
          request.query?.episodeId || request.query?.url || ""
        ).trim();
        if (!episodeId)
          return reply.send({
            success: false,
            error: "episodeId required",
            data: { sources: [] }
          });
        const data = await racing.fetchEpisodeSources(episodeId);
        return reply.send({ success: true, data });
      } catch (error) {
        return reply.send({
          success: true,
          data: { sources: [] },
          error: error?.message || "racing_watch_failed"
        });
      }
    }
  );
  fastify.get(
    "/api/media-proxy",
    async (request, reply) => {
      try {
        const query = request.query;
        const targetUrl = getQueryValue(query, "url", "URL");
        const referer = getQueryValue(query, "referer", "Referer");
        const rootReferer = getQueryValue(
          query,
          "root_referer",
          "rootReferer",
          "root-referer"
        );
        const origin = getQueryValue(query, "origin", "Origin");
        const userAgent = getQueryValue(query, "user_agent", "user-agent", "User-Agent");
        if (!targetUrl || !isAbsoluteHttpUrl(targetUrl)) {
          return reply.status(400).send("Invalid or missing target URL parameter");
        }
        const outboundHeaders = dropConditionalHeaders({
          Referer: referer || rootReferer || "https://streameeeeee.site/",
          ...origin ? { Origin: origin } : {},
          "User-Agent": userAgent || USER_AGENT,
          Accept: "application/vnd.apple.mpegurl,text/plain,video/*,audio/*,*/*;q=0.8",
          "Accept-Encoding": "identity",
          ...request.headers.range ? { Range: String(request.headers.range) } : {}
        });
        setCorsHeaders(reply);
        reply.header(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate"
        );
        reply.header("Pragma", "no-cache");
        reply.header("Expires", "0");
        reply.removeHeader("etag");
        reply.removeHeader("last-modified");
        return await streamUpstreamToReply(targetUrl, outboundHeaders, reply);
      } catch (error) {
        if (reply.raw.headersSent)
          return;
        setCorsHeaders(reply);
        return reply.status(500).send(error?.message || "media_proxy_failed");
      }
    }
  );
  fastify.get(
    "/api/image-proxy",
    async (request, reply) => {
      try {
        const targetUrl = String(request.query.url || "").trim();
        if (!targetUrl || !isAbsoluteHttpUrl(targetUrl)) {
          return reply.status(400).send("Invalid or missing image URL");
        }
        const query = request.query;
        const referer = getQueryValue(query, "referer", "Referer") || "https://www.flashscore.com/";
        const response = await import_axios.default.get(targetUrl, {
          responseType: "arraybuffer",
          timeout: 8e3,
          headers: {
            "User-Agent": USER_AGENT,
            Referer: referer,
            Accept: "image/*,*/*;q=0.8"
          },
          validateStatus: (status) => status < 500
        });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Cache-Control", "public, max-age=86400");
        if (response.headers["content-type"])
          reply.header("Content-Type", response.headers["content-type"]);
        return reply.status(response.status).send(Buffer.from(response.data));
      } catch (error) {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Cache-Control", "public, max-age=3600");
        reply.header("Content-Type", "image/svg+xml");
        return reply.status(200).send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="%23666"><circle cx="24" cy="24" r="24" fill="%23333"/><text x="24" y="24" text-anchor="middle" dominant-baseline="central" font-size="20" fill="%23666">?</text></svg>');
      }
    }
  );
  fastify.post("/api/resolve-server-embed", async (request, reply) => {
    try {
      const { url } = request.body || {};
      if (!url)
        return reply.send({ success: false, error: "no_url" });
      const response = await import_axios.default.get(url, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 1e4
      });
      const html = String(response.data || "");
      const $ = import_cheerio.default.load(html);
      const knownIds = ["wp_player", "player", "main-player", "video-player", "stream-player", "embed-player", "live-stream"];
      for (const id of knownIds) {
        const iframe = $(`iframe#${id}`);
        if (iframe.length) {
          const src = iframe.attr("src");
          if (src)
            return reply.send({ success: true, embedUrl: src });
        }
      }
      const knownClasses = ["embed-responsive-item", "player-iframe", "stream-iframe", "video-iframe"];
      for (const cls of knownClasses) {
        const iframe = $(`iframe.${cls}`);
        if (iframe.length) {
          const src = iframe.attr("src");
          if (src)
            return reply.send({ success: true, embedUrl: src });
        }
      }
      const allIframes = $("iframe");
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr("src") || "";
        if (/gooz\.aapmains|embed|stream|player|watch/i.test(src) && !/youtube.*chat|live.*chat|googleads|doubleclick|facebook/i.test(src)) {
          return reply.send({ success: true, embedUrl: src });
        }
      }
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr("src") || "";
        if (src && src.startsWith("http") && !/youtube.*chat|googleads|doubleclick/i.test(src)) {
          return reply.send({ success: true, embedUrl: src });
        }
      }
      const embedPattern = /gooz\.aapmains\.net\/new-stream-embed\/(\d+)/i;
      const jsMatch = html.match(embedPattern);
      if (jsMatch) {
        return reply.send({ success: true, embedUrl: "https://" + jsMatch[0] });
      }
      return reply.send({ success: true, embedUrl: "" });
    } catch (error) {
      return reply.send({ success: false, error: error?.message || "resolve_failed" });
    }
  });
  fastify.get("/api/iframe-proxy", async (request, reply) => {
    try {
      const targetUrl = String(request.query.url || "").trim();
      const referer = String(request.query.referer || "").trim();
      if (!targetUrl)
        return reply.status(400).send("Missing url param");
      const upstreamHeaders = {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      };
      if (referer) {
        upstreamHeaders["Referer"] = referer;
        try {
          upstreamHeaders["Origin"] = new URL(referer).origin;
        } catch {
        }
      }
      const resp = await import_axios.default.get(targetUrl, {
        headers: upstreamHeaders,
        timeout: 15e3,
        responseType: "text"
      });
      let html = String(resp.data || "");
      const base = (() => {
        try {
          return new URL(targetUrl).origin;
        } catch {
          return "";
        }
      })();
      if (base) {
        html = html.replace(
          /(<(?:img|script|link|source|video|audio|iframe)\b[^>]*?)(src=|href=)(["'])(?!https?:\/\/|\/\/|data:|#|javascript:)/gi,
          "$1$2$3" + base + "/"
        );
      }
      const proto = request.headers["x-forwarded-proto"] || request.protocol;
      const proxyBase = `${proto}://${request.headers.host}`;
      const escTargetUrl = encodeURIComponent(targetUrl);
      const xhrOverride = `<script>
var PROXY_BASE='${proxyBase}';
var _isLocal=PROXY_BASE.indexOf('localhost')>=0||PROXY_BASE.indexOf('127.0.0.1')>=0||PROXY_BASE.indexOf('192.168.')>=0;
function _shouldProxy(u){
var url=typeof u==='string'?u:'';
if(!url) return false;
if(url.indexOf(PROXY_BASE)>=0) return false;
if(!_isLocal){
var lu=url.toLowerCase();
var qi=lu.indexOf('?');
var base=qi>=0?lu.substring(0,qi):lu;
if(base.indexOf('.ts')>=0||base.indexOf('.m4s')>=0||base.indexOf('.m4v')>=0) return false;
}
return url.indexOf('http://')===0||url.indexOf('https://')===0;
}
var ro=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
var url=typeof u==='string'?u:'';
if(_shouldProxy(url)&&url.indexOf(PROXY_BASE)<0){u=PROXY_BASE+'/api/media-proxy?url='+encodeURIComponent(url)+'&referer=${escTargetUrl}&root_referer=${escTargetUrl}'}
return ro.apply(this,arguments)
};
var rf=window.fetch;
window.fetch=function(u,o){
var url=typeof u==='string'?u:'';
if(_shouldProxy(url)&&url.indexOf(PROXY_BASE)<0){u=PROXY_BASE+'/api/media-proxy?url='+encodeURIComponent(url)+'&referer=${escTargetUrl}&root_referer=${escTargetUrl}'}
return rf.call(this,u,o)
};
</script>`;
      const hlsPatch = `<script>
(function(){
var d=document.createDocumentFragment();
var s=document.createElement('script');
s.textContent='if(typeof Hls!==\\"undefined\\"&&Hls.DefaultConfig){Hls.DefaultConfig.liveSyncDuration=90;Hls.DefaultConfig.maxBufferLength=90;Hls.DefaultConfig.maxMaxBufferLength=120;Hls.DefaultConfig.maxBufferSize=200*1000*1000;Hls.DefaultConfig.backBufferLength=60;Hls.DefaultConfig.liveBackBufferLength=30;Hls.DefaultConfig.maxLiveSyncPlaybackRate=1.02;Hls.DefaultConfig.startLevel=0;Hls.DefaultConfig.abrEwmaDefaultEstimate=500000;Hls.DefaultConfig.capLevelToPlayerSize=true;Hls.DefaultConfig.testBandwidth=false;Hls.DefaultConfig.lowLatencyMode=false;Hls.DefaultConfig.startFragPrefetch=true;Hls.DefaultConfig.fragLoadingTimeOut=15000;Hls.DefaultConfig.fragLoadingRetryDelay=500;Hls.DefaultConfig.levelLoadingRetryDelay=500}';
d.appendChild(s);
document.head.appendChild(d);
})();
</script>`;
      const fitToggle = `<script>
function _fitMain(){
var isiOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
var mobileLike=window.matchMedia&&window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
var vp=document.querySelector('meta[name="viewport"]');
if(vp){if(vp.content.indexOf('viewport-fit=cover')<0)vp.content+=', viewport-fit=cover'}else{vp=document.createElement('meta');vp.name='viewport';vp.content='width=device-width,initial-scale=1,viewport-fit=cover';document.head.appendChild(vp)}
var st=document.createElement('style');
st.textContent='html,body{margin:0!important;padding:0!important;background:#000!important;overflow:hidden!important;text-align:center!important}video{background:#000!important;object-position:center center;display:block!important;margin:0 auto!important}video,iframe{max-width:none!important}:fullscreen,video:fullscreen,video:-webkit-full-screen,:-webkit-full-screen,:fullscreen video,:-webkit-full-screen video,html.__gs-pfs .__gs-pfs-target,html.__gs-pfs .__gs-pfs-target video{margin:0!important;padding:0!important;inset:0!important;left:0!important;top:0!important;width:100%!important;height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;box-sizing:border-box!important;background:#000!important;object-position:center center!important}html.__gs-pfs,html.__gs-pfs body{overflow:hidden!important;background:#000!important}html.__gs-pfs .__gs-pfs-target{position:fixed!important;z-index:2147483000!important;transform:none!important;border:0!important;border-radius:0!important}';
document.head.appendChild(st);
var i=['<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 2v3M12 19v3M3 12H1M21 12h2"/></svg>','<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="6" y="7" width="12" height="10" rx="1"/></svg>','<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M1 8h2M1 16h2M21 8h2M21 16h2"/></svg>','<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9l-3 3 3 3M16 9l3 3-3 3"/></svg>'];
var vals=['cover','contain','fill','scale-down'],lbl=['Cover','Contain','Fill','Stretch'],idx=0,vid=null;
var b=document.createElement('div');
var pfs=null;
b.id='__fitBtn';
b.style.cssText='position:fixed;top:12px;left:12px;right:auto;z-index:2147483647;cursor:pointer;display:none;align-items:center;gap:5px;background:rgba(0,0,0,.72);color:#fff;border-radius:6px;padding:5px 9px;font:11px/1 Arial,sans-serif;-webkit-user-select:none;user-select:none;border:1px solid rgba(255,255,255,.12);transition:opacity .3s ease';
b.onmouseover=function(){this.style.background='rgba(0,0,0,.88)'};
b.onmouseout=function(){this.style.background='rgba(0,0,0,.72)'};
function apply(n){if(!vid)return;idx=n;vid.style.objectFit=vals[idx];b.innerHTML=i[idx]+' '+lbl[idx];b.title=lbl[idx]}
var _hid=null;
function _rst(){if(_hid){clearTimeout(_hid)}if(b.style.display!=='none'){b.style.opacity='1';b.style.pointerEvents='';_hid=setTimeout(function(){b.style.opacity='0';b.style.pointerEvents='none'},4000)}}
function _clr(){if(_hid){clearTimeout(_hid);_hid=null}}
function show(){var v=document.querySelector('video');if(v&&v!==vid){vid=v;apply(0);b.style.display='flex';_rst()}else if(!document.querySelector('video')){b.style.display='none';_clr()}}
b.onclick=function(){apply((idx+1)%vals.length);_rst()};
function lockFsOrientation(){try{if(mobileLike&&screen.orientation&&screen.orientation.lock)screen.orientation.lock('landscape').catch(function(){})}catch(e){}}
function unlockFsOrientation(){try{if(screen.orientation&&screen.orientation.unlock)screen.orientation.unlock()}catch(e){}}
function enterPseudoFs(el){
if(!mobileLike||!isiOS||pfs)return;
var t=el&&el.nodeType===1?el:(vid&&vid.parentElement)||vid;
if(!t)return;
pfs=t;
t.classList.add('__gs-pfs-target');
document.documentElement.classList.add('__gs-pfs');
if(!t.contains(b))t.appendChild(b);
if(vid){vid.style.width='100%';vid.style.height='100%'}
lockFsOrientation();
}
function exitPseudoFs(){
if(!pfs)return;
pfs.classList.remove('__gs-pfs-target');
pfs=null;
document.documentElement.classList.remove('__gs-pfs');
if(vid){vid.style.width='';vid.style.height=''}
if(b.parentNode!==document.body)document.body.appendChild(b);
unlockFsOrientation();
}
var rq=Element.prototype.requestFullscreen;if(rq)Element.prototype.requestFullscreen=function(){if(mobileLike&&isiOS){enterPseudoFs(this);return Promise.resolve()}return rq.apply(this,arguments)};
var wrq=Element.prototype.webkitRequestFullscreen;if(wrq)Element.prototype.webkitRequestFullscreen=function(){if(mobileLike&&isiOS){enterPseudoFs(this);return}return wrq.apply(this,arguments)};
var vfs=HTMLVideoElement.prototype.webkitEnterFullscreen;if(vfs)HTMLVideoElement.prototype.webkitEnterFullscreen=function(){if(mobileLike&&isiOS){enterPseudoFs(this);return}return vfs.apply(this,arguments)};
var vxfs=HTMLVideoElement.prototype.webkitExitFullscreen;if(vxfs)HTMLVideoElement.prototype.webkitExitFullscreen=function(){if(pfs){exitPseudoFs();return}return vxfs.apply(this,arguments)};
var ex=document.exitFullscreen;if(ex)document.exitFullscreen=function(){if(pfs){exitPseudoFs();return Promise.resolve()}return ex.apply(this,arguments)};
var wex=document.webkitExitFullscreen;if(wex)document.webkitExitFullscreen=function(){if(pfs){exitPseudoFs();return}return wex.apply(this,arguments)};
function onfs(){
try{
var f=document.fullscreenElement||document.webkitFullscreenElement||pfs;
if(f&&f!==document.documentElement&&f!==document.body){
if(!f.contains(b))f.appendChild(b);
if(vid){vid.style.width='100%';vid.style.height='100%'}
lockFsOrientation();
}else if(!f){
if(vid){vid.style.width='';vid.style.height=''}
if(b.parentNode!==document.body)document.body.appendChild(b);
unlockFsOrientation();
}
}catch(e){}
}
document.addEventListener('fullscreenchange',onfs);
document.addEventListener('webkitfullscreenchange',onfs);
document.body.appendChild(b);
show();
if(vid){vid.addEventListener('mousemove',_rst);vid.addEventListener('touchstart',_rst);vid.addEventListener('touchmove',_rst);vid.addEventListener('pointermove',_rst)}
document.addEventListener('mousemove',_rst);
document.addEventListener('touchstart',_rst);
document.addEventListener('touchmove',_rst);
document.addEventListener('pointermove',_rst);
b.addEventListener('mouseenter',function(){_clr();b.style.opacity='1';b.style.pointerEvents=''});
b.addEventListener('mouseleave',_rst);
new MutationObserver(function(){var ov=vid;show();if(vid&&vid!==ov){vid.addEventListener('mousemove',_rst);vid.addEventListener('touchstart',_rst);vid.addEventListener('touchmove',_rst);vid.addEventListener('pointermove',_rst)}}).observe(document.body,{childList:true,subtree:true});
}
if(document.body)_fitMain();else document.addEventListener('DOMContentLoaded',_fitMain);
</script>`;
      html = html.replace("</head>", xhrOverride + hlsPatch + fitToggle + "</head>");
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("X-Frame-Options", "ALLOWALL");
      reply.header("Content-Security-Policy", "frame-ancestors * 'self'; script-src * 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob: *; style-src * 'unsafe-inline'");
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      reply.header("Pragma", "no-cache");
      reply.header("Expires", "0");
      return reply.status(200).send(html);
    } catch (error) {
      return reply.status(502).send("Proxy error: " + (error?.message || ""));
    }
  });
};
var ghoulstreams_default = routes;
