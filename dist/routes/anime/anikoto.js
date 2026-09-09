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
var anikoto_exports = {};
__export(anikoto_exports, {
  default: () => anikoto_default
});
module.exports = __toCommonJS(anikoto_exports);
var import_extensions = require("@consumet/extensions");
var import_anikotoProvider = require("../../providers/custom/anikotoProvider");
const routes = async (fastify, _options) => {
  const createProvider = () => {
    const instance = new import_extensions.ANIME.AniKoto();
    instance.client.defaults.timeout = 12e3;
    return instance;
  };
  const provider = createProvider();
  const sourceCache = /* @__PURE__ */ new Map();
  const SOURCE_CACHE_TTL_MS = 5 * 60 * 1e3;
  const pending = /* @__PURE__ */ new Map();
  const cachedRequest = async (key, load, valid) => {
    const cached = sourceCache.get(key);
    if (cached && cached.expires > Date.now())
      return cached.value;
    if (pending.has(key))
      return pending.get(key);
    const request = Promise.resolve().then(load).then((value) => {
      if (valid(value)) {
        for (const [id, entry] of sourceCache)
          if (entry.expires <= Date.now())
            sourceCache.delete(id);
        if (sourceCache.size >= 256)
          sourceCache.delete(sourceCache.keys().next().value);
        sourceCache.set(key, { expires: Date.now() + SOURCE_CACHE_TTL_MS, value });
      }
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
  fastify.get(
    "/",
    async (_request, reply) => reply.send({ provider: "anikoto", baseUrl: provider.toString.baseUrl })
  );
  fastify.get("/:query", async (request, reply) => {
    try {
      const query = String(request.params.query).trim();
      const page = Number(request.query?.page || 1);
      if (!query || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 1e3) {
        return reply.status(400).send({ message: "Invalid AniKoto search" });
      }
      return reply.send(
        await cachedRequest(
          `search:${query}:${page}`,
          () => createProvider().search(query, page),
          (value) => value?.results?.length > 0
        )
      );
    } catch (error) {
      return reply.status(502).send({ message: error?.message || "AniKoto search failed" });
    }
  });
  fastify.get("/info", async (request, reply) => {
    try {
      let id = String(request.query?.id || "");
      if (/^https?:\/\//i.test(id)) {
        const url = new URL(id);
        if (url.origin !== "https://anikoto.cz" || url.username || url.password) {
          return reply.status(400).send({ message: "Invalid AniKoto title ID" });
        }
        id = url.pathname.replace(/^\/watch\//, "").replace(/\/ep-\d+\/?$/, "").replace(/\/$/, "");
      }
      if (!/^[a-z0-9][a-z0-9-]{0,199}$/i.test(id))
        return reply.status(400).send({ message: "Invalid AniKoto title ID" });
      return reply.send(
        await cachedRequest(
          `info:${id}`,
          () => createProvider().fetchAnimeInfo(id),
          (value) => value?.episodes?.length > 0
        )
      );
    } catch (error) {
      return reply.status(502).send({ message: error?.message || "AniKoto info failed" });
    }
  });
  fastify.get("/watch/:episodeId", async (request, reply) => {
    try {
      const episodeId = String(request.params.episodeId);
      const server = request.query?.server;
      if (!/^[a-z0-9][a-z0-9-]{0,199}\$episode\$[1-9]\d{0,5}$/i.test(episodeId) || server !== void 0 && (typeof server !== "string" || server.length > 80)) {
        return reply.status(400).send({ message: "Invalid AniKoto episode or server" });
      }
      const cacheKey = `watch:${episodeId}|${server || ""}`;
      const value = await cachedRequest(
        cacheKey,
        async () => {
          let result = null;
          try {
            result = await (0, import_anikotoProvider.fetchCurrentAniKotoSources)(episodeId, server);
          } catch (error) {
            request.log.warn(
              { err: error, episodeId },
              "Current AniKoto extraction failed; using extension provider"
            );
          }
          if (result) {
            return result;
          }
          try {
            result = await createProvider().fetchEpisodeSources(episodeId, server);
          } catch (firstError) {
            request.log.warn(
              { err: firstError, episodeId },
              "AniKoto watch retry with fresh provider"
            );
            result = await createProvider().fetchEpisodeSources(episodeId, server);
          }
          return result;
        },
        (result) => [
          ...result?.sources || [],
          ...result?.sub?.sources || [],
          ...result?.dub?.sources || []
        ].some((source) => source?.url)
      );
      return reply.send(value);
    } catch (error) {
      return reply.status(502).send({ message: error?.message || "AniKoto source extraction failed" });
    }
  });
};
var anikoto_default = routes;
