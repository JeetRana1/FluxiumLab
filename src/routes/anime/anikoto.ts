import { FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import { fetchCurrentAniKotoSources } from '../../providers/custom/anikotoProvider';

const routes = async (fastify: FastifyInstance, _options: RegisterOptions) => {
  const createProvider = () => {
    const instance = new (ANIME as any).AniKoto();
    instance.client.defaults.timeout = 12000;
    return instance;
  };
  const provider = createProvider();
  const sourceCache = new Map<string, { expires: number; value: any }>();
  const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
  const pending = new Map<string, Promise<any>>();
  const cachedRequest = async (
    key: string,
    load: () => Promise<any>,
    valid: (value: any) => boolean,
  ) => {
    const cached = sourceCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        if (valid(value)) {
          for (const [id, entry] of sourceCache)
            if (entry.expires <= Date.now()) sourceCache.delete(id);
          if (sourceCache.size >= 256)
            sourceCache.delete(sourceCache.keys().next().value!);
          sourceCache.set(key, { expires: Date.now() + SOURCE_CACHE_TTL_MS, value });
        }
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
  fastify.get('/', async (_request, reply) =>
    reply.send({ provider: 'anikoto', baseUrl: provider.toString.baseUrl }),
  );

  fastify.get('/:query', async (request: any, reply) => {
    try {
      const query = String(request.params.query).trim();
      const page = Number(request.query?.page || 1);
      if (
        !query ||
        query.length > 200 ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > 1000
      ) {
        return reply.status(400).send({ message: 'Invalid AniKoto search' });
      }
      return reply.send(
        await cachedRequest(
          `search:${query}:${page}`,
          () => createProvider().search(query, page),
          (value) => value?.results?.length > 0,
        ),
      );
    } catch (error: any) {
      return reply
        .status(502)
        .send({ message: error?.message || 'AniKoto search failed' });
    }
  });

  fastify.get('/info', async (request: any, reply) => {
    try {
      let id = String(request.query?.id || '');
      // The extension accepts arbitrary absolute URLs; never forward user-selected hosts.
      if (/^https?:\/\//i.test(id)) {
        const url = new URL(id);
        if (url.origin !== 'https://anikoto.cz' || url.username || url.password) {
          return reply.status(400).send({ message: 'Invalid AniKoto title ID' });
        }
        id = url.pathname
          .replace(/^\/watch\//, '')
          .replace(/\/ep-\d+\/?$/, '')
          .replace(/\/$/, '');
      }
      if (!/^[a-z0-9][a-z0-9-]{0,199}$/i.test(id))
        return reply.status(400).send({ message: 'Invalid AniKoto title ID' });
      return reply.send(
        await cachedRequest(
          `info:${id}`,
          () => createProvider().fetchAnimeInfo(id),
          (value) => value?.episodes?.length > 0,
        ),
      );
    } catch (error: any) {
      return reply.status(502).send({ message: error?.message || 'AniKoto info failed' });
    }
  });

  fastify.get('/watch/:episodeId', async (request: any, reply) => {
    try {
      const episodeId = String(request.params.episodeId);
      const server = request.query?.server;
      if (
        !/^[a-z0-9][a-z0-9-]{0,199}\$episode\$[1-9]\d{0,5}$/i.test(episodeId) ||
        (server !== undefined && (typeof server !== 'string' || server.length > 80))
      ) {
        return reply.status(400).send({ message: 'Invalid AniKoto episode or server' });
      }
      const cacheKey = `watch:${episodeId}|${server || ''}`;
      const value = await cachedRequest(
        cacheKey,
        async () => {
          let result: any = null;
          try {
            result = await fetchCurrentAniKotoSources(episodeId, server);
          } catch (error: any) {
            request.log.warn(
              { err: error, episodeId },
              'Current AniKoto extraction failed; using extension provider',
            );
          }
          if (result) {
            return result;
          }

          try {
            result = await createProvider().fetchEpisodeSources(episodeId, server);
          } catch (firstError) {
            // AniKoto's provider can retain stale extractor state. Recreate it once,
            // matching the recovery users previously got by restarting the API.
            request.log.warn(
              { err: firstError, episodeId },
              'AniKoto watch retry with fresh provider',
            );
            result = await createProvider().fetchEpisodeSources(episodeId, server);
          }
          return result;
        },
        (result) =>
          [
            ...(result?.sources || []),
            ...(result?.sub?.sources || []),
            ...(result?.dub?.sources || []),
          ].some((source: any) => source?.url),
      );
      return reply.send(value);
    } catch (error: any) {
      return reply
        .status(502)
        .send({ message: error?.message || 'AniKoto source extraction failed' });
    }
  });
};

export default routes;
