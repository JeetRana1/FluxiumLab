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
const tmdbKey = () => String(process.env.TMDB_KEY || '').trim();
const infoCache = new Map<string, { expires: number; value: any }>();
const INFO_CACHE_TTL = 10 * 60 * 1000;

const resolveImdbId = async (id: string) => {
  if (/^tt\d+$/i.test(id)) return id;
  if (!/^\d+$/.test(id) || !tmdbKey()) return '';
  for (const type of ['tv', 'movie']) {
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
  return { id: absolute(href), url: absolute(href), title, name: title, year, image: poster, poster, type: href.includes('/series/') ? 'tv' : 'movie' };
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
      const imdbId = await resolveImdbId(id);
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
    const episodes = parseEpisodes($, url);
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
    return HdStream4uProvider.fetchSources(episodeId, server);
  }
}
