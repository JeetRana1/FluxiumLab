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
var anikotoProvider_exports = {};
__export(anikotoProvider_exports, {
  fetchCurrentAniKotoSources: () => fetchCurrentAniKotoSources
});
module.exports = __toCommonJS(anikotoProvider_exports);
var cheerio = __toESM(require("cheerio"));
const BASE_URL = "https://anikoto.cz";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const pageHeaders = () => ({
  "User-Agent": USER_AGENT,
  Accept: "text/html, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: `${BASE_URL}/`
});
const ajaxHeaders = () => ({
  ...pageHeaders(),
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/javascript, */*; q=0.01"
});
const parseJson = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const absoluteUrl = (url) => url.startsWith("http") ? url : `https:${url}`;
const extractEmbedId = (html) => html.match(/id=["']megaplay-player["'][^>]*data-id=["'](\d+)["']/i)?.[1] || html.match(/data-id=["'](\d+)["']/i)?.[1] || html.match(/id=["'](\d+)["']/i)?.[1] || "";
const hasSources = (result) => Boolean(
  result?.sub?.sources?.some((source) => String(source?.url || "").trim()) || result?.dub?.sources?.some((source) => String(source?.url || "").trim())
);
const discoveryCache = /* @__PURE__ */ new Map();
const discoveryPending = /* @__PURE__ */ new Map();
const discoverEpisodes = async (slug) => {
  const pending = discoveryPending.get(slug);
  if (pending)
    return pending;
  const request = (async () => {
    const signal = AbortSignal.timeout(12e3);
    const watchResponse = await globalThis.fetch(`${BASE_URL}/watch/${encodeURIComponent(slug)}`, {
      headers: pageHeaders(),
      signal
    });
    if (!watchResponse.ok)
      return /* @__PURE__ */ new Map();
    const animeId = cheerio.load(await watchResponse.text())("#watch-main").attr("data-id") || "";
    if (!animeId)
      return /* @__PURE__ */ new Map();
    const response = await globalThis.fetch(`${BASE_URL}/ajax/episode/list/${encodeURIComponent(animeId)}`, {
      headers: ajaxHeaders(),
      signal
    });
    if (!response.ok)
      return /* @__PURE__ */ new Map();
    const json = await parseJson(response);
    const $ = cheerio.load(String(json?.result || json?.html || ""));
    const episodes = /* @__PURE__ */ new Map();
    $("a[data-num]").each((_, element) => {
      const row = $(element);
      const number = Number(row.attr("data-num"));
      const ids = row.attr("data-ids") || row.attr("data-id") || "";
      if (Number.isInteger(number) && number > 0 && ids && !episodes.has(number))
        episodes.set(number, ids);
    });
    if (episodes.size) {
      for (const [key, value] of discoveryCache)
        if (value.expires <= Date.now())
          discoveryCache.delete(key);
      if (discoveryCache.size >= 128)
        discoveryCache.delete(discoveryCache.keys().next().value);
      discoveryCache.set(slug, { expires: Date.now() + 30 * 60 * 1e3, episodes });
    }
    return episodes;
  })().finally(() => discoveryPending.delete(slug));
  discoveryPending.set(slug, request);
  return request;
};
const fetchCurrentAniKotoSources = async (episodeId, server) => {
  const match = episodeId.match(/^([a-z0-9][a-z0-9-]{0,199})\$episode\$([1-9]\d{0,5})$/i);
  if (!match)
    return null;
  const signal = AbortSignal.timeout(3e4);
  const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, signal });
  const slug = match[1];
  const episodeNumber = Number(match[2]);
  const cached = discoveryCache.get(slug);
  const episodeIds = (cached && cached.expires > Date.now() ? cached.episodes.get(episodeNumber) : "") || (await discoverEpisodes(slug)).get(episodeNumber);
  if (!episodeIds)
    return null;
  const serverResponse = await fetch(
    `${BASE_URL}/ajax/server/list?servers=${encodeURIComponent(episodeIds)}`,
    { headers: ajaxHeaders() }
  );
  const serverJson = await parseJson(serverResponse);
  const $servers = cheerio.load(String(serverJson?.result || serverJson?.html || ""));
  const groups = [];
  $servers("div.servers > div.type, div[data-type]").each((_, element) => {
    const group = $servers(element);
    const type = String(group.attr("data-type") || "").toLowerCase().includes("dub") ? "dub" : "sub";
    group.find("li[data-link-id]").each((__, item) => {
      const li = $servers(item);
      const linkId = li.attr("data-link-id") || "";
      if (linkId) {
        groups.push({
          type,
          linkId,
          name: li.text().trim(),
          svId: li.attr("data-sv-id") || ""
        });
      }
    });
  });
  if (!groups.length) {
    $servers("li[data-link-id]").each((_, item) => {
      const li = $servers(item);
      const linkId = li.attr("data-link-id") || "";
      if (linkId)
        groups.push({ type: "sub", linkId, name: li.text().trim(), svId: "" });
    });
  }
  const result = { headers: { Referer: BASE_URL } };
  let nextIndex = 0;
  const poolSize = Math.min(4, groups.length);
  const worker = async () => {
    for (; ; ) {
      const current = nextIndex++;
      if (current >= groups.length)
        return;
      const group = groups[current];
      if (server && !group.name.toLowerCase().includes(String(server).toLowerCase()))
        continue;
      try {
        const svQuery = group.svId ? `&sv=${encodeURIComponent(group.svId)}` : "";
        const linkResponse = await fetch(
          `${BASE_URL}/ajax/server?get=${encodeURIComponent(group.linkId)}${svQuery}`,
          { headers: ajaxHeaders() }
        );
        const linkJson = await parseJson(linkResponse);
        const embedUrl = absoluteUrl(String(linkJson?.result?.url || linkJson?.url || ""));
        if (!embedUrl || !/^https?:\/\//i.test(embedUrl))
          continue;
        const embedResponse = await fetch(embedUrl, {
          headers: { ...pageHeaders(), Referer: `${BASE_URL}/` }
        });
        if (!embedResponse.ok)
          continue;
        const embedId = extractEmbedId(await embedResponse.text());
        if (!embedId)
          continue;
        const embedLocation = new URL(embedUrl);
        const embedOrigin = embedLocation.origin;
        const mirror = (embedLocation.searchParams.get("s") || "").replace(/[^a-z0-9_-]/gi, "");
        const mirrorQuery = mirror ? `&s=${encodeURIComponent(mirror)}` : "";
        const sourceUrls = [
          `${embedOrigin}/stream/getSourcesNew?id=${encodeURIComponent(embedId)}&id=${encodeURIComponent(embedId)}`,
          `${embedOrigin}/stream/getSources?id=${encodeURIComponent(embedId)}`
        ];
        if (/megaplay\.buzz$/i.test(new URL(embedUrl).hostname)) {
          sourceUrls.push(
            `https://vidwish.live/stream/getSourcesNew?id=${encodeURIComponent(embedId)}&id=${encodeURIComponent(embedId)}`
          );
        }
        let sourceJson = null;
        for (const sourceUrl of sourceUrls) {
          const sourceOrigin = new URL(sourceUrl).origin;
          const sourceResponse = await fetch(sourceUrl + mirrorQuery, {
            headers: { ...ajaxHeaders(), Origin: sourceOrigin, Referer: embedUrl }
          });
          if (!sourceResponse.ok)
            continue;
          const candidate = await parseJson(sourceResponse);
          if (candidate?.sources?.file || candidate?.sources?.url || candidate?.source || candidate?.url) {
            sourceJson = candidate;
            break;
          }
        }
        const file = String(
          sourceJson?.sources?.file || sourceJson?.sources?.url || sourceJson?.source || sourceJson?.url || ""
        ).trim();
        if (!file)
          continue;
        const skips = {};
        for (const type of ["intro", "outro"]) {
          const segment = sourceJson?.[type] ?? linkJson?.result?.skip_data?.[type];
          const start = Array.isArray(segment) ? segment[0] : segment?.start;
          const end = Array.isArray(segment) ? segment[1] : segment?.end;
          if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
            skips[type] = { start, end };
          }
        }
        const payload = group.type === "dub" ? result.dub ||= { sources: [], subtitles: [] } : result.sub ||= { sources: [], subtitles: [] };
        if (!payload.sources.some((source) => source.url === file && JSON.stringify({ intro: source.intro, outro: source.outro }) === JSON.stringify(skips))) {
          payload.sources.push({
            ...skips,
            url: file,
            isM3U8: /\.m3u8(?:[?#]|$)/i.test(file),
            quality: "auto",
            server: group.name,
            headers: { Referer: embedUrl, "User-Agent": USER_AGENT },
            isDub: group.type === "dub"
          });
        }
        for (const track of Array.isArray(sourceJson?.tracks) ? sourceJson.tracks : []) {
          if (track?.file && track.kind !== "thumbnails" && !payload.subtitles.some((sub) => sub.url === track.file)) {
            payload.subtitles.push({ url: track.file, lang: track.label || "English" });
          }
        }
      } catch {
      }
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return hasSources(result) ? result : null;
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  fetchCurrentAniKotoSources
});
