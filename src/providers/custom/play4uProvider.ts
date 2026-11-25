import * as cheerio from 'cheerio';
import axios from 'axios';
import { HdStream4uProvider } from './hdstream4uProvider';

const BASE_URL = 'https://play4u.org';
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const fetchPage = async (url: string) => String((await axios.get(url, { headers, timeout: 15000 })).data || '');
const absolute = (value: string) => new URL(value, BASE_URL).href;
const decodePlay4uStream = (token: string) => {
  const raw = String(token || '').trim();
  if (!raw.startsWith('pa!~')) return '';
  const encoded = raw.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(encoded, 'base64');
  const key = 'pa4u-stream-seal-v1';
  let decoded = '';
  for (let i = 0; i < bytes.length; i += 1) {
    decoded += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length));
  }
  return /^https?:\/\/[^"'\\\s]+/i.test(decoded) ? decoded : '';
};
const extractPlay4uSkipSegments = (html: string) => {
  const match = String(html || '').match(/window\.__PA_SKIP__\s*=\s*(\{[\s\S]*?\})\s*;/i);
  if (!match?.[1]) return [];
  try {
    const payload = JSON.parse(match[1]);
    return (Array.isArray(payload?.items) ? payload.items : [])
      .map((item: any) => ({
        type: String(item?.type || '').toLowerCase(),
        start: Number(item?.start),
        end: item?.end == null ? undefined : Number(item.end),
      }))
      .filter((item: any) => ['recap', 'intro', 'credits', 'outro'].includes(item.type)
        && Number.isFinite(item.start)
        && (item.end == null || Number.isFinite(item.end))
        && (item.end == null || item.end > item.start));
  } catch (_) {
    return [];
  }
};
const tmdbKey = () => String(process.env.TMDB_KEY || '').trim();
const infoCache = new Map<string, { expires: number; value: any }>();
const INFO_CACHE_TTL = 10 * 60 * 1000;

const enrichLatestItem = async (item: any) => {
  if (!item?.imdbId || !tmdbKey()) return item;
  try {
    const response = await axios.get(`https://api.themoviedb.org/3/find/${item.imdbId}`, {
      params: { api_key: tmdbKey(), external_source: 'imdb_id' },
      timeout: 8000,
    });
    const match = response.data?.tv_results?.[0] || response.data?.movie_results?.[0];
    if (!match?.id) return item;
    const isTv = Boolean(response.data?.tv_results?.[0]);
    return {
      ...item,
      id: String(match.id),
      tmdbId: String(match.id),
      title: match.title || match.name || item.title,
      name: match.name || match.title || item.name,
      type: isTv ? 'tv' : 'movie',
      poster_path: match.poster_path || '',
      backdrop_path: match.backdrop_path || '',
      image: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : item.image,
      poster: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : item.poster,
      vote_average: Number(match.vote_average || 0),
      vote_count: Number(match.vote_count || 0),
      release_date: match.release_date || '',
      first_air_date: match.first_air_date || '',
      overview: match.overview || '',
      play4uUrl: item.url,
    };
  } catch {
    return item;
  }
};

const resolveImdbId = async (id: string, mediaType: string) => {
  if (/^tt\d+$/i.test(id)) return id;
  if (!/^\d+$/.test(id) || !tmdbKey()) return '';
  for (const type of [mediaType === 'tv' ? 'tv' : 'movie']) {
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}/external_ids`, {
        params: { api_key: tmdbKey() },
        timeout: 8000,
      });
      if (response.data?.imdb_id) return String(response.data.imdb_id);
    } catch { /* try the other TMDB media type */ }
  }
  return '';
};

const parseCard = ($: cheerio.CheerioAPI, el: any) => {
  const card = $(el);
  const link = card.find('a.poster-link').first();
  const href = String(link.attr('href') || '').trim();
  const title = String(card.attr('data-title') || link.find('.poster-name').text() || '').trim();
  const year = Number(String(card.attr('data-year') || link.find('.poster-sub').text().match(/\b(?:19|20)\d{2}\b/)?.[0] || '0')) || undefined;
  const poster = String(link.find('img').attr('src') || '').trim();
  if (!href || !title) return null;
  // Play4u uses different badge classes depending on the title/template.
  // Read the visible non-language badge as a fallback so every TV card keeps
  // the same badge Play4u shows, not only cards using .badge-new-ep.
  const badgeText = String(card.find('.poster-badges .badge-chip').toArray()
    .map((node) => $(node).text().trim())
    .find((text) => text && !/^(?:[a-z]{2,3})(?:\s*[·,]\s*[a-z]{2,3})*$/i.test(text)) || '').trim();
  const episodeLabel = String(card.find('.badge-new-ep').first().text() || '').trim() || (/^S\d+\s*EP\d+$/i.test(badgeText) ? badgeText : '');
  const seasonLabel = String(card.find('.badge-season').first().text() || '').trim() || (badgeText && !episodeLabel ? badgeText : '');
  return {
    id: absolute(href),
    url: absolute(href),
    title,
    name: title,
    year,
    image: poster,
    poster,
    type: href.includes('/series/') ? 'tv' : 'movie',
    latestLabel: episodeLabel || seasonLabel || '',
    latestKind: episodeLabel ? 'episode' : (seasonLabel ? 'season' : ''),
  };
};

const parseEpisodes = ($: cheerio.CheerioAPI, url: string) => {
  const episodes = $('a[href*="/s-"][href*="/ep-"]').toArray().map((node) => {
    const href = absolute(String($(node).attr('href') || ''));
    const match = href.match(/\/s-(\d+)\/ep-(\d+)/i);
    if (!match) return null;
    return {
      id: href,
      episodeId: href,
      number: Number(match[2]),
      episode: Number(match[2]),
      season: Number(match[1]),
      title: String($(node).find('.episode-title, .episode-name').text() || $(node).text() || '').trim(),
    };
  }).filter(Boolean) as any[];
  return [...new Map(episodes.map((episode) => [`${episode.season}:${episode.episode}`, episode])).values()]
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
};

export class Play4uProvider {
  static async latest(page = 1) {
    const html = await fetchPage(`${BASE_URL}/?cat=latest${page > 1 ? `&page=${page}` : ''}`);
    const $ = cheerio.load(html);
    const results = $('article.poster-card').toArray().map((el) => {
      const item = parseCard($, el);
      if (!item) return null;
      const href = String(item.id || '');
      const imdbId = href.match(/\/(?:watch|series)\/(tt\d+)/i)?.[1] || '';
      const rawQuality = String($(el).attr('data-quality') || '').trim().toLowerCase();
      const camTitle = /\b(?:cam\s*v?\d*|camrip|hdcam|hdts|telesync|telecine|ts)\b/i.test(
        `${item.title} ${$(el).attr('data-search') || ''}`,
      );
      return {
        ...item,
        provider: 'play4u',
        isNew: true,
        isPlay4uLatest: true,
        quality: camTitle || rawQuality.includes('cam') ? 'CAM' : 'HD',
        imdbId,
      };
    }).filter(Boolean);
    const enrichedResults = await Promise.all(results.map(enrichLatestItem));
    const totalPages = Number($('.row-count').text().match(/of\s+(\d+)/i)?.[1] || 0);
    return { currentPage: page, totalPages: totalPages > 0 ? Math.ceil(totalPages / Math.max(1, enrichedResults.length)) : 1, results: enrichedResults };
  }

  static async search(query: string, page = 1) {
    if (/^(?:tt\d+|\d+)$/.test(query.trim())) {
      try {
        let info: any;
        for (const type of ['movie', 'tv']) {
          try {
            info = await this.fetchMediaInfo(query.trim(), type);
            if (info?.id) break;
          } catch { /* try the other media type */ }
        }
        if (!info?.id) throw new Error('Play4u ID not found');
        return {
          currentPage: page,
          totalPages: 1,
          results: [{ id: info.id, url: info.id, title: info.title, name: info.title, type: info.type, tmdbId: info.tmdbId, imdbId: info.imdbId }],
        };
      } catch { /* fall through to the catalog search */ }
    }
    const html = await fetchPage(`${BASE_URL}/?q=${encodeURIComponent(query)}&page=${page}`);
    const $ = cheerio.load(html);
    const needle = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const results = $('article.poster-card').toArray().map((el) => parseCard($, el)).filter(Boolean).filter((result: any) => {
      const haystack = `${result.title} ${result.year || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      return !needle || haystack.includes(needle) || needle.includes(haystack.trim());
    });
    return { currentPage: page, totalPages: 1, results };
  }

  static async fetchMediaInfo(id: string, type = 'movie') {
    const cacheKey = `${String(id).trim().toLowerCase()}|${type}`;
    const cached = infoCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    let url = /^https?:\/\//i.test(id) ? id : '';
    if (!url) {
      const imdbId = await resolveImdbId(id, type);
      if (imdbId) {
        const candidates = type === 'tv'
          ? [`${BASE_URL}/series/${imdbId}`, `${BASE_URL}/movie/${imdbId}`]
          : [`${BASE_URL}/watch/${imdbId}`, `${BASE_URL}/movie/${imdbId}`, `${BASE_URL}/series/${imdbId}`];
        for (const candidate of candidates) {
          try {
            const detail = await fetchPage(candidate);
            if (/window\.__PA_PLAY__|play4u/i.test(detail)) {
              url = candidate;
              break;
            }
          } catch { /* try the alternate Play4u media path */ }
        }
      }
    }
    if (!url) {
      const html = await fetchPage(`${BASE_URL}/?q=${encodeURIComponent(id)}`);
      const $ = cheerio.load(html);
      const cards = $('article.poster-card a.poster-link').toArray().slice(0, 30);
      for (const card of cards) {
        const candidate = absolute(String($(card).attr('href') || ''));
        if (!/^\d+$/.test(id)) { url = candidate; break; }
        try {
          const detail = await fetchPage(candidate);
          if (new RegExp(`"tmdb_id"\\s*:\\s*${id}(?:[,}])`, 'i').test(detail)) { url = candidate; break; }
        } catch { /* continue searching */ }
      }
      if (url) url = absolute(url);
    }
    if (!url) throw new Error('Play4u title not found');
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const title = String($('h1, .detail-title, .title').first().text() || $('meta[property="og:title"]').attr('content') || '').trim();
    const tmdbId = String(html.match(/"tmdb_id"\s*:\s*(\d+)/i)?.[1] || '').trim();
    const imdbId = String(html.match(/"imdb_id"\s*:\s*"(tt\d+)"/i)?.[1] || '').trim();
    let episodes = parseEpisodes($, url);
    // Series landing pages expose one season-directory link per season
    // (for example /s-01/ep-01), not the actual episode list. Hydrate those
    // season pages so consumers receive real episode URLs instead of treating
    // the directory marker as Season 1 Episode 1.
    const seasonMarkers = episodes.filter((episode: any) =>
      /^S\d+\s*[-:]\s*Season\b/i.test(String(episode?.title || '')),
    );
    if (seasonMarkers.length) {
      const hydrated: any[] = [];
      for (const marker of seasonMarkers) {
        try {
          const seasonHtml = await fetchPage(String(marker.id));
          hydrated.push(...parseEpisodes(cheerio.load(seasonHtml), String(marker.id)));
        } catch { /* keep the landing-page data if a season page fails */ }
      }
      // Remove the landing-page markers before merging. If they remain in
      // the array, Map keeps the marker for (season, episode) 1 and discards
      // the hydrated real S01E01/S02E01 URL.
      const landingEpisodes = episodes.filter((episode: any) =>
        !/^S\d+\s*[-:]\s*Season\b/i.test(String(episode?.title || '')),
      );
      const merged = [...landingEpisodes, ...hydrated];
      episodes = [...new Map(merged.map((episode: any) =>
        [`${episode.season}:${episode.episode}`, episode],
      )).values()].sort((a: any, b: any) =>
        a.season - b.season || a.episode - b.episode,
      );
    }
    const firstEpisode = episodes[0];
    const result = {
      id: url,
      title,
      type: type === 'tv' || episodes.length ? 'tv' : 'movie',
      tmdbId,
      imdbId,
      episodes,
      episodeId: firstEpisode?.id || url,
      servers: [{ name: 'Play4u', url: firstEpisode?.id || url, type: 'hls' }],
    };
    infoCache.set(cacheKey, { expires: Date.now() + INFO_CACHE_TTL, value: result });
    return result;
  }

  static async fetchSources(episodeId: string, server = 'play4u') {
    // Play4u's current watch pages expose the working PlayDrive player in
    // __PA_PLAY__. The old HDStream resolver can return a stale neopulse
    // document instead of an HLS manifest, which causes HLS.js to fail.
    if (/play4u\.org\/(?:watch|series)\//i.test(String(episodeId))) {
      try {
        const html = await fetchPage(episodeId);
        const streamMatch = html.match(/["'](?:m3u8_url|video_url)["']\s*:\s*["'](pa!~[^"']+)["']/i);
        const directStream = decodePlay4uStream(streamMatch?.[1] || '');
        if (directStream) {
          const skipSegments = extractPlay4uSkipSegments(html);
          let subtitles: Array<{ url: string; src: string; label: string; srclang: string; provider: string; referer: string }> = [];
          try {
            const manifest = String((await axios.get(directStream, {
              headers: { ...headers, Referer: episodeId },
              timeout: 10000,
            })).data || '');
            const subtitlePlaylists = [...manifest.matchAll(
              /#EXT-X-MEDIA:TYPE=SUBTITLES[^#]*?NAME="([^"]+)"[^#]*?LANGUAGE="([^"]*)"[^#]*?URI="([^"]+)"/gi,
            )];
            subtitles = await Promise.all(subtitlePlaylists.map(async (match) => {
              const playlistUrl = new URL(match[3], directStream).href;
              let src = playlistUrl;
              try {
                const playlist = String((await axios.get(playlistUrl, {
                  headers: { ...headers, Referer: episodeId },
                  timeout: 10000,
                })).data || '');
                const segment = playlist.split(/\r?\n/)
                  .map((line) => line.trim())
                  .find((line) => line && !line.startsWith('#'));
                if (segment) src = new URL(segment, playlistUrl).href;
              } catch (_) {
                // Keep the playlist URL as a fallback.
              }
              return {
                url: src,
                src,
                label: match[1],
                srclang: match[2] || 'en',
                provider: 'play4u',
                referer: episodeId,
              };
            }));
          } catch (_) {
            // The HLS source remains playable if its subtitle manifest is unavailable.
          }
          return {
            headers: { Referer: episodeId, Origin: BASE_URL },
            sources: [{ url: directStream, quality: 'auto', isM3U8: true, server: 'play4u' }],
            subtitles,
            skipSegments,
          };
        }
      } catch (_) {
        // Fall through to the legacy resolver if the watch page is unavailable.
      }
    }
    const legacy = await HdStream4uProvider.fetchSources(episodeId, server);
    try {
      const skipSegments = extractPlay4uSkipSegments(await fetchPage(episodeId));
      return skipSegments.length ? { ...legacy, skipSegments } : legacy;
    } catch (_) {
      return legacy;
    }
  }
}
