const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euros = (n) => Number(n).toFixed(2).replace('.', ',') + ' €';

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) location.href = '/login';
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

function toast(msg, isErr = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function ago(iso) {
  if (!iso) return 'jamais';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('fr-FR');
}
const plural = (n, word) => `${n.toLocaleString('fr-FR')} ${word}${n > 1 ? 's' : ''}`;

// ---- Onglets ----
function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  for (const t of ['items', 'searches', 'settings']) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  if (tab === 'settings') loadSettings();
  scrollTo({ top: 0 });
}
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

$('#logout').onclick = async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login';
};

// ---- Statut ----
let status = {};
async function loadStatus() {
  status = await api('/status');
  const ok = status.lastCycle && Date.now() - new Date(status.lastCycle) < Math.max(120, status.interval * 6) * 1000;
  $('#live').classList.toggle('ok', !!ok);
  $('#live span').textContent = ok ? 'En direct' : 'En attente';
  $('#live').title = `Dernier passage ${ago(status.lastCycle)} · toutes les ${status.interval} s · Discord ${status.discord ? '✓' : '✗'} · Telegram ${status.telegram ? '✓' : '✗'}`;
}

// ---- Choix du groupe / de la catégorie affichés ----
const view = { group: '', search: '' };
let searches = [];
const groupsOf = () => [...new Set(searches.map((s) => s.grp))];

const DEALS = '__deals'; // onglet spécial : toutes les bonnes affaires
function renderChips() {
  const groups = groupsOf();
  if (view.group && view.group !== DEALS && !groups.includes(view.group)) view.group = view.search = '';
  $('#group-chips').innerHTML = [['', 'Tout', searches.length], [DEALS, '🔥 Bonnes affaires', ''], ...groups.map((g) => [g, g, searches.filter((s) => s.grp === g).length])]
    .map(([g, label, n]) => `<button class="pill${view.group === g ? ' on' : ''}${g === DEALS ? ' deal' : ''}" data-group="${esc(g)}">${esc(label)} <small>${n}</small></button>`).join('');
  const inGroup = view.group ? searches.filter((s) => s.grp === view.group) : [];
  $('#search-chips').innerHTML = inGroup.length > 1
    ? [`<button class="pill${view.search ? '' : ' on'}" data-search="">Toutes</button>`,
      ...inGroup.map((s) => `<button class="pill${String(s.id) === view.search ? ' on' : ''}" data-search="${s.id}">${esc(s.name)}</button>`)].join('')
    : '';
}
$('#group-chips').onclick = (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  view.group = b.dataset.group;
  view.search = '';
  renderChips();
  loadItems(true);
};
$('#search-chips').onclick = (e) => {
  const b = e.target.closest('[data-search]');
  if (!b) return;
  view.search = b.dataset.search;
  renderChips();
  loadItems(true);
};
$('#sort').onchange = () => loadItems(true);

function openSearchItems(s) {
  view.group = s.grp;
  view.search = String(s.id);
  renderChips();
  showTab('items');
  loadItems(true);
}

// ---- Annonces ----
// Les annonces arrivées après l'ouverture de la page sont marquées « NOUVEAU »
const pageOpened = new Date().toISOString();
const itemsByKey = new Map();
const keyOf = (it) => `${it.search_id}-${it.id}`;
const photosOf = (it) => (it.photos?.length ? it.photos : [{ thumb: it.photo, full: it.photo_large }]).filter((p) => p.thumb);

// Galerie à balayer (doigt, molette, flèches) avec compteur et points
function galleryHTML(photos, big = false) {
  return `
    <div class="track">${photos.map((p, i) => `<img src="${esc(big ? p.full : p.thumb)}" alt="" loading="${i ? 'lazy' : 'eager'}" draggable="false">`).join('')}</div>
    ${photos.length > 1 ? `
      <button class="nav prev" aria-label="Photo précédente">‹</button>
      <button class="nav next" aria-label="Photo suivante">›</button>
      <span class="count">1/${photos.length}</span>
      <div class="dots">${photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}`;
}

function wireGallery(root) {
  const track = root.querySelector('.track');
  const go = (dir) => track.scrollBy({ left: dir * track.clientWidth, behavior: 'smooth' });
  root.querySelector('.prev')?.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
  root.querySelector('.next')?.addEventListener('click', (e) => { e.stopPropagation(); go(1); });
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    const count = root.querySelector('.count');
    if (count) count.textContent = `${i + 1}/${track.children.length}`;
    root.querySelectorAll('.dots i').forEach((d, j) => d.classList.toggle('on', i === j));
  }, { passive: true });
  return track;
}

function createCard(it) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.key = keyOf(it);
  el.innerHTML = `
    <div class="gallery">${galleryHTML(photosOf(it))}</div>
    <span class="badge">${esc(it.search_name)}</span>
    ${it.found_at > pageOpened ? '<span class="badge new">NOUVEAU</span>' : ''}
    <span class="badge deal${it.deal ? '' : ' hidden'}">🔥 -${it.discount ?? ''} %</span>
    <div class="body">
      <div class="price">${euros(it.price)}<small>${euros(it.total)} avec frais</small></div>
      <div class="t" title="${esc(it.title)}">${esc(it.title)}</div>
      <div class="m">${esc([it.brand, it.details].filter(Boolean).join(' · '))}</div>
      <div class="cote">${coteHTML(it)}</div>
      <div class="foot">
        <span class="ago">${ago(it.found_at)}</span>
        <a class="btn buy" href="${esc(it.url)}" target="_blank" rel="noopener">Acheter</a>
      </div>
    </div>`;
  wireGallery(el.querySelector('.gallery'));
  el.querySelector('.gallery').addEventListener('click', () => {
    const track = el.querySelector('.track');
    openLightbox(itemsByKey.get(el.dataset.key), Math.round(track.scrollLeft / track.clientWidth));
  });
  if (!it.photos_full || !it.appraised) photoObserver.observe(el);
  return el;
}

// Ligne « cote » sous l'annonce
function coteHTML(it) {
  if (!it.appraised) return '<span class="muted">Cote : calcul…</span>';
  if (!it.estimate) return '<span class="muted">Cote : pas assez d\'annonces comparables</span>';
  const d = it.discount ?? 0;
  const cls = it.deal ? 'good' : d > 0 ? 'ok' : 'bad';
  return `<span title="${esc(`${it.estimate.source} · ${it.estimate.label}`)}">Cote ~${euros(it.estimate.value)}</span>
    <b class="${cls}">${d > 0 ? '-' : '+'}${Math.abs(d)} %</b>
    ${it.suspect ? '<span class="warn" title="Prix très bas : souvent une contrefaçon">⚠ vérifie l\'authenticité</span>' : ''}`;
}

function applyEstimate(el, it) {
  el.querySelector('.cote').innerHTML = coteHTML(it);
  const badge = el.querySelector('.badge.deal');
  badge.textContent = `🔥 -${it.discount} %`;
  badge.classList.toggle('hidden', !it.deal);
}

// Quand une annonce apparaît à l'écran, on va chercher toutes ses photos
const photoObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    photoObserver.unobserve(e.target);
    const it = itemsByKey.get(e.target.dataset.key);
    if (!it) continue;
    if (!it.photos_full) {
      api(`/items/${it.id}/photos`).then((photos) => {
        for (const [, other] of itemsByKey) if (other.id === it.id) { other.photos = photos; other.photos_full = true; }
        if (photos.length <= 1) return;
        const gallery = e.target.querySelector('.gallery');
        gallery.innerHTML = galleryHTML(photos);
        wireGallery(gallery);
      }).catch(() => {});
    }
    // Calcule la cote des annonces trouvées avant l'ajout de cette fonction
    if (!it.appraised) {
      api(`/items/${it.search_id}/${it.id}/estimate`).then((r) => {
        Object.assign(it, { estimate: r.estimate, deal: r.deal, discount: r.discount, suspect: r.suspect, appraised: true });
        applyEstimate(e.target, it);
      }).catch(() => {});
    }
  }
}, { rootMargin: '300px' });

function sortItems(items) {
  const mode = $('#sort').value;
  if (mode === 'price_asc') return items.sort((a, b) => a.price - b.price);
  if (mode === 'price_desc') return items.sort((a, b) => b.price - a.price);
  return items;
}

// Met à jour la grille sans tout redessiner (sinon les galeries reviendraient à la 1re photo)
async function loadItems(reset = false) {
  const q = view.group === DEALS ? '?deals=1' : view.search ? `?search_id=${view.search}` : view.group ? `?group=${encodeURIComponent(view.group)}` : '';
  const items = sortItems(await api('/items' + q + (q ? '&' : '?') + 'limit=200'));
  const grid = $('#items');
  if (reset) { grid.innerHTML = ''; itemsByKey.clear(); }
  $('#items-sub').textContent = `${plural(items.length, 'annonce')} · ${plural(status.active || 0, 'catégorie active')} · mise à jour ${ago(status.lastCycle)}`;
  grid.querySelector('.empty')?.remove();
  if (!items.length) {
    grid.innerHTML = `<div class="empty"><b>Aucune annonce pour l'instant</b>${searches.length ? 'Elles apparaîtront ici dès qu\'elles sortent sur Vinted.' : 'Crée ta première catégorie dans l\'onglet « Catégories ».'}</div>`;
    itemsByKey.clear();
    return;
  }
  const keep = new Set(items.map(keyOf));
  for (const el of [...grid.children]) if (!keep.has(el.dataset.key)) { el.remove(); itemsByKey.delete(el.dataset.key); }
  let cursor = grid.firstElementChild;
  for (const it of items) {
    const key = keyOf(it);
    let el = grid.querySelector(`[data-key="${key}"]`);
    if (el) {
      el.querySelector('.ago').textContent = ago(it.found_at);
      // La cote a été calculée côté serveur depuis le dernier affichage
      const known = itemsByKey.get(key);
      if (it.appraised && known && !known.appraised) { Object.assign(known, it); applyEstimate(el, known); }
      if (el === cursor) cursor = cursor.nextElementSibling;
      else grid.insertBefore(el, cursor);
    } else {
      itemsByKey.set(key, it);
      el = createCard(it);
      grid.insertBefore(el, cursor);
    }
  }
}

// ---- Visionneuse plein écran ----
const lb = $('#lightbox');
function openLightbox(it, index = 0) {
  const photos = photosOf(it);
  lb.querySelector('.lb-gallery').innerHTML = galleryHTML(photos, true);
  const track = wireGallery(lb.querySelector('.lb-gallery'));
  lb.querySelector('.lb-title').textContent = it.title;
  lb.querySelector('.lb-price').textContent = `${euros(it.price)} · ${euros(it.total)} avec frais · ${[it.brand, it.details].filter(Boolean).join(' · ')}` +
    (it.estimate ? ` · cote ~${euros(it.estimate.value)}${it.deal ? ` 🔥 -${it.discount} %` : ''}` : '');
  lb.querySelector('.lb-buy').href = it.url;
  lb.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => { track.scrollLeft = index * track.clientWidth; });
}
function closeLightbox() {
  lb.classList.add('hidden');
  document.body.style.overflow = '';
}
lb.querySelector('.lb-close').onclick = closeLightbox;
document.addEventListener('keydown', (e) => {
  if (lb.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowRight') lb.querySelector('.next')?.click();
  if (e.key === 'ArrowLeft') lb.querySelector('.prev')?.click();
});

// ---- Catégories ----
async function loadSearches() {
  searches = await api('/searches');
  renderChips();
  $('#groups').innerHTML = groupsOf().map((g) => `<option value="${esc(g)}">`).join('');
  const groups = groupsOf();
  $('#searches').innerHTML = groups.length
    ? groups.map((g) => {
      const list = searches.filter((s) => s.grp === g);
      return `
        <section class="group">
          <div class="group-head"><h2>${esc(g)}</h2><span class="n">${list.length}</span></div>
          <div class="scards">${list.map(searchCard).join('')}</div>
        </section>`;
    }).join('')
    : '<div class="empty"><b>Aucune catégorie</b>Clique sur « Nouvelle catégorie » pour commencer.</div>';
}

function searchCard(s) {
  return `
    <article class="scard ${s.active ? '' : 'off'}">
      <button class="cover" data-act="view" data-id="${s.id}" style="background-image:url('${esc(s.cover || '')}')" aria-label="Voir les annonces"></button>
      <div class="sbody">
        <div class="stop">
          <h3>${esc(s.name)}</h3>
          <label class="toggle" title="${s.active ? 'Mettre en pause' : 'Activer'}"><input type="checkbox" data-act="toggle" data-id="${s.id}" ${s.active ? 'checked' : ''}><span class="switch"></span></label>
        </div>
        <p class="ssum">${esc(summarize(s))}</p>
        <div class="smeta">
          <span class="tag">${plural(s.item_count, 'annonce')}</span>
          <span class="tag">vérifiée ${ago(s.last_check)}</span>
          ${s.notify_discord ? `<span class="tag accent">Discord${s.discord_webhook ? ' · salon dédié' : ''}${s.discord_deals_only ? ' · 🔥 seules' : ''}</span>` : ''}
          ${s.notify_telegram ? '<span class="tag accent">Telegram</span>' : ''}
          ${s.last_error ? `<span class="tag err" title="${esc(s.last_error)}">⚠ erreur</span>` : ''}
        </div>
        <div class="sacts">
          <button class="btn small" data-act="view" data-id="${s.id}">Voir les annonces</button>
          <button class="btn ghost small" data-act="edit" data-id="${s.id}">Modifier</button>
          <a class="btn ghost small" href="${esc(vintedUrl(s.query))}" target="_blank" rel="noopener">Vinted ↗</a>
          <button class="btn danger small" data-act="delete" data-id="${s.id}">Supprimer</button>
        </div>
      </div>
    </article>`;
}

$('#searches').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const s = searches.find((x) => x.id === Number(b.dataset.id));
  try {
    if (b.dataset.act === 'view') return openSearchItems(s);
    if (b.dataset.act === 'edit') return fillForm(s);
    if (b.dataset.act === 'delete') {
      if (!confirm(`Supprimer la catégorie « ${s.name} » et ses annonces enregistrées ?`)) return;
      await api(`/searches/${s.id}`, { method: 'DELETE' });
      toast('Catégorie supprimée');
      refresh();
    }
  } catch (err) { toast(err.message, true); }
});
$('#searches').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-act="toggle"]');
  if (!input) return;
  try {
    await api(`/searches/${input.dataset.id}`, { method: 'PUT', body: { active: input.checked } });
    toast(input.checked ? 'Catégorie activée' : 'Catégorie en pause');
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---- Réglages ----
const sform = $('#settings-form');
const SETTINGS = ['interval_sec', 'discord_webhook', 'telegram_token', 'telegram_chat_id', 'deal_threshold'];
async function loadSettings() {
  const s = await api('/settings');
  for (const k of SETTINGS) sform[k].value = s[k];
  sform.telegram_deals_only.checked = s.telegram_deals_only === '1';
}
async function saveSettings() {
  const body = {};
  for (const k of SETTINGS) body[k] = sform[k].value;
  body.telegram_deals_only = sform.telegram_deals_only.checked ? '1' : '0';
  await api('/settings', { method: 'PUT', body });
}
sform.onsubmit = async (e) => {
  e.preventDefault();
  try { await saveSettings(); toast('Réglages enregistrés'); loadStatus(); } catch (err) { toast(err.message, true); }
};
document.querySelectorAll('[data-test]').forEach((b) => {
  b.onclick = async () => {
    b.disabled = true;
    try {
      await saveSettings();
      await api('/test/' + b.dataset.test, { method: 'POST' });
      toast('Message de test envoyé ✅');
      loadStatus();
    } catch (err) { toast(err.message, true); }
    b.disabled = false;
  };
});
$('#find-chat').onclick = async () => {
  try {
    await saveSettings();
    const chats = await api('/telegram/chats');
    if (!chats.length) return toast('Aucun message reçu : envoie d\'abord un message à ton bot sur Telegram', true);
    sform.telegram_chat_id.value = chats[chats.length - 1].id;
    await saveSettings();
    toast(`Chat trouvé : ${chats[chats.length - 1].name}`);
  } catch (err) { toast(err.message, true); }
};

// ---- Rafraîchissement ----
async function refresh() {
  try { await Promise.all([loadStatus(), loadSearches()]); await loadItems(); } catch (err) { toast(err.message, true); }
}
refresh();
setInterval(refresh, 15000);
