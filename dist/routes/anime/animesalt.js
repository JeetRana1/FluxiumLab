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
var animesalt_exports = {};
__export(animesalt_exports, {
  default: () => animesalt_default
});
module.exports = __toCommonJS(animesalt_exports);
var cheerio = __toESM(require("cheerio"));
var import_outboundProxy = require("../../utils/outboundProxy");
var import_cache = __toESM(require("../../utils/cache"));
var import_main = require("../../main");
var import_anilist = __toESM(require("@consumet/extensions/dist/providers/meta/anilist"));
const WATCH_META_TTL_MS = 5 * 6e4;
const watchMetaCache = /* @__PURE__ */ new Map();
const getWatchMeta = (key) => {
  const entry = watchMetaCache.get(key);
  if (!entry)
    return null;
  if (Date.now() > entry.expiresAt) {
    watchMetaCache.delete(key);
    return null;
  }
  return entry.value;
};
const setWatchMeta = (key, value) => {
  watchMetaCache.set(key, { expiresAt: Date.now() + WATCH_META_TTL_MS, value });
};
const BASE_URL = "https://animesalt.cx";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const normalizeAnimeSaltSearchText = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[×✕]/g, "x").replace(/[‐‑‒–—―]/g, "-").replace(/[_-]+/g, " ").replace(/[:;,.!?()[\]{}"'’]/g, " ").replace(/\s+/g, " ").trim();
const buildAnimeSaltSearchQueries = (query) => {
  const raw = String(query || "").replace(/\s+/g, " ").trim();
  const folded = normalizeAnimeSaltSearchText(raw);
  const withoutSeason = folded.replace(/\b(season|part|cour|arc)\s*\d+\b/gi, " ").replace(/\s+/g, " ").trim();
  const short = folded.split(" ").slice(0, 4).join(" ");
  return Array.from(
    new Set([raw, folded, withoutSeason, short].filter((q) => q && q.length >= 2))
  );
};
const decodePlayerString = (value) => String(value || "").replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/\\u003d/g, "=").replace(/\\u003a/g, ":").replace(/&amp;/gi, "&").replace(/&#038;/gi, "&").trim();
const absolutizeAnimeSaltUrl = (value, baseUrl) => {
  const raw = decodePlayerString(value);
  if (!raw)
    return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
};
const pushAnimeSaltSubtitle = (subtitles, seen, lang, url, referer) => {
  const resolvedUrl = absolutizeAnimeSaltUrl(url, referer || BASE_URL);
  if (!resolvedUrl || seen.has(resolvedUrl))
    return;
  seen.add(resolvedUrl);
  subtitles.push({
    lang: String(lang || "English").replace(/^[-\s]+|[-\s]+$/g, "").trim() || "English",
    url: resolvedUrl,
    referer,
    provider: "animesalt"
  });
};
const extractAnimeSaltSubtitles = (html, referer) => {
  const page = String(html || "");
  const subtitles = [];
  const seen = /* @__PURE__ */ new Set();
  const parseBracketList = (value) => {
    const raw = decodePlayerString(value);
    const parts = raw.split(/,(?=\[[^\]]+\])/g);
    for (const part of parts) {
      const match = String(part || "").trim().match(/^\[([^\]]+)\]\s*(.+)$/);
      if (!match)
        continue;
      pushAnimeSaltSubtitle(subtitles, seen, match[1], match[2], referer);
    }
  };
  const stringPatterns = [
    /(?:var\s+)?playerjsSubtitle\s*=\s*(["'`])([\s\S]*?)\1\s*;?/gi,
    /(?:subtitle|subtitles|tracks)\s*:\s*(["'`])(\[[^\]]+\][\s\S]*?)\1/gi,
    /(?:subtitle|subtitles)\s*=\s*(["'`])(\[[^\]]+\][\s\S]*?)\1\s*;?/gi
  ];
  for (const pattern of stringPatterns) {
    let match;
    while (match = pattern.exec(page)) {
      parseBracketList(match[2] || "");
    }
  }
  const objectPatterns = [
    /\{\s*(?:file|src|url)\s*:\s*(["'`])([^"'`]+)\1\s*,\s*(?:label|lang|name)\s*:\s*(["'`])([^"'`]+)\3[\s\S]*?\}/gi,
    /\{\s*(?:label|lang|name)\s*:\s*(["'`])([^"'`]+)\1\s*,\s*(?:file|src|url)\s*:\s*(["'`])([^"'`]+)\3[\s\S]*?\}/gi
  ];
  let objectMatch;
  while (objectMatch = objectPatterns[0].exec(page)) {
    pushAnimeSaltSubtitle(subtitles, seen, objectMatch[4], objectMatch[2], referer);
  }
  while (objectMatch = objectPatterns[1].exec(page)) {
    pushAnimeSaltSubtitle(subtitles, seen, objectMatch[2], objectMatch[4], referer);
  }
  const directUrlPattern = /https?:\\?\/\\?\/[^"'`\s<>]+(?:\/p\/|\.vtt|\.srt|\.ass)[^"'`\s<>]*/gi;
  let directMatch;
  while (directMatch = directUrlPattern.exec(page)) {
    const url = decodePlayerString(directMatch[0]);
    if (/\.(?:js|css)(?:\?|$)/i.test(url))
      continue;
    pushAnimeSaltSubtitle(subtitles, seen, "English", url, referer);
  }
  return subtitles;
};
const routes = async (fastify, options) => {
  fastify.get("/:query", async (request, reply) => {
    const query = request.params.query;
    const requestedTypeRaw = String(
      request.query.type || ""
    ).toLowerCase();
    const requestedType = requestedTypeRaw === "movie" ? "movie" : requestedTypeRaw === "tv" || requestedTypeRaw === "series" ? "tv" : "";
    try {
      const fetchSearch = async () => {
        const results2 = [];
        const seenIds = /* @__PURE__ */ new Set();
        const pushResult = (scope, href) => {
          const url = String(href || "").trim();
          if (!url)
            return;
          let id = "";
          let mediaType = "";
          if (url.includes("/series/")) {
            id = url.split("/series/")[1].split("/")[0];
            mediaType = "tv";
          } else if (url.includes("/movies/")) {
            id = "movie:" + url.split("/movies/")[1].split("/")[0];
            mediaType = "movie";
          }
          if (id && mediaType) {
            if (requestedType && mediaType !== requestedType)
              return;
            if (seenIds.has(id))
              return;
            seenIds.add(id);
            const title = scope.find("h2, .entry-title").first().text().trim() || scope.find("a[title]").first().attr("title")?.trim() || scope.find("img[alt]").first().attr("alt")?.replace(/^Image\s+/i, "").trim() || id.replace(/^movie:/, "").replace(/-/g, " ");
            const image = scope.find("img").attr("data-src") || scope.find("img").attr("src");
            results2.push({
              id,
              title,
              type: mediaType,
              url,
              image: image?.startsWith("//") ? `https:${image}` : image
            });
          }
        };
        for (const searchQuery of buildAnimeSaltSearchQueries(query)) {
          const res = await (0, import_outboundProxy.proxyGet)(
            `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`,
            {
              headers: { "User-Agent": UA },
              timeout: 3e3
            }
          );
          const $ = cheerio.load(res.data);
          $("article, .post, .result, .items article").each((_, el) => {
            const scope = $(el);
            const href = scope.find("a.lnk-blk").attr("href") || scope.find('a[href*="/series/"]').first().attr("href") || scope.find('a[href*="/movies/"]').first().attr("href");
            pushResult(scope, href);
          });
          $('a[href*="/series/"], a[href*="/movies/"]').each((_, el) => {
            const link = $(el);
            const scope = link.closest("article, .post, .item, .result, li, div");
            pushResult(scope.length ? scope : link, link.attr("href"));
          });
        }
        const anilistPromises = results2.map(async (result) => {
          try {
            const anilistId = import_main.redis ? await import_cache.default.fetch(
              import_main.redis,
              `anilist:title:${result.title}`,
              async () => {
                const anilist = new import_anilist.default();
                const searchRes = await anilist.search(result.title, 1, 1);
                return searchRes.results[0]?.id || null;
              },
              import_main.REDIS_TTL
            ) : null;
            if (anilistId)
              result.anilistId = anilistId;
          } catch (e) {
            console.error(
              "Failed to get AniList ID for",
              result.title,
              e.message
            );
          }
        });
        await Promise.all(anilistPromises);
        return results2;
      };
      const cacheType = requestedType || "all";
      const results = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `animesalt:search:${query}:${cacheType}`,
        fetchSearch,
        import_main.REDIS_TTL
      ) : await fetchSearch();
      reply.status(200).send(results);
    } catch (err) {
      reply.status(500).send({ message: "Error searching AnimeSalt", error: err.message });
    }
  });
  fastify.get("/info", async (request, reply) => {
    const id = request.query.id;
    const hydrateTitles = String(
      request.query.hydrateTitles || ""
    ).toLowerCase() === "true";
    try {
      const fetchInfo = async () => {
        const isMovie = id.startsWith("movie:");
        const slug = isMovie ? id.replace("movie:", "") : id;
        const type = isMovie ? "movies" : "series";
        const res = await (0, import_outboundProxy.proxyGet)(`${BASE_URL}/${type}/${slug}/`, {
          headers: { "User-Agent": UA },
          timeout: 3e3
        });
        const $ = cheerio.load(res.data);
        const title = $("h1").first().text().trim();
        const description = $(".wp-content p").first().text().trim() || $(".description p").first().text().trim();
        const image = $(".poster img").attr("src") || $(".poster img").attr("data-src");
        const genres = [];
        $(".category a").each((_, el) => {
          const genre = $(el).text().trim();
          if (genre && !genres.includes(genre)) {
            genres.push(genre);
          }
        });
        const episodes = [];
        const seasonsMap = /* @__PURE__ */ new Map();
        const seasonTabCounts = /* @__PURE__ */ new Map();
        const parseSeasonEpisode = (value) => {
          const match = String(value || "").match(/(?:^|\D)(\d+)\s*x\s*(\d+)(?:\D|$)/i);
          if (!match)
            return { season: 1, episode: 0 };
          return {
            season: Number(match[1]) || 1,
            episode: Number(match[2]) || 0
          };
        };
        $('a[href="javascript:void(0)"]').each((_, el) => {
          const label = $(el).text().replace(/\s+/g, " ").trim();
          const m = label.match(
            /Season\s*(\d+)\s*[•\-–]?\s*(?:\d+\s*[-–]\s*)?(\d+)\s*\((\d+)\)/i
          );
          if (!m)
            return;
          const seasonNo = Number(m[1]);
          const rangeEnd = Number(m[2]);
          const totalInParens = Number(m[3]);
          const total = Number.isFinite(totalInParens) && totalInParens > 0 ? totalInParens : rangeEnd;
          if (Number.isFinite(seasonNo) && seasonNo > 0 && Number.isFinite(total) && total > 0) {
            seasonTabCounts.set(seasonNo, total);
          }
        });
        $("article.episodes").each((_, el) => {
          const epUrl = $(el).find("a.lnk-blk").attr("href");
          const epId = epUrl?.split("/episode/")[1]?.replace(/\/$/, "");
          const epTitle = $(el).find(".entry-title").text().trim();
          const epNumStr = $(el).find(".num-epi").text().trim();
          const parsedFromId = parseSeasonEpisode(epId || "");
          const parsedFromTitle = parseSeasonEpisode(epTitle || "");
          const numMatch = epNumStr.match(/(\d+)/);
          const epNumber = numMatch ? parseInt(numMatch[1]) : 0;
          const seasonNumber = parsedFromId.season || parsedFromTitle.season || 1;
          const episodeNumber = parsedFromId.episode || epNumber || parsedFromTitle.episode || 0;
          if (epId) {
            const episodeEntry = {
              id: epId,
              title: epTitle,
              number: episodeNumber,
              season: seasonNumber,
              seasonNo: seasonNumber,
              seasonNumber,
              url: epUrl
            };
            episodes.push(episodeEntry);
            if (!seasonsMap.has(seasonNumber)) {
              seasonsMap.set(seasonNumber, {
                season: seasonNumber,
                seasonNo: seasonNumber,
                seasonNumber,
                name: `Season ${seasonNumber}`,
                episodes: []
              });
            }
            seasonsMap.get(seasonNumber).episodes.push(episodeEntry);
          }
        });
        if (!isMovie && seasonTabCounts.size > 0) {
          for (const [seasonNo, count] of seasonTabCounts.entries()) {
            if (!seasonsMap.has(seasonNo)) {
              seasonsMap.set(seasonNo, {
                season: seasonNo,
                seasonNo,
                seasonNumber: seasonNo,
                name: `Season ${seasonNo}`,
                episodes: []
              });
            }
            const bucket = seasonsMap.get(seasonNo);
            if (bucket.episodes.length > 0)
              continue;
            const existingIds = new Set(
              (Array.isArray(bucket?.episodes) ? bucket.episodes : []).map(
                (ep) => String(ep?.id || "").trim().toLowerCase()
              ).filter(Boolean)
            );
            for (let epNo = 1; epNo <= count; epNo += 1) {
              const syntheticId = `${slug}-${seasonNo}x${epNo}`.toLowerCase();
              if (existingIds.has(syntheticId))
                continue;
              const entry = {
                id: `${slug}-${seasonNo}x${epNo}`,
                title: `Episode ${epNo}`,
                number: epNo,
                season: seasonNo,
                seasonNo,
                seasonNumber: seasonNo,
                url: `${BASE_URL}/episode/${slug}-${seasonNo}x${epNo}/`
              };
              episodes.push(entry);
              bucket.episodes.push(entry);
            }
          }
        }
        const parseEpisodePageTitle = (html, fallbackTitle) => {
          const $$ = cheerio.load(html || "");
          const candidates = [
            $$('meta[property="og:title"]').attr("content") || "",
            $$('meta[name="twitter:title"]').attr("content") || "",
            $$(".entry-title").first().text().trim() || "",
            $$("h1").first().text().trim() || "",
            $$("h2").first().text().trim() || ""
          ].map(
            (v) => String(v || "").replace(/\s+/g, " ").trim()
          ).filter(Boolean);
          for (const raw of candidates) {
            let cleaned = raw.replace(/\s*[-|]\s*Anime\s*Salt\s*$/i, "").replace(/\s*\|\s*Anime\s*Salt\s*$/i, "").replace(/\s+/g, " ").trim();
            if (!cleaned)
              continue;
            if (/^episode\s*\d+$/i.test(cleaned))
              continue;
            if (/^watching:/i.test(cleaned))
              continue;
            return cleaned;
          }
          return fallbackTitle;
        };
        const needsHydration = hydrateTitles ? episodes.filter((ep) => {
          const title2 = String(ep?.title || "").trim();
          return !title2 || /^episode\s*\d+$/i.test(title2);
        }).filter((ep) => String(ep?.url || "").startsWith(BASE_URL)).slice(0, 160) : [];
        if (hydrateTitles && needsHydration.length > 0) {
          const concurrency = 8;
          const workers = Array.from(
            { length: Math.min(concurrency, needsHydration.length) },
            () => (async () => {
              while (needsHydration.length > 0) {
                const ep = needsHydration.shift();
                if (!ep?.url)
                  continue;
                try {
                  const epRes = await (0, import_outboundProxy.proxyGet)(ep.url, {
                    headers: {
                      "User-Agent": UA,
                      Referer: `${BASE_URL}/series/${slug}/`
                    },
                    timeout: 3e3
                  });
                  ep.title = parseEpisodePageTitle(
                    String(epRes?.data || ""),
                    String(ep.title || "").trim() || `Episode ${ep.number || 0}`
                  );
                } catch (_e) {
                }
              }
            })()
          );
          await Promise.allSettled(workers);
        }
        if (isMovie && episodes.length === 0) {
          episodes.push({
            id,
            // e.g. "movie:jujutsu-kaisen-0"
            title,
            number: 1,
            url: `${BASE_URL}/movies/${slug}/`
          });
        }
        episodes.sort((a, b) => {
          const seasonDiff = Number(a.season || a.seasonNo || a.seasonNumber || 0) - Number(b.season || b.seasonNo || b.seasonNumber || 0);
          if (seasonDiff !== 0)
            return seasonDiff;
          return Number(a.number || 0) - Number(b.number || 0);
        });
        const seasons = Array.from(seasonsMap.values()).map((season) => ({
          ...season,
          episodes: Array.isArray(season.episodes) ? season.episodes.sort(
            (a, b) => Number(a.number || 0) - Number(b.number || 0)
          ) : []
        })).sort(
          (a, b) => Number(a.season || a.seasonNo || 0) - Number(b.season || b.seasonNo || 0)
        );
        let anilistId = null;
        try {
          anilistId = import_main.redis ? await import_cache.default.fetch(
            import_main.redis,
            `anilist:title:${title}`,
            async () => {
              const anilist = new import_anilist.default();
              const searchRes = await anilist.search(title, 1, 1);
              return searchRes.results[0]?.id || null;
            },
            import_main.REDIS_TTL
          ) : null;
        } catch (e) {
          console.error("Failed to get AniList ID for", title, e.message);
        }
        return {
          id,
          title,
          description,
          image: image?.startsWith("//") ? `https:${image}` : image,
          genres,
          seasons,
          episodes,
          anilistId
        };
      };
      const infoCacheVersion = hydrateTitles ? "v5-hydrated" : "v5-fast";
      const info = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `animesalt:info:${id}:${infoCacheVersion}`,
        fetchInfo,
        import_main.REDIS_TTL
      ) : await fetchInfo();
      reply.status(200).send(info);
    } catch (err) {
      reply.status(500).send({ message: "Error fetching info from AnimeSalt", error: err.message });
    }
  });
  fastify.get(
    "/watch/:episodeId",
    async (request, reply) => {
      const episodeId = request.params.episodeId;
      try {
        const isMovie = episodeId.startsWith("movie:");
        const slug = isMovie ? episodeId.replace("movie:", "") : episodeId;
        const watchUrl = isMovie ? `${BASE_URL}/movies/${slug}/` : `${BASE_URL}/episode/${episodeId}/`;
        const sources = [];
        const metaCacheKey = `animesalt:watch:${episodeId}:meta:v1`;
        const fetchMeta = async () => {
          const res = await (0, import_outboundProxy.proxyGet)(watchUrl, {
            headers: { "User-Agent": UA },
            timeout: 3e3
          });
          const $ = cheerio.load(res.data);
          const iframe12 = $("#options-0 iframe").attr("data-src") || $("#options-0 iframe").attr("src") || "";
          const subtitles = [];
          let cookies2 = "";
          if (iframe12) {
            const pageRes = await (0, import_outboundProxy.proxyGet)(iframe12, {
              headers: { "User-Agent": UA, Referer: BASE_URL },
              timeout: 3e3
            });
            cookies2 = pageRes.headers["set-cookie"]?.map((c) => c.split(";")[0]).join("; ") || "";
            subtitles.push(
              ...extractAnimeSaltSubtitles(String(pageRes.data || ""), iframe12)
            );
          }
          return { iframe1: iframe12, cookies: cookies2, subtitles };
        };
        let meta = getWatchMeta(metaCacheKey);
        if (!meta) {
          meta = await fetchMeta();
          setWatchMeta(metaCacheKey, meta);
        }
        const { iframe1, cookies } = meta;
        if (iframe1) {
          try {
            const embedUrl = new URL(iframe1);
            const videoId = embedUrl.pathname.split("/").filter((p) => !!p && p !== "v").pop();
            const origin = embedUrl.origin;
            const apiRes = await (0, import_outboundProxy.proxyPost)(
              `${origin}/player/index.php?data=${videoId}&do=getVideo`,
              `hash=${videoId}&r=${encodeURIComponent(BASE_URL)}`,
              {
                headers: {
                  "User-Agent": UA,
                  Referer: iframe1,
                  "X-Requested-With": "XMLHttpRequest",
                  "Content-Type": "application/x-www-form-urlencoded",
                  Cookie: cookies
                }
              }
            );
            if (apiRes.data?.videoSource) {
              sources.push({
                url: String(apiRes.data.videoSource),
                isM3U8: true,
                quality: "Default",
                referer: iframe1,
                // The CDN binds the signed playlist to the iframe session.
                // Preserve the cookies collected before calling getVideo so
                // the browser's proxied manifest and segment requests remain
                // authorized.
                cookieHeader: cookies
              });
            } else {
              sources.push({
                url: iframe1,
                isIframe: true,
                quality: "Server 1 (Iframe)"
              });
            }
          } catch (_e) {
            sources.push({
              url: iframe1,
              isIframe: true,
              quality: "Server 1 (Iframe)"
            });
          }
        }
        reply.status(200).send({
          headers: { Referer: BASE_URL },
          sources,
          subtitles: meta.subtitles || []
        });
      } catch (err) {
        reply.status(500).send({ message: "Error fetching sources from AnimeSalt", error: err.message });
      }
    }
  );
};
var animesalt_default = routes;
