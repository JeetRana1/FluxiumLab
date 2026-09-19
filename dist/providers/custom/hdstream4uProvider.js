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
var hdstream4uProvider_exports = {};
__export(hdstream4uProvider_exports, {
  HdStream4uProvider: () => HdStream4uProvider
});
module.exports = __toCommonJS(hdstream4uProvider_exports);
var cheerio = __toESM(require("cheerio"));
var import_axios = __toESM(require("axios"));
var import_vm = __toESM(require("vm"));
var import_browserRuntimeExtractor = require("../../utils/browserRuntimeExtractor");
const BASE_URL = "https://new6.hdhub4u.cl";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TMDB_KEY = String(process.env.TMDB_KEY || "").trim();
const STREAM_HOSTS = [
  "hubstream.art",
  "hubstream.pw",
  "hubstream.cc",
  "tpead.net",
  "watchhd.upns.live",
  "hdstream4u.com",
  "hdstream4u.in",
  "morencius.com",
  "hubcloud.foo",
  "hubcloud.boo",
  "hubcloud.ink",
  "hubdrive.space",
  "gadgetsweb.xyz",
  "gamerxyt.com",
  "callistanise.com"
];
const GATE_HOSTS = [
  ...STREAM_HOSTS,
  "hubdrive.fit",
  "hubdrive.art",
  "hubdrive.foo",
  "hubdrive.space",
  "hblinks.co",
  "tech.unblockedgames.world",
  "greenmountmotors.com",
  "greenmountmotors.co",
  "greenmountmotors.xyz",
  "gamerxyt.com"
];
const RAW_FILE_HOSTS = ["r2.dev", "googleusercontent.com", "acek-cdn.com", "mindbodywellness.space"];
const HDSTREAM_SPECIAL_BONUS_OVERRIDES = {
  "indias-got-latent-season-2-hindi-webrip-all-episodes": {
    token: "ucp5r8",
    label: "Netflix Special: Varun Dhawan",
    seasonName: "Netflix Special",
    category: "netflix-special"
  }
};
class SimpleCache {
  constructor() {
    this.map = /* @__PURE__ */ new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry)
      return null;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }
  set(key, value, ttlMs) {
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }
}
const cache = new SimpleCache();
const pending = /* @__PURE__ */ new Map();
const singleFlight = (key, load) => {
  const existing = pending.get(key);
  if (existing)
    return existing;
  const promise = Promise.resolve().then(load).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
};
const requestConfig = {
  timeout: 2e4,
  maxRedirects: 5,
  validateStatus: (status) => status >= 200 && status < 400,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  }
};
const cleanText = (value) => String(value || "").replace(/\s+/g, " ").replace(/\[[^\]]*]/g, "").trim();
const dedupe = (items, keyFn) => {
  const seen = /* @__PURE__ */ new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
};
const normalizeText = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
const hasStrictTitleMatch = (candidateTitle, queries) => {
  const candidate = normalizeText(candidateTitle);
  if (!candidate)
    return false;
  const candidateTokens = candidate.split(" ").filter(Boolean);
  const candidateCompact = candidate.replace(/\s+/g, "");
  for (const query of queries) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery)
      continue;
    const queryTokens = normalizedQuery.split(" ").filter(Boolean);
    const queryCompact = normalizedQuery.replace(/\s+/g, "");
    if (candidate === normalizedQuery || candidateCompact === queryCompact)
      return true;
    if (queryTokens.length === 1) {
      if (candidateTokens.includes(queryTokens[0]))
        return true;
      continue;
    }
    const joined = candidateTokens.join(" ");
    if (joined.includes(normalizedQuery))
      return true;
  }
  return false;
};
const parseMaybeJsonString = (value) => {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
};
const absoluteUrl = (url, base = BASE_URL) => {
  const raw = String(url || "").trim();
  if (!raw)
    return "";
  try {
    const parsed = new URL(raw, base);
    if (/^(?:new1\.hdhub4u\.af|new2\.hdhub4u\.cl|new5\.hdhub4u\.cl)$/i.test(parsed.hostname)) {
      parsed.protocol = "https:";
      parsed.hostname = new URL(BASE_URL).hostname;
    }
    return parsed.toString();
  } catch {
    return raw;
  }
};
const mediaIdFromUrl = (url) => {
  const absolute = absoluteUrl(url);
  try {
    const parsed = new URL(absolute);
    const baseHost = new URL(BASE_URL).hostname.toLowerCase();
    if (parsed.hostname.toLowerCase() !== baseHost)
      return absolute;
    return `${parsed.pathname.replace(/^\/+|\/+$/g, "")}${parsed.search || ""}`;
  } catch {
    return String(url || "").replace(/^\/+|\/+$/g, "");
  }
};
const mediaUrlFromId = (mediaId) => {
  const raw = String(mediaId || "").trim();
  if (/^https?:\/\//i.test(raw))
    return absoluteUrl(raw);
  return absoluteUrl(`/${raw.replace(/^\/+/, "")}`);
};
const fetchText = async (url, referer = BASE_URL, timeout = requestConfig.timeout) => {
  const response = await import_axios.default.get(url, {
    ...requestConfig,
    timeout,
    responseType: "text",
    headers: {
      ...requestConfig.headers || {},
      Referer: referer
    }
  });
  return String(response.data || "");
};
const PACKER_MARKER = "eval(function(p,a,c,k,e,d)";
const extractPackedScripts = (text) => {
  const scripts = [];
  let start = text.indexOf(PACKER_MARKER);
  while (start !== -1) {
    const bodyEnd = text.indexOf("}", start);
    if (bodyEnd === -1)
      break;
    const openParen = text.indexOf("(", bodyEnd);
    if (openParen === -1)
      break;
    let i = openParen + 1;
    let depth = 1;
    let inStr = false;
    let quote = "";
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === quote)
          inStr = false;
      } else {
        if (ch === "'" || ch === '"') {
          inStr = true;
          quote = ch;
        } else if (ch === "(")
          depth++;
        else if (ch === ")")
          depth--;
      }
      i++;
    }
    scripts.push(text.slice(start, i));
    start = text.indexOf(PACKER_MARKER, i);
  }
  return scripts;
};
const decodePackerViaVm = (script) => {
  const m = script.match(/function\(p,a,c,k,e,d\)\{(.*)\}\((.*)\)\)?;?$/s);
  if (!m)
    return null;
  const expression = `(function(p,a,c,k,e,d){
${m[1]}
})(${m[2]})`;
  try {
    const result = import_vm.default.runInNewContext(expression, {}, { timeout: 5e3 });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
};
const decodeEmbedLinks = (html) => {
  for (const script of extractPackedScripts(html)) {
    const decoded = decodePackerViaVm(script);
    if (!decoded || !decoded.includes("var links"))
      continue;
    const hls2 = (decoded.match(/["']hls2["']\s*:\s*["']([^"']+)["']/) || [])[1] || "";
    const hls3 = (decoded.match(/["']hls3["']\s*:\s*["']([^"']+)["']/) || [])[1] || "";
    const hls4 = (decoded.match(/["']hls4["']\s*:\s*["']([^"']+)["']/) || [])[1] || "";
    const subtitles = [];
    const trackRe = /\{([^{}]*?)\}/g;
    let tm;
    while ((tm = trackRe.exec(decoded)) !== null) {
      const block = tm[1];
      const fileM = block.match(/(?:["']?file["']?|["']url["'])\s*:\s*["']([^"']+\.(?:vtt|srt|ass))["']/i);
      const labelM = block.match(/label\s*:\s*["']([^"']+)["']/i);
      if (fileM && labelM && !/thumbnail|slides/i.test(fileM[1])) {
        subtitles.push({ url: fileM[1], label: labelM[1] });
      }
    }
    if (hls2 || hls3 || hls4)
      return { hls2, hls3, hls4, subtitles };
  }
  return null;
};
const isHubstreamSignedUrl = (url) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (/(?:^|\.)hubstream\.(?:art|pw|cc|ink|foo|boo)$/.test(host))
      return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && /^\/v4\//.test(parsed.pathname);
  } catch {
    return false;
  }
};
const hubstreamTokenIsExpired = (url, nowSec = Math.floor(Date.now() / 1e3)) => {
  if (!isHubstreamSignedUrl(url))
    return false;
  try {
    const parsed = new URL(url);
    for (const key of ["v", "kx", "e", "expires", "exp"]) {
      const value = Number(parsed.searchParams.get(key) || "");
      if (Number.isFinite(value) && value >= 15e8 && value <= 22e8) {
        if (value < nowSec - 120)
          return true;
      }
    }
  } catch {
  }
  return false;
};
const filterStaleHubstreamSources = (result) => {
  if (!result || !Array.isArray(result.sources) || !result.sources.length)
    return result;
  const fresh = result.sources.filter(
    (source) => !hubstreamTokenIsExpired(String(source?.url || ""))
  );
  if (fresh.length) {
    return { ...result, sources: fresh };
  }
  return result;
};
const verifySourcePlayable = async (url, referer, timeoutMs = 4e3) => {
  if (!url)
    return false;
  try {
    const response = await import_axios.default.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer
      }
    });
    const data = String(response.data || "");
    if (/\.m3u8(?:[?#]|$)/i.test(url)) {
      return data.trim().startsWith("#EXTM3U");
    }
    return data.length > 0;
  } catch {
    return false;
  }
};
const verifyHubstreamSourceState = async (url, timeoutMs = 4e3) => {
  if (!hubstreamTokenIsExpired(url) && (0, import_browserRuntimeExtractor.getCachedHlsManifest)(url)?.body.trim().startsWith("#EXTM3U")) {
    return "ok";
  }
  try {
    const response = await import_axios.default.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 500,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://hubstream.art/"
      }
    });
    if (response.status === 403 || response.status === 404)
      return "dead";
    if (response.status >= 400)
      return "unknown";
    const data = String(response.data || "").trim();
    if (/\.m3u8(?:[?#]|$)/i.test(url)) {
      if (data.startsWith("#EXTM3U"))
        return "ok";
      const tokens = data.split(/\s+/);
      const decoded = tokens.length >= 20 && tokens.every((token) => /^\d{1,3}$/.test(token)) ? tokens.map((token) => String.fromCharCode(Number(token))).join("") : data;
      return decoded.startsWith("#EXTM3U") ? "ok" : "dead";
    }
    return data.length > 0 ? "ok" : "dead";
  } catch (error) {
    const statusCode = Number(error?.response?.status || 0);
    if (statusCode === 403 || statusCode === 404)
      return "dead";
    return statusCode >= 400 ? "unknown" : "unknown";
  }
};
const verifyHubstreamSourcesLive = async (result) => {
  if (!result || !Array.isArray(result.sources) || !result.sources.length)
    return result;
  const hubIdx = [];
  result.sources.forEach((source, index) => {
    if (isHubstreamSignedUrl(String(source?.url || "")))
      hubIdx.push(index);
  });
  if (!hubIdx.length)
    return result;
  const states = await Promise.all(
    hubIdx.map(
      (index) => verifyHubstreamSourceState(String(result.sources[index]?.url || ""))
    )
  );
  const deadIdx = /* @__PURE__ */ new Map();
  hubIdx.forEach((index, i) => {
    if (states[i] === "dead")
      deadIdx.set(index, states[i]);
  });
  if (!deadIdx.size) {
    return { ...result, hubstreamProbed: true };
  }
  const alive = result.sources.filter((_s, i) => !deadIdx.has(i));
  return {
    ...result,
    sources: alive,
    hubstreamProbed: true,
    hubstreamAllDead: alive.length === 0
  };
};
const verifySourcePlayableState = async (url, referer, timeoutMs = 4e3) => {
  if (!url)
    return "dead";
  try {
    const response = await import_axios.default.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 500,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer
      }
    });
    if (response.status >= 400)
      return "dead";
    const data = String(response.data || "");
    if (/\.m3u8(?:[?#]|$)/i.test(url)) {
      return data.trim().startsWith("#EXTM3U") ? "ok" : "dead";
    }
    return data.length > 0 ? "ok" : "dead";
  } catch (error) {
    const statusCode = Number(error?.response?.status || 0);
    return statusCode >= 400 ? "dead" : "unknown";
  }
};
const extractYear = (title) => String(title || "").match(/\b(19|20)\d{2}\b/)?.[0];
const cleanDisplayTitle = (title) => String(title || "").replace(/^\s*[^ -]+\s*/g, "").replace(/^\s*[^ -]?\s*/g, "").replace(/\s*\|\s*Full Movie.*$/i, "").replace(/\s*\|\s*ALL Episodes.*$/i, "").replace(/\s+\d{3,4}p.*$/i, "").replace(/\s+4K.*$/i, "").replace(/\s+WEB-?DL.*$/i, "").replace(/\s+BluRay.*$/i, "").replace(/\s{2,}/g, " ").trim();
const extractSeasonNumber = (value) => {
  const match = String(value || "").match(/season[\s-]*(\d+)/i) || String(value || "").match(/(?:^|[^a-z])s(\d+)(?:[^a-z]|$)/i);
  const season = Number(match?.[1] || 0);
  return Number.isFinite(season) && season > 0 ? season : 1;
};
const isStreamHost = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return STREAM_HOSTS.some((streamHost) => host === streamHost || host.endsWith(`.${streamHost}`));
  } catch {
    return false;
  }
};
const isGateUrl = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return GATE_HOSTS.some((gateHost) => host === gateHost || host.endsWith(`.${gateHost}`));
  } catch {
    return false;
  }
};
const isRawVideoUrl = (url) => {
  const raw = String(url || "");
  if (/\.(m3u8|mp4|mkv)(?:[?#]|$)/i.test(raw))
    return true;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return RAW_FILE_HOSTS.some((rawHost) => host === rawHost || host.endsWith(`.${rawHost}`));
  } catch {
    return false;
  }
};
const safeOrigin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return void 0;
  }
};
const qualityFromUrl = (url) => {
  const quality = String(url || "").match(/(?:^|[^\d])([1-9]\d{2,3})p(?:[^\d]|$)/i)?.[1];
  if (quality)
    return `${quality}p`;
  if (/master\.m3u8/i.test(url))
    return "auto";
  if (/\.mkv(?:[?#]|$)/i.test(url))
    return "mkv";
  return /\.m3u8/i.test(url) ? "default" : "default";
};
const cleanQualityLabel = (label) => {
  const raw = cleanText(label);
  const quality = raw.match(/([1-9]\d{2,3})p/i)?.[1];
  if (quality)
    return `${quality}p`;
  if (/hindi/i.test(raw))
    return "Hindi";
  if (/english/i.test(raw))
    return "English";
  if (/auto|default|hls|m3u8/i.test(raw))
    return "default";
  return raw || "default";
};
const cleanTrackLabel = (label) => {
  const raw = cleanText(label).toLowerCase();
  if (/hin|hindi/.test(raw))
    return "Hindi";
  if (/eng|english/.test(raw))
    return "English";
  if (/tam|tamil/.test(raw))
    return "Tamil";
  if (/tel|telugu/.test(raw))
    return "Telugu";
  if (/mal|malayalam/.test(raw))
    return "Malayalam";
  if (/kan|kannada/.test(raw))
    return "Kannada";
  return cleanText(label) || "English";
};
const extractWatchLinks = ($, pageUrl, html = "") => {
  const links = [];
  const contentRoot = $(".entry-content, .post-content, article, main").first();
  const root = contentRoot.length ? contentRoot : $("body");
  root.find("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href") || "", pageUrl);
    const text = cleanText($(el).text()).toLowerCase();
    if (!href)
      return;
    if (isGateUrl(href) || /watch\s*online|download|480p|720p|1080p|2160p|player/i.test(text)) {
      links.push(href);
    }
  });
  for (const match of String(html || "").matchAll(/href=["']([^"']+)["']/gi)) {
    const href = absoluteUrl(String(match[1] || ""), pageUrl);
    if (!href)
      continue;
    if (isGateUrl(href) || isStreamHost(href))
      links.push(href);
  }
  return dedupe(links, (item) => item);
};
const extractEpisodes = ($, pageUrl) => {
  const links = extractWatchLinks($, pageUrl, $.html());
  const episodes = [];
  for (const href of links) {
    const label = cleanText($(`a[href="${href}"]`).first().text()) || href;
    if (!isGateUrl(href))
      continue;
    const episodeMatch = label.match(/(?:episode|ep)\s*(\d+)/i) || href.match(/(?:episode|ep)[-/]?(\d+)/i);
    if (!episodeMatch && !/episode|season|web[\s-]*series/i.test(label + href))
      continue;
    const number = Number(episodeMatch?.[1] || episodes.length + 1);
    episodes.push({
      id: mediaIdFromUrl(href),
      title: label || `Episode ${number}`,
      number,
      url: href
    });
  }
  return dedupe(episodes, (item) => item.id).sort((a, b) => a.number - b.number);
};
const extractEpisodeWatchEntries = (html) => {
  const entries = [];
  const sectionPattern = /EPiSODE\s*(\d+)[\s\S]*?(?=EPiSODE\s*\d+|<h2[^>]*>Download|<div class="wpra-reactions-wrap|$)/gi;
  for (const match of html.matchAll(sectionPattern)) {
    const episodeNo = Number(match[1] || 0);
    const block = String(match[0] || "");
    if (!Number.isFinite(episodeNo) || episodeNo <= 0)
      continue;
    const candidates = [...block.matchAll(/https:\/\/(?:hdstream4u(?:\.com|\.in)\/file\/[A-Za-z0-9_-]+|morencius\.com\/file\/[A-Za-z0-9_-]+|watchhd\.upns\.live\/#[A-Za-z0-9_-]+|hubstream\.art\/#[A-Za-z0-9_-]+|greenmountmotors\.com\/\?id=[^"'\s<>]+|callistanise\.com\/file\/[A-Za-z0-9_-]+|gadgetsweb\.xyz\/\?id=[^"'\s<>]+|hubcdn\.sbs\/file\/[A-Za-z0-9_-]+)/gi)].map((row) => String(row[0] || "").trim()).filter(Boolean);
    const preferred = candidates.find((url) => /(?:hdstream4u|morencius)\.com\/(?:file|embed)\//i.test(url)) || candidates.find((url) => /watchhd\.upns\.live\/#/i.test(url)) || candidates.find((url) => /hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(url)) || candidates.find((url) => /greenmountmotors\.com\/\?id=/i.test(url)) || candidates.find((url) => /gadgetsweb\.xyz\/\?id=/i.test(url)) || candidates[0];
    if (!preferred)
      continue;
    entries.push({
      number: episodeNo,
      url: preferred,
      title: `Episode ${episodeNo}`
    });
  }
  return dedupe(entries, (item) => `${item.number}:${item.url}`).sort((a, b) => a.number - b.number);
};
const extractBonusEpisodeWatchEntries = (html) => {
  const entries = [];
  const bonusBlocks = String(html || "").match(/BONUS\s*EP(?:ISODE)?S?[\s\S]*?(?=EPiSODE\s*\d+|BONUS\s*EP(?:ISODE)?S?|<h2[^>]*>Download|$)/gi) || [];
  for (const block of bonusBlocks) {
    const number = Number(block.match(/BONUS\s*EP(?:ISODE)?\s*(\d+)/i)?.[1] || 0);
    if (!Number.isFinite(number) || number <= 0)
      continue;
    const candidates = [...block.matchAll(/https:\/\/(?:hdstream4u(?:\.com|\.in)\/file\/[A-Za-z0-9_-]+|morencius\.com\/file\/[A-Za-z0-9_-]+|watchhd\.upns\.live\/[#A-Za-z0-9_-]+|hubstream\.[A-Za-z0-9.-]+\/[#A-Za-z0-9_-]+)/gi)].map((match) => String(match[0] || "").trim()).filter(Boolean);
    const url = candidates[0];
    if (!url)
      continue;
    entries.push({ number, url, title: `Bonus EP ${number}` });
  }
  return dedupe(entries, (item) => `${item.number}:${item.url}`).sort((a, b) => a.number - b.number);
};
const rot13 = (value) => String(value || "").replace(/[a-zA-Z]/g, (char) => {
  const code = char.charCodeAt(0) + 13;
  const limit = char <= "Z" ? 90 : 122;
  return String.fromCharCode(limit >= code ? code : code - 26);
});
const base64Decode = (value) => Buffer.from(String(value || ""), "base64").toString("utf8");
const extractEncodedGateUrl = (html, baseUrl) => {
  const token = html.match(/s\(['"]o['"]\s*,\s*['"]([^'"]+)['"]/i)?.[1];
  if (!token)
    return "";
  try {
    let payload = base64Decode(token);
    payload = base64Decode(payload);
    payload = rot13(payload);
    payload = base64Decode(payload);
    const parsed = JSON.parse(payload);
    const next = parsed?.o ? base64Decode(String(parsed.o)) : "";
    return next ? absoluteUrl(next, baseUrl) : "";
  } catch {
    return "";
  }
};
const extractCandidateUrls = (html, baseUrl) => {
  const urls = [];
  const $ = cheerio.load(html);
  $("a[href], iframe[src], source[src], video[src], button[data-href], button[onclick]").each((_, el) => {
    const raw = $(el).attr("href") || $(el).attr("src") || $(el).attr("data-href") || $(el).attr("onclick")?.match(/https?:\/\/[^'"\s)]+/i)?.[0] || "";
    const absolute = absoluteUrl(raw, baseUrl);
    if (absolute)
      urls.push(absolute);
  });
  const patterns = [
    /https?:\\?\/\\?\/[^"'\\\s<>]+/gi,
    /(?:file|sources?|hls|playlist|url|target|redirect)\s*[:=]\s*["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = parseMaybeJsonString(String(match[1] || match[0] || "").replace(/\\\//g, "/"));
      urls.push(absoluteUrl(raw, baseUrl));
    }
  }
  const decodedGate = extractEncodedGateUrl(html, baseUrl);
  if (decodedGate)
    urls.push(decodedGate);
  return dedupe(urls.filter((url) => /^https?:\/\//i.test(url)), (item) => item);
};
const extractScriptBodies = (html) => {
  const scripts = [];
  const $ = cheerio.load(html);
  $("script").each((_, el) => {
    const body = $(el).html();
    if (body)
      scripts.push(body);
  });
  scripts.push(html);
  return scripts;
};
const extractObjectString = (objectBody, key) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = objectBody.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*["']([^"']+)["']`, "i"));
  return match?.[1];
};
const extractSourceArrays = (script, playerUrl) => {
  const found = [];
  const arrayPatterns = [/sources\s*:\s*\[([\s\S]*?)]/gi, /"sources"\s*:\s*\[([\s\S]*?)]/gi, /source\s*:\s*\[([\s\S]*?)]/gi];
  for (const pattern of arrayPatterns) {
    for (const match of script.matchAll(pattern)) {
      const block = match[1] || "";
      for (const item of block.matchAll(/\{([\s\S]*?)}/g)) {
        const objectBody = item[1] || "";
        const file = extractObjectString(objectBody, "file") || extractObjectString(objectBody, "url") || extractObjectString(objectBody, "src");
        if (!file)
          continue;
        found.push({
          url: absoluteUrl(file.replace(/\\\//g, "/"), playerUrl),
          quality: extractObjectString(objectBody, "label") || extractObjectString(objectBody, "quality") || extractObjectString(objectBody, "type")
        });
      }
    }
  }
  return found;
};
const extractPlayerSetupFiles = (script, playerUrl) => {
  const found = [];
  const filePatterns = [
    /(?:window\.)?playerSetup\s*=\s*\{[\s\S]*?(?:file|url|src)\s*:\s*["']([^"']+)["'][\s\S]*?}/gi,
    /(?:file|url|src)\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)(?:\?[^"']*)?)["']/gi,
    /["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)(?:\?[^"']*)?)["']/gi
  ];
  for (const pattern of filePatterns) {
    for (const match of script.matchAll(pattern)) {
      found.push({ url: absoluteUrl(String(match[1] || "").replace(/\\\//g, "/"), playerUrl) });
    }
  }
  return found;
};
const extractHeaders = (html, playerUrl) => {
  const headers = {};
  const origin = html.match(/(?:origin|Origin)\s*[:=]\s*["']([^"']+)["']/)?.[1] || safeOrigin(playerUrl);
  const referer = html.match(/(?:referer|referrer|Referer)\s*[:=]\s*["']([^"']+)["']/)?.[1];
  if (origin)
    headers.Origin = origin;
  if (referer)
    headers.Referer = absoluteUrl(referer, playerUrl);
  return headers;
};
const extractSubtitles = (html, playerUrl) => {
  const subtitles = [];
  const add = (url, label = "English") => {
    const absolute = absoluteUrl(url.replace(/\\\//g, "/"), playerUrl);
    if (!/\.(vtt|srt)(?:[?#]|$)/i.test(absolute))
      return;
    subtitles.push({ url: absolute, lang: cleanTrackLabel(label) });
  };
  for (const match of html.matchAll(/tracks?\s*:\s*\[([\s\S]*?)]/gi)) {
    const block = match[1];
    for (const track of block.matchAll(/\{([\s\S]*?)}/g)) {
      const file = track[1].match(/file\s*:\s*["']([^"']+)["']/i)?.[1];
      const label = track[1].match(/(?:label|kind|srclang)\s*:\s*["']([^"']+)["']/i)?.[1];
      if (file)
        add(file, label || "English");
    }
  }
  for (const match of html.matchAll(/["']([^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi)) {
    add(match[1], "English");
  }
  return dedupe(subtitles, (item) => `${item.lang}:${item.url}`);
};
const normalizeDecodedSubtitlePayload = (payload, baseUrl) => {
  const subtitles = [];
  const add = (url, label) => {
    const absolute = absoluteUrl(String(url || ""), baseUrl);
    if (!/\.(vtt|srt)(?:[?#]|$)/i.test(absolute))
      return;
    subtitles.push({ url: absolute, lang: cleanTrackLabel(label || "English") });
  };
  const visit = (value, parentKey = "", depth = 0) => {
    if (!value || depth > 4)
      return;
    if (Array.isArray(value)) {
      for (const item of value)
        visit(item, parentKey, depth + 1);
      return;
    }
    if (typeof value === "string") {
      if (/subtitle|caption|track|cc/i.test(parentKey))
        add(value, parentKey);
      return;
    }
    if (typeof value !== "object")
      return;
    const direct = value.src || value.url || value.file || value.link;
    if (direct)
      add(direct, value.label || value.lang || value.language || value.title || value.name);
    for (const key of ["subtitle", "subtitles", "tracks", "captions", "caption", "cc"]) {
      visit(value[key], key, depth + 1);
    }
    if (/subtitle|caption|track|cc/i.test(parentKey)) {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string")
          add(child, key);
      }
    }
  };
  visit(payload);
  return dedupe(subtitles, (item) => `${item.lang}:${item.url}`);
};
const extractStreams = (html, playerUrl) => {
  const candidates = extractCandidateUrls(html, playerUrl);
  const streams = [];
  const addRawSource = (rawUrl, label, baseUrl = BASE_URL) => {
    const url = absoluteUrl(String(rawUrl || "").replace(/\\\//g, "/"), baseUrl);
    if (!isRawVideoUrl(url))
      return;
    streams.push({
      url,
      quality: cleanQualityLabel(label || qualityFromUrl(url)),
      isM3U8: /\.m3u8(?:[?#]|$)/i.test(url)
    });
  };
  for (const url of candidates)
    addRawSource(url, void 0, playerUrl);
  for (const script of extractScriptBodies(html)) {
    extractSourceArrays(script, playerUrl).forEach((source) => addRawSource(source.url, source.quality, playerUrl));
    extractPlayerSetupFiles(script, playerUrl).forEach((source) => addRawSource(source.url, void 0, playerUrl));
  }
  return dedupe(streams, (item) => item.url);
};
const extractTpeadGetVideoUrls = (html, pageUrl) => {
  const candidates = [
    ...String(html || "").matchAll(/(?:https?:)?\/\/tpead\.net\/get_video\?[^"'<>\s]+/gi),
    ...String(html || "").matchAll(/['"](\/tpead\.net\/get_video\?[^"'<>]+)['"]/gi),
    ...String(html || "").matchAll(/['"](\/\/tpead\.net\/get_video\?[^"'<>]+)['"]/gi)
  ].map((match) => String(match[1] || match[0] || "").trim()).filter(Boolean);
  return dedupe(
    candidates.map((candidate) => absoluteUrl(candidate, pageUrl)).filter(Boolean).map(
      (url) => /[?&]stream=1(?:&|$)/i.test(String(url || "")) ? String(url) : `${url}${String(url).includes("?") ? "&" : "?"}stream=1`
    ).reverse(),
    (url) => url
  );
};
const resolveTpeadPlayback = async (playerUrl, referer) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { sources: [], subtitles: [] };
  }
  let browser;
  try {
    browser = await (0, import_browserRuntimeExtractor.acquireSharedBrowser)();
    if (!browser)
      return { sources: [], subtitles: [] };
    const context = await browser.newContext({
      userAgent: USER_AGENT
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const type = route.request().resourceType?.() || "";
      const url = route.request().url() || "";
      if (["image", "font", "stylesheet"].includes(type) || url.includes("google-analytics") || url.includes("googletagmanager") || url.includes("doubleclick")) {
        route.abort().catch(() => {
        });
      } else {
        route.continue().catch(() => {
        });
      }
    });
    page.on("console", () => {
    });
    page.on("pageerror", () => {
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 2e4 }).catch(() => void 0);
    await page.waitForTimeout(2e3).catch(() => void 0);
    const hiddenLink = await page.evaluate(() => {
      const hiddenLinkEl = document.querySelector("#captchalink") || document.querySelector("#norobotlink") || document.querySelector("#ideoooolink");
      return String(hiddenLinkEl?.textContent || hiddenLinkEl?.innerHTML || "").trim();
    }).catch(() => "");
    await context.close().catch(() => void 0);
    let getVideoUrl = String(hiddenLink || "").trim();
    if (!getVideoUrl)
      return { sources: [], subtitles: [] };
    if (getVideoUrl.startsWith("//"))
      getVideoUrl = `https:${getVideoUrl}`;
    else if (getVideoUrl.startsWith("/"))
      getVideoUrl = absoluteUrl(getVideoUrl, playerUrl);
    if (!/[?&]stream=1(?:&|$)/i.test(getVideoUrl)) {
      getVideoUrl += `${getVideoUrl.includes("?") ? "&" : "?"}stream=1`;
    }
    const response = await import_axios.default.get(getVideoUrl, {
      ...requestConfig,
      responseType: "stream",
      maxRedirects: 5,
      headers: {
        ...requestConfig.headers || {},
        Referer: playerUrl,
        Range: "bytes=0-1"
      }
    });
    const finalUrl = String(
      response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || getVideoUrl
    ).trim();
    try {
      response.data?.destroy?.();
    } catch {
    }
    if (!isRawVideoUrl(finalUrl))
      return { sources: [], subtitles: [] };
    return {
      sources: [
        {
          url: finalUrl,
          quality: cleanQualityLabel(qualityFromUrl(finalUrl)),
          isM3U8: /\.m3u8(?:[?#]|$)/i.test(finalUrl)
        }
      ],
      subtitles: []
    };
  } catch {
    return { sources: [], subtitles: [] };
  } finally {
    (0, import_browserRuntimeExtractor.releaseSharedBrowser)();
  }
};
const resolveToPlayer = async (startUrl, referer) => {
  let currentUrl = startUrl;
  let currentReferer = referer;
  for (let i = 0; i < 6; i++) {
    if (isRawVideoUrl(currentUrl)) {
      return { playerUrl: currentUrl, referer: currentReferer, origin: safeOrigin(currentReferer) };
    }
    if (/\/v\/[^/?#]+/i.test(currentUrl) && /hubstream|watchhd/i.test(currentUrl)) {
      return { playerUrl: currentUrl, referer: currentReferer, origin: safeOrigin(currentReferer) };
    }
    const html = await fetchText(currentUrl, currentReferer);
    const candidates = extractCandidateUrls(html, currentUrl);
    const player = candidates.find((url) => isRawVideoUrl(url)) || candidates.find((url) => /(?:hubstream|watchhd)\.[^/]+\/(?:v\/|#)/i.test(url)) || candidates.find((url) => /(?:hdstream4u|morencius)\.[^/]+\/(?:file|embed)\//i.test(url)) || candidates.find((url) => isGateUrl(url)) || candidates.find((url) => isStreamHost(url));
    if (!player || player === currentUrl) {
      return { playerUrl: currentUrl, referer: currentReferer, origin: safeOrigin(currentReferer), html };
    }
    currentReferer = currentUrl;
    currentUrl = player;
  }
  return { playerUrl: currentUrl, referer: currentReferer, origin: safeOrigin(currentReferer) };
};
const resolveGateWithPlaywright = async (startUrl, referer, timeoutMs = 15e3) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {};
  }
  const discovered = /* @__PURE__ */ new Set();
  let browser;
  try {
    browser = await (0, import_browserRuntimeExtractor.acquireSharedBrowser)();
    if (!browser)
      return {};
    const context = await browser.newContext({
      extraHTTPHeaders: referer ? { Referer: referer } : void 0,
      userAgent: USER_AGENT
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const type = route.request().resourceType?.() || "";
      const url = route.request().url() || "";
      if (["image", "font", "stylesheet"].includes(type) || url.includes("google-analytics") || url.includes("googletagmanager") || url.includes("doubleclick")) {
        route.abort().catch(() => {
        });
      } else {
        route.continue().catch(() => {
        });
      }
    });
    page.on("console", () => {
    });
    page.on("pageerror", () => {
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4] });
    });
    const remember = (value) => {
      const url = absoluteUrl(String(value || "").trim(), page.url() || startUrl);
      if (!/^https?:\/\//i.test(url))
        return;
      if (isRawVideoUrl(url) || isStreamHost(url) || isGateUrl(url) || /\/(?:file|embed|v)\//i.test(url)) {
        discovered.add(url);
      }
    };
    const attachListeners = (targetPage) => {
      targetPage.on("request", (request) => remember(request.url()));
      targetPage.on("response", async (response) => {
        remember(response.url());
        try {
          const contentType = String(response.headers()?.["content-type"] || "").toLowerCase();
          if (contentType.includes("html") || contentType.includes("javascript") || contentType.includes("json")) {
            const body = await response.text();
            extractCandidateUrls(String(body || ""), response.url()).forEach((url) => remember(url));
          }
        } catch {
        }
      });
    };
    attachListeners(page);
    context.on("page", (popup) => {
      remember(popup.url());
      attachListeners(popup);
    });
    await page.goto(startUrl, { waitUntil: "commit", timeout: 8e3 }).catch(() => void 0);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await page.evaluate(() => {
        const clickables = Array.from(document.querySelectorAll('button, a, div, [role="button"], input[type="button"], input[type="submit"], #player-button, #downloadButton'));
        const wanted = [/continue/i, /get\s*links?/i, /watch\s*online/i, /click\s*to\s*continue/i, /proceed/i, /unlock/i, /^ready$/i, /get\s*video/i, /start from beginning/i];
        for (const el of clickables) {
          const text = String(el.innerText || el.textContent || el.getAttribute("value") || "").trim();
          if (!text)
            continue;
          if (!wanted.some((pattern) => pattern.test(text)))
            continue;
          try {
            el.scrollIntoView({ block: "center", inline: "center" });
            el.click();
          } catch {
          }
        }
      }).catch(() => void 0);
      const domUrls = await page.evaluate(() => {
        const urls = /* @__PURE__ */ new Set();
        const elements = Array.from(document.querySelectorAll("[href], [src], [data-href], [onclick], #player-button, #downloadButton"));
        for (const el of elements) {
          const href = el.getAttribute("href") || el.getAttribute("src") || el.getAttribute("data-href") || "";
          if (href)
            urls.add(href);
          const onclick = el.getAttribute("onclick") || "";
          const match = onclick.match(/https?:\/\/[^'"\s)]+/i);
          if (match?.[0])
            urls.add(match[0]);
        }
        return [...urls];
      }).catch(() => []);
      domUrls.forEach((url) => remember(url));
      remember(page.url());
      if ([...discovered].some((url) => isRawVideoUrl(url))) {
        break;
      }
      await page.waitForTimeout(350).catch(() => void 0);
    }
    const sources = [...discovered].filter((url) => isRawVideoUrl(url)).map((url) => ({
      url,
      quality: cleanQualityLabel(qualityFromUrl(url)),
      isM3U8: /\.m3u8(?:[?#]|$)/i.test(url)
    }));
    if (sources.length) {
      await context.close().catch(() => void 0);
      return { sources };
    }
    const playerUrl = [...discovered].find((url) => /(?:watchhd|hubstream)\.[^/]+\/(?:v\/|#)/i.test(url)) || [...discovered].find((url) => /tpead\.net\/(?:v|e)\//i.test(url)) || [...discovered].find((url) => /hdstream4u\.[^/]+\/(?:file|embed)\//i.test(url)) || [...discovered].find((url) => isStreamHost(url));
    await context.close().catch(() => void 0);
    return playerUrl ? { playerUrl } : {};
  } catch {
    return {};
  } finally {
    (0, import_browserRuntimeExtractor.releaseSharedBrowser)();
  }
};
const extractWatchhdSourcesWithPlaywright = async (startUrl, referer) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { sources: [], subtitles: [] };
  }
  let browser;
  try {
    browser = await (0, import_browserRuntimeExtractor.acquireSharedBrowser)();
    if (!browser)
      return { sources: [], subtitles: [] };
    const context = await browser.newContext({
      extraHTTPHeaders: referer ? { Referer: referer } : void 0,
      userAgent: USER_AGENT
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const type = route.request().resourceType?.() || "";
      const url = route.request().url() || "";
      if (["image", "font", "stylesheet"].includes(type) || url.includes("google-analytics") || url.includes("googletagmanager") || url.includes("doubleclick")) {
        route.abort().catch(() => {
        });
      } else {
        route.continue().catch(() => {
        });
      }
    });
    page.on("console", () => {
    });
    page.on("pageerror", () => {
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4] });
      const OriginalTextDecoder = window.TextDecoder;
      const originalDecode = OriginalTextDecoder.prototype.decode;
      OriginalTextDecoder.prototype.decode = function(...args) {
        const out = originalDecode.apply(this, args);
        try {
          if (typeof out === "string" && (out.trim().startsWith("{") || out.includes('"source"') || out.includes("m3u8"))) {
            window.__watchhdDecodedPayloads = window.__watchhdDecodedPayloads || [];
            window.__watchhdDecodedPayloads.push(out);
          }
        } catch {
        }
        return out;
      };
    });
    await page.goto(startUrl, { waitUntil: "commit", timeout: 8e3 }).catch(() => void 0);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const clickables = Array.from(document.querySelectorAll('button, a, div, [role="button"], #player-button, #downloadButton, .jw-icon-playback, .jw-display-icon-container, video'));
        for (const el of clickables) {
          try {
            el.click();
          } catch {
          }
        }
        const video = document.querySelector("video");
        if (video) {
          video.muted = true;
          video.play().catch(() => void 0);
        }
      }).catch(() => void 0);
      await page.waitForTimeout(350).catch(() => void 0);
    }
    const decodedPayloads = await page.evaluate(() => window.__watchhdDecodedPayloads || []).catch(() => []);
    await context.close().catch(() => void 0);
    const payload = [...decodedPayloads].reverse().map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }).find(Boolean);
    if (!payload)
      return { sources: [], subtitles: [] };
    const sources = [payload.cf, payload.hlsVideoTiktok, payload.google, payload.source].filter((value) => typeof value === "string" && value.trim()).map((value) => ({
      url: absoluteUrl(value, startUrl),
      quality: cleanQualityLabel(qualityFromUrl(value)),
      isM3U8: /\.m3u8(?:[?#]|$)/i.test(value)
    })).filter((source) => isRawVideoUrl(source.url));
    const subtitles = normalizeDecodedSubtitlePayload(payload, startUrl);
    return { sources: dedupe(sources, (item) => item.url), subtitles: dedupe(subtitles, (item) => `${item.lang}:${item.url}`) };
  } catch {
    return { sources: [], subtitles: [] };
  } finally {
    (0, import_browserRuntimeExtractor.releaseSharedBrowser)();
  }
};
const fetchTmdbMetadata = (id, mediaType) => {
  const key = `hdstream4u:tmdb:${mediaType}:${id}`;
  return singleFlight(key, async () => {
    const cached = cache.get(key);
    if (cached)
      return cached;
    const response = await import_axios.default.get(`https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${TMDB_KEY}`, {
      timeout: 15e3,
      headers: { "User-Agent": USER_AGENT }
    });
    if (response.data?.id)
      cache.set(key, response.data, 10 * 60 * 1e3);
    return response.data || {};
  });
};
const resolveTmdbNumericIdToPage = async (id, type = "movie") => {
  if (!/^\d+$/.test(String(id || "")) || !TMDB_KEY)
    return "";
  const mediaTypes = Array.from(/* @__PURE__ */ new Set([type === "tv" ? "tv" : "movie", type === "tv" ? "movie" : "tv"]));
  for (const mediaType of mediaTypes) {
    try {
      const payload = await fetchTmdbMetadata(id, mediaType);
      const titleCandidates = [payload?.title, payload?.name, payload?.original_title, payload?.original_name].filter((value, index, arr) => typeof value === "string" && value.trim() && arr.indexOf(value) === index).map((value) => String(value).trim());
      if (!titleCandidates.length)
        continue;
      const year = Number(String(payload?.release_date || payload?.first_air_date || "").slice(0, 4));
      const searchResults = await HdStream4uProvider.search(titleCandidates[0], 1);
      const results = Array.isArray(searchResults?.results) ? searchResults.results : [];
      const best = results.map((item) => {
        const tvLike = /season|episode|series|web[\s-]*series/i.test(`${item?.title || ""} ${item?.url || ""}`);
        const typeBonus = mediaType === "tv" ? tvLike ? 80 : -40 : tvLike ? -60 : 40;
        const yearBonus = year && new RegExp(`(^|[^d])${year}([^d]|$)`, "i").test(String(item?.title || "")) ? 120 : 0;
        return {
          item,
          score: titleMatchScore(String(item?.title || ""), titleCandidates) + typeBonus + yearBonus,
          strict: hasStrictTitleMatch(String(item?.title || ""), titleCandidates)
        };
      }).filter((entry) => entry.score >= 700 && entry.strict).sort(
        (a, b) => b.score - a.score
      )[0]?.item;
      if (best?.id)
        return String(best.id);
    } catch {
    }
  }
  return "";
};
const fetchTmdbBasicInfo = async (id, type = "movie") => {
  if (!/^\d+$/.test(String(id || "")) || !TMDB_KEY)
    return null;
  const mediaTypes = Array.from(/* @__PURE__ */ new Set([type === "tv" ? "tv" : "movie", type === "tv" ? "movie" : "tv"]));
  for (const mediaType of mediaTypes) {
    try {
      const payload = await fetchTmdbMetadata(id, mediaType);
      if (payload?.id)
        return { ...payload, media_type: mediaType };
    } catch {
    }
  }
  return null;
};
class HdStream4uProvider {
  static async search(query, page = 1) {
    return singleFlight(JSON.stringify(["search", query, page]), () => this.searchUnshared(query, page));
  }
  static async searchUnshared(query, page) {
    if (!query)
      return { error: "Query is required" };
    const cacheKey = `hdstream4u:search:${query}:${page}`;
    const cached = cache.get(cacheKey);
    if (cached)
      return cached;
    try {
      const apiUrl = new URL("https://search.pingora.fyi/collections/post/documents/search");
      apiUrl.searchParams.set("q", query);
      apiUrl.searchParams.set("query_by", "post_title,category,stars,director,imdb_id");
      apiUrl.searchParams.set("query_by_weights", "4,2,2,2,4");
      apiUrl.searchParams.set("sort_by", "sort_by_date:desc");
      apiUrl.searchParams.set("limit", "15");
      apiUrl.searchParams.set("highlight_fields", "none");
      apiUrl.searchParams.set("use_cache", "true");
      apiUrl.searchParams.set("page", String(page));
      apiUrl.searchParams.set("analytics_tag", (/* @__PURE__ */ new Date()).toISOString().slice(0, 10));
      const response = await import_axios.default.get(apiUrl.toString(), {
        ...requestConfig,
        timeout: 8e3,
        responseType: "json",
        headers: {
          ...requestConfig.headers || {},
          Accept: "application/json, text/plain, */*",
          Origin: BASE_URL,
          Referer: `${BASE_URL}/?s=${encodeURIComponent(query)}`
        }
      });
      const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
      const pingoraResults = hits.map((hit) => hit?.document || {}).map((doc) => {
        const permalink = String(doc.permalink || doc.url || "").trim();
        const title = cleanText(String(doc.post_title || doc.title || ""));
        if (!permalink || !title)
          return null;
        return {
          id: mediaIdFromUrl(permalink),
          title,
          url: absoluteUrl(permalink),
          image: absoluteUrl(String(doc.post_thumbnail || doc.image || ""), permalink),
          type: /(?:season|episode|series|web[\s-]*series)/i.test(title) ? "tv" : "movie"
        };
      }).filter(Boolean);
      const found = Number(response.data?.found || pingoraResults.length);
      if (pingoraResults.length > 0) {
        const payload2 = {
          currentPage: page,
          hasNextPage: page * 15 < found,
          results: dedupe(pingoraResults, (item) => String(item.id || item.url || ""))
        };
        cache.set(cacheKey, payload2, 10 * 60 * 1e3);
        return payload2;
      }
    } catch {
    }
    let domResults = [];
    let hasNextPage = false;
    try {
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
      const html = await fetchText(searchUrl, BASE_URL, 5e3);
      const $ = cheerio.load(html);
      const results = [];
      $("article, .post, .latestPost, .gridlove-post, .entry, .blog-entry, li.thumb").each((_, el) => {
        const anchor = $(el).find('h2 a, h3 a, .entry-title a, a[rel="bookmark"], figure a, a').first();
        const href = anchor.attr("href") || "";
        const title = cleanText(anchor.text() || $(el).find("h2, h3, .entry-title, img").first().attr("alt") || $(el).find("h2, h3, .entry-title").first().text());
        if (!href || !title)
          return;
        const image = $(el).find("img").first().attr("data-src") || $(el).find("img").first().attr("data-lazy-src") || $(el).find("img").first().attr("src") || "";
        results.push({
          id: mediaIdFromUrl(href),
          title,
          url: absoluteUrl(href),
          image: absoluteUrl(image, href),
          type: /(?:season|episode|series|web[\s-]*series)/i.test(title) ? "tv" : "movie"
        });
      });
      domResults = dedupe(results, (item) => String(item.id || item.url || ""));
      hasNextPage = $('a.next, .pagination .next, a[rel="next"]').length > 0;
    } catch {
    }
    const payload = {
      currentPage: page,
      hasNextPage,
      results: domResults
    };
    cache.set(cacheKey, payload, 10 * 60 * 1e3);
    return payload;
  }
  static async fetchMediaInfo(id, type = "movie") {
    return singleFlight(JSON.stringify(["info", id, type]), () => this.fetchMediaInfoUnshared(id, type));
  }
  static async fetchMediaInfoUnshared(id, type) {
    if (!id)
      return { error: "id is required" };
    try {
      const originalId = String(id || "").trim();
      const tmdbInfoPromise = /^\d+$/.test(originalId) ? fetchTmdbBasicInfo(originalId, type) : Promise.resolve(null);
      let mediaId = originalId;
      const tmdbInfo = await tmdbInfoPromise;
      if (/^\d+$/.test(mediaId)) {
        mediaId = await resolveTmdbNumericIdToPage(mediaId, type) || mediaId;
        if (/^\d+$/.test(mediaId)) {
          const title2 = String(tmdbInfo?.title || tmdbInfo?.name || "").trim();
          if (title2) {
            const searchResults = await HdStream4uProvider.search(title2, 1);
            const match = (searchResults?.results || []).filter((item) => item?.id && hasStrictTitleMatch(String(item.title || ""), [title2])).sort((a, b) => titleMatchScore(String(b.title || ""), [title2]) - titleMatchScore(String(a.title || ""), [title2]))[0];
            if (match?.id)
              mediaId = String(match.id);
          }
        }
      }
      const cacheKey = `hdstream4u:info:${type}:${mediaId}`;
      const cached = cache.get(cacheKey);
      if (cached)
        return cached;
      const pageUrl = mediaUrlFromId(mediaId);
      const html = await fetchText(pageUrl);
      const $ = cheerio.load(html);
      const rawTitle = cleanText(
        $("h1.entry-title, h1.post-title, .entry-title, h1").first().text() || $('meta[property="og:title"]').attr("content") || mediaId
      ) || "Unknown";
      const title = cleanDisplayTitle(String(tmdbInfo?.title || tmdbInfo?.name || rawTitle || "Unknown"));
      const image = absoluteUrl(
        $('meta[property="og:image"]').attr("content") || $(".entry-content img, article img").first().attr("src") || "",
        pageUrl
      );
      const description = cleanText(
        String(tmdbInfo?.overview || "") || $('meta[property="og:description"]').attr("content") || $(".entry-content p, .post-content p, article p").first().text()
      );
      const episodeWatchEntries = extractEpisodeWatchEntries(html);
      const bonusLinkEntries = $("a").toArray().flatMap((anchor) => {
        const label = cleanText($(anchor).text());
        const href = absoluteUrl(String($(anchor).attr("href") || ""), pageUrl);
        const number = Number(label.match(/BONUS\s*EP(?:ISODE)?\s*(\d+)/i)?.[1] || 0);
        if (!number || !href || !isGateUrl(href) || !/bonus\s*ep|ep\s*\d+.*bonus/i.test(label))
          return [];
        return [{ number, url: href, title: `Bonus EP ${number}` }];
      });
      const bonusEpisodeWatchEntries = dedupe(
        [...extractBonusEpisodeWatchEntries(html), ...bonusLinkEntries],
        (item) => `${item.number}:${item.url}`
      );
      const episodes = episodeWatchEntries.length ? episodeWatchEntries.map((entry) => ({
        id: mediaIdFromUrl(entry.url),
        title: entry.title,
        number: entry.number,
        url: entry.url,
        isBonus: false
      })) : extractEpisodes($, pageUrl).map((episode) => ({ ...episode, isBonus: false }));
      const bonusEpisodes = bonusEpisodeWatchEntries.map((entry) => ({
        id: mediaIdFromUrl(entry.url),
        title: entry.title,
        number: entry.number,
        url: entry.url,
        isBonus: true
      }));
      const specialOverride = HDSTREAM_SPECIAL_BONUS_OVERRIDES[mediaIdFromUrl(pageUrl)];
      if (specialOverride) {
        const tokenIndex = episodes.findIndex((episode) => {
          const tokenCheck = `${episode?.id || ""} ${episode?.url || ""}`;
          return tokenCheck.includes(specialOverride.token);
        });
        if (tokenIndex >= 0) {
          const [specialEpisode] = episodes.splice(tokenIndex, 1);
          if (specialEpisode) {
            bonusEpisodes.push({
              id: specialEpisode.id,
              title: specialOverride.label,
              number: specialEpisode.number,
              url: specialEpisode.url,
              isBonus: true,
              seasonNameOverride: specialOverride.seasonName,
              categoryOverride: specialOverride.category
            });
          }
        }
      }
      const watchLinks = extractWatchLinks($, pageUrl, html);
      const servers = watchLinks.map((href) => ({
        name: /hubstream|watchhd|hdstream4u\.com\/file|morencius\.com\/file/i.test(href) ? "Watch Online" : "HDHub4u",
        url: href,
        fileCode: href.split("/").pop() || ""
      }));
      const numberedEpisodeIds = new Set(
        episodes.map((episode) => String(episode?.id || "").trim().toLowerCase()).filter(Boolean)
      );
      const uniqueBonusEpisodes = bonusEpisodes.filter(
        (episode) => !numberedEpisodeIds.has(String(episode?.id || "").trim().toLowerCase())
      );
      if (episodes.some((e) => /hubstream\.art\/#[A-Za-z0-9_-]+$/.test(e.url) || /morencius\.com\/file\/[A-Za-z0-9_-]+$/.test(e.url))) {
        const betterFromPage = [];
        if (betterFromPage.length) {
          let hdIdx = 0;
          for (const ep of episodes) {
            if ((/hubstream\.art\/#[A-Za-z0-9_-]+$/.test(ep.url) || /morencius\.com\/file\/[A-Za-z0-9_-]+$/.test(ep.url)) && betterFromPage[hdIdx]) {
              ep.url = betterFromPage[hdIdx];
              ep.id = mediaIdFromUrl(ep.url);
              hdIdx++;
            }
          }
        }
      }
      const result = {
        id: mediaIdFromUrl(pageUrl),
        title,
        url: pageUrl,
        image,
        description,
        type: String(tmdbInfo?.media_type || "").toLowerCase() === "tv" || /season|episodes?|series|web[\s-]*series/i.test(rawTitle) || episodes.length > 1 ? "tv" : "movie",
        releaseDate: String(tmdbInfo?.release_date || tmdbInfo?.first_air_date || extractYear(rawTitle) || ""),
        servers,
        episodes: episodes.length || uniqueBonusEpisodes.length ? [...episodes, ...uniqueBonusEpisodes].map((episode) => ({
          episodeId: episode.id,
          title: episode.title,
          episodeNumber: episode.number,
          seasonNumber: episode.isBonus ? 0 : extractSeasonNumber(rawTitle || pageUrl),
          bonusSeasonNumber: episode.isBonus ? extractSeasonNumber(rawTitle || pageUrl) : void 0,
          seasonName: episode.isBonus ? episode.seasonNameOverride || "Bonus" : `Season ${extractSeasonNumber(rawTitle || pageUrl)}`,
          category: episode.isBonus ? episode.categoryOverride || "bonus" : "season",
          url: episode.url
        })) : [
          {
            episodeId: mediaIdFromUrl(watchLinks[0] || pageUrl),
            title: title || "Movie",
            episodeNumber: 1,
            seasonNumber: 0,
            url: watchLinks[0] || pageUrl
          }
        ],
        tmdbId: originalId,
        sourceTitle: rawTitle
      };
      cache.set(cacheKey, result, 10 * 60 * 1e3);
      return result;
    } catch (error) {
      return { error: error.message };
    }
  }
  static async extractHdstream4uFileWithManifestPrefetch(startUrl, server) {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      return null;
    }
    let browser;
    try {
      browser = await (0, import_browserRuntimeExtractor.acquireSharedBrowser)();
      if (!browser)
        return null;
      const context = await browser.newContext({
        extraHTTPHeaders: { Referer: BASE_URL },
        userAgent: USER_AGENT
      });
      const page = await context.newPage();
      await page.route("**/*", (route) => {
        const type = route.request().resourceType?.() || "";
        const url = route.request().url() || "";
        if (["image", "font", "stylesheet"].includes(type) || url.includes("google-analytics") || url.includes("googletagmanager") || url.includes("doubleclick")) {
          route.abort().catch(() => {
          });
        } else {
          route.continue().catch(() => {
          });
        }
      });
      page.on("console", () => {
      });
      page.on("pageerror", () => {
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4] });
        window.__watchhdDecodedPayloads = [];
        const OriginalTextDecoder = window.TextDecoder;
        const originalDecode = OriginalTextDecoder.prototype.decode;
        OriginalTextDecoder.prototype.decode = function(...args) {
          const out = originalDecode.apply(this, args);
          try {
            if (typeof out === "string" && (out.trim().startsWith("{") || out.includes('"source"') || out.includes("m3u8"))) {
              const store = window.__watchhdDecodedPayloads;
              if (Array.isArray(store) && store.length < 30)
                store.push(out);
            }
          } catch {
          }
          return out;
        };
      });
      page.on("response", async (response) => {
        try {
          const url = response.url();
          const contentType = String(response.headers()?.["content-type"] || "").toLowerCase();
          if (url.includes(".m3u8") && (contentType.includes("mpegurl") || contentType.includes("vnd.apple.mpegurl") || contentType.includes("octet-stream") || contentType.includes("text/") || contentType.includes("unknown"))) {
            const body = await response.text().catch(() => null);
            if (body && String(body).trim().startsWith("#EXTM3U")) {
              (0, import_browserRuntimeExtractor.setCachedHlsManifest)(url, String(body), contentType);
            }
          }
        } catch {
        }
      });
      await page.goto(startUrl, { waitUntil: "commit", timeout: 8e3 }).catch(() => void 0);
      const decodedPayloads = await page.evaluate(() => window.__watchhdDecodedPayloads || []).catch(() => []);
      let payload = [...decodedPayloads].reverse().map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }).find(Boolean);
      if (payload && [payload.cf, payload.hlsVideoTiktok, payload.google, payload.source].some((v) => typeof v === "string" && v.trim())) {
        const rawSources2 = [payload.cf, payload.hlsVideoTiktok, payload.google, payload.source].filter((value) => typeof value === "string" && value.trim()).map((value) => {
          const url = absoluteUrl(value, startUrl);
          return { url, quality: cleanQualityLabel(qualityFromUrl(url)), isM3U8: /\.m3u8(?:[?#]|$)/i.test(url) };
        }).filter((source) => isRawVideoUrl(source.url));
        await Promise.all(rawSources2.map(async (src) => {
          if (/hubstream\.(?:art|pw|cc|ink|foo|boo)/i.test(src.url) && src.isM3U8) {
            try {
              const body = await page.evaluate(
                async (url) => {
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), 4e3);
                  try {
                    const r = await fetch(url, { signal: controller.signal, credentials: "include", headers: { Referer: document.location.href } });
                    if (!r.ok)
                      return null;
                    return await r.text();
                  } catch {
                    return null;
                  } finally {
                    clearTimeout(timer);
                  }
                },
                src.url
              ).catch(() => null);
              if (body && String(body).trim().startsWith("#EXTM3U")) {
                (0, import_browserRuntimeExtractor.setCachedHlsManifest)(src.url, String(body), "application/vnd.apple.mpegurl");
              }
            } catch {
            }
          }
        }));
      }
      if (!payload) {
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => {
            const clickables = Array.from(
              document.querySelectorAll('button, a, div, [role="button"], #player-button, video')
            );
            for (const el of clickables) {
              try {
                el.click();
              } catch {
              }
            }
            const video = document.querySelector("video");
            if (video) {
              video.muted = true;
              video.play().catch(() => void 0);
            }
          }).catch(() => void 0);
          await page.waitForTimeout(1e3).catch(() => void 0);
        }
      }
      if (!payload) {
        const retryPayloads = await page.evaluate(() => window.__watchhdDecodedPayloads || []).catch(() => []);
        payload = [...retryPayloads].reverse().map((value) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        }).find(Boolean);
      }
      if (!payload) {
        await context.close().catch(() => void 0);
        return null;
      }
      const rawSources = [payload.cf, payload.hlsVideoTiktok, payload.google, payload.source].filter((value) => typeof value === "string" && value.trim()).map((value) => {
        const url = absoluteUrl(value, startUrl);
        return {
          url,
          quality: cleanQualityLabel(qualityFromUrl(url)),
          isM3U8: /\.m3u8(?:[?#]|$)/i.test(url)
        };
      }).filter((source) => isRawVideoUrl(source.url));
      if (!rawSources.length) {
        await context.close().catch(() => void 0);
        return null;
      }
      const subtitles = payload.tracks ? (Array.isArray(payload.tracks) ? payload.tracks : []).filter((t) => {
        const trackUrl = absoluteUrl(t.file || t.url || "", startUrl);
        return /\.(vtt|srt|ass)/i.test(trackUrl) && !/\/thumbnail(?:s)?\.vtt/i.test(trackUrl);
      }).map((t) => ({
        url: absoluteUrl(t.file || t.url || "", startUrl).replace(/#.*$/, ""),
        lang: cleanTrackLabel(t.label || t.lang)
      })).filter((t, i, arr) => arr.findIndex((x) => x.url === t.url) === i) : [];
      await context.close().catch(() => void 0);
      return {
        headers: {
          Referer: `${startUrl}#`,
          Origin: "https://hdstream4u.com",
          "User-Agent": USER_AGENT
        },
        sources: dedupe(rawSources, (s) => s.url).map((s) => ({
          url: s.url,
          quality: s.quality || "auto",
          isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
          server
        })),
        subtitles: dedupe(subtitles, (t) => `${t.lang}:${t.url}`)
      };
    } catch {
      return null;
    } finally {
      (0, import_browserRuntimeExtractor.releaseSharedBrowser)();
    }
  }
  // Fast path: decode the morencius embed page's p.a.c.k.e.r script directly in
  // Node (no Playwright). Returns the acek-cdn stream (hls2) as primary, the
  // mindbodywellness mirror (hls3) as backup, and the morencius origin (hls4) as
  // last resort, plus any vtt subtitle tracks.
  static async extractMorenciusEmbedFast(fileCode, server) {
    if (!fileCode || !/^[A-Za-z0-9_-]+$/.test(fileCode))
      return null;
    try {
      const html = await fetchText(
        `https://morencius.com/embed/${fileCode}`,
        "https://hdstream4u.com/",
        8e3
      );
      const links = decodeEmbedLinks(html);
      if (!links || !links.hls2 && !links.hls3 && !links.hls4)
        return null;
      const sources = [];
      const pushUrl = (url) => {
        const absolute = url.startsWith("/") ? `https://morencius.com${url}` : url;
        if (isRawVideoUrl(absolute)) {
          sources.push({
            url: absolute,
            quality: qualityFromUrl(absolute),
            isM3U8: /\.m3u8(?:[?#]|$)/i.test(absolute),
            server
          });
        }
      };
      if (links.hls2)
        pushUrl(links.hls2);
      if (links.hls3)
        pushUrl(links.hls3);
      if (links.hls4)
        pushUrl(links.hls4);
      if (!sources.length)
        return null;
      const subtitles = links.subtitles.map((t) => ({
        url: t.url.startsWith("/") ? `https://morencius.com${t.url}` : t.url,
        lang: cleanTrackLabel(t.label)
      })).filter((t) => /\.(vtt|srt|ass)/i.test(t.url)).filter((t, i, arr) => arr.findIndex((x) => x.url === t.url) === i);
      return {
        headers: {
          Referer: "https://morencius.com/",
          "User-Agent": USER_AGENT
        },
        sources: dedupe(sources, (s) => s.url).map((s) => ({
          url: s.url,
          quality: s.quality || "auto",
          isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
          server
        })),
        subtitles
      };
    } catch {
      return null;
    }
  }
  static async fetchSources(episodeId, server = "hdstream4u", _strictServer = false, options = {}) {
    return singleFlight(
      JSON.stringify(["watch", episodeId, server, _strictServer, options.mediaId]),
      () => this.fetchSourcesUnshared(episodeId, server, _strictServer, options)
    );
  }
  static async fetchSourcesUnshared(episodeId, server, _strictServer, options) {
    const cacheKey = `fetchSources:${String(episodeId || "").trim()}|${server}|${String(
      options?.mediaId || ""
    ).trim()}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }
    let result = await HdStream4uProvider.fetchSourcesUncached(
      episodeId,
      server,
      _strictServer,
      options
    );
    let filteredResult = filterStaleHubstreamSources(result);
    let verifiedResult = await verifyHubstreamSourcesLive(filteredResult);
    if (verifiedResult?.hubstreamAllDead) {
      result = await HdStream4uProvider.fetchSourcesUncached(
        episodeId,
        server,
        _strictServer,
        options
      );
      filteredResult = filterStaleHubstreamSources(result);
      verifiedResult = await verifyHubstreamSourcesLive(filteredResult);
    }
    if (verifiedResult?.sources?.length) {
      cache.set(cacheKey, verifiedResult, 5 * 60 * 1e3);
      return verifiedResult;
    }
    return Array.isArray(filteredResult?.sources) && filteredResult.sources.length ? filteredResult : verifiedResult || result;
  }
  static async fetchSourcesUncached(episodeId, server = "hdstream4u", _strictServer = false, options = {}) {
    try {
      const rawEpisodeId = String(episodeId || "").trim();
      let startUrl = mediaUrlFromId(rawEpisodeId || String(options.mediaId || "").trim());
      if (options.mediaId && !/^https?:\/\//i.test(String(options.mediaId)) && /^[a-z0-9][a-z0-9-]{8,}$/i.test(rawEpisodeId)) {
        startUrl = mediaUrlFromId(String(options.mediaId));
      }
      if (!startUrl) {
        return { error: "episodeId is required" };
      }
      let hubLink = "";
      let hubPlaybackPromise = null;
      if (/https?:\/\/(?:new\d+\.)?hdhub4u\.[^/]+\//i.test(startUrl)) {
        try {
          const pageHtml = await fetchText(startUrl);
          const watchLinks = extractWatchLinks(cheerio.load(pageHtml), startUrl, pageHtml);
          const directLink = watchLinks.find(
            (url) => /(?:hdstream4u|morencius)\.com\/(?:file|embed)\/[A-Za-z0-9_-]+/i.test(url)
          );
          hubLink = watchLinks.find(
            (url) => /hubstream\.(?:art|pw|cc|ink|foo|boo)\/?#/i.test(url)
          ) || "";
          if (hubLink) {
            hubPlaybackPromise = (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(hubLink, BASE_URL, 2e4).then(
              (value) => value?.sources?.length ? { ok: true, hubLink, value } : { ok: false, hubLink, value: null }
            ).catch(() => ({ ok: false, hubLink, value: null }));
          }
          if (directLink || hubLink) {
            startUrl = directLink || hubLink || startUrl;
          }
        } catch {
        }
      }
      let hubstreamOnlyFallback = null;
      if (/^https?:\/\/(?:[^.]+\.)*hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(startUrl)) {
        const hubHash = /#([A-Za-z0-9_-]+)\/?$/i.exec(startUrl)?.[1] || "";
        if (!hubHash) {
          const hubPlayback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(startUrl, BASE_URL, 2e4);
          if (hubPlayback?.sources?.length) {
            return {
              headers: {
                Referer: startUrl,
                ...hubPlayback.cookieHeader ? { Cookie: hubPlayback.cookieHeader } : {},
                "User-Agent": USER_AGENT
              },
              sources: hubPlayback.sources.map((s) => ({
                url: s.url,
                quality: s.quality || "auto",
                isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
                server
              })),
              subtitles: hubPlayback.subtitles || []
            };
          }
        } else if (!hubPlaybackPromise) {
          hubstreamOnlyFallback = (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(startUrl, BASE_URL, 2e4).then(
            (value) => value?.sources?.length ? { ok: true, hubLink: startUrl, value } : { ok: false, hubLink: startUrl, value: null }
          ).catch(() => ({ ok: false, hubLink: startUrl, value: null }));
        }
      }
      const fileCodeMatch = /^https?:\/\/(?:[^.]+\.)?(?:hdstream4u\.com|morencius\.com)\/(?:file|embed)\/([A-Za-z0-9_-]+)/i.exec(startUrl);
      let fileCode = fileCodeMatch?.[1] || (/^[a-z0-9_-]{8,}$/i.test(rawEpisodeId) ? rawEpisodeId : "");
      if (!fileCode && hubstreamOnlyFallback) {
        fileCode = /#([A-Za-z0-9_-]+)\/?$/i.exec(startUrl)?.[1] || "";
      }
      if (fileCode && !hubstreamOnlyFallback) {
        const fastEmbed = await this.extractMorenciusEmbedFast(fileCode, server);
        if (fastEmbed?.sources?.length) {
          const states = await Promise.all(
            fastEmbed.sources.map(
              (s) => verifySourcePlayableState(String(s?.url || ""), "https://morencius.com/", 2500)
            )
          );
          const aliveSources = fastEmbed.sources.filter(
            (_s, i) => states[i] !== "dead"
          );
          if (aliveSources.length) {
            return {
              headers: {
                Referer: "https://morencius.com/",
                "User-Agent": USER_AGENT
              },
              sources: aliveSources.map((s) => ({
                url: s.url,
                quality: s.quality || "auto",
                isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
                server
              })),
              subtitles: fastEmbed.subtitles || []
            };
          }
        }
        const embedUrl = `https://morencius.com/embed/${fileCode}`;
        const playbackPromise = (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(embedUrl, BASE_URL, 15e3).then((value) => value?.sources?.length ? { kind: "embed", value } : Promise.reject(new Error("No embed sources")));
        const filePromise = this.extractHdstream4uFileWithManifestPrefetch(`https://hdstream4u.com/file/${fileCode}`, server).then((value) => value?.sources?.length ? { kind: "file", value } : Promise.reject(new Error("No file sources")));
        const firstSource = await Promise.race([
          Promise.any([filePromise, playbackPromise]).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(), 45e3))
        ]);
        const hubResult = firstSource?.kind === "hub" ? firstSource.value : null;
        if (hubResult?.sources?.length && firstSource) {
          return {
            headers: {
              Referer: firstSource?.hubLink,
              ...hubResult.cookieHeader ? { Cookie: hubResult.cookieHeader } : {},
              "User-Agent": USER_AGENT
            },
            sources: hubResult.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: hubResult.subtitles || []
          };
        }
        const playback = firstSource?.kind === "embed" ? firstSource.value : null;
        const hdResult = firstSource?.kind === "file" ? firstSource.value : null;
        if (playback?.sources?.length) {
          const playbackNeedsHubFallback = playback.sources.some(
            (s) => /(?:morencius\.com|tiktokcdn\.com|hdstream4u\.com)/i.test(String(s?.url || ""))
          );
          if (playbackNeedsHubFallback && fileCode) {
            const embedSource = playback.sources.find(
              (s) => !/tiktokcdn\.com/i.test(String(s?.url || ""))
            );
            const embedHealthy = embedSource ? await verifySourcePlayable(
              String(embedSource.url),
              "https://morencius.com/"
            ) : false;
            if (!embedHealthy) {
              try {
                const hubUrl = `https://hubstream.art/#${fileCode}`;
                const hubPlayback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(hubUrl, BASE_URL, 2e4);
                if (hubPlayback?.sources?.length) {
                  return {
                    headers: {
                      Referer: hubUrl,
                      ...hubPlayback.cookieHeader ? { Cookie: hubPlayback.cookieHeader } : {},
                      "User-Agent": USER_AGENT
                    },
                    sources: hubPlayback.sources.map((s) => ({
                      url: s.url,
                      quality: s.quality || "auto",
                      isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
                      server
                    })),
                    subtitles: hubPlayback.subtitles || []
                  };
                }
              } catch {
              }
            }
          }
          return {
            headers: { Referer: "https://morencius.com/", "User-Agent": USER_AGENT },
            sources: playback.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: playback.subtitles || []
          };
        }
        if (hdResult?.sources?.length) {
          const allTiktok = hdResult.sources.every(
            (s) => /tiktokcdn\.com/i.test(s.url)
          );
          if (allTiktok && fileCode) {
            const hubUrl = `https://hubstream.art/#${fileCode}`;
            const hubPlayback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(hubUrl, BASE_URL, 2e4);
            if (hubPlayback?.sources?.length) {
              return {
                headers: {
                  Referer: hubUrl,
                  "User-Agent": USER_AGENT
                },
                sources: hubPlayback.sources.map((s) => ({
                  url: s.url,
                  quality: s.quality || "auto",
                  isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
                  server
                })),
                subtitles: hubPlayback.subtitles || []
              };
            }
          }
          return hdResult;
        }
      }
      const hubFallbackPromise = hubPlaybackPromise || hubstreamOnlyFallback;
      if (hubFallbackPromise) {
        const hub = await hubFallbackPromise;
        if (hub?.ok && hub.value?.sources?.length) {
          return {
            headers: {
              Referer: hub.hubLink,
              ...hub.value.cookieHeader ? { Cookie: hub.value.cookieHeader } : {},
              "User-Agent": USER_AGENT
            },
            sources: hub.value.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: hub.value.subtitles || []
          };
        }
      }
      if (hubstreamOnlyFallback && fileCode) {
        return HdStream4uProvider.fetchSourcesUncached(
          `https://hdstream4u.com/file/${fileCode}`,
          server,
          _strictServer,
          options
        );
      }
      if (!/^https?:\/\//i.test(rawEpisodeId) && /^[a-z0-9_-]{8,}$/i.test(rawEpisodeId)) {
        const embedUrl = `https://hdstream4u.com/embed/${rawEpisodeId}`;
        const playback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(embedUrl, BASE_URL, 15e3);
        if (playback?.sources?.length) {
          return {
            headers: { Referer: "https://hdstream4u.com/", "User-Agent": USER_AGENT },
            sources: playback.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: playback.subtitles || []
          };
        }
      }
      if (/^https?:\/\/(?:[^.]+\.)?tpead\.net\/(?:v|e)\//i.test(startUrl)) {
        const tpeadPlayback = await resolveTpeadPlayback(startUrl, BASE_URL);
        if (tpeadPlayback?.sources?.length) {
          return {
            headers: {
              Referer: startUrl,
              "User-Agent": USER_AGENT
            },
            sources: tpeadPlayback.sources.map((s) => ({ ...s, server })),
            subtitles: tpeadPlayback.subtitles
          };
        }
      }
      if (/^https?:\/\/(?:[^.]+\.)*hubstream\.(?:art|pw|cc|ink|foo|boo)\/?#/i.test(rawEpisodeId) || /^https?:\/\/(?:[^.]+\.)*hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(startUrl)) {
        const hubPlayback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(startUrl, BASE_URL, 2e4);
        if (hubPlayback?.sources?.length) {
          return {
            headers: {
              Referer: startUrl,
              ...hubPlayback.cookieHeader ? { Cookie: hubPlayback.cookieHeader } : {},
              "User-Agent": USER_AGENT
            },
            sources: hubPlayback.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: hubPlayback.subtitles || []
          };
        }
      }
      const resolved = await resolveToPlayer(
        startUrl,
        options.mediaId ? mediaUrlFromId(String(options.mediaId || "").trim()) : startUrl
      );
      if (isRawVideoUrl(resolved.playerUrl)) {
        return {
          headers: {
            ...resolved.origin ? { Origin: resolved.origin } : {},
            Referer: resolved.referer,
            "User-Agent": USER_AGENT
          },
          sources: [
            {
              url: resolved.playerUrl,
              quality: qualityFromUrl(resolved.playerUrl),
              isM3U8: /\.m3u8(?:[?#]|$)/i.test(resolved.playerUrl),
              server
            }
          ],
          subtitles: []
        };
      }
      if (/watchhd\.upns\.live/i.test(resolved.playerUrl)) {
        const watchhdPlayback = await extractWatchhdSourcesWithPlaywright(
          resolved.playerUrl,
          resolved.referer
        );
        if (watchhdPlayback.sources.length) {
          return {
            headers: {
              ...resolved.origin ? { Origin: resolved.origin } : {},
              Referer: resolved.referer,
              "User-Agent": USER_AGENT
            },
            sources: watchhdPlayback.sources.map((s) => ({ ...s, server })),
            subtitles: watchhdPlayback.subtitles
          };
        }
      }
      if (/tpead\.net\/(?:v|e)\//i.test(resolved.playerUrl)) {
        const tpeadPlayback = await resolveTpeadPlayback(resolved.playerUrl, resolved.referer);
        if (tpeadPlayback.sources.length) {
          return {
            headers: {
              ...resolved.origin ? { Origin: resolved.origin } : {},
              Referer: resolved.playerUrl,
              "User-Agent": USER_AGENT
            },
            sources: tpeadPlayback.sources.map((s) => ({ ...s, server })),
            subtitles: tpeadPlayback.subtitles
          };
        }
      }
      if (/hubstream\.(?:art|pw|cc|ink|foo|boo)/i.test(resolved.playerUrl)) {
        const hubPlayback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(
          resolved.playerUrl,
          resolved.referer,
          15e3
        );
        if (hubPlayback.sources.length) {
          return {
            headers: {
              ...resolved.origin ? { Origin: resolved.origin } : {},
              Referer: resolved.playerUrl,
              ...hubPlayback.cookieHeader ? { Cookie: hubPlayback.cookieHeader } : {},
              "User-Agent": USER_AGENT
            },
            sources: hubPlayback.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: hubPlayback.subtitles || []
          };
        }
      }
      const playerHtml = resolved.html ?? await fetchText(resolved.playerUrl, resolved.referer);
      const parsed = {
        sources: extractStreams(playerHtml, resolved.playerUrl),
        subtitles: extractSubtitles(playerHtml, resolved.playerUrl),
        headers: extractHeaders(playerHtml, resolved.playerUrl)
      };
      if (parsed.sources.length && !parsed.subtitles.length) {
        try {
          const playbackSubtitles = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(
            resolved.playerUrl,
            resolved.referer,
            15e3
          );
          if (playbackSubtitles.subtitles.length) {
            parsed.subtitles = dedupe(
              [
                ...parsed.subtitles,
                ...playbackSubtitles.subtitles.map((track) => ({
                  url: absoluteUrl(String(track?.url || ""), resolved.playerUrl),
                  lang: cleanTrackLabel(String(track?.lang || track?.label || "English"))
                }))
              ].filter((track) => track.url),
              (track) => `${track.lang}:${track.url}`
            );
          }
        } catch {
        }
      }
      if (!parsed.sources.length) {
        const gatePlayback = await resolveGateWithPlaywright(resolved.playerUrl, resolved.referer, 15e3);
        if (gatePlayback.sources?.length) {
          return {
            headers: {
              ...resolved.origin ? { Origin: resolved.origin } : {},
              Referer: resolved.playerUrl,
              "User-Agent": USER_AGENT
            },
            sources: gatePlayback.sources.map((s) => ({ ...s, server })),
            subtitles: []
          };
        }
        if (gatePlayback.playerUrl) {
          if (/watchhd\.upns\.live/i.test(gatePlayback.playerUrl)) {
            const watchhdPlayback = await extractWatchhdSourcesWithPlaywright(
              gatePlayback.playerUrl,
              resolved.playerUrl
            );
            if (watchhdPlayback.sources.length) {
              return {
                headers: {
                  ...resolved.origin ? { Origin: resolved.origin } : {},
                  Referer: gatePlayback.playerUrl,
                  "User-Agent": USER_AGENT
                },
                sources: watchhdPlayback.sources.map((s) => ({ ...s, server })),
                subtitles: watchhdPlayback.subtitles
              };
            }
          }
          if (/callistanise\.com/i.test(gatePlayback.playerUrl)) {
            const finalPlayback2 = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(
              gatePlayback.playerUrl,
              resolved.playerUrl,
              15e3
            );
            if (finalPlayback2.sources.length) {
              return {
                headers: {
                  ...resolved.origin ? { Origin: resolved.origin } : {},
                  Referer: gatePlayback.playerUrl,
                  "User-Agent": USER_AGENT
                },
                sources: finalPlayback2.sources.map((s) => ({
                  url: s.url,
                  quality: s.quality || "auto",
                  isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
                  server
                })),
                subtitles: finalPlayback2.subtitles || []
              };
            }
          }
          const finalGatePlayback = await resolveGateWithPlaywright(
            gatePlayback.playerUrl,
            resolved.playerUrl,
            15e3
          );
          if (finalGatePlayback.sources?.length) {
            return {
              headers: {
                ...resolved.origin ? { Origin: resolved.origin } : {},
                Referer: gatePlayback.playerUrl,
                "User-Agent": USER_AGENT
              },
              sources: finalGatePlayback.sources.map((s) => ({ ...s, server })),
              subtitles: []
            };
          }
          const finalPlayback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(
            gatePlayback.playerUrl,
            resolved.playerUrl,
            15e3
          );
          if (finalPlayback.sources.length) {
            return {
              headers: {
                ...resolved.origin ? { Origin: resolved.origin } : {},
                Referer: gatePlayback.playerUrl,
                "User-Agent": USER_AGENT
              },
              sources: finalPlayback.sources.map((s) => ({
                url: s.url,
                quality: s.quality || "auto",
                isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
                server
              })),
              subtitles: finalPlayback.subtitles || []
            };
          }
        }
        const playback = await (0, import_browserRuntimeExtractor.extractPlaybackWithPlaywright)(
          resolved.playerUrl,
          resolved.referer,
          15e3
        );
        if (playback.sources.length) {
          return {
            headers: {
              ...resolved.origin ? { Origin: resolved.origin } : {},
              Referer: resolved.playerUrl,
              "User-Agent": USER_AGENT
            },
            sources: playback.sources.map((s) => ({
              url: s.url,
              quality: s.quality || "auto",
              isM3U8: s.isM3U8 || /\.m3u8/i.test(s.url),
              server
            })),
            subtitles: playback.subtitles || []
          };
        }
        throw new Error("HDHub4U: no raw playable streams found");
      }
      return {
        headers: {
          ...parsed.headers,
          ...resolved.origin ? { Origin: resolved.origin } : {},
          Referer: resolved.playerUrl,
          "User-Agent": USER_AGENT
        },
        sources: parsed.sources.map((s) => ({ ...s, server })),
        subtitles: parsed.subtitles
      };
    } catch (error) {
      return { error: error.message };
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HdStream4uProvider
});
