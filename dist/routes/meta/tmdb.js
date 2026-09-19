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
var tmdb_exports = {};
__export(tmdb_exports, {
  default: () => tmdb_default
});
module.exports = __toCommonJS(tmdb_exports);
var import_extensions = require("@consumet/extensions");
var import_main = require("../../main");
var import_cache = __toESM(require("../../utils/cache"));
var import_streamable = require("../../utils/streamable");
var import_movieServerFallback = require("../../utils/movieServerFallback");
var import_axios = __toESM(require("axios"));
var import_googleapis = require("googleapis");
var import_hdstream4uProvider = require("../../providers/custom/hdstream4uProvider");
const configureMeta = (meta) => {
  if (meta && meta.client?.defaults) {
    meta.client.defaults.headers.common["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  return meta;
};
const shouldLookupTrailers = String(process.env.TMDB_ENABLE_TRAILER_LOOKUP || "false").toLowerCase() === "true";
const logTmdbFailure = (label, error) => {
  const status = error?.response?.status;
  if (status && status !== 404) {
    console.warn(
      `${label} (HTTP ${status}):`,
      error?.message || error
    );
  }
};
const createTmdbClient = (provider) => {
  if (!import_main.tmdbApi)
    return null;
  return configureMeta(new import_extensions.META.TMDB(import_main.tmdbApi, provider));
};
const parseIso8601DurationToSeconds = (duration) => {
  if (!duration || typeof duration !== "string")
    return 0;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match)
    return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
};
const trailerScore = (params) => {
  const title = String(params.title || "").toLowerCase();
  const channelTitle = String(params.channelTitle || "").toLowerCase();
  const year = String(params.releaseYear || "").trim();
  let score = 0;
  if (title.includes("official trailer"))
    score += 140;
  else if (title.includes("trailer"))
    score += 100;
  if (title.includes("official"))
    score += 25;
  if (year && title.includes(year))
    score += 12;
  if (title.includes("teaser") || title.includes("clip") || title.includes("behind the scenes") || title.includes("featurette") || title.includes("interview") || title.includes("tv spot") || title.includes("short") || title.includes("promo") || title.includes("reaction")) {
    score -= 180;
  }
  if (channelTitle.includes("trailers"))
    score += 20;
  if (params.durationSeconds > 0) {
    if (params.durationSeconds < 45)
      score -= 220;
    else if (params.durationSeconds < 75)
      score -= 100;
    else if (params.durationSeconds >= 75 && params.durationSeconds <= 260)
      score += 30;
    else if (params.durationSeconds > 900)
      score -= 50;
  }
  return score;
};
const fetchTmdbOfficialTrailer = async (id, type) => {
  if (!import_main.tmdbApi)
    return null;
  try {
    const tmdbType = String(type || "").toLowerCase() === "tv" ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${tmdbType}/${id}/videos?api_key=${import_main.tmdbApi}&language=en-US`;
    const response = await import_axios.default.get(url);
    const results = Array.isArray(response?.data?.results) ? response.data.results : [];
    const ranked = results.filter(
      (row) => String(row?.site || "").toLowerCase() === "youtube" && row?.key
    ).map((row) => {
      const trailerType = String(row?.type || "").toLowerCase();
      const trailerName = String(row?.name || "").toLowerCase();
      let score = 0;
      if (trailerType === "trailer")
        score += 140;
      else
        score -= 80;
      if (row?.official === true)
        score += 60;
      if (trailerName.includes("official"))
        score += 25;
      if (trailerType.includes("teaser") || trailerType.includes("clip") || trailerType.includes("behind the scenes") || trailerType.includes("featurette") || trailerName.includes("teaser") || trailerName.includes("clip") || trailerName.includes("behind the scenes") || trailerName.includes("featurette") || trailerName.includes("tv spot")) {
        score -= 220;
      }
      return {
        key: String(row.key),
        score,
        publishedAt: Date.parse(String(row?.published_at || row?.publishedAt || "")) || 0
      };
    }).sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
    const best = ranked[0];
    if (!best || best.score <= 0)
      return null;
    return `https://www.youtube.com/watch?v=${best.key}`;
  } catch (error) {
    const status = error?.response?.status;
    if (status && status !== 404) {
      console.warn(
        `Error fetching TMDB official trailer (HTTP ${status}):`,
        error?.message || error
      );
    }
    return null;
  }
};
const extractYouTubeVideoId = (value) => {
  if (!value)
    return null;
  const raw = String(value).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw))
    return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.includes("youtube.com")) {
      const fromV = url.searchParams.get("v") || "";
      if (/^[a-zA-Z0-9_-]{11}$/.test(fromV))
        return fromV;
      const parts = url.pathname.split("/").filter(Boolean);
      const idx = parts.findIndex((p) => p === "embed" || p === "shorts");
      if (idx >= 0 && parts[idx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])) {
        return parts[idx + 1];
      }
    }
  } catch {
  }
  const fallback = raw.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/i);
  return fallback ? fallback[1] : null;
};
const getYouTubeWatchUrl = (value) => {
  const id = extractYouTubeVideoId(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
};
const hasForbiddenTrailerText = (value) => {
  const text = String(value || "").toLowerCase();
  if (!text)
    return false;
  return text.includes("teaser") || text.includes("clip") || text.includes("behind the scenes") || text.includes("featurette") || text.includes("tv spot") || text.includes("promo") || text.includes("interview") || text.includes("short");
};
const chooseOfficialTrailerFromExisting = async (payload) => {
  const candidates = [];
  const pushCandidate = (rawUrl, name, type, official) => {
    const url = getYouTubeWatchUrl(String(rawUrl || ""));
    if (!url)
      return;
    const lowerName = String(name || "").toLowerCase();
    const lowerType = String(type || "").toLowerCase();
    let score = 0;
    if (lowerType === "trailer")
      score += 120;
    if (lowerName.includes("official trailer"))
      score += 100;
    else if (lowerName.includes("trailer"))
      score += 60;
    if (official === true || lowerName.includes("official"))
      score += 25;
    if (hasForbiddenTrailerText(lowerName) || hasForbiddenTrailerText(lowerType)) {
      score -= 250;
    }
    if (url.includes("/shorts/"))
      score -= 400;
    candidates.push({ url, score });
  };
  if (typeof payload === "string") {
    pushCandidate(payload);
  } else if (Array.isArray(payload)) {
    for (const row of payload.slice(0, 12)) {
      if (typeof row === "string")
        pushCandidate(row);
      else if (row && typeof row === "object")
        pushCandidate(
          row.url || row.link || row.id || row.key,
          row.name || row.title,
          row.type,
          row.official
        );
    }
  } else if (payload && typeof payload === "object") {
    pushCandidate(
      payload.url || payload.link || payload.id || payload.key,
      payload.name || payload.title,
      payload.type,
      payload.official
    );
  }
  const ranked = candidates.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0)
    return null;
  return best.url;
};
const attachBestTrailer = async (info, id, type) => {
  if (!info || typeof info !== "object")
    return;
  const tmdbTrailer = await fetchTmdbOfficialTrailer(id, type);
  if (tmdbTrailer) {
    info.trailer = tmdbTrailer;
    return;
  }
  const existingTrailer = await chooseOfficialTrailerFromExisting(info.trailer);
  if (existingTrailer) {
    info.trailer = existingTrailer;
    return;
  }
  delete info.trailer;
  if (!shouldLookupTrailers)
    return;
  const title = info.title || info.name;
  const year = info.releaseDate || info.firstAirDate;
  const yearStr = year ? new Date(year).getFullYear().toString() : void 0;
  const youtubeTrailer = await fetchYouTubeTrailer(title, yearStr);
  if (youtubeTrailer) {
    info.trailer = youtubeTrailer;
  }
};
const fetchYouTubeTrailer = async (title, year) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey)
    return null;
  try {
    const youtube = import_googleapis.google.youtube({
      version: "v3",
      auth: apiKey
    });
    const query = `${title} ${year ? year : ""} trailer`.trim();
    const response = await youtube.search.list({
      part: ["snippet"],
      q: query,
      type: ["video"],
      maxResults: 8,
      order: "relevance"
    });
    const items = response.data.items;
    if (items && items.length > 0) {
      const candidates = items.map((item) => ({
        id: item.id?.videoId,
        title: item.snippet?.title || "",
        channelTitle: item.snippet?.channelTitle || ""
      })).filter((item) => item.id);
      if (!candidates.length)
        return null;
      const videoDetails = await youtube.videos.list({
        part: ["contentDetails"],
        id: candidates.map((candidate) => candidate.id)
      });
      const durationById = /* @__PURE__ */ new Map();
      for (const detail of videoDetails.data.items || []) {
        const detailId = detail.id || "";
        const duration = parseIso8601DurationToSeconds(
          detail.contentDetails?.duration || ""
        );
        if (detailId)
          durationById.set(detailId, duration);
      }
      const ranked = candidates.map((candidate) => {
        const id = candidate.id;
        const score = trailerScore({
          title: candidate.title,
          channelTitle: candidate.channelTitle,
          durationSeconds: durationById.get(id) || 0,
          releaseYear: year
        });
        return { ...candidate, score };
      }).sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (best && best.score > -40) {
        return `https://www.youtube.com/watch?v=${best.id}`;
      }
    }
  } catch (error) {
    console.error("Error fetching YouTube trailer:", error);
  }
  return null;
};
const ANIME_PROVIDER_ROUTES = {
  animesalt: "/anime/animesalt"
};
const resolveMovieProvider = (provider) => {
  if (!provider)
    return void 0;
  switch (provider.toLowerCase()) {
    case "flixhq":
      return void 0;
    default:
      return void 0;
  }
};
const HDSTREAM_TV_EPISODE_SHIFTS = {
  "262838": { 2: { shiftFrom: 6, shift: 1 } }
};
const resolveHdstream4uTvEpisodeId = async (request, id, type, season, episode, titleInfo) => {
  const requestedSeason = Number(season || 1);
  const requestedEpisode = Number(episode || 1);
  const episodeShift = HDSTREAM_TV_EPISODE_SHIFTS[String(id || "").trim()]?.[requestedSeason];
  const shiftedEpisode = episodeShift && requestedEpisode >= episodeShift.shiftFrom ? requestedEpisode + episodeShift.shift : requestedEpisode;
  let targetId = String(id || "").trim();
  try {
    const tmdbInfoRes = titleInfo ? null : await request.server.inject({
      method: "GET",
      url: `/meta/tmdb/info/${encodeURIComponent(targetId)}?type=${encodeURIComponent(type || "tv")}`
    });
    const tmdbInfo = titleInfo || safeJsonParse(tmdbInfoRes?.body || "{}");
    const titleCandidates = getTitleCandidatesFromMedia(tmdbInfo);
    const preferredYear = Number(
      String(tmdbInfo?.releaseDate || tmdbInfo?.first_air_date || "").slice(0, 4)
    );
    const targetSeasonLabel = `season ${requestedSeason}`;
    const searchResults = await Promise.all(
      titleCandidates.map((title) => searchHdhub4uByTitle(`${title} ${targetSeasonLabel}`).catch(() => []))
    );
    for (const [index, results] of searchResults.entries()) {
      try {
        const title = titleCandidates[index];
        const normTitle = normalizeText(title);
        const ranked = results.map((entry) => {
          const score = titleMatchScore(entry.title, titleCandidates);
          const normalizedEntry = normalizeText(entry.title);
          const startsWithBonus = normTitle && normalizedEntry.startsWith(normTitle) ? 400 : 0;
          const trailingAfterTitle = normTitle && normalizedEntry.startsWith(normTitle) ? normalizedEntry.slice(normTitle.length).trim() : "";
          const foreignSuffixPenalty = trailingAfterTitle && !/^(?:\(?season\b|s\d+\b|series\b|web\b|all\s+episodes\b|bluray\b|webrip\b|web-dl\b|hindi\b|english\b|dual\b|x264\b|480p\b|720p\b|1080p\b|2160p\b|dd5\.1\b|\|)/i.test(
            trailingAfterTitle
          ) ? -550 : 0;
          const seasonHit = new RegExp(`season[\\s-]*${requestedSeason}(?:\\b|-)`, "i").test(
            `${entry.title} ${entry.url}`
          ) ? 300 : -200;
          const yearBonus = preferredYear && new RegExp(`(^|[^\\d])${preferredYear}([^\\d]|$)`, "i").test(entry.title) ? 120 : 0;
          return {
            url: entry.url,
            score: score + seasonHit + yearBonus + startsWithBonus + foreignSuffixPenalty
          };
        }).filter((entry) => entry.score >= 700).sort((a, b) => b.score - a.score);
        if (ranked[0]?.url) {
          targetId = ranked[0].url;
          break;
        }
      } catch {
      }
    }
  } catch {
  }
  if (/^\d+$/.test(targetId))
    return "";
  const infoRes = await request.server.inject({
    method: "GET",
    url: `/movies/hdstream4u/info?id=${encodeURIComponent(targetId)}&type=${encodeURIComponent(type || "tv")}`
  });
  if (infoRes.statusCode >= 400)
    return "";
  const payload = safeJsonParse(infoRes.body || "{}");
  const entries = Array.isArray(payload?.episodes) ? payload.episodes : [];
  const isBonusEntry = (entry) => String(entry?.category || "").toLowerCase() === "bonus" || Number(entry?.seasonNumber) === 0 || /bonus/i.test(String(entry?.seasonName || entry?.title || ""));
  const numberedEntries = entries.filter((entry) => !isBonusEntry(entry));
  const getEntrySeason = (entry) => {
    const value = Number(entry?.seasonNumber ?? entry?.season ?? 1);
    return Number.isFinite(value) && value > 0 ? value : 1;
  };
  const match = entries.find(
    (entry) => !isBonusEntry(entry) && getEntrySeason(entry) === requestedSeason && Number(entry?.episodeNumber || entry?.episode || entry?.number || 0) === shiftedEpisode
  );
  const normalizeEpisodeId = (entry) => {
    const raw = String(entry?.episodeId || entry?.url || entry?.id || "").trim();
    return raw;
  };
  if (match)
    return normalizeEpisodeId(match);
  const episodeOnlyMatches = numberedEntries.filter(
    (entry) => Number(entry?.episodeNumber || entry?.episode || entry?.number || 0) === shiftedEpisode
  );
  if (episodeOnlyMatches.length === 1) {
    return normalizeEpisodeId(episodeOnlyMatches[0]);
  }
  const seasonValues = Array.from(
    new Set(
      numberedEntries.map((entry) => Number(entry?.seasonNumber || entry?.season || 1)).filter((value) => Number.isFinite(value) && value > 0)
    )
  );
  if (seasonValues.length === 1) {
    const fallback = episodeOnlyMatches[0];
    if (fallback)
      return normalizeEpisodeId(fallback);
  }
  return "";
};
const IS_PRODUCTION = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
const MOVIE_WATCH_ATTEMPT_TIMEOUT_MS = Number(
  process.env.MOVIE_WATCH_ATTEMPT_TIMEOUT_MS || (IS_PRODUCTION ? 7e3 : 5e3)
);
const parseLocsFromXml = (xml) => {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
};
const parseEpisodeNumber = (value) => {
  const match = value.match(/episode-(\d+)/i) || value.match(/episode\s*(\d+)/i);
  if (!match)
    return void 0;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : void 0;
};
const extractSlug = (value) => {
  const clean = value.split("?")[0].replace(/\/$/, "");
  const last = clean.split("/").pop() || clean;
  return last.replace(/\.html$/i, "");
};
const toAbsoluteUrl = (base, maybeUrl) => {
  if (/^https?:\/\//i.test(maybeUrl))
    return maybeUrl;
  return `${base.replace(/\/$/, "")}/${String(maybeUrl || "").replace(/^\//, "")}`;
};
const normalizeText = (value) => String(value || "").replace(/&#8217;/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
const safeJsonParse = (value) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};
const toGenreNames = (genres) => {
  if (!Array.isArray(genres))
    return [];
  return genres.map((genre) => {
    if (typeof genre === "string")
      return genre;
    if (genre && typeof genre.name === "string")
      return genre.name;
    return "";
  }).filter(Boolean).map((genre) => normalizeText(genre));
};
const getTitleCandidatesFromMedia = (media) => {
  return [media?.title, media?.name, media?.originalTitle, media?.originalName].filter((v, i, arr) => typeof v === "string" && v.trim() && arr.indexOf(v) === i).map((v) => String(v).trim());
};
const titleMatchScore = (candidateTitle, queries) => {
  const candidate = normalizeText(candidateTitle);
  if (!candidate)
    return -1;
  let score = 0;
  for (const query of queries) {
    const normQuery = normalizeText(query);
    if (!normQuery)
      continue;
    if (candidate === normQuery)
      score = Math.max(score, 1e3);
    else if (candidate.includes(normQuery) || normQuery.includes(candidate))
      score = Math.max(score, 700);
  }
  return score;
};
const resolveTmdbExternalImdbId = async (id, type) => {
  const sourceId = String(id || "").trim();
  if (!sourceId)
    return "";
  if (/^tt\d+$/i.test(sourceId))
    return sourceId;
  if (!/^\d+$/.test(sourceId) || !import_main.tmdbApi)
    return "";
  const mediaTypes = Array.from(
    /* @__PURE__ */ new Set([type === "tv" ? "tv" : "movie", type === "tv" ? "movie" : "tv"])
  );
  for (const mediaType of mediaTypes) {
    try {
      const response = await import_axios.default.get(
        `https://api.themoviedb.org/3/${mediaType}/${sourceId}/external_ids?api_key=${import_main.tmdbApi}`
      );
      const imdbId = String(response?.data?.imdb_id || "").trim();
      if (/^tt\d+$/i.test(imdbId))
        return imdbId;
    } catch {
    }
  }
  return "";
};
const ANIME_MAPPING_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
let animeIdIndex = null;
let animeIdIndexLoading = null;
const loadAnimeIdIndex = async () => {
  if (animeIdIndex)
    return animeIdIndex;
  if (animeIdIndexLoading)
    return animeIdIndexLoading;
  animeIdIndexLoading = (async () => {
    try {
      const { data } = await import_axios.default.get(ANIME_MAPPING_URL, {
        timeout: 3e4,
        responseType: "json"
      });
      if (!Array.isArray(data))
        return null;
      const index = {};
      for (const entry of data) {
        const anilistId = Number(entry?.anilist_id);
        if (!Number.isInteger(anilistId) || anilistId <= 0)
          continue;
        const tm = entry?.themoviedb_id;
        if (tm && typeof tm === "object") {
          if (tm.tv != null)
            index[`tv:${tm.tv}`] = anilistId;
          const movieIds = Array.isArray(tm.movie) ? tm.movie : tm.movie != null ? [tm.movie] : [];
          for (const movieId of movieIds) {
            if (movieId != null)
              index[`movie:${movieId}`] = anilistId;
          }
        }
        if (entry?.tvdb_id != null)
          index[`tvdb:${entry.tvdb_id}`] = anilistId;
      }
      animeIdIndex = index;
      return index;
    } catch (err) {
      console.warn(`[anime-mapping] failed to load index: ${err?.message || err}`);
      return null;
    } finally {
      animeIdIndexLoading = null;
    }
  })();
  return animeIdIndexLoading;
};
const resolveAniListIdByExactMapping = async (id, type) => {
  const sourceId = String(id || "").trim();
  if (!sourceId || !/^\d+$/.test(sourceId))
    return null;
  const index = await loadAnimeIdIndex();
  if (!index)
    return null;
  const primaryType = type === "tv" ? "tv" : "movie";
  const secondaryType = primaryType === "tv" ? "movie" : "tv";
  for (const key of [`${primaryType}:${sourceId}`, `${secondaryType}:${sourceId}`]) {
    const found = index[key];
    if (found != null)
      return String(found);
  }
  return null;
};
const isAnimeLikeMovie = (media) => {
  const genreNames = toGenreNames(media?.genres);
  const hasAnimationGenre = genreNames.some((genre) => genre.includes("animation"));
  const hasAnimeGenre = genreNames.some((genre) => genre.includes("anime"));
  const lang = normalizeText(
    String(media?.originalLanguage || media?.original_language || "")
  );
  const isJapanese = lang === "ja";
  return hasAnimeGenre || hasAnimationGenre && isJapanese;
};
const normalizeSlug = (value) => String(value || "").toLowerCase().replace(/\.html$/i, "").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const stripTrailingYear = (value) => value.replace(/-(19|20)\d{2}$/i, "");
const HDHUB4U_POST_SITEMAP_URL = "https://new6.hdhub4u.cl/post-sitemap.xml";
let hdhub4uSitemapCache = null;
const fetchHdhub4uSitemapUrls = async () => {
  if (hdhub4uSitemapCache && hdhub4uSitemapCache.expiresAt > Date.now()) {
    return hdhub4uSitemapCache.urls;
  }
  const response = await import_axios.default.get(HDHUB4U_POST_SITEMAP_URL, {
    timeout: 2e4,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    responseType: "text"
  });
  const xml = String(response.data || "");
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => String(match[1] || "").trim()).filter((value) => /^https?:\/\//i.test(value));
  hdhub4uSitemapCache = {
    urls,
    expiresAt: Date.now() + 30 * 60 * 1e3
  };
  return urls;
};
const searchHdhub4uByTitle = async (query) => {
  const apiUrl = new URL("https://search.pingora.fyi/collections/post/documents/search");
  apiUrl.searchParams.set("q", query);
  apiUrl.searchParams.set("query_by", "post_title,category,stars,director,imdb_id");
  apiUrl.searchParams.set("query_by_weights", "4,2,2,2,4");
  apiUrl.searchParams.set("sort_by", "sort_by_date:desc");
  apiUrl.searchParams.set("limit", "10");
  apiUrl.searchParams.set("highlight_fields", "none");
  apiUrl.searchParams.set("use_cache", "true");
  apiUrl.searchParams.set("page", "1");
  apiUrl.searchParams.set("analytics_tag", (/* @__PURE__ */ new Date()).toISOString().slice(0, 10));
  const response = await import_axios.default.get(apiUrl.toString(), {
    timeout: 15e3,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json, text/plain, */*",
      Origin: "https://new6.hdhub4u.cl",
      Referer: `https://new6.hdhub4u.cl/?s=${encodeURIComponent(query)}`
    }
  });
  const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
  return hits.map((hit) => hit?.document || {}).map((doc) => ({
    title: String(doc?.post_title || "").trim(),
    url: String(doc?.permalink || doc?.url || "").trim()
  })).filter((entry) => entry.title && entry.url);
};
const findBestHdhub4uUrl = async (titleCandidates, year) => {
  const urls = await fetchHdhub4uSitemapUrls();
  const ranked = urls.map((url) => {
    const slug = stripTrailingYear(normalizeSlug(new URL(url).pathname.split("/").filter(Boolean).pop() || ""));
    const score = titleMatchScore(slug.replace(/-/g, " "), titleCandidates);
    const yearBonus = year && new RegExp(`(^|-)${year}(-|$)`, "i").test(url) ? 120 : 0;
    const tvBonus = /season|episode|series|web-series/i.test(url) ? 30 : 0;
    return { url, score: score + yearBonus + tvBonus };
  }).filter((entry) => entry.score >= 700).sort((a, b) => b.score - a.score);
  return ranked[0]?.url || "";
};
const extractHdstreamMovieCandidateIds = (infoPayload) => {
  const servers = Array.isArray(infoPayload?.servers) ? infoPayload.servers : [];
  const episodes = Array.isArray(infoPayload?.episodes) ? infoPayload.episodes : [];
  const out = [];
  const push = (value) => {
    const clean = String(value || "").trim();
    if (clean && !out.includes(clean))
      out.push(clean);
  };
  servers.forEach((server) => {
    const url = String(server?.url || "").trim();
    const fileCode = String(server?.fileCode || "").trim();
    if (/(?:hdstream4u|morencius)\.com\/file\//i.test(url)) {
      push(fileCode || url);
    }
  });
  servers.forEach((server) => {
    const url = String(server?.url || "").trim();
    if (/hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(url))
      push(url);
  });
  episodes.forEach((episode) => {
    push(episode?.episodeId);
    push(episode?.url);
  });
  return out;
};
const withSoftTimeout = async (promise, timeoutMs) => {
  return await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
};
const resolveHdstream4uEpisodeId = async (request, mediaInfo) => {
  const mediaIdHint = String(mediaInfo?.tmdbId || mediaInfo?.id || "").trim();
  const mediaTypeHint = String(mediaInfo?.type || mediaInfo?.media_type || "movie").trim();
  if (mediaIdHint) {
    const directInfoRes = await request.server.inject({
      method: "GET",
      url: `/movies/hdstream4u/info?id=${encodeURIComponent(mediaIdHint)}&type=${encodeURIComponent(mediaTypeHint)}`
    });
    if (directInfoRes.statusCode < 400) {
      const directInfoPayload = safeJsonParse(directInfoRes.body || "{}");
      const directCandidates = extractHdstreamMovieCandidateIds(directInfoPayload);
      if (directCandidates.length)
        return directCandidates[0];
    }
  }
  const titleCandidates = getTitleCandidatesFromMedia(mediaInfo);
  if (!titleCandidates.length)
    return "";
  const preferredYear = Number(String(mediaInfo?.releaseDate || mediaInfo?.first_air_date || "").slice(0, 4));
  const searchResults = await Promise.all(
    titleCandidates.map((title) => searchHdhub4uByTitle(title).catch(() => []))
  );
  let matchedUrl = searchResults.flat().map((entry) => {
    const score = titleMatchScore(entry.title, titleCandidates);
    const yearBonus = preferredYear && new RegExp(`(^|[^\\d])${preferredYear}([^\\d]|$)`, "i").test(entry.title) ? 120 : 0;
    const tvLike = /season|episode|series|web[\s-]*series/i.test(entry.title + " " + entry.url);
    const typeBonus = mediaInfo?.type === "tv" || mediaInfo?.media_type === "tv" ? tvLike ? 80 : -40 : tvLike ? -60 : 40;
    return { url: entry.url, score: score + yearBonus + typeBonus };
  }).filter((entry) => entry.score >= 700).sort((a, b) => b.score - a.score)[0]?.url || "";
  if (!matchedUrl) {
    const sitemapUrl = await findBestHdhub4uUrl(
      titleCandidates,
      Number.isFinite(preferredYear) ? preferredYear : void 0
    );
    matchedUrl = sitemapUrl;
  }
  if (!matchedUrl)
    return "";
  const infoRes = await request.server.inject({
    method: "GET",
    url: `/movies/hdstream4u/info?id=${encodeURIComponent(matchedUrl)}`
  });
  if (infoRes.statusCode >= 400)
    return "";
  const infoPayload = safeJsonParse(infoRes.body || "{}");
  const servers = Array.isArray(infoPayload?.servers) ? infoPayload.servers : [];
  const isTv = String(mediaInfo?.type || mediaInfo?.media_type || "").toLowerCase() === "tv";
  const directFileServer = servers.find(
    (server) => /(?:hdstream4u|morencius)\.com\/file\//i.test(String(server?.url || ""))
  );
  const primary = servers.find((server) => /watch\s*online/i.test(String(server?.name || ""))) || servers.find((server) => /^https?:\/\//i.test(String(server?.url || ""))) || servers[0];
  const fallbackEpisode = Array.isArray(infoPayload?.episodes) ? infoPayload.episodes[0] : null;
  if (!isTv) {
    const directFileId = String(
      directFileServer?.fileCode || directFileServer?.url || ""
    ).trim();
    if (directFileId)
      return directFileId;
    const watchOnline = servers.find(
      (server) => /hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(String(server?.url || ""))
    );
    if (watchOnline?.url)
      return String(watchOnline.url).trim();
    const providerMediaId = String(
      infoPayload?.id || matchedUrl || infoPayload?.url || ""
    ).trim();
    if (providerMediaId)
      return providerMediaId;
  }
  return String(
    primary?.url || primary?.fileCode || primary?.id || fallbackEpisode?.episodeId || fallbackEpisode?.url || ""
  ).trim();
};
const buildDramaSlugVariants = (dramaSlug) => {
  const base = normalizeSlug(dramaSlug);
  const set = /* @__PURE__ */ new Set();
  const push = (v) => {
    const clean = v ? normalizeSlug(v) : "";
    if (clean)
      set.add(clean);
  };
  push(base);
  push(stripTrailingYear(base));
  push(base.replace(/-season-\d+$/i, ""));
  push(base.replace(/-s\d+$/i, ""));
  push(base.replace(/-part-\d+$/i, ""));
  push(stripTrailingYear(base.replace(/-season-\d+$/i, "")));
  push(base.replace(/-\d{4}-[a-z]{2,4}$/i, ""));
  push(base.replace(/-[a-z]{2,4}$/i, ""));
  push(base.replace(/-\d{4}$/i, ""));
  const tokens = base.split("-").filter(Boolean);
  if (tokens.length >= 2)
    push(tokens.slice(0, 2).join("-"));
  if (tokens.length >= 1)
    push(tokens[0]);
  return [...set];
};
const convertTmdbImagesToUrls = (data) => {
  if (!data || typeof data !== "object")
    return data;
  const convertPath = (path) => {
    if (!path || typeof path !== "string")
      return null;
    if (path.startsWith("http"))
      return path;
    return `https://image.tmdb.org/t/p/w500${path}`;
  };
  if (data.poster_path)
    data.image = convertPath(data.poster_path);
  if (data.backdrop_path)
    data.cover = convertPath(data.backdrop_path);
  if (data.profile_path)
    data.image = convertPath(data.profile_path);
  if (Array.isArray(data.seasons)) {
    data.seasons = data.seasons.map((season) => {
      if (season.poster_path)
        season.image = convertPath(season.poster_path);
      return season;
    });
  }
  if (Array.isArray(data.episodes)) {
    data.episodes = data.episodes.map((episode) => {
      if (episode.still_path)
        episode.image = convertPath(episode.still_path);
      return episode;
    });
  }
  return data;
};
const buildAnimesaltTmdbInfo = async (request, id, type) => {
  const baseTmdb = new import_extensions.META.TMDB(import_main.tmdbApi);
  const fetchBase = async () => {
    const res = await baseTmdb.fetchMediaInfo(id, type);
    if (res && typeof res === "object") {
      delete res.cast;
      delete res.characters;
      delete res.recommendations;
      delete res.similar;
    }
    return res;
  };
  const baseInfo = import_main.redis ? await import_cache.default.fetch(
    import_main.redis,
    `tmdb:info:${type}:${id}:trailer-v3`,
    fetchBase,
    import_main.REDIS_TTL
  ) : await fetchBase();
  await attachBestTrailer(baseInfo, id, type);
  const titleCandidates = getTitleCandidatesFromMedia(baseInfo);
  if (!titleCandidates.length)
    return baseInfo;
  const yearGuess = Number(
    String(baseInfo?.releaseDate || baseInfo?.firstAirDate || "").slice(0, 4)
  );
  const term = titleCandidates[0];
  try {
    const searchRes = await request.server.inject({
      method: "GET",
      url: `/anime/animesalt/${encodeURIComponent(term)}`
    });
    if (searchRes.statusCode < 400) {
      const payload = safeJsonParse(searchRes.body || "{}");
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const scored = results.map((item) => {
        const itemTitle = String(item?.title || "");
        let score = titleMatchScore(itemTitle, titleCandidates);
        if (Number.isFinite(yearGuess) && yearGuess > 1900) {
          const itemYear = Number(String(item?.releaseDate || "").slice(0, 4));
          if (itemYear === yearGuess)
            score += 50;
        }
        return { item, score };
      }).sort((a, b) => b.score - a.score);
      const pick = scored[0]?.item;
      if (pick && pick.anilistId) {
        const anilistId = String(pick.anilistId);
        if (Array.isArray(baseInfo.seasons)) {
          baseInfo.seasons = baseInfo.seasons.map((season) => {
            if (!Array.isArray(season.episodes))
              return season;
            return {
              ...season,
              episodes: season.episodes.map((ep) => ({
                ...ep,
                id: `${anilistId}$episode$${ep.episode || ep.number}`
              }))
            };
          });
        } else if (Array.isArray(baseInfo.episodes)) {
          baseInfo.episodes = baseInfo.episodes.map((ep) => ({
            ...ep,
            id: `${anilistId}$episode$${ep.episode || ep.number}`
          }));
        }
        baseInfo.anilistId = anilistId;
        baseInfo.id = anilistId;
      }
    }
  } catch {
  }
  convertTmdbImagesToUrls(baseInfo);
  return baseInfo;
};
const buildFlixhqTmdbInfo = async (request, id, type) => {
  const baseTmdb = new import_extensions.META.TMDB(import_main.tmdbApi);
  const fetchBase = async () => {
    let res = null;
    try {
      res = await baseTmdb.fetchMediaInfo(id, type);
    } catch {
      if (import_main.tmdbApi) {
        const directUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${import_main.tmdbApi}`;
        const directRes = await import_axios.default.get(directUrl, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (directRes?.data) {
          const direct = directRes.data;
          const isTv = String(type || "").toLowerCase() === "tv";
          let seasons = Array.isArray(direct?.seasons) ? direct.seasons.map((s) => ({
            id: String(s?.id || ""),
            name: s?.name,
            season: s?.season_number,
            image: s?.poster_path ? `https://image.tmdb.org/t/p/original${s.poster_path}` : null,
            episodes: []
          })) : [];
          if (isTv && seasons.length) {
            const seasonDetails = await Promise.all(
              seasons.filter(
                (s) => Number.isFinite(Number(s?.season)) && Number(s.season) >= 0
              ).slice(0, 25).map(async (s) => {
                try {
                  const seasonNo = Number(s.season);
                  const seasonUrl = `https://api.themoviedb.org/3/tv/${id}/season/${seasonNo}?api_key=${import_main.tmdbApi}&language=en-US`;
                  const seasonRes = await import_axios.default.get(seasonUrl, {
                    headers: { "User-Agent": "Mozilla/5.0" }
                  });
                  const episodes = Array.isArray(seasonRes?.data?.episodes) ? seasonRes.data.episodes.map((ep, idx) => {
                    const epNo = Number(
                      ep?.episode_number || ep?.number || idx + 1
                    );
                    return {
                      id: `${id}-s${seasonNo}e${epNo}`,
                      episode: epNo,
                      number: epNo,
                      title: ep?.name || `Episode ${epNo}`,
                      season: seasonNo
                    };
                  }) : [];
                  return { seasonNo, episodes };
                } catch {
                  return null;
                }
              })
            );
            const bySeasonNo = /* @__PURE__ */ new Map();
            seasonDetails.forEach((entry) => {
              if (!entry || !Number.isFinite(Number(entry.seasonNo)))
                return;
              bySeasonNo.set(
                Number(entry.seasonNo),
                Array.isArray(entry.episodes) ? entry.episodes : []
              );
            });
            seasons = seasons.map((s) => {
              const seasonNo = Number(s?.season || 0);
              return { ...s, episodes: bySeasonNo.get(seasonNo) || [] };
            });
          }
          const movieRuntime = Number(direct?.runtime || 0);
          const tvEpisodeRuntime = Array.isArray(direct?.episode_run_time) && direct.episode_run_time.length ? Number(direct.episode_run_time[0] || 0) : 0;
          const normalizedRuntime = movieRuntime > 0 ? movieRuntime : tvEpisodeRuntime;
          res = {
            id: String(direct?.id || id),
            title: direct?.title || direct?.name || "Unknown",
            type,
            media_type: type,
            description: direct?.overview,
            image: direct?.poster_path ? `https://image.tmdb.org/t/p/original${direct.poster_path}` : null,
            cover: direct?.backdrop_path ? `https://image.tmdb.org/t/p/original${direct.backdrop_path}` : null,
            status: direct?.status,
            releaseDate: direct?.release_date || direct?.first_air_date,
            runtime: normalizedRuntime,
            duration: normalizedRuntime,
            rating: direct?.vote_average,
            genres: Array.isArray(direct?.genres) ? direct.genres.map((g) => g?.name).filter(Boolean) : [],
            totalEpisodes: Number(direct?.number_of_episodes || 0),
            seasons
          };
        }
      }
    }
    if (!res) {
      throw new Error("Failed to fetch base metadata for FlixHQ mapping");
    }
    if (res && typeof res === "object") {
      delete res.cast;
      delete res.characters;
      delete res.recommendations;
      delete res.similar;
    }
    return res;
  };
  const baseInfo = import_main.redis ? await import_cache.default.fetch(
    import_main.redis,
    `tmdb:info:${type}:${id}:flixhq-mapped:v3`,
    fetchBase,
    import_main.REDIS_TTL
  ) : await fetchBase();
  await attachBestTrailer(baseInfo, id, type);
  const titleCandidates = getTitleCandidatesFromMedia(baseInfo);
  if (!titleCandidates.length)
    return baseInfo;
  const yearGuess = Number(
    String(baseInfo?.releaseDate || baseInfo?.firstAirDate || "").slice(0, 4)
  );
  const expectedType = String(type || "").toLowerCase() === "tv" ? "tv" : "movie";
  const resolveAniListId = async () => {
    try {
      const exactAnimeId = await resolveAniListIdByExactMapping(id, expectedType);
      if (exactAnimeId)
        return exactAnimeId;
    } catch {
    }
    const queries = titleCandidates.slice(0, 2);
    for (const query of queries) {
      try {
        const anilistRes = await request.server.inject({
          method: "GET",
          url: `/meta/anilist/${encodeURIComponent(query)}`
        });
        if (anilistRes.statusCode >= 400)
          continue;
        const anilistPayload = safeJsonParse(anilistRes.body || "{}");
        const anilistRows = Array.isArray(anilistPayload?.results) ? anilistPayload.results : [];
        if (!anilistRows.length)
          continue;
        const picked = anilistRows.map((item) => ({
          item,
          score: titleMatchScore(
            String(item?.title || item?.name || ""),
            titleCandidates
          )
        })).sort((a, b) => b.score - a.score)[0]?.item;
        const pickedId = String(picked?.id || "").trim();
        if (pickedId)
          return pickedId;
      } catch {
        continue;
      }
    }
    return null;
  };
  const animeId = await resolveAniListId();
  if (animeId)
    baseInfo.anilistId = animeId;
  const mainTerms = titleCandidates.slice(0, 2);
  const searchTerms = Array.from(
    /* @__PURE__ */ new Set([
      ...mainTerms,
      // Prioritize exact title matches first
      ...mainTerms.flatMap(
        (title) => Number.isFinite(yearGuess) && yearGuess > 1900 ? [`${title} ${yearGuess}`] : []
      )
    ])
  ).slice(0, 4);
  const searchPromises = searchTerms.map(async (term) => {
    try {
      const searchRes = await request.server.inject({
        method: "GET",
        url: `/movies/flixhq/${encodeURIComponent(term)}`
      });
      if (searchRes.statusCode >= 400)
        return [];
      const payload = safeJsonParse(searchRes.body || "{}");
      return Array.isArray(payload?.data) ? payload.data : [];
    } catch {
      return [];
    }
  });
  const searchResults = await Promise.all(searchPromises);
  const combinedResults = searchResults.flat();
  const seen = /* @__PURE__ */ new Set();
  const deduped = combinedResults.filter((row) => {
    const key = String(row?.id || "").trim();
    if (!key || seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
  const scored = deduped.map((item) => {
    const itemType = normalizeText(String(item?.type || ""));
    const itemTitle = String(item?.name || item?.title || "");
    const score = titleMatchScore(itemTitle, titleCandidates) + (itemType === expectedType ? 120 : -250) + (() => {
      const rowYear = Number(item?.releaseDate);
      if (!Number.isFinite(yearGuess) || yearGuess <= 1900 || !Number.isFinite(rowYear))
        return 0;
      if (rowYear === yearGuess)
        return 30;
      if (Math.abs(rowYear - yearGuess) === 1)
        return 10;
      return 0;
    })() + (() => {
      if (expectedType !== "tv")
        return 0;
      const baseSeasons = Array.isArray(baseInfo?.seasons) ? baseInfo.seasons.length : 0;
      const rowSeasons = Number(item?.seasons || 0);
      if (!baseSeasons || !rowSeasons)
        return 0;
      if (baseSeasons === rowSeasons)
        return 12;
      if (Math.abs(baseSeasons - rowSeasons) <= 1)
        return 5;
      return 0;
    })();
    return { item, score };
  }).sort((a, b) => b.score - a.score);
  const topMatch = scored[0];
  if (topMatch && topMatch.score > 1100) {
    const pick2 = topMatch.item;
    if (pick2?.id) {
      try {
        const infoRes = await request.server.inject({
          method: "GET",
          url: `/movies/flixhq/info?id=${encodeURIComponent(String(pick2.id))}`
        });
        if (infoRes.statusCode < 400) {
          const payload = safeJsonParse(infoRes.body || "{}");
          const providerEpisodes = Array.isArray(payload?.providerEpisodes) ? payload.providerEpisodes : Array.isArray(payload?.data?.providerEpisodes) ? payload.data.providerEpisodes : [];
          if (providerEpisodes.length > 0) {
            const bySeasonEpisode = /* @__PURE__ */ new Map();
            for (const ep of providerEpisodes) {
              const seasonNum = Number(ep?.seasonNumber || 0);
              const episodeNum = Number(ep?.episodeNumber || 0);
              if (!seasonNum || !episodeNum)
                continue;
              bySeasonEpisode.set(`${seasonNum}:${episodeNum}`, ep);
            }
            if (Array.isArray(baseInfo?.seasons)) {
              baseInfo.seasons = baseInfo.seasons.map(
                (season, seasonIndex) => {
                  const seasonNum = Number(season?.season || seasonIndex + 1);
                  if (!Array.isArray(season?.episodes))
                    return season;
                  return {
                    ...season,
                    episodes: season.episodes.map(
                      (episode, episodeIndex) => {
                        const episodeNum = Number(
                          episode?.episode || episode?.number || episodeIndex + 1
                        );
                        const mapped = bySeasonEpisode.get(`${seasonNum}:${episodeNum}`);
                        if (!mapped?.episodeId)
                          return episode;
                        return {
                          ...episode,
                          id: mapped.episodeId,
                          url: mapped.episodeId
                        };
                      }
                    )
                  };
                }
              );
            }
            baseInfo.provider = "flixhq";
            baseInfo.providerSourceId = pick2.id;
            return baseInfo;
          }
        }
      } catch {
      }
    }
  }
  let pick = scored[0]?.item;
  if (!pick?.id)
    return baseInfo;
  try {
    const infoRes = await request.server.inject({
      method: "GET",
      url: `/movies/flixhq/info?id=${encodeURIComponent(String(pick.id))}`
    });
    if (infoRes.statusCode >= 400)
      return baseInfo;
    const payload = safeJsonParse(infoRes.body || "{}");
    const providerEpisodes = Array.isArray(payload?.providerEpisodes) ? payload.providerEpisodes : Array.isArray(payload?.data?.providerEpisodes) ? payload.data.providerEpisodes : [];
    if (!providerEpisodes.length)
      return baseInfo;
    const bySeasonEpisode = /* @__PURE__ */ new Map();
    for (const ep of providerEpisodes) {
      const seasonNum = Number(ep?.seasonNumber || 0);
      const episodeNum = Number(ep?.episodeNumber || 0);
      if (!seasonNum || !episodeNum)
        continue;
      bySeasonEpisode.set(`${seasonNum}:${episodeNum}`, ep);
    }
    if (Array.isArray(baseInfo?.seasons)) {
      baseInfo.seasons = baseInfo.seasons.map((season, seasonIndex) => {
        const seasonNum = Number(season?.season || seasonIndex + 1);
        if (!Array.isArray(season?.episodes))
          return season;
        return {
          ...season,
          episodes: season.episodes.map((episode, episodeIndex) => {
            const episodeNum = Number(
              episode?.episode || episode?.number || episodeIndex + 1
            );
            const mapped = bySeasonEpisode.get(`${seasonNum}:${episodeNum}`);
            if (!mapped?.episodeId)
              return episode;
            return {
              ...episode,
              id: mapped.episodeId,
              url: mapped.episodeId
            };
          })
        };
      });
    }
    baseInfo.provider = "flixhq";
    baseInfo.providerSourceId = pick.id;
    convertTmdbImagesToUrls(baseInfo);
    return baseInfo;
  } catch {
    return baseInfo;
  }
};
const routes = async (fastify, options) => {
  fastify.get("/", (_, rp) => {
    rp.status(200).send({
      intro: "Welcome to the tmdb provider: check out the provider's website @ https://www.themoviedb.org/",
      routes: ["/:query", "/info/:id", "/watch/:episodeId"],
      documentation: "https://docs.consumet.org/#tag/tmdb"
    });
  });
  fastify.get("/:query", async (request, reply) => {
    const query = request.params.query;
    const page = request.query.page;
    const tmdb = configureMeta(
      new import_extensions.META.TMDB(import_main.tmdbApi)
    );
    try {
      const fetchSearch = async () => {
        return await tmdb.search(query, page);
      };
      let res = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `tmdb:search:${query}:${page || 1}`,
        fetchSearch,
        import_main.REDIS_TTL
      ) : await fetchSearch();
      const rescued = await getDirectTmdbSearch(query, page);
      if (rescued?.results?.length) {
        res = {
          ...rescued,
          results: rescued.results
        };
      } else if (!res || !Array.isArray(res.results) || res.results.length === 0) {
        res = { results: [], total_results: 0, message: "No TMDB results found" };
      }
      reply.status(200).send(res);
    } catch (err) {
      console.error("TMDB Search Error:", err);
      const rescued = await getDirectTmdbSearch(query, page);
      if (rescued) {
        return reply.status(200).send({ ...rescued, message: "Search results rescued after fetch failure" });
      }
      reply.status(200).send({
        results: [],
        total_results: 0,
        message: "Search failed, please try again or check TMDB key."
      });
    }
  });
  const getDirectTmdbSearch = async (query, page = 1) => {
    try {
      if (!import_main.tmdbApi)
        return null;
      const encodedQuery = encodeURIComponent(query);
      const headers = { "User-Agent": "Mozilla/5.0" };
      const [multiRes, movieRes, tvRes] = await Promise.all(
        ["multi", "movie", "tv"].map(
          (kind) => import_axios.default.get(
            `https://api.themoviedb.org/3/search/${kind}?api_key=${import_main.tmdbApi}&query=${encodedQuery}&page=${page}`,
            { headers }
          )
        )
      );
      const merged = /* @__PURE__ */ new Map();
      for (const [kind, response] of [
        ["multi", multiRes],
        ["movie", movieRes],
        ["tv", tvRes]
      ]) {
        for (const item of Array.isArray(response.data?.results) ? response.data.results : []) {
          if (item?.id === void 0 || item?.id === null || item.media_type === "person")
            continue;
          const type = kind === "tv" || item.media_type === "tv" ? "tv" : "movie";
          const key = `${type}:${item.id}`;
          if (!merged.has(key))
            merged.set(key, { ...item, media_type: type });
        }
      }
      if (merged.size) {
        const results = Array.from(merged.values());
        return {
          results: results.map((item) => ({
            id: String(item.id),
            title: item.title || item.name || "Unknown",
            image: item.poster_path ? `https://image.tmdb.org/t/p/original${item.poster_path}` : null,
            type: item.media_type === "tv" ? "tv" : "movie",
            releaseDate: item.release_date || item.first_air_date,
            rating: item.vote_average
          })),
          total_results: Math.max(
            Number(multiRes.data?.total_results || 0),
            Number(movieRes.data?.total_results || 0),
            Number(tvRes.data?.total_results || 0)
          ),
          total_pages: Math.max(
            Number(multiRes.data?.total_pages || 0),
            Number(movieRes.data?.total_pages || 0),
            Number(tvRes.data?.total_pages || 0)
          )
        };
      }
    } catch (err) {
      console.error("Direct TMDB Search Error:", err);
    }
    return null;
  };
  const getAlternateTmdbType = (type) => String(type || "").toLowerCase() === "tv" ? "movie" : "tv";
  const fetchDirectTmdbPayload = async (id, type) => {
    const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${import_main.tmdbApi}`;
    return import_axios.default.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 5e3
    });
  };
  const getDirectTmdbInfo = async (id, type, includeSeasons = false) => {
    try {
      if (!import_main.tmdbApi)
        return null;
      let resolvedType = String(type || "").toLowerCase() === "tv" ? "tv" : "movie";
      let res = null;
      try {
        res = await fetchDirectTmdbPayload(id, resolvedType);
      } catch (err) {
        const status = Number(err?.response?.status || 0);
        if (status === 404) {
          const alternateType = getAlternateTmdbType(resolvedType);
          try {
            res = await fetchDirectTmdbPayload(id, alternateType);
            resolvedType = alternateType;
          } catch (altErr) {
            const altStatus = Number(altErr?.response?.status || 0);
            if (altStatus !== 404) {
              console.error("Direct TMDB Fetch Error:", altErr);
            }
            return null;
          }
        } else {
          console.error("Direct TMDB Fetch Error:", err);
          return null;
        }
      }
      if (res.data) {
        const isTv = resolvedType === "tv";
        const movieRuntime = Number(res.data.runtime || 0);
        const tvEpisodeRuntime = Array.isArray(res.data.episode_run_time) && res.data.episode_run_time.length ? Number(res.data.episode_run_time[0] || 0) : 0;
        const normalizedRuntime = movieRuntime > 0 ? movieRuntime : tvEpisodeRuntime;
        let seasons = Array.isArray(res.data.seasons) ? res.data.seasons.map((s) => ({
          id: s?.id !== void 0 && s?.id !== null ? String(s.id) : `${id}-season-${s?.season_number ?? ""}`,
          name: s.name,
          season: s.season_number,
          image: s.poster_path ? `https://image.tmdb.org/t/p/original${s.poster_path}` : null,
          episodes: []
        })) : [];
        if (isTv && includeSeasons && seasons.length) {
          const seasonFetches = seasons.filter(
            (s) => Number.isFinite(Number(s?.season)) && Number(s.season) >= 0
          ).slice(0, 25).map(async (s) => {
            try {
              const seasonNo = Number(s.season);
              const seasonUrl = `https://api.themoviedb.org/3/tv/${id}/season/${seasonNo}?api_key=${import_main.tmdbApi}&language=en-US`;
              const seasonRes = await import_axios.default.get(seasonUrl, {
                headers: { "User-Agent": "Mozilla/5.0" },
                timeout: 5e3
              });
              const episodes = Array.isArray(seasonRes?.data?.episodes) ? seasonRes.data.episodes.map((ep, idx) => {
                const epNo = Number(ep?.episode_number || ep?.number || idx + 1);
                return {
                  id: `${id}-s${seasonNo}e${epNo}`,
                  episode: epNo,
                  number: epNo,
                  title: ep?.name || `Episode ${epNo}`,
                  season: seasonNo
                };
              }) : [];
              return { seasonNo, episodes };
            } catch {
              return null;
            }
          });
          const seasonDetails = await Promise.all(seasonFetches);
          const bySeasonNo = /* @__PURE__ */ new Map();
          seasonDetails.forEach((entry) => {
            if (!entry || !Number.isFinite(Number(entry.seasonNo)))
              return;
            bySeasonNo.set(
              Number(entry.seasonNo),
              Array.isArray(entry.episodes) ? entry.episodes : []
            );
          });
          seasons = seasons.map((s) => {
            const seasonNo = Number(s?.season || 0);
            return { ...s, episodes: bySeasonNo.get(seasonNo) || [] };
          });
        }
        return {
          id: res.data?.id !== void 0 && res.data?.id !== null ? String(res.data.id) : String(id),
          title: res.data.title || res.data.name || "Unknown",
          type: resolvedType,
          media_type: resolvedType,
          description: res.data.overview,
          image: `https://image.tmdb.org/t/p/original${res.data.poster_path}`,
          cover: `https://image.tmdb.org/t/p/original${res.data.backdrop_path}`,
          status: res.data.status,
          releaseDate: res.data.release_date || res.data.first_air_date,
          runtime: normalizedRuntime,
          duration: normalizedRuntime,
          rating: res.data.vote_average,
          genres: res.data.genres?.map((g) => g.name) || [],
          totalEpisodes: res.data.number_of_episodes || (res.data.episodes ? res.data.episodes.length : 0),
          seasons
          // Minimal info to keep UI working
        };
      }
    } catch (err) {
      console.error("Direct TMDB Fetch Error:", err);
    }
    return null;
  };
  const getRequestedSeason = async (request, reply, id) => {
    const query = request.query;
    if (query.type !== "tv" || query.details !== "true" || query.season === void 0 || query.provider)
      return false;
    const season = Number(query.season);
    if (!/^\d+$/.test(id || "") || !/^\d+$/.test(query.season) || !Number.isSafeInteger(season)) {
      reply.status(400).send({ message: "Invalid TMDB show or season number" });
      return true;
    }
    try {
      const response = await import_axios.default.get(`https://api.themoviedb.org/3/tv/${id}/season/${season}`, {
        params: { api_key: import_main.tmdbApi, language: "en-US" },
        timeout: 1e4
      });
      reply.send({ ...response.data, tmdb_id: String(id) });
    } catch (_) {
      reply.status(502).send({ message: "TMDB season metadata unavailable" });
    }
    return true;
  };
  fastify.get("/info", async (request, reply) => {
    const sanitizeType = (t) => {
      if (!t || t === "undefined" || t === "null")
        return void 0;
      return String(t).toLowerCase();
    };
    const id = request.query.id;
    if (await getRequestedSeason(request, reply, id))
      return;
    let type = sanitizeType(request.query.type);
    const provider = request.query.provider;
    const providerLower = provider?.toLowerCase();
    let tmdb = createTmdbClient(void 0);
    if (!id)
      return reply.status(400).send({ message: "The 'id' query is required" });
    if (!type || type !== "movie" && type !== "tv") {
      console.log(`[SmartGuess] type missing for id ${id}, attempting resolution...`);
      try {
        const tvQuery = `https://api.themoviedb.org/3/tv/${id}?api_key=${import_main.tmdbApi}`;
        const tvRes = await import_axios.default.get(tvQuery).catch(() => null);
        if (tvRes?.data) {
          type = "tv";
          console.log(`[SmartGuess] Resolved id ${id} as 'tv'`);
        } else {
          const movieQuery = `https://api.themoviedb.org/3/movie/${id}?api_key=${import_main.tmdbApi}`;
          const movieRes = await import_axios.default.get(movieQuery).catch(() => null);
          if (movieRes?.data) {
            type = "movie";
            console.log(`[SmartGuess] Resolved id ${id} as 'movie'`);
          }
        }
      } catch {
      }
    }
    if (!type) {
      return reply.status(400).send({
        message: "The 'type' query is required and could not be auto-resolved."
      });
    }
    if (!import_main.tmdbApi) {
      const rescued = await getDirectTmdbInfo(id, type);
      if (rescued) {
        await attachBestTrailer(rescued, id, type);
        convertTmdbImagesToUrls(rescued);
        return reply.status(200).send(rescued);
      }
      return reply.status(200).send({
        id,
        title: "Unknown",
        type,
        media_type: type,
        episodes: [],
        message: "TMDB key not configured on the server."
      });
    }
    if (!providerLower) {
      const fetchDirect = async () => {
        const direct = await getDirectTmdbInfo(
          id,
          type,
          String(type || "").toLowerCase() === "tv"
        );
        if (!direct)
          return null;
        await attachBestTrailer(direct, id, type);
        convertTmdbImagesToUrls(direct);
        return direct;
      };
      const directRes = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `tmdb:info:direct:${type}:${id}:seasons-v2`,
        fetchDirect,
        import_main.REDIS_TTL
      ) : await fetchDirect();
      if (directRes) {
        return reply.status(200).send(directRes);
      }
    }
    if (providerLower === "animesalt") {
      try {
        const res = await buildAnimesaltTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }
    if (providerLower === "flixhq") {
      try {
        const res = await buildFlixhqTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }
    if (typeof provider !== "undefined") {
      const selectedProvider = resolveMovieProvider(provider);
      if (selectedProvider) {
        tmdb = createTmdbClient(selectedProvider);
        if (!tmdb) {
          return reply.status(200).send({
            id,
            title: "Unknown",
            type,
            media_type: type,
            episodes: [],
            message: "TMDB key not configured on the server."
          });
        }
      } else {
        const possibleProvider = import_extensions.PROVIDERS_LIST.MOVIES.find(
          (p) => p.name.toLowerCase() === provider.toLocaleLowerCase() && p.name.toLowerCase() !== "flixhq"
        );
        tmdb = createTmdbClient(possibleProvider);
        if (!tmdb) {
          return reply.status(200).send({
            id,
            title: "Unknown",
            type,
            media_type: type,
            episodes: [],
            message: "TMDB key not configured on the server."
          });
        }
      }
    }
    try {
      const fetchInfo = async () => {
        const info = await tmdb.fetchMediaInfo(id, type);
        if (info && typeof info === "object") {
          delete info.cast;
          delete info.characters;
          delete info.recommendations;
          delete info.similar;
          await attachBestTrailer(info, id, type);
          convertTmdbImagesToUrls(info);
        }
        return info;
      };
      let res = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `tmdb:info:${type}:${id}:${provider || "default"}:trailer-v3`,
        fetchInfo,
        import_main.REDIS_TTL
      ) : await fetchInfo();
      if (!res || !res.title || res.title === "Unknown") {
        const rescued = await getDirectTmdbInfo(id, type);
        if (rescued) {
          await attachBestTrailer(rescued, id, type);
          convertTmdbImagesToUrls(rescued);
          res = {
            ...res || {},
            ...rescued,
            message: "Metadata partially rescued via direct fetch"
          };
        }
      }
      reply.status(200).send(res);
    } catch (err) {
      logTmdbFailure("TMDB Info Error", err);
      const rescued = await getDirectTmdbInfo(id, type);
      if (rescued) {
        await attachBestTrailer(rescued, id, type);
        convertTmdbImagesToUrls(rescued);
        return reply.status(200).send({
          ...rescued,
          episodes: [],
          message: "Metadata rescued after fetch failure"
        });
      }
      reply.status(200).send({
        id,
        title: "Unknown",
        episodes: [],
        message: "TMDB metadata fetch failed"
      });
    }
  });
  fastify.get("/info/:id", async (request, reply) => {
    const sanitizeType = (t) => {
      if (!t || t === "undefined" || t === "null")
        return void 0;
      return String(t).toLowerCase();
    };
    const id = request.params.id;
    if (await getRequestedSeason(request, reply, id))
      return;
    let type = sanitizeType(request.query.type);
    const provider = request.query.provider;
    const providerLower = provider?.toLowerCase();
    let tmdb = createTmdbClient(void 0);
    if (!type || type !== "movie" && type !== "tv") {
      console.log(`[SmartGuess] type missing for id ${id}, attempting resolution...`);
      try {
        const tvQuery = `https://api.themoviedb.org/3/tv/${id}?api_key=${import_main.tmdbApi}`;
        const tvRes = await import_axios.default.get(tvQuery).catch(() => null);
        if (tvRes?.data) {
          type = "tv";
          console.log(`[SmartGuess] Resolved id ${id} as 'tv'`);
        } else {
          const movieQuery = `https://api.themoviedb.org/3/movie/${id}?api_key=${import_main.tmdbApi}`;
          const movieRes = await import_axios.default.get(movieQuery).catch(() => null);
          if (movieRes?.data) {
            type = "movie";
            console.log(`[SmartGuess] Resolved id ${id} as 'movie'`);
          }
        }
      } catch {
      }
    }
    if (!type) {
      return reply.status(400).send({
        message: "The 'type' query is required and could not be auto-resolved."
      });
    }
    if (!import_main.tmdbApi) {
      return reply.status(200).send({
        id,
        title: "Unknown",
        type,
        media_type: type,
        episodes: [],
        message: "TMDB key not configured on the server."
      });
    }
    if (!providerLower) {
      const fetchDirect = async () => {
        const direct = await getDirectTmdbInfo(
          id,
          type,
          String(type || "").toLowerCase() === "tv"
        );
        if (!direct)
          return null;
        await attachBestTrailer(direct, id, type);
        convertTmdbImagesToUrls(direct);
        return direct;
      };
      const directRes = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `tmdb:info:direct:${type}:${id}:seasons-v2`,
        fetchDirect,
        import_main.REDIS_TTL
      ) : await fetchDirect();
      if (directRes) {
        return reply.status(200).send(directRes);
      }
    }
    if (providerLower === "animesalt") {
      try {
        const res = await buildAnimesaltTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }
    if (providerLower === "flixhq") {
      try {
        const res = await buildFlixhqTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }
    if (typeof provider !== "undefined") {
      const selectedProvider = resolveMovieProvider(provider);
      if (selectedProvider) {
        tmdb = createTmdbClient(selectedProvider);
      } else {
        const possibleProvider = import_extensions.PROVIDERS_LIST.MOVIES.find(
          (p) => p.name.toLowerCase() === provider.toLocaleLowerCase()
        );
        tmdb = createTmdbClient(possibleProvider);
      }
    }
    try {
      const fetchInfo = async () => {
        const info = await tmdb.fetchMediaInfo(id, type);
        if (info && typeof info === "object") {
          delete info.cast;
          delete info.characters;
          delete info.recommendations;
          delete info.similar;
          await attachBestTrailer(info, id, type);
          convertTmdbImagesToUrls(info);
        }
        return info;
      };
      let res = import_main.redis ? await import_cache.default.fetch(
        import_main.redis,
        `tmdb:info:${type}:${id}:${provider || "default"}:trailer-v3`,
        fetchInfo,
        import_main.REDIS_TTL
      ) : await fetchInfo();
      if (!res || !res.title || res.title === "Unknown") {
        const rescued = await getDirectTmdbInfo(id, type);
        if (rescued) {
          await attachBestTrailer(rescued, id, type);
          convertTmdbImagesToUrls(rescued);
          res = {
            ...res || {},
            ...rescued,
            message: "Metadata partially rescued via direct fetch"
          };
        }
      }
      reply.status(200).send(res);
    } catch (err) {
      logTmdbFailure("TMDB Info ID Error", err);
      const rescued = await getDirectTmdbInfo(id, type);
      if (rescued) {
        await attachBestTrailer(rescued, id, type);
        convertTmdbImagesToUrls(rescued);
        return reply.status(200).send({
          ...rescued,
          episodes: [],
          message: "Metadata rescued after fetch failure"
        });
      }
      reply.status(200).send({
        id,
        title: "Unknown",
        episodes: [],
        message: "TMDB metadata fetch failed"
      });
    }
  });
  fastify.get("/trending", async (request, reply) => {
    const validTimePeriods = /* @__PURE__ */ new Set(["day", "week"]);
    const sanitizeType = (t) => {
      if (!t || t === "undefined" || t === "null")
        return "all";
      return String(t).toLowerCase();
    };
    const type = sanitizeType(request.query.type);
    let timePeriod = request.query.timePeriod || "day";
    if (!validTimePeriods.has(timePeriod))
      timePeriod = "day";
    const page = request.query.page || 1;
    if (!import_main.tmdbApi) {
      return reply.status(200).send({
        results: [],
        page,
        message: "TMDB key not configured on the server."
      });
    }
    try {
      let res = await getDirectTmdbTrending(type, timePeriod, page);
      if (!res || !Array.isArray(res.results) || res.results.length === 0) {
        const tmdb = createTmdbClient(void 0);
        if (tmdb) {
          res = await tmdb.fetchTrending(type, timePeriod, page);
        }
      }
      if (res && Array.isArray(res.results)) {
        res.results.forEach((item) => {
          delete item.cast;
          delete item.characters;
        });
      }
      reply.status(200).send(res);
    } catch (err) {
      console.error("TMDB Trending Error:", err);
      const rescued = await getDirectTmdbTrending(type, timePeriod, page);
      if (rescued) {
        return reply.status(200).send({ ...rescued, message: "Trending rescued after fetch failure" });
      }
      reply.status(200).send({
        results: [],
        message: "Trending currently unavailable, please check TMDB key."
      });
    }
  });
  const getDirectTmdbTrending = async (type = "all", timePeriod = "day", page = 1) => {
    try {
      if (!import_main.tmdbApi)
        return null;
      const url = `https://api.themoviedb.org/3/trending/${type}/${timePeriod}?api_key=${import_main.tmdbApi}&page=${page}`;
      const res = await import_axios.default.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.data && Array.isArray(res.data.results)) {
        return {
          results: res.data.results.filter((item) => item?.id !== void 0 && item?.id !== null).map((item) => ({
            id: String(item.id),
            title: item.title || item.name || "Unknown",
            image: item.poster_path ? `https://image.tmdb.org/t/p/original${item.poster_path}` : null,
            type: item.media_type || (type === "all" ? "movie" : type),
            releaseDate: item.release_date || item.first_air_date,
            rating: item.vote_average
          })),
          page: res.data.page
        };
      }
    } catch (err) {
      console.error("Direct TMDB Trending Error:", err);
    }
    return null;
  };
  const watch = async (request, reply) => {
    const sanitizeType = (t) => {
      if (!t || t === "undefined" || t === "null")
        return void 0;
      return String(t).toLowerCase();
    };
    let episodeId = request.params.episodeId;
    if (!episodeId) {
      episodeId = request.query.episodeId;
    }
    const id = request.query.id;
    const type = sanitizeType(request.query.type);
    const provider = request.query.provider;
    const providerLower = provider?.toLowerCase();
    const server = request.query.server;
    const directOnlyRaw = String(
      request.query.directOnly || ""
    ).toLowerCase();
    const directOnly = directOnlyRaw === "1" || directOnlyRaw === "true" || directOnlyRaw === "yes";
    const sourceType = String(
      request.query.source_type || request.query.category || ""
    ).toLowerCase();
    const requestedSeasonForCache = String(
      request.query.season || ""
    );
    const requestedEpisodeForCache = String(
      request.query.episode || ""
    );
    console.log(
      `[tmdb.ts] watch hit: id=${id}, type=${type}, provider=${provider}, providerLower=${providerLower}`
    );
    const cacheKey = !server ? `tmdb:watch:v5:${type}:${id}:${provider || "default"}:${requestedSeasonForCache}:${requestedEpisodeForCache}:${episodeId || ""}:${directOnly}:${sourceType}` : null;
    if (cacheKey && import_main.redis) {
      try {
        const cached = await import_main.redis.get(cacheKey);
        if (cached) {
          const payload = JSON.parse(cached);
          const cachedCookie = String(payload?.headers?.Cookie || "").trim();
          if (providerLower === "hdstream4u" && !cachedCookie) {
          } else {
            return reply.status(200).send(payload);
          }
        }
      } catch {
      }
    }
    if (providerLower === "hdstream4u" && type === "movie" && id) {
      try {
        const infoRes = await request.server.inject({
          method: "GET",
          url: `/movies/hdstream4u/info?id=${encodeURIComponent(String(id))}&type=movie`
        });
        if (infoRes.statusCode < 400) {
          const infoPayload = safeJsonParse(infoRes.body || "{}");
          const candidates = extractHdstreamMovieCandidateIds(infoPayload).slice(0, 3);
          if (candidates.length) {
            const raced = await Promise.any(
              candidates.map(async (candidateId) => {
                const payload = await withSoftTimeout(
                  import_hdstream4uProvider.HdStream4uProvider.fetchSources(
                    candidateId,
                    "hdstream4u",
                    false,
                    { mediaId: String(id) }
                  ),
                  3e4
                );
                const sources = Array.isArray(payload?.sources) ? payload.sources : [];
                if (!sources.length)
                  throw new Error("no sources");
                return payload;
              })
            ).catch(() => null);
            if (raced) {
              if (cacheKey && import_main.redis) {
                import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(raced)).catch(() => {
                });
              }
              return reply.status(200).send(raced);
            }
          }
        }
      } catch {
      }
    }
    if (providerLower && ANIME_PROVIDER_ROUTES[providerLower]) {
      let resolvedEpisodeId = episodeId;
      if (providerLower === "animesalt" && (!resolvedEpisodeId || !resolvedEpisodeId.includes("$"))) {
        try {
          const info = await buildAnimesaltTmdbInfo(request, id, type || "tv");
          const requestedSeason = Number(
            request.query.season || 1
          );
          const requestedEpisode = Number(
            request.query.episode || 1
          );
          const seasonMatch = Array.isArray(info?.seasons) ? info.seasons.find((s) => Number(s?.season || 1) === requestedSeason) : void 0;
          const epMatch = Array.isArray(seasonMatch?.episodes) ? seasonMatch.episodes.find(
            (ep) => Number(ep?.episode || ep?.number || 0) === requestedEpisode
          ) : void 0;
          if (epMatch?.id) {
            resolvedEpisodeId = epMatch.id;
          }
        } catch {
        }
      }
      if (!resolvedEpisodeId) {
        return reply.status(400).send({ message: `episodeId is required for ${providerLower} watch` });
      }
      const animeBaseUrl = ANIME_PROVIDER_ROUTES[providerLower];
      const queryParts = [];
      if (server) {
        queryParts.push(`server=${encodeURIComponent(server)}`);
      }
      if (providerLower === "hianime")
        queryParts.push("category=both");
      if (directOnly)
        queryParts.push("directOnly=true");
      const queryString = queryParts.length ? `?${queryParts.join("&")}` : "";
      const redirectUrl = `${animeBaseUrl}/watch/${resolvedEpisodeId}${queryString}`;
      return reply.redirect(redirectUrl);
    }
    if (type === "movie" && id && providerLower === "flixhq" && !episodeId) {
      try {
        let titleForSearch = "";
        try {
          const baseTmdb = new import_extensions.META.TMDB(import_main.tmdbApi);
          let mediaInfo;
          try {
            mediaInfo = await baseTmdb.fetchMediaInfo(id, "movie");
          } catch {
            mediaInfo = await getDirectTmdbInfo(id, "movie");
          }
          if (mediaInfo?.title) {
            titleForSearch = mediaInfo.title;
          }
        } catch {
        }
        if (titleForSearch) {
          try {
            const searchRes = await request.server.inject({
              method: "GET",
              url: `/movies/flixhq/${encodeURIComponent(titleForSearch)}`
            });
            if (searchRes.statusCode < 400) {
              const payload = safeJsonParse(searchRes.body || "{}");
              const results = Array.isArray(payload?.data) ? payload.data : [];
              const movieMatch = results.filter(
                (item) => normalizeText(String(item?.type || "")) === "movie"
              ).map((item) => ({
                item,
                score: titleMatchScore(String(item?.name || item?.title || ""), [
                  titleForSearch
                ])
              })).sort((a, b) => b.score - a.score)[0]?.item;
              if (movieMatch?.id) {
                const queryParts = [`episodeId=${encodeURIComponent(movieMatch.id)}`];
                if (server)
                  queryParts.push(`server=${encodeURIComponent(server)}`);
                if (server)
                  queryParts.push("strictServer=true");
                if (directOnly)
                  queryParts.push("directOnly=true");
                if (!directOnly)
                  queryParts.push("allowEmbedFallback=true");
                const watchRes = await request.server.inject({
                  method: "GET",
                  url: `/movies/flixhq/watch?${queryParts.join("&")}`
                });
                if (watchRes.statusCode < 400) {
                  const watchPayload = safeJsonParse(watchRes.body || "{}");
                  const sources = Array.isArray(watchPayload?.sources) ? watchPayload.sources : [];
                  if (sources.length > 0) {
                    if (!directOnly || sources.some(
                      (src) => /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(src?.url || ""))
                    )) {
                      if (cacheKey && import_main.redis) {
                        import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(watchPayload)).catch(() => {
                        });
                      }
                      return reply.status(200).send(watchPayload);
                    }
                  }
                }
              }
            }
          } catch {
          }
        }
      } catch {
      }
    }
    const resolveFlixhqTvEpisodeId = async () => {
      const requestedSeason = Number(request.query.season || 1);
      const requestedEpisode = Number(
        request.query.episode || 1
      );
      const pickEpisodeId = (info) => {
        const seasonMatch = Array.isArray(info?.seasons) ? info.seasons.find(
          (s) => Number(s?.season || s?.number || 1) === requestedSeason
        ) : void 0;
        const epMatch = Array.isArray(seasonMatch?.episodes) ? seasonMatch.episodes.find(
          (ep) => Number(ep?.episode || ep?.number || ep?.episodeNumber || 0) === requestedEpisode
        ) : void 0;
        const providerEpisodeMatch = Array.isArray(info?.providerEpisodes) ? info.providerEpisodes.find(
          (ep) => Number(ep?.seasonNumber || ep?.season || 1) === requestedSeason && Number(ep?.episodeNumber || ep?.episode || ep?.number || 0) === requestedEpisode
        ) : void 0;
        return String(
          epMatch?.id || epMatch?.episodeId || epMatch?.url || providerEpisodeMatch?.episodeId || providerEpisodeMatch?.id || providerEpisodeMatch?.url || ""
        ).trim();
      };
      try {
        const info = await buildFlixhqTmdbInfo(
          request,
          String(id || ""),
          String(type || "tv")
        );
        const mapped = pickEpisodeId(info);
        if (mapped)
          return mapped;
      } catch {
      }
      const mediaInfo = await getDirectTmdbInfo(
        String(id || ""),
        String(type || "tv")
      );
      const title = String(mediaInfo?.title || mediaInfo?.name || "").trim();
      if (!title)
        return "";
      const searchRes = await request.server.inject({
        method: "GET",
        url: `/movies/flixhq/${encodeURIComponent(title)}`
      });
      if (searchRes.statusCode >= 400)
        return "";
      const searchPayload = safeJsonParse(searchRes.body || "{}");
      const results = Array.isArray(searchPayload?.data) ? searchPayload.data : [];
      const yearGuess = Number(
        String(mediaInfo?.releaseDate || mediaInfo?.firstAirDate || "").slice(0, 4)
      );
      const scored = results.filter((row) => String(row?.id || "").trim()).map((row) => ({
        row,
        score: titleMatchScore(String(row?.name || row?.title || ""), [title]) + (Number(String(row?.releaseDate || "").slice(0, 4)) === yearGuess ? 50 : 0) + (String(row?.type || "").toLowerCase().includes("tv") ? 20 : 0)
      })).sort((a, b) => b.score - a.score);
      const flixId = String(scored[0]?.row?.id || "").trim();
      if (!flixId)
        return "";
      const infoRes = await request.server.inject({
        method: "GET",
        url: `/movies/flixhq/info?id=${encodeURIComponent(flixId)}&type=tv`
      });
      if (infoRes.statusCode >= 400)
        return "";
      return pickEpisodeId(safeJsonParse(infoRes.body || "{}"));
    };
    if (!episodeId && type === "tv" && id && (!providerLower || providerLower === "flixhq")) {
      try {
        episodeId = await resolveFlixhqTvEpisodeId() || episodeId;
      } catch {
      }
    }
    const syntheticTmdbEpisodeId = type === "tv" && id && providerLower === "hdstream4u" && new RegExp(`^${String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-s\\d+e\\d+$`, "i").test(String(episodeId || ""));
    if ((!episodeId || syntheticTmdbEpisodeId) && type === "tv" && id && providerLower === "hdstream4u") {
      try {
        episodeId = await resolveHdstream4uTvEpisodeId(
          request,
          String(id || ""),
          String(type || "tv"),
          Number(request.query.season || 1),
          Number(request.query.episode || 1),
          await getDirectTmdbInfo(String(id), "tv")
        ) || episodeId;
      } catch {
      }
    }
    const directHdstreamTvAttempt = providerLower === "hdstream4u" && type === "tv" && /^https?:\/\//i.test(String(episodeId || ""));
    if (directHdstreamTvAttempt) {
      try {
        const delegated = await request.server.inject({
          method: "GET",
          url: `/movies/hdstream4u/watch?episodeId=${encodeURIComponent(episodeId)}`
        });
        if (delegated.statusCode < 400) {
          const payload = safeJsonParse(delegated.body || "{}");
          if (payload?.sources?.length)
            return reply.status(200).send(payload);
        }
      } catch {
      }
    }
    let discoveredMovieOrTvInfo = null;
    if ((type === "movie" || type === "tv") && (!providerLower || providerLower === "hdstream4u") && !directHdstreamTvAttempt && id) {
      try {
        const discoveryTmdb = new import_extensions.META.TMDB(
          import_main.tmdbApi,
          void 0
        );
        let mediaInfo = await getDirectTmdbInfo(id, type);
        if (!mediaInfo) {
          try {
            mediaInfo = await discoveryTmdb.fetchMediaInfo(id, type);
          } catch {
            mediaInfo = null;
          }
        }
        discoveredMovieOrTvInfo = mediaInfo;
        if (!mediaInfo || !mediaInfo.title || mediaInfo.title === "Unknown") {
          const rescued = await getDirectTmdbInfo(id, type);
          if (rescued)
            mediaInfo = { ...mediaInfo || {}, ...rescued };
        }
        const titleCandidates = getTitleCandidatesFromMedia(mediaInfo);
        if (titleCandidates.length) {
          try {
            const hdstreamEpisodeId = type === "tv" ? episodeId : episodeId || await resolveHdstream4uEpisodeId(request, mediaInfo);
            if (hdstreamEpisodeId) {
              const delegated = await request.server.inject({
                method: "GET",
                url: `/movies/hdstream4u/watch?episodeId=${encodeURIComponent(hdstreamEpisodeId)}${type === "movie" && id ? `&mediaId=${encodeURIComponent(String(id))}` : ""}`
              });
              if (delegated.statusCode < 400) {
                const payload = safeJsonParse(delegated.body || "{}");
                const sources = Array.isArray(payload?.sources) ? payload.sources : [];
                if (sources.length > 0) {
                  if (cacheKey && import_main.redis) {
                    import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(payload)).catch(() => {
                    });
                  }
                  return reply.status(200).send(payload);
                }
              }
            }
          } catch {
          }
        }
      } catch {
      }
    }
    let movieProvider = void 0;
    let tmdb = configureMeta(new import_extensions.META.TMDB(import_main.tmdbApi, movieProvider));
    if (typeof provider !== "undefined") {
      const selectedProvider = resolveMovieProvider(provider);
      if (selectedProvider) {
        movieProvider = selectedProvider;
        tmdb = configureMeta(new import_extensions.META.TMDB(import_main.tmdbApi, selectedProvider));
      } else {
        const possibleProvider = import_extensions.PROVIDERS_LIST.MOVIES.find(
          (p) => p.name.toLowerCase() === provider.toLocaleLowerCase()
        );
        movieProvider = possibleProvider || movieProvider;
        tmdb = configureMeta(new import_extensions.META.TMDB(import_main.tmdbApi, possibleProvider));
      }
    }
    let sourceId = "";
    let mediaId = "";
    try {
      if (type === "movie" && id) {
        sourceId = String(episodeId || "").trim();
        mediaId = id;
        if ((providerLower === "flixhq" || !providerLower) && sourceId) {
          const lowerSourceId = sourceId.toLowerCase();
          const foreignProviderUrl = /^https?:\/\//i.test(sourceId);
          const foreignProviderHint = lowerSourceId.includes("animesalt") || lowerSourceId.includes("hianime");
          if (foreignProviderUrl || foreignProviderHint) {
            sourceId = "";
          }
        }
        if (!sourceId && providerLower === "flixhq") {
          try {
            const flixInfo = await buildFlixhqTmdbInfo(request, id, type);
            const infoEpisodeId = String(flixInfo?.episodeId || "").trim();
            const providerSourceId = String(flixInfo?.providerSourceId || "").trim();
            sourceId = infoEpisodeId || providerSourceId || sourceId;
          } catch {
          }
        }
        sourceId = sourceId || id.replace(/^movie\//, "");
      } else {
        sourceId = episodeId;
        mediaId = id;
      }
      if ((providerLower === "flixhq" || !providerLower) && sourceId) {
        try {
          const queryParts = [`episodeId=${encodeURIComponent(sourceId)}`];
          if (server)
            queryParts.push(`server=${encodeURIComponent(server)}`);
          if (server)
            queryParts.push("strictServer=true");
          if (directOnly)
            queryParts.push("directOnly=true");
          if (!directOnly)
            queryParts.push("allowEmbedFallback=true");
          const delegated = await request.server.inject({
            method: "GET",
            url: `/movies/flixhq/watch?${queryParts.join("&")}`
          });
          if (delegated.statusCode < 400) {
            const payload = safeJsonParse(delegated.body || "{}");
            const sources = Array.isArray(payload?.sources) ? payload.sources : [];
            if (!directOnly || sources.some(
              (src) => /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(src?.url || ""))
            )) {
              if (cacheKey && import_main.redis) {
                import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(payload)).catch(() => {
                });
              }
              return reply.status(200).send(payload);
            }
          }
        } catch {
        }
      }
      if (providerLower === "hdstream4u" && sourceId) {
        try {
          const delegated = await request.server.inject({
            method: "GET",
            url: `/movies/hdstream4u/watch?episodeId=${encodeURIComponent(sourceId)}${mediaId ? `&mediaId=${encodeURIComponent(mediaId)}` : ""}`
          });
          if (delegated.statusCode < 400) {
            const payload = safeJsonParse(delegated.body || "{}");
            const sources = Array.isArray(payload?.sources) ? payload.sources : [];
            if (sources.length > 0) {
              if (cacheKey && import_main.redis) {
                import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(payload)).catch(() => {
                });
              }
              return reply.status(200).send(payload);
            }
          }
        } catch {
        }
      }
      if (providerLower === "hdstream4u" && !sourceId) {
        throw new Error("HDStream4u: no episode ID found for requested TV episode");
      }
      const res = await (0, import_streamable.fetchWithServerFallback)(
        async (selectedServer) => await tmdb.fetchEpisodeSources(sourceId, mediaId, selectedServer),
        server,
        server ? [server] : [import_extensions.StreamingServers.VidCloud, import_extensions.StreamingServers.UpCloud],
        {
          attemptTimeoutMs: MOVIE_WATCH_ATTEMPT_TIMEOUT_MS,
          requireDirectPlayable: directOnly
        }
      );
      if (cacheKey && import_main.redis && res) {
        import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(res)).catch(() => {
        });
      }
      reply.status(200).send(res);
    } catch (err) {
      if ((type === "tv" || type === "movie") && sourceId && (!providerLower || providerLower === "flixhq")) {
        try {
          const queryParts = [`episodeId=${encodeURIComponent(sourceId)}`];
          if (server)
            queryParts.push(`server=${encodeURIComponent(server)}`);
          if (server)
            queryParts.push("strictServer=true");
          if (directOnly)
            queryParts.push("directOnly=true");
          if (!directOnly)
            queryParts.push("allowEmbedFallback=true");
          const delegated = await request.server.inject({
            method: "GET",
            url: `/movies/flixhq/watch?${queryParts.join("&")}`
          });
          if (delegated.statusCode < 400) {
            const payload = safeJsonParse(delegated.body || "{}");
            const sources = Array.isArray(payload?.sources) ? payload.sources : [];
            if (!directOnly || sources.some(
              (src) => /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(src?.url || ""))
            )) {
              if (cacheKey && import_main.redis) {
                import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(payload)).catch(() => {
                });
              }
              return reply.status(200).send(payload);
            }
          }
        } catch {
        }
      }
      if (type === "movie" && sourceId) {
        try {
          const fallback = await (0, import_movieServerFallback.getMovieEmbedFallbackSource)(
            movieProvider,
            sourceId,
            mediaId,
            server
          );
          if (fallback) {
            if (cacheKey && import_main.redis) {
              import_main.redis.setex(cacheKey, import_main.REDIS_TTL, JSON.stringify(fallback)).catch(() => {
              });
            }
            return reply.status(200).send(fallback);
          }
        } catch {
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tmdb.ts] watch failed: ${message}`);
      reply.status(404).send({ message, error: "Not Found or Extraction Failed" });
    }
  };
  fastify.get("/watch", watch);
  fastify.get("/watch/:episodeId", watch);
};
var tmdb_default = routes;
