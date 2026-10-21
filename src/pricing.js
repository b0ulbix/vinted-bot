// Estimation de la cote d'une annonce, pour repérer les bonnes affaires
//  - Cartes Pokémon : prix Cardmarket (via la base gratuite pokemontcg.io)
//  - Le reste (vêtements, Pop…) : prix médian des annonces similaires sur Vinted
import { readFileSync } from 'node:fs';
import { db, getSettings } from './db.js';
import { filterParams, searchRaw, brands } from './vinted.js';

const FR_EN = JSON.parse(readFileSync(new URL('./ref/pokemon-fr-en.json', import.meta.url), 'utf8'));
const EN_NAMES = new Set(Object.values(FR_EN).map((n) => n.toLowerCase()));
const MIN_SAMPLES = 6;          // nombre minimum d'annonces comparables pour une cote fiable
const MIN_SAVING = 5;           // une bonne affaire doit faire gagner au moins 5 €
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// « Prix courant » : sur Vinted beaucoup d'annonces sont trop chères et ne se vendent jamais,
// donc la moyenne ou la médiane gonflent la cote. On prend le prix sous lequel se trouvent
// 35 % des annonces comparables : c'est plus proche de ce qui se vend vraiment.
const percentile = (nums, p) => {
  const a = [...nums].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo);
};
const marketPrice = (nums) => percentile(nums, 0.35);
const condOf = (details) => (/neuf/i.test(String(details || '')) ? 'neuf' : 'occasion');

// Petit cache en mémoire (la cote d'un même type d'article change peu en quelques heures)
const cache = new Map();
async function cached(key, ttlHours, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlHours * 3600_000) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---- Cartes Pokémon ----
const CARD_EXCLUDE = /\b(lot|lots|psa|pca|cgc|bgs|grad|display|etb|booster|coffret|classeur|deck)\b/i;
let pkmnCalls = [];

async function pokemonCard(item) {
  const text = `${item.title} ${item.brand}`;
  if (!/pok[eé]mon|pokemon/i.test(text) || CARD_EXCLUDE.test(item.title)) return null;
  const num = item.title.match(/\b(\d{1,3})\s*\/\s*(\d{2,3})\b/);
  if (!num) return null;
  // Nom anglais de la carte : on traduit les noms français trouvés dans le titre
  const words = norm(item.title).split(/[^a-z0-9-]+/).filter(Boolean);
  const names = new Set();
  for (const [fr, en] of Object.entries(FR_EN)) if (words.includes(norm(fr))) names.add(en.toLowerCase());
  for (const w of words) if (EN_NAMES.has(w)) names.add(w);

  const cards = await cached(`pk:${Number(num[1])}/${num[2]}`, 24, async () => {
    // Limite de l'API gratuite : 25 appels par minute au maximum
    pkmnCalls = pkmnCalls.filter((t) => Date.now() - t < 60_000);
    if (pkmnCalls.length >= 25) return null;
    pkmnCalls.push(Date.now());
    const q = encodeURIComponent(`number:${Number(num[1])} set.printedTotal:${Number(num[2])}`);
    const res = await fetch(`https://api.pokemontcg.io/v2/cards?q=${q}&select=name,number,set,cardmarket&pageSize=20`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return (await res.json()).data || [];
  });
  if (!cards?.length) return null;
  const match = cards.filter((c) => [...names].some((n) => norm(c.name).includes(n)));
  const card = match.length === 1 ? match[0] : cards.length === 1 ? cards[0] : null;
  const p = card?.cardmarket?.prices;
  const value = p && (p.trendPrice || p.avg30 || p.averageSellPrice);
  if (!value) return null;
  return { value: Math.round(value * 100) / 100, source: 'Cardmarket', label: `${card.name} · ${card.set.name}` };
}

// ---- Annonces similaires sur Vinted ----
// Type d'article d'après le titre (plusieurs langues car Vinted mélange les pays)
const TYPES = [
  ['doudoune', /\b(doudoune|puffer|piumino|nuptse|daunenjacke)\b/i],
  ['veste', /\b(veste|jacket|giacca|jacke|chaqueta|blouson|parka|manteau|coat|bomber|coupe[- ]vent|windbreaker|anorak|softshell|overshirt)\b/i],
  ['pull', /\b(pull|sweat|sweatshirt|hoodie|sweater|jumper|maglione|felpa|pullover|cardigan|capuche|crewneck|quarter[- ]zip|kapuzenpullover)\b/i],
  ['tshirt', /\b(t-?shirt|tee|tshirt|maglietta|maglia|camiseta|longsleeve|debardeur|tank)\b/i],
  ['polo', /\bpolo\b/i],
  ['chemise', /\b(chemise|camicia|hemd|shirt)\b/i],
  ['pantalon', /\b(pantalon|pants|jeans?|trousers|pantaloni|cargo|jogging|joggers?|chino|hose)\b/i],
  ['short', /\b(short|shorts|bermuda)\b/i],
  ['chaussures', /\b(sneakers?|baskets?|chaussures?|shoes|dunk|jordan|scarpe|schuhe)\b/i],
  ['sac', /\b(sac|bag|borsa|bandouli[eè]re|tasche)\b/i],
  ['accessoire', /\b(casquette|cap|bonnet|beanie|hat|ceinture|belt|echarpe)\b/i],
];

const typeOf = (title) => TYPES.find(([, re]) => re.test(norm(title)))?.[0] || null;
const sizeOf = (details) => String(details || '').split(' · ')[0].trim();

async function brandId(title) {
  if (!title) return null;
  return cached(`brand:${norm(title)}`, 168, async () => {
    const list = await brands(title).catch(() => []);
    return list.find((b) => norm(b.title) === norm(title))?.id || null;
  });
}

// ---- Funko Pop : on identifie le Pop précis (numéro + nom) ----
const POP_EXCLUDE = /\b(lot|lots|bitty|pocket|keychain|porte[- ]?cl[eé]s?|mystery|minis?|pack|collection)\b/i;
const POP_STOPWORDS = new Set(['funko', 'pop', 'pops', 'figurine', 'figure', 'vinyl', 'vinyle', 'neuf', 'neuve', 'boite', 'box', 'avec', 'sans', 'disney', 'marvel', 'movies', 'animation', 'television', 'games', 'rocks', 'exclusive', 'exclu', 'edition', 'special', 'vendu', 'vends', 'tres', 'bon', 'etat', 'protection', 'protector', 'nr', 'no']);

function popNumber(title) {
  const marked = title.match(/(?:#|n[°o]\.?\s*|nr\.?\s*|no\.?\s*|num[ée]ro\s*)(\d{1,4})\b/i);
  if (marked) return marked[1];
  // Sinon un nombre de 2 à 4 chiffres qui n'est ni une année, ni une taille, ni un prix
  for (const m of title.matchAll(/\b(\d{2,4})\b(?!\s*(?:cm|mm|ans|€|eur|euros?|x\b|pcs|pi[eè]ces|%))/gi)) {
    const n = Number(m[1]);
    if (m[1].length === 4 && n >= 1950 && n <= 2035) continue;
    return m[1];
  }
  return null;
}
const popWords = (title) => norm(title).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !POP_STOPWORDS.has(w) && !/^\d+$/.test(w));

async function popMedian(item) {
  if (POP_EXCLUDE.test(item.title)) return null;
  const num = popNumber(item.title);
  if (!num) return null; // Pop non identifié : pas de cote plutôt qu'une cote fausse
  const words = popWords(item.title);
  const params = new URLSearchParams({ search_text: `funko pop ${num}`, per_page: '96', order: 'newest_first' });
  const sample = await cached(`pop:${num}`, 6, async () =>
    (await searchRaw(params)).map((it) => ({ id: it.id, price: it.price, title: it.title })));
  // Même numéro ET au moins un mot du nom en commun (les numéros se répètent d'une licence à l'autre)
  const pool = sample.filter((it) => it.id !== item.id && it.price > 0 && !POP_EXCLUDE.test(it.title) &&
    popNumber(it.title) === num && (!words.length || popWords(it.title).some((w) => words.includes(w))));
  if (pool.length < 4) return null;
  return { value: Math.round(marketPrice(pool.map((it) => it.price)) * 100) / 100, source: 'Vinted', label: `prix courant de ${pool.length} annonces du même Pop (n°${num})` };
}

// ---- Vêtements et autres : même marque, même type, même taille ----
async function vintedMedian(item, search) {
  if (/funko|\bpop\b/i.test(`${item.title} ${item.brand} ${search.query}`)) return popMedian(item);
  const params = filterParams(search.query);
  let key = `v:${search.id}`;
  const id = await brandId(item.brand);
  if (id) { params.set('attribute_ids[brand]', id); key += `:b${id}`; }
  else if (params.has('attribute_ids[brand]')) return null; // marque inconnue : pas de comparaison fiable
  const type = typeOf(item.title);
  if (!type) return null; // type d'article inconnu : on ne compare pas des choses différentes
  const sample = await cached(key, 6, async () => {
    params.set('per_page', '96');
    params.set('order', 'newest_first');
    return (await searchRaw(params)).map((it) => ({ id: it.id, price: it.price, title: it.title, details: it.details }));
  });
  // Uniquement des articles du même type (une veste avec des vestes), puis de la même taille si possible
  let pool = sample.filter((it) => it.id !== item.id && it.price > 0 && typeOf(it.title) === type);
  if (pool.length < MIN_SAMPLES) return null;
  let what = 'du même type';
  const size = sizeOf(item.details);
  const sameSize = size ? pool.filter((it) => sizeOf(it.details) === size) : [];
  if (sameSize.length >= MIN_SAMPLES) { pool = sameSize; what += ', même taille'; }
  // Neuf et occasion ne se vendent pas au même prix
  const cond = condOf(item.details);
  const sameCond = pool.filter((it) => condOf(it.details) === cond);
  if (sameCond.length >= MIN_SAMPLES) { pool = sameCond; what += cond === 'neuf' ? ', neuf' : ', occasion'; }
  return { value: Math.round(marketPrice(pool.map((it) => it.price)) * 100) / 100, source: 'Vinted', label: `prix courant de ${pool.length} annonces ${what}` };
}

// ---- Estimation + verdict ----
const update = db.prepare('UPDATE items SET data = ? WHERE item_id = ?');
let chain = Promise.resolve();

export function appraise(item, search) {
  const job = chain.then(async () => {
    try {
      delete item.estimate;
      delete item.discount;
      item.deal = false;
      // Les cartes Pokémon ont des prix trop variés pour une médiane : seulement la cote Cardmarket
      const isPokemon = /pok[eé]mon/i.test(`${item.title} ${item.brand} ${search.query}`);
      const estimate = isPokemon ? await pokemonCard(item).catch(() => null) : await vintedMedian(item, search);
      if (estimate) {
        const threshold = (Number(getSettings().deal_threshold) || 30) / 100;
        item.estimate = estimate;
        item.discount = Math.round((1 - item.price / estimate.value) * 100);
        item.deal = item.price <= estimate.value * (1 - threshold) && estimate.value - item.price >= MIN_SAVING;
        // Beaucoup trop bas pour être vrai : souvent une contrefaçon, à vérifier avant d'acheter
        item.suspect = item.deal && item.discount >= 70 && estimate.value >= 40;
      }
      item.appraised = true;
      update.run(JSON.stringify(item), item.id);
    } catch (e) {
      console.error(`[cote ${item.id}]`, e.message);
    }
    return item;
  });
  chain = job.then(() => sleep(300));
  return job;
}
