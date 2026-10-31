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
var play4u_exports = {};
__export(play4u_exports, {
  default: () => play4u_default
});
module.exports = __toCommonJS(play4u_exports);
var import_play4uProvider = require("../../providers/custom/play4uProvider");
const routes = async (fastify, _options) => {
  fastify.get("/", (_, reply) => reply.send({ intro: "Play4u provider", routes: ["/search", "/info", "/watch"] }));
  fastify.get("/search", async (request, reply) => {
    const { query, page } = request.query;
    if (!query)
      return reply.code(400).send({ error: "query is required" });
    return reply.send(await import_play4uProvider.Play4uProvider.search(query, page || 1));
  });
  fastify.get("/info", async (request, reply) => {
    const { id, type } = request.query;
    if (!id)
      return reply.code(400).send({ error: "id is required" });
    return reply.send(await import_play4uProvider.Play4uProvider.fetchMediaInfo(id, type || "movie"));
  });
  fastify.get("/watch", async (request, reply) => {
    const { episodeId, server } = request.query;
    if (!episodeId)
      return reply.code(400).send({ error: "episodeId is required" });
    const result = await import_play4uProvider.Play4uProvider.fetchSources(episodeId, server || "play4u");
    if (!result?.sources?.length)
      return reply.code(404).send({ error: "Play4u source not found" });
    return reply.send(result);
  });
};
var play4u_default = routes;
