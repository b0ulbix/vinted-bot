// Base de données SQLite (intégrée à Node, rien à installer)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || dataDir + 'vinted.db');

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    max_price REAL,
    active INTEGER NOT NULL DEFAULT 1,
    notify_discord INTEGER NOT NULL DEFAULT 1,
    notify_telegram INTEGER NOT NULL DEFAULT 1,
    initialized INTEGER NOT NULL DEFAULT 0,
    last_check TEXT,
    last_error TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS items (
    search_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    found_at TEXT NOT NULL,
    PRIMARY KEY (search_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS items_found ON items (found_at DESC);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Mises à jour de la base pour les versions plus récentes
const columns = db.prepare('PRAGMA table_info(searches)').all().map((c) => c.name);
if (!columns.includes('discord_webhook')) db.exec('ALTER TABLE searches ADD COLUMN discord_webhook TEXT');
// Discord : n'envoyer que les bonnes affaires pour cette catégorie (utile pour les recherches très actives)
if (!columns.includes('discord_deals_only')) db.exec('ALTER TABLE searches ADD COLUMN discord_deals_only INTEGER NOT NULL DEFAULT 0');
// Noms affichés des filtres choisis (catégorie, marques), pour les réafficher dans le formulaire
if (!columns.includes('labels')) db.exec('ALTER TABLE searches ADD COLUMN labels TEXT');
// Groupe de la catégorie (ex : « Perso », « Revente »), pour les ranger ensemble
if (!columns.includes('grp')) db.exec("ALTER TABLE searches ADD COLUMN grp TEXT NOT NULL DEFAULT 'Général'");

const DEFAULTS = {
  interval_sec: '30',
  discord_webhook: '',
  telegram_token: '',
  telegram_chat_id: '',
  deal_threshold: '30',        // % sous la cote pour être une « bonne affaire »
  telegram_deals_only: '1',    // Telegram ne sonne que pour les bonnes affaires
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function saveSettings(values) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const key of Object.keys(DEFAULTS)) {
    if (values[key] !== undefined) stmt.run(key, String(values[key]).trim());
  }
}

// Valeur interne (ex : clé secrète des sessions), créée au premier lancement
export function getInternal(key, create) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const value = create();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return value;
}
