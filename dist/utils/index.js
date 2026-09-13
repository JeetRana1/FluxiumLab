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
var utils_exports = {};
__export(utils_exports, {
  default: () => utils_default
});
module.exports = __toCommonJS(utils_exports);
var import_axios = __toESM(require("axios"));
var import_outboundProxy = require("./outboundProxy");
var import_providers = __toESM(require("./providers"));
var cheerio = __toESM(require("cheerio"));
const routes = async (fastify, options) => {
  await fastify.register(new import_providers.default().getProviders);
  fastify.post("/anilist", async (request, reply) => {
    try {
      const body = request.body || {};
      const response = await import_axios.default.post("https://graphql.anilist.co", {
        query: body.query,
        variables: body.variables || {}
      }, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: 7e3,
        validateStatus: () => true
      });
      return reply.code(response.status).send(response.data);
    } catch (error) {
      return reply.code(502).send({ error: "AniList request failed", message: error?.message || "Upstream unavailable" });
    }
  });
  const normalizeTitleForMatch = (v) => String(v || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\(([^)]*)\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const toArrayPayload = (payload) => {
    if (Array.isArray(payload))
      return payload;
    if (Array.isArray(payload?.results))
      return payload.results;
    if (Array.isArray(payload?.data))
      return payload.data;
    return [];
  };
  const pickBestSearchResult = (title, results) => {
    const norm = normalizeTitleForMatch(title);
    if (!norm)
      return null;
    const titleTokens = new Set(norm.split(" ").filter(Boolean));
    let best = { score: 0, item: null };
    for (const item of results || []) {
      const name = String(
        item?.title || item?.name || item?.title_english || item?.titleEnglish || item?.japanese_title || ""
      ).trim();
      const itemNorm = normalizeTitleForMatch(name);
      if (!itemNorm)
        continue;
      let score = 0;
      if (itemNorm === norm)
        score += 120;
      if (itemNorm.includes(norm) || norm.includes(itemNorm))
        score += 30;
      const tokens = itemNorm.split(" ").filter(Boolean);
      let overlap = 0;
      tokens.forEach((t) => {
        if (titleTokens.has(t))
          overlap += 1;
      });
      score += overlap * 8;
      if (score > best.score)
        best = { score, item };
    }
    return best.score > 0 ? best.item : null;
  };
  const parseStatusFromEpisode = (ep) => {
    const boolFiller = ep?.isFiller === true || ep?.filler === true;
    const boolMixed = ep?.isMixed === true || ep?.mixed === true;
    const boolCanon = ep?.isMangaCanon === true || ep?.isCanon === true || ep?.mangaCanon === true || ep?.canon === true;
    const text = normalizeTitleForMatch(
      `${ep?.title || ""} ${ep?.description || ""} ${ep?.type || ""} ${ep?.category || ""}`
    );
    const textFiller = text.includes("filler");
    const textMixed = text.includes("mixed canon filler") || text.includes("mixed canon");
    const textCanon = text.includes("manga canon") || text.includes("canon");
    if (boolFiller || textFiller)
      return "filler";
    if (boolMixed || textMixed)
      return "mixed";
    if (boolCanon || textCanon)
      return "manga";
    return null;
  };
  const buildEpisodeStatusMap = (infoPayload) => {
    const map = {};
    const episodes = toArrayPayload(
      infoPayload?.episodes ? infoPayload.episodes : infoPayload
    );
    episodes.forEach((ep, idx) => {
      const epNo = Number(ep?.number || ep?.episodeNumber || ep?.episode || idx + 1);
      if (!Number.isFinite(epNo) || epNo <= 0)
        return;
      const status = parseStatusFromEpisode(ep);
      if (!status)
        return;
      map[String(epNo)] = status;
    });
    return map;
  };
  const fetchFillerFromMetaProvider = async (provider, title) => {
    try {
      const searchRes = await fastify.inject({
        method: "GET",
        url: `/meta/${provider}/${encodeURIComponent(title)}?page=1`
      });
      if (searchRes.statusCode >= 400)
        return { provider, id: null, episodes: {} };
      const searchPayload = JSON.parse(searchRes.body || "{}");
      const best = pickBestSearchResult(title, toArrayPayload(searchPayload));
      const contentId = best?.id || best?.anilistId || best?.malId || best?._id;
      if (!contentId)
        return { provider, id: null, episodes: {} };
      const infoRes = await fastify.inject({
        method: "GET",
        url: `/meta/${provider}/info/${encodeURIComponent(String(contentId))}?fetchFiller=true`
      });
      if (infoRes.statusCode >= 400)
        return { provider, id: contentId, episodes: {} };
      const infoPayload = JSON.parse(infoRes.body || "{}");
      return {
        provider,
        id: contentId,
        episodes: buildEpisodeStatusMap(infoPayload)
      };
    } catch {
      return { provider, id: null, episodes: {} };
    }
  };
  let aflIndexCache = null;
  const manifestCache = /* @__PURE__ */ new Map();
  const fetchFillerFromAFL = async (title) => {
    try {
      const buildSlugCandidates = (t) => {
        const raw = normalizeTitleForMatch(t);
        if (!raw)
          return [];
        const cleaned = raw.replace(/\b(tv|season|part|cour|movie|ona|ova)\b/g, " ").replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
        const tokens = cleaned.split(" ").filter(Boolean);
        if (!tokens.length)
          return [];
        return [
          tokens.join("-"),
          tokens.slice(0, 3).join("-"),
          tokens.slice(0, 2).join("-")
        ];
      };
      const slugCandidates = [...new Set(buildSlugCandidates(title))];
      if (!slugCandidates.length)
        return { id: null, episodes: {} };
      if (!aflIndexCache) {
        try {
          const { data } = await import_axios.default.get("https://www.animefillerlist.com/shows", {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36"
            },
            timeout: 1e4
          });
          const $ = cheerio.load(data);
          const entries = [];
          $("#ShowList .Group li a").each((_, el) => {
            const name = $(el).text().trim();
            const href = $(el).attr("href") || "";
            const slug = href.split("/").pop() || "";
            if (name && slug) {
              entries.push({ name, slug, norm: normalizeTitleForMatch(name) });
            }
          });
          if (entries.length > 0)
            aflIndexCache = entries;
        } catch {
        }
      }
      if (aflIndexCache && aflIndexCache.length > 0) {
        const titleTokens = new Set(
          normalizeTitleForMatch(title).split(" ").filter(Boolean)
        );
        let best = { score: 0, slug: "" };
        for (const entry of aflIndexCache) {
          const entryNorm = entry.norm;
          let score = 0;
          if (entryNorm === normalizeTitleForMatch(title))
            score += 100;
          if (entryNorm.includes(normalizeTitleForMatch(title)) || normalizeTitleForMatch(title).includes(entryNorm))
            score += 35;
          const entryTokens = entryNorm.split(" ").filter(Boolean);
          let overlap = 0;
          entryTokens.forEach((t) => {
            if (titleTokens.has(t))
              overlap += 1;
          });
          score += overlap * 8;
          if (score > best.score)
            best = { score, slug: entry.slug };
        }
        if (best.score >= 16 && best.slug) {
          slugCandidates.unshift(best.slug);
        }
      }
      const uniqueSlugs = [...new Set(slugCandidates.filter(Boolean))];
      for (const slug of uniqueSlugs) {
        try {
          const { data } = await import_axios.default.get(
            `https://www.animefillerlist.com/shows/${slug}`,
            {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36"
              },
              timeout: 8e3
            }
          );
          const $ = cheerio.load(data);
          const episodes = {};
          let found = false;
          $("table.EpisodeList tbody tr").each((_, el) => {
            const epNumStr = $(el).find("td.Number").text().trim();
            const epNum = parseInt(epNumStr, 10);
            if (isNaN(epNum))
              return;
            found = true;
            const typeStr = $(el).find("td.Type").text().trim().toLowerCase();
            let status = "manga";
            if (typeStr.includes("filler")) {
              if (typeStr.includes("mixed") || typeStr.includes("mostly"))
                status = "mixed";
              else
                status = "filler";
            } else if (typeStr.includes("canon")) {
              status = "manga";
            }
            episodes[epNum] = status;
          });
          if (found) {
            return { id: slug, episodes };
          }
        } catch {
        }
      }
    } catch {
    }
    return { id: null, episodes: {} };
  };
  const dummySegmentUrl = "data:application/octet-stream;";
  const proxyAffinityByHost = /* @__PURE__ */ new Map();
  const PROXY_AFFINITY_TTL_MS = 1e3 * 60 * 8;
  fastify.get("/audio_tam/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/audio_hin/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/audio_tel/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/audio_mal/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/audio_ben/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/audio_eng/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/audio_jpn/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_tam/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_hin/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_tel/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_mal/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_ben/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_eng/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/utils/audio_jpn/*", async (request, reply) => {
    return reply.header("Content-Type", "application/vnd.apple.mpegurl").send(
      `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,${dummySegmentUrl}
#EXT-X-ENDLIST`
    );
  });
  fastify.get("/proxy", async (request, reply) => {
    let url = String(request.query?.url || "");
    let referer = String(request.query?.referer || "");
    const incomingRange = String(request.headers?.range || "");
    if (!url)
      return reply.status(400).send({ message: "url is required" });
    for (let i = 0; i < 6; i += 1) {
      let nested;
      try {
        nested = new URL(url);
      } catch {
        break;
      }
      if (!/\/utils\/proxy$/i.test(nested.pathname))
        break;
      const innerUrl = nested.searchParams.get("url");
      if (!innerUrl)
        break;
      const innerReferer = nested.searchParams.get("referer");
      url = innerUrl;
      if (!referer && innerReferer)
        referer = innerReferer;
    }
    let target;
    try {
      target = new URL(url);
    } catch {
      return reply.status(400).send({ message: "invalid url" });
    }
    if (!["http:", "https:"].includes(target.protocol)) {
      return reply.status(400).send({ message: "invalid protocol" });
    }
    try {
      const pathLower = target.pathname.toLowerCase();
      const queryLower = target.search.toLowerCase();
      const looksLikeM3u8 = pathLower.endsWith(".m3u8") || pathLower.includes("playlist") || queryLower.includes(".m3u8");
      const looksLikeMediaSegment = /\.(ts|m4s|m4v|mp4|aac|mp3)(\?|$)/i.test(pathLower) || queryLower.includes(".m4s") || queryLower.includes(".ts");
      const isSwiftstreamOppaiMedia = /(^|\.)swiftstream\.top$/i.test(target.hostname) && /\/proxy\/oppai\//i.test(target.pathname);
      const boundedRange = incomingRange.replace(/^bytes=(\d+)-\s*$/i, (_match, start) => {
        const first = Number(start);
        return Number.isSafeInteger(first) && first >= 0 ? `bytes=${first}-${first + 4 * 1024 * 1024 - 1}` : incomingRange;
      });
      const upstreamRange = boundedRange || (isSwiftstreamOppaiMedia ? "bytes=0-" : "");
      let refererForRequest = referer || `${target.protocol}//${target.host}/`;
      if (/(?:(?:shiora|mikora)\.(?:top|site|club|net)|lostproject\.club)$/i.test(target.hostname) && /anikoto\.cz/i.test(refererForRequest)) {
        refererForRequest = "https://megaplay.buzz/";
      }
      if (/(^|\.)kryntal\.top$/i.test(target.hostname) && !/^https?:\/\/megaplay\.buzz\//i.test(refererForRequest)) {
        refererForRequest = "https://megaplay.buzz/";
      }
      if (/(^|\.)imgnex\.top$/i.test(target.hostname) && !/^https?:\/\/megaplay\.buzz\//i.test(refererForRequest)) {
        refererForRequest = "https://megaplay.buzz/";
      }
      const baseRequestConfig = {
        responseType: looksLikeM3u8 ? "arraybuffer" : "stream",
        timeout: looksLikeM3u8 ? 2e4 : looksLikeMediaSegment || isSwiftstreamOppaiMedia ? 25e3 : 3e4,
        headers: {
          Referer: refererForRequest,
          Origin: (() => {
            try {
              const u = new URL(refererForRequest);
              return `${u.protocol}//${u.host}`;
            } catch {
              return `${target.protocol}//${target.host}`;
            }
          })(),
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          ...upstreamRange ? { Range: upstreamRange } : {}
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 400
      };
      const proxyCandidates = await (0, import_outboundProxy.getProxyCandidates)();
      const chain = [void 0, ...proxyCandidates];
      const fetchWithChain = async (targetUrl, requestConfig) => {
        let lastErr = null;
        const host = (() => {
          try {
            return new URL(targetUrl).hostname.toLowerCase();
          } catch {
            return "";
          }
        })();
        const forceDirectOnly = /(^|\.)net20\.cc$/.test(host) || /(^|\.)nm-cdn\d+\.top$/.test(host) || host.includes("animesalt") || host.includes("sprintcdn") || host.includes("r66nv9ed");
        const sticky = proxyAffinityByHost.get(host);
        const stickyProxy = sticky && Date.now() - sticky.at < PROXY_AFFINITY_TTL_MS ? sticky.proxyUrl : void 0;
        const effectiveChain = forceDirectOnly ? [void 0] : [.../* @__PURE__ */ new Set([stickyProxy, ...chain])];
        if (effectiveChain.length <= 1) {
          try {
            const proxyOptions = (0, import_outboundProxy.toAxiosProxyOptions)(effectiveChain[0]);
            const upstream2 = await import_axios.default.get(targetUrl, {
              proxy: false,
              ...requestConfig,
              ...proxyOptions
            });
            return upstream2;
          } catch (err) {
            throw err;
          }
        }
        const attemptProxy = async (proxyUrl) => {
          const proxyOptions = (0, import_outboundProxy.toAxiosProxyOptions)(proxyUrl);
          let refererForRequest2 = requestConfig.headers.Referer || "";
          let originForRequest = requestConfig.headers.Origin || "";
          const isAnimesaltCdn = /(^|\.)(as-cdn\d+|z\d+|animesalt|as2|as-api)\.(cx|pro|ac|top|xyz|link|click|net|cc|org)$/i.test(
            target.hostname
          );
          const isHianimeCdn = /(^|\.)(rainveil\d*|megacloud\d*|rapid-cloud\d*|rabbitstream\d*|vizcloud\d*|cloud9|bunnycdn|vidcloud)\.(xyz|tv|ru|net|gg|co|online|pro|ac|cc|bz|li|to)$/i.test(
            target.hostname
          );
          const isAniKotoMegaplaySubtitle = /(^|\.)(nexabloom|shiora|mikora|imgnex|mewstream)\.(top|site|club|net)$/i.test(
            target.hostname
          ) && /(\/subtitles\/|\.(vtt|srt|ass|ssa)(\?|$))/i.test(target.pathname);
          if (isAniKotoMegaplaySubtitle) {
            if (!/megaplay\.buzz/i.test(refererForRequest2))
              refererForRequest2 = "https://megaplay.buzz/";
            if (!/megaplay\.buzz/i.test(originForRequest))
              originForRequest = "https://megaplay.buzz";
          }
          if (isAnimesaltCdn) {
            if (refererForRequest2.includes("animesalt.")) {
              refererForRequest2 = refererForRequest2.replace(
                /animesalt\.(cx|pro|xyz|click)/gi,
                "animesalt.cx"
              );
            } else if (!refererForRequest2) {
              refererForRequest2 = "https://animesalt.cx/";
            }
            if (originForRequest.includes("animesalt.")) {
              originForRequest = originForRequest.replace(
                /animesalt\.(cx|pro|xyz|click)/gi,
                "animesalt.cx"
              );
            } else if (!originForRequest) {
              originForRequest = "https://animesalt.cx";
            }
          }
          const perAttemptTimeout = Math.max(
            looksLikeM3u8 ? 9e3 : looksLikeMediaSegment ? 12e3 : 1e4,
            Math.min(
              Number(requestConfig.timeout || 12e3),
              looksLikeM3u8 ? 14e3 : 18e3
            )
          );
          const response = await import_axios.default.get(targetUrl, {
            proxy: false,
            ...requestConfig,
            timeout: perAttemptTimeout,
            headers: {
              ...requestConfig.headers,
              Referer: refererForRequest2,
              Origin: originForRequest
            },
            ...proxyOptions
          });
          proxyAffinityByHost.set(host, { proxyUrl, at: Date.now() });
          return response;
        };
        try {
          return await attemptProxy(void 0);
        } catch (e) {
          lastErr = e;
        }
        for (let i = 1; i < effectiveChain.length; i += 2) {
          const batch = effectiveChain.slice(i, i + 2);
          try {
            return await Promise.any(batch.map((p) => attemptProxy(p)));
          } catch (aggregateErr) {
            lastErr = aggregateErr;
          }
        }
        throw lastErr || new Error("proxy failed");
      };
      const cacheKey = `${target.toString()}|ref=${referer}`;
      let upstream = void 0;
      if (looksLikeM3u8) {
        const cached = manifestCache.get(cacheKey);
        if (cached && Date.now() - cached.at < cached.ttl) {
          upstream = {
            status: 200,
            data: Buffer.from(cached.raw, "utf8"),
            headers: {
              "content-type": cached.contentType || "application/vnd.apple.mpegurl"
            }
          };
        }
      }
      if (!upstream) {
        const maxFetchAttempts = looksLikeMediaSegment ? 3 : 1;
        let lastFetchError = null;
        for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
          try {
            upstream = await fetchWithChain(target.toString(), baseRequestConfig);
            break;
          } catch (error) {
            lastFetchError = error;
            if (attempt >= maxFetchAttempts)
              break;
            await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
          }
        }
        if (!upstream && lastFetchError)
          throw lastFetchError;
      }
      if (upstream.status >= 400) {
        return reply.status(upstream.status).send({
          message: `upstream error ${upstream.status}`
        });
      }
      const contentType = String(upstream.headers["content-type"] || "").toLowerCase();
      const mediaContentType = /\.mkv(?:$|[?#])/i.test(target.pathname) ? "video/x-matroska" : contentType;
      const isM3u8 = looksLikeM3u8 || contentType.includes("mpegurl") || contentType.includes("application/x-mpegurl") || contentType.includes("application/vnd.apple.mpegurl");
      let raw = "";
      if (isM3u8) {
        if (upstream.data && typeof upstream.data.pipe === "function") {
          raw = await new Promise((resolve, reject) => {
            let buf = "";
            upstream.data.on("data", (chunk) => buf += chunk.toString("utf8"));
            upstream.data.on("end", () => resolve(buf));
            upstream.data.on("error", reject);
          });
        } else {
          raw = Buffer.from(upstream.data).toString("utf8");
        }
        const base = target.toString();
        const normalizeManifestUri = (candidate) => {
          let c = String(candidate || "").trim();
          if (!c)
            return c;
          if (/^https?:\/\/\/+/i.test(c)) {
            c = c.replace(/^https?:\/\/\/+/i, "/");
          }
          if (/^https?:\/\/files\//i.test(c)) {
            const u = new URL(c);
            c = `/files${u.pathname}`;
            if (u.search)
              c += u.search;
          }
          return c;
        };
        const shouldProxyManifestUris = (() => {
          const host = target.hostname.toLowerCase();
          const ref = referer.toLowerCase();
          return /(^|\.)(as-cdn\d+|z\d+|as2|as-api)\.(top|pro|ac|xyz|link|click|net|cc|org)$/i.test(
            host
          ) || host.includes("animesalt") || host.includes("swiftstream") || host.includes("sprintcdn") || host.includes("r66nv9ed") || ref.includes("swiftstream") || ref.includes("animesalt") || ref.includes("flixhq") || ref.includes("vidking") || ref.includes("megacloud") || ref.includes("upcloud") || ref.includes("vidcloud");
        })();
        const proxyOrigin = (() => {
          const proto = String(
            request.headers["x-forwarded-proto"] || request.protocol || "http"
          ).split(",")[0].trim();
          const host = String(
            request.headers.host || request.hostname || "127.0.0.1:3000"
          );
          return `${proto}://${host}`;
        })();
        const rewriteUri = (candidate) => {
          try {
            const normalized = normalizeManifestUri(candidate);
            let abs = new URL(normalized, base).toString();
            for (let i = 0; i < 4; i += 1) {
              const nested = new URL(abs);
              if (!/\/utils\/proxy$/i.test(nested.pathname))
                break;
              const innerUrl = nested.searchParams.get("url");
              if (!innerUrl)
                break;
              abs = innerUrl;
            }
            if (shouldProxyManifestUris) {
              const ref = refererForRequest ? `&referer=${encodeURIComponent(refererForRequest)}` : "";
              return `${proxyOrigin}/utils/proxy?url=${encodeURIComponent(abs)}${ref}`;
            }
            return abs;
          } catch {
            return candidate;
          }
        };
        const isMasterManifest = raw.includes("#EXT-X-STREAM-INF");
        const isSkipProbeHost = true;
        const isNet20Manifest = isSkipProbeHost;
        const lines = raw.split("\n");
        const reachabilityCache = /* @__PURE__ */ new Map();
        const isUriReachable = async (candidate) => {
          try {
            const normalized = normalizeManifestUri(candidate);
            const abs = new URL(normalized, base).toString();
            if (reachabilityCache.has(abs))
              return reachabilityCache.get(abs);
            const probeTarget = new URL(abs);
            const probeReferer = referer || `${target.protocol}//${target.host}/`;
            const probeConfig = {
              responseType: "arraybuffer",
              timeout: 7e3,
              headers: {
                Referer: probeReferer,
                Origin: `${new URL(probeReferer).protocol}//${new URL(probeReferer).host}`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
              },
              maxRedirects: 3,
              validateStatus: () => true
            };
            const probe = await fetchWithChain(probeTarget.toString(), probeConfig);
            const ok = Number(probe?.status || 0) >= 200 && Number(probe?.status || 0) < 400;
            reachabilityCache.set(abs, ok);
            return ok;
          } catch {
            return false;
          }
        };
        let filteredLines = [...lines];
        const shouldFilterMasterVariants = !isNet20Manifest;
        if (isMasterManifest && shouldFilterMasterVariants) {
          const droppedLines = /* @__PURE__ */ new Set();
          let keptVariantCount = 0;
          let totalVariantCount = 0;
          for (let i = 0; i < lines.length; i++) {
            if (droppedLines.has(i))
              continue;
            const trimmed = String(lines[i] || "").trim();
            if (!trimmed)
              continue;
            if (trimmed.startsWith("#EXT-X-MEDIA:") && trimmed.includes('URI="')) {
              const match = /URI="([^"]+)"/.exec(trimmed);
              if (match?.[1]) {
                const ok = await isUriReachable(match[1]);
                if (!ok)
                  droppedLines.add(i);
              }
              continue;
            }
            if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
              totalVariantCount += 1;
              let j = i + 1;
              while (j < lines.length && !String(lines[j] || "").trim())
                j++;
              if (j >= lines.length)
                continue;
              const next = String(lines[j] || "").trim();
              if (!next || next.startsWith("#"))
                continue;
              const ok = await isUriReachable(next);
              if (!ok) {
                droppedLines.add(i);
                droppedLines.add(j);
              } else {
                keptVariantCount += 1;
              }
            }
          }
          if (totalVariantCount > 0 && keptVariantCount === 0) {
            return reply.status(502).send({ message: "no live variants in master manifest" });
          }
          if (keptVariantCount > 0) {
            filteredLines = lines.filter((_, idx) => !droppedLines.has(idx));
          }
        }
        const rewritten = filteredLines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed)
            return line;
          if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
            return line.replace(
              /URI="([^"]+)"/g,
              (_m, uri) => `URI="${rewriteUri(uri)}"`
            );
          }
          if (trimmed.startsWith("#") && trimmed.includes("URI='")) {
            return line.replace(
              /URI='([^']+)'/g,
              (_m, uri) => `URI='${rewriteUri(uri)}'`
            );
          }
          if (trimmed.startsWith("#"))
            return line;
          return rewriteUri(trimmed);
        }).join("\n");
        try {
          manifestCache.set(cacheKey, {
            at: Date.now(),
            ttl: 5e3,
            raw: rewritten,
            contentType: "application/vnd.apple.mpegurl"
          });
        } catch {
        }
        return reply.header("Content-Type", "application/vnd.apple.mpegurl").header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Headers", "Range,Content-Type").header("Access-Control-Expose-Headers", "Content-Length,Content-Range").header("Cache-Control", "no-cache, no-store, must-revalidate").header("Pragma", "no-cache").header("Expires", "0").send(rewritten);
      }
      const statusCode = Number(upstream.status) || 200;
      if (statusCode === 206) {
        reply.status(206);
      }
      const passHeaders = [
        "accept-ranges",
        "content-range",
        "content-length",
        "cache-control",
        "etag",
        "last-modified"
      ];
      for (const h of passHeaders) {
        const v = upstream.headers?.[h];
        if (v != null)
          reply.header(h, String(v));
      }
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Headers", "Range,Content-Type");
      reply.header("Access-Control-Expose-Headers", "Content-Length,Content-Range");
      if (!isM3u8 && upstream.data && typeof upstream.data.pipe === "function") {
        return reply.header("Content-Type", mediaContentType || "application/octet-stream").header("Connection", "keep-alive").header(
          "Cache-Control",
          String(
            upstream.headers?.["cache-control"] || "public, max-age=60, no-transform"
          )
        ).send(upstream.data);
      }
      return reply.header("Content-Type", mediaContentType || "application/octet-stream").send(Buffer.from(upstream.data));
    } catch (err) {
      return reply.status(502).send({ message: err?.message || "proxy failed" });
    }
  });
  fastify.get("/filler", async (request, reply) => {
    const title = String(request.query?.title || "").trim();
    if (!title)
      return reply.status(400).send({ message: "title is required" });
    const mal = await fetchFillerFromMetaProvider("mal", title);
    if (Object.keys(mal.episodes).length > 0) {
      return reply.status(200).send({
        title,
        source: "meta-mal",
        providerId: mal.id,
        episodes: mal.episodes
      });
    }
    const anilist = await fetchFillerFromMetaProvider("anilist", title);
    if (Object.keys(anilist.episodes).length > 0) {
      return reply.status(200).send({
        title,
        source: "meta-anilist",
        providerId: anilist.id,
        episodes: anilist.episodes
      });
    }
    const afl = await fetchFillerFromAFL(title);
    if (Object.keys(afl.episodes).length > 0) {
      return reply.status(200).send({
        title,
        source: "animefillerlist",
        providerId: afl.id,
        episodes: afl.episodes
      });
    }
    return reply.status(200).send({
      title,
      source: "none",
      episodes: {}
    });
  });
  fastify.get("/vtt", async (request, reply) => {
    const url = String(request.query?.url || "").trim();
    const referer = String(request.query?.referer || "").trim();
    if (!url)
      return reply.status(400).send("url is required");
    let target;
    try {
      target = new URL(url);
    } catch {
      return reply.status(400).send("invalid url");
    }
    if (!["http:", "https:"].includes(target.protocol)) {
      return reply.status(400).send("invalid protocol");
    }
    const getUrlVariants = (value) => {
      const variants = /* @__PURE__ */ new Set();
      const add = (candidate) => {
        const normalized = String(candidate || "").trim();
        if (!normalized)
          return;
        try {
          const parsed = new URL(normalized);
          if (["http:", "https:"].includes(parsed.protocol))
            variants.add(parsed.toString());
        } catch {
        }
      };
      add(value);
      try {
        add(decodeURI(value));
      } catch {
      }
      try {
        add(decodeURIComponent(value));
      } catch {
      }
      return [...variants];
    };
    const toShirnaProxyUrl = (subtitleUrl) => {
      const rawBase = String(process.env.SHIRNA_PROXY_URL || "").trim();
      if (!rawBase)
        return null;
      if (rawBase.includes("{url}"))
        return rawBase.replace("{url}", encodeURIComponent(subtitleUrl));
      if (/[?&](src|url)=$/i.test(rawBase))
        return `${rawBase}${encodeURIComponent(subtitleUrl)}`;
      const joiner = rawBase.includes("?") ? "&" : "?";
      return `${rawBase}${joiner}src=${encodeURIComponent(subtitleUrl)}`;
    };
    const refererForRequest = referer || `${target.protocol}//${target.host}/`;
    let originForRequest = refererForRequest;
    try {
      originForRequest = `${new URL(refererForRequest).protocol}//${new URL(refererForRequest).host}`;
    } catch {
    }
    const isAnimeSaltSubtitleHost = /(^|\.)(as-cdn\d+|z\d+|as2|as-api)\.(top|pro|ac|xyz|link|click|net|cc|org)$/i.test(
      target.hostname
    );
    const isKryntalSubtitleHost = /(^|\.)kryntal\.top$/i.test(target.hostname);
    const isAniKotoMegaplaySubtitleHost = /(^|\.)(nexabloom|shiora|mikora|imgnex|mewstream)\.(top|site|club|net)$/i.test(
      target.hostname
    ) && /(\/subtitles\/|\.(vtt|srt|ass|ssa)(\?|$))/i.test(target.pathname);
    const refererCandidates = (() => {
      const values = [
        refererForRequest,
        `${target.protocol}//${target.host}/`,
        isAnimeSaltSubtitleHost ? "https://animesalt.cx/" : "",
        isAnimeSaltSubtitleHost ? `${target.protocol}//${target.host}/` : "",
        // AniKoto's kryntal hosts reject the AniKoto/stream referer and only
        // serve subtitle VTTs with the Megaplay origin as Referer.
        isKryntalSubtitleHost ? "https://megaplay.buzz/" : "",
        isAniKotoMegaplaySubtitleHost ? "https://megaplay.buzz/" : ""
      ].filter(Boolean);
      return [...new Set(values)];
    })();
    const normalizeCueTimestamp = (value) => {
      const raw = String(value || "").trim().replace(",", ".");
      const match = raw.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
      if (!match)
        return raw;
      const hours = String(Number(match[1] || 0)).padStart(2, "0");
      const minutes = String(Number(match[2] || 0)).padStart(2, "0");
      const seconds = String(Number(match[3] || 0)).padStart(2, "0");
      const millis = String(match[4] || "000").padEnd(3, "0").slice(0, 3);
      return `${hours}:${minutes}:${seconds}.${millis}`;
    };
    const normalizeCueTimings = (text) => String(text || "").replace(
      /(\d+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*(\d+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)([^\n\r]*)/g,
      (_match, start, end, suffix) => `${normalizeCueTimestamp(start)} --> ${normalizeCueTimestamp(end)}${suffix || ""}`
    );
    const stripSubtitleMarkup = (text) => String(text || "").replace(/<\/?(i|b|u|font|c|ruby|rt|v)(?:\s+[^>]*)?>/gi, "").replace(/<[^>]+>/g, "");
    const sanitizeCueText = (text) => {
      const normalized = String(text || "").replace(/\r+/g, "").replace(/^\uFEFF/, "");
      return normalized.split("\n").map((line) => {
        const trimmed = line.trim();
        if (!trimmed)
          return "";
        if (/^WEBVTT$/i.test(trimmed))
          return line;
        if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(trimmed))
          return line;
        if (/^\d+$/.test(trimmed))
          return line;
        if (/-->/.test(line))
          return line;
        return stripSubtitleMarkup(line);
      }).join("\n");
    };
    const srtToVtt = (text) => {
      const clean = sanitizeCueText(normalizeCueTimings(text));
      return `WEBVTT

${clean}`;
    };
    const assTimeToVtt = (t) => {
      const m = String(t || "").trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,2})$/);
      if (!m)
        return "";
      return `${String(Number(m[1])).padStart(2, "0")}:${String(Number(m[2])).padStart(2, "0")}:${String(Number(m[3])).padStart(2, "0")}.${String(Math.round(Number(`0.${m[4] || "0"}`) * 1e3)).padStart(3, "0")}`;
    };
    const assToVtt = (text) => {
      const lines = text.replace(/\r+/g, "").replace(/^\uFEFF/, "").split("\n");
      const cues = [];
      let idx = 1;
      for (const line of lines) {
        const m = line.match(
          /^Dialogue:\s*[^,]*,([^,]+),([^,]+),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/i
        );
        if (!m)
          continue;
        const s = assTimeToVtt(m[1]);
        const e = assTimeToVtt(m[2]);
        if (!s || !e)
          continue;
        const txt = String(m[3] || "").replace(/\{[^}]*\}/g, "").replace(/\\N/gi, "\n").replace(/\\n/g, "\n").replace(/<[^>]+>/g, "").trim();
        if (!txt)
          continue;
        cues.push(`${idx++}
${s} --> ${e}
${txt}`);
      }
      return cues.length ? `WEBVTT

${cues.join("\n\n")}` : "";
    };
    try {
      const { getCachedSubtitleText } = await import("./browserRuntimeExtractor.js");
      const cachedSubtitle = getCachedSubtitleText(url);
      if (cachedSubtitle) {
        let raw2 = sanitizeCueText(cachedSubtitle);
        const isVtt2 = raw2.trim().toLowerCase().startsWith("webvtt");
        if (!isVtt2 && raw2.includes("-->"))
          raw2 = `WEBVTT

${raw2.replace(/\r+/g, "").replace(/^\uFEFF/, "")}`;
        return reply.header("Content-Type", "text/vtt; charset=utf-8").header("Access-Control-Allow-Origin", "*").header("Cache-Control", "public, max-age=1800").send(raw2);
      }
      const proxyCandidates = await (0, import_outboundProxy.getProxyCandidates)();
      const urlVariants = getUrlVariants(url);
      const targetRequests = [
        ...urlVariants.map((requestUrl) => ({ requestUrl, displayUrl: requestUrl })),
        ...urlVariants.map((requestUrl) => toShirnaProxyUrl(requestUrl)).filter((requestUrl) => Boolean(requestUrl)).map((requestUrl) => ({ requestUrl, displayUrl: requestUrl }))
      ];
      const chain = [void 0, ...proxyCandidates];
      let raw = "";
      let lastErr = null;
      for (const targetRequest of targetRequests) {
        for (const candidateReferer of refererCandidates) {
          let candidateOrigin = candidateReferer;
          try {
            candidateOrigin = `${new URL(candidateReferer).protocol}//${new URL(candidateReferer).host}`;
          } catch {
          }
          for (const proxyUrl of chain) {
            try {
              const { toAxiosProxyOptions: tap } = await import("./outboundProxy.js");
              const proxyOpts = tap(proxyUrl);
              const resp = await import_axios.default.get(targetRequest.requestUrl, {
                proxy: false,
                ...proxyOpts,
                responseType: "text",
                timeout: 15e3,
                headers: {
                  Accept: "text/vtt,text/plain,*/*",
                  Referer: candidateReferer,
                  Origin: candidateOrigin,
                  "X-Forward-Origin": candidateOrigin,
                  "X-Forward-Referer": candidateReferer,
                  "Sec-Fetch-Dest": "empty",
                  "Sec-Fetch-Mode": "cors",
                  "Sec-Fetch-Site": "cross-site",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                },
                maxRedirects: 5,
                validateStatus: (s) => s < 400
              });
              raw = String(resp.data || "");
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (raw)
            break;
        }
        if (raw)
          break;
      }
      if (!raw) {
        return reply.status(502).send(lastErr?.message || "upstream fetch failed");
      }
      const ln = raw.trim().toLowerCase();
      if (ln.startsWith("<!doctype html") || ln.startsWith("<html")) {
        return reply.status(502).send("upstream returned HTML error page");
      }
      let vtt = "";
      const trimmed = raw.trim();
      if (!trimmed.includes("-->") && trimmed.length > 50 && /^[a-z0-9+/= \n\r\t]+$/i.test(trimmed)) {
        try {
          const decoded = Buffer.from(trimmed.replace(/\s/g, ""), "base64").toString(
            "utf8"
          );
          if (decoded.includes("-->"))
            raw = decoded;
        } catch {
        }
      }
      const hasCue = raw.includes("-->");
      const hasSrt = /\d+:\d{1,2}:\d{1,2}[.,]\d{1,3}/.test(raw);
      const isAss = /^\s*\[Script Info\]/im.test(raw) || /^\s*\[Events\]/im.test(raw);
      const isSrt = /^\d+:\d{1,2}:\d{1,2}[,.]\d{1,3}$/.test(
        raw.split("\n").find((l) => l.includes(",")) || ""
      ) || hasCue && hasSrt && !raw.trim().toLowerCase().startsWith("webvtt");
      const isVtt = raw.trim().toLowerCase().startsWith("webvtt");
      if (isAss)
        vtt = assToVtt(raw);
      else if (isSrt)
        vtt = srtToVtt(raw);
      else if (isVtt)
        vtt = sanitizeCueText(normalizeCueTimings(raw));
      else if (hasCue)
        vtt = `WEBVTT

${sanitizeCueText(normalizeCueTimings(raw))}`;
      else
        vtt = raw;
      reply.header("Content-Type", "text/vtt; charset=utf-8").header("Access-Control-Allow-Origin", "*").header("Cache-Control", "public, max-age=3600").send(vtt);
    } catch (err) {
      return reply.status(502).send(err?.message || "vtt proxy failed");
    }
  });
  fastify.get("/", async (request, reply) => {
    reply.status(200).send("Welcome to Consumet Utils!");
  });
};
var utils_default = routes;
