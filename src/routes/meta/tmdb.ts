import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { META, PROVIDERS_LIST, StreamingServers } from '@consumet/extensions';
import { load } from 'cheerio';
import { tmdbApi, redis, REDIS_TTL } from '../../main';
import cache from '../../utils/cache';
import { fetchWithServerFallback, MOVIE_SERVER_FALLBACKS } from '../../utils/streamable';
import { configureProvider } from '../../utils/provider';
import { getMovieEmbedFallbackSource } from '../../utils/movieServerFallback';
import axios from 'axios';
import { google } from 'googleapis';
import { HdStream4uProvider } from '../../providers/custom/hdstream4uProvider';

const configureMeta = (meta: any) => {
  if (meta && (meta as any).client?.defaults) {
    // Already set globally in main.ts, but being explicit for meta routes
    (meta as any).client.defaults.headers.common['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  return meta;
};

const shouldLookupTrailers =
  String(process.env.TMDB_ENABLE_TRAILER_LOOKUP || 'false').toLowerCase() === 'true';

const logTmdbFailure = (label: string, error: any): void => {
  // Anime frequently map to TMDB ids that no longer exist (404). These are
  // expected and non-fatal (the route rescues and still returns 200), so keep
  // them out of the logs instead of dumping a full axios stack per title.
  const status = error?.response?.status;
  if (status && status !== 404) {
    console.warn(
      `${label} (HTTP ${status}):`,
      error?.message || error,
    );
  }
};

const createTmdbClient = (provider: any) => {
  if (!tmdbApi) return null;
  return configureMeta(new META.TMDB(tmdbApi, provider));
};

const parseIso8601DurationToSeconds = (duration?: string): number => {
  if (!duration || typeof duration !== 'string') return 0;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
};

const trailerScore = (params: {
  title: string;
  channelTitle?: string;
  durationSeconds: number;
  releaseYear?: string;
}): number => {
  const title = String(params.title || '').toLowerCase();
  const channelTitle = String(params.channelTitle || '').toLowerCase();
  const year = String(params.releaseYear || '').trim();

  let score = 0;

  if (title.includes('official trailer')) score += 140;
  else if (title.includes('trailer')) score += 100;

  if (title.includes('official')) score += 25;

  if (year && title.includes(year)) score += 12;

  if (
    title.includes('teaser') ||
    title.includes('clip') ||
    title.includes('behind the scenes') ||
    title.includes('featurette') ||
    title.includes('interview') ||
    title.includes('tv spot') ||
    title.includes('short') ||
    title.includes('promo') ||
    title.includes('reaction')
  ) {
    score -= 180;
  }

  if (channelTitle.includes('trailers')) score += 20;

  if (params.durationSeconds > 0) {
    if (params.durationSeconds < 45) score -= 220;
    else if (params.durationSeconds < 75) score -= 100;
    else if (params.durationSeconds >= 75 && params.durationSeconds <= 260) score += 30;
    else if (params.durationSeconds > 900) score -= 50;
  }

  return score;
};

const fetchTmdbOfficialTrailer = async (
  id: string,
  type?: string,
): Promise<string | null> => {
  if (!tmdbApi) return null;

  try {
    const tmdbType = String(type || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${tmdbType}/${id}/videos?api_key=${tmdbApi}&language=en-US`;
    const response = await axios.get(url);
    const results = Array.isArray(response?.data?.results) ? response.data.results : [];

    const ranked = results
      .filter(
        (row: any) => String(row?.site || '').toLowerCase() === 'youtube' && row?.key,
      )
      .map((row: any) => {
        const trailerType = String(row?.type || '').toLowerCase();
        const trailerName = String(row?.name || '').toLowerCase();
        let score = 0;

        if (trailerType === 'trailer') score += 140;
        else score -= 80;

        if (row?.official === true) score += 60;
        if (trailerName.includes('official')) score += 25;

        if (
          trailerType.includes('teaser') ||
          trailerType.includes('clip') ||
          trailerType.includes('behind the scenes') ||
          trailerType.includes('featurette') ||
          trailerName.includes('teaser') ||
          trailerName.includes('clip') ||
          trailerName.includes('behind the scenes') ||
          trailerName.includes('featurette') ||
          trailerName.includes('tv spot')
        ) {
          score -= 220;
        }

        return {
          key: String(row.key),
          score,
          publishedAt:
            Date.parse(String(row?.published_at || row?.publishedAt || '')) || 0,
        };
      })
      .sort((a: any, b: any) => b.score - a.score || b.publishedAt - a.publishedAt);

    const best = ranked[0];
    if (!best || best.score <= 0) return null;
    return `https://www.youtube.com/watch?v=${best.key}`;
  } catch (error: any) {
    const status = error?.response?.status;
    if (status && status !== 404) {
      console.warn(
        `Error fetching TMDB official trailer (HTTP ${status}):`,
        error?.message || error,
      );
    }
    return null;
  }
};

const extractYouTubeVideoId = (value: string): string | null => {
  if (!value) return null;

  const raw = String(value).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (url.hostname.includes('youtube.com')) {
      const fromV = url.searchParams.get('v') || '';
      if (/^[a-zA-Z0-9_-]{11}$/.test(fromV)) return fromV;

      const parts = url.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => p === 'embed' || p === 'shorts');
      if (idx >= 0 && parts[idx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])) {
        return parts[idx + 1];
      }
    }
  } catch {
    // ignore parse errors
  }

  const fallback = raw.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/i);
  return fallback ? fallback[1] : null;
};

const getYouTubeWatchUrl = (value: string): string | null => {
  const id = extractYouTubeVideoId(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
};

const hasForbiddenTrailerText = (value: string): boolean => {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('teaser') ||
    text.includes('clip') ||
    text.includes('behind the scenes') ||
    text.includes('featurette') ||
    text.includes('tv spot') ||
    text.includes('promo') ||
    text.includes('interview') ||
    text.includes('short')
  );
};

const chooseOfficialTrailerFromExisting = async (
  payload: any,
): Promise<string | null> => {
  const candidates: Array<{ url: string; score: number }> = [];

  const pushCandidate = (rawUrl: any, name?: any, type?: any, official?: any) => {
    const url = getYouTubeWatchUrl(String(rawUrl || ''));
    if (!url) return;

    const lowerName = String(name || '').toLowerCase();
    const lowerType = String(type || '').toLowerCase();
    let score = 0;

    if (lowerType === 'trailer') score += 120;
    if (lowerName.includes('official trailer')) score += 100;
    else if (lowerName.includes('trailer')) score += 60;
    if (official === true || lowerName.includes('official')) score += 25;

    if (hasForbiddenTrailerText(lowerName) || hasForbiddenTrailerText(lowerType)) {
      score -= 250;
    }

    if (url.includes('/shorts/')) score -= 400;

    candidates.push({ url, score });
  };

  if (typeof payload === 'string') {
    pushCandidate(payload);
  } else if (Array.isArray(payload)) {
    for (const row of payload.slice(0, 12)) {
      if (typeof row === 'string') pushCandidate(row);
      else if (row && typeof row === 'object')
        pushCandidate(
          row.url || row.link || row.id || row.key,
          row.name || row.title,
          row.type,
          row.official,
        );
    }
  } else if (payload && typeof payload === 'object') {
    pushCandidate(
      payload.url || payload.link || payload.id || payload.key,
      payload.name || payload.title,
      payload.type,
      payload.official,
    );
  }

  const ranked = candidates.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0) return null;
  return best.url;
};

const attachBestTrailer = async (info: any, id: string, type?: string) => {
  if (!info || typeof info !== 'object') return;

  const tmdbTrailer = await fetchTmdbOfficialTrailer(id, type);
  if (tmdbTrailer) {
    info.trailer = tmdbTrailer;
    return;
  }

  const existingTrailer = await chooseOfficialTrailerFromExisting(info.trailer);
  if (existingTrailer) {
    info.trailer = existingTrailer;
    return;
  }

  delete info.trailer;

  if (!shouldLookupTrailers) return;

  const title = info.title || info.name;
  const year = info.releaseDate || info.firstAirDate;
  const yearStr = year ? new Date(year).getFullYear().toString() : undefined;
  const youtubeTrailer = await fetchYouTubeTrailer(title, yearStr);
  if (youtubeTrailer) {
    info.trailer = youtubeTrailer;
  }
};

const fetchYouTubeTrailer = async (
  title: string,
  year?: string,
): Promise<string | null> => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  try {
    const youtube = google.youtube({
      version: 'v3',
      auth: apiKey,
    });

    const query = `${title} ${year ? year : ''} trailer`.trim();
    const response = await youtube.search.list({
      part: ['snippet'],
      q: query,
      type: ['video'],
      maxResults: 8,
      order: 'relevance',
    });

    const items = response.data.items;
    if (items && items.length > 0) {
      const candidates = items
        .map((item) => ({
          id: item.id?.videoId,
          title: item.snippet?.title || '',
          channelTitle: item.snippet?.channelTitle || '',
        }))
        .filter((item) => item.id);

      if (!candidates.length) return null;

      const videoDetails = await youtube.videos.list({
        part: ['contentDetails'],
        id: candidates.map((candidate) => candidate.id as string),
      });

      const durationById = new Map<string, number>();
      for (const detail of videoDetails.data.items || []) {
        const detailId = detail.id || '';
        const duration = parseIso8601DurationToSeconds(
          detail.contentDetails?.duration || '',
        );
        if (detailId) durationById.set(detailId, duration);
      }

      const ranked = candidates
        .map((candidate) => {
          const id = candidate.id as string;
          const score = trailerScore({
            title: candidate.title,
            channelTitle: candidate.channelTitle,
            durationSeconds: durationById.get(id) || 0,
            releaseYear: year,
          });
          return { ...candidate, score };
        })
        .sort((a, b) => b.score - a.score);

      const best = ranked[0];
      if (best && best.score > -40) {
        return `https://www.youtube.com/watch?v=${best.id}`;
      }
    }
  } catch (error) {
    console.error('Error fetching YouTube trailer:', error);
  }
  return null;
};

// Map of anime providers that have direct routes in this API
const ANIME_PROVIDER_ROUTES: Record<string, string> = {
  animesalt: '/anime/animesalt',
};

const resolveMovieProvider = (provider?: string) => {
  if (!provider) return undefined;
  switch (provider.toLowerCase()) {
    case 'flixhq':
      return undefined;
    default:
      return undefined;
  }
};

// Some HDHub4u pages number a standalone special inside the season's episode
// list, shifting every later episode by +1 relative to TMDB (e.g. "India's Got
// Latent" S2 labels the Netflix-only "Varun Dhawan" episode as EPISODE 6, so
// TMDB S2E6 "Rakhi Sawant" lives at hdstream EP7). This map translates the
// requested TMDB episode: when requestedEpisode >= shiftFrom, look for provider
// episode = requestedEpisode + shift. Keyed by TMDB numeric id, then season.
const HDSTREAM_TV_EPISODE_SHIFTS: Record<string, Record<number, { shiftFrom: number; shift: number }>> = {
  '262838': { 2: { shiftFrom: 6, shift: 1 } },
};

const resolveHdstream4uTvEpisodeId = async (
  request: FastifyRequest,
  id: string,
  type: string,
  season?: number,
  episode?: number,
  titleInfo?: any,
): Promise<string> => {
  const requestedSeason = Number(season || 1);
  const requestedEpisode = Number(episode || 1);
  const episodeShift = HDSTREAM_TV_EPISODE_SHIFTS[String(id || '').trim()]?.[requestedSeason];
  const shiftedEpisode =
    episodeShift && requestedEpisode >= episodeShift.shiftFrom
      ? requestedEpisode + episodeShift.shift
      : requestedEpisode;

  let targetId = String(id || '').trim();
  try {
    const tmdbInfoRes = titleInfo ? null : await request.server.inject({
      method: 'GET',
      url: `/meta/tmdb/info/${encodeURIComponent(targetId)}?type=${encodeURIComponent(type || 'tv')}`,
    });
    const tmdbInfo = titleInfo || safeJsonParse(tmdbInfoRes?.body || '{}');
    const titleCandidates = getTitleCandidatesFromMedia(tmdbInfo);
    const preferredYear = Number(
      String(tmdbInfo?.releaseDate || tmdbInfo?.first_air_date || '').slice(0, 4),
    );
    const targetSeasonLabel = `season ${requestedSeason}`;
    const searchResults = await Promise.all(
      titleCandidates.map((title) => searchHdhub4uByTitle(`${title} ${targetSeasonLabel}`).catch(() => [])),
    );
    for (const [index, results] of searchResults.entries()) {
      try {
        const title = titleCandidates[index];
        const normTitle = normalizeText(title);
        const ranked = results
          .map((entry) => {
            const score = titleMatchScore(entry.title, titleCandidates);
            const normalizedEntry = normalizeText(entry.title);
            const startsWithBonus =
              normTitle && normalizedEntry.startsWith(normTitle) ? 400 : 0;
            const trailingAfterTitle =
              normTitle && normalizedEntry.startsWith(normTitle)
                ? normalizedEntry.slice(normTitle.length).trim()
                : '';
            const foreignSuffixPenalty =
              trailingAfterTitle &&
              !/^(?:\(?season\b|s\d+\b|series\b|web\b|all\s+episodes\b|bluray\b|webrip\b|web-dl\b|hindi\b|english\b|dual\b|x264\b|480p\b|720p\b|1080p\b|2160p\b|dd5\.1\b|\|)/i.test(
                trailingAfterTitle,
              )
                ? -550
                : 0;
            const seasonHit = new RegExp(`season[\\s-]*${requestedSeason}(?:\\b|-)`, 'i').test(
              `${entry.title} ${entry.url}`,
            )
              ? 300
              : -200;
            const yearBonus =
              preferredYear &&
              new RegExp(`(^|[^\\d])${preferredYear}([^\\d]|$)`, 'i').test(entry.title)
                ? 120
                : 0;
            return {
              url: entry.url,
              score:
                score + seasonHit + yearBonus + startsWithBonus + foreignSuffixPenalty,
            };
          })
          .filter((entry) => entry.score >= 700)
          .sort((a, b) => b.score - a.score);
        if (ranked[0]?.url) {
          targetId = ranked[0].url;
          break;
        }
      } catch {
        // fall back to generic info lookup below
      }
    }
  } catch {
    // fall through to generic info lookup below
  }

  // If no season-specific provider page matched, avoid the slow numeric-ID
  // fallback. It cannot resolve a real HDStream episode and only adds delay.
  if (/^\d+$/.test(targetId)) return '';

  const infoRes = await request.server.inject({
    method: 'GET',
    url: `/movies/hdstream4u/info?id=${encodeURIComponent(targetId)}&type=${encodeURIComponent(type || 'tv')}`,
  });
  if (infoRes.statusCode >= 400) return '';
  const payload = safeJsonParse(infoRes.body || '{}');
  const entries = Array.isArray(payload?.episodes) ? payload.episodes : [];
  const isBonusEntry = (entry: any): boolean =>
    String(entry?.category || '').toLowerCase() === 'bonus' ||
    Number(entry?.seasonNumber) === 0 ||
    /bonus/i.test(String(entry?.seasonName || entry?.title || ''));
  const numberedEntries = entries.filter((entry: any) => !isBonusEntry(entry));
  const getEntrySeason = (entry: any): number => {
    const value = Number(entry?.seasonNumber ?? entry?.season ?? 1);
    return Number.isFinite(value) && value > 0 ? value : 1;
  };
  const match = entries.find(
    (entry: any) =>
      !isBonusEntry(entry) &&
      getEntrySeason(entry) === requestedSeason &&
      Number(entry?.episodeNumber || entry?.episode || entry?.number || 0) === shiftedEpisode,
  );
  const normalizeEpisodeId = (entry: any): string => {
    const raw = String(entry?.episodeId || entry?.url || entry?.id || '').trim();
    // Preserve the episode's own HubStream link so TV playback can try the
    // matching HubStream episode before falling back to HDStream4u.
    return raw;
  };

  if (match) return normalizeEpisodeId(match);

  // Bonus episodes are intentionally NOT resolved here. The frontend surfaces
  // them in a dedicated Bonus tab and plays them through the provider's direct
  // watch endpoint (episodeId=...hubstream.art/#...). Mapping a numbered
  // episode the provider does not have onto a Bonus episode made bonus content
  // leak into the normal season tab, so that fallback is disabled.

  // HDStream4u season pages sometimes expose only the requested season's episodes
  // but still label every row as season 1. When that happens, fall back to episode
  // number matching so TMDB SxEy requests can still resolve.
  const episodeOnlyMatches = numberedEntries.filter(
    (entry: any) =>
      Number(entry?.episodeNumber || entry?.episode || entry?.number || 0) === shiftedEpisode,
  );
  if (episodeOnlyMatches.length === 1) {
    return normalizeEpisodeId(episodeOnlyMatches[0]);
  }

  const seasonValues = Array.from(
    new Set(
      numberedEntries
        .map((entry: any) => Number(entry?.seasonNumber || entry?.season || 1))
        .filter((value: number) => Number.isFinite(value) && value > 0),
    ),
  );
  if (seasonValues.length === 1) {
    const fallback = episodeOnlyMatches[0];
    if (fallback) return normalizeEpisodeId(fallback);
  }

  return '';
};




const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const MOVIE_WATCH_ATTEMPT_TIMEOUT_MS = Number(
  process.env.MOVIE_WATCH_ATTEMPT_TIMEOUT_MS || (IS_PRODUCTION ? 7000 : 5000),
);

const parseLocsFromXml = (xml: string): string[] => {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
};

const parseEpisodeNumber = (value: string): number | undefined => {
  const match = value.match(/episode-(\d+)/i) || value.match(/episode\s*(\d+)/i);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : undefined;
};

const extractSlug = (value: string): string => {
  const clean = value.split('?')[0].replace(/\/$/, '');
  const last = clean.split('/').pop() || clean;
  return last.replace(/\.html$/i, '');
};

const toAbsoluteUrl = (base: string, maybeUrl: string): string => {
  if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
  return `${base.replace(/\/$/, '')}/${String(maybeUrl || '').replace(/^\//, '')}`;
};

const normalizeText = (value: string): string =>
  String(value || '')
    .replace(/&#8217;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const safeJsonParse = (value: string) => {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
};

const toGenreNames = (genres: unknown): string[] => {
  if (!Array.isArray(genres)) return [];
  return genres
    .map((genre: any) => {
      if (typeof genre === 'string') return genre;
      if (genre && typeof genre.name === 'string') return genre.name;
      return '';
    })
    .filter(Boolean)
    .map((genre) => normalizeText(genre));
};

const getTitleCandidatesFromMedia = (media: any): string[] => {
  return [media?.title, media?.name, media?.originalTitle, media?.originalName]
    .filter((v, i, arr) => typeof v === 'string' && v.trim() && arr.indexOf(v) === i)
    .map((v) => String(v).trim());
};

const titleMatchScore = (candidateTitle: string, queries: string[]): number => {
  const candidate = normalizeText(candidateTitle);
  if (!candidate) return -1;
  let score = 0;
  for (const query of queries) {
    const normQuery = normalizeText(query);
    if (!normQuery) continue;
    if (candidate === normQuery) score = Math.max(score, 1000);
    else if (candidate.includes(normQuery) || normQuery.includes(candidate))
      score = Math.max(score, 700);
  }
  return score;
};

const resolveTmdbExternalImdbId = async (id: string, type?: string): Promise<string> => {
  const sourceId = String(id || '').trim();
  if (!sourceId) return '';
  if (/^tt\d+$/i.test(sourceId)) return sourceId;
  if (!/^\d+$/.test(sourceId) || !tmdbApi) return '';

  const mediaTypes = Array.from(
    new Set([type === 'tv' ? 'tv' : 'movie', type === 'tv' ? 'movie' : 'tv']),
  );

  for (const mediaType of mediaTypes) {
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/${mediaType}/${sourceId}/external_ids?api_key=${tmdbApi}`,
      );
      const imdbId = String(response?.data?.imdb_id || '').trim();
      if (/^tt\d+$/i.test(imdbId)) return imdbId;
    } catch {
      // Try the next TMDB media type.
    }
  }

  return '';
};

// ---------------------------------------------------------------------------
// Exact anime ID bridging: TMDB -> AniList via the Fribb anime-lists dataset
// (the same dataset that powers ani.zip). This avoids fragile title matching.
// The list ships themoviedb_id + tvdb_id per anilist_id, so we can resolve an
// exact AniList id straight from a TMDB id + media type. Loaded once in memory.
// ---------------------------------------------------------------------------
const ANIME_MAPPING_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';

let animeIdIndex: Record<string, number> | null = null;
let animeIdIndexLoading: Promise<Record<string, number> | null> | null = null;

const loadAnimeIdIndex = async (): Promise<Record<string, number> | null> => {
  if (animeIdIndex) return animeIdIndex;
  if (animeIdIndexLoading) return animeIdIndexLoading;

  animeIdIndexLoading = (async () => {
    try {
      const { data } = await axios.get(ANIME_MAPPING_URL, {
        timeout: 30000,
        responseType: 'json',
      });
      if (!Array.isArray(data)) return null;

      const index: Record<string, number> = {};
      for (const entry of data) {
        const anilistId = Number(entry?.anilist_id);
        if (!Number.isInteger(anilistId) || anilistId <= 0) continue;

        const tm = entry?.themoviedb_id;
        if (tm && typeof tm === 'object') {
          if (tm.tv != null) index[`tv:${tm.tv}`] = anilistId;
          const movieIds = Array.isArray(tm.movie)
            ? tm.movie
            : tm.movie != null
              ? [tm.movie]
              : [];
          for (const movieId of movieIds) {
            if (movieId != null) index[`movie:${movieId}`] = anilistId;
          }
        }
        if (entry?.tvdb_id != null) index[`tvdb:${entry.tvdb_id}`] = anilistId;
      }
      animeIdIndex = index;
      return index;
    } catch (err: any) {
      console.warn(`[anime-mapping] failed to load index: ${err?.message || err}`);
      return null;
    } finally {
      animeIdIndexLoading = null;
    }
  })();

  return animeIdIndexLoading;
};

const resolveAniListIdByExactMapping = async (
  id: string,
  type?: string,
): Promise<string | null> => {
  const sourceId = String(id || '').trim();
  if (!sourceId || !/^\d+$/.test(sourceId)) return null;

  const index = await loadAnimeIdIndex();
  if (!index) return null;

  const primaryType = type === 'tv' ? 'tv' : 'movie';
  const secondaryType = primaryType === 'tv' ? 'movie' : 'tv';

  for (const key of [`${primaryType}:${sourceId}`, `${secondaryType}:${sourceId}`]) {
    const found = index[key];
    if (found != null) return String(found);
  }
  return null;
};

const isAnimeLikeMovie = (media: any): boolean => {
  const genreNames = toGenreNames(media?.genres);
  const hasAnimationGenre = genreNames.some((genre) => genre.includes('animation'));
  const hasAnimeGenre = genreNames.some((genre) => genre.includes('anime'));
  const lang = normalizeText(
    String(media?.originalLanguage || media?.original_language || ''),
  );
  const isJapanese = lang === 'ja';
  return hasAnimeGenre || (hasAnimationGenre && isJapanese);
};

const normalizeSlug = (value: string): string =>
  String(value || '')
    .toLowerCase()
    .replace(/\.html$/i, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const stripTrailingYear = (value: string): string => value.replace(/-(19|20)\d{2}$/i, '');

const HDHUB4U_POST_SITEMAP_URL = 'https://new6.hdhub4u.cl/post-sitemap.xml';
let hdhub4uSitemapCache: { urls: string[]; expiresAt: number } | null = null;

const fetchHdhub4uSitemapUrls = async (): Promise<string[]> => {
  if (hdhub4uSitemapCache && hdhub4uSitemapCache.expiresAt > Date.now()) {
    return hdhub4uSitemapCache.urls;
  }

  const response = await axios.get(HDHUB4U_POST_SITEMAP_URL, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    responseType: 'text',
  });
  const xml = String(response.data || '');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map((match) => String(match[1] || '').trim())
    .filter((value) => /^https?:\/\//i.test(value));

  hdhub4uSitemapCache = {
    urls,
    expiresAt: Date.now() + 30 * 60 * 1000,
  };

  return urls;
};

const searchHdhub4uByTitle = async (
  query: string,
): Promise<Array<{ title: string; url: string }>> => {
  const apiUrl = new URL('https://search.pingora.fyi/collections/post/documents/search');
  apiUrl.searchParams.set('q', query);
  apiUrl.searchParams.set('query_by', 'post_title,category,stars,director,imdb_id');
  apiUrl.searchParams.set('query_by_weights', '4,2,2,2,4');
  apiUrl.searchParams.set('sort_by', 'sort_by_date:desc');
  apiUrl.searchParams.set('limit', '10');
  apiUrl.searchParams.set('highlight_fields', 'none');
  apiUrl.searchParams.set('use_cache', 'true');
  apiUrl.searchParams.set('page', '1');
  apiUrl.searchParams.set('analytics_tag', new Date().toISOString().slice(0, 10));

  const response = await axios.get(apiUrl.toString(), {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://new6.hdhub4u.cl',
      Referer: `https://new6.hdhub4u.cl/?s=${encodeURIComponent(query)}`,
    },
  });

  const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
  return hits
    .map((hit: any) => hit?.document || {})
    .map((doc: any) => ({
      title: String(doc?.post_title || '').trim(),
      url: String(doc?.permalink || doc?.url || '').trim(),
    }))
    .filter((entry: any) => entry.title && entry.url);
};

const findBestHdhub4uUrl = async (
  titleCandidates: string[],
  year?: number,
): Promise<string> => {
  const urls = await fetchHdhub4uSitemapUrls();
  const ranked = urls
    .map((url) => {
      const slug = stripTrailingYear(normalizeSlug(new URL(url).pathname.split('/').filter(Boolean).pop() || ''));
      const score = titleMatchScore(slug.replace(/-/g, ' '), titleCandidates);
      const yearBonus = year && new RegExp(`(^|-)${year}(-|$)`, 'i').test(url) ? 120 : 0;
      const tvBonus = /season|episode|series|web-series/i.test(url) ? 30 : 0;
      return { url, score: score + yearBonus + tvBonus };
    })
    .filter((entry) => entry.score >= 700)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.url || '';
};

const extractHdstreamMovieCandidateIds = (infoPayload: any): string[] => {
  const servers = Array.isArray(infoPayload?.servers) ? infoPayload.servers : [];
  const episodes = Array.isArray(infoPayload?.episodes) ? infoPayload.episodes : [];
  const out: string[] = [];
  const push = (value: any) => {
    const clean = String(value || '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  };

  servers.forEach((server: any) => {
    const url = String(server?.url || '').trim();
    const fileCode = String(server?.fileCode || '').trim();
    if (/(?:hdstream4u|morencius)\.com\/file\//i.test(url)) {
      push(fileCode || url);
    }
  });

  servers.forEach((server: any) => {
    const url = String(server?.url || '').trim();
    if (/hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(url)) push(url);
  });

  episodes.forEach((episode: any) => {
    push(episode?.episodeId);
    push(episode?.url);
  });

  return out;
};

const withSoftTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  return await Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
};

const resolveHdstream4uEpisodeId = async (
  request: FastifyRequest,
  mediaInfo: any,
): Promise<string> => {
  const mediaIdHint = String(mediaInfo?.tmdbId || mediaInfo?.id || '').trim();
  const mediaTypeHint = String(mediaInfo?.type || mediaInfo?.media_type || 'movie').trim();

  if (mediaIdHint) {
    const directInfoRes = await request.server.inject({
      method: 'GET',
      url: `/movies/hdstream4u/info?id=${encodeURIComponent(mediaIdHint)}&type=${encodeURIComponent(mediaTypeHint)}`,
    });
    if (directInfoRes.statusCode < 400) {
      const directInfoPayload = safeJsonParse(directInfoRes.body || '{}');
      const directCandidates = extractHdstreamMovieCandidateIds(directInfoPayload);
      if (directCandidates.length) return directCandidates[0];
    }
  }

  const titleCandidates = getTitleCandidatesFromMedia(mediaInfo);
  if (!titleCandidates.length) return '';

  const preferredYear = Number(String(mediaInfo?.releaseDate || mediaInfo?.first_air_date || '').slice(0, 4));
  const searchResults = await Promise.all(
    titleCandidates.map((title) => searchHdhub4uByTitle(title).catch(() => [])),
  );
  let matchedUrl = searchResults
    .flat()
    .map((entry) => {
      const score = titleMatchScore(entry.title, titleCandidates);
      const yearBonus = preferredYear && new RegExp(`(^|[^\\d])${preferredYear}([^\\d]|$)`, 'i').test(entry.title)
        ? 120
        : 0;
      const tvLike = /season|episode|series|web[\s-]*series/i.test(entry.title + ' ' + entry.url);
      const typeBonus = mediaInfo?.type === 'tv' || mediaInfo?.media_type === 'tv'
        ? (tvLike ? 80 : -40)
        : (tvLike ? -60 : 40);
      return { url: entry.url, score: score + yearBonus + typeBonus };
    })
    .filter((entry) => entry.score >= 700)
    .sort((a, b) => b.score - a.score)[0]?.url || '';

  if (!matchedUrl) {
    const sitemapUrl = await findBestHdhub4uUrl(
      titleCandidates,
      Number.isFinite(preferredYear) ? preferredYear : undefined,
    );
    matchedUrl = sitemapUrl;
  }
  if (!matchedUrl) return '';

  const infoRes = await request.server.inject({
    method: 'GET',
    url: `/movies/hdstream4u/info?id=${encodeURIComponent(matchedUrl)}`,
  });
  if (infoRes.statusCode >= 400) return '';

  const infoPayload = safeJsonParse(infoRes.body || '{}');
  const servers = Array.isArray(infoPayload?.servers) ? infoPayload.servers : [];
  const isTv =
    String(mediaInfo?.type || mediaInfo?.media_type || '').toLowerCase() === 'tv';
  const directFileServer = servers.find((server: any) =>
    /(?:hdstream4u|morencius)\.com\/file\//i.test(String(server?.url || '')),
  );
  const primary =
    servers.find((server: any) => /watch\s*online/i.test(String(server?.name || ''))) ||
    servers.find((server: any) => /^https?:\/\//i.test(String(server?.url || ''))) ||
    servers[0];
  const fallbackEpisode = Array.isArray(infoPayload?.episodes) ? infoPayload.episodes[0] : null;

  if (!isTv) {
    // HDStream's direct Player-2 file links can be present before their raw
    // extractor is ready. The Watch Online/Hubstream player is the reliable
    // playable candidate when both are listed.
    const directFileId = String(
      directFileServer?.fileCode || directFileServer?.url || '',
    ).trim();
    if (directFileId) return directFileId;

    const watchOnline = servers.find((server: any) =>
      /hubstream\.(?:art|pw|cc|ink|foo|boo)\/#/i.test(String(server?.url || '')),
    );
    if (watchOnline?.url) return String(watchOnline.url).trim();

    const providerMediaId = String(
      infoPayload?.id || matchedUrl || infoPayload?.url || '',
    ).trim();
    if (providerMediaId) return providerMediaId;
  }

  return String(
    primary?.url ||
      primary?.fileCode ||
      primary?.id ||
      fallbackEpisode?.episodeId ||
      fallbackEpisode?.url ||
      '',
  ).trim();
};




const buildDramaSlugVariants = (dramaSlug: string): string[] => {
  const base = normalizeSlug(dramaSlug);
  const set = new Set<string>();
  const push = (v?: string) => {
    const clean = v ? normalizeSlug(v) : '';
    if (clean) set.add(clean);
  };

  push(base);
  push(stripTrailingYear(base));
  push(base.replace(/-season-\d+$/i, ''));
  push(base.replace(/-s\d+$/i, ''));
  push(base.replace(/-part-\d+$/i, ''));
  push(stripTrailingYear(base.replace(/-season-\d+$/i, '')));
  push(base.replace(/-\d{4}-[a-z]{2,4}$/i, ''));
  push(base.replace(/-[a-z]{2,4}$/i, ''));
  push(base.replace(/-\d{4}$/i, ''));

  const tokens = base.split('-').filter(Boolean);
  if (tokens.length >= 2) push(tokens.slice(0, 2).join('-'));
  if (tokens.length >= 1) push(tokens[0]);

  return [...set];
};

const convertTmdbImagesToUrls = (data: any) => {
  if (!data || typeof data !== 'object') return data;

  const convertPath = (path: string) => {
    if (!path || typeof path !== 'string') return null;
    if (path.startsWith('http')) return path;
    return `https://image.tmdb.org/t/p/w500${path}`;
  };

  if (data.poster_path) data.image = convertPath(data.poster_path);
  if (data.backdrop_path) data.cover = convertPath(data.backdrop_path);
  if (data.profile_path) data.image = convertPath(data.profile_path);

  if (Array.isArray(data.seasons)) {
    data.seasons = data.seasons.map((season: any) => {
      if (season.poster_path) season.image = convertPath(season.poster_path);
      return season;
    });
  }

  if (Array.isArray(data.episodes)) {
    data.episodes = data.episodes.map((episode: any) => {
      if (episode.still_path) episode.image = convertPath(episode.still_path);
      return episode;
    });
  }

  return data;
};




const buildAnimesaltTmdbInfo = async (request: any, id: string, type: string) => {
  const baseTmdb = new META.TMDB(tmdbApi);
  const fetchBase = async () => {
    const res = await baseTmdb.fetchMediaInfo(id, type);
    if (res && typeof res === 'object') {
      delete (res as any).cast;
      delete (res as any).characters;
      delete (res as any).recommendations;
      delete (res as any).similar;
    }
    return res;
  };

  const baseInfo: any = redis
    ? await cache.fetch(
        redis as any,
        `tmdb:info:${type}:${id}:trailer-v3`,
        fetchBase,
        REDIS_TTL,
      )
    : await fetchBase();

  await attachBestTrailer(baseInfo, id, type);

  const titleCandidates = getTitleCandidatesFromMedia(baseInfo);
  if (!titleCandidates.length) return baseInfo;

  const yearGuess = Number(
    String(baseInfo?.releaseDate || baseInfo?.firstAirDate || '').slice(0, 4),
  );

  // Search AnimeSalt with primary titles
  const term = titleCandidates[0];
  try {
    const searchRes = await request.server.inject({
      method: 'GET',
      url: `/anime/animesalt/${encodeURIComponent(term)}`,
    });

    if (searchRes.statusCode < 400) {
      const payload = safeJsonParse(searchRes.body || '{}');
      const results = Array.isArray(payload?.results) ? payload.results : [];

      const scored = results
        .map((item: any) => {
          const itemTitle = String(item?.title || '');
          let score = titleMatchScore(itemTitle, titleCandidates);

          if (Number.isFinite(yearGuess) && yearGuess > 1900) {
            const itemYear = Number(String(item?.releaseDate || '').slice(0, 4));
            if (itemYear === yearGuess) score += 50;
          }

          return { item, score };
        })
        .sort((a: any, b: any) => b.score - a.score);

      const pick = scored[0]?.item;
      if (pick && pick.anilistId) {
        const anilistId = String(pick.anilistId);

        if (Array.isArray(baseInfo.seasons)) {
          baseInfo.seasons = baseInfo.seasons.map((season: any) => {
            if (!Array.isArray(season.episodes)) return season;
            return {
              ...season,
              episodes: season.episodes.map((ep: any) => ({
                ...ep,
                id: `${anilistId}$episode$${ep.episode || ep.number}`,
              })),
            };
          });
        } else if (Array.isArray(baseInfo.episodes)) {
          baseInfo.episodes = baseInfo.episodes.map((ep: any) => ({
            ...ep,
            id: `${anilistId}$episode$${ep.episode || ep.number}`,
          }));
        }
        baseInfo.anilistId = anilistId;
        baseInfo.id = anilistId;
      }
    }
  } catch {
    // ignore mapping errors
  }

  convertTmdbImagesToUrls(baseInfo);
  return baseInfo;
};

const buildFlixhqTmdbInfo = async (request: any, id: string, type: string) => {
  const baseTmdb = new META.TMDB(tmdbApi);

  const fetchBase = async () => {
    let res: any = null;
    try {
      res = await baseTmdb.fetchMediaInfo(id, type);
    } catch {
      if (tmdbApi) {
        const directUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbApi}`;
        const directRes = await axios.get(directUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (directRes?.data) {
          const direct = directRes.data;
          const isTv = String(type || '').toLowerCase() === 'tv';

          let seasons = Array.isArray(direct?.seasons)
            ? direct.seasons.map((s: any) => ({
                id: String(s?.id || ''),
                name: s?.name,
                season: s?.season_number,
                image: s?.poster_path
                  ? `https://image.tmdb.org/t/p/original${s.poster_path}`
                  : null,
                episodes: [],
              }))
            : [];

          if (isTv && seasons.length) {
            const seasonDetails = await Promise.all(
              seasons
                .filter(
                  (s: any) => Number.isFinite(Number(s?.season)) && Number(s.season) >= 0,
                )
                .slice(0, 25)
                .map(async (s: any) => {
                  try {
                    const seasonNo = Number(s.season);
                    const seasonUrl = `https://api.themoviedb.org/3/tv/${id}/season/${seasonNo}?api_key=${tmdbApi}&language=en-US`;
                    const seasonRes = await axios.get(seasonUrl, {
                      headers: { 'User-Agent': 'Mozilla/5.0' },
                    });
                    const episodes = Array.isArray(seasonRes?.data?.episodes)
                      ? seasonRes.data.episodes.map((ep: any, idx: number) => {
                          const epNo = Number(
                            ep?.episode_number || ep?.number || idx + 1,
                          );
                          return {
                            id: `${id}-s${seasonNo}e${epNo}`,
                            episode: epNo,
                            number: epNo,
                            title: ep?.name || `Episode ${epNo}`,
                            season: seasonNo,
                          };
                        })
                      : [];
                    return { seasonNo, episodes };
                  } catch {
                    return null;
                  }
                }),
            );

            const bySeasonNo = new Map<number, any[]>();
            seasonDetails.forEach((entry: any) => {
              if (!entry || !Number.isFinite(Number(entry.seasonNo))) return;
              bySeasonNo.set(
                Number(entry.seasonNo),
                Array.isArray(entry.episodes) ? entry.episodes : [],
              );
            });

            seasons = seasons.map((s: any) => {
              const seasonNo = Number(s?.season || 0);
              return { ...s, episodes: bySeasonNo.get(seasonNo) || [] };
            });
          }

          const movieRuntime = Number(direct?.runtime || 0);
          const tvEpisodeRuntime =
            Array.isArray(direct?.episode_run_time) && direct.episode_run_time.length
              ? Number(direct.episode_run_time[0] || 0)
              : 0;
          const normalizedRuntime = movieRuntime > 0 ? movieRuntime : tvEpisodeRuntime;

          res = {
            id: String(direct?.id || id),
            title: direct?.title || direct?.name || 'Unknown',
            type,
            media_type: type,
            description: direct?.overview,
            image: direct?.poster_path
              ? `https://image.tmdb.org/t/p/original${direct.poster_path}`
              : null,
            cover: direct?.backdrop_path
              ? `https://image.tmdb.org/t/p/original${direct.backdrop_path}`
              : null,
            status: direct?.status,
            releaseDate: direct?.release_date || direct?.first_air_date,
            runtime: normalizedRuntime,
            duration: normalizedRuntime,
            rating: direct?.vote_average,
            genres: Array.isArray(direct?.genres)
              ? direct.genres.map((g: any) => g?.name).filter(Boolean)
              : [],
            totalEpisodes: Number(direct?.number_of_episodes || 0),
            seasons,
          };
        }
      }
    }
    if (!res) {
      throw new Error('Failed to fetch base metadata for FlixHQ mapping');
    }
    if (res && typeof res === 'object') {
      delete (res as any).cast;
      delete (res as any).characters;
      delete (res as any).recommendations;
      delete (res as any).similar;
    }
    return res;
  };

  const baseInfo: any = redis
    ? await cache.fetch(
        redis as any,
        `tmdb:info:${type}:${id}:flixhq-mapped:v3`,
        fetchBase,
        REDIS_TTL,
      )
    : await fetchBase();

  await attachBestTrailer(baseInfo, id, type);

  const titleCandidates = getTitleCandidatesFromMedia(baseInfo);
  if (!titleCandidates.length) return baseInfo;

  const yearGuess = Number(
    String(baseInfo?.releaseDate || baseInfo?.firstAirDate || '').slice(0, 4),
  );
  const expectedType = String(type || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
  const resolveAniListId = async () => {
    // 1) Prefer an exact, static ID bridge (TMDB id -> AniList id). This is the
    // robust path that eliminates title-match errors for well-mapped titles.
    try {
      const exactAnimeId = await resolveAniListIdByExactMapping(id, expectedType);
      if (exactAnimeId) return exactAnimeId;
    } catch {
      // fall back to title matching below
    }

    const queries = titleCandidates.slice(0, 2);
    for (const query of queries) {
      try {
        const anilistRes = await request.server.inject({
          method: 'GET',
          url: `/meta/anilist/${encodeURIComponent(query)}`,
        });
        if (anilistRes.statusCode >= 400) continue;
        const anilistPayload = safeJsonParse(anilistRes.body || '{}');
        const anilistRows = Array.isArray(anilistPayload?.results)
          ? anilistPayload.results
          : [];
        if (!anilistRows.length) continue;

        const picked = anilistRows
          .map((item: any) => ({
            item,
            score: titleMatchScore(
              String(item?.title || item?.name || ''),
              titleCandidates,
            ),
          }))
          .sort((a: any, b: any) => b.score - a.score)[0]?.item;
        const pickedId = String(picked?.id || '').trim();
        if (pickedId) return pickedId;
      } catch {
        continue;
      }
    }
    return null;
  };

  const animeId = await resolveAniListId();
  if (animeId) baseInfo.anilistId = animeId;

  // Build search terms, prioritizing exact titles over year variants
  const mainTerms = titleCandidates.slice(0, 2); // First 2 most relevant titles
  const searchTerms = Array.from(
    new Set([
      ...mainTerms, // Prioritize exact title matches first
      ...mainTerms.flatMap((title) =>
        Number.isFinite(yearGuess) && yearGuess > 1900 ? [`${title} ${yearGuess}`] : [],
      ),
    ]),
  ).slice(0, 4); // Limit to top 4 search terms for speed

  // Parallelize all searches instead of sequential
  const searchPromises = searchTerms.map(async (term) => {
    try {
      const searchRes = await request.server.inject({
        method: 'GET',
        url: `/movies/flixhq/${encodeURIComponent(term)}`,
      });
      if (searchRes.statusCode >= 400) return [];
      const payload = safeJsonParse(searchRes.body || '{}');
      return Array.isArray(payload?.data) ? payload.data : [];
    } catch {
      return [];
    }
  });

  const searchResults = await Promise.all(searchPromises);
  const combinedResults = searchResults.flat();

  const seen = new Set<string>();
  const deduped = combinedResults.filter((row) => {
    const key = String(row?.id || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const scored = deduped
    .map((item) => {
      const itemType = normalizeText(String(item?.type || ''));
      const itemTitle = String(item?.name || item?.title || '');
      const score =
        titleMatchScore(itemTitle, titleCandidates) +
        (itemType === expectedType ? 120 : -250) +
        (() => {
          const rowYear = Number(item?.releaseDate);
          if (
            !Number.isFinite(yearGuess) ||
            yearGuess <= 1900 ||
            !Number.isFinite(rowYear)
          )
            return 0;
          if (rowYear === yearGuess) return 30;
          if (Math.abs(rowYear - yearGuess) === 1) return 10;
          return 0;
        })() +
        (() => {
          if (expectedType !== 'tv') return 0;
          const baseSeasons = Array.isArray(baseInfo?.seasons)
            ? baseInfo.seasons.length
            : 0;
          const rowSeasons = Number(item?.seasons || 0);
          if (!baseSeasons || !rowSeasons) return 0;
          if (baseSeasons === rowSeasons) return 12;
          if (Math.abs(baseSeasons - rowSeasons) <= 1) return 5;
          return 0;
        })();
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  // Early exit if top match is perfect (exact title + correct type + correct year)
  const topMatch = scored[0];
  if (topMatch && topMatch.score > 1100) {
    // High confidence match: 1000 (exact) + 120 (type) + 30 (year) = 1150+
    const pick = topMatch.item;
    if (pick?.id) {
      try {
        const infoRes = await request.server.inject({
          method: 'GET',
          url: `/movies/flixhq/info?id=${encodeURIComponent(String(pick.id))}`,
        });
        if (infoRes.statusCode < 400) {
          const payload = safeJsonParse(infoRes.body || '{}');
          const providerEpisodes = Array.isArray(payload?.providerEpisodes)
            ? payload.providerEpisodes
            : Array.isArray(payload?.data?.providerEpisodes)
              ? payload.data.providerEpisodes
              : [];
          if (providerEpisodes.length > 0) {
            // Skip to the end of the function with early result
            const bySeasonEpisode = new Map<string, any>();
            for (const ep of providerEpisodes) {
              const seasonNum = Number(ep?.seasonNumber || 0);
              const episodeNum = Number(ep?.episodeNumber || 0);
              if (!seasonNum || !episodeNum) continue;
              bySeasonEpisode.set(`${seasonNum}:${episodeNum}`, ep);
            }

            if (Array.isArray(baseInfo?.seasons)) {
              baseInfo.seasons = baseInfo.seasons.map(
                (season: any, seasonIndex: number) => {
                  const seasonNum = Number(season?.season || seasonIndex + 1);
                  if (!Array.isArray(season?.episodes)) return season;
                  return {
                    ...season,
                    episodes: season.episodes.map(
                      (episode: any, episodeIndex: number) => {
                        const episodeNum = Number(
                          episode?.episode || episode?.number || episodeIndex + 1,
                        );
                        const mapped = bySeasonEpisode.get(`${seasonNum}:${episodeNum}`);
                        if (!mapped?.episodeId) return episode;
                        return {
                          ...episode,
                          id: mapped.episodeId,
                          url: mapped.episodeId,
                        };
                      },
                    ),
                  };
                },
              );
            }

            baseInfo.provider = 'flixhq';
            baseInfo.providerSourceId = pick.id;
            return baseInfo; // Early return on perfect match
          }
        }
      } catch {
        // Fall through to normal path
      }
    }
  }

  let pick = scored[0]?.item;
  if (!pick?.id) return baseInfo;

  try {
    const infoRes = await request.server.inject({
      method: 'GET',
      url: `/movies/flixhq/info?id=${encodeURIComponent(String(pick.id))}`,
    });

    if (infoRes.statusCode >= 400) return baseInfo;
    const payload = safeJsonParse(infoRes.body || '{}');
    const providerEpisodes = Array.isArray(payload?.providerEpisodes)
      ? payload.providerEpisodes
      : Array.isArray(payload?.data?.providerEpisodes)
        ? payload.data.providerEpisodes
        : [];

    if (!providerEpisodes.length) return baseInfo;

    const bySeasonEpisode = new Map<string, any>();
    for (const ep of providerEpisodes) {
      const seasonNum = Number(ep?.seasonNumber || 0);
      const episodeNum = Number(ep?.episodeNumber || 0);
      if (!seasonNum || !episodeNum) continue;
      bySeasonEpisode.set(`${seasonNum}:${episodeNum}`, ep);
    }

    if (Array.isArray(baseInfo?.seasons)) {
      baseInfo.seasons = baseInfo.seasons.map((season: any, seasonIndex: number) => {
        const seasonNum = Number(season?.season || seasonIndex + 1);
        if (!Array.isArray(season?.episodes)) return season;
        return {
          ...season,
          episodes: season.episodes.map((episode: any, episodeIndex: number) => {
            const episodeNum = Number(
              episode?.episode || episode?.number || episodeIndex + 1,
            );
            const mapped = bySeasonEpisode.get(`${seasonNum}:${episodeNum}`);
            if (!mapped?.episodeId) return episode;
            return {
              ...episode,
              id: mapped.episodeId,
              url: mapped.episodeId,
            };
          }),
        };
      });
    }

    baseInfo.provider = 'flixhq';
    baseInfo.providerSourceId = pick.id;
    convertTmdbImagesToUrls(baseInfo);
    return baseInfo;
  } catch {
    return baseInfo;
  }
};

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the tmdb provider: check out the provider's website @ https://www.themoviedb.org/",
      routes: ['/:query', '/info/:id', '/watch/:episodeId'],
      documentation: 'https://docs.consumet.org/#tag/tmdb',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;
    const page = (request.query as { page: number }).page;
    const tmdb = configureMeta(
      new META.TMDB(tmdbApi),
    );

    try {
      const fetchSearch = async () => {
        return await tmdb.search(query, page);
      };

       let res = redis
         ? await cache.fetch(
             redis as any,
             `tmdb:search:${query}:${page || 1}`,
             fetchSearch,
             REDIS_TTL,
           )
         : await fetchSearch();

        // Direct TMDB multi-search is authoritative now that the dead provider
        // fallback has been removed. It preserves the correct movie/TV type.
        const rescued = await getDirectTmdbSearch(query, page);
        if (rescued?.results?.length) {
          res = {
            ...rescued,
            results: rescued.results,
          };
       } else if (!res || !Array.isArray(res.results) || res.results.length === 0) {
         res = { results: [], total_results: 0, message: 'No TMDB results found' };
       }

      reply.status(200).send(res);
    } catch (err) {
      console.error('TMDB Search Error:', err);
      // Catch-all rescue
      const rescued = await getDirectTmdbSearch(query, page);
      if (rescued) {
        return reply
          .status(200)
          .send({ ...rescued, message: 'Search results rescued after fetch failure' });
      }
      reply
        .status(200)
        .send({
          results: [],
          total_results: 0,
          message: 'Search failed, please try again or check TMDB key.',
        });
    }
  });

  const getDirectTmdbSearch = async (query: string, page: number = 1) => {
    try {
      if (!tmdbApi) return null;
      const encodedQuery = encodeURIComponent(query);
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      const [multiRes, movieRes, tvRes] = await Promise.all(
        ['multi', 'movie', 'tv'].map((kind) =>
          axios.get(
            `https://api.themoviedb.org/3/search/${kind}?api_key=${tmdbApi}&query=${encodedQuery}&page=${page}`,
            { headers },
          ),
        ),
      );
      const merged = new Map<string, any>();
      for (const [kind, response] of [
        ['multi', multiRes],
        ['movie', movieRes],
        ['tv', tvRes],
      ] as const) {
        for (const item of Array.isArray(response.data?.results) ? response.data.results : []) {
          if (item?.id === undefined || item?.id === null || item.media_type === 'person') continue;
          const type = kind === 'tv' || item.media_type === 'tv' ? 'tv' : 'movie';
          const key = `${type}:${item.id}`;
          if (!merged.has(key)) merged.set(key, { ...item, media_type: type });
        }
      }
      if (merged.size) {
        const results = Array.from(merged.values());
        return {
          results: results
            .map((item: any) => ({
              id: String(item.id),
              title: item.title || item.name || 'Unknown',
              image: item.poster_path
                ? `https://image.tmdb.org/t/p/original${item.poster_path}`
                : null,
              type: item.media_type === 'tv' ? 'tv' : 'movie',
              releaseDate: item.release_date || item.first_air_date,
              rating: item.vote_average,
            })),
          total_results: Math.max(
            Number(multiRes.data?.total_results || 0),
            Number(movieRes.data?.total_results || 0),
            Number(tvRes.data?.total_results || 0),
          ),
          total_pages: Math.max(
            Number(multiRes.data?.total_pages || 0),
            Number(movieRes.data?.total_pages || 0),
            Number(tvRes.data?.total_pages || 0),
          ),
        };
      }
    } catch (err) {
      console.error('Direct TMDB Search Error:', err);
    }
    return null;
  };

  const getAlternateTmdbType = (type: string) =>
    String(type || '').toLowerCase() === 'tv' ? 'movie' : 'tv';

  const fetchDirectTmdbPayload = async (id: string, type: string) => {
    const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbApi}`;
    return axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    });
  };

  const getDirectTmdbInfo = async (id: string, type: string, includeSeasons = false) => {
    try {
      if (!tmdbApi) return null;

      let resolvedType = String(type || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
      let res: any = null;

      try {
        res = await fetchDirectTmdbPayload(id, resolvedType);
      } catch (err: any) {
        const status = Number(err?.response?.status || 0);
        if (status === 404) {
          const alternateType = getAlternateTmdbType(resolvedType);
          try {
            res = await fetchDirectTmdbPayload(id, alternateType);
            resolvedType = alternateType;
          } catch (altErr: any) {
            const altStatus = Number(altErr?.response?.status || 0);
            if (altStatus !== 404) {
              console.error('Direct TMDB Fetch Error:', altErr);
            }
            return null;
          }
        } else {
          console.error('Direct TMDB Fetch Error:', err);
          return null;
        }
      }

      if (res.data) {
        const isTv = resolvedType === 'tv';
        const movieRuntime = Number(res.data.runtime || 0);
        const tvEpisodeRuntime =
          Array.isArray(res.data.episode_run_time) && res.data.episode_run_time.length
            ? Number(res.data.episode_run_time[0] || 0)
            : 0;
        const normalizedRuntime = movieRuntime > 0 ? movieRuntime : tvEpisodeRuntime;
        let seasons = Array.isArray(res.data.seasons)
          ? res.data.seasons.map((s: any) => ({
              id:
                s?.id !== undefined && s?.id !== null
                  ? String(s.id)
                  : `${id}-season-${s?.season_number ?? ''}`,
              name: s.name,
              season: s.season_number,
              image: s.poster_path
                ? `https://image.tmdb.org/t/p/original${s.poster_path}`
                : null,
              episodes: [],
            }))
          : [];

        if (isTv && includeSeasons && seasons.length) {
          const seasonFetches = seasons
            .filter(
              (s: any) => Number.isFinite(Number(s?.season)) && Number(s.season) >= 0,
            )
            .slice(0, 25)
            .map(async (s: any) => {
              try {
                const seasonNo = Number(s.season);
                const seasonUrl = `https://api.themoviedb.org/3/tv/${id}/season/${seasonNo}?api_key=${tmdbApi}&language=en-US`;
                const seasonRes = await axios.get(seasonUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  timeout: 5000,
                });
                const episodes = Array.isArray(seasonRes?.data?.episodes)
                  ? seasonRes.data.episodes.map((ep: any, idx: number) => {
                      const epNo = Number(ep?.episode_number || ep?.number || idx + 1);
                      return {
                        id: `${id}-s${seasonNo}e${epNo}`,
                        episode: epNo,
                        number: epNo,
                        title: ep?.name || `Episode ${epNo}`,
                        season: seasonNo,
                      };
                    })
                  : [];
                return { seasonNo, episodes };
              } catch {
                return null;
              }
            });

          const seasonDetails = await Promise.all(seasonFetches);
          const bySeasonNo = new Map<number, any[]>();
          seasonDetails.forEach((entry: any) => {
            if (!entry || !Number.isFinite(Number(entry.seasonNo))) return;
            bySeasonNo.set(
              Number(entry.seasonNo),
              Array.isArray(entry.episodes) ? entry.episodes : [],
            );
          });

          seasons = seasons.map((s: any) => {
            const seasonNo = Number(s?.season || 0);
            return { ...s, episodes: bySeasonNo.get(seasonNo) || [] };
          });
        }

        return {
          id:
            res.data?.id !== undefined && res.data?.id !== null
              ? String(res.data.id)
              : String(id),
          title: res.data.title || res.data.name || 'Unknown',
          type: resolvedType,
          media_type: resolvedType,
          description: res.data.overview,
          image: `https://image.tmdb.org/t/p/original${res.data.poster_path}`,
          cover: `https://image.tmdb.org/t/p/original${res.data.backdrop_path}`,
          status: res.data.status,
          releaseDate: res.data.release_date || res.data.first_air_date,
          runtime: normalizedRuntime,
          duration: normalizedRuntime,
          rating: res.data.vote_average,
          genres: res.data.genres?.map((g: any) => g.name) || [],
          totalEpisodes:
            res.data.number_of_episodes ||
            (res.data.episodes ? res.data.episodes.length : 0),
          seasons,
          // Minimal info to keep UI working
        };
      }
    } catch (err) {
      console.error('Direct TMDB Fetch Error:', err);
    }
    return null;
  };

  const getRequestedSeason = async (request: FastifyRequest, reply: FastifyReply, id: string) => {
    const query = request.query as { type?: string; season?: string; details?: string; provider?: string };
    if (query.type !== 'tv' || query.details !== 'true' || query.season === undefined || query.provider) return false;
    const season = Number(query.season);
    if (!/^\d+$/.test(id || '') || !/^\d+$/.test(query.season) || !Number.isSafeInteger(season)) {
      reply.status(400).send({ message: 'Invalid TMDB show or season number' });
      return true;
    }
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${season}`, {
        params: { api_key: tmdbApi, language: 'en-US' }, timeout: 10000,
      });
      // Keep TMDB's episode identity and raw votes, including null/zero values.
      reply.send({ ...response.data, tmdb_id: String(id) });
    } catch (_) {
      reply.status(502).send({ message: 'TMDB season metadata unavailable' });
    }
    return true;
  };

  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const sanitizeType = (t: any): string | undefined => {
      if (!t || t === 'undefined' || t === 'null') return undefined;
      return String(t).toLowerCase();
    };

    const id = (request.query as { id: string }).id;
    if (await getRequestedSeason(request, reply, id)) return;
    let type = sanitizeType((request.query as { type: string }).type);
    const provider = (request.query as { provider?: string }).provider;
    const providerLower = provider?.toLowerCase();
    let tmdb = createTmdbClient(undefined);

    if (!id) return reply.status(400).send({ message: "The 'id' query is required" });

    // --- Smart Type Guessing Logic ---
    if (!type || (type !== 'movie' && type !== 'tv')) {
      console.log(`[SmartGuess] type missing for id ${id}, attempting resolution...`);
      try {
        // Try to fetch as TV first (37854 is a TV show in user's logs)
        const tvQuery = `https://api.themoviedb.org/3/tv/${id}?api_key=${tmdbApi}`;
        const tvRes = await axios.get(tvQuery).catch(() => null);
        if (tvRes?.data) {
          type = 'tv';
          console.log(`[SmartGuess] Resolved id ${id} as 'tv'`);
        } else {
          const movieQuery = `https://api.themoviedb.org/3/movie/${id}?api_key=${tmdbApi}`;
          const movieRes = await axios.get(movieQuery).catch(() => null);
          if (movieRes?.data) {
            type = 'movie';
            console.log(`[SmartGuess] Resolved id ${id} as 'movie'`);
          }
        }
      } catch {
        // Fallback below
      }
    }

    if (!type) {
      return reply
        .status(400)
        .send({
          message: "The 'type' query is required and could not be auto-resolved.",
        });
    }

    if (!tmdbApi) {
      const rescued = await getDirectTmdbInfo(id, type as string);
      if (rescued) {
        await attachBestTrailer(rescued, id, type as string);
        convertTmdbImagesToUrls(rescued);
        return reply.status(200).send(rescued);
      }

      return reply.status(200).send({
        id,
        title: 'Unknown',
        type,
        media_type: type,
        episodes: [],
        message: 'TMDB key not configured on the server.',
      });
    }

    // When no provider is explicitly requested, prefer direct TMDB metadata.
    // This avoids hard dependency on FlixHQ host resolution during basic info fetches.
    if (!providerLower) {
      const fetchDirect = async () => {
        const direct = await getDirectTmdbInfo(
          id,
          type as string,
          String(type || '').toLowerCase() === 'tv',
        );
        if (!direct) return null;
        await attachBestTrailer(direct, id, type as string);
        convertTmdbImagesToUrls(direct);
        return direct;
      };

      const directRes = redis
        ? await cache.fetch(
            redis as any,
            `tmdb:info:direct:${type}:${id}:seasons-v2`,
            fetchDirect,
            REDIS_TTL,
          )
        : await fetchDirect();

      if (directRes) {
        return reply.status(200).send(directRes);
      }
      // Fall through to provider-backed path as a last resort.
    }


    if (providerLower === 'animesalt') {
      try {
        const res = await buildAnimesaltTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }


    if (providerLower === 'flixhq') {
      try {
        const res = await buildFlixhqTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }

    if (typeof provider !== 'undefined') {
      const selectedProvider = resolveMovieProvider(provider);
      if (selectedProvider) {
        tmdb = createTmdbClient(selectedProvider);
        if (!tmdb) {
          return reply
            .status(200)
            .send({
              id,
              title: 'Unknown',
              type,
              media_type: type,
              episodes: [],
              message: 'TMDB key not configured on the server.',
            });
        }
      } else {
        const possibleProvider = PROVIDERS_LIST.MOVIES.find(
          (p) =>
            p.name.toLowerCase() === provider.toLocaleLowerCase() &&
            p.name.toLowerCase() !== 'flixhq',
        );
        tmdb = createTmdbClient(possibleProvider);
        if (!tmdb) {
          return reply
            .status(200)
            .send({
              id,
              title: 'Unknown',
              type,
              media_type: type,
              episodes: [],
              message: 'TMDB key not configured on the server.',
            });
        }
      }
    }

    try {
      const fetchInfo = async () => {
        const info = await tmdb.fetchMediaInfo(id, type);
        if (info && typeof info === 'object') {
          // Optimize for speed by removing heavy fields not used in current UI
          delete (info as any).cast;
          delete (info as any).characters;
          delete (info as any).recommendations;
          delete (info as any).similar;

          await attachBestTrailer(info, id, type);
          convertTmdbImagesToUrls(info);
        }
        return info;
      };

      let res = redis
        ? await cache.fetch(
            redis as any,
            `tmdb:info:${type}:${id}:${provider || 'default'}:trailer-v3`,
            fetchInfo,
            REDIS_TTL,
          )
        : await fetchInfo();

      // If title is "Unknown" or missing, try to rescue it directly from TMDB
      if (!res || !(res as any).title || (res as any).title === 'Unknown') {
        const rescued = await getDirectTmdbInfo(id, type);
        if (rescued) {
          await attachBestTrailer(rescued, id, type);
          convertTmdbImagesToUrls(rescued);
          res = {
            ...(res || {}),
            ...rescued,
            message: 'Metadata partially rescued via direct fetch',
          };
        }
      }

      reply.status(200).send(res);
    } catch (err) {
      logTmdbFailure('TMDB Info Error', err);
      // Catch-all rescue if the entire fetch fails
      const rescued = await getDirectTmdbInfo(id, type);
      if (rescued) {
        await attachBestTrailer(rescued, id, type);
        convertTmdbImagesToUrls(rescued);
        return reply
          .status(200)
          .send({
            ...rescued,
            episodes: [],
            message: 'Metadata rescued after fetch failure',
          });
      }
      reply
        .status(200)
        .send({
          id,
          title: 'Unknown',
          episodes: [],
          message: 'TMDB metadata fetch failed',
        });
    }
  });

  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const sanitizeType = (t: any): string | undefined => {
      if (!t || t === 'undefined' || t === 'null') return undefined;
      return String(t).toLowerCase();
    };

    const id = (request.params as { id: string }).id;
    if (await getRequestedSeason(request, reply, id)) return;
    let type = sanitizeType((request.query as { type: string }).type);
    const provider = (request.query as { provider?: string }).provider;
    const providerLower = provider?.toLowerCase();
    let tmdb = createTmdbClient(undefined);

    // --- Smart Type Guessing Logic ---
    if (!type || (type !== 'movie' && type !== 'tv')) {
      console.log(`[SmartGuess] type missing for id ${id}, attempting resolution...`);
      try {
        const tvQuery = `https://api.themoviedb.org/3/tv/${id}?api_key=${tmdbApi}`;
        const tvRes = await axios.get(tvQuery).catch(() => null);
        if (tvRes?.data) {
          type = 'tv';
          console.log(`[SmartGuess] Resolved id ${id} as 'tv'`);
        } else {
          const movieQuery = `https://api.themoviedb.org/3/movie/${id}?api_key=${tmdbApi}`;
          const movieRes = await axios.get(movieQuery).catch(() => null);
          if (movieRes?.data) {
            type = 'movie';
            console.log(`[SmartGuess] Resolved id ${id} as 'movie'`);
          }
        }
      } catch {
        // Fallback below
      }
    }

    if (!type) {
      return reply
        .status(400)
        .send({
          message: "The 'type' query is required and could not be auto-resolved.",
        });
    }

    if (!tmdbApi) {
      return reply.status(200).send({
        id,
        title: 'Unknown',
        type,
        media_type: type,
        episodes: [],
        message: 'TMDB key not configured on the server.',
      });
    }

    // When no provider is explicitly requested, prefer direct TMDB metadata.
    // This avoids hard dependency on FlixHQ host resolution during basic info fetches.
    if (!providerLower) {
      const fetchDirect = async () => {
        const direct = await getDirectTmdbInfo(
          id,
          type as string,
          String(type || '').toLowerCase() === 'tv',
        );
        if (!direct) return null;
        await attachBestTrailer(direct, id, type as string);
        convertTmdbImagesToUrls(direct);
        return direct;
      };

      const directRes = redis
        ? await cache.fetch(
            redis as any,
            `tmdb:info:direct:${type}:${id}:seasons-v2`,
            fetchDirect,
            REDIS_TTL,
          )
        : await fetchDirect();

      if (directRes) {
        return reply.status(200).send(directRes);
      }
      // Fall through to provider-backed path as a last resort.
    }


    if (providerLower === 'animesalt') {
      try {
        const res = await buildAnimesaltTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }


    if (providerLower === 'flixhq') {
      try {
        const res = await buildFlixhqTmdbInfo(request, id, type);
        return reply.status(200).send(res);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ message });
      }
    }

    if (typeof provider !== 'undefined') {
      const selectedProvider = resolveMovieProvider(provider);
      if (selectedProvider) {
        tmdb = createTmdbClient(selectedProvider);
      } else {
        const possibleProvider = PROVIDERS_LIST.MOVIES.find(
          (p) => p.name.toLowerCase() === provider.toLocaleLowerCase(),
        );
        tmdb = createTmdbClient(possibleProvider);
      }
    }

    try {
      const fetchInfo = async () => {
        const info = await tmdb.fetchMediaInfo(id, type);
        if (info && typeof info === 'object') {
          // Optimize for speed by removing heavy fields not used in current UI
          delete (info as any).cast;
          delete (info as any).characters;
          delete (info as any).recommendations;
          delete (info as any).similar;

          await attachBestTrailer(info, id, type);
          convertTmdbImagesToUrls(info);
        }
        return info;
      };

      let res = redis
        ? await cache.fetch(
            redis as any,
            `tmdb:info:${type}:${id}:${provider || 'default'}:trailer-v3`,
            fetchInfo,
            REDIS_TTL,
          )
        : await fetchInfo();

      // If title is "Unknown" or missing, try to rescue it directly from TMDB
      if (!res || !(res as any).title || (res as any).title === 'Unknown') {
        const rescued = await getDirectTmdbInfo(id, type);
        if (rescued) {
          await attachBestTrailer(rescued, id, type);
          convertTmdbImagesToUrls(rescued);
          res = {
            ...(res || {}),
            ...rescued,
            message: 'Metadata partially rescued via direct fetch',
          };
        }
      }

      reply.status(200).send(res);
    } catch (err) {
      logTmdbFailure('TMDB Info ID Error', err);
      // Catch-all rescue
      const rescued = await getDirectTmdbInfo(id, type);
      if (rescued) {
        await attachBestTrailer(rescued, id, type);
        convertTmdbImagesToUrls(rescued);
        return reply
          .status(200)
          .send({
            ...rescued,
            episodes: [],
            message: 'Metadata rescued after fetch failure',
          });
      }
      reply
        .status(200)
        .send({
          id,
          title: 'Unknown',
          episodes: [],
          message: 'TMDB metadata fetch failed',
        });
    }
  });

  fastify.get('/trending', async (request: FastifyRequest, reply: FastifyReply) => {
    const validTimePeriods = new Set(['day', 'week'] as const);
    type validTimeType = typeof validTimePeriods extends Set<infer T> ? T : undefined;

    const sanitizeType = (t: any): string => {
      if (!t || t === 'undefined' || t === 'null') return 'all';
      return String(t).toLowerCase();
    };

    const type = sanitizeType((request.query as { type?: string }).type);
    let timePeriod =
      (request.query as { timePeriod?: validTimeType }).timePeriod || 'day';

    // make day as default time period
    if (!validTimePeriods.has(timePeriod)) timePeriod = 'day';

    const page = (request.query as { page?: number }).page || 1;

    if (!tmdbApi) {
      return reply.status(200).send({
        results: [],
        page,
        message: 'TMDB key not configured on the server.',
      });
    }

    try {
      let res = await getDirectTmdbTrending(type, timePeriod, page);

      // If direct TMDB is empty, fall back to the extension provider.
      if (!res || !Array.isArray(res.results) || res.results.length === 0) {
        const tmdb = createTmdbClient(undefined);
        if (tmdb) {
          res = await tmdb.fetchTrending(type, timePeriod, page);
        }
      }

      if (res && Array.isArray(res.results)) {
        res.results.forEach((item: any) => {
          delete (item as any).cast;
          delete (item as any).characters;
        });
      }
      reply.status(200).send(res);
    } catch (err) {
      console.error('TMDB Trending Error:', err);
      // Catch-all rescue
      const rescued = await getDirectTmdbTrending(type, timePeriod, page);
      if (rescued) {
        return reply
          .status(200)
          .send({ ...rescued, message: 'Trending rescued after fetch failure' });
      }
      reply
        .status(200)
        .send({
          results: [],
          message: 'Trending currently unavailable, please check TMDB key.',
        });
    }
  });

  const getDirectTmdbTrending = async (
    type: string = 'all',
    timePeriod: string = 'day',
    page: number = 1,
  ) => {
    try {
      if (!tmdbApi) return null;
      const url = `https://api.themoviedb.org/3/trending/${type}/${timePeriod}?api_key=${tmdbApi}&page=${page}`;
      const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.data && Array.isArray(res.data.results)) {
        return {
          results: res.data.results
            .filter((item: any) => item?.id !== undefined && item?.id !== null)
            .map((item: any) => ({
              id: String(item.id),
              title: item.title || item.name || 'Unknown',
              image: item.poster_path
                ? `https://image.tmdb.org/t/p/original${item.poster_path}`
                : null,
              type: item.media_type || (type === 'all' ? 'movie' : type),
              releaseDate: item.release_date || item.first_air_date,
              rating: item.vote_average,
            })),
          page: res.data.page,
        };
      }
    } catch (err) {
      console.error('Direct TMDB Trending Error:', err);
    }
    return null;
  };

  const watch = async (request: FastifyRequest, reply: FastifyReply) => {
    const sanitizeType = (t: any): string | undefined => {
      if (!t || t === 'undefined' || t === 'null') return undefined;
      return String(t).toLowerCase();
    };

    let episodeId = (request.params as { episodeId: string }).episodeId;
    if (!episodeId) {
      episodeId = (request.query as { episodeId: string }).episodeId;
    }
    const id = (request.query as { id: string }).id;
    const type = sanitizeType((request.query as { type: string }).type);
    const provider = (request.query as { provider?: string }).provider;
    const providerLower = provider?.toLowerCase();
    const server = (request.query as { server?: StreamingServers }).server;
    const directOnlyRaw = String(
      (request.query as { directOnly?: string }).directOnly || '',
    ).toLowerCase();
    const directOnly =
      directOnlyRaw === '1' || directOnlyRaw === 'true' || directOnlyRaw === 'yes';
    const sourceType = String(
      (request.query as { source_type?: string; category?: string }).source_type ||
        (request.query as { category?: string }).category ||
        '',
    ).toLowerCase();
    const requestedSeasonForCache = String(
      (request.query as { season?: string }).season || '',
    );
    const requestedEpisodeForCache = String(
      (request.query as { episode?: string }).episode || '',
    );

    console.log(
      `[tmdb.ts] watch hit: id=${id}, type=${type}, provider=${provider}, providerLower=${providerLower}`,
    );

    // Build cache key for watch results (skip caching if server is specified since that changes results)
    const cacheKey = !server
      ? `tmdb:watch:v5:${type}:${id}:${provider || 'default'}:${requestedSeasonForCache}:${requestedEpisodeForCache}:${episodeId || ''}:${directOnly}:${sourceType}`
      : null;

    // Try to return from cache first
    if (cacheKey && redis) {
      try {
        const cached = await (redis as any).get(cacheKey);
        if (cached) {
          const payload = JSON.parse(cached);
          const cachedCookie = String(payload?.headers?.Cookie || '').trim();
          if (providerLower === 'hdstream4u' && !cachedCookie) {
            // Older cached HDStream4u watch payloads are missing the browser-session
            // cookie needed by hubstream manifests. Recompute instead of serving stale data.
          } else {
            return reply.status(200).send(payload);
          }
        }
      } catch {
        // Ignore cache read errors and proceed with normal flow
      }
    }

    if (providerLower === 'hdstream4u' && type === 'movie' && id) {
      try {
        const infoRes = await request.server.inject({
          method: 'GET',
          url: `/movies/hdstream4u/info?id=${encodeURIComponent(String(id))}&type=movie`,
        });

        if (infoRes.statusCode < 400) {
          const infoPayload = safeJsonParse(infoRes.body || '{}');
          const candidates = extractHdstreamMovieCandidateIds(infoPayload).slice(0, 3);

          if (candidates.length) {
            // Race all candidate extractions in parallel and take the first
            // one that yields playable sources. Previously this looped
            // sequentially with a 30s timeout per candidate (up to ~90s when
            // the first candidates were stale); parallel racing makes the
            // happy path return in a couple of seconds.
            const raced = await Promise.any(
              candidates.map(async (candidateId: string) => {
                const payload = await withSoftTimeout(
                  HdStream4uProvider.fetchSources(
                    candidateId,
                    'hdstream4u',
                    false,
                    { mediaId: String(id) },
                  ),
                  30000,
                );
                const sources = Array.isArray(payload?.sources) ? payload.sources : [];
                if (!sources.length) throw new Error('no sources');
                return payload;
              }),
            ).catch(() => null);

            if (raced) {
              if (cacheKey && redis) {
                (redis as any)
                  .setex(cacheKey, REDIS_TTL, JSON.stringify(raced))
                  .catch(() => {});
              }
              return reply.status(200).send(raced);
            }
          }
        }
      } catch {
        // Fall through to the standard provider flow below.
      }
    }



    // Check if it's an anime provider
    if (providerLower && ANIME_PROVIDER_ROUTES[providerLower]) {
      let resolvedEpisodeId = episodeId;

      // Attempt to resolve episodeId from season/episode if it's a provider-specific mapping provider
      if (
        providerLower === 'animesalt' &&
        (!resolvedEpisodeId || !resolvedEpisodeId.includes('$'))
      ) {
        try {
          const info: any = await buildAnimesaltTmdbInfo(request, id, type || 'tv');

          const requestedSeason = Number(
            (request.query as { season?: number }).season || 1,
          );
          const requestedEpisode = Number(
            (request.query as { episode?: number }).episode || 1,
          );

          const seasonMatch = Array.isArray(info?.seasons)
            ? info.seasons.find((s: any) => Number(s?.season || 1) === requestedSeason)
            : undefined;
          const epMatch = Array.isArray(seasonMatch?.episodes)
            ? seasonMatch.episodes.find(
                (ep: any) => Number(ep?.episode || ep?.number || 0) === requestedEpisode,
              )
            : undefined;

          if (epMatch?.id) {
            resolvedEpisodeId = epMatch.id;
          }
        } catch {
          // Fallback to default redirect
        }
      }

      if (!resolvedEpisodeId) {
        return reply
          .status(400)
          .send({ message: `episodeId is required for ${providerLower} watch` });
      }

      const animeBaseUrl = ANIME_PROVIDER_ROUTES[providerLower];
      const queryParts: string[] = [];
      if (server) {
        queryParts.push(`server=${encodeURIComponent(server)}`);
      }
      if (providerLower === 'hianime') queryParts.push('category=both');
      if (directOnly) queryParts.push('directOnly=true');
      const queryString = queryParts.length ? `?${queryParts.join('&')}` : '';
      const redirectUrl = `${animeBaseUrl}/watch/${resolvedEpisodeId}${queryString}`;
      return reply.redirect(redirectUrl);
    }

    if (
      type === 'movie' &&
      id &&
      providerLower === 'flixhq' &&
      !episodeId
    ) {
      // FAST PATH: For movies, skip full episode mapping and go straight to FlixHQ watch
      // This cuts response time by 60-70% compared to full buildFlixhqTmdbInfo
      try {
        let titleForSearch = '';

        // TMDB numeric ids are not FlixHQ movie ids. Resolve movies through title search first.
        try {
          const baseTmdb = new META.TMDB(tmdbApi);
          let mediaInfo: any;
          try {
            mediaInfo = await baseTmdb.fetchMediaInfo(id, 'movie');
          } catch {
            mediaInfo = await getDirectTmdbInfo(id, 'movie');
          }

          if (mediaInfo?.title) {
            titleForSearch = mediaInfo.title;
          }
        } catch {
          // Will use fallback
        }

        // Search FlixHQ with title
        if (titleForSearch) {
          try {
            const searchRes = await request.server.inject({
              method: 'GET',
              url: `/movies/flixhq/${encodeURIComponent(titleForSearch)}`,
            });
            if (searchRes.statusCode < 400) {
              const payload = safeJsonParse(searchRes.body || '{}');
              const results = Array.isArray(payload?.data) ? payload.data : [];
              const movieMatch = results
                .filter(
                  (item: any) => normalizeText(String(item?.type || '')) === 'movie',
                )
                .map((item: any) => ({
                  item,
                  score: titleMatchScore(String(item?.name || item?.title || ''), [
                    titleForSearch,
                  ]),
                }))
                .sort((a: any, b: any) => b.score - a.score)[0]?.item;

              if (movieMatch?.id) {
                // Found movie! Directly call FlixHQ watch
                const queryParts = [`episodeId=${encodeURIComponent(movieMatch.id)}`];
                if (server) queryParts.push(`server=${encodeURIComponent(server)}`);
                if (server) queryParts.push('strictServer=true');
                if (directOnly) queryParts.push('directOnly=true');
                if (!directOnly) queryParts.push('allowEmbedFallback=true');

                const watchRes = await request.server.inject({
                  method: 'GET',
                  url: `/movies/flixhq/watch?${queryParts.join('&')}`,
                });

                if (watchRes.statusCode < 400) {
                  const watchPayload = safeJsonParse(watchRes.body || '{}');
                  const sources = Array.isArray(watchPayload?.sources)
                    ? watchPayload.sources
                    : [];
                  if (sources.length > 0) {
                    if (
                      !directOnly ||
                      sources.some((src: any) =>
                        /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(src?.url || '')),
                      )
                    ) {
                      if (cacheKey && redis) {
                        (redis as any)
                          .setex(cacheKey, REDIS_TTL, JSON.stringify(watchPayload))
                          .catch(() => {});
                      }
                      return reply.status(200).send(watchPayload);
                    }
                  }
                }
              }
            }
          } catch {
            // Fall through to normal path
          }
        }
      } catch {
        // Fall through to normal path
      }
    }

    const resolveFlixhqTvEpisodeId = async () => {
      const requestedSeason = Number((request.query as { season?: number }).season || 1);
      const requestedEpisode = Number(
        (request.query as { episode?: number }).episode || 1,
      );
      const pickEpisodeId = (info: any) => {
        const seasonMatch = Array.isArray(info?.seasons)
          ? info.seasons.find(
              (s: any) => Number(s?.season || s?.number || 1) === requestedSeason,
            )
          : undefined;
        const epMatch = Array.isArray(seasonMatch?.episodes)
          ? seasonMatch.episodes.find(
              (ep: any) =>
                Number(ep?.episode || ep?.number || ep?.episodeNumber || 0) ===
                requestedEpisode,
            )
          : undefined;
        const providerEpisodeMatch = Array.isArray(info?.providerEpisodes)
          ? info.providerEpisodes.find(
              (ep: any) =>
                Number(ep?.seasonNumber || ep?.season || 1) === requestedSeason &&
                Number(ep?.episodeNumber || ep?.episode || ep?.number || 0) ===
                  requestedEpisode,
            )
          : undefined;
        return String(
          epMatch?.id ||
            epMatch?.episodeId ||
            epMatch?.url ||
            providerEpisodeMatch?.episodeId ||
            providerEpisodeMatch?.id ||
            providerEpisodeMatch?.url ||
            '',
        ).trim();
      };

      try {
        const info: any = await buildFlixhqTmdbInfo(
          request,
          String(id || ''),
          String(type || 'tv'),
        );
        const mapped = pickEpisodeId(info);
        if (mapped) return mapped;
      } catch {
        // Try title search fallback below.
      }

      const mediaInfo: any = await getDirectTmdbInfo(
        String(id || ''),
        String(type || 'tv'),
      );
      const title = String(mediaInfo?.title || mediaInfo?.name || '').trim();
      if (!title) return '';

      const searchRes = await request.server.inject({
        method: 'GET',
        url: `/movies/flixhq/${encodeURIComponent(title)}`,
      });
      if (searchRes.statusCode >= 400) return '';
      const searchPayload = safeJsonParse(searchRes.body || '{}');
      const results = Array.isArray(searchPayload?.data) ? searchPayload.data : [];
      const yearGuess = Number(
        String(mediaInfo?.releaseDate || mediaInfo?.firstAirDate || '').slice(0, 4),
      );
      const scored = results
        .filter((row: any) => String(row?.id || '').trim())
        .map((row: any) => ({
          row,
          score:
            titleMatchScore(String(row?.name || row?.title || ''), [title]) +
            (Number(String(row?.releaseDate || '').slice(0, 4)) === yearGuess ? 50 : 0) +
            (String(row?.type || '')
              .toLowerCase()
              .includes('tv')
              ? 20
              : 0),
        }))
        .sort((a: any, b: any) => b.score - a.score);
      const flixId = String(scored[0]?.row?.id || '').trim();
      if (!flixId) return '';

      const infoRes = await request.server.inject({
        method: 'GET',
        url: `/movies/flixhq/info?id=${encodeURIComponent(flixId)}&type=tv`,
      });
      if (infoRes.statusCode >= 400) return '';
      return pickEpisodeId(safeJsonParse(infoRes.body || '{}'));
    };

    if (
      !episodeId &&
      type === 'tv' &&
      id &&
      (!providerLower || providerLower === 'flixhq')
    ) {
      try {
        episodeId = (await resolveFlixhqTvEpisodeId()) || episodeId;
      } catch {
        // Ignore mapping fallback failures and allow normal flow to return extraction errors.
      }
    }

    const syntheticTmdbEpisodeId = type === 'tv' && id && providerLower === 'hdstream4u' &&
      new RegExp(`^${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-s\\d+e\\d+$`, 'i').test(String(episodeId || ''));
    if ((!episodeId || syntheticTmdbEpisodeId) && type === 'tv' && id && providerLower === 'hdstream4u') {
      try {
        episodeId =
          (await resolveHdstream4uTvEpisodeId(
            request,
            String(id || ''),
            String(type || 'tv'),
            Number((request.query as { season?: number }).season || 1),
            Number((request.query as { episode?: number }).episode || 1),
            await getDirectTmdbInfo(String(id), 'tv'),
          )) || episodeId;
      } catch {
        // Ignore mapping failures and continue.
      }
    }

    // A resolved HDStream TV link needs no further title discovery, season
    // hydration or trailer lookup before extraction. Keep the existing fallback
    // flow if this direct attempt does not return sources.
    const directHdstreamTvAttempt = providerLower === 'hdstream4u' && type === 'tv' && /^https?:\/\//i.test(String(episodeId || ''));
    if (directHdstreamTvAttempt) {
      try {
        const delegated = await request.server.inject({
          method: 'GET',
          url: `/movies/hdstream4u/watch?episodeId=${encodeURIComponent(episodeId)}`,
        });
        if (delegated.statusCode < 400) {
          const payload = safeJsonParse(delegated.body || '{}');
          if (payload?.sources?.length) return reply.status(200).send(payload);
        }
      } catch {
        // Preserve provider discovery/recovery on extraction failure.
      }
    }

    let discoveredMovieOrTvInfo: any = null;

    if (
      (type === 'movie' || type === 'tv') &&
      (!providerLower || providerLower === 'hdstream4u') &&
      !directHdstreamTvAttempt &&
      id
    ) {
      try {
        const discoveryTmdb = new META.TMDB(
          tmdbApi,
          undefined,
        );
        let mediaInfo: any = await getDirectTmdbInfo(id, type);
        if (!mediaInfo) {
          try {
            mediaInfo = await discoveryTmdb.fetchMediaInfo(id, type);
          } catch {
            mediaInfo = null;
          }
        }
        discoveredMovieOrTvInfo = mediaInfo;

        // Final check for "Unknown" title after fetch
        if (!mediaInfo || !mediaInfo.title || mediaInfo.title === 'Unknown') {
          const rescued = await getDirectTmdbInfo(id, type);
          if (rescued) mediaInfo = { ...(mediaInfo || {}), ...rescued };
        }

        const titleCandidates = getTitleCandidatesFromMedia(mediaInfo);
        if (titleCandidates.length) {
          try {
            const hdstreamEpisodeId =
              type === 'tv'
                ? episodeId
                : episodeId || (await resolveHdstream4uEpisodeId(request, mediaInfo));
            if (hdstreamEpisodeId) {
              const delegated = await request.server.inject({
                method: 'GET',
                url: `/movies/hdstream4u/watch?episodeId=${encodeURIComponent(hdstreamEpisodeId)}${type === 'movie' && id ? `&mediaId=${encodeURIComponent(String(id))}` : ''}`,
              });
              if (delegated.statusCode < 400) {
                const payload = safeJsonParse(delegated.body || '{}');
                const sources = Array.isArray(payload?.sources) ? payload.sources : [];
                if (sources.length > 0) {
                  if (cacheKey && redis) {
                    (redis as any)
                      .setex(cacheKey, REDIS_TTL, JSON.stringify(payload))
                      .catch(() => {});
                  }
                  return reply.status(200).send(payload);
                }
              }
            }
          } catch {
            // Fall through to remaining providers.
          }
        }
      } catch {
        // Ignore discovery errors and continue with movie providers.
      }
    }

    // Movie/TV providers
    let movieProvider: any = undefined;
    let tmdb = configureMeta(new META.TMDB(tmdbApi, movieProvider));
    if (typeof provider !== 'undefined') {
      const selectedProvider = resolveMovieProvider(provider);
      if (selectedProvider) {
        movieProvider = selectedProvider as any;
        tmdb = configureMeta(new META.TMDB(tmdbApi, selectedProvider));
      } else {
        const possibleProvider = PROVIDERS_LIST.MOVIES.find(
          (p) => p.name.toLowerCase() === provider.toLocaleLowerCase(),
        );
        movieProvider = (possibleProvider as any) || movieProvider;
        tmdb = configureMeta(new META.TMDB(tmdbApi, possibleProvider));
      }
    }
    let sourceId = '';
    let mediaId = '';
    try {
      // For movies, the id parameter contains the provider's media ID (e.g., "movie/watch-marty-supreme-139738")
      // We need to use this as the first parameter, not the TMDB episodeId
      // For TV shows, episodeId is the actual episode ID from the provider

      if (type === 'movie' && id) {
        // For movies, episodeId is the provider source ID in TMDB/provider responses.
        sourceId = String(episodeId || '').trim();
        mediaId = id;

        // Frontend can occasionally leak a previous provider episodeId (e.g. DramaCool URL)
        // into a FlixHQ movie request. Ignore those and resolve proper FlixHQ ids.
        if ((providerLower === 'flixhq' || !providerLower) && sourceId) {
          const lowerSourceId = sourceId.toLowerCase();
          const foreignProviderUrl = /^https?:\/\//i.test(sourceId);
          const foreignProviderHint =
            lowerSourceId.includes('animesalt') ||
            lowerSourceId.includes('hianime');
          if (foreignProviderUrl || foreignProviderHint) {
            sourceId = '';
          }
        }

        // FlixHQ often requires provider-specific numeric IDs (not TMDB ids) for watch extraction.
        if (!sourceId && providerLower === 'flixhq') {
          try {
            const flixInfo: any = await buildFlixhqTmdbInfo(request, id, type);
            const infoEpisodeId = String(flixInfo?.episodeId || '').trim();
            const providerSourceId = String(flixInfo?.providerSourceId || '').trim();
            sourceId = infoEpisodeId || providerSourceId || sourceId;
          } catch {
            // Ignore resolution errors and continue with generic fallback below.
          }
        }

        // Generic fallback when provider-specific id could not be resolved.
        sourceId = sourceId || id.replace(/^movie\//, '');
      } else {
        // For TV shows, use episodeId as sourceId and id as mediaId
        sourceId = episodeId;
        mediaId = id;
      }

      // Fast path: delegate FlixHQ playback extraction to the custom provider first.
      // This path is optimized and cached at /movies/flixhq/watch.
      if ((providerLower === 'flixhq' || !providerLower) && sourceId) {
        try {
          const queryParts = [`episodeId=${encodeURIComponent(sourceId)}`];
          if (server) queryParts.push(`server=${encodeURIComponent(server)}`);
          if (server) queryParts.push('strictServer=true');
          if (directOnly) queryParts.push('directOnly=true');
          if (!directOnly) queryParts.push('allowEmbedFallback=true');
          const delegated = await request.server.inject({
            method: 'GET',
            url: `/movies/flixhq/watch?${queryParts.join('&')}`,
          });

          if (delegated.statusCode < 400) {
            const payload = safeJsonParse(delegated.body || '{}');
            const sources = Array.isArray(payload?.sources) ? payload.sources : [];
            if (
              !directOnly ||
              sources.some((src: any) =>
                /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(src?.url || '')),
              )
            ) {
              // Cache watch result for fast subsequent loads
              if (cacheKey && redis) {
                (redis as any)
                  .setex(cacheKey, REDIS_TTL, JSON.stringify(payload))
                  .catch(() => {});
              }
              return reply.status(200).send(payload);
            }
          }
        } catch {
          // Fall through to TMDB provider extraction path.
        }
      }

      if (providerLower === 'hdstream4u' && sourceId) {
        try {
          const delegated = await request.server.inject({
            method: 'GET',
            url: `/movies/hdstream4u/watch?episodeId=${encodeURIComponent(sourceId)}${mediaId ? `&mediaId=${encodeURIComponent(mediaId)}` : ''}`,
          });
          if (delegated.statusCode < 400) {
            const payload = safeJsonParse(delegated.body || '{}');
            const sources = Array.isArray(payload?.sources) ? payload.sources : [];
            if (sources.length > 0) {
              if (cacheKey && redis) {
                (redis as any).setex(cacheKey, REDIS_TTL, JSON.stringify(payload)).catch(() => {});
              }
              return reply.status(200).send(payload);
            }
          }
        } catch {
          // Fall through.
        }
      }

      if (providerLower === 'hdstream4u' && !sourceId) {
        throw new Error('HDStream4u: no episode ID found for requested TV episode');
      }

      const res = await fetchWithServerFallback(
        async (selectedServer) =>
          await tmdb.fetchEpisodeSources(sourceId, mediaId, selectedServer),
        server,
        server ? [server] : [StreamingServers.VidCloud, StreamingServers.UpCloud],
        {
          attemptTimeoutMs: MOVIE_WATCH_ATTEMPT_TIMEOUT_MS,
          requireDirectPlayable: directOnly,
        },
      );

      // Cache watch result for fast subsequent loads
      if (cacheKey && redis && res) {
        (redis as any).setex(cacheKey, REDIS_TTL, JSON.stringify(res)).catch(() => {});
      }
      reply.status(200).send(res);
    } catch (err: any) {
      if (
        (type === 'tv' || type === 'movie') &&
        sourceId &&
        (!providerLower || providerLower === 'flixhq')
      ) {
        try {
          const queryParts = [`episodeId=${encodeURIComponent(sourceId)}`];
          if (server) queryParts.push(`server=${encodeURIComponent(server)}`);
          if (server) queryParts.push('strictServer=true');
          if (directOnly) queryParts.push('directOnly=true');
          if (!directOnly) queryParts.push('allowEmbedFallback=true');
          const delegated = await request.server.inject({
            method: 'GET',
            url: `/movies/flixhq/watch?${queryParts.join('&')}`,
          });

          if (delegated.statusCode < 400) {
            const payload = safeJsonParse(delegated.body || '{}');
            const sources = Array.isArray(payload?.sources) ? payload.sources : [];
            if (
              !directOnly ||
              sources.some((src: any) =>
                /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(src?.url || '')),
              )
            ) {
              // Cache watch result for fast subsequent loads
              if (cacheKey && redis) {
                (redis as any)
                  .setex(cacheKey, REDIS_TTL, JSON.stringify(payload))
                  .catch(() => {});
              }
              return reply.status(200).send(payload);
            }
          }
        } catch {
          // Continue to existing fallbacks below.
        }
      }

      if (type === 'movie' && sourceId) {
        try {
          const fallback = await getMovieEmbedFallbackSource(
            movieProvider as any,
            sourceId,
            mediaId,
            server,
          );

          if (fallback) {
            // Cache watch result for fast subsequent loads
            if (cacheKey && redis) {
              (redis as any)
                .setex(cacheKey, REDIS_TTL, JSON.stringify(fallback))
                .catch(() => {});
            }
            return reply.status(200).send(fallback);
          }
        } catch {
          // Ignore fallback errors and return the extraction error below.
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tmdb.ts] watch failed: ${message}`);
      reply.status(404).send({ message, error: 'Not Found or Extraction Failed' });
    }
  };
  fastify.get('/watch', watch);
  fastify.get('/watch/:episodeId', watch);
};

export default routes;
