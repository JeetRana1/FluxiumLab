import * as cheerio from 'cheerio';
import { createDecipheriv } from 'crypto';

// MegaPlay's public client uses a zero-padded 32-byte key for its URL envelope.
export const decodeAniKotoSourceResponse = (payload: any): any => {
  if (!payload || typeof payload.enc !== 'string') return payload;
  try {
    const key = Buffer.alloc(32);
    key.write('i?LMTAx0Q6,:}50U');
    const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from("W0;27ToaUpl_P%'c"));
    const decoded = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(payload.enc, 'base64url')), decipher.final(),
    ]).toString('utf8'));
    const file = decoded?.file || decoded?.url;
    if (typeof file !== 'string' || !/^https?:\/\//i.test(file)) return payload;
    return { ...payload, sources: { file } };
  } catch {
    return payload;
  }
};

const BASE_URL = 'https://anikoto.cz';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const pageHeaders = () => ({
  'User-Agent': USER_AGENT,
  Accept: 'text/html, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.5',
  Referer: `${BASE_URL}/`,
});

const ajaxHeaders = () => ({
  ...pageHeaders(),
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
});

const parseJson = async (response: Response): Promise<any> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const absoluteUrl = (url: string): string =>
  url.startsWith('http') ? url : `https:${url}`;

const extractEmbedId = (html: string): string =>
  html.match(/id=["']megaplay-player["'][^>]*data-id=["'](\d+)["']/i)?.[1] ||
  html.match(/data-id=["'](\d+)["']/i)?.[1] ||
  html.match(/id=["'](\d+)["']/i)?.[1] ||
  '';

const hasSources = (result: any): boolean =>
  Boolean(
    result?.sub?.sources?.some((source: any) => String(source?.url || '').trim()) ||
      result?.dub?.sources?.some((source: any) => String(source?.url || '').trim()),
  );

// Only discovery IDs, never signed media URLs or source-specific skip timings.
const discoveryCache = new Map<string, { expires: number; episodes: ReadonlyMap<number, string> }>();
const discoveryPending = new Map<string, Promise<ReadonlyMap<number, string>>>();
const discoverEpisodes = async (slug: string): Promise<ReadonlyMap<number, string>> => {
  const pending = discoveryPending.get(slug);
  if (pending) return pending;
  const request = (async () => {
    const signal = AbortSignal.timeout(12000);
    const watchResponse = await globalThis.fetch(`${BASE_URL}/watch/${encodeURIComponent(slug)}`, {
      headers: pageHeaders(), signal,
    });
    if (!watchResponse.ok) return new Map<number, string>();
    const animeId = cheerio.load(await watchResponse.text())('#watch-main').attr('data-id') || '';
    if (!animeId) return new Map<number, string>();
    const response = await globalThis.fetch(`${BASE_URL}/ajax/episode/list/${encodeURIComponent(animeId)}`, {
      headers: ajaxHeaders(), signal,
    });
    if (!response.ok) return new Map<number, string>();
    const json = await parseJson(response);
    const $ = cheerio.load(String(json?.result || json?.html || ''));
    const episodes = new Map<number, string>();
    $('a[data-num]').each((_, element) => {
      const row = $(element);
      const number = Number(row.attr('data-num'));
      const ids = row.attr('data-ids') || row.attr('data-id') || '';
      if (Number.isInteger(number) && number > 0 && ids && !episodes.has(number)) episodes.set(number, ids);
    });
    if (episodes.size) {
      for (const [key, value] of discoveryCache) if (value.expires <= Date.now()) discoveryCache.delete(key);
      if (discoveryCache.size >= 128) discoveryCache.delete(discoveryCache.keys().next().value!);
      discoveryCache.set(slug, { expires: Date.now() + 30 * 60 * 1000, episodes });
    }
    return episodes;
  })().finally(() => discoveryPending.delete(slug));
  discoveryPending.set(slug, request);
  return request;
};

/** Resolve current AniKoto server links without relying on the older extension provider. */
export const fetchCurrentAniKotoSources = async (
  episodeId: string,
  server?: string,
): Promise<any | null> => {
  const match = episodeId.match(/^([a-z0-9][a-z0-9-]{0,199})\$episode\$([1-9]\d{0,5})$/i);
  if (!match) return null;
  // Bound the whole extraction, including response bodies and slow mirrors.
  const signal = AbortSignal.timeout(30000);
  const fetch = (url: string, options: RequestInit = {}) => globalThis.fetch(url, { ...options, signal });

  const slug = match[1];
  const episodeNumber = Number(match[2]);
  const cached = discoveryCache.get(slug);
  // A newly released episode may not be in a still-fresh snapshot.
  const episodeIds = (cached && cached.expires > Date.now() ? cached.episodes.get(episodeNumber) : '')
    || (await discoverEpisodes(slug)).get(episodeNumber);
  if (!episodeIds) return null;

  const serverResponse = await fetch(
    `${BASE_URL}/ajax/server/list?servers=${encodeURIComponent(episodeIds)}`,
    { headers: ajaxHeaders() },
  );
  const serverJson = await parseJson(serverResponse);
  const $servers = cheerio.load(String(serverJson?.result || serverJson?.html || ''));
  const groups: Array<{ type: 'sub' | 'dub'; linkId: string; name: string; svId: string }> = [];

  $servers('div.servers > div.type, div[data-type]').each((_, element) => {
    const group = $servers(element);
    const type = String(group.attr('data-type') || '').toLowerCase().includes('dub') ? 'dub' : 'sub';
    group.find('li[data-link-id]').each((__, item) => {
      const li = $servers(item);
      const linkId = li.attr('data-link-id') || '';
      if (linkId) {
        groups.push({
          type,
          linkId,
          name: li.text().trim(),
          svId: li.attr('data-sv-id') || '',
        });
      }
    });
  });

  if (!groups.length) {
    $servers('li[data-link-id]').each((_, item) => {
      const li = $servers(item);
      const linkId = li.attr('data-link-id') || '';
      if (linkId) groups.push({ type: 'sub', linkId, name: li.text().trim(), svId: '' });
    });
  }

  const result: any = { headers: { Referer: BASE_URL } };

  // Resolve every server group concurrently (bounded pool). AniKoto commonly
  // exposes 4-6 mirrors, and each mirror needs 4-5 chained upstream requests;
  // a sequential loop makes the first watch call take 10s+, which is where
  // most of the perceived "video won't load" latency comes from.
  let nextIndex = 0;
  const poolSize = Math.min(4, groups.length);
  const worker = async (): Promise<void> => {
    for (;;) {
      const current = nextIndex++;
      if (current >= groups.length) return;
      const group = groups[current];
      if (server && !group.name.toLowerCase().includes(String(server).toLowerCase())) continue;
      try {
        const svQuery = group.svId ? `&sv=${encodeURIComponent(group.svId)}` : '';
        const linkResponse = await fetch(
          `${BASE_URL}/ajax/server?get=${encodeURIComponent(group.linkId)}${svQuery}`,
          { headers: ajaxHeaders() },
        );
        const linkJson = await parseJson(linkResponse);
        const embedUrl = absoluteUrl(String(linkJson?.result?.url || linkJson?.url || ''));
        if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) continue;

        const embedResponse = await fetch(embedUrl, {
          headers: { ...pageHeaders(), Referer: `${BASE_URL}/` },
        });
        if (!embedResponse.ok) continue;
        const embedId = extractEmbedId(await embedResponse.text());
        if (!embedId) continue;

        const embedLocation = new URL(embedUrl);
        const embedOrigin = embedLocation.origin;
        // MegaPlay's client forwards this selector to getSources; dropping it
        // makes alternate server buttons resolve to the default CDN instead.
        const mirror = (embedLocation.searchParams.get('s') || '').replace(/[^a-z0-9_-]/gi, '');
        const mirrorQuery = mirror ? `&s=${encodeURIComponent(mirror)}` : '';
        const sourceUrls = [
          `${embedOrigin}/stream/getSourcesNew?id=${encodeURIComponent(embedId)}&id=${encodeURIComponent(embedId)}`,
          `${embedOrigin}/stream/getSources?id=${encodeURIComponent(embedId)}`,
        ];
        if (/megaplay\.buzz$/i.test(new URL(embedUrl).hostname)) {
          sourceUrls.push(
            `https://vidwish.live/stream/getSourcesNew?id=${encodeURIComponent(embedId)}&id=${encodeURIComponent(embedId)}`,
          );
        }
        let sourceJson: any = null;
        for (const sourceUrl of sourceUrls) {
          const sourceOrigin = new URL(sourceUrl).origin;
          const sourceResponse = await fetch(sourceUrl + mirrorQuery, {
            headers: { ...ajaxHeaders(), Origin: sourceOrigin, Referer: embedUrl },
          });
          if (!sourceResponse.ok) continue;
          const candidate = decodeAniKotoSourceResponse(await parseJson(sourceResponse));
          if (candidate?.sources?.file || candidate?.sources?.url || candidate?.source || candidate?.url) {
            sourceJson = candidate;
            break;
          }
        }
        const file = String(
          sourceJson?.sources?.file ||
            sourceJson?.sources?.url ||
            sourceJson?.source ||
            sourceJson?.url ||
            '',
        ).trim();
        if (!file) continue;

        // Timings are seconds on this embed's timeline, not episode-wide metadata.
        const skips: any = {};
        for (const type of ['intro', 'outro']) {
          const segment = sourceJson?.[type] ?? linkJson?.result?.skip_data?.[type];
          const start = Array.isArray(segment) ? segment[0] : segment?.start;
          const end = Array.isArray(segment) ? segment[1] : segment?.end;
          if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
            skips[type] = { start, end };
          }
        }
        const payload = group.type === 'dub' ? (result.dub ||= { sources: [], subtitles: [] }) : (result.sub ||= { sources: [], subtitles: [] });
        if (!payload.sources.some((source: any) => source.url === file && JSON.stringify({ intro: source.intro, outro: source.outro }) === JSON.stringify(skips))) {
          payload.sources.push({
            ...skips,
            url: file,
            isM3U8: /\.m3u8(?:[?#]|$)/i.test(file),
            quality: 'auto',
            server: group.name,
            headers: { Referer: embedUrl, 'User-Agent': USER_AGENT },
            isDub: group.type === 'dub',
          });
        }
        for (const track of Array.isArray(sourceJson?.tracks) ? sourceJson.tracks : []) {
          if (track?.file && track.kind !== 'thumbnails' && !payload.subtitles.some((sub: any) => sub.url === track.file)) {
            // MegaPlay's CDN rejects the AniKoto page referer for subtitle VTTs
            // and only serves them with the embed origin root as Referer.
            payload.subtitles.push({
              url: track.file,
              lang: track.label || 'English',
              referer: `${embedOrigin}/`,
            });
          }
        }
      } catch {
        // Continue with the next server; AniKoto commonly exposes multiple mirrors.
      }
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return hasSources(result) ? result : null;
};
