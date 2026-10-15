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
var domain_resolver_exports = {};
__export(domain_resolver_exports, {
  BaseUrlResolver: () => BaseUrlResolver
});
module.exports = __toCommonJS(domain_resolver_exports);
const KNOWN_DOMAINS = [
  "https://mybuffstreams.plus",
  ...process.env.BUFFSTREAMS_BASE_URL ? [process.env.BUFFSTREAMS_BASE_URL.replace(/\/+$/, "")] : [],
  "https://buffstreams.ir"
];
let cachedUrl = KNOWN_DOMAINS[0];
let lastProbeMs = 0;
const PROBE_TTL_MS = 2 * 60 * 1e3;
let probing = null;
let probeBackoff = 0;
async function probeDomain(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6e3);
    const res = await fetch(`${url}/index7`, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      }
    });
    clearTimeout(timeout);
    return res.ok || res.status === 403 || res.status === 429;
  } catch {
    return false;
  }
}
async function probeAll() {
  for (const domain of KNOWN_DOMAINS) {
    if (await probeDomain(domain)) {
      return domain;
    }
  }
  return KNOWN_DOMAINS[0];
}
function startProbe() {
  if (probing)
    return;
  if (Date.now() - lastProbeMs < PROBE_TTL_MS)
    return;
  probing = probeAll().then((url) => {
    cachedUrl = url;
    lastProbeMs = Date.now();
    probeBackoff = 0;
    probing = null;
  }).catch(() => {
    probeBackoff = Math.min(probeBackoff + 1, 4);
    probing = null;
  });
}
startProbe();
const BaseUrlResolver = {
  getBaseUrl() {
    return cachedUrl || KNOWN_DOMAINS[0];
  },
  async forceProbe() {
    const url = await probeAll();
    cachedUrl = url;
    lastProbeMs = Date.now();
    probeBackoff = 0;
    probing = null;
    return url;
  },
  getProbeBackoff() {
    return probeBackoff;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BaseUrlResolver
});
