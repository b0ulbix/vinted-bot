// Boucle de surveillance : vérifie chaque recherche à intervalle régulier
import { db, getSettings } from './db.js';
import { search } from './vinted.js';
import { notifyItem } from './notify.js';
import { loadPhotos } from './photos.js';
import { appraise } from './pricing.js';

const MAX_NOTIFS_PER_CHECK = 10;
const KEEP_PER_SEARCH = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const state = { started: new Date().toISOString(), lastCycle: null, cycles: 0, found: 0 };

const insertItem = db.prepare('INSERT OR IGNORE INTO items (search_id, item_id, data, found_at) VALUES (?, ?, ?, ?)');
const maxId = db.prepare('SELECT MAX(item_id) AS m FROM items WHERE search_id = ?');
const markOk = db.prepare('UPDATE searches SET initialized = 1, last_check = ?, last_error = NULL WHERE id = ?');
const markError = db.prepare('UPDATE searches SET last_check = ?, last_error = ? WHERE id = ?');
const prune = db.prepare(`DELETE FROM items WHERE search_id = ? AND item_id NOT IN (
  SELECT item_id FROM items WHERE search_id = ? ORDER BY found_at DESC, item_id DESC LIMIT ${KEEP_PER_SEARCH})`);

export async function checkSearch(s) {
  const now = new Date().toISOString();
  try {
    const items = await search(s.query);
    // Les numéros d'annonce Vinted augmentent avec le temps : une vraie nouveauté a un numéro plus grand que tout ce qu'on a déjà vu
    const maxSeen = maxId.get(s.id).m || 0;
    const fresh = [];
    for (const it of items) {
      if (s.max_price && it.price > s.max_price) continue;
      if (insertItem.run(s.id, it.id, JSON.stringify(it), now).changes && it.id > maxSeen) fresh.push(it);
    }
    markOk.run(now, s.id);
    prune.run(s.id, s.id);
    // Premier passage : on enregistre l'existant sans notifier, pour ne pas spammer
    if (s.initialized && fresh.length) {
      state.found += fresh.length;
      console.log(`[${s.name}] ${fresh.length} nouvelle(s) annonce(s)`);
      // Photos + alertes en arrière-plan : la surveillance passe tout de suite à la catégorie suivante
      for (const it of fresh.slice(0, MAX_NOTIFS_PER_CHECK).reverse()) {
        loadPhotos(it).then(() => appraise(it, s)).then(() => notifyItem(s, it)).catch(() => {}); // erreurs déjà affichées dans le journal
      }
    }
  } catch (e) {
    console.error(`[${s.name}]`, e.message);
    markError.run(now, e.message, s.id);
  }
}

export function startScanner() {
  const tick = async () => {
    try {
      const searches = db.prepare('SELECT * FROM searches WHERE active = 1').all();
      for (const s of searches) {
        await checkSearch(s);
        await sleep(800); // petite pause entre deux recherches pour rester discret
      }
      state.lastCycle = new Date().toISOString();
      state.cycles++;
    } catch (e) {
      console.error('[scanner]', e);
    }
    const interval = Math.max(10, Number(getSettings().interval_sec) || 30);
    setTimeout(tick, interval * 1000);
  };
  tick();
}
