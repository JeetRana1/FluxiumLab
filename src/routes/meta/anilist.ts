import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { META } from '@consumet/extensions';
import { Genres, SubOrSub } from '@consumet/extensions/dist/models';
import Anilist from '@consumet/extensions/dist/providers/meta/anilist';
import Myanimelist from '@consumet/extensions/dist/providers/meta/mal';
import { StreamingServers } from '@consumet/extensions/dist/models';

import cache from '../../utils/cache';
import { redis } from '../../main';
import AnimeSama from '@consumet/extensions/dist/providers/anime/animesama';
import { fetchWithServerFallback } from '../../utils/streamable';
import { configureProvider } from '../../utils/provider';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the anilist provider: check out the provider's website @ https://anilist.co/",
      routes: ['/:query', '/info/:id', '/watch/:episodeId'],
      documentation: 'https://docs.consumet.org/#tag/anilist',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;
    const page = Number((request.query as { page?: number }).page) || 1;
    const perPage = Number((request.query as { perPage?: number }).perPage) || 15;
    try {
      let res: any = null;
      try {
        const anilist = generateAnilistMeta();
        res = await anilist.search(query, page, perPage);
      } catch (err: any) {
        console.warn(
          '[Anilist] GraphQL search failed, trying fallbacks:',
          err?.message || err,
        );
        res = null;
      }

      if (res && Array.isArray(res.results) && res.results.length > 0) {
        reply.status(200).send(res);
        return;
      }

      // MyAnimeList is reachable from hosts where AniList's GraphQL endpoint is
      // IP-blocked, and (via the anime page) returns both English and romaji
      // titles plus the release year, making it a strong anime-detection source.
      try {
        const malRows = await searchMyanimelist(query, 5);
        if (malRows.length > 0) {
          reply.status(200).send({
            currentPage: page,
            hasNextPage: false,
            totalPages: 1,
            totalResults: malRows.length,
            results: malRows,
          });
          return;
        }
      } catch (err: any) {
        console.warn('[Anilist] MAL fallback search failed:', err?.message || err);
      }

      // AnimeSalt only indexes anime, so its catalog is a reliable substitute
      // for anime detection when AniList and MyAnimeList are unreachable.
      // Map rows into the AniList search shape so existing title-matching
      // logic keeps working.
      try {
        const fallbackRes = await request.server.inject({
          method: 'GET',
          url: `/anime/animesalt/${encodeURIComponent(query)}`,
        });
        if (fallbackRes.statusCode === 200) {
          let fallbackRows: any[] = [];
          try {
            fallbackRows = JSON.parse(fallbackRes.body || '[]');
          } catch {
            fallbackRows = [];
          }
          if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
            const mapped = fallbackRows.slice(0, perPage).map((row) => {
              const title = String(row?.title || '').trim();
              return {
                id: String(row?.id || ''),
                malId: null,
                title: {
                  romaji: title,
                  english: title,
                  native: title,
                  userPreferred: title,
                },
                image: row?.image || null,
                cover: null,
                description: null,
                status: null,
                rating: null,
                genres: [],
                totalEpisodes: null,
                currentEpisodeCount: null,
                type: row?.type || 'tv',
                releaseDate: null,
                year: null,
                startDate: null,
              };
            });
            reply.status(200).send({
              currentPage: page,
              hasNextPage: false,
              totalPages: 1,
              totalResults: mapped.length,
              results: mapped,
            });
            return;
          }
        }
      } catch (err: any) {
        console.warn(
          '[Anilist] AnimeSalt fallback search failed:',
          err?.message || err,
        );
      }

      reply.status(200).send({ results: [], message: 'No results found' });
    } catch (err: any) {
      console.error('[Anilist] Search error:', err?.message || err);
      reply.status(200).send({ results: [], message: err?.message || 'Search failed' });
    }
  });

  fastify.get(
    '/advanced-search',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query as { query: string }).query;
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;
      const type = (request.query as { type: string }).type;
      let genres = (request.query as { genres?: string | string[] }).genres;
      const id = (request.query as { id: string }).id;
      const format = (request.query as { format: string }).format;
      let sort = (request.query as { sort?: string | string[] }).sort;
      const status = (request.query as { status: string }).status;
      const year = (request.query as { year: number }).year;
      const season = (request.query as { season: string }).season;
      const countryOfOrigin = (request.query as { countryOfOrigin: string })
        .countryOfOrigin;

      const anilist = generateAnilistMeta();

      if (genres) {
        try {
          const parsedGenres = JSON.parse(genres as string);
          parsedGenres.forEach((genre: string) => {
            if (!Object.values(Genres).includes(genre as Genres)) {
              // We'll just skip invalid genres or handle specifically
            }
          });
          genres = parsedGenres;
        } catch {
          genres = undefined;
        }
      }

      if (sort) {
        try {
          sort = JSON.parse(sort as string);
        } catch {
          sort = undefined;
        }
      }

      if (season) {
        if (!['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(season))
          return reply.status(400).send({ message: `${season} is not a valid season` });
      }

      const res = await anilist.advancedSearch(
        query,
        type,
        page,
        perPage,
        format,
        sort as string[],
        genres as string[],
        id,
        year,
        status,
        season,
        countryOfOrigin,
      );

      reply.status(200).send(res);
    },
  );

  fastify.get('/trending', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const anilist = generateAnilistMeta();

    redis
      ? reply
          .status(200)
          .send(
            await cache.fetch(
              redis as any,
              `anilist:trending;${page};${perPage}`,
              async () => await anilist.fetchTrendingAnime(page, perPage),
              60 * 60,
            ),
          )
      : reply.status(200).send(await anilist.fetchTrendingAnime(page, perPage));
  });

  fastify.get('/popular', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const anilist = generateAnilistMeta();

    redis
      ? reply
          .status(200)
          .send(
            await cache.fetch(
              redis as any,
              `anilist:popular;${page};${perPage}`,
              async () => await anilist.fetchPopularAnime(page, perPage),
              60 * 60,
            ),
          )
      : reply.status(200).send(await anilist.fetchPopularAnime(page, perPage));
  });

  fastify.get(
    '/airing-schedule',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;
      const weekStart = (request.query as { weekStart: number | string }).weekStart;
      const weekEnd = (request.query as { weekEnd: number | string }).weekEnd;
      const notYetAired = (request.query as { notYetAired: boolean }).notYetAired;

      const anilist = generateAnilistMeta();
      const _weekStart = Math.ceil(Date.now() / 1000);

      const res = await anilist.fetchAiringSchedule(
        page ?? 1,
        perPage ?? 20,
        weekStart ?? _weekStart,
        weekEnd ?? _weekStart + 604800,
        notYetAired ?? true,
      );

      reply.status(200).send(res);
    },
  );

  fastify.get('/genre', async (request: FastifyRequest, reply: FastifyReply) => {
    const genres = (request.query as { genres: string }).genres;
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const anilist = generateAnilistMeta();

    if (typeof genres === 'undefined')
      return reply.status(400).send({ message: 'genres is required' });

    try {
      const parsedGenres = JSON.parse(genres);
      const res = await anilist.fetchAnimeGenres(parsedGenres, page, perPage);
      reply.status(200).send(res);
    } catch (err: any) {
      reply.status(400).send({ message: 'Invalid genres data' });
    }
  });

  fastify.get(
    '/recent-episodes',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const provider = (request.query as { provider: string }).provider;
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;

      const anilist = generateAnilistMeta(provider);
      const res = await anilist.fetchRecentEpisodes(provider as any, page, perPage);
      reply.status(200).send(res);
    },
  );

  fastify.get('/random-anime', async (request: FastifyRequest, reply: FastifyReply) => {
    const anilist = generateAnilistMeta();
    const res = await anilist.fetchRandomAnime().catch(() => {
      return reply.status(404).send({ message: 'Anime not found' });
    });
    reply.status(200).send(res);
  });

  fastify.get('/servers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const provider = (request.query as { provider?: string }).provider;

    let anilist = generateAnilistMeta(provider);
    const res = await anilist.fetchEpisodeServers(id);
    reply.status(200).send(res);
  });

  fastify.get('/episodes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const id = (request.params as { id: string }).id;
    const provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let dub = (request.query as { dub?: string | boolean }).dub;

    let anilist = generateAnilistMeta(provider);

    dub = dub === 'true' || dub === '1';
    fetchFiller = fetchFiller === 'true' || fetchFiller === '1';

    try {
      if (redis) {
        const data = await cache.fetch(
          redis,
          `anilist:episodes;${id};${dub};${fetchFiller};${anilist.provider.name.toLowerCase()}`,
          async () =>
            anilist.fetchEpisodesListById(id, dub as boolean, fetchFiller as boolean),
          dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2,
        );
        reply.status(200).send(data);
      } else {
        const data = await anilist.fetchEpisodesListById(
          id,
          dub as boolean,
          fetchFiller as boolean,
        );
        reply.status(200).send(data);
      }
    } catch (err) {
      return reply.status(404).send({ message: 'Anime not found' });
    }
  });

  fastify.get('/data/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const anilist = generateAnilistMeta();
    const res = await anilist.fetchAnilistInfoById(id);
    reply.status(200).send(res);
  });

  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const today = new Date();
    const dayOfWeek = today.getDay();
    const provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let isDub = (request.query as { dub?: string | boolean }).dub;

    let anilist = generateAnilistMeta(provider);

    isDub = isDub === 'true' || isDub === '1';
    fetchFiller = fetchFiller === 'true' || fetchFiller === '1';

    try {
      if (redis) {
        const data = await cache.fetch(
          redis,
          `anilist:info;${id};${isDub};${fetchFiller};${anilist.provider.name.toLowerCase()}`,
          async () =>
            anilist.fetchAnimeInfo(id, isDub as boolean, fetchFiller as boolean),
          dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2,
        );
        reply.status(200).send(data);
      } else {
        const data = await anilist.fetchAnimeInfo(
          id,
          isDub as boolean,
          fetchFiller as boolean,
        );
        reply.status(200).send(data);
      }
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });

  fastify.get('/character/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const anilist = generateAnilistMeta();
    const res = await anilist.fetchCharacterInfoById(id);
    reply.status(200).send(res);
  });

  fastify.get(
    '/watch/:episodeId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { episodeId: string }).episodeId;
      const provider = (request.query as { provider?: string }).provider;
      const server = (request.query as { server?: StreamingServers }).server;
      let isDub = (request.query as { dub?: string | boolean }).dub;

      if (server && !Object.values(StreamingServers).includes(server))
        return reply.status(400).send('Invalid server');

      isDub = isDub === 'true' || isDub === '1';
      let anilist = generateAnilistMeta(provider);

      try {
        const fetchSources = async (selectedServer?: StreamingServers) => {
          return provider === 'zoro'
            ? await anilist.fetchEpisodeSources(
                episodeId,
                selectedServer,
                isDub ? SubOrSub.DUB : SubOrSub.SUB,
              )
            : await anilist.fetchEpisodeSources(episodeId, selectedServer);
        };

        if (redis) {
          const data = await cache.fetch(
            redis,
            `anilist:watch;${episodeId};${anilist.provider.name.toLowerCase()};${server};${isDub ? 'dub' : 'sub'}`,
            async () => await fetchWithServerFallback(fetchSources, server),
            600,
          );
          reply.status(200).send(data);
        } else {
          const data = await fetchWithServerFallback(fetchSources, server);
          reply.status(200).send(data);
        }
      } catch (err) {
        reply.status(500).send({ message: 'Something went wrong.' });
      }
    },
  );

  fastify.get('/staff/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const anilist = generateAnilistMeta();
    try {
      if (redis) {
        const data = await cache.fetch(
          redis,
          `anilist:staff;${id}`,
          async () => await anilist.fetchStaffById(Number(id)),
          60 * 60,
        );
        reply.status(200).send(data);
      } else {
        const data = await anilist.fetchStaffById(Number(id));
        reply.status(200).send(data);
      }
    } catch (err: any) {
      reply.status(404).send({ message: err.message });
    }
  });

  fastify.get('/favorites', async (request: FastifyRequest, reply: FastifyReply) => {
    const type = (request.query as { type?: 'ANIME' | 'MANGA' | 'BOTH' }).type;
    const headers = request.headers as Record<string, string>;

    if (!headers.authorization) {
      return reply.status(401).send({ message: 'Authorization header is required' });
    }

    const anilist = generateAnilistMeta();
    try {
      const res = await anilist.fetchFavoriteList(headers.authorization, type);
      reply.status(200).send(res);
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });
};

class BrowserAnilist extends Anilist {
  configureBrowserHeaders(): void {
    this.client.interceptors.request.use((config) => {
      if (String(config.url || '').includes('graphql.anilist.co')) {
        config.headers = config.headers || {};
        config.headers['Referer'] = 'https://anilist.co/';
        config.headers['Origin'] = 'https://anilist.co';
        config.headers['Accept'] = 'application/json, text/plain, */*';
        config.headers['User-Agent'] =
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      }
      return config;
    });
  }
}

const generateAnilistMeta = (provider: string | undefined = undefined): Anilist => {
  // Do NOT pass getProxyCandidatesSync() here: Proxy.setProxy prefixes the
  // proxy URL onto every outgoing request, which corrupts AniList's absolute
  // graphql URLs (e.g. "<proxy>https://graphql.anilist.co") and throws
  // "Invalid URL". AniList is reached directly with browser-style headers.
  const anilist = new BrowserAnilist(configureProvider(new AnimeSama()));

  // AniList now returns 403/404 unless the GraphQL call looks like a real
  // browser request (anti-bot). Attach a browser-style Referer/Origin and
  // User-Agent so trending/search/advanced-search don't silently fail.
  anilist.configureBrowserHeaders();

  return anilist;
};

/**
 * Searches MyAnimeList (MAL) and enriches the top results by fetching each
 * anime page for its English/romaji/native titles and release year. Results
 * are mapped into the AniList search shape so downstream title-matching logic
 * works unchanged.
 */
const searchMyanimelist = async (query: string, limit = 5): Promise<any[]> => {
  const mal = new Myanimelist();
  const searchRes = await mal.search(query, 1);
  const rows = Array.isArray(searchRes?.results) ? searchRes.results : [];
  const top = rows.slice(0, limit);
  if (top.length === 0) return [];

  const enriched = await Promise.all(
    top.map(async (row: any) => {
      let info: any = null;
      try {
        info = await mal.fetchMalInfoById(row.id);
      } catch {
        info = null;
      }
      return { row, info };
    }),
  );

  return enriched.map(({ row, info }) => {
    const title = info?.title || {};
    const romaji = title.romaji || String(row.title || '');
    const english = title.english || title.userPreferred || String(row.title || '');
    const native = title.native || english;
    const year =
      Number.isFinite(info?.startDate?.year) ? info.startDate.year : null;
    const totalEpisodes =
      row?.totalEpisodes ?? info?.totalEpisodes ?? null;
    return {
      id: String(row.id || ''),
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
      type: row?.type || info?.type || 'tv',
      releaseDate: year != null ? String(year) : null,
      year,
      startDate: info?.startDate || null,
    };
  });
};

export default routes;
