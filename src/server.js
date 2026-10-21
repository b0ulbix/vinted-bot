// Serveur web : tableau de bord + API
import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getSettings, saveSettings, getInternal } from './db.js';
import { startScanner, checkSearch, state } from './scanner.js';
import { filterParams, facets, categories, brands, preview } from './vinted.js';
import { notifyItem, telegramChats } from './notify.js';
import { loadPhotos } from './photos.js';
import { appraise } from './pricing.js';

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD;
if (!PASSWORD || PASSWORD === 'change-moi') {
  console.error('⚠  Définis DASHBOARD_PASSWORD dans le fichier .env avant de lancer le bot.');
  process.exit(1);
}

// Jeton de session : dépend du mot de passe, donc changer le mot de passe déconnecte tout le monde
const secret = getInternal('session_secret', () => randomBytes(32).toString('hex'));
const TOKEN = createHmac('sha256', secret).update(PASSWORD).digest('hex');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

function readCookie(req, name) {
  const match = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function isLogged(req) {
  const token = readCookie(req, 'session');
  return !!token && token.length === TOKEN.length && timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
}

app.post('/login', async (req, res) => {
  const pass = String(req.body?.password || '');
  const ok = pass.length === PASSWORD.length && timingSafeEqual(Buffer.from(pass), Buffer.from(PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1000)); // ralentit les essais de mots de passe
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  res.cookie('session', TOKEN, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 90 });
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/login', (req, res) => res.sendFile(publicDir + 'login.html'));
app.get('/style.css', (req, res) => res.set('Cache-Control', 'no-store').sendFile(publicDir + 'style.css'));
app.get('/favicon.svg', (req, res) => res.sendFile(publicDir + 'favicon.svg'));

// Tout le reste demande d'être connecté
app.use((req, res, next) => {
  if (isLogged(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non connecté' });
  res.redirect('/login');
});

// Pas de cache (sinon Cloudflare garde les anciennes versions du site)
app.use(express.static(publicDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

// ---- API ----
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

const flag = (v) => (v === undefined || v === null ? 1 : v ? 1 : 0);

function cleanSearch(body) {
  const name = String(body.name || '').trim();
  const grp = String(body.grp || '').trim().slice(0, 40) || 'Général';
  const query = String(body.query || '').trim();
  if (!name) throw new Error('Donne un nom à la recherche');
  if (!query) throw new Error('Indique des mots-clés ou colle une URL de recherche Vinted');
  if (/^https?:\/\//i.test(query) && !/vinted\./i.test(query)) throw new Error('Ce lien ne vient pas de Vinted');
  if (!filterParams(query).toString()) throw new Error('Ajoute au moins un mot-clé ou un filtre');
  const maxPrice = body.max_price === '' || body.max_price == null ? null : Number(body.max_price);
  if (maxPrice !== null && !(maxPrice > 0)) throw new Error('Prix max invalide');
  const webhook = String(body.discord_webhook || '').trim();
  if (webhook && !/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(webhook)) throw new Error('Lien de webhook Discord invalide');
  return {
    name, grp, query, max_price: maxPrice, discord_webhook: webhook || null,
    discord_deals_only: body.discord_deals_only ? 1 : 0,
    labels: body.labels ? (typeof body.labels === 'string' ? body.labels : JSON.stringify(body.labels)) : null,
    // Absent = activé par défaut ; false ou 0 (valeur déjà enregistrée) = désactivé
    active: flag(body.active),
    notify_discord: flag(body.notify_discord),
    notify_telegram: flag(body.notify_telegram),
  };
}

app.get('/api/status', (req, res) => {
  const counts = db.prepare('SELECT COUNT(*) AS searches, SUM(active) AS active, (SELECT COUNT(*) FROM items) AS items FROM searches').get();
  const s = getSettings();
  res.json({ ...state, ...counts, interval: Number(s.interval_sec), discord: !!s.discord_webhook, telegram: !!(s.telegram_token && s.telegram_chat_id) });
});

app.get('/api/searches', (req, res) => {
  const rows = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.search_id = s.id) AS item_count,
    (SELECT data FROM items i WHERE i.search_id = s.id ORDER BY found_at DESC, item_id DESC LIMIT 1) AS last_item
    FROM searches s ORDER BY s.grp COLLATE NOCASE, s.id`).all();
  // Photo de couverture = dernière annonce trouvée
  res.json(rows.map(({ last_item, ...s }) => ({ ...s, cover: last_item ? JSON.parse(last_item).photo : null })));
});

app.post('/api/searches', wrap(async (req, res) => {
  const s = cleanSearch(req.body);
  const r = db.prepare(`INSERT INTO searches (name, grp, query, max_price, active, notify_discord, notify_telegram, discord_webhook, discord_deals_only, labels, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.name, s.grp, s.query, s.max_price, s.active, s.notify_discord, s.notify_telegram, s.discord_webhook, s.discord_deals_only, s.labels, new Date().toISOString());
  const created = db.prepare('SELECT * FROM searches WHERE id = ?').get(r.lastInsertRowid);
  await checkSearch(created); // premier passage tout de suite pour afficher les annonces
  res.json(db.prepare('SELECT * FROM searches WHERE id = ?').get(created.id));
}));

app.put('/api/searches/:id', wrap((req, res) => {
  const old = db.prepare('SELECT * FROM searches WHERE id = ?').get(req.params.id);
  if (!old) throw new Error('Recherche introuvable');
  const s = cleanSearch({ ...old, ...req.body });
  // Si la recherche change, le prochain passage ne notifie pas l'existant
  const initialized = s.query === old.query && s.max_price === old.max_price ? old.initialized : 0;
  db.prepare(`UPDATE searches SET name = ?, grp = ?, query = ?, max_price = ?, active = ?, notify_discord = ?, notify_telegram = ?, discord_webhook = ?, discord_deals_only = ?, labels = ?, initialized = ?
    WHERE id = ?`).run(s.name, s.grp, s.query, s.max_price, s.active, s.notify_discord, s.notify_telegram, s.discord_webhook, s.discord_deals_only, s.labels, initialized, old.id);
  res.json(db.prepare('SELECT * FROM searches WHERE id = ?').get(old.id));
}));

app.delete('/api/searches/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE search_id = ?').run(req.params.id);
  db.prepare('DELETE FROM searches WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 120, 500);
  const searchId = req.query.search_id ? Number(req.query.search_id) : null;
  const grp = req.query.group ? String(req.query.group) : null;
  const deals = req.query.deals === '1' ? 1 : null; // seulement les bonnes affaires
  const rows = db.prepare(`SELECT i.search_id, i.data, i.found_at, s.name AS search_name FROM items i
    JOIN searches s ON s.id = i.search_id
    WHERE (? IS NULL OR i.search_id = ?) AND (? IS NULL OR s.grp = ?) AND (? IS NULL OR json_extract(i.data, '$.deal') = 1)
    ORDER BY i.found_at DESC, i.item_id DESC LIMIT ?`).all(searchId, searchId, grp, grp, deals, limit);
  res.json(rows.map((r) => ({ ...JSON.parse(r.data), search_id: r.search_id, search_name: r.search_name, found_at: r.found_at })));
});

app.get('/api/settings', (req, res) => res.json(getSettings()));

app.put('/api/settings', (req, res) => {
  saveSettings(req.body || {});
  res.json(getSettings());
});

// ---- Filtres Vinted pour le formulaire (gardés en cache 1 h) ----
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const FACETS = new Set(['size', 'status', 'color', 'material', 'brand']);
app.get('/api/vinted/facets', wrap(async (req, res) => {
  const code = String(req.query.code);
  if (!FACETS.has(code)) throw new Error('Filtre inconnu');
  const query = String(req.query.query || '');
  res.json(await cached(`f:${code}:${query}`, () => facets(query, code)));
}));
app.get('/api/vinted/categories', wrap(async (req, res) => {
  const id = String(req.query.id || '');
  res.json(await cached(`c:${id}`, () => categories(id)));
}));
app.get('/api/vinted/brands', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(q ? await cached(`b:${q.toLowerCase()}`, () => brands(q)) : []);
}));
app.get('/api/vinted/preview', wrap(async (req, res) => {
  res.json(await preview(String(req.query.query || '')));
}));

// Toutes les photos d'une annonce (chargées à la demande par le tableau de bord)
app.get('/api/items/:itemId/photos', wrap(async (req, res) => {
  const row = db.prepare('SELECT data FROM items WHERE item_id = ? LIMIT 1').get(Number(req.params.itemId));
  if (!row) throw new Error('Annonce introuvable');
  const item = await loadPhotos(JSON.parse(row.data));
  res.json(item.photos || []);
}));

// Cote d'une annonce déjà enregistrée (calculée à la demande quand elle s'affiche sur le site)
app.get('/api/items/:searchId/:itemId/estimate', wrap(async (req, res) => {
  const row = db.prepare(`SELECT i.data, s.* FROM items i JOIN searches s ON s.id = i.search_id
    WHERE i.search_id = ? AND i.item_id = ?`).get(Number(req.params.searchId), Number(req.params.itemId));
  if (!row) throw new Error('Annonce introuvable');
  let item = JSON.parse(row.data);
  if (!item.appraised) item = await appraise(item, row);
  res.json({ estimate: item.estimate || null, deal: !!item.deal, discount: item.discount ?? null, suspect: !!item.suspect });
}));

// Le test envoie la dernière vraie annonce trouvée, avec ses photos
app.post('/api/test/:target', wrap(async (req, res) => {
  const s = getSettings();
  const target = req.params.target;
  if (target === 'discord' && !s.discord_webhook) throw new Error('Ajoute d\'abord le lien du webhook Discord');
  if (target === 'telegram' && !(s.telegram_token && s.telegram_chat_id)) throw new Error('Ajoute d\'abord le token et le chat ID Telegram');
  const row = db.prepare('SELECT data FROM items ORDER BY found_at DESC, item_id DESC LIMIT 1').get();
  if (!row) throw new Error('Ajoute d\'abord une recherche pour avoir une annonce à envoyer');
  const item = await loadPhotos(JSON.parse(row.data));
  await notifyItem({ name: 'Test', notify_discord: target === 'discord', notify_telegram: target === 'telegram', force: true }, item);
  res.json({ ok: true });
}));

app.get('/api/telegram/chats', wrap(async (req, res) => {
  const { telegram_token } = getSettings();
  if (!telegram_token) throw new Error('Ajoute d\'abord le token du bot Telegram');
  res.json(await telegramChats(telegram_token));
}));

app.listen(PORT, () => {
  console.log(`✅ Tableau de bord : http://localhost:${PORT}`);
  startScanner();
});
