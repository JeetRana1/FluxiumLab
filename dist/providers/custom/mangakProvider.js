"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mangakProvider_exports = {};
__export(mangakProvider_exports, {
  MangakProvider: () => MangakProvider
});
module.exports = __toCommonJS(mangakProvider_exports);
const API_BASE = "https://api.mangak.io";
const SITE_BASE = "https://mangak.io";
const headers = (referer = `${SITE_BASE}/search`) => ({
  Accept: "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  Referer: referer
});
const getJson = async (url, referer) => {
  const response = await fetch(url, { headers: headers(referer) });
  if (!response.ok)
    throw new Error(`Mangak request failed: ${response.status}`);
  return response.json();
};
class MangakProvider {
  static search(query, page = 1, limit = 20) {
    return getJson(`${API_BASE}/titles/search?page=${page}&limit=${limit}&q=${encodeURIComponent(query)}`);
  }
  static browse(options = {}) {
    const params = new URLSearchParams();
    params.set("page", String(options.page || 1));
    params.set("limit", String(options.limit || 20));
    if (options.sort)
      params.set("sort", options.sort);
    if (options.genres)
      params.set("genres", options.genres);
    return getJson(`${API_BASE}/titles/search?${params.toString()}`);
  }
  static genres(limit = 100) {
    return getJson(`${API_BASE}/genres?page=1&limit=${limit}`);
  }
  static async info(id) {
    const payload = await getJson(`${API_BASE}/titles/search?page=1&limit=20&q=${encodeURIComponent(id)}`);
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    return items.find((item) => String(item?.id) === id) || items[0] || null;
  }
  static async chapters(id) {
    const payload = await getJson(`${API_BASE}/titles/${encodeURIComponent(id)}/chapters`, `${SITE_BASE}/titles/${id}`);
    return Array.isArray(payload?.data?.chapters) ? payload.data.chapters : [];
  }
  static async chapterImages(slug, chapterSlug) {
    const page = await fetch(`${SITE_BASE}/${encodeURIComponent(slug)}`, { headers: headers() });
    if (!page.ok)
      throw new Error(`Mangak title page failed: ${page.status}`);
    const html = await page.text();
    const buildMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    const buildId = buildMatch ? JSON.parse(buildMatch[1])?.buildId : null;
    if (!buildId)
      throw new Error("Mangak build ID unavailable");
    const payload = await getJson(
      `${SITE_BASE}/_next/data/${encodeURIComponent(buildId)}/${encodeURIComponent(slug)}/${encodeURIComponent(chapterSlug)}.json?slug=${encodeURIComponent(slug)}&chapter-slug=${encodeURIComponent(chapterSlug)}`,
      `${SITE_BASE}/${slug}/${chapterSlug}`
    );
    return payload?.pageProps?.initialChapter || null;
  }
  static async chapter(mangaId, slug, number) {
    const chapters = await this.chapters(mangaId);
    const chapter = chapters.find((item) => Number(item?.number) === Number(number));
    if (!chapter)
      return null;
    const detail = await this.chapterImages(slug, chapter.slug);
    return detail ? { chapter, images: detail.images || [] } : null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MangakProvider
});
