import { endpoint, json, rateLimit } from './_lib/guard.js';

/**
 * GET /api/search?q=&count=&sources=
 * مجمّع بحث صور على الخادم (لا مفاتيح مطلوبة لمعظم المصادر).
 * Openverse يعمل تلقائيًا إذا ضُبط OPENVERSE_TOKEN في متغيرات البيئة.
 */
const UA = 'AbuNawaf-ImageSearch/3.0 (+https://abu-nawaf-hub.vercel.app)';
const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
const extOf = (u) => { try { return new URL(u).pathname.split('.').pop().toLowerCase(); } catch { return ''; } };
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/^File:/, '').replace(/\s+/g, ' ').trim();
const stripQuery = (u) => { try { const x = new URL(u); x.search = ''; return x.href; } catch { return u; } };

const S = {
  async wikimedia(q, n) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent('filetype:bitmap ' + q)}&gsrnamespace=6&gsrlimit=${Math.min(50, n)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=480&format=json`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('wikimedia');
    const j = await r.json();
    return Object.values(j.query?.pages || {}).map((p) => {
      const ii = p.imageinfo?.[0] || {};
      const md = ii.extmetadata || {};
      const full = stripQuery(ii.url || '');
      return {
        id: 'wm-' + p.pageid, title: clean(p.title).replace(/\.[a-z0-9]+$/i, ''),
        url: full, thumb: stripQuery(ii.thumburl || ii.url || ''),
        width: ii.width || 0, height: ii.height || 0,
        source: 'Wikimedia', license: String(md.LicenseShortName?.value || 'open').toLowerCase().replace(/\s+/g, '-'),
        creator: clean(md.Artist?.value).slice(0, 60), page: ii.descriptionurl || full, tags: [],
      };
    }).filter((x) => x.url && IMG_EXT.includes(extOf(x.url)));
  },
  async artic(q, n) {
    const r = await fetch(`https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(q)}&fields=id,title,image_id,artist_display,date_display,is_public_domain&limit=${Math.min(50, n)}`, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('artic');
    const j = await r.json();
    return (j.data || []).filter((x) => x.image_id).map((x) => {
      const base = `https://www.artic.edu/iiif/2/${x.image_id}/full`;
      return {
        id: 'aic-' + x.id, title: clean(x.title) || 'Artwork', url: `${base}/1686,/0/default.jpg`,
        thumb: `${base}/400,/0/default.jpg`, width: 1686, height: 0, source: 'Art Institute',
        license: x.is_public_domain ? 'public-domain' : 'art-institute',
        creator: clean(x.artist_display).split('\n')[0].slice(0, 60),
        page: `https://www.artic.edu/artworks/${x.id}`, tags: [x.date_display || ''],
      };
    });
  },
  async nasa(q, n) {
    const r = await fetch(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image&page_size=${Math.min(100, n)}`, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('nasa');
    const j = await r.json();
    return (j.collection?.items || []).filter((x) => x.links?.[0]?.href).map((x, i) => {
      const d = x.data?.[0] || {};
      return {
        id: 'nasa-' + (d.nasa_id || i), title: clean(d.title) || 'NASA',
        url: x.links[0].href, thumb: x.links[0].href, width: 0, height: 0, source: 'NASA',
        license: 'public-domain', creator: clean(d.center || 'NASA'),
        page: `https://images.nasa.gov/details/${d.nasa_id || ''}`, tags: [(d.date_created || '').slice(0, 10)].filter(Boolean),
      };
    });
  },
  async loc(q, n) {
    const r = await fetch(`https://www.loc.gov/photos/?q=${encodeURIComponent(q)}&fo=json&c=${Math.min(50, n)}`, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('loc');
    const j = await r.json();
    return (j.results || []).map((x, i) => {
      const img = Array.isArray(x.image_url) ? x.image_url[0] : x.image_url;
      if (!img) return null;
      return {
        id: 'loc-' + (x.id || i), title: clean(Array.isArray(x.title) ? x.title[0] : x.title) || 'Library of Congress',
        url: img, thumb: img.replace(/\/\d+\.(jpe?g|png|gif)$/i, '/480.$1'), width: 0, height: 0,
        source: 'LOC', license: 'public-domain', creator: 'Library of Congress',
        page: x.id ? `https://www.loc.gov/item/${x.id}/` : img, tags: [].concat(x.date || []).slice(0, 1),
      };
    }).filter(Boolean).filter((x) => IMG_EXT.includes(extOf(x.url)));
  },
  async openverse(q, n) {
    const token = process.env.OPENVERSE_TOKEN || '';
    if (!token) throw new Error('openverse:token-missing');
    const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${Math.min(100, n)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) throw new Error('openverse');
    const j = await r.json();
    return (j.results || []).map((x) => ({
      id: 'ov-' + (x.id || x.url), title: clean(x.title) || q, url: x.url, thumb: x.thumbnail || x.url,
      width: x.width || 0, height: x.height || 0, source: 'Openverse', license: String(x.license || '').toLowerCase(),
      creator: clean(x.creator), page: x.foreign_landing_url || x.url, tags: [],
    }));
  },
};

export default endpoint(async (req, res) => {
  if (!rateLimit(req, res, { max: 60, windowMs: 60_000, key: 'imgsearch' })) return;
  const q = String(req.query?.q || '').trim().slice(0, 120);
  if (!q) return json(res, 400, { error: 'q مطلوب' });
  const count = Math.min(100, Math.max(12, parseInt(req.query?.count, 10) || 48));
  const wanted = String(req.query?.sources || 'wikimedia,artic,nasa,loc,openverse')
    .split(',').map((s) => s.trim()).filter((s) => S[s]);

  const results = await Promise.all(wanted.map(async (k) => {
    try { return { k, items: await S[k](q, count) }; }
    catch (e) { return { k, items: [], error: e.message }; }
  }));
  const seen = new Set();
  const items = results.flatMap((r) => r.items).filter((x) => {
    const key = (x.url || '').replace(/^https?:\/\//, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });

  return json(res, 200, {
    q, count: items.length, items,
    sources: results.map((r) => ({ name: r.k, ok: !r.error, count: r.items.length, error: r.error })),
    engine: 'AbuNawaf Image Search 3.0',
  });
}, { name: 'search', methods: ['GET'] });
