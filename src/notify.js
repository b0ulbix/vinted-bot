// Envoi des alertes sur Discord et Telegram, avec toutes les photos et un bouton « Acheter »
import sharp from 'sharp';
import { getSettings } from './db.js';
import { downloadImage } from './vinted.js';

const MAX_PHOTOS = 10; // limite de Discord et Telegram par message
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const euros = (n) => n.toFixed(2).replace('.', ',') + ' €';

// Réessaie jusqu'à 3 fois en cas de coupure réseau (« fetch failed »)
async function fetchRetry(url, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...options, body: typeof options.body === 'function' ? options.body() : options.body, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (attempt >= 3) throw new Error(`réseau (${e.cause?.code || e.name})`);
      await sleep(2000 * attempt);
    }
  }
}

// Télécharge les photos une seule fois et les convertit en JPEG (format accepté partout)
async function getImages(item) {
  const urls = (item.photos?.length ? item.photos.map((p) => p.full) : [item.photo_large]).filter(Boolean).slice(0, MAX_PHOTOS);
  const results = await Promise.allSettled(urls.map(async (u) => sharp(await downloadImage(u)).jpeg({ quality: 85 }).toBuffer()));
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// ---- Discord ----
async function postDiscord(url, form) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchRetry(url, { method: 'POST', body: form });
    if (res.ok) return null;
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await sleep((data.retry_after || 2) * 1000);
      continue;
    }
    return res;
  }
  throw new Error('Discord : trop de messages, réessaie plus tard');
}

export async function sendDiscord(webhook, item, searchName, images) {
  const payload = {
    username: 'Vinted Bot',
    embeds: [{
      title: (item.deal ? `🔥 BONNE AFFAIRE -${item.discount} % · ` : '') + item.title.slice(0, 220),
      url: item.url,
      color: item.deal ? 0xff6b2c : 0x09b1ba,
      description: `**[🛒 Acheter sur Vinted](${item.url})**` +
        (item.suspect ? '\n⚠️ Prix très bas : vérifie bien l\'authenticité avant d\'acheter' : ''),
      fields: [
        { name: 'Prix', value: euros(item.price), inline: true },
        ...(item.estimate ? [{ name: 'Cote estimée', value: `${euros(item.estimate.value)} (${item.discount > 0 ? '-' : '+'}${Math.abs(item.discount)} %)\n${item.estimate.source} · ${item.estimate.label}`.slice(0, 1000), inline: true }] : []),
        { name: 'Avec protection', value: euros(item.total), inline: true },
        { name: 'Marque', value: item.brand || '—', inline: true },
        { name: 'Taille / état', value: item.details || '—', inline: true },
        { name: 'Vendeur', value: item.seller || '—', inline: true },
        { name: 'Photos', value: String(images.length), inline: true },
      ],
      footer: { text: `Recherche : ${searchName}` },
      timestamp: new Date().toISOString(),
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Acheter', emoji: { name: '🛒' }, url: item.url }] }],
    attachments: images.map((_, i) => ({ id: i, filename: `photo${i + 1}.jpg` })),
  };
  // Les photos sont envoyées en pièces jointes : Discord les affiche en mosaïque, et on peut les faire défiler en cliquant dessus
  const form = (withButton = true) => () => {
    const f = new FormData();
    const body = withButton ? payload : { ...payload, components: undefined };
    f.append('payload_json', JSON.stringify(body));
    images.forEach((buf, i) => f.append(`files[${i}]`, new Blob([buf], { type: 'image/jpeg' }), `photo${i + 1}.jpg`));
    return f;
  };
  const sep = webhook.includes('?') ? '&' : '?';
  let failed = await postDiscord(`${webhook}${sep}with_components=true`, form(true));
  // Si Discord refuse le bouton, on renvoie sans (le lien « Acheter » reste dans le message)
  if (failed?.status === 400) failed = await postDiscord(webhook, form(false));
  if (failed) throw new Error(`Discord a refusé le message (code ${failed.status})`);
}

// ---- Telegram ----
async function telegram(token, method, fields, files = []) {
  const body = () => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    files.forEach(({ name, buf }) => f.append(name, new Blob([buf], { type: 'image/jpeg' }), name + '.jpg'));
    return f;
  };
  // Telegram limite le nombre de messages par minute : on envoie un message à la fois et on attend si on va trop vite
  const job = telegramQueue.then(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetchRetry(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body }).then((r) => r.json());
      if (res.ok) return res.result;
      const wait = res.parameters?.retry_after;
      if (!wait) throw new Error(`Telegram : ${res.description || 'erreur inconnue'}`);
      await sleep((wait + 1) * 1000);
    }
    throw new Error('Telegram : trop de messages, alerte abandonnée');
  });
  telegramQueue = job.catch(() => {}).then(() => sleep(1100));
  return job;
}
let telegramQueue = Promise.resolve();

export async function sendTelegram(token, chatId, item, searchName, images) {
  const caption =
    (item.deal ? `🔥 <b>BONNE AFFAIRE -${item.discount} %</b>\n` : '') +
    `<b>${esc(item.title)}</b>\n` +
    `💶 <b>${euros(item.price)}</b> (${euros(item.total)} avec protection)\n` +
    (item.estimate ? `📊 Cote ~${euros(item.estimate.value)} (${esc(item.estimate.source)})\n` : '') +
    (item.suspect ? '⚠️ Prix très bas : vérifie l\'authenticité\n' : '') +
    (item.brand ? `🏷 ${esc(item.brand)}\n` : '') +
    (item.details ? `👕 ${esc(item.details)}\n` : '') +
    `🔎 ${esc(searchName)}`;
  const buyButton = { inline_keyboard: [[{ text: '🛒 Acheter', url: item.url }]] };

  if (images.length >= 2) {
    // Album : on fait défiler les photos en balayant
    const files = images.map((buf, i) => ({ name: `p${i}`, buf }));
    const media = files.map((f, i) => ({ type: 'photo', media: `attach://${f.name}`, ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}) }));
    let sent = null;
    try {
      sent = await telegram(token, 'sendMediaGroup', { chat_id: chatId, media }, files);
    } catch (e) {
      // Si Telegram refuse une des photos, on envoie au moins la première avec le bouton
      if (!/Bad Request/.test(e.message)) throw e;
      return sendTelegram(token, chatId, item, searchName, images.slice(0, 1));
    }
    // Un album ne peut pas avoir de bouton : on l'ajoute juste en dessous, sans 2e sonnerie
    await telegram(token, 'sendMessage', {
      chat_id: chatId, text: `🛒 <b>${euros(item.price)}</b> · ${esc(item.title)}`, parse_mode: 'HTML',
      reply_markup: buyButton, disable_notification: true, reply_parameters: { message_id: sent[0].message_id },
    });
  } else if (images.length === 1) {
    try {
      await telegram(token, 'sendPhoto', { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup: buyButton }, [{ name: 'photo', buf: images[0] }]);
    } catch (e) {
      if (!/Bad Request/.test(e.message)) throw e;
      return sendTelegram(token, chatId, item, searchName, []); // dernier recours : message texte
    }
  } else {
    await telegram(token, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: buyButton });
  }
}

// Un salon Discord accepte ~30 messages par minute : une file par salon, un message toutes les 2 s.
// Si la file déborde (recherche très active comme les cartes Pokémon), on laisse tomber
// les alertes ordinaires, mais jamais les bonnes affaires.
const MAX_QUEUE = 12;
const discordQueues = new Map();
let dropped = 0;

function discordQueue(webhook) {
  if (!discordQueues.has(webhook)) discordQueues.set(webhook, { chain: Promise.resolve(), pending: 0 });
  return discordQueues.get(webhook);
}

function enqueueDiscord(webhook, job) {
  const q = discordQueue(webhook);
  q.pending++;
  const p = q.chain.then(job);
  q.chain = p.catch(() => {}).then(() => sleep(2000));
  p.finally(() => q.pending--);
  return p;
}

export async function notifyItem(search, item) {
  const s = getSettings();
  // Chaque recherche peut avoir son propre salon Discord, sinon on utilise celui des réglages
  let discord = search.notify_discord && (search.discord_webhook || s.discord_webhook);
  if (search.discord_deals_only && !item.deal && !search.force) discord = null;
  if (discord && !item.deal && !search.force && discordQueue(discord).pending >= MAX_QUEUE) {
    discord = null;
    if (++dropped % 25 === 1) console.error(`[notif Discord] salon saturé : ${dropped} alerte(s) ordinaire(s) non envoyée(s) au total (elles restent visibles sur le site)`);
  }
  // Option : Telegram ne sonne que pour les bonnes affaires (Discord garde tout)
  const tg = search.notify_telegram && s.telegram_token && s.telegram_chat_id && (s.telegram_deals_only !== '1' || item.deal || search.force);
  if (!discord && !tg) return;
  const images = await getImages(item);
  const jobs = [];
  if (discord) jobs.push(enqueueDiscord(discord, () => sendDiscord(discord, item, search.name, images)));
  if (tg) jobs.push(sendTelegram(s.telegram_token, s.telegram_chat_id, item, search.name, images));
  const results = await Promise.allSettled(jobs);
  const names = [discord && 'Discord', tg && 'Telegram'].filter(Boolean);
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(`[notif ${names[i]}] ${item.title} :`, r.reason.message); });
  // On remonte l'erreur pour le bouton « Tester »
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

// Liste les conversations qui ont récemment écrit au bot Telegram (pour trouver le chat ID)
export async function telegramChats(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).then((r) => r.json());
  if (!res.ok) throw new Error(`Telegram : ${res.description || 'token invalide'}`);
  const chats = new Map();
  for (const u of res.result) {
    const chat = (u.message || u.channel_post || u.my_chat_member)?.chat;
    if (chat) chats.set(chat.id, { id: chat.id, name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username });
  }
  return [...chats.values()];
}
