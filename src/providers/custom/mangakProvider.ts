const API_BASE = 'https://api.mangak.io';
const SITE_BASE = 'https://mangak.io';

const headers = (referer = `${SITE_BASE}/search`) => ({
  Accept: 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Referer: referer,
});

const getJson = async (url: string, referer?: string) => {
  const response = await fetch(url, { headers: headers(referer) });
  if (!response.ok) throw new Error(`Mangak request failed: ${response.status}`);
  return response.json();
};

export class MangakProvider {
  static search(query: string, page = 1, limit = 20) {
    return getJson(`${API_BASE}/titles/search?page=${page}&limit=${limit}&q=${encodeURIComponent(query)}`);
  }

  static browse(options: { sort?: string; genres?: string; page?: number; limit?: number } = {}) {
    const params = new URLSearchParams();
    params.set('page', String(options.page || 1));
    params.set('limit', String(options.limit || 20));
    if (options.sort) params.set('sort', options.sort);
    if (options.genres) params.set('genres', options.genres);
    return getJson(`${API_BASE}/titles/search?${params.toString()}`);
  }

  static genres(limit = 100) {
    return getJson(`${API_BASE}/genres?page=1&limit=${limit}`);
  }

  static async info(id: string) {
    const payload: any = await getJson(`${API_BASE}/titles/search?page=1&limit=20&q=${encodeURIComponent(id)}`);
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    return items.find((item: any) => String(item?.id) === id) || items[0] || null;
  }

  static async chapters(id: string) {
    const payload: any = await getJson(`${API_BASE}/titles/${encodeURIComponent(id)}/chapters`, `${SITE_BASE}/titles/${id}`);
    return Array.isArray(payload?.data?.chapters) ? payload.data.chapters : [];
  }

  static async chapterImages(slug: string, chapterSlug: string) {
    const page = await fetch(`${SITE_BASE}/${encodeURIComponent(slug)}`, { headers: headers() });
    if (!page.ok) throw new Error(`Mangak title page failed: ${page.status}`);
    const html = await page.text();
    const buildMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    const buildId = buildMatch ? JSON.parse(buildMatch[1])?.buildId : null;
    if (!buildId) throw new Error('Mangak build ID unavailable');

    const payload: any = await getJson(
      `${SITE_BASE}/_next/data/${encodeURIComponent(buildId)}/${encodeURIComponent(slug)}/${encodeURIComponent(chapterSlug)}.json?slug=${encodeURIComponent(slug)}&chapter-slug=${encodeURIComponent(chapterSlug)}`,
      `${SITE_BASE}/${slug}/${chapterSlug}`,
    );
    return payload?.pageProps?.initialChapter || null;
  }

  static async chapter(mangaId: string, slug: string, number: number) {
    const chapters = await this.chapters(mangaId);
    const chapter = chapters.find((item: any) => Number(item?.number) === Number(number));
    if (!chapter) return null;
    const detail = await this.chapterImages(slug, chapter.slug);
    return detail ? { chapter, images: detail.images || [] } : null;
  }
}
