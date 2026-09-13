import { FastifyInstance, RegisterOptions } from 'fastify';
import axios from 'axios';
import { getProxyCandidates, toAxiosProxyOptions } from './outboundProxy';

import Providers from './providers';
import * as cheerio from 'cheerio';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(new Providers().getProviders);

  // Keep AniList requests server-side so the player is not blocked by CORS.
  fastify.post('/anilist', async (request, reply) => {
    try {
      const body = (request.body || {}) as { query?: string; variables?: Record<string, unknown> };
      const response = await axios.post('https://graphql.anilist.co', {
        query: body.query,
        variables: body.variables || {},
      }, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 7000,
        validateStatus: () => true,
      });
      return reply.code(response.status).send(response.data);
    } catch (error: any) {
      return reply.code(502).send({ error: 'AniList request failed', message: error?.message || 'Upstream unavailable' });
    }
  });

  const normalizeTitleForMatch = (v: any): string =>
    String(v || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\(([^)]*)\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const toArrayPayload = (payload: any): any[] => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  };

  const pickBestSearchResult = (title: string, results: any[]): any | null => {
    const norm = normalizeTitleForMatch(title);
    if (!norm) return null;
    const titleTokens = new Set(norm.split(' ').filter(Boolean));
    let best: { score: number; item: any | null } = { score: 0, item: null };

    for (const item of results || []) {
      const name = String(
        item?.title ||
          item?.name ||
          item?.title_english ||
          item?.titleEnglish ||
          item?.japanese_title ||
          '',
      ).trim();
      const itemNorm = normalizeTitleForMatch(name);
      if (!itemNorm) continue;
      let score = 0;
      if (itemNorm === norm) score += 120;
      if (itemNorm.includes(norm) || norm.includes(itemNorm)) score += 30;
      const tokens = itemNorm.split(' ').filter(Boolean);
      let overlap = 0;
      tokens.forEach((t) => {
        if (titleTokens.has(t)) overlap += 1;
      });
      score += overlap * 8;
      if (score > best.score) best = { score, item };
    }
    return best.score > 0 ? best.item : null;
  };

  const parseStatusFromEpisode = (ep: any): 'manga' | 'mixed' | 'filler' | null => {
    const boolFiller = ep?.isFiller === true || ep?.filler === true;
    const boolMixed = ep?.isMixed === true || ep?.mixed === true;
    const boolCanon =
      ep?.isMangaCanon === true ||
      ep?.isCanon === true ||
      ep?.mangaCanon === true ||
      ep?.canon === true;

    const text = normalizeTitleForMatch(
      `${ep?.title || ''} ${ep?.description || ''} ${ep?.type || ''} ${ep?.category || ''}`,
    );
    const textFiller = text.includes('filler');
    const textMixed = text.includes('mixed canon filler') || text.includes('mixed canon');
    const textCanon = text.includes('manga canon') || text.includes('canon');

    if (boolFiller || textFiller) return 'filler';
    if (boolMixed || textMixed) return 'mixed';
    if (boolCanon || textCanon) return 'manga';
    return null;
  };

  const buildEpisodeStatusMap = (
    infoPayload: any,
  ): Record<string, 'manga' | 'mixed' | 'filler'> => {
    const map: Record<string, 'manga' | 'mixed' | 'filler'> = {};
    const episodes = toArrayPayload(
      infoPayload?.episodes ? infoPayload.episodes : infoPayload,
    );
    episodes.forEach((ep, idx) => {
      const epNo = Number(ep?.number || ep?.episodeNumber || ep?.episode || idx + 1);
      if (!Number.isFinite(epNo) || epNo <= 0) return;
      const status = parseStatusFromEpisode(ep);
      if (!status) return;
      map[String(epNo)] = status;
    });
    return map;
  };

  const fetchFillerFromMetaProvider = async (
    provider: 'mal' | 'anilist',
    title: string,
  ) => {
    try {
      const searchRes = await fastify.inject({
        method: 'GET',
        url: `/meta/${provider}/${encodeURIComponent(title)}?page=1`,
      });
      if (searchRes.statusCode >= 400)
        return { provider, id: null, episodes: {} as Record<string, any> };
      const searchPayload = JSON.parse(searchRes.body || '{}');
      const best = pickBestSearchResult(title, toArrayPayload(searchPayload));
      const contentId = best?.id || best?.anilistId || best?.malId || best?._id;
      if (!contentId) return { provider, id: null, episodes: {} as Record<string, any> };

      const infoRes = await fastify.inject({
        method: 'GET',
        url: `/meta/${provider}/info/${encodeURIComponent(String(contentId))}?fetchFiller=true`,
      });
      if (infoRes.statusCode >= 400)
        return { provider, id: contentId, episodes: {} as Record<string, any> };
      const infoPayload = JSON.parse(infoRes.body || '{}');
      return {
        provider,
        id: contentId,
        episodes: buildEpisodeStatusMap(infoPayload),
      };
    } catch {
      return { provider, id: null, episodes: {} as Record<string, any> };
    }
  };

  let aflIndexCache: { name: string; slug: string; norm: string }[] | null = null;

  // Simple in-memory cache for recently-fetched manifests to avoid repeated upstream
  // fetches during aggressive hot-reloads/seeks. TTL is short to avoid serving stale tokens.
  const manifestCache = new Map<
    string,
    { at: number; ttl: number; raw: string; contentType?: string }
  >();

  const fetchFillerFromAFL = async (
    title: string,
  ): Promise<{
    id: string | null;
    episodes: Record<string, 'manga' | 'mixed' | 'filler'>;
  }> => {
    try {
      const buildSlugCandidates = (t: string) => {
        const raw = normalizeTitleForMatch(t);
        if (!raw) return [];
        const cleaned = raw
          .replace(/\b(tv|season|part|cour|movie|ona|ova)\b/g, ' ')
          .replace(/[^\w\s-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const tokens = cleaned.split(' ').filter(Boolean);
        if (!tokens.length) return [];
        return [
          tokens.join('-'),
          tokens.slice(0, 3).join('-'),
          tokens.slice(0, 2).join('-'),
        ];
      };

      const slugCandidates = [...new Set(buildSlugCandidates(title))];
      if (!slugCandidates.length) return { id: null, episodes: {} };

      if (!aflIndexCache) {
        try {
          const { data } = await axios.get('https://www.animefillerlist.com/shows', {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36',
            },
            timeout: 10000,
          });
          const $ = cheerio.load(data);
          const entries: { name: string; slug: string; norm: string }[] = [];
          $('#ShowList .Group li a').each((_, el) => {
            const name = $(el).text().trim();
            const href = $(el).attr('href') || '';
            const slug = href.split('/').pop() || '';
            if (name && slug) {
              entries.push({ name, slug, norm: normalizeTitleForMatch(name) });
            }
          });
          if (entries.length > 0) aflIndexCache = entries;
        } catch {}
      }

      if (aflIndexCache && aflIndexCache.length > 0) {
        const titleTokens = new Set(
          normalizeTitleForMatch(title).split(' ').filter(Boolean),
        );
        let best = { score: 0, slug: '' };
        for (const entry of aflIndexCache) {
          const entryNorm = entry.norm;
          let score = 0;
          if (entryNorm === normalizeTitleForMatch(title)) score += 100;
          if (
            entryNorm.includes(normalizeTitleForMatch(title)) ||
            normalizeTitleForMatch(title).includes(entryNorm)
          )
            score += 35;
          const entryTokens = entryNorm.split(' ').filter(Boolean);
          let overlap = 0;
          entryTokens.forEach((t) => {
            if (titleTokens.has(t)) overlap += 1;
          });
          score += overlap * 8;
          if (score > best.score) best = { score, slug: entry.slug };
        }
        if (best.score >= 16 && best.slug) {
          slugCandidates.unshift(best.slug);
        }
      }

      const uniqueSlugs = [...new Set(slugCandidates.filter(Boolean))];

      for (const slug of uniqueSlugs) {
        try {
          const { data } = await axios.get(
            `https://www.animefillerlist.com/shows/${slug}`,
            {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36',
              },
              timeout: 8000,
            },
          );
          const $ = cheerio.load(data);
          const episodes: Record<string, 'manga' | 'mixed' | 'filler'> = {};
          let found = false;
          $('table.EpisodeList tbody tr').each((_, el) => {
            const epNumStr = $(el).find('td.Number').text().trim();
            const epNum = parseInt(epNumStr, 10);
            if (isNaN(epNum)) return;
            found = true;
            const typeStr = $(el).find('td.Type').text().trim().toLowerCase();
            let status: 'manga' | 'mixed' | 'filler' = 'manga';
            if (typeStr.includes('filler')) {
              if (typeStr.includes('mixed') || typeStr.includes('mostly'))
                status = 'mixed';
              else status = 'filler';
            } else if (typeStr.includes('canon')) {
              status = 'manga';
            }
            episodes[epNum] = status;
          });

          if (found) {
            return { id: slug, episodes };
          }
        } catch {}
      }
    } catch {}
    return { id: null, episodes: {} };
  };

  // Handle audio track requests - return minimal valid m3u8 with dummy segment to prevent HLS errors
  // The segment URL points to a valid location but will return empty content
  const dummySegmentUrl = 'data:application/octet-stream;';
  const proxyAffinityByHost = new Map<string, { proxyUrl?: string; at: number }>();
  const PROXY_AFFINITY_TTL_MS = 1000 * 60 * 8;

  // Direct routes
  fastify.get('/audio_tam/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/audio_hin/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/audio_tel/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/audio_mal/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/audio_ben/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/audio_eng/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/audio_jpn/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  // Routes under /utils/ for proxied audio tracks
  fastify.get('/utils/audio_tam/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/utils/audio_hin/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/utils/audio_tel/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/utils/audio_mal/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/utils/audio_ben/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/utils/audio_eng/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });
  fastify.get('/utils/audio_jpn/*', async (request, reply) => {
    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,${dummySegmentUrl}\n#EXT-X-ENDLIST`,
      );
  });

  fastify.get('/proxy', async (request: any, reply: any) => {
    let url = String(request.query?.url || '');
    let referer = String(request.query?.referer || '');
    const incomingRange = String(request.headers?.range || '');
    if (!url) return reply.status(400).send({ message: 'url is required' });

    for (let i = 0; i < 6; i += 1) {
      let nested: URL;
      try {
        nested = new URL(url);
      } catch {
        break;
      }
      if (!/\/utils\/proxy$/i.test(nested.pathname)) break;
      const innerUrl = nested.searchParams.get('url');
      if (!innerUrl) break;
      const innerReferer = nested.searchParams.get('referer');
      url = innerUrl;
      if (!referer && innerReferer) referer = innerReferer;
    }

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reply.status(400).send({ message: 'invalid url' });
    }

    if (!['http:', 'https:'].includes(target.protocol)) {
      return reply.status(400).send({ message: 'invalid protocol' });
    }

    try {
      const pathLower = target.pathname.toLowerCase();
      const queryLower = target.search.toLowerCase();
      const looksLikeM3u8 =
        pathLower.endsWith('.m3u8') ||
        pathLower.includes('playlist') ||
        queryLower.includes('.m3u8');
      const looksLikeMediaSegment =
        /\.(ts|m4s|m4v|mp4|aac|mp3)(\?|$)/i.test(pathLower) ||
        queryLower.includes('.m4s') ||
        queryLower.includes('.ts');
      const isSwiftstreamOppaiMedia =
        /(^|\.)swiftstream\.top$/i.test(target.hostname) &&
        /\/proxy\/oppai\//i.test(target.pathname);
      // Browsers commonly request `bytes=N-` for large direct files. Forwarding
      // that open-ended range makes some origins return the entire remaining
      // MKV, which stalls startup and causes overlapping retries. Bound it to a
      // small window; the browser will request the next window when needed.
      const boundedRange = incomingRange.replace(/^bytes=(\d+)-\s*$/i, (_match, start) => {
        const first = Number(start);
        return Number.isSafeInteger(first) && first >= 0
          ? `bytes=${first}-${first + (4 * 1024 * 1024) - 1}`
          : incomingRange;
      });
      const upstreamRange = boundedRange || (isSwiftstreamOppaiMedia ? 'bytes=0-' : '');

       let refererForRequest = referer || `${target.protocol}//${target.host}/`;
       // AniKoto subtitle/CDN hosts reject the AniKoto site referer and accept
       // the Megaplay origin used by the extracted source.
       if (
         /(?:(?:shiora|mikora)\.(?:top|site|club|net)|lostproject\.club)$/i.test(target.hostname) &&
         /anikoto\.cz/i.test(refererForRequest)
       ) {
         refererForRequest = 'https://megaplay.buzz/';
       }
       // AniKoto's kryntal.top hosts serve Megaplay manifests, segments and
       // subtitle VTTs. They return 403 with the AniKoto/stream referer and
       // only accept the Megaplay origin as Referer.
       if (
         /(^|\.)kryntal\.top$/i.test(target.hostname) &&
         !/^https?:\/\/megaplay\.buzz\//i.test(refererForRequest)
       ) {
         refererForRequest = 'https://megaplay.buzz/';
       }
       // AniKoto/Megaplay imgnex.top hosts (cdn./ncdn.) also serve manifests,
       // segments and subtitle VTTs behind the Megaplay origin referer.
       if (
         /(^|\.)imgnex\.top$/i.test(target.hostname) &&
         !/^https?:\/\/megaplay\.buzz\//i.test(refererForRequest)
       ) {
         refererForRequest = 'https://megaplay.buzz/';
       }
      const baseRequestConfig = {
        responseType: looksLikeM3u8 ? 'arraybuffer' : 'stream',
        timeout: looksLikeM3u8
          ? 20000
          : looksLikeMediaSegment || isSwiftstreamOppaiMedia
            ? 25000
            : 30000,
        headers: {
          Referer: refererForRequest,
          Origin: (() => {
            try {
              const u = new URL(refererForRequest);
              return `${u.protocol}//${u.host}`;
            } catch {
              return `${target.protocol}//${target.host}`;
            }
          })(),
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          ...(upstreamRange ? { Range: upstreamRange } : {}),
        },
        maxRedirects: 5,
        validateStatus: (status: number) => status < 400,
      };

      const proxyCandidates = await getProxyCandidates();
      const chain = [undefined, ...proxyCandidates];
      const fetchWithChain = async (targetUrl: string, requestConfig: any) => {
        let lastErr: any = null;
        const host = (() => {
          try {
            return new URL(targetUrl).hostname.toLowerCase();
          } catch {
            return '';
          }
        })();
        const forceDirectOnly =
          /(^|\.)net20\.cc$/.test(host) ||
          /(^|\.)nm-cdn\d+\.top$/.test(host) ||
          host.includes('animesalt') ||
          host.includes('sprintcdn') ||
          host.includes('r66nv9ed');
        const sticky = proxyAffinityByHost.get(host);
        const stickyProxy =
          sticky && Date.now() - sticky.at < PROXY_AFFINITY_TTL_MS
            ? sticky.proxyUrl
            : undefined;
        const effectiveChain = forceDirectOnly
          ? [undefined]
          : [...new Set([stickyProxy, ...chain])];

        // If direct only or just one option, do it simple
        if (effectiveChain.length <= 1) {
          try {
            const proxyOptions = toAxiosProxyOptions(effectiveChain[0]);
            const upstream = await axios.get(targetUrl, {
              proxy: false,
              ...requestConfig,
              ...proxyOptions,
            } as any);
            return upstream;
          } catch (err: any) {
            throw err;
          }
        }

        // Parallel Race for multiple proxies: Try up to 3 at a time to find one that works fast
        const attemptProxy = async (proxyUrl: string | undefined) => {
          const proxyOptions = toAxiosProxyOptions(proxyUrl);
          let refererForRequest = requestConfig.headers.Referer || '';
          let originForRequest = requestConfig.headers.Origin || '';

          const isAnimesaltCdn =
            /(^|\.)(as-cdn\d+|z\d+|animesalt|as2|as-api)\.(cx|pro|ac|top|xyz|link|click|net|cc|org)$/i.test(
              target.hostname,
            );

          const isHianimeCdn =
            /(^|\.)(rainveil\d*|megacloud\d*|rapid-cloud\d*|rabbitstream\d*|vizcloud\d*|cloud9|bunnycdn|vidcloud)\.(xyz|tv|ru|net|gg|co|online|pro|ac|cc|bz|li|to)$/i.test(
              target.hostname,
            );

          // MegaPlay subtitle CDNs reject the AniKoto page referer for VTT/SRT
          // files and only serve them with the embed origin root as Referer.
          const isAniKotoMegaplaySubtitle =
            /(^|\.)(nexabloom|shiora|mikora|imgnex|mewstream)\.(top|site|club|net)$/i.test(
              target.hostname,
            ) && /(\/subtitles\/|\.(vtt|srt|ass|ssa)(\?|$))/i.test(target.pathname);
          if (isAniKotoMegaplaySubtitle) {
            if (!/megaplay\.buzz/i.test(refererForRequest)) refererForRequest = 'https://megaplay.buzz/';
            if (!/megaplay\.buzz/i.test(originForRequest)) originForRequest = 'https://megaplay.buzz';
          }

          if (isAnimesaltCdn) {
            if (refererForRequest.includes('animesalt.')) {
              refererForRequest = refererForRequest.replace(
                /animesalt\.(cx|pro|xyz|click)/gi,
                'animesalt.cx',
              );
            } else if (!refererForRequest) {
              refererForRequest = 'https://animesalt.cx/';
            }
            if (originForRequest.includes('animesalt.')) {
              originForRequest = originForRequest.replace(
                /animesalt\.(cx|pro|xyz|click)/gi,
                'animesalt.cx',
              );
            } else if (!originForRequest) {
              originForRequest = 'https://animesalt.cx';
            }
          }

          const perAttemptTimeout = Math.max(
            looksLikeM3u8 ? 9000 : looksLikeMediaSegment ? 12000 : 10000,
            Math.min(
              Number(requestConfig.timeout || 12000),
              looksLikeM3u8 ? 14000 : 18000,
            ),
          );

          const response = await axios.get(targetUrl, {
            proxy: false,
            ...requestConfig,
            timeout: perAttemptTimeout,
            headers: {
              ...requestConfig.headers,
              Referer: refererForRequest,
              Origin: originForRequest,
            },
            ...proxyOptions,
          } as any);
          proxyAffinityByHost.set(host, { proxyUrl, at: Date.now() });
          return response;
        };

        // Attempt direct first if not forced proxy
        try {
          return await attemptProxy(undefined);
        } catch (e) {
          lastErr = e;
        }

        // Try remaining proxies in blocks of 2 to balance load vs speed
        for (let i = 1; i < effectiveChain.length; i += 2) {
          const batch = effectiveChain.slice(i, i + 2);
          try {
            return await Promise.any(batch.map((p) => attemptProxy(p)));
          } catch (aggregateErr) {
            lastErr = aggregateErr;
          }
        }

        throw lastErr || new Error('proxy failed');
      };

      const cacheKey = `${target.toString()}|ref=${referer}`;
      let upstream: any = undefined;
      // Use short-lived cache for m3u8 manifests to avoid repeated upstream hits during hot-reloads/seeks
      if (looksLikeM3u8) {
        const cached = manifestCache.get(cacheKey);
        if (cached && Date.now() - cached.at < cached.ttl) {
          upstream = {
            status: 200,
            data: Buffer.from(cached.raw, 'utf8'),
            headers: {
              'content-type': cached.contentType || 'application/vnd.apple.mpegurl',
            },
          } as any;
        }
      }

      if (!upstream) {
        const maxFetchAttempts = looksLikeMediaSegment ? 3 : 1;
        let lastFetchError: any = null;
        for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
          try {
            upstream = await fetchWithChain(target.toString(), baseRequestConfig);
            break;
          } catch (error: any) {
            lastFetchError = error;
            if (attempt >= maxFetchAttempts) break;
            await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
          }
        }
        if (!upstream && lastFetchError) throw lastFetchError;
      }

      if (upstream.status >= 400) {
        return reply.status(upstream.status).send({
          message: `upstream error ${upstream.status}`,
        });
      }

      const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
      const mediaContentType = /\.mkv(?:$|[?#])/i.test(target.pathname)
        ? 'video/x-matroska'
        : contentType;
      const isM3u8 =
        looksLikeM3u8 ||
        contentType.includes('mpegurl') ||
        contentType.includes('application/x-mpegurl') ||
        contentType.includes('application/vnd.apple.mpegurl');

      let raw = '';
      if (isM3u8) {
        if (upstream.data && typeof (upstream.data as any).pipe === 'function') {
          raw = await new Promise<string>((resolve, reject) => {
            let buf = '';
            upstream.data.on('data', (chunk: Buffer) => (buf += chunk.toString('utf8')));
            upstream.data.on('end', () => resolve(buf));
            upstream.data.on('error', reject);
          });
        } else {
          raw = Buffer.from(upstream.data).toString('utf8');
        }

        const base = target.toString();

        const normalizeManifestUri = (candidate: string) => {
          let c = String(candidate || '').trim();
          if (!c) return c;
          // Some providers emit malformed "https:///files/..." URIs.
          if (/^https?:\/\/\/+/i.test(c)) {
            c = c.replace(/^https?:\/\/\/+/i, '/');
          }
          // If parser produced "https://files/..." from malformed inputs, treat it as path.
          if (/^https?:\/\/files\//i.test(c)) {
            const u = new URL(c);
            c = `/files${u.pathname}`;
            if (u.search) c += u.search;
          }
          return c;
        };

        const shouldProxyManifestUris = (() => {
          const host = target.hostname.toLowerCase();
          const ref = referer.toLowerCase();
          return (
            /(^|\.)(as-cdn\d+|z\d+|as2|as-api)\.(top|pro|ac|xyz|link|click|net|cc|org)$/i.test(
              host,
            ) ||
            host.includes('animesalt') ||
            host.includes('swiftstream') ||
            host.includes('sprintcdn') ||
            host.includes('r66nv9ed') ||
            ref.includes('swiftstream') ||
            ref.includes('animesalt') ||
            ref.includes('flixhq') ||
            ref.includes('vidking') ||
            ref.includes('megacloud') ||
            ref.includes('upcloud') ||
            ref.includes('vidcloud')
          );
        })();

        const proxyOrigin = (() => {
          const proto = String(
            request.headers['x-forwarded-proto'] || request.protocol || 'http',
          )
            .split(',')[0]
            .trim();
          const host = String(
            request.headers.host || request.hostname || '127.0.0.1:3000',
          );
          return `${proto}://${host}`;
        })();

        const rewriteUri = (candidate: string) => {
          try {
            const normalized = normalizeManifestUri(candidate);
            let abs = new URL(normalized, base).toString();
            for (let i = 0; i < 4; i += 1) {
              const nested = new URL(abs);
              if (!/\/utils\/proxy$/i.test(nested.pathname)) break;
              const innerUrl = nested.searchParams.get('url');
              if (!innerUrl) break;
              abs = innerUrl;
            }
            if (shouldProxyManifestUris) {
              const ref = refererForRequest
                ? `&referer=${encodeURIComponent(refererForRequest)}`
                : '';
              return `${proxyOrigin}/utils/proxy?url=${encodeURIComponent(abs)}${ref}`;
            }
            return abs;
          } catch {
            return candidate;
          }
        };

        const isMasterManifest = raw.includes('#EXT-X-STREAM-INF');
        // Skip variant reachability probing for CDNs with signed/anti-leech URLs.
        // These CDNs require specific tokens/cookies that our server-side probe won't have,
        // causing false 403s and all variants being incorrectly dropped → 502.
        const isSkipProbeHost = true; // DISABLED PROBING: It is too expensive for multiple variants.
        const isNet20Manifest = isSkipProbeHost;
        const lines = raw.split('\n');

        const reachabilityCache = new Map<string, boolean>();
        const isUriReachable = async (candidate: string): Promise<boolean> => {
          try {
            const normalized = normalizeManifestUri(candidate);
            const abs = new URL(normalized, base).toString();
            if (reachabilityCache.has(abs)) return reachabilityCache.get(abs) as boolean;

            const probeTarget = new URL(abs);
            const probeReferer = referer || `${target.protocol}//${target.host}/`;
            const probeConfig = {
              responseType: 'arraybuffer',
              timeout: 7000,
              headers: {
                Referer: probeReferer,
                Origin: `${new URL(probeReferer).protocol}//${new URL(probeReferer).host}`,
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              },
              maxRedirects: 3,
              validateStatus: () => true as const,
            };

            const probe = await fetchWithChain(probeTarget.toString(), probeConfig);
            const ok =
              Number(probe?.status || 0) >= 200 && Number(probe?.status || 0) < 400;
            reachabilityCache.set(abs, ok);
            return ok;
          } catch {
            return false;
          }
        };

        let filteredLines = [...lines];
        const shouldFilterMasterVariants = !isNet20Manifest;
        if (isMasterManifest && shouldFilterMasterVariants) {
          const droppedLines = new Set<number>();
          let keptVariantCount = 0;
          let totalVariantCount = 0;

          for (let i = 0; i < lines.length; i++) {
            if (droppedLines.has(i)) continue;
            const trimmed = String(lines[i] || '').trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('#EXT-X-MEDIA:') && trimmed.includes('URI="')) {
              const match = /URI="([^"]+)"/.exec(trimmed);
              if (match?.[1]) {
                const ok = await isUriReachable(match[1]);
                if (!ok) droppedLines.add(i);
              }
              continue;
            }

            if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
              totalVariantCount += 1;
              let j = i + 1;
              while (j < lines.length && !String(lines[j] || '').trim()) j++;
              if (j >= lines.length) continue;
              const next = String(lines[j] || '').trim();
              if (!next || next.startsWith('#')) continue;

              const ok = await isUriReachable(next);
              if (!ok) {
                droppedLines.add(i);
                droppedLines.add(j);
              } else {
                keptVariantCount += 1;
              }
            }
          }

          if (totalVariantCount > 0 && keptVariantCount === 0) {
            return reply
              .status(502)
              .send({ message: 'no live variants in master manifest' });
          }

          if (keptVariantCount > 0) {
            filteredLines = lines.filter((_, idx) => !droppedLines.has(idx));
          }
        }

        // Rewrite all URIs in the manifest, including audio tracks
        const rewritten = filteredLines
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
              return line.replace(
                /URI="([^"]+)"/g,
                (_m, uri) => `URI="${rewriteUri(uri)}"`,
              );
            }
            if (trimmed.startsWith('#') && trimmed.includes("URI='")) {
              return line.replace(
                /URI='([^']+)'/g,
                (_m, uri) => `URI='${rewriteUri(uri)}'`,
              );
            }
            if (trimmed.startsWith('#')) return line;
            return rewriteUri(trimmed);
          })
          .join('\n');

        // Cache rewritten manifest briefly so rapid reloads don't refetch upstream immediately
        try {
          manifestCache.set(cacheKey, {
            at: Date.now(),
            ttl: 5000,
            raw: rewritten,
            contentType: 'application/vnd.apple.mpegurl',
          });
        } catch {}

        return reply
          .header('Content-Type', 'application/vnd.apple.mpegurl')
          .header('Access-Control-Allow-Origin', '*')
          .header('Access-Control-Allow-Headers', 'Range,Content-Type')
          .header('Access-Control-Expose-Headers', 'Content-Length,Content-Range')
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .header('Pragma', 'no-cache')
          .header('Expires', '0')
          .send(rewritten);
      }

      const statusCode = Number(upstream.status) || 200;
      if (statusCode === 206) {
        reply.status(206);
      }

      const passHeaders = [
        'accept-ranges',
        'content-range',
        'content-length',
        'cache-control',
        'etag',
        'last-modified',
      ];
      for (const h of passHeaders) {
        const v = upstream.headers?.[h];
        if (v != null) reply.header(h, String(v));
      }

      // Ensure CORS is allowed for proxied media responses so browser can fetch segments
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Headers', 'Range,Content-Type');
      reply.header('Access-Control-Expose-Headers', 'Content-Length,Content-Range');

      if (!isM3u8 && upstream.data && typeof (upstream.data as any).pipe === 'function') {
        return reply
          .header('Content-Type', mediaContentType || 'application/octet-stream')
          .header('Connection', 'keep-alive')
          .header(
            'Cache-Control',
            String(
              upstream.headers?.['cache-control'] || 'public, max-age=60, no-transform',
            ),
          )
          .send(upstream.data);
      }

      return reply
        .header('Content-Type', mediaContentType || 'application/octet-stream')
        .send(Buffer.from(upstream.data));
    } catch (err: any) {
      return reply.status(502).send({ message: err?.message || 'proxy failed' });
    }
  });

  fastify.get('/filler', async (request: any, reply: any) => {
    const title = String(request.query?.title || '').trim();
    if (!title) return reply.status(400).send({ message: 'title is required' });

    const mal = await fetchFillerFromMetaProvider('mal', title);
    if (Object.keys(mal.episodes).length > 0) {
      return reply.status(200).send({
        title,
        source: 'meta-mal',
        providerId: mal.id,
        episodes: mal.episodes,
      });
    }

    const anilist = await fetchFillerFromMetaProvider('anilist', title);
    if (Object.keys(anilist.episodes).length > 0) {
      return reply.status(200).send({
        title,
        source: 'meta-anilist',
        providerId: anilist.id,
        episodes: anilist.episodes,
      });
    }

    const afl = await fetchFillerFromAFL(title);
    if (Object.keys(afl.episodes).length > 0) {
      return reply.status(200).send({
        title,
        source: 'animefillerlist',
        providerId: afl.id,
        episodes: afl.episodes,
      });
    }

    return reply.status(200).send({
      title,
      source: 'none',
      episodes: {},
    });
  });

  // VTT proxy: fetch a subtitle URL, convert SRT/ASS → WebVTT, serve as text/vtt.
  // iOS AVKit native fullscreen player cannot load data: URI text tracks — it needs a real HTTP URL.
  fastify.get('/vtt', async (request: any, reply: any) => {
    const url = String(request.query?.url || '').trim();
    const referer = String(request.query?.referer || '').trim();
    if (!url) return reply.status(400).send('url is required');

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reply.status(400).send('invalid url');
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      return reply.status(400).send('invalid protocol');
    }

    const getUrlVariants = (value: string): string[] => {
      const variants = new Set<string>();
      const add = (candidate: string) => {
        const normalized = String(candidate || '').trim();
        if (!normalized) return;
        try {
          const parsed = new URL(normalized);
          if (['http:', 'https:'].includes(parsed.protocol))
            variants.add(parsed.toString());
        } catch {
          // ignore invalid decode attempts
        }
      };

      add(value);
      try {
        add(decodeURI(value));
      } catch {
        /* ignore */
      }
      try {
        add(decodeURIComponent(value));
      } catch {
        /* ignore */
      }

      return [...variants];
    };

    const toShirnaProxyUrl = (subtitleUrl: string): string | null => {
      const rawBase = String(process.env.SHIRNA_PROXY_URL || '').trim();
      if (!rawBase) return null;
      if (rawBase.includes('{url}'))
        return rawBase.replace('{url}', encodeURIComponent(subtitleUrl));
      if (/[?&](src|url)=$/i.test(rawBase))
        return `${rawBase}${encodeURIComponent(subtitleUrl)}`;
      const joiner = rawBase.includes('?') ? '&' : '?';
      return `${rawBase}${joiner}src=${encodeURIComponent(subtitleUrl)}`;
    };

    const refererForRequest = referer || `${target.protocol}//${target.host}/`;
    let originForRequest = refererForRequest;
    try {
      originForRequest = `${new URL(refererForRequest).protocol}//${new URL(refererForRequest).host}`;
    } catch {
      /* ignore */
    }
    const isAnimeSaltSubtitleHost =
      /(^|\.)(as-cdn\d+|z\d+|as2|as-api)\.(top|pro|ac|xyz|link|click|net|cc|org)$/i.test(
        target.hostname,
      );
    const isKryntalSubtitleHost = /(^|\.)kryntal\.top$/i.test(target.hostname);
    const isAniKotoMegaplaySubtitleHost =
      /(^|\.)(nexabloom|shiora|mikora|imgnex|mewstream)\.(top|site|club|net)$/i.test(
        target.hostname,
      ) && /(\/subtitles\/|\.(vtt|srt|ass|ssa)(\?|$))/i.test(target.pathname);
    const refererCandidates = (() => {
      const values = [
        refererForRequest,
        `${target.protocol}//${target.host}/`,
        isAnimeSaltSubtitleHost ? 'https://animesalt.cx/' : '',
        isAnimeSaltSubtitleHost ? `${target.protocol}//${target.host}/` : '',
        // AniKoto's kryntal hosts reject the AniKoto/stream referer and only
        // serve subtitle VTTs with the Megaplay origin as Referer.
        isKryntalSubtitleHost ? 'https://megaplay.buzz/' : '',
        isAniKotoMegaplaySubtitleHost ? 'https://megaplay.buzz/' : '',
      ].filter(Boolean);
      return [...new Set(values)];
    })();

    const normalizeCueTimestamp = (value: string): string => {
      const raw = String(value || '')
        .trim()
        .replace(',', '.');
      const match = raw.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
      if (!match) return raw;
      const hours = String(Number(match[1] || 0)).padStart(2, '0');
      const minutes = String(Number(match[2] || 0)).padStart(2, '0');
      const seconds = String(Number(match[3] || 0)).padStart(2, '0');
      const millis = String(match[4] || '000')
        .padEnd(3, '0')
        .slice(0, 3);
      return `${hours}:${minutes}:${seconds}.${millis}`;
    };

    const normalizeCueTimings = (text: string): string =>
      String(text || '').replace(
        /(\d+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*(\d+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)([^\n\r]*)/g,
        (_match, start, end, suffix) =>
          `${normalizeCueTimestamp(start)} --> ${normalizeCueTimestamp(end)}${suffix || ''}`,
      );

    const stripSubtitleMarkup = (text: string): string =>
      String(text || '')
        .replace(/<\/?(i|b|u|font|c|ruby|rt|v)(?:\s+[^>]*)?>/gi, '')
        .replace(/<[^>]+>/g, '');

    const sanitizeCueText = (text: string): string => {
      const normalized = String(text || '').replace(/\r+/g, '').replace(/^\uFEFF/, '');
      return normalized
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return '';
          if (/^WEBVTT$/i.test(trimmed)) return line;
          if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(trimmed)) return line;
          if (/^\d+$/.test(trimmed)) return line;
          if (/-->/.test(line)) return line;
          return stripSubtitleMarkup(line);
        })
        .join('\n');
    };

    const srtToVtt = (text: string): string => {
      const clean = sanitizeCueText(normalizeCueTimings(text));
      return `WEBVTT\n\n${clean}`;
    };

    const assTimeToVtt = (t: string): string => {
      const m = String(t || '')
        .trim()
        .match(/^(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,2})$/);
      if (!m) return '';
      return `${String(Number(m[1])).padStart(2, '0')}:${String(Number(m[2])).padStart(2, '0')}:${String(Number(m[3])).padStart(2, '0')}.${String(Math.round(Number(`0.${m[4] || '0'}`) * 1000)).padStart(3, '0')}`;
    };

    const assToVtt = (text: string): string => {
      const lines = text
        .replace(/\r+/g, '')
        .replace(/^\uFEFF/, '')
        .split('\n');
      const cues: string[] = [];
      let idx = 1;
      for (const line of lines) {
        const m = line.match(
          /^Dialogue:\s*[^,]*,([^,]+),([^,]+),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/i,
        );
        if (!m) continue;
        const s = assTimeToVtt(m[1]);
        const e = assTimeToVtt(m[2]);
        if (!s || !e) continue;
        const txt = String(m[3] || '')
          .replace(/\{[^}]*\}/g, '')
          .replace(/\\N/gi, '\n')
          .replace(/\\n/g, '\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (!txt) continue;
        cues.push(`${idx++}\n${s} --> ${e}\n${txt}`);
      }
      return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}` : '';
    };

    try {
      const { getCachedSubtitleText } = await import('./browserRuntimeExtractor.js');
      const cachedSubtitle = getCachedSubtitleText(url);
      if (cachedSubtitle) {
        let raw = sanitizeCueText(cachedSubtitle);
        const isVtt = raw.trim().toLowerCase().startsWith('webvtt');
        if (!isVtt && raw.includes('-->'))
          raw = `WEBVTT\n\n${raw.replace(/\r+/g, '').replace(/^\uFEFF/, '')}`;
        return reply
          .header('Content-Type', 'text/vtt; charset=utf-8')
          .header('Access-Control-Allow-Origin', '*')
          .header('Cache-Control', 'public, max-age=1800')
          .send(raw);
      }

      const proxyCandidates = await getProxyCandidates();
      const urlVariants = getUrlVariants(url);
      const targetRequests = [
        ...urlVariants.map((requestUrl) => ({ requestUrl, displayUrl: requestUrl })),
        ...urlVariants
          .map((requestUrl) => toShirnaProxyUrl(requestUrl))
          .filter((requestUrl): requestUrl is string => Boolean(requestUrl))
          .map((requestUrl) => ({ requestUrl, displayUrl: requestUrl })),
      ];
      const chain = [undefined, ...proxyCandidates];
      let raw = '';
      let lastErr: any = null;
      for (const targetRequest of targetRequests) {
        for (const candidateReferer of refererCandidates) {
          let candidateOrigin = candidateReferer;
          try {
            candidateOrigin = `${new URL(candidateReferer).protocol}//${new URL(candidateReferer).host}`;
          } catch {
            /* ignore */
          }
          for (const proxyUrl of chain) {
            try {
              const { toAxiosProxyOptions: tap } = await import('./outboundProxy.js');
              const proxyOpts = tap(proxyUrl);
              const resp = await axios.get(targetRequest.requestUrl, {
                proxy: false,
                ...proxyOpts,
                responseType: 'text',
                timeout: 15000,
                headers: {
                  Accept: 'text/vtt,text/plain,*/*',
                  Referer: candidateReferer,
                  Origin: candidateOrigin,
                  'X-Forward-Origin': candidateOrigin,
                  'X-Forward-Referer': candidateReferer,
                  'Sec-Fetch-Dest': 'empty',
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Site': 'cross-site',
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                maxRedirects: 5,
                validateStatus: (s: number) => s < 400,
              } as any);
              raw = String(resp.data || '');
              break;
            } catch (e: any) {
              lastErr = e;
            }
          }
          if (raw) break;
        }
        if (raw) break;
      }

      if (!raw) {
        return reply.status(502).send(lastErr?.message || 'upstream fetch failed');
      }

      // Detect and convert format
      const ln = raw.trim().toLowerCase();
      if (ln.startsWith('<!doctype html') || ln.startsWith('<html')) {
        return reply.status(502).send('upstream returned HTML error page');
      }

      let vtt = '';
      const trimmed = raw.trim();
      // AnimeSalt base64-encoded subtitles
      if (
        !trimmed.includes('-->') &&
        trimmed.length > 50 &&
        /^[a-z0-9+/= \n\r\t]+$/i.test(trimmed)
      ) {
        try {
          const decoded = Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString(
            'utf8',
          );
          if (decoded.includes('-->')) raw = decoded;
        } catch {
          /* ignore */
        }
      }

      const hasCue = raw.includes('-->');
      const hasSrt = /\d+:\d{1,2}:\d{1,2}[.,]\d{1,3}/.test(raw);
      const isAss = /^\s*\[Script Info\]/im.test(raw) || /^\s*\[Events\]/im.test(raw);
      const isSrt =
        /^\d+:\d{1,2}:\d{1,2}[,.]\d{1,3}$/.test(
          raw.split('\n').find((l) => l.includes(',')) || '',
        ) ||
        (hasCue && hasSrt && !raw.trim().toLowerCase().startsWith('webvtt'));
      const isVtt = raw.trim().toLowerCase().startsWith('webvtt');

      if (isAss) vtt = assToVtt(raw);
      else if (isSrt) vtt = srtToVtt(raw);
      else if (isVtt)
        vtt = sanitizeCueText(normalizeCueTimings(raw));
      else if (hasCue)
        vtt = `WEBVTT\n\n${sanitizeCueText(normalizeCueTimings(raw))}`;
      else vtt = raw;

      reply
        .header('Content-Type', 'text/vtt; charset=utf-8')
        .header('Access-Control-Allow-Origin', '*')
        .header('Cache-Control', 'public, max-age=3600')
        .send(vtt);
    } catch (err: any) {
      return reply.status(502).send(err?.message || 'vtt proxy failed');
    }
  });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Utils!');
  });
};

export default routes;
