import * as cheerio from 'cheerio';

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
  const watchResponse = await fetch(`${BASE_URL}/watch/${encodeURIComponent(slug)}`, {
    headers: pageHeaders(),
  });
  if (!watchResponse.ok) return null;
  const watchHtml = await watchResponse.text();
  const animeId = cheerio.load(watchHtml)('#watch-main').attr('data-id') || '';
  if (!animeId) return null;

  const episodeResponse = await fetch(
    `${BASE_URL}/ajax/episode/list/${encodeURIComponent(animeId)}`,
    { headers: ajaxHeaders() },
  );
  const episodeJson = await parseJson(episodeResponse);
  const episodeHtml = String(episodeJson?.result || episodeJson?.html || '');
  const $episodes = cheerio.load(episodeHtml);
  const episode = $episodes(`a[data-num="${episodeNumber}"]`).first();
  const episodeIds = episode.attr('data-ids') || episode.attr('data-id') || '';
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
          const candidate = await parseJson(sourceResponse);
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

        const payload = group.type === 'dub' ? (result.dub ||= { sources: [], subtitles: [] }) : (result.sub ||= { sources: [], subtitles: [] });
        if (!payload.sources.some((source: any) => source.url === file)) {
          payload.sources.push({
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
            payload.subtitles.push({ url: track.file, lang: track.label || 'English' });
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
