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
var buffstreams_exports = {};
__export(buffstreams_exports, {
  BuffStreams: () => BuffStreams,
  default: () => buffstreams_default
});
module.exports = __toCommonJS(buffstreams_exports);
var import_models = require("@consumet/extensions/dist/models");
var import_extensions = require("@consumet/extensions");
var import_browserRuntimeExtractor = require("../../utils/browserRuntimeExtractor");
var import_domain_resolver = require("./domain-resolver");
class BuffStreams extends import_models.MovieParser {
  constructor() {
    super();
    this.name = "BuffStreams";
    this.classPath = "SPORTS.BuffStreams";
    this.supportedTypes = /* @__PURE__ */ new Set([import_extensions.TvType.MOVIE, import_extensions.TvType.TVSERIES]);
    this.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    this.REQUEST_TIMEOUT_MS = 8e3;
    this.DEEP_PROBE_CONCURRENCY = 8;
    this.DEEP_PROBE_TTL_MS = 5 * 60 * 1e3;
    this.deepProbeCache = /* @__PURE__ */ new Map();
    this.probeInFlight = /* @__PURE__ */ new Map();
    this.logo = `${this.baseUrl}/images/mlb.webp?v3e32`;
  }
  get baseUrl() {
    return import_domain_resolver.BaseUrlResolver.getBaseUrl();
  }
  get homeUrl() {
    return `${this.baseUrl}/index7`;
  }
  get index18Url() {
    return `${this.baseUrl}/index18`;
  }
  getAllCategoryPages(b) {
    return {
      nfl: `${b}/nflstreams2`,
      soccer: `${b}/soccer-live-streams`,
      mma: `${b}/mmastreams2`,
      boxing: `${b}/boxingstreams2`,
      f1: `${b}/f1streams2`,
      nba: `${b}/nbastreams2`,
      nhl: `${b}/nhlstreams2`,
      mlb: `${b}/mlb-live-streams`,
      ncaa: `${b}/ncaastreams`
    };
  }
  get categoryPages() {
    return this.getAllCategoryPages(this.baseUrl);
  }
  buildHeaders(referer) {
    const origin = (() => {
      try {
        return new URL(referer).origin;
      } catch {
        return this.baseUrl;
      }
    })();
    return { "User-Agent": this.userAgent, Referer: referer, Origin: origin };
  }
  cleanText(value) {
    return String(value || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  }
  toAbsoluteUrl(value, fallbackBase = this.baseUrl) {
    const raw = String(value || "").trim();
    if (!raw)
      return null;
    try {
      return new URL(raw, fallbackBase).toString();
    } catch {
      return null;
    }
  }
  stripUnneededHtml(value) {
    return String(value || "").replace(/<svg\b[\s\S]*?<\/svg>/gi, "").replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<footer\b[\s\S]*?<\/footer>/gi, "").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  }
  async fetchLeanHtml(url, referer = this.homeUrl, options = {}) {
    const headers = {
      ...this.buildHeaders(referer),
      Accept: "text/html,application/xhtml+xml"
    };
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206)
      throw new Error(`HTTP error! status: ${response.status}`);
    const maxBytes = options.maxBytes || 512 * 1024;
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      return this.stripUnneededHtml(text.slice(0, maxBytes));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let output = "";
    try {
      while (received < maxBytes) {
        const { done, value } = await reader.read();
        if (done)
          break;
        received += value.byteLength;
        output += decoder.decode(value, { stream: true });
        output = this.stripUnneededHtml(output);
        if (typeof options.stopWhen === "function" && options.stopWhen(output))
          break;
      }
      output += decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
    return this.stripUnneededHtml(output);
  }
  async fetchRawHtml(url, referer = this.homeUrl, options = {}) {
    const headers = {
      ...this.buildHeaders(referer),
      Accept: "text/html,application/xhtml+xml",
      Range: `bytes=0-${Math.max(0, (options.maxBytes || 512 * 1024) - 1)}`
    };
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206)
      throw new Error(`HTTP error! status: ${response.status}`);
    const maxBytes = options.maxBytes || 512 * 1024;
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      return text.slice(0, maxBytes);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let output = "";
    try {
      while (received < maxBytes) {
        const { done, value } = await reader.read();
        if (done)
          break;
        received += value.byteLength;
        output += decoder.decode(value, { stream: true });
        if (typeof options.stopWhen === "function" && options.stopWhen(output))
          break;
      }
      output += decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
    return output;
  }
  extractCountdownFromScripts(rawHtml) {
    if (!rawHtml)
      return null;
    const scriptBlocks = rawHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of scriptBlocks) {
      const inner = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
      const explicitCountdown = inner.match(
        /["']?(?:countdown|countdownSeconds|countdownLeft|timeLeft|timeRemaining|secondsLeft|secondsRemaining)["']?\s*[:=]\s*(\d{3,6})\b/i
      );
      if (explicitCountdown) {
        const totalSeconds = parseInt(explicitCountdown[1], 10);
        if (totalSeconds > 60 && totalSeconds < 86400) {
          return {
            h: Math.floor(totalSeconds / 3600),
            m: Math.floor(totalSeconds % 3600 / 60),
            s: totalSeconds % 60
          };
        }
      }
      const explicitHms = inner.match(
        /["']?(?:countdown|countdownSeconds|countdownLeft|timeLeft|timeRemaining)["']?\s*[:=]\s*["']?(\d{1,2})\s*[:\-,/]\s*(\d{1,2})\s*[:\-,/]\s*(\d{1,2})["']?/i
      );
      if (explicitHms) {
        const h = parseInt(explicitHms[1], 10);
        const m = parseInt(explicitHms[2], 10);
        const s = parseInt(explicitHms[3], 10);
        if (h < 48 && m < 60 && s < 60 && h * 3600 + m * 60 + s > 60)
          return { h, m, s };
      }
      const timestampCountdown = inner.match(
        /["']?(?:startAt|eventStart|startTime|eventStartUtc|countdownTarget)["']?\s*[:=]\s*(\d{10,13})\b/i
      );
      if (timestampCountdown) {
        const ts = parseInt(timestampCountdown[1], 10);
        const diffMs = (ts > 1e12 ? ts : ts * 1e3) - Date.now();
        if (diffMs > 6e4 && diffMs < 864e5) {
          const totalSeconds = Math.floor(diffMs / 1e3);
          return {
            h: Math.floor(totalSeconds / 3600),
            m: Math.floor(totalSeconds % 3600 / 60),
            s: totalSeconds % 60
          };
        }
      }
    }
    return null;
  }
  extractLiveState(title = "", statusText = "", rowHtml = "") {
    try {
      const normalize = (value) => this.cleanText(value).replace(/\blive streams?(?:\s+links)?\b/gi, " ").replace(/\bwatch(?:\s+live)?\b/gi, " ").replace(/\s+/g, " ").trim();
      const haystack = [statusText, title, normalize(rowHtml)].map(normalize).filter(Boolean).join(" ");
      const exactTimeMatch = haystack.match(
        /\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:AM|PM)?(?:\s*[A-Z]{2,4})?\b/i
      );
      const periodPatterns = [
        /\bIN\s*PROGRESS\b/i,
        /\b(?:1ST|2ND)\s*HALF\b/i,
        /\bHALF\s*TIME\b|\bHALFTIME\b/i,
        /\b(?:1ST|2ND|3RD|4TH)\s*QUARTER\b/i,
        /\bQ[1-4]\b/i,
        /\b(?:1ST|2ND|3RD)\s*PERIOD\b/i,
        /\bOVERTIME\b|\bOT\b/i,
        /\bTOP\s+\d+(?:ST|ND|RD|TH)?\b|\bBOTTOM\s+\d+(?:ST|ND|RD|TH)?\b/i,
        /\bLIVE\b/i
      ];
      const periodMatch = periodPatterns.map((p) => haystack.match(p)).find(Boolean);
      const periodText = (periodMatch?.[0] || "").replace(/\s+/g, " ").trim().toUpperCase();
      const isLive = Boolean(
        periodText && !/\bNOT\s*STARTED\b|\bUPCOMING\b/i.test(periodText)
      );
      return {
        isLive,
        periodText,
        exactTime: exactTimeMatch ? exactTimeMatch[0].replace(/\s+/g, " ").trim() : ""
      };
    } catch {
      return { isLive: false, periodText: "", exactTime: "" };
    }
  }
  inferType(url, sectionTitle = "") {
    const lower = `${url || ""} ${sectionTitle || ""}`.toLowerCase();
    if (lower.includes("/wnba/") || lower.includes("wnba"))
      return "wnba";
    if (lower.includes("/wwe/") || lower.includes("wwe"))
      return "wwe";
    if (lower.includes("/nba/") || lower.includes("nba"))
      return "nba";
    if (lower.includes("/nhl/") || lower.includes("nhl"))
      return "nhl";
    if (lower.includes("/mlb/") || lower.includes("baseball") || lower.includes("mlb"))
      return "mlb";
    if (lower.includes("/nfl/") || lower.includes("nfl"))
      return "nfl";
    if (lower.includes("/boxing/") || lower.includes("boxing"))
      return "boxing";
    if (lower.includes("/mma/") || lower.includes("mma") || lower.includes("ufc"))
      return "mma";
    if (lower.includes("/soccer") || lower.includes("/football") || lower.includes("soccer") || lower.includes("world cup") || lower.includes("world championship"))
      return "soccer";
    if (lower.includes("/f1/") || lower.includes("formula 1") || lower.includes("f1") || lower.includes("nascar") || lower.includes("indycar"))
      return "f1";
    if (lower.includes("/ncaa/") || lower.includes("ncaa"))
      return "ncaa";
    return "sports";
  }
  extractExactTime(value) {
    const match = String(value || "").match(
      /\b\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*(?:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT|CEST|CET|BST|IST|MSK|JST|AEST|AEDT|AWST|NZST|NZDT|SGT|HKT|CST\s+Asia|EEST|EET|WEST|WET|CAT|EAT|SAST|BRT|ART|CLT)?)?\b/i
    );
    return match ? match[0].replace(/\s+/g, " ").trim() : "";
  }
  buildEasternEventStartMs(exactTime, canonicalDate) {
    const dateMatch = String(canonicalDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = String(exactTime || "").match(
      /(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT))?/i
    );
    if (!dateMatch || !timeMatch)
      return 0;
    let hours = Number(timeMatch[1]) % 12;
    const minutes = Number(timeMatch[2]);
    if (String(timeMatch[3] || "").toUpperCase() === "PM")
      hours += 12;
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const day = Number(dateMatch[3]);
    const zoneToken = String(timeMatch[4] || "UTC").toUpperCase().replace(/\s+ASIA/i, "");
    const zoneOffsetHours = zoneToken.startsWith("CT") ? 5 : zoneToken.startsWith("MT") ? 6 : zoneToken.startsWith("PT") ? 7 : zoneToken === "UTC" || zoneToken === "GMT" ? 0 : zoneToken === "CEST" || zoneToken === "CET" || zoneToken === "BST" || zoneToken === "WEST" || zoneToken === "WET" || zoneToken === "CAT" || zoneToken === "EAT" || zoneToken === "SAST" ? 2 : zoneToken === "EEST" || zoneToken === "EET" || zoneToken === "IST" || zoneToken === "MSK" ? 3 : zoneToken === "SGT" || zoneToken === "HKT" || zoneToken === "AWST" || zoneToken === "CST" ? 8 : zoneToken === "JST" || zoneToken === "KST" ? 9 : zoneToken === "AEST" || zoneToken === "AEDT" || zoneToken === "NZST" || zoneToken === "NZDT" ? 11 : zoneToken === "BRT" || zoneToken === "ART" ? 3 : zoneToken === "CLT" ? 4 : zoneToken === "ET" || zoneToken === "EST" || zoneToken === "EDT" ? 4 : 0;
    const resultMs = Date.UTC(year, month, day, hours + zoneOffsetHours, minutes, 0, 0);
    const isAmTime = String(timeMatch[3] || "").toUpperCase() === "AM" && hours < 12;
    if (isAmTime && resultMs < Date.now() - 8 * 60 * 60 * 1e3) {
      const nextDayMs = Date.UTC(
        year,
        month,
        day + 1,
        hours + zoneOffsetHours,
        minutes,
        0,
        0
      );
      if (nextDayMs > Date.now() - 2 * 60 * 60 * 1e3)
        return nextDayMs;
    }
    return resultMs;
  }
  fillSiblingScheduleData(streams) {
    const sectionDateMap = /* @__PURE__ */ new Map();
    for (const stream of streams) {
      const key = String(stream?.sectionTitle || "").trim().toLowerCase();
      const canonicalDate = String(stream?.canonicalEventDate || "").trim();
      if (key && canonicalDate && !sectionDateMap.has(key))
        sectionDateMap.set(key, canonicalDate);
    }
    return streams.map((stream) => {
      const sectionKey = String(stream?.sectionTitle || "").trim().toLowerCase();
      const canonicalDate = String(
        stream?.canonicalEventDate || sectionDateMap.get(sectionKey) || ""
      ).trim();
      const exactTime = this.extractExactTime(
        stream?.liveState?.exactTime || stream?.statusText || stream?.title || ""
      );
      if (canonicalDate && exactTime) {
        const computedMs = this.buildEasternEventStartMs(exactTime, canonicalDate);
        const existingMs = Number(stream?.eventStartUtcMs || 0);
        if (computedMs && computedMs > Date.now() - 2 * 60 * 60 * 1e3) {
          const shouldOverride = !existingMs;
          if (shouldOverride) {
            const countdownSeconds = Math.floor((computedMs - Date.now()) / 1e3);
            return {
              ...stream,
              canonicalEventDate: canonicalDate || stream?.canonicalEventDate,
              eventStartUtcMs: computedMs,
              countdownSeconds,
              isLocked: countdownSeconds > 0 ? true : stream?.isLocked,
              lockReason: countdownSeconds > 0 ? "countdown-timer" : stream?.lockReason
            };
          }
        }
      }
      if (stream?.canonicalEventDate && Number(stream?.eventStartUtcMs || 0) > 0)
        return stream;
      if (canonicalDate && !stream?.canonicalEventDate) {
        return { ...stream, canonicalEventDate: canonicalDate };
      }
      return stream;
    });
  }
  inferLiveState(title, statusText, sectionTitle) {
    const liveState = this.extractLiveState(title, statusText);
    if (liveState.isLive)
      return true;
    const haystack = `${statusText || ""} ${title || ""} ${sectionTitle || ""}`.toLowerCase();
    return /\bin progress\b|\blive\b|\b1st half\b|\b2nd half\b|\bhalftime\b|\bquarter\b|\bq[1-4]\b|\bperiod\b|\bovertime\b|\binnings?\b|\btop \d+|\bbottom \d+|\bpractice\b|\bqualifying\b|\bsprint\b|\brace\b/i.test(
      haystack
    );
  }
  parseCompetitionItem(itemHtml, fallbackImage, sectionTitle) {
    const hrefMatch = itemHtml.match(/<a[^>]+href=["']([^"']+)["']/i);
    const url = this.toAbsoluteUrl(hrefMatch?.[1] || "");
    if (!url)
      return null;
    const anchorHtml = itemHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || itemHtml;
    const type = this.inferType(url, sectionTitle);
    const compactTitle = this.cleanText(
      anchorHtml.match(/<div[^>]*>([\s\S]*?)<\/div>/i)?.[1] || ""
    );
    const compactMeta = this.cleanText(
      anchorHtml.match(/<small[^>]*>([\s\S]*?)<\/small>/i)?.[1] || ""
    );
    if (compactTitle) {
      const liveState2 = this.extractLiveState(compactTitle, compactMeta, itemHtml);
      return {
        id: url,
        title: compactTitle,
        url,
        type,
        image: fallbackImage,
        categoryImage: fallbackImage,
        statusText: compactMeta,
        liveState: liveState2,
        isLive: liveState2.isLive || this.inferLiveState(compactTitle, compactMeta, sectionTitle)
      };
    }
    const nameMatches = [
      ...anchorHtml.matchAll(
        /<span[^>]*class=["'][^"']*name[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi
      )
    ].map((m) => this.cleanText(m[1])).filter(Boolean);
    const statusMatch = anchorHtml.match(
      /<(?:time|span)[^>]*class=["'][^"']*competition-cell-status[^"']*["'][^>]*>([\s\S]*?)<\/(?:time|span)>/i
    );
    const status = this.cleanText(statusMatch?.[1] || "");
    const sideA = nameMatches[0] || "";
    const sideB = nameMatches[1] || "";
    const title = [sideA, status, sideB].filter(Boolean).join(" ").trim() || this.cleanText(url);
    const liveState = this.extractLiveState(title, status, itemHtml);
    return {
      id: url,
      title,
      url,
      type,
      image: fallbackImage,
      categoryImage: fallbackImage,
      statusText: status,
      liveState,
      isLive: liveState.isLive || this.inferLiveState(title, status, sectionTitle)
    };
  }
  parseStreamsFromHTML(html) {
    const sections = [];
    const seen = /* @__PURE__ */ new Set();
    const tournamentRegex = /<div\b[^>]*class=["'][^"']*top-tournament[^"']*["'][^>]*>/gi;
    const starts = [...html.matchAll(tournamentRegex)].map((m) => m.index).filter((i) => Number.isFinite(i));
    for (let i = 0; i < starts.length; i += 1) {
      const block = html.slice(starts[i], starts[i + 1] || html.length);
      const listOpenMatch = block.match(
        /<ul\b[^>]*class=["'][^"']*competitions[^"']*["'][^>]*>/i
      );
      if (!listOpenMatch)
        continue;
      const listStart = (listOpenMatch.index || 0) + listOpenMatch[0].length;
      const listEnd = block.indexOf("</ul>", listStart);
      const listBlock = listEnd >= 0 ? block.slice(listStart, listEnd) : block.slice(listStart);
      const headingBlock = block.slice(0, listOpenMatch.index || 0);
      const imageMatch = headingBlock.match(/<img[^>]+src=["']([^"']+)["']/i);
      const titleMatch = headingBlock.match(
        /<h2[^>]*class=["'][^"']*league-name[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
      ) || headingBlock.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
      const sectionImage = this.toAbsoluteUrl(imageMatch?.[1] || "") || "";
      const sectionTitle = this.cleanText(titleMatch?.[1] || "Live Streams");
      const itemMatches = [...listBlock.matchAll(/<li\b[\s\S]*?<\/li>/gi)];
      for (const match of itemMatches) {
        const parsed = this.parseCompetitionItem(match[0], sectionImage, sectionTitle);
        if (!parsed)
          continue;
        if (seen.has(parsed.url))
          continue;
        seen.add(parsed.url);
        sections.push({ ...parsed, sectionTitle, tournamentImage: sectionImage });
      }
    }
    return sections;
  }
  async fetchCategoryStreams(url) {
    const html = await this.fetchLeanHtml(url, this.homeUrl, {
      maxBytes: 900 * 1024,
      stopWhen: (text) => /<\/html>/i.test(text)
    });
    return this.parseStreamsFromHTML(html);
  }
  async fetchAllStreams() {
    const b = this.baseUrl;
    const urls = [`${b}/index7`, `${b}/index18`];
    const results = await Promise.allSettled(
      urls.map((url) => this.fetchCategoryStreams(url))
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    return this.mergeStreams(fulfilled);
  }
  mergeStreams(streamGroups) {
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const group of streamGroups) {
      for (const stream of group) {
        const key = stream.url || stream.id;
        if (!key || seen.has(key))
          continue;
        seen.add(key);
        merged.push(stream);
      }
    }
    return merged;
  }
  getDeepProbeCache(streamId) {
    const cached = this.deepProbeCache.get(streamId);
    if (!cached)
      return null;
    if (Date.now() - cached.probedAt > this.DEEP_PROBE_TTL_MS) {
      this.deepProbeCache.delete(streamId);
      return null;
    }
    return cached;
  }
  setDeepProbeCache(streamId, data) {
    this.deepProbeCache.set(streamId, { ...data, probedAt: Date.now() });
  }
  async deepProbeStream(streamUrl) {
    const probeId = String(streamUrl || "").trim();
    if (!probeId)
      return {
        canonicalEventDate: "",
        eventStartUtcMs: 0,
        countdownSeconds: -1,
        hasActiveStream: false,
        isLive: false,
        isLocked: false,
        lockReason: ""
      };
    const cached = this.getDeepProbeCache(probeId);
    if (cached)
      return cached;
    if (this.probeInFlight.has(probeId))
      return this.probeInFlight.get(probeId);
    const promise = (async () => {
      try {
        const rawHtml = await this.fetchRawHtml(probeId, this.homeUrl, {
          maxBytes: 256 * 1024,
          stopWhen: (text) => /<\/html>/i.test(text) || /<iframe[^>]+src=["'][^"']+["']/i.test(text)
        });
        const html = this.stripUnneededHtml(rawHtml);
        const result = {
          canonicalEventDate: "",
          eventStartUtcMs: 0,
          countdownSeconds: -1,
          hasActiveStream: false,
          isLive: false,
          isLocked: false,
          lockReason: ""
        };
        const dateText = html.match(/<img[^>]+>\s*<span[^>]*>(\d{4}-\d{2}-\d{2})<\/span>/i) || html.match(
          /<[^>]*class=["'][^"']*date[^"']*["'][^>]*>([^<]*\d{4}-\d{2}-\d{2}[^<]*)<\/[^>]*>/i
        ) || html.match(/>(\d{4}-\d{2}-\d{2})</i);
        if (dateText?.[1])
          result.canonicalEventDate = dateText[1].trim();
        const epochMatch = html.match(/var\s+countDownDate\s*=\s*(\d{10,13})\s*\*\s*1000/i) || html.match(
          /(?:countDownDate|countdownTarget|eventStart|startAt|startTime|eventStartUtc)["']?\s*[:=]\s*["']?(\d{10,13})\b/i
        ) || html.match(
          /(?:countDownDate|countdownTarget|eventStart|startAt|startTime|eventStartUtc)["']?\s*[:=]\s*["']?(\d{10,13})\s*\*\s*1000/i
        );
        if (epochMatch?.[1]) {
          const rawTs = parseInt(epochMatch[1], 10);
          const tsMs = rawTs < 1e12 ? rawTs * 1e3 : rawTs;
          const diffMs = tsMs - Date.now();
          if (diffMs > 0 && diffMs < 7 * 24 * 60 * 60 * 1e3) {
            result.eventStartUtcMs = tsMs;
            result.countdownSeconds = Math.floor(diffMs / 1e3);
            result.isLocked = true;
            result.lockReason = "countdown-timer";
          }
        }
        const countdownFromScripts = result.eventStartUtcMs > 0 ? null : this.extractCountdownFromScripts(rawHtml);
        const countdownMatch = result.eventStartUtcMs > 0 ? null : countdownFromScripts ? [
          "",
          String(countdownFromScripts.h),
          String(countdownFromScripts.m),
          String(countdownFromScripts.s)
        ] : html.match(/\b(\d{2}):(\d{2}):(\d{2})\b/);
        if (countdownMatch) {
          const h = parseInt(countdownMatch[1], 10);
          const m = parseInt(countdownMatch[2], 10);
          const s = parseInt(countdownMatch[3], 10);
          result.countdownSeconds = h * 3600 + m * 60 + s;
          result.isLocked = true;
          result.lockReason = "countdown-timer";
        }
        const hasM3u8 = /src\s*[:=]\s*["']?[^"'\s]*\.m3u8/i.test(html) || /(?:file|source|manifest|streamUrl)\s*[:=]\s*["']?[^"'\s]*\.m3u8/i.test(html) || /https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?/i.test(html);
        const pageTextContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const hasInProgressText = /\bIN\s*PROGRESS\b|\b2ND\s*QUARTER\b|\b1ST\s*QUARTER\b|\b3RD\s*QUARTER\b|\b4TH\s*QUARTER\b|\b1ST\s*HALF\b|\b2ND\s*HALF\b|\bHALFTIME\b|\bOVERTIME\b/i.test(
          pageTextContent
        );
        const hasLiveScore = /<span[^>]*class=["'][^"']*score[^"']*["'][^>]*>\s*\d+\s*<\/span>/i.test(html);
        if (hasM3u8 || hasInProgressText && hasLiveScore) {
          result.hasActiveStream = true;
          result.isLive = true;
          result.isLocked = false;
          result.lockReason = "early-broadcast";
        }
        this.setDeepProbeCache(probeId, result);
        return result;
      } catch (err) {
        console.warn(
          `[BuffStreams] Deep probe failed for ${probeId}:`,
          err?.message || err
        );
        return {
          canonicalEventDate: "",
          eventStartUtcMs: 0,
          countdownSeconds: -1,
          hasActiveStream: false,
          isLive: false,
          isLocked: false,
          lockReason: "probe-error"
        };
      } finally {
        this.probeInFlight.delete(probeId);
      }
    })();
    this.probeInFlight.set(probeId, promise);
    return promise;
  }
  async batchDeepProbe(streams) {
    const targets = streams.filter((s) => s?.url && !this.getDeepProbeCache(s.url));
    if (!targets.length)
      return streams;
    for (let i = 0; i < targets.length; i += this.DEEP_PROBE_CONCURRENCY) {
      const batch = targets.slice(i, i + this.DEEP_PROBE_CONCURRENCY);
      await Promise.allSettled(batch.map((s) => this.deepProbeStream(s.url)));
    }
    return streams.map((stream) => {
      const probe = this.getDeepProbeCache(stream.url);
      if (!probe)
        return stream;
      const enriched = { ...stream };
      if (probe.canonicalEventDate)
        enriched.canonicalEventDate = probe.canonicalEventDate;
      if (Number.isFinite(probe.eventStartUtcMs) && probe.eventStartUtcMs > 0)
        enriched.eventStartUtcMs = probe.eventStartUtcMs;
      if (Number.isFinite(probe.countdownSeconds) && probe.countdownSeconds >= 0) {
        enriched.countdownSeconds = probe.countdownSeconds;
      }
      if (probe.hasActiveStream) {
        enriched.hasActiveStream = true;
        enriched.isLive = true;
        enriched.isLocked = false;
      }
      if (probe.isLocked && probe.lockReason === "countdown-timer") {
        enriched.isLocked = true;
        enriched.lockReason = probe.lockReason;
      }
      return enriched;
    });
  }
  async search(query, options) {
    try {
      const raw = String(query || "").trim().toLowerCase();
      let streams;
      if (!raw || raw === "all") {
        streams = await this.fetchAllStreams();
      } else {
        const b = this.baseUrl;
        const categoryKey = raw.replace(/^category:/, "");
        const catPages = this.getAllCategoryPages(b);
        const urls = [];
        if (categoryKey === "fighting") {
          urls.push(catPages.boxing, catPages.mma);
        } else if (catPages[categoryKey]) {
          urls.push(catPages[categoryKey]);
        }
        urls.push(`${b}/index7`, `${b}/index18`);
        const results = await Promise.allSettled(
          urls.map((url) => this.fetchCategoryStreams(url))
        );
        streams = this.mergeStreams(
          results.filter((r) => r.status === "fulfilled").map((r) => r.value)
        );
        if (categoryKey === "fighting") {
          streams = streams.filter(
            (s) => /\/(?:boxing|mma|ufc|pfl|wwe)\b|title-game\/(?:boxing|mma|ufc|pfl|wwe)|\b(?:boxing|mma|ufc|pfl|wwe|bkfc|bellator|one fight|fighting championship)\b/i.test(
              `${s.url || ""} ${s.title || ""} ${s.sectionTitle || ""}`
            )
          );
        } else if (raw && raw.startsWith("category:")) {
          streams = streams.filter(
            (s) => String(s.type || "").toLowerCase() === categoryKey || `${s.url || ""} ${s.title || ""} ${s.sectionTitle || ""}`.toLowerCase().includes(categoryKey)
          );
        } else if (raw) {
          streams = streams.filter(
            (s) => `${s.title} ${s.statusText || ""} ${s.type} ${s.sectionTitle || ""}`.toLowerCase().includes(raw)
          );
        }
      }
      if (!streams.length && import_domain_resolver.BaseUrlResolver.getProbeBackoff() < 3) {
        const newDomain = await import_domain_resolver.BaseUrlResolver.forceProbe();
        if (newDomain && (!raw || raw === "all")) {
          streams = await this.fetchAllStreams();
        }
      }
      const toProbe = streams.filter((stream) => stream?.isLive || /in progress|live|started/i.test(`${stream?.title || ""} ${stream?.statusText || ""}`)).slice(0, 2);
      if (toProbe.length) {
        streams = await this.batchDeepProbe(streams);
      }
      return this.fillSiblingScheduleData(streams);
    } catch (error) {
      console.error("Error in BuffStreams search:", error);
      return [];
    }
  }
  async fetchMediaInfo(mediaId) {
    const url = this.toAbsoluteUrl(mediaId) || mediaId;
    try {
      const rawHtml = await this.fetchRawHtml(url, this.homeUrl, {
        maxBytes: 700 * 1024,
        stopWhen: (text) => /<\/html>/i.test(text)
      });
      const html = this.stripUnneededHtml(rawHtml);
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch?.[1]?.replace(/\s*-\s*Buffstreams\s*$/i, "").trim() || "BuffStreams Event";
      const embedUrl = this.extractEmbedUrl(html, url);
      let canonicalEventDate = "";
      const dateText = html.match(/<img[^>]+>\s*<span[^>]*>(\d{4}-\d{2}-\d{2})<\/span>/i) || html.match(
        /<[^>]*class=["'][^"']*date[^"']*["'][^>]*>([^<]*\d{4}-\d{2}-\d{2}[^<]*)<\/[^>]*>/i
      ) || html.match(/>(\d{4}-\d{2}-\d{2})</i);
      if (dateText?.[1])
        canonicalEventDate = dateText[1].trim();
      let eventStartUtcMs = 0;
      const epochMatch = html.match(/var\s+countDownDate\s*=\s*(\d{10,13})\s*\*\s*1000/i) || html.match(
        /(?:countDownDate|countdownTarget|eventStart|startAt|startTime|eventStartUtc)["']?\s*[:=]\s*["']?(\d{10,13})\b/i
      ) || html.match(
        /(?:countDownDate|countdownTarget|eventStart|startAt|startTime|eventStartUtc)["']?\s*[:=]\s*["']?(\d{10,13})\s*\*\s*1000/i
      );
      if (epochMatch?.[1]) {
        const rawTs = parseInt(epochMatch[1], 10);
        const tsMs = rawTs < 1e12 ? rawTs * 1e3 : rawTs;
        const diffMs = tsMs - Date.now();
        if (diffMs > 0 && diffMs < 7 * 24 * 60 * 60 * 1e3) {
          eventStartUtcMs = tsMs;
        }
      }
      let countdownSeconds = -1;
      let lockReason = "";
      if (eventStartUtcMs > 0) {
        countdownSeconds = Math.floor((eventStartUtcMs - Date.now()) / 1e3);
        lockReason = "countdown-timer";
      }
      const countdownFromScripts = eventStartUtcMs > 0 ? null : this.extractCountdownFromScripts(rawHtml);
      const countdownMatch = eventStartUtcMs > 0 ? null : countdownFromScripts ? [
        "",
        String(countdownFromScripts.h),
        String(countdownFromScripts.m),
        String(countdownFromScripts.s)
      ] : html.match(/\b(\d{2}):(\d{2}):(\d{2})\b/);
      if (countdownMatch) {
        countdownSeconds = parseInt(countdownMatch[1], 10) * 3600 + parseInt(countdownMatch[2], 10) * 60 + parseInt(countdownMatch[3], 10);
        lockReason = "countdown-timer";
      }
      const hasM3u8InPage = /src\s*[:=]\s*["']?[^"'\s]*\.m3u8/i.test(html) || /(?:file|source|manifest|streamUrl)\s*[:=]\s*["']?[^"'\s]*\.m3u8/i.test(html) || /https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?/i.test(html);
      const pageTextCheck = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const hasInProgressCheck = /\bIN\s*PROGRESS\b|\b2ND\s*QUARTER\b|\b1ST\s*QUARTER\b|\b3RD\s*QUARTER\b|\b4TH\s*QUARTER\b|\b1ST\s*HALF\b|\b2ND\s*HALF\b|\bHALFTIME\b|\bOVERTIME\b/i.test(
        pageTextCheck
      );
      const hasLiveScoreCheck = /<span[^>]*class=["'][^"']*score[^"']*["'][^>]*>\s*\d+\s*<\/span>/i.test(html);
      const hasActiveStream = hasM3u8InPage || hasInProgressCheck && hasLiveScoreCheck;
      if (hasActiveStream)
        lockReason = "early-broadcast";
      const liveState = this.extractLiveState(title, "", html);
      return {
        id: url,
        title,
        url,
        embedUrl: embedUrl || void 0,
        sport: this.inferType(url, title),
        eventDate: canonicalEventDate || void 0,
        eventStartUtcMs: eventStartUtcMs || void 0,
        status: liveState.periodText || (hasActiveStream ? "LIVE" : "UPCOMING"),
        teams: [],
        scores: [],
        awayScore: null,
        homeScore: null
      };
    } catch (error) {
      console.error("Error in BuffStreams fetchMediaInfo:", error);
      throw error;
    }
  }
  async fetchEpisodeSources(episodeId) {
    const pageUrl = this.toAbsoluteUrl(episodeId) || episodeId;
    try {
      const html = await this.fetchLeanHtml(pageUrl, this.homeUrl, {
        maxBytes: 700 * 1024,
        stopWhen: (text) => /<\/html>/i.test(text) || /<iframe[^>]+src=["'][^"']+["']/i.test(text)
      });
      const embedUrl = this.extractEmbedUrl(html, pageUrl);
      const candidateUrls = this.collectEmbedCandidates(html, pageUrl);
      if (embedUrl)
        candidateUrls.unshift(embedUrl);
      const uniqueCandidates = [
        ...new Set(
          candidateUrls.map((candidate) => this.toAbsoluteUrl(candidate, pageUrl) || "").filter(Boolean)
        )
      ];
      const gatheredSources = [];
      for (const candidate of uniqueCandidates) {
        const embedHtml = await this.fetchLeanHtml(candidate, pageUrl, {
          maxBytes: 384 * 1024,
          stopWhen: (text) => /(?:window\.atob|source\s*:|\.m3u8|load-playlist|\/playlist\/)/i.test(text)
        }).catch(() => "");
        const directSources = this.extractSourcesFromEmbedHtml(
          embedHtml,
          candidate,
          pageUrl
        );
        for (const source of directSources) {
          gatheredSources.push(source);
        }
      }
      if (!gatheredSources.length && embedUrl) {
        const playwrightSources = await (0, import_browserRuntimeExtractor.extractDirectSourcesWithPlaywright)(
          embedUrl,
          pageUrl,
          12e3
        ).catch(() => []);
        for (const source of playwrightSources) {
          if (!source?.url)
            continue;
          gatheredSources.push({
            url: source.url,
            quality: source.quality || "auto",
            isM3U8: Boolean(source.isM3U8),
            isDirect: true
          });
        }
      }
      const deduped = this.dedupeSources(gatheredSources);
      if (!deduped.length)
        return { sources: [], headers: {}, embedUrl };
      return {
        sources: deduped,
        headers: this.buildHeaders(pageUrl),
        embedUrl
      };
    } catch (error) {
      console.error("Error in BuffStreams fetchEpisodeSources:", error);
      return { sources: [], headers: {} };
    }
  }
  async fetchEpisodeServers(_) {
    return [];
  }
  collectEmbedCandidates(html, pageUrl) {
    const source = String(html || "");
    const candidates = [];
    const push = (value) => {
      const raw = String(value || "").trim();
      if (!raw || candidates.includes(raw))
        return;
      candidates.push(raw);
    };
    const patterns = [
      /<iframe[^>]+id=["']cx-iframe["'][^>]+src=["']([^"']+)["']/i,
      /<iframe[^>]+data-src=["']([^"']+)["'][^>]*>/i,
      /<iframe[^>]+src=["']([^"']+)["'][^>]*>/i,
      /data-iframe=["']([^"']+)["']/i,
      /src=["']([^"']+(?:embed|iframe|player|server)[^"']*)["']/i,
      /src\s*:\s*["']([^"']+)["']/i,
      /source\s*:\s*["']([^"']+)["']/i,
      /file\s*:\s*["']([^"']+)["']/i,
      /url\s*:\s*["']([^"']+)["']/i,
      /iframe\s*:\s*["']([^"']+)["']/i,
      /['"](https?:\/\/[^'"\s>]+(?:embed|iframe|player|playlist|load-playlist|server|source)[^'"\s>]*)['"]/i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1])
        push(match[1]);
    }
    for (const match of source.matchAll(
      /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    )) {
      const href = String(match[1] || "");
      const linkText = String(match[2] || "").toLowerCase();
      if (/server|source|play|stream|watch|embed/i.test(href) || /server|source|play|stream/i.test(linkText)) {
        push(href);
      }
    }
    return candidates.map((candidate) => this.toAbsoluteUrl(candidate, pageUrl) || candidate).filter(Boolean);
  }
  extractSourcesFromEmbedHtml(html, candidateUrl, pageUrl) {
    const source = String(html || "");
    const headers = this.buildHeaders(candidateUrl || pageUrl);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (url, quality = "auto") => {
      const clean = String(url || "").trim();
      if (!clean || seen.has(clean))
        return;
      seen.add(clean);
      out.push({
        url: clean,
        quality,
        isM3U8: /\.m3u8(\?|$)/i.test(clean) || /\/m3u8-proxy\?/i.test(clean) || /\/playlist\//i.test(clean),
        isDirect: true,
        headers
      });
    };
    for (const match of source.matchAll(
      /https?:\/\/[^'"\s]+(?:load-playlist|\.m3u8|\/playlist\/[^'"\s]*)/gi
    )) {
      push(match[0], "auto");
    }
    for (const match of source.matchAll(/['"](https?:\/\/[^'"]+)['"]/gi)) {
      if (/load-playlist|\.m3u8|\/playlist\//i.test(match[1]))
        push(match[1], "auto");
    }
    const directAtobMatch = source.match(
      /source\s*:\s*window\.atob\(\s*['"]([^'"]+)['"]\s*\)/i
    );
    if (directAtobMatch?.[1]) {
      try {
        const decoded = Buffer.from(String(directAtobMatch[1]).trim(), "base64").toString("utf8").trim();
        if (/^https?:\/\//i.test(decoded))
          push(decoded, "auto");
      } catch {
      }
    }
    for (const match of source.matchAll(/window\.atob\(\s*['"]([^'"]+)['"]\s*\)/gi)) {
      try {
        const decoded = Buffer.from(String(match[1]).trim(), "base64").toString("utf8").trim();
        if (/^https?:\/\//i.test(decoded))
          push(decoded, "auto");
      } catch {
      }
    }
    return out;
  }
  dedupeSources(sources) {
    const seen = /* @__PURE__ */ new Set();
    return sources.filter((source) => {
      const key = String(source?.url || "").trim();
      if (!key || seen.has(key))
        return false;
      seen.add(key);
      return true;
    });
  }
  extractEmbedUrl(html, pageUrl) {
    const source = String(html || "");
    const candidates = [];
    const push = (value) => {
      const raw = String(value || "").trim();
      if (!raw || candidates.includes(raw))
        return;
      candidates.push(raw);
    };
    const iframePatterns = [
      /<iframe[^>]+id=["']cx-iframe["'][^>]+src=["']([^"']+)["']/i,
      /<iframe[^>]+data-src=["']([^"']+)["'][^>]*>/i,
      /<iframe[^>]+src=["']([^"']+)["'][^>]*>/i,
      /data-iframe=["']([^"']+)["']/i,
      /src=["']([^"']+(?:embed|iframe|player)[^"']*)["']/i
    ];
    for (const pattern of iframePatterns) {
      const match = source.match(pattern);
      if (match?.[1])
        push(match[1]);
    }
    const scriptUrlPatterns = [
      /window\.location\s*=\s*["']([^"']+)["']/i,
      /src\s*:\s*["']([^"']+)["']/i,
      /source\s*:\s*["']([^"']+)["']/i,
      /file\s*:\s*["']([^"']+)["']/i,
      /url\s*:\s*["']([^"']+)["']/i,
      /iframe\s*:\s*["']([^"']+)["']/i,
      /['"](https?:\/\/[^'"\s>]+(?:embed|playlist|m3u8|load-playlist)[^'"\s>]*)['"]/i
    ];
    for (const pattern of scriptUrlPatterns) {
      const match = source.match(pattern);
      if (match?.[1])
        push(match[1]);
    }
    for (const candidate of candidates) {
      const resolved = this.toAbsoluteUrl(candidate, pageUrl);
      if (resolved && /^https?:\/\//i.test(resolved))
        return resolved;
    }
    return null;
  }
  extractHlsFromEmbed(html) {
    const decodeIfUrl = (value) => {
      try {
        const decoded = Buffer.from(String(value || "").trim(), "base64").toString("utf8").trim();
        if (/^https?:\/\//i.test(decoded))
          return decoded;
      } catch {
      }
      return null;
    };
    const directAtobMatch = html.match(
      /source\s*:\s*window\.atob\(\s*['"]([^'"]+)['"]\s*\)/i
    );
    if (directAtobMatch?.[1]) {
      const decoded = decodeIfUrl(directAtobMatch[1]);
      if (decoded)
        return decoded;
    }
    for (const match of html.matchAll(/window\.atob\(\s*['"]([^'"]+)['"]\s*\)/gi)) {
      const decoded = decodeIfUrl(match[1]);
      if (decoded)
        return decoded;
    }
    const directSourceMatch = html.match(/source\s*:\s*['"]([^'"]+)['"]/i);
    if (directSourceMatch?.[1] && /^https?:\/\//i.test(directSourceMatch[1]))
      return directSourceMatch[1];
    const playlistMatch = html.match(
      /https?:\/\/[^'"\s]+(?:load-playlist|\.m3u8|\/playlist\/[^'"\s]+)/i
    );
    if (playlistMatch?.[0])
      return playlistMatch[0];
    for (const match of html.matchAll(/['"](https?:\/\/[^'"]+)['"]/gi)) {
      if (/load-playlist|\.m3u8|\/playlist\//i.test(match[1]))
        return match[1];
    }
    return null;
  }
}
var buffstreams_default = BuffStreams;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BuffStreams
});
