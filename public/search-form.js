// Formulaire de recherche avec les filtres Vinted (catégorie, taille, marque, état, couleur, matière, prix)
const form = $('#search-form');
const MULTI = { size: 'size_ids[]', brand: 'brand_ids[]', status: 'status_ids[]', color: 'color_ids[]', material: 'material_ids[]' };
const ATTR_FROM_URL = { 'catalog[]': 'catalog', 'catalog_ids[]': 'catalog', ...Object.fromEntries(Object.entries(MULTI).map(([k, v]) => [v, k])) };

// État des filtres choisis : pour chaque filtre, id → nom affiché
// catalogPath = catégorie en cours de navigation, pinned = autres catégories ajoutées (ex : T-shirts + Pulls)
const F = { catalogPath: [], pinned: new Map(), size: new Map(), brand: new Map(), status: new Map(), color: new Map(), material: new Map() };
let autoName = true;

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---- URL Vinted ↔ filtres ----
function buildUrl() {
  const u = new URL('https://www.vinted.fr/catalog');
  const p = u.searchParams;
  const text = form.search_text.value.trim();
  if (text) p.set('search_text', text);
  for (const id of selectedCatalogs().keys()) p.append('catalog[]', id);
  for (const [code, key] of Object.entries(MULTI)) for (const id of F[code].keys()) p.append(key, id);
  if (form.price_from.value) p.set('price_from', form.price_from.value);
  if (form.price_to.value) p.set('price_to', form.price_to.value);
  p.set('order', 'newest_first');
  return u.toString();
}

function vintedUrl(query) {
  return /^https?:\/\//i.test(query) ? query : `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}&order=newest_first`;
}

function resetFilters() {
  F.catalogPath = [];
  F.pinned.clear();
  for (const code of Object.keys(MULTI)) F[code].clear();
  form.search_text.value = form.price_from.value = form.price_to.value = '';
}

function loadQuery(query, labels) {
  resetFilters();
  const names = labels?.names || {};
  if (!/^https?:\/\//i.test(query)) { form.search_text.value = query; return; }
  const url = new URL(query);
  const pathCat = url.pathname.match(/\/catalog\/(\d+)/)?.[1];
  const catIds = pathCat ? [pathCat] : [];
  for (const [k, v] of url.searchParams) {
    const code = ATTR_FROM_URL[k] || k.match(/^attribute_ids\[(\w+)\]$/)?.[1];
    if (k === 'search_text') form.search_text.value = v;
    else if (k === 'price_from') form.price_from.value = v;
    else if (k === 'price_to') form.price_to.value = v;
    else if (code === 'catalog') catIds.push(...v.split(',').filter(Boolean));
    else if (F[code] instanceof Map) for (const id of v.split(',')) if (id) F[code].set(id, names[`${code}:${id}`] || `n°${id}`);
  }
  const [first, ...others] = [...new Set(catIds)];
  if (first) F.catalogPath = labels?.catalogPath?.at(-1)?.id === first ? labels.catalogPath : [{ id: first, title: names[`catalog:${first}`] || `Catégorie n°${first}` }];
  for (const id of others) F.pinned.set(id, names[`catalog:${id}`] || `Catégorie n°${id}`);
}

function labelsValue() {
  const names = {};
  for (const code of Object.keys(MULTI)) for (const [id, title] of F[code]) names[`${code}:${id}`] = title;
  for (const [id, title] of F.pinned) names[`catalog:${id}`] = title;
  return { catalogPath: F.catalogPath, names };
}

// Toutes les catégories Vinted choisies : celle en cours + celles ajoutées
function selectedCatalogs() {
  const all = new Map();
  const cur = F.catalogPath.at(-1);
  if (cur) all.set(cur.id, cur.title);
  for (const [id, title] of F.pinned) all.set(id, title);
  return all;
}

// Résumé lisible d'une recherche pour la liste
function summarize(s) {
  if (!/^https?:\/\//i.test(s.query)) return `« ${s.query} »`;
  const labels = s.labels ? JSON.parse(s.labels) : null;
  const url = new URL(s.query);
  const parts = [];
  const text = url.searchParams.get('search_text');
  if (text) parts.push(`« ${text} »`);
  if (labels?.catalogPath?.length) parts.push(labels.catalogPath.map((c) => c.title).join(' › '));
  const groups = {};
  for (const [k, title] of Object.entries(labels?.names || {})) (groups[k.split(':')[0]] ||= []).push(title);
  for (const titles of Object.values(groups)) parts.push(titles.length > 4 ? `${titles.slice(0, 4).join(', ')} +${titles.length - 4}` : titles.join(', '));
  const from = url.searchParams.get('price_from');
  const to = url.searchParams.get('price_to');
  if (from || to) parts.push(from && to ? `${from}–${to} €` : from ? `dès ${from} €` : `max ${to} €`);
  return parts.join(' · ') || 'Tous les articles';
}

// ---- Affichage des filtres ----
function updateHeads() {
  for (const el of document.querySelectorAll('.filter[data-code]')) {
    const code = el.dataset.code;
    const sel = el.querySelector('.sel');
    let text = '';
    if (code === 'catalog') text = [...selectedCatalogs().values()].join(', ');
    else {
      const titles = [...F[code].values()];
      text = titles.length > 2 ? `${titles.slice(0, 2).join(', ')} +${titles.length - 2}` : titles.join(', ');
    }
    sel.textContent = text || 'Tous';
    el.classList.toggle('active', !!text);
  }
}

const chip = (code, o, on) => {
  const icon = o.prefix?.url ? `<img src="${esc(o.prefix.url)}" alt="">` : '';
  return `<button type="button" class="chip${on ? ' on' : ''}" data-code="${code}" data-id="${esc(o.id)}" data-title="${esc(o.title)}">${icon}${esc(o.title)}</button>`;
};

// Les tailles arrivent en groupes imbriqués : on les aplatit en lignes
function optionGroups(options) {
  const groups = [];
  const leaves = [];
  for (const o of options) {
    if (o.options?.length) groups.push(...optionGroups(o.options));
    else leaves.push(o);
  }
  return leaves.length ? [leaves, ...groups] : groups;
}

async function renderFilter(el) {
  const code = el.dataset.code;
  const body = el.querySelector('.filter-body');
  body.innerHTML = '<p class="hint">Chargement…</p>';
  try {
    if (code === 'catalog') {
      const current = F.catalogPath.at(-1);
      const children = await api(`/vinted/categories?id=${current?.id || ''}`);
      const pinned = [...F.pinned].map(([id, title]) => `<button type="button" class="chip on" data-unpin="${esc(id)}">${esc(title)} ✕</button>`).join('');
      body.innerHTML = `
        ${pinned ? `<div class="chips">${pinned}</div>` : ''}
        <div class="crumbs">
          <button type="button" class="crumb" data-depth="0">Toutes</button>
          ${F.catalogPath.map((c, i) => `› <button type="button" class="crumb" data-depth="${i + 1}">${esc(c.title)}</button>`).join(' ')}
        </div>
        <div class="chips">${children.map((c) => `<button type="button" class="chip" data-cat="${esc(c.id)}" data-title="${esc(c.title)}">${esc(c.title)} ›</button>`).join('')
          || '<span class="hint">C\'est la catégorie la plus précise ✓</span>'}</div>
        ${current ? '<div><button type="button" class="btn ghost small" data-pin="1">+ Ajouter une autre catégorie</button></div>' : ''}`;
      return;
    }
    let options = await api(`/vinted/facets?code=${code}&query=${encodeURIComponent(buildUrl())}`);
    let search = '';
    if (code === 'brand') {
      search = `<input type="text" class="brand-search" placeholder="Rechercher une marque…">`;
      const selected = [...F.brand].map(([id, title]) => ({ id, title }));
      options = [...selected, ...options.filter((o) => !F.brand.has(String(o.id)))];
    }
    const groups = optionGroups(options);
    body.innerHTML = search + (groups.length
      ? groups.map((g) => `<div class="chips">${g.map((o) => chip(code, o, F[code].has(String(o.id)))).join('')}</div>`).join('')
      : '<p class="hint">Aucune option pour cette recherche.</p>');
    // Corrige les noms affichés des filtres déjà choisis (utile pour les anciennes recherches)
    for (const g of groups) for (const o of g) if (F[code].has(String(o.id))) F[code].set(String(o.id), o.title);
    updateHeads();
  } catch (err) {
    body.innerHTML = `<p class="hint" style="color:var(--err)">${esc(err.message)}</p>`;
  }
}

// Après un changement, recharge les filtres ouverts (les tailles dépendent de la catégorie, etc.)
const refreshOpen = debounce(() => {
  for (const el of document.querySelectorAll('.filter[data-code]')) {
    if (!el.querySelector('.filter-body').classList.contains('hidden') && el.dataset.code !== 'catalog') renderFilter(el);
  }
}, 500);

function changed({ reloadFilters = false } = {}) {
  updateHeads();
  if (autoName) {
    const brands = [...F.brand.values()].slice(0, 2).join(' ');
    form.name.value = form.search_text.value.trim() || [F.catalogPath.at(-1)?.title, brands].filter(Boolean).join(' ') || '';
  }
  if (reloadFilters) refreshOpen();
  updatePreview();
}

// ---- Aperçu des annonces qui correspondent ----
const updatePreview = debounce(async () => {
  const box = $('#preview');
  const url = buildUrl();
  if (url === 'https://www.vinted.fr/catalog?order=newest_first') { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="hint">Recherche des annonces…</p>';
  try {
    const { total, items } = await api(`/vinted/preview?query=${encodeURIComponent(url)}`);
    box.innerHTML = `
      <div class="preview-head">
        <b>${total >= 960 ? '960+' : total} annonce(s)</b> correspondent · les plus récentes :
        <a href="${esc(url)}" target="_blank" rel="noopener">voir sur Vinted ↗</a>
      </div>
      <div class="preview-strip">${items.map((it) => `
        <a href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.title)}">
          <img src="${esc(it.photo || '')}" alt="" loading="lazy"><span>${euros(it.price)}</span>
        </a>`).join('') || '<span class="hint">Aucune annonce pour l\'instant avec ces filtres.</span>'}</div>`;
  } catch (err) {
    box.innerHTML = `<p class="hint" style="color:var(--err)">${esc(err.message)}</p>`;
  }
}, 700);

// ---- Événements ----
$('#filters').addEventListener('click', async (e) => {
  const head = e.target.closest('.filter-head');
  if (head) {
    const el = head.parentElement;
    const body = el.querySelector('.filter-body');
    const opening = body.classList.contains('hidden');
    body.classList.toggle('hidden', !opening);
    el.classList.toggle('open', opening);
    if (opening) renderFilter(el);
    return;
  }
  // Garde la catégorie en cours et repart de zéro pour en choisir une autre
  if (e.target.closest('[data-pin]')) {
    const cur = F.catalogPath.at(-1);
    if (cur) F.pinned.set(cur.id, cur.title);
    F.catalogPath = [];
    renderFilter(e.target.closest('.filter'));
    return changed({ reloadFilters: true });
  }
  const unpin = e.target.closest('[data-unpin]');
  if (unpin) {
    F.pinned.delete(unpin.dataset.unpin);
    renderFilter(unpin.closest('.filter'));
    return changed({ reloadFilters: true });
  }
  const crumb = e.target.closest('.crumb');
  if (crumb) {
    F.catalogPath = F.catalogPath.slice(0, Number(crumb.dataset.depth));
    renderFilter(crumb.closest('.filter'));
    return changed({ reloadFilters: true });
  }
  const c = e.target.closest('.chip');
  if (!c) return;
  if (c.dataset.cat) {
    F.catalogPath.push({ id: c.dataset.cat, title: c.dataset.title });
    renderFilter(c.closest('.filter'));
    return changed({ reloadFilters: true });
  }
  const map = F[c.dataset.code];
  if (map.has(c.dataset.id)) map.delete(c.dataset.id);
  else map.set(c.dataset.id, c.dataset.title);
  c.classList.toggle('on');
  changed();
});

// Recherche de marque
$('#filters').addEventListener('input', debounce(async (e) => {
  if (!e.target.classList.contains('brand-search')) return;
  const q = e.target.value.trim();
  const box = e.target.closest('.filter-body');
  const results = q ? await api(`/vinted/brands?q=${encodeURIComponent(q)}`).catch(() => []) : [];
  box.querySelectorAll('.chips').forEach((x) => x.remove());
  const selected = [...F.brand].map(([id, title]) => ({ id, title }));
  const list = [...selected, ...results.filter((b) => !F.brand.has(b.id))];
  box.insertAdjacentHTML('beforeend', `<div class="chips">${list.map((o) => chip('brand', o, F.brand.has(String(o.id)))).join('')}</div>`);
}, 300));

form.search_text.addEventListener('input', () => changed({ reloadFilters: true }));
form.price_from.addEventListener('input', () => changed());
form.price_to.addEventListener('input', () => changed());
form.name.addEventListener('input', () => { autoName = !form.name.value; });
form.paste_url.addEventListener('input', () => {
  const v = form.paste_url.value.trim();
  if (!/^https?:\/\/(www\.)?vinted\./i.test(v)) return;
  loadQuery(v, null);
  form.paste_url.value = '';
  toast('Filtres remplis depuis le lien : ouvre-les pour vérifier');
  changed({ reloadFilters: true });
});

// ---- Ajout / modification (fenêtre) ----
const sheet = $('#sheet');
function openSheet() {
  sheet.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  sheet.querySelector('.sheet-body').scrollTop = 0;
}
function closeSheet() {
  sheet.classList.add('hidden');
  document.body.style.overflow = '';
}
$('#close-sheet').onclick = closeSheet;
$('#cancel-edit').onclick = closeSheet;
sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.classList.contains('hidden')) closeSheet(); });
$('#new-search').onclick = () => fillForm(null);

function fillForm(s) {
  form.id.value = s?.id || '';
  loadQuery(s?.query || '', s?.labels ? JSON.parse(s.labels) : null);
  if (s?.max_price && !form.price_to.value) form.price_to.value = s.max_price;
  form.name.value = s?.name || '';
  form.grp.value = s?.grp || (view.group || '');
  autoName = !s;
  form.discord_webhook.value = s?.discord_webhook || '';
  form.discord_deals_only.checked = !!s?.discord_deals_only;
  form.paste_url.value = '';
  form.active.checked = s ? !!s.active : true;
  form.notify_discord.checked = s ? !!s.notify_discord : true;
  form.notify_telegram.checked = s ? !!s.notify_telegram : true;
  document.querySelectorAll('.filter-body').forEach((b) => b.classList.add('hidden'));
  document.querySelectorAll('.filter').forEach((b) => b.classList.remove('open'));
  $('#form-title').textContent = s ? `Modifier « ${s.name} »` : 'Nouvelle catégorie';
  $('#save-search').textContent = s ? 'Enregistrer' : 'Créer la catégorie';
  $('#preview').innerHTML = '';
  updateHeads();
  updatePreview();
  openSheet();
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#save-search');
  btn.disabled = true;
  const body = {
    name: form.name.value, grp: form.grp.value, query: buildUrl(), max_price: '', labels: labelsValue(),
    discord_webhook: form.discord_webhook.value, discord_deals_only: form.discord_deals_only.checked,
    active: form.active.checked, notify_discord: form.notify_discord.checked, notify_telegram: form.notify_telegram.checked,
  };
  try {
    if (form.id.value) await api(`/searches/${form.id.value}`, { method: 'PUT', body });
    else await api('/searches', { method: 'POST', body });
    toast(form.id.value ? 'Catégorie modifiée' : 'Catégorie créée : tu seras alerté des nouvelles annonces');
    closeSheet();
    refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
};

updateHeads();
