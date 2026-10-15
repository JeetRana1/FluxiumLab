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
var anilist_exports = {};
__export(anilist_exports, {
  default: () => anilist_default
});
module.exports = __toCommonJS(anilist_exports);
var import_models = require("@consumet/extensions/dist/models");
var import_anilist = __toESM(require("@consumet/extensions/dist/providers/meta/anilist"));
var import_mal = __toESM(require("@consumet/extensions/dist/providers/meta/mal"));
var import_models2 = require("@consumet/extensions/dist/models");
var import_cache = __toESM(require("../../utils/cache"));
var import_main = require("../../main");
var import_animesama = __toESM(require("@consumet/extensions/dist/providers/anime/animesama"));
var import_streamable = require("../../utils/streamable");
var import_provider = require("../../utils/provider");
const routes = async (fastify, options) => {
  fastify.get("/", (_, rp) => {
    rp.status(200).send({
      intro: "Welcome to the anilist provider: check out the provider's website @ https://anilist.co/",
      routes: ["/:query", "/info/:id", "/watch/:episodeId"],
      documentation: "https://docs.consumet.org/#tag/anilist"
    });
  });
  fastify.get("/:query", async (request, reply) => {
    const query = request.params.query;
    const page = Number(request.query.page) || 1;
    const perPage = Number(request.query.perPage) || 15;
    try {
      let res = null;
      try {
        const anilist = generateAnilistMeta();
        res = await anilist.search(query, page, perPage);
      } catch (err) {
        console.warn(
          "[Anilist] GraphQL search failed, trying fallbacks:",
          err?.message || err
        );
        res = null;
      }
      if (res && Array.isArray(res.results) && res.results.length > 0) {
        reply.status(200).send(res);
        return;
      }
      try {
        const malRows = await searchMyanimelist(query, 5);
        if (malRows.length > 0) {
          reply.status(200).send({
            currentPage: page,
            hasNextPage: false,
            totalPages: 1,
            totalResults: malRows.length,
            results: malRows
          });
          return;
        }
      } catch (err) {
        console.warn("[Anilist] MAL fallback search failed:", err?.message || err);
      }
      try {
        const fallbackRes = await request.server.inject({
          method: "GET",
          url: `/anime/animesalt/${encodeURIComponent(query)}`
        });
        if (fallbackRes.statusCode === 200) {
          let fallbackRows = [];
          try {
            fallbackRows = JSON.parse(fallbackRes.body || "[]");
          } catch {
            fallbackRows = [];
          }
          if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
            const mapped = fallbackRows.slice(0, perPage).map((row) => {
              const title = String(row?.title || "").trim();
              return {
                id: String(row?.id || ""),
                malId: null,
                title: {
                  romaji: title,
                  english: title,
                  native: title,
                  userPreferred: title
                },
                image: row?.image || null,
                cover: null,
                description: null,
                status: null,
                rating: null,
                genres: [],
                totalEpisodes: null,
                currentEpisodeCount: null,
                type: row?.type || "tv",
                releaseDate: null,
                year: null,
                startDate: null
              };
            });
            reply.status(200).send({
              currentPage: page,
              hasNextPage: false,
              totalPages: 1,
              totalResults: mapped.length,
              results: mapped
            });
            return;
          }
        }
      } catch (err) {
        console.warn(
          "[Anilist] AnimeSalt fallback search failed:",
          err?.message || err
        );
      }
      reply.status(200).send({ results: [], message: "No results found" });
    } catch (err) {
      console.error("[Anilist] Search error:", err?.message || err);
      reply.status(200).send({ results: [], message: err?.message || "Search failed" });
    }
  });
  fastify.get(
    "/advanced-search",
    async (request, reply) => {
      const query = request.query.query;
      const page = request.query.page;
      const perPage = request.query.perPage;
      const type = request.query.type;
      let genres = request.query.genres;
      const id = request.query.id;
      const format = request.query.format;
      let sort = request.query.sort;
      const status = request.query.status;
      const year = request.query.year;
      const season = request.query.season;
      const countryOfOrigin = request.query.countryOfOrigin;
      const anilist = generateAnilistMeta();
      if (genres) {
        try {
          const parsedGenres = JSON.parse(genres);
          parsedGenres.forEach((genre) => {
            if (!Object.values(import_models.Genres).includes(genre)) {
            }
          });
          genres = parsedGenres;
        } catch {
          genres = void 0;
        }
      }
      if (sort) {
        try {
          sort = JSON.parse(sort);
        } catch {
          sort = void 0;
        }
      }
      if (season) {
        if (!["WINTER", "SPRING", "SUMMER", "FALL"].includes(season))
          return reply.status(400).send({ message: `${season} is not a valid season` });
      }
      const res = await anilist.advancedSearch(
        query,
        type,
        page,
        perPage,
        format,
        sort,
        genres,
        id,
        year,
        status,
        season,
        countryOfOrigin
      );
      reply.status(200).send(res);
    }
  );
  fastify.get("/trending", async (request, reply) => {
    const page = request.query.page;
    const perPage = request.query.perPage;
    const anilist = generateAnilistMeta();
    import_main.redis ? reply.status(200).send(
      await import_cache.default.fetch(
        import_main.redis,
        `anilist:trending;${page};${perPage}`,
        async () => await anilist.fetchTrendingAnime(page, perPage),
        60 * 60
      )
    ) : reply.status(200).send(await anilist.fetchTrendingAnime(page, perPage));
  });
  fastify.get("/popular", async (request, reply) => {
    const page = request.query.page;
    const perPage = request.query.perPage;
    const anilist = generateAnilistMeta();
    import_main.redis ? reply.status(200).send(
      await import_cache.default.fetch(
        import_main.redis,
        `anilist:popular;${page};${perPage}`,
        async () => await anilist.fetchPopularAnime(page, perPage),
        60 * 60
      )
    ) : reply.status(200).send(await anilist.fetchPopularAnime(page, perPage));
  });
  fastify.get(
    "/airing-schedule",
    async (request, reply) => {
      const page = request.query.page;
      const perPage = request.query.perPage;
      const weekStart = request.query.weekStart;
      const weekEnd = request.query.weekEnd;
      const notYetAired = request.query.notYetAired;
      const anilist = generateAnilistMeta();
      const _weekStart = Math.ceil(Date.now() / 1e3);
      const res = await anilist.fetchAiringSchedule(
        page ?? 1,
        perPage ?? 20,
        weekStart ?? _weekStart,
        weekEnd ?? _weekStart + 604800,
        notYetAired ?? true
      );
      reply.status(200).send(res);
    }
  );
  fastify.get("/genre", async (request, reply) => {
    const genres = request.query.genres;
    const page = request.query.page;
    const perPage = request.query.perPage;
    const anilist = generateAnilistMeta();
    if (typeof genres === "undefined")
      return reply.status(400).send({ message: "genres is required" });
    try {
      const parsedGenres = JSON.parse(genres);
      const res = await anilist.fetchAnimeGenres(parsedGenres, page, perPage);
      reply.status(200).send(res);
    } catch (err) {
      reply.status(400).send({ message: "Invalid genres data" });
    }
  });
  fastify.get(
    "/recent-episodes",
    async (request, reply) => {
      const provider = request.query.provider;
      const page = request.query.page;
      const perPage = request.query.perPage;
      const anilist = generateAnilistMeta(provider);
      const res = await anilist.fetchRecentEpisodes(provider, page, perPage);
      reply.status(200).send(res);
    }
  );
  fastify.get("/random-anime", async (request, reply) => {
    const anilist = generateAnilistMeta();
    const res = await anilist.fetchRandomAnime().catch(() => {
      return reply.status(404).send({ message: "Anime not found" });
    });
    reply.status(200).send(res);
  });
  fastify.get("/servers/:id", async (request, reply) => {
    const id = request.params.id;
    const provider = request.query.provider;
    let anilist = generateAnilistMeta(provider);
    const res = await anilist.fetchEpisodeServers(id);
    reply.status(200).send(res);
  });
  fastify.get("/episodes/:id", async (request, reply) => {
    const today = /* @__PURE__ */ new Date();
    const dayOfWeek = today.getDay();
    const id = request.params.id;
    const provider = request.query.provider;
    let fetchFiller = request.query.fetchFiller;
    let dub = request.query.dub;
    let anilist = generateAnilistMeta(provider);
    dub = dub === "true" || dub === "1";
    fetchFiller = fetchFiller === "true" || fetchFiller === "1";
    try {
      if (import_main.redis) {
        const data = await import_cache.default.fetch(
          import_main.redis,
          `anilist:episodes;${id};${dub};${fetchFiller};${anilist.provider.name.toLowerCase()}`,
          async () => anilist.fetchEpisodesListById(id, dub, fetchFiller),
          dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : 60 * 60 / 2
        );
        reply.status(200).send(data);
      } else {
        const data = await anilist.fetchEpisodesListById(
          id,
          dub,
          fetchFiller
        );
        reply.status(200).send(data);
      }
    } catch (err) {
      return reply.status(404).send({ message: "Anime not found" });
    }
  });
  fastify.get("/data/:id", async (request, reply) => {
    const id = request.params.id;
    const anilist = generateAnilistMeta();
    const res = await anilist.fetchAnilistInfoById(id);
    reply.status(200).send(res);
  });
  fastify.get("/info/:id", async (request, reply) => {
    const id = request.params.id;
    const today = /* @__PURE__ */ new Date();
    const dayOfWeek = today.getDay();
    const provider = request.query.provider;
    let fetchFiller = request.query.fetchFiller;
    let isDub = request.query.dub;
    let anilist = generateAnilistMeta(provider);
    isDub = isDub === "true" || isDub === "1";
    fetchFiller = fetchFiller === "true" || fetchFiller === "1";
    try {
      if (import_main.redis) {
        const data = await import_cache.default.fetch(
          import_main.redis,
          `anilist:info;${id};${isDub};${fetchFiller};${anilist.provider.name.toLowerCase()}`,
          async () => anilist.fetchAnimeInfo(id, isDub, fetchFiller),
          dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : 60 * 60 / 2
        );
        reply.status(200).send(data);
      } else {
        const data = await anilist.fetchAnimeInfo(
          id,
          isDub,
          fetchFiller
        );
        reply.status(200).send(data);
      }
    } catch (err) {
      reply.status(500).send({ message: err.message });
    }
  });
  fastify.get("/character/:id", async (request, reply) => {
    const id = request.params.id;
    const anilist = generateAnilistMeta();
    const res = await anilist.fetchCharacterInfoById(id);
    reply.status(200).send(res);
  });
  fastify.get(
    "/watch/:episodeId",
    async (request, reply) => {
      const episodeId = request.params.episodeId;
      const provider = request.query.provider;
      const server = request.query.server;
      let isDub = request.query.dub;
      if (server && !Object.values(import_models2.StreamingServers).includes(server))
        return reply.status(400).send("Invalid server");
      isDub = isDub === "true" || isDub === "1";
      let anilist = generateAnilistMeta(provider);
      try {
        const fetchSources = async (selectedServer) => {
          return provider === "zoro" ? await anilist.fetchEpisodeSources(
            episodeId,
            selectedServer,
            isDub ? import_models.SubOrSub.DUB : import_models.SubOrSub.SUB
          ) : await anilist.fetchEpisodeSources(episodeId, selectedServer);
        };
        if (import_main.redis) {
          const data = await import_cache.default.fetch(
            import_main.redis,
            `anilist:watch;${episodeId};${anilist.provider.name.toLowerCase()};${server};${isDub ? "dub" : "sub"}`,
            async () => await (0, import_streamable.fetchWithServerFallback)(fetchSources, server),
            600
          );
          reply.status(200).send(data);
        } else {
          const data = await (0, import_streamable.fetchWithServerFallback)(fetchSources, server);
          reply.status(200).send(data);
        }
      } catch (err) {
        reply.status(500).send({ message: "Something went wrong." });
      }
    }
  );
  fastify.get("/staff/:id", async (request, reply) => {
    const id = request.params.id;
    const anilist = generateAnilistMeta();
    try {
      if (import_main.redis) {
        const data = await import_cache.default.fetch(
          import_main.redis,
          `anilist:staff;${id}`,
          async () => await anilist.fetchStaffById(Number(id)),
          60 * 60
        );
        reply.status(200).send(data);
      } else {
        const data = await anilist.fetchStaffById(Number(id));
        reply.status(200).send(data);
      }
    } catch (err) {
      reply.status(404).send({ message: err.message });
    }
  });
  fastify.get("/favorites", async (request, reply) => {
    const type = request.query.type;
    const headers = request.headers;
    if (!headers.authorization) {
      return reply.status(401).send({ message: "Authorization header is required" });
    }
    const anilist = generateAnilistMeta();
    try {
      const res = await anilist.fetchFavoriteList(headers.authorization, type);
      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({ message: err.message });
    }
  });
};
class BrowserAnilist extends import_anilist.default {
  configureBrowserHeaders() {
    this.client.interceptors.request.use((config) => {
      if (String(config.url || "").includes("graphql.anilist.co")) {
        config.headers = config.headers || {};
        config.headers["Referer"] = "https://anilist.co/";
        config.headers["Origin"] = "https://anilist.co";
        config.headers["Accept"] = "application/json, text/plain, */*";
        config.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      }
      return config;
    });
  }
}
const generateAnilistMeta = (provider = void 0) => {
  const anilist = new BrowserAnilist((0, import_provider.configureProvider)(new import_animesama.default()));
  anilist.configureBrowserHeaders();
  return anilist;
};
const searchMyanimelist = async (query, limit = 5) => {
  const mal = new import_mal.default();
  const searchRes = await mal.search(query, 1);
  const rows = Array.isArray(searchRes?.results) ? searchRes.results : [];
  const top = rows.slice(0, limit);
  if (top.length === 0)
    return [];
  const enriched = await Promise.all(
    top.map(async (row) => {
      let info = null;
      try {
        info = await mal.fetchMalInfoById(row.id);
      } catch {
        info = null;
      }
      return { row, info };
    })
  );
  return enriched.map(({ row, info }) => {
    const title = info?.title || {};
    const romaji = title.romaji || String(row.title || "");
    const english = title.english || title.userPreferred || String(row.title || "");
    const native = title.native || english;
    const year = Number.isFinite(info?.startDate?.year) ? info.startDate.year : null;
    const totalEpisodes = row?.totalEpisodes ?? info?.totalEpisodes ?? null;
    return {
      id: String(row.id || ""),
      malId: row.id ? Number(row.id) : null,
      title: { romaji, english, native, userPreferred: english || romaji },
      image: row?.image || info?.image || null,
      cover: info?.image || null,
      description: info?.description || row?.description || null,
      status: info?.status ?? null,
      rating: row?.rating ?? info?.rating ?? null,
      genres: Array.isArray(info?.genres) ? info.genres : [],
      totalEpisodes,
      currentEpisodeCount: totalEpisodes,
      type: row?.type || info?.type || "tv",
      releaseDate: year != null ? String(year) : null,
      year,
      startDate: info?.startDate || null
    };
  });
};
var anilist_default = routes;
