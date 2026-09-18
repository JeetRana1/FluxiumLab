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
var mangak_exports = {};
__export(mangak_exports, {
  default: () => mangak_default
});
module.exports = __toCommonJS(mangak_exports);
var import_mangakProvider = require("../../providers/custom/mangakProvider");
const routes = async (fastify, _options) => {
  fastify.get("/search/:query", async (request, reply) => {
    try {
      const result = await import_mangakProvider.MangakProvider.search(request.params.query, Number(request.query?.page) || 1, Number(request.query?.limit) || 20);
      return reply.send(result);
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
  fastify.get("/browse", async (request, reply) => {
    try {
      const result = await import_mangakProvider.MangakProvider.browse({
        sort: request.query?.sort,
        genres: request.query?.genres,
        page: Number(request.query?.page) || 1,
        limit: Number(request.query?.limit) || 21
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
  fastify.get("/genres", async (request, reply) => {
    try {
      const result = await import_mangakProvider.MangakProvider.genres(Number(request.query?.limit) || 100);
      return reply.send(result);
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
  fastify.get("/info/:id", async (request, reply) => {
    try {
      const result = await import_mangakProvider.MangakProvider.info(request.params.id);
      return result ? reply.send(result) : reply.status(404).send({ message: "Manga not found" });
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
  fastify.get("/chapters/:id", async (request, reply) => {
    try {
      return reply.send({ chapters: await import_mangakProvider.MangakProvider.chapters(request.params.id) });
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
  fastify.get("/chapter-images/:slug/:chapterSlug", async (request, reply) => {
    try {
      const result = await import_mangakProvider.MangakProvider.chapterImages(request.params.slug, request.params.chapterSlug);
      return result ? reply.send(result) : reply.status(404).send({ message: "Chapter images not found" });
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
  fastify.get("/chapter/:id/:slug/:number", async (request, reply) => {
    try {
      const result = await import_mangakProvider.MangakProvider.chapter(request.params.id, request.params.slug, Number(request.params.number));
      return result ? reply.send(result) : reply.status(404).send({ message: "Chapter not found" });
    } catch (error) {
      return reply.status(502).send({ message: error.message });
    }
  });
};
var mangak_default = routes;
