// Récupère toutes les photos d'une annonce (une seule fois, puis gardées en mémoire)
import { db } from './db.js';
import { itemPhotos } from './vinted.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const update = db.prepare('UPDATE items SET data = ? WHERE item_id = ?');

// Vinted bloque si on ouvre trop de pages d'annonces : 15 par minute au maximum,
// et pause de 2 minutes s'il nous demande de ralentir (code 429)
const MAX_PER_MIN = 15;
let calls = [];
let pausedUntil = 0;

// File d'attente : une page Vinted à la fois, pour rester discret
let chain = Promise.resolve();
const pending = new Map();

export function loadPhotos(item) {
  if (item.photos_full) return Promise.resolve(item);
  if (pending.has(item.id)) return pending.get(item.id);
  const job = chain.then(async () => {
    calls = calls.filter((t) => Date.now() - t < 60_000);
    // Trop de demandes : on garde la 1re photo pour l'instant (le site réessaiera plus tard)
    if (Date.now() < pausedUntil || calls.length >= MAX_PER_MIN) return item;
    calls.push(Date.now());
    try {
      const photos = await itemPhotos(item);
      if (photos.length) item.photos = photos;
      item.photos_full = true;
      update.run(JSON.stringify(item), item.id);
    } catch (e) {
      if (/429/.test(e.message)) {
        if (Date.now() >= pausedUntil) console.error('[photos] Vinted demande de ralentir : pause de 2 min');
        pausedUntil = Date.now() + 120_000;
      } else console.error(`[photos ${item.id}]`, e.message);
    }
    return item;
  });
  chain = job.then(() => sleep(400));
  pending.set(item.id, job);
  job.finally(() => pending.delete(item.id));
  return job;
}
