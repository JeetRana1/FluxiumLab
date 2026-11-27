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
var anime_exports = {};
__export(anime_exports, {
  default: () => anime_default
});
module.exports = __toCommonJS(anime_exports);
var import_extensions = require("@consumet/extensions");
var import_anikoto = __toESM(require("./anikoto"));
const routes = async (fastify, options) => {
  await fastify.register(import_anikoto.default, { prefix: "/anikoto" });
  fastify.get("/", async (request, reply) => {
    reply.status(200).send("Welcome to Consumet Anime \u{1F5FE}");
  });
  fastify.get("/:animeProvider", async (request, reply) => {
    const queries = {
      animeProvider: "",
      page: 1
    };
    queries.animeProvider = decodeURIComponent(
      request.params.animeProvider
    );
    queries.page = request.query.page;
    if (queries.page < 1)
      queries.page = 1;
    const provider = import_extensions.PROVIDERS_LIST.ANIME.find(
      (provider2) => provider2.toString.name === queries.animeProvider
    );
    try {
      if (provider) {
        reply.redirect(`/anime/${provider.toString.name}`);
      } else {
        reply.status(404).send({ message: "Provider not found, please check the providers list." });
      }
    } catch (err) {
      reply.status(500).send("Something went wrong. Please try again later.");
    }
  });
};
var anime_default = routes;
