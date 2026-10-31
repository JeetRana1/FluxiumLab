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
var play4uProvider_exports = {};
__export(play4uProvider_exports, {
  Play4uProvider: () => Play4uProvider
});
module.exports = __toCommonJS(play4uProvider_exports);
var cheerio = __toESM(require("cheerio"));
var import_axios = __toESM(require("axios"));
var import_hdstream4uProvider = require("./hdstream4uProvider");
const BASE_URL = "https://play4u.org";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};
const fetchPage = async (url) => String((await import_axios.default.get(url, { headers, timeout: 15e3 })).data || "");
const absolute = (value) => new URL(value, BASE_URL).href;
const tmdbKey = () => String(process.env.TMDB_KEY || "").trim();
const infoCache = /* @__PURE__ */ new Map();
const INFO_CACHE_TTL = 10 * 60 * 1e3;
const resolveImdbId = async (id) => {
  if (/^tt\d+$/i.test(id))
    return id;
  if (!/^\d+$/.test(id) || !tmdbKey())
    return "";
  for (const type of ["tv", "movie"]) {
    try {
      const response = await import_axios.default.get(`https://api.themoviedb.org/3/${type}/${id}/external_ids`, {
        params: { api_key: tmdbKey() },
        timeout: 8e3
      });
      if (response.data?.imdb_id)
        return String(response.data.imdb_id);
    } catch {
    }
  }
  return "";
};
const parseCard = ($, el) => {
  const card = $(el);
  const link = card.find("a.poster-link").first();
  const href = String(link.attr("href") || "").trim();
  const title = String(card.attr("data-title") || link.find(".poster-name").text() || "").trim();
  const year = Number(String(card.attr("data-year") || link.find(".poster-sub").text().match(/\b(?:19|20)\d{2}\b/)?.[0] || "0")) || void 0;
  const poster = String(link.find("img").attr("src") || "").trim();
  if (!href || !title)
    return null;
  return { id: absolute(href), url: absolute(href), title, name: title, year, image: poster, poster, type: href.includes("/series/") ? "tv" : "movie" };
};
const parseEpisodes = ($, url) => {
  const episodes = $('a[href*="/s-"][href*="/ep-"]').toArray().map((node) => {
    const href = absolute(String($(node).attr("href") || ""));
    const match = href.match(/\/s-(\d+)\/ep-(\d+)/i);
    if (!match)
      return null;
    return {
      id: href,
      episodeId: href,
      number: Number(match[2]),
      episode: Number(match[2]),
      season: Number(match[1]),
      title: String($(node).find(".episode-title, .episode-name").text() || $(node).text() || "").trim()
    };
  }).filter(Boolean);
  return [...new Map(episodes.map((episode) => [`${episode.season}:${episode.episode}`, episode])).values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
};
class Play4uProvider {
  static async search(query, page = 1) {
    if (/^(?:tt\d+|\d+)$/.test(query.trim())) {
      try {
        let info;
        for (const type of ["movie", "tv"]) {
          try {
            info = await this.fetchMediaInfo(query.trim(), type);
            if (info?.id)
              break;
          } catch {
          }
        }
        if (!info?.id)
          throw new Error("Play4u ID not found");
        return {
          currentPage: page,
          totalPages: 1,
          results: [{ id: info.id, url: info.id, title: info.title, name: info.title, type: info.type, tmdbId: info.tmdbId, imdbId: info.imdbId }]
        };
      } catch {
      }
    }
    const html = await fetchPage(`${BASE_URL}/?q=${encodeURIComponent(query)}&page=${page}`);
    const $ = cheerio.load(html);
    const needle = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const results = $("article.poster-card").toArray().map((el) => parseCard($, el)).filter(Boolean).filter((result) => {
      const haystack = `${result.title} ${result.year || ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      return !needle || haystack.includes(needle) || needle.includes(haystack.trim());
    });
    return { currentPage: page, totalPages: 1, results };
  }
  static async fetchMediaInfo(id, type = "movie") {
    const cacheKey = `${String(id).trim().toLowerCase()}|${type}`;
    const cached = infoCache.get(cacheKey);
    if (cached && cached.expires > Date.now())
      return cached.value;
    let url = /^https?:\/\//i.test(id) ? id : "";
    if (!url) {
      const imdbId2 = await resolveImdbId(id);
      if (imdbId2) {
        const candidates = type === "tv" ? [`${BASE_URL}/series/${imdbId2}`, `${BASE_URL}/movie/${imdbId2}`] : [`${BASE_URL}/watch/${imdbId2}`, `${BASE_URL}/movie/${imdbId2}`, `${BASE_URL}/series/${imdbId2}`];
        for (const candidate of candidates) {
          try {
            const detail = await fetchPage(candidate);
            if (/window\.__PA_PLAY__|play4u/i.test(detail)) {
              url = candidate;
              break;
            }
          } catch {
          }
        }
      }
    }
    if (!url) {
      const html2 = await fetchPage(`${BASE_URL}/?q=${encodeURIComponent(id)}`);
      const $2 = cheerio.load(html2);
      const cards = $2("article.poster-card a.poster-link").toArray().slice(0, 30);
      for (const card of cards) {
        const candidate = absolute(String($2(card).attr("href") || ""));
        if (!/^\d+$/.test(id)) {
          url = candidate;
          break;
        }
        try {
          const detail = await fetchPage(candidate);
          if (new RegExp(`"tmdb_id"\\s*:\\s*${id}(?:[,}])`, "i").test(detail)) {
            url = candidate;
            break;
          }
        } catch {
        }
      }
      if (url)
        url = absolute(url);
    }
    if (!url)
      throw new Error("Play4u title not found");
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const title = String($("h1, .detail-title, .title").first().text() || $('meta[property="og:title"]').attr("content") || "").trim();
    const tmdbId = String(html.match(/"tmdb_id"\s*:\s*(\d+)/i)?.[1] || "").trim();
    const imdbId = String(html.match(/"imdb_id"\s*:\s*"(tt\d+)"/i)?.[1] || "").trim();
    const episodes = parseEpisodes($, url);
    const firstEpisode = episodes[0];
    const result = {
      id: url,
      title,
      type: type === "tv" || episodes.length ? "tv" : "movie",
      tmdbId,
      imdbId,
      episodes,
      episodeId: firstEpisode?.id || url,
      servers: [{ name: "Play4u", url: firstEpisode?.id || url, type: "hls" }]
    };
    infoCache.set(cacheKey, { expires: Date.now() + INFO_CACHE_TTL, value: result });
    return result;
  }
  static async fetchSources(episodeId, server = "play4u") {
    return import_hdstream4uProvider.HdStream4uProvider.fetchSources(episodeId, server);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Play4uProvider
});
