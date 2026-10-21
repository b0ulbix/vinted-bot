// Client Vinted : récupère les dernières annonces d'une recherche
const SITE = 'https://www.vinted.fr';
const API = 'https://api.vinted.fr/svc-catalogue/items';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const COOKIE_TTL = 30 * 60 * 1000;

// Paramètres de l'URL Vinted qu'on ignore (pagination, suivi…)
const IGNORED = new Set(['page', 'per_page', 'time', 'order', 'search_id', 'search_by_image_uuid', 'global_search_session_id']);

let cookie = null;
let cookieAt = 0;

async function refreshCookie() {
  const res = await fetch(SITE + '/', { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' } });
  const jar = {};
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    const value = kv.slice(i + 1);
    if (value) jar[kv.slice(0, i)] = value;
  }
  if (!jar.access_token_web) throw new Error(`Vinted refuse la connexion (code ${res.status})`);
  cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  cookieAt = Date.now();
}

// Filtres de l'URL du site Vinted → format attendu par l'API (attribute_ids[size]=4,5…)
const WEB_TO_ATTR = {
  'catalog[]': 'catalog', 'catalog_ids[]': 'catalog', 'size_ids[]': 'size', 'brand_ids[]': 'brand',
  'status_ids[]': 'status', 'color_ids[]': 'color', 'material_ids[]': 'material', 'patterns_ids[]': 'patterns',
};

// Accepte soit une URL de recherche Vinted copiée depuis le navigateur, soit de simples mots-clés
export function filterParams(query) {
  const params = new URLSearchParams();
  const attrs = {};
  const text = query.trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const pathCatalog = url.pathname.match(/\/catalog\/(\d+)/); // ex : /catalog/2309-livres
    if (pathCatalog) attrs.catalog = [pathCatalog[1]];
    for (const [k, v] of url.searchParams) {
      if (IGNORED.has(k) || v === '') continue;
      const attr = WEB_TO_ATTR[k] || k.match(/^attribute_ids\[(\w+)\]$/)?.[1];
      if (attr) (attrs[attr] ||= []).push(...v.split(','));
      else params.append(k, v);
    }
  } else if (text) {
    params.set('search_text', text);
  }
  for (const [code, ids] of Object.entries(attrs)) params.set(`attribute_ids[${code}]`, [...new Set(ids)].join(','));
  return params;
}

export function buildParams(query) {
  const params = filterParams(query);
  params.set('page', '1');
  params.set('per_page', '60'); // assez large pour les recherches très actives
  params.set('order', 'newest_first');
  return params;
}

const toPhoto = (p) => ({ thumb: p.thumbnails?.find((t) => t.type === 'thumb310x430')?.url || p.url, full: p.url });

function mapItem(it) {
  const photo = it.photo?.thumbnails?.find((t) => t.type === 'thumb310x430')?.url || it.photo?.url || null;
  return {
    photos: it.photo ? [toPhoto(it.photo)] : [],
    photos_full: false,
    id: it.id,
    title: it.title,
    price: Number(it.price?.amount ?? 0),
    total: Number(it.total_item_price?.amount ?? 0),
    currency: it.price?.currency_code || 'EUR',
    brand: it.item_box?.first_line || '',
    details: it.item_box?.second_line || '',
    photo,
    photo_large: it.photo?.url || photo,
    url: it.url?.startsWith('http') ? it.url : SITE + it.url,
    seller: it.user?.login || '',
    favourites: it.favourite_count || 0,
  };
}

async function vintedFetch(url, accept, retry = true) {
  if (!cookie || Date.now() - cookieAt > COOKIE_TTL) await refreshCookie();
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: accept,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Origin: SITE,
      Referer: SITE + '/',
      Cookie: cookie,
    },
  });
  if ((res.status === 401 || res.status === 403) && retry) {
    cookie = null;
    return vintedFetch(url, accept, false);
  }
  return res;
}

// La recherche ne donne que la 1re photo : on lit toutes les photos sur la page de l'annonce
export async function itemPhotos(item) {
  const res = await vintedFetch(item.url, 'text/html');
  if (res.status === 404 || res.status === 410) return []; // annonce supprimée ou vendue
  if (!res.ok) throw new Error(`Page annonce : code ${res.status}`);
  const flat = (await res.text()).split('\\"').join('"');
  const start = flat.indexOf(`"item_id":"${item.id}","photos":[`);
  if (start < 0) return [];
  const open = flat.indexOf('[', start);
  let depth = 0;
  let end = open;
  for (; end < flat.length; end++) {
    if (flat[end] === '[') depth++;
    else if (flat[end] === ']' && --depth === 0) break;
  }
  return JSON.parse(flat.slice(open, end + 1)).map(toPhoto);
}

export async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Photo : code ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Recherche avec des paramètres déjà prêts (utilisé pour estimer la cote)
export async function searchRaw(params) {
  const res = await vintedFetch(`${API}?${params}`, 'application/json');
  if (!res.ok) throw new Error(`Erreur Vinted (code ${res.status})`);
  return ((await res.json()).items || []).map(mapItem);
}

export async function search(query) {
  const res = await vintedFetch(`${API}?${buildParams(query)}`, 'application/json, text/plain, */*');
  if (res.status === 429) throw new Error('Vinted limite les requêtes (429) : augmente l\'intervalle');
  if (!res.ok) throw new Error(`Erreur Vinted (code ${res.status})`);
  const json = await res.json();
  return (json.items || []).map(mapItem);
}

// ---- Listes de filtres (pour le formulaire du tableau de bord) ----
const FILTERS_API = 'https://api.vinted.fr/svc-filters';

async function getJson(url) {
  const res = await vintedFetch(url, 'application/json');
  if (!res.ok) throw new Error(`Erreur Vinted (code ${res.status})`);
  return res.json();
}

// Options d'un filtre (taille, état, couleur, matière, marque) selon la recherche en cours
export async function facets(query, code) {
  const params = filterParams(query);
  params.set('filter_code', code);
  return (await getJson(`${FILTERS_API}/filters/facets?${params}`)).options || [];
}

// Sous-catégories d'une catégorie (ou les catégories principales si aucune)
export async function categories(catalogId) {
  const params = new URLSearchParams();
  if (catalogId) params.set('attribute_ids[catalog]', catalogId);
  const json = await getJson(`${FILTERS_API}/faceted_categories?${params}`);
  return (json.categories || []).map((c) => ({ id: String(c.id), title: c.title }));
}

export async function brands(keyword) {
  const json = await getJson(`${SITE}/api/v2/brands?keyword=${encodeURIComponent(keyword)}`);
  return (json.brands || []).slice(0, 20).map((b) => ({ id: String(b.id), title: b.title }));
}

// Aperçu : quelques annonces actuelles + nombre total
export async function preview(query) {
  const params = buildParams(query);
  params.set('per_page', '8');
  const res = await vintedFetch(`${API}?${params}`, 'application/json');
  if (!res.ok) throw new Error(`Erreur Vinted (code ${res.status})`);
  const json = await res.json();
  return { total: json.pagination?.total_entries ?? 0, items: (json.items || []).map(mapItem) };
}
