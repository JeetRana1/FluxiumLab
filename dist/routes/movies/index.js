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
var movies_exports = {};
__export(movies_exports, {
  default: () => movies_default
});
module.exports = __toCommonJS(movies_exports);
var import_extensions = require("@consumet/extensions");
var import_hdstream4u = __toESM(require("./hdstream4u"));
var import_play4u = __toESM(require("./play4u"));
const routes = async (fastify, options) => {
  await fastify.register(import_hdstream4u.default, { prefix: "/hdstream4u" });
  await fastify.register(import_play4u.default, { prefix: "/play4u" });
  fastify.get("/", async (request, reply) => {
    reply.status(200).send("Welcome to Consumet Movies and TV Shows");
  });
  fastify.get("/:movieProvider", async (request, reply) => {
    const queries = {
      movieProvider: "",
      page: 1
    };
    queries.movieProvider = decodeURIComponent(
      request.params.movieProvider
    );
    queries.page = request.query.page;
    if (queries.page < 1)
      queries.page = 1;
    const provider = import_extensions.PROVIDERS_LIST.MOVIES.find(
      (provider2) => provider2.toString.name === queries.movieProvider
    );
    try {
      if (provider) {
        reply.redirect(`/movies/${provider.toString.name}`);
      } else {
        reply.status(404).send({ message: "Page not found, please check the providers list." });
      }
    } catch (err) {
      reply.status(500).send({ message: "Something went wrong. Please try again later." });
    }
  });
  fastify.get("/:id/:title", async (request, reply) => {
    const { id, title } = request.params;
    return reply.redirect(`/meta/tmdb/watch?id=${id}&type=movie&provider=hdstream4u`);
  });
};
var movies_default = routes;
