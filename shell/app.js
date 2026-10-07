/* VK Player — интерфейс и плеер.
   Данные — через API веб-версии ВК (основной процесс выполняет запросы внутри страницы vk.com).
   Воспроизведение — свой <audio> + hls.js, поэтому музыка не прерывается ни при поиске,
   ни при переходах между разделами. */
'use strict';

const bridge = window.vkp;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// --- Помощники -----------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // только для наших статических иконок
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5l11.5 7L8 19z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3 17h3c5 0 6-10 11-10h3.5M3 7h3c5 0 6 10 11 10h3.5"/><path d="M18 4.5l2.5 2.5L18 9.5M18 14.5l2.5 2.5-2.5 2.5"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>',
  login: '<svg viewBox="0 0 24 24"><path d="M10 17l5-5-5-5M15 12H3M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.7" class="fill"/><circle cx="12" cy="12" r="1.7" class="fill"/><circle cx="18.5" cy="12" r="1.7" class="fill"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h7"/><path class="fill" d="M15.5 13.5l5 3-5 3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path class="fill" d="M11 3q1 7 8 8q-7 1-8 8q-1-7-8-8q7-1 8-8z"/></svg>',
  tune: '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 10.5h10M5 15h12M5 19.5h7"/></svg>',
};
const iconEl = (name) => el('span', { class: 'ico', html: ICON[name] }).firstChild;

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const tracksWord = (n) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;

// Журнал для отчёта разработчику: что приложение пробовало и что получило (без токенов и ссылок на звук)
const diag = {
  entries: [],
  add(area, text, data) {
    this.entries.push({ t: new Date().toISOString().slice(11, 19), area, text, data });
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400);
  },
  async save() {
    const scrub = (v) => JSON.stringify(v, (k, x) => (/token|access_key|^url$|secret/i.test(k) ? undefined : x), 1);
    const text = [
      `VK Player ${navigator.userAgent}`,
      `Вход: ${auth.loggedIn ? 'да' : 'нет'}`,
      '',
      ...this.entries.map((e) => `[${e.t}] ${e.area}: ${e.text}${e.data !== undefined ? '\n' + scrub(e.data) : ''}`),
    ].join('\n');
    const file = await bridge.saveReport(text);
    toast('Отчёт сохранён в «Загрузки»');
    return file;
  },
};

let toastTimer = null;
function toast(text, { onClick = null, duration = 2600 } = {}) {
  const t = $('#toast');
  t.textContent = text;
  t.onclick = onClick;
  t.style.cursor = onClick ? 'pointer' : '';
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

// --- API ВКонтакте -------------------------------------------------------------------------

// Ответы на «читающие» запросы кэшируем ненадолго: назад/вперёд и повторные открытия — мгновенно
const CACHEABLE = /^(catalog\.|audio\.(get|getPlaylists|getPlaylistById|getRecommendations|search)$|users\.get$)/;
const apiCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

async function vk(method, params = {}, { cache = CACHEABLE.test(method), anonymous = false } = {}) {
  const key = cache ? (anonymous ? 'anon:' : '') + method + JSON.stringify(params) : null;
  if (key) {
    const hit = apiCache.get(key);
    if (hit && Date.now() - hit.time < CACHE_TTL) return hit.promise;
  }
  const promise = bridge.api(method, params, { anonymous }).then((res) => {
    if (!res.ok) {
      const err = new Error(res.error || 'Ошибка ВКонтакте');
      err.code = res.code;
      throw err;
    }
    return res.data;
  });
  if (key) {
    apiCache.set(key, { time: Date.now(), promise });
    promise.catch(() => apiCache.delete(key));
    if (apiCache.size > 200) apiCache.delete(apiCache.keys().next().value);
  }
  return promise;
}

// --- Нормализация данных -------------------------------------------------------------------

function pickPhoto(obj, size) {
  if (!obj) return '';
  const sizes = [1200, 600, 300, 270, 135, 68, 34];
  const order = [...sizes.filter((s) => s >= size).reverse(), ...sizes.filter((s) => s < size)];
  for (const s of order) if (obj[`photo_${s}`]) return obj[`photo_${s}`];
  return '';
}

function normTrack(a) {
  const thumb = (a.album && a.album.thumb) || a.thumb || null;
  return {
    id: a.id,
    owner_id: a.owner_id,
    access_key: a.access_key || '',
    // лицензионный трек: так отмечен, принадлежит площадке или привязан к релизу/карточке артиста
    isLicensed: Boolean(a.is_licensed) || a.owner_id < 0 || Boolean(a.album && a.album.id) || Boolean((a.main_artists || []).length),
    album: (a.album && a.album.title) || '',
    key: `${a.owner_id}_${a.id}`,
    fullId: `${a.owner_id}_${a.id}${a.access_key ? '_' + a.access_key : ''}`,
    title: a.title || '',
    subtitle: a.subtitle || '',
    artist: a.artist || '',
    artists: (a.main_artists || []).filter((x) => x.id && x.name).map((x) => ({ id: x.id, name: x.name })),
    duration: a.duration || 0,
    url: a.url || '',
    explicit: Boolean(a.is_explicit),
    chart: a.audio_chart_info ? { position: a.audio_chart_info.position || 0, state: String(a.audio_chart_info.state || a.audio_chart_info.trend || '') } : null,
    thumb,
    cover: (size) => pickPhoto(thumb, size),
  };
}

// Тип релиза: ВК иногда прямо пишет его в данных, иначе определяем по числу треков
function releaseKind(p) {
  const raw = String((p.album && p.album.type) || p.album_type || '').toLowerCase();
  if (raw === 'single') return 'Сингл';
  if (raw === 'ep') return 'EP';
  if (raw === 'album') return 'Альбом';
  if (raw) return raw.toUpperCase();
  return '';
}

function normPlaylist(p) {
  const o = p.original || {};
  const photo = p.photo || (p.thumbs && p.thumbs[0]) || null;
  const artists = (p.main_artists || []).map((x) => x.name).join(', ');
  return {
    owner_id: o.owner_id ?? p.owner_id,
    id: o.playlist_id ?? p.id,
    access_key: o.access_key ?? p.access_key ?? '',
    title: p.title || 'Плейлист',
    sub: artists || (p.year ? `${p.year}` : '') || (p.count ? tracksWord(p.count) : ''),
    count: p.count || 0,
    isAlbum: p.type === 'album',
    kind: releaseKind(p),
    year: p.year || '',
    cover: (size) => pickPhoto(photo, size),
  };
}

// Раскладываем ответ catalog.getAudio / catalog.getSection в блоки
function artistPhoto(artist, minWidth = 300) {
  const photos = (artist && artist.photo) || [];
  const sorted = [...photos].sort((a, b) => a.width - b.width);
  const fit = sorted.find((p) => p.width >= minWidth) || sorted[sorted.length - 1];
  return fit ? fit.url : '';
}

function parseCatalog(resp, explicitSection = null) {
  const audios = new Map((resp.audios || []).map((a) => [`${a.owner_id}_${a.id}`, a]));
  const playlists = new Map((resp.playlists || []).map((p) => [`${p.owner_id}_${p.id}`, p]));
  const artists = new Map((resp.artists || []).map((a) => [String(a.id), a]));
  const catalog = resp.catalog;
  const section = explicitSection
    || resp.section
    || (catalog && (catalog.sections.find((s) => s.id === catalog.default_section) || catalog.sections[0]))
    || { blocks: [] };
  const blocks = [];
  let header = null;
  const idOf = (raw) => String(raw).split('_').slice(0, 2).join('_');
  for (const b of section.blocks || []) {
    const layout = (b.layout && b.layout.name) || '';
    if (layout.startsWith('header')) {
      header = { title: (b.layout && b.layout.title) || b.title, action: (b.actions || []).find((a) => a.section_id) };
      continue;
    }
    if (layout === 'separator') continue;
    if (b.data_type === 'music_audios') {
      const tracks = (b.audios_ids || []).map((id) => audios.get(idOf(id))).filter(Boolean).map(normTrack);
      if (tracks.length) blocks.push({ kind: 'tracks', title: header ? header.title : b.title, action: header && header.action, layout, tracks, nextFrom: b.next_from });
    } else if (b.data_type === 'music_playlists') {
      const items = (b.playlists_ids || []).map((id) => playlists.get(idOf(id))).filter(Boolean).map(normPlaylist);
      if (items.length) blocks.push({ kind: 'playlists', title: header ? header.title : b.title, action: header && header.action, items, nextFrom: b.next_from });
    } else if (b.data_type === 'music_artists' || b.data_type === 'artists') {
      const items = (b.artists_ids || []).map((id) => artists.get(String(id))).filter(Boolean)
        .map((a) => ({ id: a.id, name: a.name, photo: artistPhoto(a, 200) }));
      if (items.length) blocks.push({ kind: 'artists', title: header ? header.title : b.title, items });
    }
    header = null;
  }
  return { title: section.title || '', id: section.id, blocks, nextFrom: section.next_from };
}

// Раздел по адресу ВК. Для вошедшего пользователя ВК отвечает набором вкладок —
// берём вкладку с нужным адресом, а если её нет, открываем «Показать все» нужного блока.
const targetOf = (u) => {
  try {
    const x = new URL(u);
    return [x.pathname, x.searchParams.get('block') || '', x.searchParams.get('section') || ''].join('|');
  } catch {
    return '';
  }
};
// Ищем раздел в ответе catalog.getAudio: вкладка с этим адресом, блок с этим адресом
// или заголовок блока с подходящим названием — и открываем его «Показать все»
async function findSection(resp, url, titleRe, anonymous) {
  const want = targetOf(url);
  const sections = (resp.catalog && resp.catalog.sections) || [];
  const open = async (id) => parseCatalog(await vk('catalog.getSection', { section_id: id }, { anonymous }));
  const exact = sections.find((s) => targetOf(s.url) === want);
  if (exact) return exact.blocks && exact.blocks.length ? parseCatalog(resp, exact) : open(exact.id);
  for (const sec of sections) {
    for (const b of sec.blocks || []) {
      const showAll = b.meta && b.meta.show_all_info && b.meta.show_all_info.section_id;
      if (showAll && targetOf(b.url) === want) return open(showAll);
      for (const a of b.actions || []) {
        if (a.section_id && a.action && targetOf(a.action.url) === want) return open(a.section_id);
      }
    }
  }
  if (titleRe) {
    for (const sec of sections) {
      for (const b of sec.blocks || []) {
        const title = (b.layout && b.layout.title) || b.title || '';
        const action = (b.actions || []).find((a) => a.section_id);
        if (action && titleRe.test(title)) return open(action.section_id);
      }
    }
  }
  return null;
}

// Раздел по адресу ВК. Для вошедшего пользователя ВК отвечает набором вкладок,
// поэтому пробуем по очереди: сам адрес → вкладку «Обзор» → публичный каталог (как у гостя).
async function catalogByUrl(url, titleRe) {
  const attempts = [
    () => vk('catalog.getAudio', { url, need_blocks: 1 }).then((r) => findSection(r, url, titleRe, false)),
  ];
  if (auth.loggedIn) {
    attempts.push(() => vk('catalog.getAudio', { url: 'https://vk.ru/audio?section=explore', need_blocks: 1 }).then((r) => findSection(r, url, titleRe, false)));
    attempts.push(async () => {
      const resp = await vk('catalog.getAudio', { url, need_blocks: 1 }, { anonymous: true });
      const data = (await findSection(resp, url, titleRe, true)) || parseCatalog(resp);
      // у гостевого каталога ссылки — 30-секундные отрывки; полные ссылки плеер возьмёт по аккаунту
      data.blocks.forEach((b) => (b.tracks || []).forEach((t) => { t.url = ''; }));
      data.anonymous = true;
      return data;
    });
  } else {
    attempts.push(async () => parseCatalog(await vk('catalog.getAudio', { url, need_blocks: 1 })));
  }
  for (const attempt of attempts) {
    try {
      const data = await attempt();
      if (data && data.blocks.some((b) => b.kind === 'tracks' || b.kind === 'playlists')) return data;
    } catch {
      /* следующий способ */
    }
  }
  return null;
}

// --- Состояние входа ----------------------------------------------------------------------

const auth = { loggedIn: false, me: null };

async function refreshMe() {
  if (!auth.loggedIn) {
    auth.me = null;
  } else {
    try {
      const [me] = await vk('users.get', { fields: 'photo_100' });
      auth.me = me;
    } catch {
      auth.me = null;
    }
  }
  renderAccount();
}

function renderAccount() {
  $('#login-btn').hidden = auth.loggedIn;
  $('#user').hidden = !auth.loggedIn;
  if (auth.me) {
    $('#user-name').textContent = `${auth.me.first_name} ${auth.me.last_name}`;
    $('#user-avatar').src = auth.me.photo_100 || '';
  }
}

// --- Вход (официальная страница ВК в окне программы) ---------------------------------------

const loginModal = $('#login-modal');
const loginSlot = $('#login-slot');
function slotRect() {
  const r = loginSlot.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
function openLogin() {
  loginModal.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => bridge.login(slotRect())));
}
function closeLogin(cancel) {
  loginModal.hidden = true;
  if (cancel) bridge.loginCancel();
}
new ResizeObserver(() => { if (!loginModal.hidden) bridge.loginBounds(slotRect()); }).observe(loginSlot);
$('#login-close').addEventListener('click', () => closeLogin(true));
$('#login-btn').addEventListener('click', openLogin);
$('#logout-btn').addEventListener('click', () => {
  bridge.logout();
  toast('Вы вышли из аккаунта');
});
bridge.onLoginClosed(() => {
  closeLogin(false);
  toast('Готово, вы вошли ✦');
});
bridge.onAuthChanged(async ({ loggedIn }) => {
  const changed = loggedIn !== auth.loggedIn;
  auth.loggedIn = loggedIn;
  if (changed) { apiCache.clear(); suggestCache.clear(); router.dropCache(); }
  await refreshMe();
  library.load();
  if (changed) router.reload();
});

function loginPrompt(what) {
  return el('div', { class: 'state' },
    el('div', { class: 'state-title', text: what }),
    el('div', { text: 'Войдите во ВКонтакте — откроется официальная страница входа.' }),
    el('button', { class: 'btn primary', onclick: openLogin }, iconEl('login'), 'Войти'));
}

// --- Отрисовка: треки и карточки -----------------------------------------------------------

// Номер строки; в чарте — место и движение (корона, вверх, вниз, без изменений)
function rowNumber(track, index) {
  const chart = track.chart && track.chart.position ? track.chart : null;
  if (!chart) return el('div', { class: 'row-num', text: String(index + 1) });
  const st = chart.state.toLowerCase();
  const trend = /crown|leader|top/.test(st) || (!st && chart.position === 1) ? 'crown'
    : /up|rais|rise|grow/.test(st) ? 'up'
      : /down|fall|drop/.test(st) ? 'down'
        : /new/.test(st) ? 'new'
          : st ? 'same' : '';
  return el('div', { class: 'row-num chart' },
    el('span', { text: String(chart.position) }),
    trend ? el('i', { class: 'trend ' + trend, title: { crown: 'Лидер чарта', up: 'Поднялся', down: 'Опустился', new: 'Новинка в чарте', same: 'Без изменений' }[trend] }) : null);
}

function trackRow(track, list, index, { number = false, onPlay = null } = {}) {
  const row = el('div', {
    class: 'row' + (player.current && player.current.key === track.key ? ' playing' : ''),
    dataset: { key: track.key },
    title: `${track.artist} — ${track.title}`,
    onclick: () => { player.playList(list, index); if (onPlay && player.queue === list) onPlay(list); },
  },
  number ? rowNumber(track, index) : null,
  el('div', { class: 'row-cover' },
    el('img', { src: track.cover(135) || null, alt: '', loading: 'lazy', decoding: 'async', width: '46', height: '46' }),
    el('div', { class: 'row-overlay', html: `${ICON.play.replace('<svg', '<svg class="icon-play"')}<span class="eq"><i></i><i></i><i></i></span>` })),
  el('div', { class: 'row-text' },
    el('div', { class: 'row-title' }, track.title + (track.subtitle ? ` (${track.subtitle})` : ''), track.explicit ? el('span', { class: 'explicit', text: 'E' }) : null),
    artistLine(track, 'row-artist')),
  el('div', { class: 'row-dur', text: fmt(track.duration) }),
  el('button', {
    class: 'row-more', title: 'Ещё', html: ICON.more,
    onclick: (e) => { e.stopPropagation(); openTrackMenu(track, e.currentTarget); },
  }));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openTrackMenu(track, { x: e.clientX, y: e.clientY }); });
  return row;
}

function normArtist(a) {
  return { id: a.id, name: a.name, photo: artistPhoto(a, 200) };
}

async function searchArtists(q, count = 5) {
  try {
    const resp = await vk('audio.searchArtists', { q, count });
    return (resp.items || resp || []).filter((a) => a && a.id && a.name).map(normArtist);
  } catch {
    return [];
  }
}

function openArtist(a) {
  if (sheet.open) sheet.hide();
  closeSuggest();
  router.go('artist', { id: a.id, name: a.name });
}

// У трека нет ID артиста — находим артиста по имени
async function openArtistByName(name) {
  const clean = name.split(/,|&| feat\.| ft\.| x /i)[0].trim();
  const found = await searchArtists(clean, 3);
  const exact = found.find((a) => a.name.toLowerCase() === clean.toLowerCase()) || found[0];
  if (exact) openArtist(exact);
  else {
    if (sheet.open) sheet.hide();
    searchInput.value = clean;
    runSearch(clean);
  }
}

// Имена артистов — ссылки на их страницы (в списках, в плеере и в полноэкранном режиме)
function artistLine(track, cls, node = null) {
  const line = node || el('div', { class: cls });
  line.replaceChildren();
  if (!track) return line;
  if (!track.artists.length) {
    line.append(el('span', {
      class: 'artist-link', text: track.artist,
      onclick: (e) => { e.stopPropagation(); openArtistByName(track.artist); },
    }));
    return line;
  }
  track.artists.forEach((a, i) => {
    if (i) line.append(', ');
    line.append(el('span', {
      class: 'artist-link', text: a.name,
      onclick: (e) => { e.stopPropagation(); openArtist(a); },
    }));
  });
  return line;
}

function artistChip(a) {
  return el('button', { class: 'artist-chip', onclick: () => openArtist(a) },
    el('div', { class: 'artist-chip-photo' }, a.photo ? el('img', { src: a.photo, alt: '', loading: 'lazy' }) : el('span', { html: ICON.user })),
    el('div', { class: 'artist-chip-name', text: a.name }));
}

// Сетка показывает первые 12 треков, но играет весь блок; onPlay догружает остальное
function trackGrid(tracks, { limit = 12, onPlay = null } = {}) {
  return el('div', { class: 'track-grid' }, tracks.slice(0, limit).map((t, i) => trackRow(t, tracks, i, { onPlay })));
}

// Дописать треки в играющую очередь (без повторов); mixed — вразброс после текущего
function appendToQueue(queue, more, mixed = false) {
  if (player.queue !== queue) return;
  const have = new Set(queue.map((t) => t.key));
  for (const t of more) {
    if (have.has(t.key)) continue;
    have.add(t.key);
    queue.push(t);
    const idx = queue.length - 1;
    if (mixed) player.order.splice(player.pos + 1 + Math.floor(Math.random() * (player.order.length - player.pos)), 0, idx);
    else player.order.push(idx);
  }
  renderQueue();
}

// Что догружать, когда трек запущен из блока на главной: «Мои треки» — вся медиатека,
// другие блоки с «Все» — весь раздел
function blockExtender(block) {
  if (/^мои треки$/i.test(block.title || '') && auth.loggedIn) {
    return (queue) => loadAllMy().then((all) => appendToQueue(queue, all, player.shuffle)).catch(() => {});
  }
  if (block.action && block.action.section_id) {
    return (queue) => loadSection({ id: block.action.section_id, url: block.action.action && block.action.action.url })
      .then((data) => appendToQueue(queue, data.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks), player.shuffle))
      .catch(() => {});
  }
  return null;
}
function trackList(tracks, { number = true } = {}) {
  return el('div', { class: 'track-list' }, tracks.map((t, i) => trackRow(t, tracks, i, { number })));
}

function playlistCard(p) {
  return el('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => router.go('playlist', p) },
    el('div', { class: 'card-cover' },
      el('img', { src: p.cover(300) || null, alt: '', loading: 'lazy', decoding: 'async' }),
      el('button', {
        class: 'card-play', title: 'Слушать', html: ICON.play,
        onclick: (e) => { e.stopPropagation(); playPlaylist(p); },
      })),
    el('div', { class: 'card-title', text: p.title }),
    el('div', { class: 'card-sub', text: p.sub }),
    p.kind ? el('div', { class: 'card-meta' }, el('span', { class: 'card-kind', text: p.kind }), p.year ? ` · ${p.year}` : '') : null);
}

function sectionHead(title, action) {
  return el('div', { class: 'section-head' },
    el('h2', { class: 'section-title', text: title || '' }),
    auth.loggedIn && /^мои треки$/i.test(title || '') ? el('button', { class: 'more shuffle-all', title: 'Перемешать все мои треки', onclick: () => playAllMy(true) }, iconEl('shuffle'), 'Перемешать всё') : null,
    action ? el('button', { class: 'more', text: 'Все', onclick: () => router.go('section', { id: action.section_id, title, url: action.action && action.action.url }) }) : null);
}

function pageHead(eyebrow, title, sub, actions = []) {
  return el('div', { class: 'page-head' },
    el('div', {},
      el('div', { class: 'eyebrow', text: eyebrow }),
      el('h1', { class: 'page-title', text: title }),
      sub ? el('div', { class: 'page-sub', text: sub }) : null),
    actions.length ? el('div', { class: 'page-actions' }, actions) : null);
}

function playButtons(getTracks) {
  return [
    el('button', { class: 'btn primary', onclick: async () => player.playList(await getTracks(), 0, { shuffle: false }) }, iconEl('play'), 'Слушать'),
    el('button', { class: 'btn ghost', onclick: async () => player.playList(await getTracks(), 0, { shuffle: true }) }, iconEl('shuffle'), 'Перемешать'),
  ];
}

function renderBlocks(blocks, { limit = 99 } = {}) {
  const frag = document.createDocumentFragment();
  for (const block of blocks.slice(0, limit)) {
    if (block.kind === 'tracks') {
      const list = block.layout === 'list' || block.layout === 'music_chart_list'
        ? trackList(block.tracks)
        : trackGrid(block.tracks, { onPlay: blockExtender(block) });
      frag.append(el('section', { class: 'section' }, sectionHead(block.title, block.action), list));
    } else if (block.kind === 'playlists') {
      frag.append(el('section', { class: 'section' }, sectionHead(block.title, block.action),
        el('div', { class: 'card-row' }, block.items.map(playlistCard))));
    } else if (block.kind === 'artists') {
      frag.append(el('section', { class: 'section' }, sectionHead(block.title || 'Артисты'),
        el('div', { class: 'artist-row' }, block.items.map(artistChip))));
    }
  }
  return frag;
}

function loadingView() {
  return el('div', {}, el('div', { class: 'skeleton', style: 'width:40%;height:48px;margin:10px 0 28px' }),
    Array.from({ length: 8 }, () => el('div', { class: 'skeleton' })));
}

function errorView(err, retry) {
  return el('div', { class: 'state' },
    el('div', { class: 'state-title', text: 'Не получилось загрузить' }),
    el('div', { text: err && err.message ? err.message : 'Проверьте интернет' }),
    retry ? el('button', { class: 'btn ghost', text: 'Повторить', onclick: retry }) : null);
}

// --- Подгрузка при прокрутке ---------------------------------------------------------------

let loadMore = null;
const content = $('#content');
content.addEventListener('scroll', () => {
  if (loadMore && content.scrollTop + content.clientHeight > content.scrollHeight - 600) {
    const fn = loadMore;
    loadMore = null;
    fn();
  }
});

function pagedTrackList(tracks, sectionId, nextFrom, { anonymous = false } = {}) {
  const list = trackList(tracks);
  const more = async (from) => {
    if (!from || !sectionId) return;
    try {
      const resp = await vk('catalog.getSection', { section_id: sectionId, start_from: from }, { anonymous });
      const parsed = parseCatalog(resp);
      const extra = parsed.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks);
      const seen = new Set(tracks.map((t) => t.key));
      const fresh = extra.filter((t) => !seen.has(t.key));
      if (anonymous) fresh.forEach((t) => { t.url = ''; });
      if (!fresh.length) return;
      const start = tracks.length;
      tracks.push(...fresh);
      fresh.forEach((t, i) => list.append(trackRow(t, tracks, start + i, { number: true })));
      const next = parsed.nextFrom || (parsed.blocks.find((b) => b.kind === 'tracks') || {}).nextFrom;
      if (next && next !== from) loadMore = () => more(next);
    } catch {
      /* конец списка или ошибка — просто перестаём подгружать */
    }
  };
  if (nextFrom) loadMore = () => more(nextFrom);
  return list;
}

// --- Экраны --------------------------------------------------------------------------------

function mixCard() {
  const card = el('div', { class: 'mix' + (player.mix ? ' on' : ''), id: 'mix-card' },
    el('div', { class: 'mix-text' },
      el('div', { class: 'mix-title', text: 'VK Микс' }),
      el('div', { class: 'mix-sub', id: 'mix-sub', text: auth.loggedIn ? mixSettings.summary() : 'Войдите, чтобы слушать микс под ваш вкус' }),
      auth.loggedIn ? el('button', { class: 'mix-tune', onclick: () => mixSettings.open() }, el('span', { class: 'ico', html: ICON.tune }), 'Настроить') : null),
    el('button', {
      class: 'mix-play', title: 'Слушать VK Микс',
      html: `${ICON.play.replace('<svg', '<svg class="icon-play"')}<svg viewBox="0 0 24 24" class="icon-pause"><rect class="fill" x="6" y="5" width="4" height="14" rx="1.2"/><rect class="fill" x="14" y="5" width="4" height="14" rx="1.2"/></svg>`,
      onclick: () => {
        if (!auth.loggedIn) { openLogin(); return; }
        if (player.mix) player.toggle(); else player.startMix();
      },
    }));
  return card;
}

let mixLogged = false;
async function viewHome() {
  const resp = await vk('catalog.getAudio', { url: 'https://vk.ru/audio', need_blocks: 1 });
  const data = parseCatalog(resp);
  // для отчёта: как ВК описывает интерактивный VK Микс (настроение, язык и т.п.)
  if (auth.loggedIn && !mixLogged) {
    mixLogged = true;
    try {
      const sec = ((resp.catalog && resp.catalog.sections) || [])[0] || {};
      const mixBlock = (sec.blocks || []).find((b) => /stream_mix/.test(`${b.data_type} ${(b.layout && b.layout.name) || ''}`));
      const extra = Object.fromEntries(Object.entries(resp).filter(([k]) => /mix|stream|filter|setting/i.test(k)));
      diag.add('mix', `блок микса на Главной: ${JSON.stringify({ block: mixBlock, data: extra }).slice(0, 12000)}`);
    } catch (err) { diag.add('mix', `блок микса: ${err.message}`); }
    mixSettings.loadFromVk();
  }
  return [
    pageHead('Обзор', auth.me ? `Привет, ${auth.me.first_name}` : 'Музыка для вас', null),
    mixCard(),
    renderBlocks(data.blocks, { limit: 8 }),
  ];
}

async function viewSimilar(track) {
  if (!auth.loggedIn) return loginPrompt('Похожие треки');
  const resp = await vk('audio.getRecommendations', { target_audio: track.key, count: 100 });
  const tracks = (resp.items || resp || []).map(normTrack);
  if (!tracks.length) return [pageHead('Похожие', track.title), el('div', { class: 'state' }, el('div', { class: 'state-title', text: 'ВКонтакте не нашёл похожих' }))];
  return [pageHead(`Похожие на «${track.title}»`, track.artist, tracksWord(tracks.length), playButtons(() => tracks)), trackList(tracks)];
}

async function viewArtist({ id, name }) {
  const resp = await vk('catalog.getAudioArtist', { artist_id: id, need_blocks: 1 });
  const data = parseCatalog(resp);
  const artist = (resp.artists || []).find((a) => String(a.id) === String(id)) || (resp.artists || [])[0] || { name };
  const photo = artistPhoto(artist, 800);
  const top = data.blocks.find((b) => b.kind === 'tracks');
  const topTracks = top ? top.tracks : [];
  if (top) top.layout = 'list';
  return [
    el('div', { class: 'artist-hero' + (photo ? '' : ' no-photo') },
      photo ? el('img', { class: 'artist-hero-bg', src: photo, alt: '' }) : null,
      el('div', { class: 'artist-hero-text' },
        el('div', { class: 'eyebrow', text: 'Артист' }),
        el('h1', { class: 'page-title', text: artist.name || name }),
        topTracks.length ? el('div', { class: 'page-actions' }, playButtons(() => topTracks)) : null)),
    renderBlocks(data.blocks.map((b) => (b === top ? { ...b, tracks: b.tracks.slice(0, 10) } : b))),
  ];
}

// Чарт и новинки одинаковы для всех — берём их из публичного каталога ВК (как у гостя),
// а полные версии треков плеер получает по аккаунту
async function viewPublicList(url, eyebrow, title) {
  const anonymous = auth.loggedIn;
  const data = parseCatalog(await vk('catalog.getAudio', { url, need_blocks: 1 }, { anonymous }));
  const block = data.blocks.find((b) => b.kind === 'tracks');
  if (!block) throw new Error('ВКонтакте не отдал этот раздел');
  const tracks = block.tracks;
  if (anonymous) tracks.forEach((t) => { t.url = ''; }); // в гостевом каталоге — только отрывки
  return [
    pageHead(eyebrow, title, tracksWord(tracks.length) + (block.nextFrom ? '+' : ''), playButtons(() => tracks)),
    pagedTrackList(tracks, data.id, block.nextFrom || data.nextFrom, { anonymous }),
  ];
}

// Чарт VK Музыки. Гостевой каталог ВК отдаёт устаревший чарт, поэтому ищем блок чарта
// в каталоге аккаунта: блок с раскладкой music_chart_* и его «Показать все».
async function chartFromAccount() {
  // мобильный «Обзор»: «Собрано редакцией» → «Чарт VK Музыки» — он во второй части раздела
  try {
    const found = await accountExploreBlock('chart', /^чарт\s+vk/i);
    if (found && found.blocks.some((b) => b.kind === 'tracks')) return found;
  } catch (err) { diag.add('chart', `обзор: ${err.message}`); }
  const isChart = (b) => b.data_type === 'music_audios'
    && (/chart/.test((b.layout && b.layout.name) || '') || /chart/.test(b.url || '') || /чарт/i.test(b.title || (b.layout && b.layout.title) || ''));
  const describe = (resp) => ((resp.catalog && resp.catalog.sections) || (resp.section ? [resp.section] : [])).map((sec) => ({
    title: sec.title, url: sec.url,
    blocks: (sec.blocks || []).map((b) => `${b.data_type}/${(b.layout && b.layout.name) || ''}/${(b.layout && b.layout.title) || b.title || ''} ${b.url || ''}`).slice(0, 40),
  }));
  const firstTracks = (data) => (data.blocks.find((x) => x.kind === 'tracks') || { tracks: [] }).tracks.slice(0, 5).map((t) => `${t.artist} — ${t.title}`);
  const scan = async (resp, depth, where) => {
    diag.add('chart', `ответ ${where}`, describe(resp));
    const sections = (resp.catalog && resp.catalog.sections) || (resp.section ? [resp.section] : []);
    for (const sec of sections) {
      // вкладка, которая сама и есть чарт
      if (/block=chart/.test(sec.url || '') && (sec.blocks || []).some((b) => b.data_type === 'music_audios')) return parseCatalog(resp, sec);
      const block = (sec.blocks || []).find(isChart);
      if (!block) continue;
      const showAll = block.meta && block.meta.show_all_info && block.meta.show_all_info.section_id;
      const action = (block.actions || []).find((x) => x.section_id);
      const target = showAll || (action && action.section_id);
      if (/list/.test((block.layout && block.layout.name) || '') || !target) return parseCatalog(resp, sec);
      return parseCatalog(await vk('catalog.getSection', { section_id: target }));
    }
    // вкладки без содержимого (Главная, Обзор…) открываем по одной
    if (depth > 0) {
      for (const sec of sections.filter((x) => !(x.blocks || []).length).slice(0, 5)) {
        try {
          const found = await scan(await vk('catalog.getSection', { section_id: sec.id }), depth - 1, `вкладка «${sec.title}»`);
          if (found) return found;
        } catch (err) { diag.add('chart', `вкладка «${sec.title}»: ${err.message}`); }
      }
    }
    return null;
  };
  const accept = (found, where) => {
    if (found && found.blocks.some((b) => b.kind === 'tracks')) {
      diag.add('chart', `взят чарт: ${where}`, firstTracks(found));
      return found;
    }
    return null;
  };
  for (const url of ['https://vk.ru/audio?block=chart', 'https://vk.ru/music/chart', 'https://vk.ru/audio?section=explore']) {
    try {
      const found = accept(await scan(await vk('catalog.getAudio', { url, need_blocks: 1 }), 0, url), url);
      if (found) return found;
    } catch (err) { diag.add('chart', `${url}: ${err.message}`); }
  }
  // чарт как плейлист официальных сообществ VK Музыки (фанатские копии из поиска не берём)
  const fromPlaylist = async (p, where) => {
    const resp = await vk('audio.get', { owner_id: p.owner_id, album_id: p.id, access_key: p.access_key || '', count: 200 });
    const tracks = (resp.items || []).map(normTrack);
    diag.add('chart', `плейлист ${where}: «${p.title}», ${tracks.length} треков`, tracks.slice(0, 5).map((t) => `${t.artist} — ${t.title}`));
    return tracks.length ? { id: null, blocks: [{ kind: 'tracks', title: p.title, tracks }] } : null;
  };
  for (const owner of [-147845620, -137360741]) {
    try {
      const all = [];
      for (let offset = 0; offset < 600; offset += 100) {
        const resp = await vk('audio.getPlaylists', { owner_id: owner, count: 100, offset });
        all.push(...(resp.items || []));
        if (!(resp.items || []).length || all.length >= (resp.count || 0)) break;
      }
      const charts = all.filter((p) => /чарт|chart/i.test(p.title || ''));
      diag.add('chart', `плейлисты ${owner}: всего ${all.length}, с «чарт»: ${charts.length}`, charts.map((p) => `${p.title} (${p.count})`));
      const p = charts.sort((x, y) => (y.update_time || 0) - (x.update_time || 0))[0];
      if (p) { const found = await fromPlaylist(p, `сообщества ${owner}`); if (found) return found; }
    } catch (err) { diag.add('chart', `плейлисты ${owner}: ${err.message}`); }
  }
  // «Сегодня в плеере» из Обзора аккаунта — то, что сейчас больше всего слушают
  try {
    const today = await accountExploreBlock('player_today');
    if (today && today.blocks.some((b) => b.kind === 'tracks')) {
      diag.add('chart', 'взят блок «Сегодня в плеере»', firstTracks(today));
      return { ...today, popular: true };
    }
  } catch (err) { diag.add('chart', `сегодня в плеере: ${err.message}`); }
  // популярное во ВКонтакте — то, что сейчас слушают больше всего
  try {
    const resp = await vk('audio.getPopular', { count: 100, only_eng: 0 });
    const tracks = (Array.isArray(resp) ? resp : resp.items || []).map(normTrack);
    diag.add('chart', `audio.getPopular: ${tracks.length}`, tracks.slice(0, 10).map((t) => `${t.artist} — ${t.title}`));
    if (tracks.length) return { id: null, popular: true, blocks: [{ kind: 'tracks', title: 'Популярное', tracks }] };
  } catch (err) { diag.add('chart', `audio.getPopular: ${err.message}`); }

  // раздел чарта из публичного каталога, но открытый от имени аккаунта
  try {
    const guest = await vk('catalog.getAudio', { url: 'https://vk.ru/audio?block=chart', need_blocks: 1 }, { anonymous: true });
    const sec = ((guest.catalog && guest.catalog.sections) || [])[0];
    if (sec) {
      const found = accept(parseCatalog(await vk('catalog.getSection', { section_id: sec.id })), 'раздел публичного чарта от аккаунта');
      if (found) return found;
    }
  } catch (err) { diag.add('chart', `раздел публичного чарта: ${err.message}`); }
  return null;
}

// Блок раздела «Обзор» аккаунта (block=new_songs, чарт и т.п.), открытый целиком.
// ВК отдаёт «Обзор» частями (как при прокрутке) — листаем, пока не найдём.
async function accountExploreBlock(name, headerRe = null) {
  const first = await vk('catalog.getAudio', { url: 'https://vk.ru/audio?section=explore', need_blocks: 1 });
  const sections = (first.catalog && first.catalog.sections) || [];
  const sec = sections.find((x) => /обзор/i.test(x.title || '') || /section=explore/.test(x.url || '')) || sections[0];
  if (!sec) return null;
  let page = { resp: first, section: sec };
  if (!(sec.blocks || []).length) {
    const r = await vk('catalog.getSection', { section_id: sec.id });
    page = { resp: r, section: r.section || { blocks: [] } };
  }
  const titles = [];
  for (let n = 0; n < 10 && page; n++) {
    const blocks = page.section.blocks || [];
    let header = null;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const layout = (b.layout && b.layout.name) || '';
      if (layout.startsWith('header')) { header = b; titles.push((b.layout && b.layout.title) || b.title || ''); continue; }
      if (layout === 'separator') continue;
      const headerTitle = header ? (header.layout && header.layout.title) || header.title || '' : '';
      const byUrl = new RegExp(`[?&]block=${name}(&|$)`).test(b.url || '');
      const byTitle = headerRe && headerRe.test(headerTitle) && b.data_type === 'music_audios';
      if (byUrl || byTitle) {
        let id = b.meta && b.meta.show_all_info && b.meta.show_all_info.section_id;
        const action = header && (header.actions || []).find((x) => x.section_id);
        if (!id && action) id = action.section_id;
        diag.add('catalog', `«${headerTitle || name}» найден в «Обзоре» (часть ${n + 1}): ${id ? 'раздел целиком' : 'только блок'}`);
        if (id) return parseCatalog(await vk('catalog.getSection', { section_id: id }));
        return parseCatalog(page.resp, { ...page.section, blocks: [header, b].filter(Boolean) });
      }
      header = null;
    }
    const next = page.section.next_from;
    if (!next) break;
    const r = await vk('catalog.getSection', { section_id: page.section.id || sec.id, start_from: next });
    page = { resp: r, section: r.section || { blocks: [] } };
  }
  diag.add('catalog', `«${name}» в «Обзоре» не найден; заголовки: ${titles.join(' | ')}`);
  return null;
}

async function viewNew() {
  let data = null;
  if (auth.loggedIn) {
    try { data = await accountExploreBlock('new_songs'); } catch (err) { diag.add('catalog', `новинки: ${err.message}`); }
  }
  const block = data && data.blocks.find((b) => b.kind === 'tracks');
  if (!block) return viewPublicList('https://vk.ru/audio?block=new_songs', 'Открыть новое', 'Новинки');
  const tracks = block.tracks;
  return [
    pageHead('Открыть новое', 'Новинки', tracksWord(tracks.length) + (block.nextFrom ? '+' : ''), playButtons(() => tracks)),
    pagedTrackList(tracks, data.id, block.nextFrom || data.nextFrom),
  ];
}

async function viewChart() {
  const data = auth.loggedIn ? await chartFromAccount() : null;
  if (!data) {
    diag.add('chart', 'в аккаунте чарт не найден — показан публичный');
    return viewPublicList('https://vk.ru/audio?block=chart', 'Открыть новое', 'Чарт VK Музыки');
  }
  const block = data.blocks.find((b) => b.kind === 'tracks');
  const tracks = block.tracks;
  if (!data.popular) tracks.forEach((t, i) => { if (!t.chart) t.chart = { position: i + 1, state: '' }; });
  return [
    pageHead(data.popular ? 'Популярное во ВКонтакте' : 'Открыть новое', data.popular ? 'Сегодня в плеере' : 'Чарт VK Музыки', tracksWord(tracks.length) + (block.nextFrom ? '+' : ''), playButtons(() => tracks)),
    pagedTrackList(tracks, data.id, block.nextFrom || data.nextFrom),
  ];
}

async function viewCatalogList(url, eyebrow, title, titleRe) {
  const data = await catalogByUrl(url, titleRe);
  if (!data) throw new Error('ВКонтакте не отдал этот раздел');
  const block = data.blocks.find((b) => b.kind === 'tracks');
  if (!block) return [pageHead(eyebrow, title), renderBlocks(data.blocks)];
  const tracks = block.tracks;
  return [
    pageHead(eyebrow, title, tracksWord(tracks.length) + (block.nextFrom ? '+' : ''), playButtons(() => tracks)),
    data.anonymous ? trackList(tracks) : pagedTrackList(tracks, data.id, block.nextFrom || data.nextFrom),
  ];
}

// Раздел «Показать все». Некоторые разделы (например, все релизы артиста) ВК не отдаёт
// по ID — тогда открываем их по адресу страницы, как делает сам сайт.
async function loadSection({ id, url }) {
  try {
    return parseCatalog(await vk('catalog.getSection', { section_id: id }));
  } catch (err) {
    if (!url) throw err;
    const artist = /\/artist\/([^/?#]+)/.exec(url);
    const resp = artist
      ? await vk('catalog.getAudioArtist', { artist_id: artist[1], url, need_blocks: 1 })
      : await vk('catalog.getAudio', { url, need_blocks: 1 });
    const sections = (resp.catalog && resp.catalog.sections) || [];
    return parseCatalog(resp, sections.find((s) => targetOf(s.url) === targetOf(url)) || null);
  }
}

async function viewSection({ id, title, url }) {
  const data = await loadSection({ id, url });
  const name = title || data.title;
  const trackBlocks = data.blocks.filter((b) => b.kind === 'tracks');
  if (data.blocks.length === 1 && trackBlocks.length === 1) {
    const tracks = trackBlocks[0].tracks;
    return [pageHead('Подборка', name, null, playButtons(() => tracks)), pagedTrackList(tracks, data.id, trackBlocks[0].nextFrom || data.nextFrom)];
  }
  const playlistsOnly = data.blocks.every((b) => b.kind === 'playlists');
  if (playlistsOnly) {
    return [pageHead('Подборка', name), el('div', { class: 'card-grid' }, data.blocks.flatMap((b) => b.items).map(playlistCard))];
  }
  return [pageHead('Подборка', name), renderBlocks(data.blocks)];
}

const MY_PAGE = 200;
// Все «Мои аудио» целиком — для «Слушать» и «Перемешать» (ВК отдаёт по 200, при частых
// запросах отвечает ошибкой — тогда ждём и повторяем, а не останавливаемся на первой сотне)
let myAllCache = null;
async function loadAllMy(onProgress = () => {}) {
  const uid = auth.me && auth.me.id;
  if (myAllCache && myAllCache.uid === uid && Date.now() - myAllCache.at < 5 * 60e3) return myAllCache.tracks;
  const tracks = [];
  const seen = new Set();
  let total = Infinity;
  for (let offset = 0, guard = 0; offset < total && guard < 100; guard++) {
    let resp = null;
    for (let attempt = 0; attempt < 4 && !resp; attempt++) {
      try {
        resp = await vk('audio.get', { owner_id: uid, count: MY_PAGE, offset }, { cache: false });
      } catch (err) {
        diag.add('my', `audio.get offset ${offset}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (!resp) break;
    total = resp.count || 0;
    const page = (resp.items || []).map(normTrack);
    if (!page.length) break;
    page.forEach((t) => { if (!seen.has(t.key)) { seen.add(t.key); tracks.push(t); } });
    offset += page.length;
    onProgress(tracks.length, total);
    await new Promise((r) => setTimeout(r, 250));
  }
  diag.add('my', `загружено ${tracks.length} из ${total}`);
  myAllCache = { uid, at: Date.now(), tracks };
  return tracks;
}

// «Перемешать всё» как в ВК: играть сразу, без загрузки всей медиатеки.
// Если ВК умеет отдавать перемешанный список сам (audio.get с shuffle) — берём его,
// иначе начинаем со случайной сотни, а остальное подмешиваем в очередь фоном.
async function playAllMy(shuffle) {
  if (!auth.loggedIn) { openLogin(); return; }
  const uid = auth.me && auth.me.id;
  if (!shuffle) {
    const first = await vk('audio.get', { owner_id: uid, count: MY_PAGE, offset: 0 });
    const tracks = (first.items || []).map(normTrack);
    if (!tracks.length) return;
    player.playList(tracks, 0, { shuffle: false });
    appendRestMy(tracks, false);
    return;
  }
  let start = [];
  try {
    const [plain, mixed] = await Promise.all([
      vk('audio.get', { owner_id: uid, count: 30, offset: 0 }),
      vk('audio.get', { owner_id: uid, count: MY_PAGE, offset: 0, shuffle: 1 }, { cache: false }),
    ]);
    const a = (plain.items || []).slice(0, 15).map((x) => x.id).join();
    const b = (mixed.items || []).slice(0, 15).map((x) => x.id).join();
    if (a !== b && (mixed.items || []).length) {
      start = mixed.items.map(normTrack);
      diag.add('my', 'перемешивание: ВК отдаёт перемешанный список сам');
    } else {
      const total = plain.count || 0;
      const offset = Math.max(0, Math.floor(Math.random() * Math.max(1, total - MY_PAGE)));
      const page = await vk('audio.get', { owner_id: uid, count: MY_PAGE, offset });
      start = (page.items || []).map(normTrack);
      diag.add('my', `перемешивание: начинаем со случайной сотни (с ${offset} из ${total})`);
    }
  } catch (err) {
    toast('Не удалось загрузить треки');
    return;
  }
  if (!start.length) return;
  for (let i = start.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [start[i], start[j]] = [start[j], start[i]]; }
  player.playList(start, 0, { shuffle: false });
  player.setShuffle(true);
  appendRestMy(start, true);
}

// остальные треки медиатеки догружаются в фоне и добавляются в очередь (вразброс, если перемешано)
async function appendRestMy(queue, mixed) {
  const all = await loadAllMy().catch(() => []);
  appendToQueue(queue, all, mixed);
}

async function viewMy() {
  if (!auth.loggedIn) return loginPrompt('Моя музыка');
  const uid = auth.me && auth.me.id;
  const first = await vk('audio.get', { owner_id: uid, count: MY_PAGE, offset: 0 });
  const total = first.count || 0;
  const tracks = (first.items || []).map(normTrack);
  if (!tracks.length) return [pageHead('Медиатека', 'Моя музыка'), el('div', { class: 'state' }, el('div', { class: 'state-title', text: 'Здесь пока пусто' }), 'Добавляйте треки — они появятся тут.')];
  const list = trackList(tracks);
  // остальное подгружается по мере прокрутки
  let offset = (first.items || []).length;
  const more = async () => {
    if (offset >= total) return;
    try {
      const resp = await vk('audio.get', { owner_id: uid, count: MY_PAGE, offset });
      const page = (resp.items || []).map(normTrack);
      if (!page.length) return;
      offset += page.length;
      const start = tracks.length;
      tracks.push(...page);
      page.forEach((t, i) => list.append(trackRow(t, tracks, start + i, { number: true })));
      if (offset < total) loadMore = more;
    } catch {
      loadMore = more; // попробуем ещё раз при следующей прокрутке
    }
  };
  if (offset < total) loadMore = more;
  // «Слушать» и «Перемешать» — по всему списку, а не только по загруженной части
  return [pageHead('Медиатека', 'Моя музыка', tracksWord(total), [
    el('button', { class: 'btn primary', onclick: () => playAllMy(false) }, iconEl('play'), 'Слушать'),
    el('button', { class: 'btn ghost', onclick: () => playAllMy(true) }, iconEl('shuffle'), 'Перемешать всё'),
  ]), list];
}

async function viewRecs() {
  if (!auth.loggedIn) return loginPrompt('Для вас');
  try {
    const resp = await vk('audio.getRecommendations', { count: 100 });
    const tracks = (resp.items || resp || []).map(normTrack);
    if (tracks.length) return [pageHead('Подобрано алгоритмами', 'Для вас', tracksWord(tracks.length), playButtons(() => tracks)), trackList(tracks)];
  } catch {
    /* попробуем раздел рекомендаций */
  }
  const data = await catalogByUrl('https://vk.ru/audio?section=recoms', /для вас|рекоменд/i);
  if (!data || !data.blocks.length) throw new Error('ВКонтакте пока не подобрал рекомендации');
  const all = data.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks);
  return [pageHead('Подобрано алгоритмами', 'Для вас', null, all.length ? playButtons(() => all) : []), renderBlocks(data.blocks)];
}

async function viewPlaylists() {
  if (!auth.loggedIn) return loginPrompt('Плейлисты');
  const resp = await vk('audio.getPlaylists', { owner_id: auth.me && auth.me.id, count: 200 });
  const items = (resp.items || []).map(normPlaylist);
  if (!items.length) return [pageHead('Медиатека', 'Плейлисты'), el('div', { class: 'state' }, el('div', { class: 'state-title', text: 'Плейлистов пока нет' }))];
  return [pageHead('Медиатека', 'Плейлисты', `${items.length} ${plural(items.length, 'плейлист', 'плейлиста', 'плейлистов')}`), el('div', { class: 'card-grid' }, items.map(playlistCard))];
}

async function playlistTracks(p) {
  const params = { owner_id: p.owner_id, playlist_id: p.id, album_id: p.id, count: 1000 };
  if (p.access_key) params.access_key = p.access_key;
  const resp = await vk('audio.get', params);
  return (resp.items || []).map(normTrack);
}

async function playPlaylist(p) {
  try {
    const tracks = await playlistTracks(p);
    if (tracks.length) player.playList(tracks, 0);
  } catch (err) {
    if (!auth.loggedIn) openLogin();
    else toast('Не удалось открыть плейлист');
  }
}

async function viewPlaylist(p) {
  let tracks;
  try {
    tracks = await playlistTracks(p);
  } catch (err) {
    if (!auth.loggedIn) return loginPrompt(p.title);
    throw err;
  }
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  const minutes = Math.round(total / 60);
  return [
    el('div', { class: 'hero' },
      el('div', { class: 'hero-cover' }, el('img', { src: p.cover(600) || (tracks[0] && tracks[0].cover(600)) || null, alt: '' })),
      el('div', { class: 'hero-text' },
        el('div', { class: 'eyebrow', text: p.isAlbum ? 'Альбом' : 'Плейлист' }),
        el('h1', { class: 'page-title', text: p.title }),
        el('div', { class: 'page-sub', text: [p.sub, tracksWord(tracks.length), minutes ? `${minutes} мин` : ''].filter(Boolean).join(' · ') }),
        el('div', { class: 'page-actions' }, playButtons(() => tracks)))),
    trackList(tracks),
  ];
}

async function viewSearch(query) {
  if (!auth.loggedIn) return loginPrompt('Поиск');
  let blocks = [];
  try {
    blocks = parseCatalog(await vk('catalog.getAudioSearch', { query, need_blocks: 1 })).blocks;
  } catch {
    /* запасной вариант ниже */
  }
  if (!blocks.some((b) => b.kind === 'tracks')) {
    const resp = await vk('audio.search', { q: query, count: 100, auto_complete: 1 });
    blocks = [{ kind: 'tracks', title: 'Треки', layout: 'list', tracks: (resp.items || []).map(normTrack) }, ...blocks.filter((b) => b.kind !== 'tracks')];
  }
  if (!blocks.some((b) => b.kind === 'artists')) {
    const artists = await searchArtists(query, 10);
    if (artists.length) blocks.unshift({ kind: 'artists', title: 'Артисты', items: artists });
  }
  const head = pageHead('Поиск', `«${query}»`);
  // артисты — первым блоком
  blocks.sort((a, b) => (a.kind === 'artists' ? -1 : 0) - (b.kind === 'artists' ? -1 : 0));
  if (!blocks.some((b) => (b.tracks || b.items || []).length)) {
    return [head, el('div', { class: 'state' }, el('div', { class: 'state-title', text: 'Ничего не нашлось' }), 'Попробуйте написать иначе.')];
  }
  // треки в результатах поиска — полным списком
  blocks.forEach((b) => { if (b.kind === 'tracks') b.layout = 'list'; });
  return [head, renderBlocks(blocks)];
}

// --- Роутер --------------------------------------------------------------------------------

const ROUTES = {
  home: viewHome,
  my: viewMy,
  recs: viewRecs,
  playlists: viewPlaylists,
  history: viewHistory,
  chart: () => viewChart(),
  new: () => viewNew(),
  section: viewSection,
  playlist: viewPlaylist,
  search: viewSearch,
  artist: viewArtist,
  similar: viewSimilar,
};

const router = {
  stack: [],
  index: -1,
  token: 0,
  go(name, params, { push = true } = {}) {
    this.saveCurrent();
    if (push) {
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push({ name, params });
      if (this.stack.length > 30) this.stack.shift();
      this.index = this.stack.length - 1;
    }
    this.render();
  },
  back() { if (this.index > 0) { this.saveCurrent(); this.index -= 1; this.render({ restore: true }); } },
  forward() { if (this.index < this.stack.length - 1) { this.saveCurrent(); this.index += 1; this.render({ restore: true }); } },
  reload() { if (this.index >= 0) { this.dropCache(); this.render(); } },
  // запоминаем готовый экран и прокрутку, чтобы «назад» открывался мгновенно
  saveCurrent() {
    const entry = this.stack[this.index];
    const view = $('#view');
    if (entry && view && !view.querySelector('.skeleton')) {
      entry.node = view;
      entry.scroll = content.scrollTop;
      entry.more = loadMore;
      entry.time = Date.now();
    }
  },
  dropCache() { this.stack.forEach((e) => { e.node = null; }); },
  async render({ restore = false } = {}) {
    const entry = this.stack[this.index];
    const { name, params } = entry;
    const token = ++this.token;
    loadMore = null;
    $$('[data-route]').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
    $('#back').disabled = this.index <= 0;
    $('#forward').disabled = this.index >= this.stack.length - 1;
    if (restore && entry.node && Date.now() - entry.time < CACHE_TTL) {
      $('#view').replaceWith(entry.node);
      content.scrollTop = entry.scroll || 0;
      loadMore = entry.more || null;
      player.markRows();
      return;
    }
    // новый элемент, а не очистка старого: старый экран лежит в кэше для «назад»
    const view = el('div', { class: 'view', id: 'view' }, loadingView());
    $('#view').replaceWith(view);
    content.scrollTop = 0;
    let nodes;
    try {
      nodes = await ROUTES[name](params);
    } catch (err) {
      if (token !== this.token) return;
      view.replaceChildren(errorView(err, () => this.render()));
      return;
    }
    if (token !== this.token) return;
    const fresh = el('div', { class: 'view', id: 'view' }, nodes);
    view.replaceWith(fresh);
    player.markRows();
  },
};

$$('[data-route]').forEach((btn) => btn.addEventListener('click', () => router.go(btn.dataset.route)));
$('#back').addEventListener('click', () => router.back());
$('#forward').addEventListener('click', () => router.forward());

// --- Поиск и подсказки ---------------------------------------------------------------------

const searchInput = $('#search');
const suggest = $('#suggest');
let suggestToken = 0;
let suggestTimer = null;
let suggestSel = -1;
const suggestCache = new Map();

function closeSuggest() {
  suggest.hidden = true;
  suggestSel = -1;
}

function suggestItems() { return $$('.suggest-item', suggest); }
function moveSel(delta) {
  const items = suggestItems();
  if (!items.length) return;
  suggestSel = (suggestSel + delta + items.length) % items.length;
  items.forEach((it, i) => it.classList.toggle('sel', i === suggestSel));
  items[suggestSel].scrollIntoView({ block: 'nearest' });
}

function runSearch(q) {
  q = q.trim();
  if (!q) return;
  closeSuggest();
  searchInput.blur();
  router.go('search', q);
}

async function updateSuggest() {
  const q = searchInput.value.trim();
  const token = ++suggestToken;
  if (!q) { closeSuggest(); return; }
  if (!auth.loggedIn) {
    suggest.replaceChildren(el('button', { class: 'suggest-item', onclick: () => { closeSuggest(); openLogin(); } },
      el('span', { class: 's-icon', html: ICON.login }),
      el('span', { class: 's-text' }, el('div', { class: 's-title', text: 'Войдите, чтобы искать' }), el('div', { class: 's-sub', text: 'Поиск ВК Музыки доступен после входа' }))));
    suggest.hidden = false;
    return;
  }
  let cached = suggestCache.get(q.toLowerCase());
  if (!cached) {
    const [items, found] = await Promise.all([
      vk('audio.search', { q, count: 7, auto_complete: 1 }).then((r) => (r.items || []).map(normTrack)).catch(() => []),
      searchArtists(q, 3),
    ]);
    cached = { items, found };
    suggestCache.set(q.toLowerCase(), cached);
    if (suggestCache.size > 100) suggestCache.delete(suggestCache.keys().next().value);
  }
  if (token !== suggestToken) return;
  const { items } = cached;
  // артисты: из поиска артистов, а если он пуст — из найденных треков
  const seenArtists = new Set();
  const artists = [...cached.found, ...items.flatMap((t) => t.artists)].filter((a) => {
    if (seenArtists.has(String(a.id))) return false;
    seenArtists.add(String(a.id));
    return true;
  }).slice(0, 3);
  const nodes = [
    el('button', { class: 'suggest-item', onclick: () => runSearch(q) },
      el('span', { class: 's-icon', html: ICON.search }),
      el('span', { class: 's-text' }, el('div', { class: 's-title', text: `Искать «${q}»` }), el('div', { class: 's-sub', text: 'Все треки, альбомы и плейлисты' }))),
  ];
  if (artists.length) {
    nodes.push(el('div', { class: 'suggest-head', text: 'Артисты' }));
    artists.forEach((a) => nodes.push(el('button', { class: 'suggest-item', onclick: () => { searchInput.blur(); openArtist(a); } },
      a.photo ? el('img', { src: a.photo, alt: '', style: 'border-radius:50%' }) : el('span', { class: 's-icon', html: ICON.user }),
      el('span', { class: 's-text' }, el('div', { class: 's-title', text: a.name }), el('div', { class: 's-sub', text: 'Артист' })))));
  }
  if (items.length) {
    nodes.push(el('div', { class: 'suggest-head', text: 'Треки' }));
    items.slice(0, 6).forEach((t, i, arr) => nodes.push(el('button', { class: 'suggest-item', onclick: () => { closeSuggest(); player.playList(arr, i); } },
      el('img', { src: t.cover(68) || null, alt: '' }),
      el('span', { class: 's-text' }, el('div', { class: 's-title', text: t.title }), el('div', { class: 's-sub', text: `${t.artist} · ${fmt(t.duration)}` })))));
  }
  suggest.replaceChildren(...nodes);
  suggestSel = -1;
  suggest.hidden = document.activeElement !== searchInput;
}

searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(updateSuggest, 180);
});
searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) updateSuggest(); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Escape') { closeSuggest(); searchInput.blur(); }
  else if (e.key === 'Enter' && suggestSel >= 0) { e.preventDefault(); suggestItems()[suggestSel].click(); }
});
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(searchInput.value); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#search-wrap')) closeSuggest(); });
bridge.onFocusSearch(() => { searchInput.focus(); searchInput.select(); });

// --- Плеер ---------------------------------------------------------------------------------

const audio = new Audio();
audio.preload = 'auto';
audio.crossOrigin = 'anonymous'; // нужно эквалайзеру (CDN ВК разрешает такие запросы)

const player = {
  queue: [],
  order: [],
  pos: -1,
  current: null,
  shuffle: localStorage.getItem('shuffle') === '1',
  repeat: localStorage.getItem('repeat') || 'off', // off | all | one
  hls: null,
  loadId: 0,
  skips: 0,

  mix: false,
  mixLoading: false,

  async startMix() {
    const tracks = await this.fetchMix(false);
    if (!tracks.length) { toast('VK Микс сейчас недоступен'); return; }
    this.mix = true;
    this.queue = tracks;
    this.order = [...tracks.keys()];
    this.pos = 0;
    renderMixState();
    this.load();
  },

  async fetchMix(append) {
    const get = async (more) => {
      const params = { ...mixSettings.params(), count: 10, append: more ? 1 : 0 };
      const resp = await vk('audio.getStreamMixAudios', params, { cache: false });
      const list = (Array.isArray(resp) ? resp : resp.items || []).map(normTrack);
      diag.add('mix', `getStreamMixAudios ${JSON.stringify(params)}`, list.slice(0, 4).map((t) => `${t.artist} — ${t.title}`));
      return list;
    };
    try {
      let tracks = await get(append);
      if (!mixSettings.active()) return tracks;
      // настройки проверяем и сами: язык и «знакомое/незнакомое» видно по трекам
      const all = [...tracks];
      let kept = tracks.filter((t) => mixSettings.accepts(t));
      for (let i = 0; kept.length < 4 && i < 4; i++) {
        tracks = await get(true);
        if (!tracks.length) break;
        all.push(...tracks);
        kept = kept.concat(tracks.filter((t) => mixSettings.accepts(t)));
      }
      return kept.length ? kept : all;
    } catch (err) {
      return [];
    }
  },

  // микс бесконечный: подгружаем следующие треки заранее
  async extendMix() {
    if (!this.mix || this.mixLoading || this.pos < this.order.length - 3) return;
    this.mixLoading = true;
    const more = await this.fetchMix(true);
    const seen = new Set(this.queue.map((t) => t.key));
    for (const t of more) {
      if (seen.has(t.key)) continue;
      this.queue.push(t);
      this.order.push(this.queue.length - 1);
    }
    this.mixLoading = false;
    renderQueue();
  },

  playList(tracks, index, { shuffle } = {}) {
    if (!tracks || !tracks.length) return;
    if (this.mix) { this.mix = false; renderMixState(); }
    if (shuffle !== undefined) this.setShuffle(shuffle);
    const same = this.current && tracks[index] && tracks[index].key === this.current.key && this.queue === tracks;
    if (same) { this.toggle(); return; }
    this.queue = tracks;
    this.buildOrder(shuffle ? Math.floor(Math.random() * tracks.length) : index);
    this.load();
  },

  buildOrder(startIndex) {
    const n = this.queue.length;
    const rest = [...Array(n).keys()].filter((i) => i !== startIndex);
    if (this.shuffle) {
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = [startIndex, ...rest];
      this.pos = 0;
    } else {
      this.order = [...Array(n).keys()];
      this.pos = startIndex;
    }
  },

  setShuffle(on) {
    this.shuffle = on;
    localStorage.setItem('shuffle', on ? '1' : '0');
    if (this.current && this.queue.length) {
      this.buildOrder(this.order[this.pos]);
    }
    renderModes();
  },

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    localStorage.setItem('repeat', this.repeat);
    renderModes();
  },

  async load() {
    const track = this.queue[this.order[this.pos]];
    if (!track) return;
    if (this.mix) this.extendMix();
    const id = ++this.loadId;
    this.current = track;
    renderNowPlaying();
    this.markRows();
    if (!track.url) {
      try {
        const [fresh] = await vk('audio.getById', { audios: track.fullId }, { cache: false });
        if (fresh && fresh.url) track.url = fresh.url;
      } catch {
        /* нет доступа */
      }
    }
    if (id !== this.loadId) return;
    // режим «без цензуры»: если версия уже проверена — сразу играем её;
    // иначе играем лицензию, а проверка идёт в фоне и подменит звук на той же секунде
    track.substitute = null;
    let playUrl = track.url;
    const known = uncensor.applies(track) ? uncensor.get(track.key) : undefined;
    if (known) {
      const altUrl = await uncensor.urlOf(known);
      if (id !== this.loadId) return;
      if (altUrl) {
        track.substitute = { ...known, url: altUrl };
        playUrl = altUrl;
        if (!uncensor.jobs.has(track.key)) uncensor.status.set(track.key, uncensor.statusFromMemo(track));
      } else if (!known.manual) {
        // запомненная копия больше недоступна — ищем заново, пока играет лицензия
        delete uncensor.memo[track.key];
        uncensor.analyze(track).then((alt) => this.useSubstitute(track, alt, id));
      }
    } else if (uncensor.applies(track) && uncensor.get(track.key) === null) {
      if (!uncensor.jobs.has(track.key)) uncensor.status.set(track.key, uncensor.statusFromMemo(track));
    } else if (uncensor.applies(track)) {
      uncensor.analyze(track).then((alt) => this.useSubstitute(track, alt, id));
    } else if (uncensor.enabled && auth.loggedIn) {
      diag.add('18+', `${track.artist} — ${track.title}: автопоиск пропущен (${!track.isLicensed ? 'не лицензия' : track.duration <= 30 ? 'короткий' : 'нет условия'})`);
    }
    renderUncensorStatus();
    renderSubstitute();
    if (!playUrl) {
      toast(auth.loggedIn ? 'Трек недоступен' : 'Полная версия — после входа');
      return this.skipBroken();
    }
    this.attach(playUrl, id, track);
  },

  // найдена версия без цензуры — переключаемся на неё на той же секунде
  async useSubstitute(track, alt, id = this.loadId) {
    if (!alt || id !== this.loadId || this.current !== track) return;
    const altUrl = await uncensor.urlOf(alt);
    if (!altUrl || id !== this.loadId) return;
    track.substitute = { ...alt, url: altUrl };
    renderSubstitute();
    this.attach(altUrl, id, track, false, audio.currentTime);
    toast(alt.manual ? 'Включена выбранная версия' : 'Включена версия без цензуры');
  },

  attach(url, id, track, retried = false, startAt = 0) {
    const wasPaused = audio.paused && startAt > 0;
    this.destroyHls();
    if (/\.m3u8/.test(url) && window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        startPosition: startAt > 0 ? startAt : -1,
        enableWorker: true,
        startFragPrefetch: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30, // по умолчанию hls.js хранит весь прослушанный трек в памяти
      });
      this.hls = hls;
      hls.on(Hls.Events.ERROR, async (_e, data) => {
        if (!data.fatal || id !== this.loadId) return;
        // ссылка протухла — спрашиваем свежую и пробуем ещё раз
        if (!retried && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try {
            const [fresh] = await vk('audio.getById', { audios: track.fullId }, { cache: false });
            if (fresh && fresh.url && id === this.loadId) {
              track.url = fresh.url;
              return this.attach(fresh.url, id, track, true);
            }
          } catch {
            /* ниже — пропуск */
          }
        }
        if (id === this.loadId) this.skipBroken();
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
    } else {
      audio.src = url;
      if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
    }
    if (!wasPaused) audio.play().catch(() => {});
  },

  destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  },

  skipBroken() {
    this.skips += 1;
    if (this.skips > 6) { this.skips = 0; toast('Не получается воспроизвести — проверьте интернет'); return; }
    setTimeout(() => this.next(true), 400);
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    if (this.pos + 1 >= this.order.length) {
      if (this.mix) {
        // микс не кончается: дожидаемся следующей порции и продолжаем
        this.extendMix().then(() => {
          if (this.pos + 1 < this.order.length) { this.pos += 1; this.load(); }
        });
        return;
      }
      if (this.repeat === 'all' || !auto) {
        if (this.shuffle) this.buildOrder(this.order[0]);
        this.pos = 0;
      } else {
        audio.pause();
        return;
      }
    } else {
      this.pos += 1;
    }
    this.load();
  },

  prev() {
    if (!this.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    this.pos = this.pos > 0 ? this.pos - 1 : this.order.length - 1;
    this.load();
  },

  toggle() {
    if (!this.current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  },

  playNext(track) {
    if (!this.current || !this.queue.length) { this.playList([track], 0); return; }
    const index = this.queue.length;
    this.queue = this.queue.concat([track]); // копия: не меняем список на экране
    this.order.splice(this.pos + 1, 0, index);
    renderQueue();
    toast('Будет играть следующим');
  },

  jumpTo(orderPos) {
    this.pos = orderPos;
    this.load();
  },

  markRows() {
    const key = this.current && this.current.key;
    $$('.row.playing').forEach((r) => { if (r.dataset.key !== key) r.classList.remove('playing'); });
    if (key) $$(`.row[data-key="${CSS.escape(key)}"]`).forEach((r) => r.classList.add('playing'));
  },
};

// История прослушиваний (хранится на этом компьютере)
const listenHistory = {
  items: (() => { try { return JSON.parse(localStorage.getItem('history') || '[]'); } catch { return []; } })(),
  lastKey: null,
  add(t) {
    if (!t || t.key === this.lastKey) return;
    this.lastKey = t.key;
    const raw = {
      id: t.id, owner_id: t.owner_id, access_key: t.access_key, title: t.title, subtitle: t.subtitle, artist: t.artist,
      main_artists: t.artists, duration: t.duration, is_explicit: t.explicit, is_licensed: t.isLicensed, album: { thumb: t.thumb }, at: Date.now(),
    };
    this.items = [raw, ...this.items.filter((x) => `${x.owner_id}_${x.id}` !== t.key)].slice(0, 500);
    try { localStorage.setItem('history', JSON.stringify(this.items)); } catch { /* не страшно */ }
  },
  clear() { this.items = []; try { localStorage.removeItem('history'); } catch { /* не страшно */ } },
};

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400e3);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

async function viewHistory() {
  if (!listenHistory.items.length) {
    return [pageHead('Медиатека', 'История'), el('div', { class: 'state' }, el('div', { class: 'state-title', text: 'Здесь пока пусто' }), 'Треки, которые вы слушаете, появятся тут.')];
  }
  const tracks = listenHistory.items.map((x) => normTrack(x));
  const out = [pageHead('Медиатека', 'История', tracksWord(tracks.length), [
    ...playButtons(() => tracks),
    el('button', { class: 'btn ghost', onclick: () => { listenHistory.clear(); router.go('history'); } }, 'Очистить'),
  ])];
  let label = null, group = null;
  listenHistory.items.forEach((x, i) => {
    const l = dayLabel(x.at);
    if (l !== label) {
      label = l;
      group = el('div', { class: 'track-list' });
      out.push(el('section', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { class: 'section-title', text: l })), group));
    }
    group.append(trackRow(tracks[i], tracks, i, { number: false }));
  });
  return out;
}

audio.addEventListener('playing', () => {
  listenHistory.add(player.current);
  player.skips = 0;
  prepareNext();
});

// Пока играет трек, тихо получаем ссылку на следующий — переход будет без паузы
let preparedKey = null;
async function prepareNext() {
  const nextPos = player.pos + 1 < player.order.length ? player.pos + 1 : (player.repeat === 'all' ? 0 : -1);
  const next = nextPos >= 0 ? player.queue[player.order[nextPos]] : null;
  // следующий трек проверяем заранее, после текущего — чтобы к его началу уже играла версия без цензуры
  if (next && uncensor.applies(next) && uncensor.get(next.key) === undefined) {
    const current = player.current && uncensor.jobs.get(player.current.key);
    Promise.resolve(current).catch(() => null).then(() => uncensor.analyze(next));
  }
  if (!next || next.url || preparedKey === next.key) return;
  preparedKey = next.key;
  try {
    const [fresh] = await vk('audio.getById', { audios: next.fullId }, { cache: false });
    if (fresh && fresh.url) next.url = fresh.url;
  } catch {
    /* попробуем при переключении */
  }
}
audio.addEventListener('play', () => { document.body.classList.add('is-playing'); updateMediaSession(); });
audio.addEventListener('pause', () => { document.body.classList.remove('is-playing'); updateMediaSession(); });
audio.addEventListener('ended', () => player.next(true));
audio.addEventListener('error', () => { if (player.current && !player.hls) player.skipBroken(); });
audio.addEventListener('timeupdate', renderProgress);
audio.addEventListener('durationchange', renderProgress);

// --- Отображение «Сейчас играет» -----------------------------------------------------------

let ambientUrl = '';
let ambientFront = 'ambient-a';
function setAmbient(url) {
  if (url === ambientUrl) return;
  ambientUrl = url;
  document.body.classList.toggle('has-art', Boolean(url));
  const back = ambientFront === 'ambient-a' ? 'ambient-b' : 'ambient-a';
  if (!url) {
    $('#' + ambientFront).classList.remove('on');
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (ambientUrl !== url) return;
    $('#' + back).style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
    $('#' + back).classList.add('on');
    $('#' + ambientFront).classList.remove('on');
    ambientFront = back;
  };
  img.src = url;
}

function renderNowPlaying() {
  const t = player.current;
  $('#player').classList.toggle('idle', !t);
  $('#bar-title').textContent = t ? t.title : 'Ничего не играет';
  if (t) artistLine(t, '', $('#bar-artist'));
  else $('#bar-artist').textContent = 'Выберите трек';
  const small = t ? t.cover(135) : '';
  const big = t ? t.cover(1200) || t.cover(600) : '';
  const barImg = $('#bar-cover img');
  if (small) barImg.src = small; else barImg.removeAttribute('src');
  const fsImg = $('#fs-cover img');
  if (big) fsImg.src = big; else fsImg.removeAttribute('src');
  $('#fs-title').textContent = t ? t.title : '';
  artistLine(t, '', $('#fs-artist'));
  lyrics.trackChanged();
  const tiny = t ? t.cover(68) : '';
  setAmbient(tiny);
  const bgImage = t && t.cover(135) ? `url("${t.cover(135).replace(/"/g, '%22')}")` : 'none';
  $$('.fs-bg-layer').forEach((layer) => { layer.style.backgroundImage = bgImage; });
  bridge.trackTitle(t ? `${t.artist} — ${t.title}` : '');
  renderAddState();
  renderSubstitute();
  animateSwap();
  renderQueue();
  updateMediaSession(true);
  renderProgress();
}

function renderQueue() {
  const list = $('#fs-queue');
  const upcoming = [];
  for (let i = player.pos + 1; i < player.order.length && upcoming.length < 30; i++) upcoming.push(i);
  list.replaceChildren(...upcoming.map((p) => {
    const t = player.queue[player.order[p]];
    const row = trackRow(t, player.queue, player.order[p]);
    row.onclick = () => player.jumpTo(p);
    return row;
  }));
}

// --- Настройки VK Микса: настроение, узнаваемость, язык -------------------------------------
// Варианты берём у ВК (audio.getStreamMixSettings), а если он их не отдал — те же, что в приложении ВК.
// Значки настроения — свои, объёмные (эмодзи в Windows выглядят по-разному и грубо)
const MOOD_ICONS = {
  joyful: `<svg viewBox="0 0 48 48"><defs><radialGradient id="mg-sun" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff3b0"/><stop offset=".55" stop-color="#ffc53d"/><stop offset="1" stop-color="#ff8a1f"/></radialGradient></defs><g fill="#ffb43a">${Array.from({ length: 8 }, (_, i) => `<rect x="22" y="2" width="4" height="9" rx="2" transform="rotate(${i * 45} 24 24)"/>`).join('')}</g><circle cx="24" cy="24" r="11" fill="url(#mg-sun)"/></svg>`,
  sad: '<svg viewBox="0 0 48 48"><defs><linearGradient id="mg-moon" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9fc2ff"/><stop offset="1" stop-color="#2f4bff"/></linearGradient></defs><path d="M30 7a17 17 0 1 0 11 27A14 14 0 0 1 30 7z" fill="url(#mg-moon)"/><circle cx="36" cy="13" r="1.6" fill="#cfe0ff"/><circle cx="41" cy="21" r="1.1" fill="#cfe0ff"/></svg>',
  active: '<svg viewBox="0 0 48 48"><defs><linearGradient id="mg-fire" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff3d2e"/><stop offset=".6" stop-color="#ff8a2a"/><stop offset="1" stop-color="#ffd166"/></linearGradient></defs><path d="M24 4c2 7 11 11 11 22a11 11 0 0 1-22 0c0-6 3-9 5-11 0 4 2 6 4 6-1-6 0-12 2-17z" fill="url(#mg-fire)"/><path d="M24 26c2 3 5 4 5 8a5 5 0 0 1-10 0c0-3 3-5 5-8z" fill="#ffe08a"/></svg>',
  calm: '<svg viewBox="0 0 48 48"><defs><linearGradient id="mg-calm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d7b8ff"/><stop offset="1" stop-color="#7b4dff"/></linearGradient></defs><g fill="url(#mg-calm)">' + Array.from({ length: 6 }, (_, i) => `<ellipse cx="24" cy="13" rx="6" ry="10" transform="rotate(${i * 60} 24 24)"/>`).join('') + '</g><circle cx="24" cy="24" r="5" fill="#f1e6ff"/></svg>',
  love: '<svg viewBox="0 0 48 48"><defs><linearGradient id="mg-love" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb3d1"/><stop offset="1" stop-color="#ff2d78"/></linearGradient></defs><path d="M24 41S6 30 6 17a9 9 0 0 1 18-3 9 9 0 0 1 18 3c0 13-18 24-18 24z" fill="url(#mg-love)"/><ellipse cx="15" cy="15" rx="3.5" ry="2.2" fill="#fff" opacity=".45" transform="rotate(-30 15 15)"/></svg>',
};

// Варианты берём у ВК (audio.getStreamMixSettings), а если он их не отдал — те же, что в приложении ВК.
const MIX_DEFAULT_GROUPS = [
  { id: 'vibes', title: 'Настроение', big: true, options: [
    { id: 'happy', title: 'Радостно', svg: MOOD_ICONS.joyful },
    { id: 'sad', title: 'Грустно', svg: MOOD_ICONS.sad },
    { id: 'active', title: 'Активно', svg: MOOD_ICONS.active },
    { id: 'calm', title: 'Спокойно', svg: MOOD_ICONS.calm },
    { id: 'love', title: 'Любовь', svg: MOOD_ICONS.love },
  ] },
  { id: 'recognitions', title: 'Узнаваемость', options: [
    { id: 'known', title: 'Знакомое', local: 'familiar' },
    { id: 'unknown', title: 'Незнакомое', local: 'unfamiliar' },
    { id: 'fresh', title: 'Новинки' },
  ] },
  { id: 'langs', title: 'Язык', options: [
    { id: 'ru', title: 'Русский', local: 'ru' },
    { id: 'international', title: 'Иностранный', local: 'foreign' },
    { id: 'instrumental', title: 'Без слов' },
  ] },
];

const mixSettings = {
  groups: MIX_DEFAULT_GROUPS,
  fromVk: false,
  chosen: (() => { try { return JSON.parse(localStorage.getItem('mixSettings') || '{}'); } catch { return {}; } })(),
  draft: {},

  active() { return Object.values(this.chosen).some(Boolean); },

  option(groupId, optionId) {
    const g = this.groups.find((x) => x.id === groupId);
    return g && g.options.find((o) => o.id === optionId);
  },

  summary() {
    const picked = Object.entries(this.chosen).filter(([, v]) => v).map(([g, v]) => (this.option(g, v) || {}).title).filter(Boolean);
    return picked.length ? picked.join(' · ') : 'Бесконечный поток музыки под ваш вкус';
  },

  // Как передавать настройки в audio.getStreamMixAudios, ВК не документирует —
  // способ подбирается один раз проверкой (discover) и запоминается
  format: localStorage.getItem('mixFormat') || '',
  FORMATS: {
    keys: (sel) => Object.fromEntries(Object.entries(sel).map(([g, v]) => [g, v.join(',')])),
    mix_params: (sel) => ({ mix_params: JSON.stringify(sel) }),
    settings: (sel) => ({ settings: JSON.stringify(sel) }),
    mix_settings: (sel) => ({ mix_settings: JSON.stringify(sel) }),
    filters: (sel) => ({ filters: JSON.stringify(sel) }),
    options: (sel) => ({ options: Object.values(sel).flat().join(',') }),
    mix_options: (sel) => ({ mix_options: Object.values(sel).flat().join(',') }),
    selected_options: (sel) => ({ selected_options: Object.values(sel).flat().join(',') }),
  },
  selection(chosen = this.chosen) {
    return Object.fromEntries(Object.entries(chosen).filter(([, v]) => v).map(([g, v]) => [g, [v]]));
  },

  // Параметры запроса микса
  params() {
    const params = { mix_id: 'common' };
    const fmt = this.FORMATS[this.format];
    if (fmt && this.active()) Object.assign(params, fmt(this.selection()));
    return params;
  },

  // Проверка способов: отправляем микс с «Язык: Иностранный» и смотрим, запомнил ли ВК выбор
  // (audio.getStreamMixSettings отдаёт отмеченные варианты) или поменялся ли язык треков
  async discover() {
    if (this.format || !auth.loggedIn) return this.format;
    const cyrShare = (list) => list.length ? list.filter((t) => /[а-яё]/i.test(`${t.artist} ${t.title}`)).length / list.length : 0;
    const fetchMix = async (extra) => {
      const resp = await vk('audio.getStreamMixAudios', { mix_id: 'common', count: 20, append: 0, ...extra }, { cache: false });
      return (Array.isArray(resp) ? resp : resp.items || []).map(normTrack);
    };
    const selectedNow = async () => {
      const r = await vk('audio.getStreamMixSettings', { mix_id: 'common' }, { cache: false });
      const out = {};
      for (const g of ((r.settings || r).mix_categories || [])) for (const o of g.options || []) if (o.selected) out[g.id] = String(o.id);
      return out;
    };
    const results = {};
    for (const [name, fmt] of Object.entries(this.FORMATS)) {
      try {
        const foreign = await fetchMix(fmt({ langs: ['international'] }));
        const stored = await selectedNow().catch(() => ({}));
        const russian = await fetchMix(fmt({ langs: ['ru'] }));
        const diff = cyrShare(russian) - cyrShare(foreign);
        results[name] = { stored: stored.langs || '', diff: Math.round(diff * 100) / 100 };
        if (stored.langs === 'international' || diff > 0.5) {
          this.format = name;
          break;
        }
      } catch (err) {
        results[name] = err.message;
      }
    }
    diag.add('mix', `подбор способа передать настройки: ${this.format || 'ни один не сработал'}`, results);
    try { localStorage.setItem('mixFormat', this.format || 'none'); } catch { /* не страшно */ }
    if (!this.format) this.format = 'none';
    return this.format;
  },

  // Проверка трека по тому, что видно без ВК
  accepts(t) {
    const text = `${t.artist} ${t.title}`;
    const cyr = /[а-яё]/i.test(text);
    for (const [groupId, optionId] of Object.entries(this.chosen)) {
      const o = optionId && this.option(groupId, optionId);
      const local = o && o.local;
      if (local === 'ru' && !cyr) return false;
      if (local === 'foreign' && cyr) return false;
      if (local === 'unfamiliar' && library.has(t)) return false;
      if (local === 'familiar' && library.loaded && !library.has(t) && !this.knownArtist(t)) return false;
    }
    return true;
  },

  knownArtist(t) {
    return (t.artists || []).some((a) => libraryArtists.has(a.name.toLowerCase())) || libraryArtists.has(t.artist.toLowerCase());
  },

  // Разбираем ответ ВК в группы. Формат ответа не документирован — принимаем любые похожие поля.
  async loadFromVk() {
    if (this.fromVk || !auth.loggedIn) return;
    try {
      const resp = await vk('audio.getStreamMixSettings', {}, { cache: false });
      diag.add('mix', 'audio.getStreamMixSettings', resp);
      // формат ВК: { settings: { mix_categories: [{ id: 'vibes', options: [{ id: 'happy', selected }] }] } }
      const root = resp.settings || resp;
      const rawGroups = root.mix_categories || root.categories || (Array.isArray(resp) ? resp : resp.items || []);
      this.serverSelected = {};
      for (const g of rawGroups) for (const o of g.options || []) if (o.selected) this.serverSelected[g.id] = String(o.id);
      const groups = rawGroups.map((g) => {
        const options = (g.options || g.items || g.values || g.buttons || []).map((o) => ({
          id: String(o.id ?? o.value ?? o.key ?? o.name ?? ''),
          title: o.title || o.name || o.text || '',
          svg: '',
          image: (typeof o.icon === 'string' && /\.(png|jpe?g|webp|svg)(\?|$)/i.test(o.icon) && o.icon) || (o.icon && (o.icon.url || (Array.isArray(o.icon) && o.icon.length && o.icon[o.icon.length - 1].url))) || (o.image && o.image.url) || '',
          mixId: o.mix_id || '',
          params: o.params || o.request_params || null,
        })).filter((o) => o.id && o.title);
        return { id: String(g.id ?? g.key ?? g.type ?? g.name ?? ''), title: g.title || g.name || '', options };
      }).filter((g) => g.id && g.options.length);
      if (!groups.length) return;
      // свои значки и локальные проверки переносим по названиям
      for (const g of groups) {
        const def = MIX_DEFAULT_GROUPS.find((d) => d.title.toLowerCase() === g.title.toLowerCase());
        if (def) g.big = def.big;
        for (const o of g.options) {
          const d = MIX_DEFAULT_GROUPS.flatMap((x) => x.options).find((x) => x.title.toLowerCase() === o.title.toLowerCase());
          if (d) { o.svg = o.image ? '' : d.svg; o.local = d.local; }
        }
      }
      this.groups = groups;
      this.fromVk = true;
      for (const k of Object.keys(this.chosen)) if (!this.option(k, this.chosen[k])) delete this.chosen[k];
      // настройки, выбранные в приложении ВК, подхватываем, если здесь ещё ничего не выбрано
      if (!this.active() && Object.keys(this.serverSelected).length) this.chosen = { ...this.serverSelected };
    } catch (err) {
      diag.add('mix', `audio.getStreamMixSettings: ${err.message}`); // остаются варианты по умолчанию
    }
  },

  async open() {
    this.draft = { ...this.chosen };
    await this.loadFromVk();
    let panel = $('#mix-settings');
    if (panel) panel.remove();
    panel = el('div', { class: 'mix-settings-backdrop', id: 'mix-settings', onclick: (e) => { if (e.target === panel) this.close(); } },
      el('div', { class: 'mix-settings', role: 'dialog', 'aria-label': 'Настроить VK Микс' },
        el('div', { class: 'ms-head' },
          el('div', {}, el('div', { class: 'ms-title', text: 'Настроить VK Микс' }), el('div', { class: 'ms-sub', text: 'Выберите по одному варианту в любой группе' })),
          el('button', { class: 'ms-close', title: 'Закрыть', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', onclick: () => this.close() })),
        this.groups.map((g) => el('div', { class: 'ms-group' },
          el('div', { class: 'ms-label', text: g.title }),
          el('div', { class: 'ms-options' + (g.big ? ' big' : '') }, g.options.map((o) => el('button', {
            class: 'ms-opt' + (this.draft[g.id] === o.id ? ' on' : ''),
            dataset: { group: g.id, opt: o.id },
            onclick: () => { this.draft[g.id] = this.draft[g.id] === o.id ? '' : o.id; this.paint(); },
          },
          g.big ? (o.image ? el('span', { class: 'ms-icon' }, el('img', { src: o.image, alt: '' })) : el('span', { class: 'ms-icon', html: o.svg || MOOD_ICONS.calm })) : null,
          el('span', { class: 'ms-text', text: o.title })))))),
        el('div', { class: 'ms-foot' },
          el('button', { class: 'ms-reset', text: 'Сбросить', onclick: () => { this.draft = {}; this.paint(); } }),
          el('button', { class: 'ms-apply', id: 'ms-apply', text: 'Применить', onclick: () => this.apply() }))));
    document.body.append(panel);
    this.paint();
  },

  paint() {
    $$('#mix-settings .ms-opt').forEach((b) => b.classList.toggle('on', this.draft[b.dataset.group] === b.dataset.opt));
    const same = JSON.stringify(this.clean(this.draft)) === JSON.stringify(this.clean(this.chosen));
    const apply = $('#ms-apply');
    if (apply) apply.disabled = same;
  },

  clean(obj) { return Object.fromEntries(Object.entries(obj).filter(([, v]) => v).sort()); },

  close() { const p = $('#mix-settings'); if (p) p.remove(); },

  async apply() {
    this.chosen = this.clean(this.draft);
    if (!this.format && this.active()) {
      toast('Настраиваем VK Микс…', { duration: 20000 });
      await this.discover();
    }
    try { localStorage.setItem('mixSettings', JSON.stringify(this.chosen)); } catch { /* не страшно */ }
    this.close();
    const sub = $('#mix-sub');
    if (sub) sub.textContent = this.summary();
    player.startMix(); // сразу слушаем микс с новыми настройками
  },
};

// Артисты из «Моих аудио» — чтобы понимать, что пользователю знакомо
const libraryArtists = new Set();

function renderMixState() {
  const card = $('#mix-card');
  if (card) card.classList.toggle('on', player.mix);
}

function renderModes() {
  $$('[data-act="shuffle"]').forEach((b) => b.classList.toggle('on', player.shuffle));
  $$('[data-act="repeat"]').forEach((b) => {
    b.classList.toggle('on', player.repeat !== 'off');
    b.classList.toggle('one', player.repeat === 'one');
    b.title = { off: 'Повтор выключен', all: 'Повторять очередь', one: 'Повторять трек' }[player.repeat];
  });
  renderQueue();
}

// перемотка и громкость: следуют за курсором 1:1, применяются при отпускании
const setFill = (input) => input.style.setProperty('--p', `${((input.value - input.min) / ((input.max - input.min) || 1)) * 100}%`);
let seeking = false;
const seekEls = $$('.seek');
const posEls = $$('[data-bind="pos"]');
const durEls = $$('[data-bind="dur"]');
let progressQueued = false;
let lastPosText = '';
let lastDurText = '';
function renderProgress() {
  if (progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(() => {
    progressQueued = false;
    if (document.body.classList.contains('paused')) return; // окно свёрнуто — не рисуем
    const d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (player.current ? player.current.duration : 0);
    if (!seeking) {
      const value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
      seekEls.forEach((s) => { if (Number(s.value) !== value) { s.value = value; setFill(s); } });
      const posText = fmt(audio.currentTime);
      if (posText !== lastPosText) { lastPosText = posText; posEls.forEach((n) => { n.textContent = posText; }); }
    }
    const durText = fmt(d);
    if (durText !== lastDurText) { lastDurText = durText; durEls.forEach((n) => { n.textContent = durText; }); }
    if (sheet.open) lyrics.update();
  });
}
seekEls.forEach((s) => {
  s.addEventListener('pointerdown', () => { seeking = true; });
  s.addEventListener('input', () => {
    seeking = true;
    setFill(s);
    const d = isFinite(audio.duration) ? audio.duration : 0;
    posEls.forEach((n) => { n.textContent = fmt((s.value / 1000) * d); });
    seekEls.forEach((o) => { if (o !== s) { o.value = s.value; setFill(o); } });
  });
  s.addEventListener('change', () => {
    const d = isFinite(audio.duration) ? audio.duration : 0;
    if (d) audio.currentTime = (s.value / 1000) * d;
    seeking = false;
  });
});

let lastVolume = Number(localStorage.getItem('volume') || 0.8);
function setVolume(v, remember = true) {
  audio.volume = Math.max(0, Math.min(1, v));
  if (remember && v > 0) lastVolume = v;
  localStorage.setItem('volume', String(audio.volume));
  $$('.vol').forEach((r) => { r.value = Math.round(audio.volume * 100); setFill(r); });
  $$('.volume').forEach((w) => w.classList.toggle('muted', audio.volume === 0));
}
$$('.vol').forEach((r) => r.addEventListener('input', () => setVolume(r.value / 100)));
$$('.mute').forEach((b) => b.addEventListener('click', () => setVolume(audio.volume > 0 ? 0 : lastVolume || 0.7, false)));

// кнопки управления
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'toggle') player.toggle();
  else if (act === 'next') player.next();
  else if (act === 'prev') player.prev();
  else if (act === 'shuffle') player.setShuffle(!player.shuffle);
  else if (act === 'repeat') player.cycleRepeat();
  else if (act === 'add') library.toggle(player.current);
  else if (act === 'menu') openTrackMenu(player.current, btn);
  else if (act === 'download') downloadTrack(player.current);
});
bridge.onMedia((action) => {
  if (action === 'toggle') player.toggle();
  if (action === 'next') player.next();
  if (action === 'prev') player.prev();
});

// системная плашка Windows / медиаклавиши
function updateMediaSession(metadata = false) {
  if (!('mediaSession' in navigator)) return;
  const t = player.current;
  if (metadata) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({
      title: t.title,
      artist: t.artist,
      artwork: [135, 300, 600, 1200].map((s) => ({ src: t.cover(s), sizes: `${s}x${s}`, type: 'image/jpeg' })).filter((a) => a.src),
    }) : null;
  }
  navigator.mediaSession.playbackState = !t ? 'none' : audio.paused ? 'paused' : 'playing';
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => player.toggle());
  ms.setActionHandler('pause', () => player.toggle());
  ms.setActionHandler('nexttrack', () => player.next());
  ms.setActionHandler('previoustrack', () => player.prev());
  ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; });
}

// --- Текст песни ---------------------------------------------------------------------------

const lyricsBox = $('#fs-lyrics');
const lyrics = {
  key: null,      // для какого трека загружен текст
  lines: [],      // [{ time, text, node }]
  synced: false,
  active: -1,
  loading: false,

  trackChanged() {
    this.key = null;
    this.lines = [];
    this.active = -1;
    if (sheet.open && fsModes.current === 'lyrics') this.load();
  },

  parse(resp, duration) {
    const l = (resp && (resp.lyrics || resp)) || {};
    const stamps = l.timestamps || l.lines || [];
    if (Array.isArray(stamps) && stamps.length && stamps[0] && ('begin' in stamps[0] || 'time' in stamps[0])) {
      let lines = stamps.map((x) => ({ time: Number(x.begin ?? x.time ?? 0), text: String(x.line ?? x.text ?? '') }));
      // ВК отдаёт время в миллисекундах; если похоже на секунды — оставляем
      const maxTime = Math.max(...lines.map((x) => x.time));
      if (maxTime > (duration || 600) + 30) lines = lines.map((x) => ({ ...x, time: x.time / 1000 }));
      return { synced: true, lines };
    }
    const text = Array.isArray(l.text) ? l.text : typeof l.text === 'string' ? l.text.split('\n') : null;
    if (text && text.some((x) => x.trim())) return { synced: false, lines: text.map((t) => ({ time: 0, text: t })) };
    return null;
  },

  async load() {
    const t = player.current;
    if (!t || this.key === t.key || this.loading) return;
    this.key = t.key;
    this.loading = true;
    lyricsBox.className = 'fs-lyrics empty';
    lyricsBox.replaceChildren(el('div', { class: 'lyric-empty', text: 'Загружаем текст…' }));
    let parsed = null;
    if (auth.loggedIn) {
      try {
        parsed = this.parse(await vk('audio.getLyrics', { audio_id: t.key }), t.duration);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) diag.add('lyrics', `${t.artist} — ${t.title}: у ВК текста нет`);
    // у ВК текста нет — открытая база LRCLIB (часто с привязкой ко времени), затем Genius
    if (!parsed && player.current && player.current.key === t.key) {
      lyricsBox.replaceChildren(el('div', { class: 'lyric-empty', text: 'Ищем текст…' }));
      const lrc = await bridge.lrclibLyrics({ artist: t.artist, title: t.title, duration: t.duration }).catch(() => null);
      if (lrc && lrc.synced) {
        const lines = lrc.synced.split('\n').map((line) => {
          const m = /^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line.trim());
          return m ? { time: Number(m[1]) * 60 + Number(m[2]), text: m[3] } : null;
        }).filter(Boolean);
        if (lines.length) parsed = { synced: true, lines, source: 'LRCLIB' };
      }
      if (!parsed && lrc && lrc.plain) parsed = { synced: false, lines: lrc.plain.split('\n').map((text) => ({ time: 0, text })), source: 'LRCLIB' };
      diag.add('lyrics', `LRCLIB: ${parsed ? 'найден' : 'нет'}`);
    }
    if (!parsed && player.current && player.current.key === t.key) {
      lyricsBox.replaceChildren(el('div', { class: 'lyric-empty', text: 'Ищем текст на Genius…' }));
      const genius = await bridge.geniusLyrics({ artist: t.artist, title: t.title }).catch((err) => ({ error: String(err) }));
      if (genius && genius.lines && genius.lines.length) {
        parsed = { synced: false, lines: genius.lines.map((text) => ({ time: 0, text })), source: 'Genius' };
      }
      diag.add('lyrics', `Genius: ${parsed ? 'найден' : (genius && genius.url ? `страница ${genius.url}, ${genius.error || 'текста нет'}` : 'песня не найдена в поиске')}`);
    }
    this.loading = false;
    if (!player.current || player.current.key !== t.key) { this.key = null; return this.load(); }
    if (!parsed) {
      this.lines = [];
      lyricsBox.replaceChildren(el('div', { class: 'lyric-empty', text: 'Текст для этого трека не нашёлся' }));
      return;
    }
    this.synced = parsed.synced;
    this.active = -1;
    lyricsBox.className = 'fs-lyrics ' + (parsed.synced ? 'synced' : 'plain');
    this.lines = parsed.lines.map((line) => ({
      ...line,
      node: el('div', {
        class: 'lyric' + (!parsed.synced && /^\[.*\]$/.test(line.text.trim()) ? ' tag' : ''), text: line.text || (parsed.synced ? '♪' : '\u00a0'),
        onclick: parsed.synced ? () => { audio.currentTime = line.time; this.update(true); } : null,
      }),
    }));
    lyricsBox.replaceChildren(...this.lines.map((l) => l.node));
    if (parsed.source) lyricsBox.append(el('div', { class: 'lyric-source', text: `Текст: ${parsed.source}` }));
    lyricsBox.scrollTop = 0;
    this.update(true);
  },

  // подсветка текущей строки и плавная прокрутка к ней
  update(force = false) {
    if (!this.synced || !this.lines.length || fs.hidden) return;
    const now = audio.currentTime + 0.25;
    let idx = -1;
    for (let i = 0; i < this.lines.length; i++) if (this.lines[i].time <= now) idx = i; else break;
    if (idx === this.active && !force) return;
    this.lines.forEach((l, i) => {
      l.node.classList.toggle('active', i === idx);
      l.node.classList.toggle('past', i < idx);
    });
    this.active = idx;
    const target = this.lines[Math.max(idx, 0)].node;
    lyricsBox.scrollTo({ top: target.offsetTop - lyricsBox.clientHeight * 0.38, behavior: force ? 'auto' : 'smooth' });
  },
};

// режимы полноэкранного плеера: «Обложка» / «Текст» / «Далее»
const fsModes = {
  current: localStorage.getItem('fsMode') || 'cover',

  set(name) {
    this.current = name;
    localStorage.setItem('fsMode', name);
    const fsEl = $('#fs');
    fsEl.classList.remove('mode-cover', 'mode-lyrics', 'mode-queue');
    fsEl.classList.add(`mode-${name}`);
    $$('[data-fs-tab]').forEach((t) => t.classList.toggle('active', t.dataset.fsTab === name));
    $$('[data-fs-pane]').forEach((p) => { p.hidden = p.dataset.fsPane !== name; });
    this.moveIndicator();
    if (name === 'lyrics') { lyrics.load(); requestAnimationFrame(() => lyrics.update(true)); }
    if (name === 'queue') renderQueue();
  },

  // белый ползунок перетекает под выбранную вкладку
  moveIndicator() {
    const tab = $(`[data-fs-tab="${this.current}"]`);
    const ind = $('#fs-tab-ind');
    if (!tab || !ind || !tab.offsetWidth) return;
    ind.style.width = `${tab.offsetWidth}px`;
    ind.style.transform = `translateX(${tab.offsetLeft}px)`;
  },
};
$$('[data-fs-tab]').forEach((tab) => tab.addEventListener('click', () => fsModes.set(tab.dataset.fsTab)));
window.addEventListener('resize', () => fsModes.moveIndicator());

// --- Полноэкранный плеер: лист с пружинами и жестом ----------------------------------------

const fs = $('#fs');
const sheet = {
  y: 0,
  v: 0,
  raf: 0,
  open: false,

  set(y) {
    this.y = y;
    fs.style.transform = `translate3d(0, ${y}px, 0)`;
    // фон под листом проявляется по мере открытия
    fs.style.opacity = String(Math.max(0.5, 1 - y / (window.innerHeight * 1.6)));
  },

  // пружина с затуханием (damping) и откликом (response) — как у Apple
  springTo(target, { velocity = this.v, damping = 1, response = 0.38 } = {}, done) {
    cancelAnimationFrame(this.raf);
    const k = (2 * Math.PI / response) ** 2;
    const c = (4 * Math.PI * damping) / response;
    let v = velocity;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const a = -k * (this.y - target) - c * v;
      v += a * dt;
      this.set(this.y + v * dt);
      this.v = v;
      if (Math.abs(this.y - target) < 0.5 && Math.abs(v) < 20) {
        this.set(target);
        this.v = 0;
        if (done) done();
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },

  // пока лист полностью открыт, интерфейс под ним не рисуем
  cover(on) { document.body.classList.toggle('fs-covered', on); },

  show() {
    if (!player.current) return;
    fs.hidden = false;
    this.open = true;
    document.body.classList.add('fs-open');
    fsModes.set(fsModes.current);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.set(0); this.cover(true); return; }
    // появляется оттуда, где была нижняя панель
    this.set(window.innerHeight);
    this.springTo(0, { velocity: 0, damping: 1, response: 0.42 }, () => this.cover(true));
  },

  hide(velocity = 0) {
    this.open = false;
    document.body.classList.remove('fs-open');
    if (document.body.classList.contains('immersive')) setImmersive(false);
    this.cover(false);
    const finish = () => { fs.hidden = true; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    this.springTo(window.innerHeight, { velocity: Math.max(velocity, 0), damping: 1, response: 0.36 }, finish);
  },
};

// Перетаскивание листа вниз: 1:1 за курсором, резиновое сопротивление вверх,
// по отпусканию — проекция импульса и пружина с унаследованной скоростью
(function setupSheetDrag() {
  let dragging = false;
  let startY = 0;
  let startSheetY = 0;
  let history = [];
  const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
  const project = (v, d = 0.998) => ((v / 1000) * d) / (1 - d);

  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    dragging = true;
    cancelAnimationFrame(sheet.raf); // перехватываем лист прямо на лету
    sheet.cover(false);
    startY = e.clientY;
    startSheetY = sheet.y;
    history = [{ y: e.clientY, t: performance.now() }];
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    let y = startSheetY + (e.clientY - startY);
    if (y < 0) y = rubberband(y, window.innerHeight);
    sheet.set(y);
    history.push({ y: e.clientY, t: performance.now() });
    if (history.length > 6) history.shift();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    const a = history[0];
    const b = history[history.length - 1];
    const dt = (b.t - a.t) / 1000;
    const v = dt > 0 ? (b.y - a.y) / dt : 0;
    const projected = sheet.y + project(v);
    if (projected > window.innerHeight * 0.3 && v > -200) sheet.hide(v);
    else sheet.springTo(0, { velocity: v, damping: 0.85, response: 0.36 }, () => sheet.cover(true));
  };
  for (const target of [$('#fs-grabber'), $('#fs-cover'), $('.fs-top')]) {
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
})();

$('#bar-track').addEventListener('click', (e) => { if (!e.target.closest('.artist-link')) sheet.show(); });
$('#expand').addEventListener('click', () => sheet.show());
$('#fs-close').addEventListener('click', () => sheet.hide());

// --- Меню трека (⋯ и правый клик) ---------------------------------------------------------

let openMenuEl = null;
function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}
function openTrackMenu(track, anchor) {
  closeMenu();
  if (!track) return;
  const inLibrary = library.has(track);
  const items = [
    ['Играть следующим', ICON.next, () => player.playNext(track)],
    [inLibrary ? 'Удалить из Моих аудио' : 'Добавить в Мои аудио', inLibrary ? ICON.minus : ICON.plus, () => library.toggle(track)],
    ['Скачать', ICON.download, () => downloadTrack(track)],
    ['Найти похожие', ICON.sparkle, () => router.go('similar', track)],
    ['Перейти к артисту', ICON.user, () => (track.artists.length ? openArtist(track.artists[0]) : openArtistByName(track.artist))],
    ['Текст на Genius', ICON.quote, () => bridge.geniusOpen({ artist: track.artist, title: track.title })],
    ['Найти версию без цензуры', ICON.search, () => { uncensor.recheck(track); if (player.current && player.current.key === track.key) uncensorDetails.open(track); }],
  ];
  const menu = el('div', { class: 'menu', role: 'menu' },
    el('div', { class: 'menu-head' }, el('div', { class: 'menu-title', text: track.title }), el('div', { class: 'menu-sub', text: track.artist })),
    items.map(([label, icon, action]) => el('button', {
      class: 'menu-item', role: 'menuitem',
      onclick: () => { closeMenu(); action(); },
    }, el('span', { class: 'menu-ico', html: icon }), label)));
  document.body.append(menu);
  // рядом с кнопкой или курсором, но внутри окна
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = (anchor instanceof Element ? r.right - mw : r.left);
  let y = r.bottom + 6;
  if (y + mh > window.innerHeight - 8) y = r.top - mh - 6;
  x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  y = Math.max(8, y);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.transformOrigin = `${anchor instanceof Element ? '100%' : '0'} ${y < r.top ? '100%' : '0'}`;
  openMenuEl = menu;
}
document.addEventListener('pointerdown', (e) => { if (openMenuEl && !e.target.closest('.menu')) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
content.addEventListener('scroll', closeMenu, { passive: true });

// --- Мои аудио: добавить / убрать -----------------------------------------------------------

const library = {
  keys: new Set(),
  loaded: false,

  async load() {
    this.keys.clear();
    libraryArtists.clear();
    this.loaded = false;
    if (!auth.loggedIn || !auth.me) return renderAddState();
    // список «Моих аудио» нужен только чтобы знать, что уже добавлено — грузим порциями в фоне
    try {
      let offset = 0;
      for (let guard = 0; guard < 60; guard++) {
        const resp = await vk('audio.get', { owner_id: auth.me.id, count: MY_PAGE, offset });
        const items = resp.items || [];
        items.forEach((a) => {
          this.keys.add(`${a.owner_id}_${a.id}`);
          (a.main_artists || []).forEach((x) => x.name && libraryArtists.add(x.name.toLowerCase()));
          if (a.artist) libraryArtists.add(a.artist.toLowerCase());
        });
        offset += items.length;
        renderAddState();
        if (!items.length || offset >= (resp.count || 0)) break;
      }
      this.loaded = true;
    } catch {
      /* не страшно — кнопка просто покажет «добавить» */
    }
    renderAddState();
  },

  has(t) { return Boolean(t) && this.keys.has(t.key); },

  async toggle(t) {
    if (!t) return;
    if (!auth.loggedIn) { openLogin(); return; }
    try {
      if (this.has(t)) {
        try {
          await vk('audio.delete', { audio_id: t.id, owner_id: auth.me.id }, { cache: false });
        } catch {
          await vk('audio.delete', { audio_id: t.id, owner_id: t.owner_id }, { cache: false });
        }
        this.keys.delete(t.key);
        toast('Убрано из Моих аудио');
      } else {
        const params = { audio_id: t.id, owner_id: t.owner_id };
        if (t.access_key) params.access_key = t.access_key;
        await vk('audio.add', params, { cache: false });
        this.keys.add(t.key);
        toast('Добавлено в Мои аудио');
      }
      apiCache.clear(); // «Моя музыка» должна обновиться
    } catch (err) {
      toast(`Не получилось: ${err.message}`);
    }
    renderAddState();
  },
};

function renderAddState() {
  const added = library.has(player.current);
  $$('[data-act="add"]').forEach((b) => {
    b.classList.toggle('added', added);
    b.title = added ? 'Убрать из Моих аудио' : 'Добавить в Мои аудио';
  });
}

// --- Скачивание ---------------------------------------------------------------------------

let downloading = false;
async function downloadTrack(t) {
  if (!t || downloading) return;
  if (!auth.loggedIn) { toast('Скачивание — после входа во ВКонтакте'); openLogin(); return; }
  const src = t.substitute || t; // качаем ту версию, что играет (в т.ч. без цензуры)
  let url = src.url;
  if (!url) {
    try {
      const [fresh] = await vk('audio.getById', { audios: src.fullId }, { cache: false });
      url = fresh && fresh.url;
    } catch {
      url = '';
    }
  }
  if (!url) { toast('Этот трек нельзя скачать'); return; }
  downloading = true;
  const buttons = $$('[data-act="download"]');
  buttons.forEach((b) => { b.classList.add('busy'); b.style.setProperty('--dl', '0%'); });
  const res = await bridge.download({ key: t.key, url, title: t.title, artist: t.artist, album: t.album, cover: t.cover(600) });
  buttons.forEach((b) => b.classList.remove('busy'));
  downloading = false;
  if (res.ok) toast('Сохранено — показать в папке', { onClick: () => bridge.showFile(res.path), duration: 5000 });
  else if (!res.canceled) toast(`Не удалось скачать: ${res.error || 'ошибка'}`);
}
bridge.onDownloadProgress(({ progress }) => {
  $$('[data-act="download"]').forEach((b) => b.style.setProperty('--dl', `${Math.round(progress * 100)}%`));
});

// --- Эквалайзер (Web Audio) ---------------------------------------------------------------

const eq = {
  freqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  presets: {
    'Обычный': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Бас': [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0],
    'Поп': [-1, 1, 3, 4, 3, 1, -1, -1, 0, 0],
    'Рок': [4, 3, 1.5, -1, -1, 1, 3, 4, 4, 4],
    'Хип-хоп': [5, 4.5, 2, 3, -1, -1, 1, -0.5, 2, 3],
    'Электроника': [5, 4, 1, 0, -1.5, 1, 0, 2, 4, 5],
    'Вокал': [-2, -2, -1, 1, 3.5, 4, 3, 1.5, 0, -1],
    'Акустика': [3, 3, 2, 1, 1.5, 1, 2, 3, 3, 2],
    'Ночь': [-1, 0, 1, 1, 0, -1, -2, -3, -4, -5],
  },
  enabled: localStorage.getItem('eqOn') === '1',
  preset: localStorage.getItem('eqPreset') || 'Обычный',
  gains: JSON.parse(localStorage.getItem('eqGains') || 'null') || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ctx: null,
  filters: [],
  analyser: null,

  // цепочка: <audio> → 10 фильтров → анализатор (для «пульса» обложки) → динамики
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      this.filters = this.freqs.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === this.freqs.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      });
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      [source, ...this.filters, this.analyser, ctx.destination].reduce((a, b) => { a.connect(b); return b; });
      this.ctx = ctx;
      this.apply();
    } catch (err) {
      console.warn('Эквалайзер недоступен', err);
    }
  },

  apply() {
    this.filters.forEach((f, i) => { f.gain.value = this.enabled ? this.gains[i] : 0; });
    $$('.eq-toggle').forEach((b) => b.classList.toggle('on', this.enabled));
    $('#eq-panel').classList.toggle('off', !this.enabled);
  },

  save() {
    localStorage.setItem('eqOn', this.enabled ? '1' : '0');
    localStorage.setItem('eqPreset', this.preset);
    localStorage.setItem('eqGains', JSON.stringify(this.gains));
  },

  setPreset(name) {
    this.preset = name;
    this.gains = [...this.presets[name]];
    this.enabled = true;
    $('#eq-on').checked = true;
    this.save();
    this.apply();
    this.render();
  },

  render() {
    $('#eq-on').checked = this.enabled;
    $('#eq-presets').replaceChildren(...Object.keys(this.presets).map((name) => el('button', {
      class: 'eq-chip' + (name === this.preset ? ' active' : ''), text: name, onclick: () => this.setPreset(name),
    })));
    $('#eq-bands').replaceChildren(...this.freqs.map((f, i) => {
      const input = el('input', { type: 'range', min: '-12', max: '12', step: '0.5', value: String(this.gains[i]), 'aria-label': `${f} Гц` });
      setFill(input);
      input.addEventListener('input', () => {
        this.gains[i] = Number(input.value);
        this.preset = 'Свой';
        $$('.eq-chip').forEach((c) => c.classList.remove('active'));
        setFill(input);
        this.apply();
        this.save();
      });
      return el('div', { class: 'eq-band' }, input, el('span', { text: f >= 1000 ? `${f / 1000}k` : String(f) }));
    }));
    this.apply();
  },
};

// эквалайзер открывается и из нижней панели, и из полноэкранного плеера
$$('.eq-toggle').forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('#eq-panel');
  panel.hidden = !panel.hidden;
  panel.classList.toggle('in-fs', sheet.open);
  if (!panel.hidden) eq.render();
}));
$('#uc-open').addEventListener('click', () => { $('#eq-panel').hidden = true; uncensorDetails.open(); });
$('#report-save').addEventListener('click', () => diag.save());
$$('.uc-status, #uncensored-badge').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); uncensorDetails.open(); }));
$('#eq-on').addEventListener('change', () => {
  eq.enabled = $('#eq-on').checked;
  eq.save();
  eq.apply();
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#eq-panel, .eq-toggle')) $('#eq-panel').hidden = true;
});

// --- Подмена зацензуренных треков оригиналом ---------------------------------------------
// 1) Ищем во ВКонтакте ту же песню: тот же исполнитель, то же название (приписки в скобках
//    вроде «(Nagasaki's.47)» допускаются), та же длительность ±4 с, и это не ремикс/slowed/cover/live.
// 2) Проверяем по звуку (shell/compare.js): кандидат должен совпадать с лицензионной версией
//    везде, кроме коротких мест, где в лицензии слова заглушены. Перезалитые зацензуренные
//    копии (совпадают полностью) и другие записи (не совпадают) пропускаются.

const NOT_ORIGINAL = [
  'remix', 'rmx', 'ремикс', 'slowed', 'slow', 'sped', 'speed up', 'speedup', 'nightcore', 'reverb', 'реверб',
  'cover', 'кавер', 'karaoke', 'караоке', 'instrumental', 'инструментал', 'минус', 'minus', 'live', 'лайв',
  'концерт', 'acoustic', 'акустика', 'edit', 'mashup', 'мэшап', 'bass boost', 'bass boosted', '8d', 'phonk',
  'demo', 'демо', 'radio', 'tiktok', 'tik tok', 'extended', 'перепев', 'пародия', 'parody', 'mix', 'vip',
  'bootleg', 'flip', 'rework', 'snippet', 'сниппет', 'нарезка', 'clean', 'censored', 'цензура', 'cut', 'short',
  'без мата', 'без матов', 'без мата', 'no mat', 'нет мата', 'чистая версия', 'радио версия', 'type beat', 'beat', 'бит',
];
const notOriginalRe = new RegExp(`(?<![\\p{L}\\p{N}])(${NOT_ORIGINAL.map((w) => w.replace(/ /g, '\\s*')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const EVIDENCE_RE = /(?<![\p{L}\p{N}])(uncensored|explicit|без цензуры|нецензур|18\+|original|оригинал|album version)(?![\p{L}\p{N}])/iu;

function normText(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/\((feat|ft|prod)[^)]*\)|\[(feat|ft|prod)[^\]]*\]/g, ' ')
    .replace(/\s(feat|ft)\.?\s.*$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
// название без любых приписок в скобках: «Куни (Nagasaki's.47)» → «куни»
const baseTitle = (title) => normText(String(title || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
function similar(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const uncensor = {
  enabled: localStorage.getItem('uncensor') !== '0', // включено по умолчанию
  // вердикты: ключ трека → найденная версия или { none: время }; «не найдено» перепроверяем через 3 дня
  // при смене способа проверки старые вердикты сбрасываются, ручной выбор пользователя остаётся
  memo: (() => {
    try {
      const saved = localStorage.getItem('uncensorMemo5');
      if (saved) return JSON.parse(saved);
      const old = JSON.parse(localStorage.getItem('uncensorMemo4') || '{}');
      ['uncensorMemo2', 'uncensorMemo3', 'uncensorMemo4'].forEach((k) => localStorage.removeItem(k));
      return Object.fromEntries(Object.entries(old).filter(([, v]) => v && v.manual));
    } catch { return {}; }
  })(),
  jobs: new Map(), // идущие проверки
  status: new Map(), // ход проверки по трекам — для индикатора и подробностей
  decodeCtx: null,

  get(key) {
    const v = this.memo[key];
    if (!v) return undefined;
    if (v.none) return v.manual || Date.now() - v.none < 86400e3 ? null : undefined;
    return v;
  },

  // value — найденная версия или null; alts — все проверенные копии (чтобы переключаться и потом)
  remember(key, value, alts) {
    const prev = this.memo[key];
    const keep = alts || (prev && prev.alts) || [];
    this.memo[key] = { ...(value || { none: Date.now() }), alts: keep };
    const keys = Object.keys(this.memo);
    if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach((k) => delete this.memo[k]);
    try { localStorage.setItem('uncensorMemo5', JSON.stringify(this.memo)); } catch { /* не страшно */ }
  },

  // нужно ли вообще проверять этот трек
  // отметке 18+ у лицензии не верим: ВК ставит её и зацензуренным версиям
  applies(track) {
    return this.enabled && auth.loggedIn && track && track.isLicensed && track.duration > 30;
  },

  // почему кандидат не подходит (или '' — подходит). Длительность проверяем мягко:
  // у копий она бывает указана неверно, а точный ответ всё равно даст сравнение звука.
  reject(orig, c, { strict = true } = {}) {
    if (c.key === orig.key) return 'тот же трек';
    const tags = `${c.title} ${c.subtitle} ${c.artist}`;
    const origTag = notOriginalRe.test(`${orig.title} ${orig.subtitle}`);
    if (!origTag && (notOriginalRe.test(`${c.title} ${c.subtitle}`) || /\d\s*hz\b|bass|басс/i.test(tags))) return 'ремикс / другая версия';
    const a = baseTitle(orig.title), b = baseTitle(c.title);
    if (!(b === a || b.startsWith(a + ' ') || similar(a, b) >= 0.85)) return 'другое название';
    const mainArtist = normText((orig.artists[0] && orig.artists[0].name) || orig.artist.split(/,|&/)[0]);
    const cArtist = normText(c.artist);
    if (!cArtist.includes(mainArtist) && similar(cArtist, normText(orig.artist)) < 0.8) return 'другой исполнитель';
    if (strict && this.durationOff(orig, c)) return 'другая длительность';
    return '';
  },

  // длительность: ±12 с подходит; явно неверная (в разы больше/меньше) — тоже проверяем
  durationOff(orig, c) {
    const d = Math.abs(c.duration - orig.duration);
    const broken = c.duration > orig.duration * 1.6 || c.duration < orig.duration * 0.6;
    return d > 12 && !broken;
  },

  async candidates(track, st) {
    const artist = (track.artists[0] && track.artists[0].name) || track.artist.split(/,|&/)[0];
    // несколько формулировок запроса: копии пользователи подписывают по-разному
    const base = baseTitle(track.title) || track.title;
    const queries = [...new Set([`${artist} ${base}`, `${artist} ${track.title}`, `${track.artist} ${base}`, `${base} ${artist}`, base])];
    const seen = new Map();
    for (const [i, q] of queries.entries()) {
      st.note = `Поиск копий: запрос ${i + 1} из ${queries.length}`;
      renderUncensorStatus();
      try {
        const resp = await vk('audio.search', { q, count: 200, auto_complete: 0 }, { cache: false });
        (resp.items || []).map(normTrack).forEach((t) => seen.set(t.key, t));
      } catch (err) {
        diag.add('18+', `поиск «${q}»: ${err.message}`);
      }
    }
    // приоритет: загрузки пользователей, пометки «без цензуры», та же длительность
    const score = (c) => (c.owner_id > 0 ? 3 : 0) + (EVIDENCE_RE.test(`${c.title} ${c.subtitle}`) ? 2 : 0)
      + (normText(c.title) !== normText(track.title) ? 1 : 0)
      // оригиналы без цензуры часто на секунду-другую отличаются по длительности (другой мастер)
      + (Math.abs(c.duration - track.duration) >= 1 && Math.abs(c.duration - track.duration) <= 6 ? 1.5 : 0)
      - Math.min(Math.abs(c.duration - track.duration), 30) * 0.1;
    const reasons = {};
    const ok = [];
    const pool = [];
    for (const c of seen.values()) {
      const why = this.reject(track, c);
      if (why) reasons[why] = (reasons[why] || 0) + 1; else ok.push(c);
      // для окна подробностей: все копии этой песни, даже отсеянные по длительности
      if (!this.reject(track, c, { strict: false }) || why === 'другая длительность' || why === 'ремикс / другая версия') pool.push({ track: c, why });
    }
    st.found = seen.size;
    st.reasons = reasons;
    st.pool = pool.filter((x) => x.why !== 'тот же трек').sort((x, y) => score(y.track) - score(x.track)).slice(0, 40);
    return ok.sort((a, b) => score(b) - score(a)).slice(0, 14);
  },

  // ссылка на звук версии: по ID, а если ВК не отдал (чужие загрузки) — находим её поиском заново
  async urlOf(t) {
    if (t.url) return t.url;
    try {
      const [fresh] = await vk('audio.getById', { audios: t.fullId }, { cache: false });
      if (fresh && fresh.url) return fresh.url;
    } catch { /* поищем */ }
    for (const q of [`${t.artist} ${t.title}`, t.title]) {
      try {
        const resp = await vk('audio.search', { q, count: 100, auto_complete: 0 }, { cache: false });
        const hit = (resp.items || []).find((a) => `${a.owner_id}_${a.id}` === t.key && a.url);
        if (hit) return hit.url; // в запомненную версию ссылку не пишем — она живёт недолго
      } catch { /* следующий запрос */ }
    }
    diag.add('18+', `нет ссылки на версию ${t.artist} — ${t.title}`);
    return '';
  },

  // звук трека: скачиваем, декодируем в моно 8 кГц (для сравнения волн этого достаточно)
  async samples(url, maxSeconds = 0) {
    const res = await bridge.audioData(url, maxSeconds);
    if (!res.ok) throw new Error(res.error || 'не скачался звук');
    if (!this.decodeCtx) this.decodeCtx = new OfflineAudioContext(1, 1, 8000);
    const bytes = res.data;
    const buffer = await this.decodeCtx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return monoFromBuffer(buffer);
  },

  // Полная проверка трека. Результат запоминается. force — проверить заново по просьбе пользователя.
  analyze(track, { force = false } = {}) {
    if (!force && !this.applies(track)) return Promise.resolve(null);
    if (!force && this.get(track.key) !== undefined) return Promise.resolve(this.get(track.key));
    if (this.jobs.has(track.key)) return this.jobs.get(track.key);
    const st = { state: 'search', note: 'Поиск копий', done: 0, total: 0, results: [], found: 0, reasons: {} };
    this.status.set(track.key, st);
    renderUncensorStatus();
    const finish = (state, value, note) => {
      st.state = state;
      st.note = note;
      const code = (v) => (/✓/.test(v) ? 'ok' : /та же/.test(v) ? 'same' : /другая/.test(v) ? 'diff' : '');
      const checked = st.results.filter((r) => r.track);
      const seen = new Set(checked.map((r) => r.track.key));
      const alts = [
        ...checked.map((r) => ({ t: r.track, verdict: code(r.verdict), corr: r.corr, spots: r.spots })),
        ...(st.pool || []).filter((x) => !seen.has(x.track.key) && !x.why).map((x) => ({ t: x.track, verdict: '' })),
      ].slice(0, 14).map(({ t, ...r }) => ({ key: t.key, fullId: t.fullId, title: t.title, subtitle: t.subtitle, artist: t.artist, duration: t.duration, explicit: t.explicit, ...r }));
      if (state !== 'error') this.remember(track.key, value, alts);
      if (state === 'none') setTimeout(() => { st.quiet = true; renderUncensorStatus(); }, 6000);
      diag.add('18+', `${track.artist} — ${track.title} (${fmt(track.duration)}): ${note}`, {
        found: st.found, reasons: st.reasons,
        checked: st.results.map(({ track: _t, ...r }) => r),
        others: (st.pool || []).slice(0, 15).map((x) => `${x.track.artist} — ${x.track.title} ${fmt(x.track.duration)} ${x.why || ''}`),
      });
      renderUncensorStatus();
      return value;
    };
    const job = (async () => {
      const list = await this.candidates(track, st);
      if (!list.length) return finish('none', null, `Нет подходящих копий (найдено ${st.found})`);
      st.state = 'orig';
      st.note = 'Анализ лицензионной версии';
      st.total = list.length;
      renderUncensorStatus();
      const origUrl = await this.urlOf(track);
      if (!origUrl) return finish('error', null, 'Нет доступа к звуку трека');
      let orig;
      try { orig = await this.samples(origUrl); } catch (err) { return finish('error', null, `Не удалось разобрать звук: ${err.message}`); }
      const PREVIEW_SEC = 45;
      st.state = 'check';
      // проверка одного кандидата: сначала начало трека, целиком — только если начало совпало
      const check = async (c) => {
        const row = { title: `${c.artist} — ${c.title}${c.subtitle ? ` (${c.subtitle})` : ''}`, dur: fmt(c.duration), explicit: c.explicit, verdict: '', track: c };
        st.results.push(row);
        try {
          const url = await this.urlOf(c);
          if (!url) { row.verdict = 'нет доступа'; return false; }
          // начало кандидата сравниваем с началом лицензии (+12 с на возможный сдвиг)
          const head = await this.samples(url, PREVIEW_SEC);
          const quick = compareAudio(orig.subarray(0, head.length + 12 * 8000), head);
          row.corr = Math.round(quick.corr * 100) / 100;
          if (quick.verdict === 'different') { row.verdict = 'другая запись'; return false; }
          let res = quick;
          if (quick.verdict !== 'uncensored') res = compareAudio(orig, await this.samples(url));
          row.corr = Math.round(res.corr * 100) / 100;
          row.spots = res.spots;
          row.shift = Math.round(res.lag * 10) / 10;
          if (res.speed) row.speed = Math.round((res.speed - 1) * 1000) / 10;
          row.verdict = { uncensored: 'без цензуры ✓', same: 'та же цензура', different: 'другая запись' }[res.verdict];
          return res.verdict === 'uncensored';
        } catch (err) {
          row.verdict = `ошибка: ${err.message}`;
          return false;
        } finally {
          st.done++;
          st.note = `Проверено ${st.done} из ${st.total}`;
          renderUncensorStatus();
        }
      };
      // по три кандидата параллельно, по порядку приоритета
      for (let i = 0; i < list.length; i += 3) {
        const batch = list.slice(i, i + 3);
        const results = await Promise.all(batch.map(check));
        const hit = batch.find((_, j) => results[j]);
        if (hit) return finish('found', { key: hit.key, fullId: hit.fullId, title: hit.title, artist: hit.artist }, `Найдена версия без цензуры: ${hit.artist} — ${hit.title}`);
      }
      return finish('none', null, `Версия без цензуры не найдена (проверено ${st.done})`);
    })().catch((err) => finish('error', null, `Ошибка: ${err.message}`)).finally(() => this.jobs.delete(track.key));
    this.jobs.set(track.key, job);
    return job;
  },

  // состояние для окна версий, когда проверка уже была раньше
  statusFromMemo(track) {
    const v = this.memo[track.key];
    if (!v) return null;
    const results = (v.alts || []).map((x) => ({
      track: { ...x, owner_id: Number(String(x.key).split('_')[0]), url: '', subtitle: x.subtitle || '' },
      dur: fmt(x.duration), verdict: x.verdict, corr: x.corr, spots: x.spots, explicit: x.explicit,
    }));
    const note = v.none ? (v.manual ? 'Выбрана лицензионная версия' : 'Версия без цензуры не найдена')
      : v.manual ? 'Версия выбрана вручную' : 'Найдена версия без цензуры';
    return { state: v.none ? 'none' : 'found', quiet: true, note, results, done: results.length, total: results.length, found: 0, reasons: {} };
  },

  // пользователь сам выбрал версию в окне подробностей: играем её с той же секунды и запоминаем
  async pick(track, cand) {
    const found = { key: cand.key, fullId: cand.fullId, title: cand.title, artist: cand.artist, manual: true };
    this.remember(track.key, found);
    const st = this.status.get(track.key);
    if (st) { st.state = 'found'; st.quiet = true; st.note = 'Версия выбрана вручную'; }
    if (player.current && player.current.key === track.key) await player.useSubstitute(player.current, found);
    else toast('Эта версия будет играть вместо лицензии');
    renderUncensorStatus();
    if (uncensorDetails.track) uncensorDetails.render();
  },

  // вернуть лицензионную версию
  async unpick(track) {
    this.remember(track.key, { none: Date.now(), manual: true });
    const st = this.status.get(track.key);
    if (st) { st.state = 'none'; st.quiet = true; st.note = 'Выбрана лицензионная версия'; }
    if (player.current && player.current.key === track.key && player.current.substitute) {
      player.current.substitute = null;
      renderSubstitute();
      player.attach(player.current.url, player.loadId, player.current, false, audio.currentTime);
      toast('Включена лицензионная версия');
    }
    renderUncensorStatus();
    if (uncensorDetails.track) uncensorDetails.render();
  },

  // ручная проверка из меню трека
  async recheck(track) {
    if (!auth.loggedIn) { openLogin(); return; }
    delete this.memo[track.key];
    toast('Ищем версию без цензуры…');
    const alt = await this.analyze(track, { force: true });
    if (player.current && player.current.key === track.key) player.useSubstitute(player.current, alt);
    if (!alt) toast('Версия без цензуры не найдена', { onClick: () => uncensorDetails.open(track), duration: 4000 });
  },
};

// Индикатор поиска оригинала: в нижней панели и в полноэкранном режиме
function renderUncensorStatus() {
  const t = player.current;
  const st = t && uncensor.status.get(t.key);
  const show = st && !st.quiet && (st.state === 'search' || st.state === 'orig' || st.state === 'check' || st.state === 'none' || st.state === 'error');
  for (const box of $$('.uc-status')) {
    box.hidden = !show;
    if (!show) continue;
    const busy = st.state !== 'none' && st.state !== 'error';
    box.classList.toggle('busy', busy);
    box.querySelector('.uc-text').textContent = busy ? `Ищем версию без цензуры · ${st.note}` : st.note;
    const p = st.state === 'search' ? 0.08 : st.state === 'orig' ? 0.15 : st.total ? 0.15 + 0.85 * (st.done / st.total) : 1;
    box.style.setProperty('--p', String(busy ? p : 1));
  }
  renderSubstitute();
  if (uncensorDetails.track && t && uncensorDetails.track.key === t.key) uncensorDetails.render();
}

// Подробности проверки — что нашлось и почему не подошло
const uncensorDetails = {
  track: null,
  open(track = player.current) {
    if (!track) return;
    this.track = track;
    this.close(true);
    document.body.append(el('div', { class: 'mix-settings-backdrop', id: 'uc-details', onclick: (e) => { if (e.target.id === 'uc-details') this.close(); } },
      el('div', { class: 'mix-settings uc-details', role: 'dialog' }, el('div', { id: 'uc-body' }))));
    this.render();
  },
  close(silent) { const p = $('#uc-details'); if (p) p.remove(); if (!silent) this.track = null; },
  render() {
    const body = $('#uc-body');
    if (!body || !this.track) return;
    const t = this.track;
    const st = uncensor.status.get(t.key) || uncensor.statusFromMemo(t);
    const busy = uncensor.jobs.has(t.key);
    const isCurrent = player.current && player.current.key === t.key;
    const memo = uncensor.memo[t.key];
    // какая версия выбрана сейчас: играющая подмена, иначе — запомненная, иначе — лицензия
    const activeKey = (isCurrent && player.current.substitute && player.current.substitute.key) || (memo && !memo.none && memo.key) || t.key;
    const BADGE = { ok: ['Без цензуры', 'ok'], same: ['Та же цензура', 'muted'], diff: ['Другая запись', 'muted'] };
    const code = (v) => (/✓/.test(v || '') || v === 'ok' ? 'ok' : /та же/.test(v || '') || v === 'same' ? 'same' : /другая/.test(v || '') || v === 'diff' ? 'diff' : '');
    const option = ({ key, title, sub, badge, meta, onclick }) => el('button', {
      class: 'vp-opt' + (key === activeKey ? ' active' : '') + (badge && badge[1] === 'ok' ? ' good' : ''),
      onclick,
    },
    el('span', { class: 'vp-radio' }),
    el('span', { class: 'vp-text' },
      el('span', { class: 'vp-title', text: title }),
      el('span', { class: 'vp-sub' }, sub, meta ? el('span', { class: 'vp-meta', text: meta }) : null)),
    badge ? el('span', { class: 'vp-badge ' + badge[1], text: badge[0] }) : null);

    const rows = (st ? st.results : []).filter((r) => r.track && r.track.key !== t.key);
    const order = { ok: 0, '': 1, same: 2, diff: 3 };
    rows.sort((x, y) => order[code(x.verdict)] - order[code(y.verdict)]);
    const checkedKeys = new Set(rows.map((r) => r.track.key));
    const others = st && st.pool ? st.pool.filter((x) => x.track.key !== t.key && !checkedKeys.has(x.track.key)) : [];
    const good = rows.filter((r) => code(r.verdict) === 'ok').length;
    const progress = busy && st ? (st.state === 'check' && st.total ? 0.15 + 0.85 * (st.done / st.total) : st.state === 'orig' ? 0.15 : 0.06) : 0;
    const statusText = busy ? (st ? st.note : 'Ищем…') : good ? `${good} ${plural(good, 'версия', 'версии', 'версий')} без цензуры` : st ? st.note : 'Проверка ещё не запускалась';
    const versionRow = (cand, verdict, extra) => option({
      key: cand.key,
      title: cand.title + (cand.subtitle ? ` (${cand.subtitle})` : ''),
      sub: cand.artist,
      meta: [fmt(cand.duration), extra].filter(Boolean).join(' · '),
      badge: BADGE[code(verdict)] || ['Не проверялась', 'muted'],
      onclick: () => uncensor.pick(t, cand),
    });

    body.replaceChildren(...[
      el('div', { class: 'vp-head' },
        el('img', { class: 'vp-cover', src: t.cover ? t.cover(135) || '' : '', alt: '' }),
        el('div', { class: 'vp-head-text' },
          el('div', { class: 'vp-kicker', text: 'Версии трека' }),
          el('div', { class: 'vp-name', text: t.title }),
          el('div', { class: 'vp-artist', text: `${t.artist} · ${fmt(t.duration)}` })),
        el('button', { class: 'ms-close', title: 'Закрыть', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', onclick: () => this.close() })),
      el('div', { class: 'vp-status' + (busy ? ' busy' : good ? ' good' : '') },
        el('span', { class: 'vp-dot' }),
        el('span', { text: statusText }),
        busy ? el('span', { class: 'vp-progress' }, el('i', { style: `width:${Math.round(progress * 100)}%` })) : null),
      el('div', { class: 'vp-list' },
        option({
          key: t.key, title: 'Лицензия ВКонтакте', sub: 'Версия площадки, может быть с цензурой', badge: null,
          onclick: () => uncensor.unpick(t),
        }),
        rows.map((r) => versionRow(r.track, r.verdict, r.spots ? `мест цензуры: ${r.spots}` : ''))),
      others.length ? el('details', { class: 'vp-more' },
        el('summary', { text: `Ещё копии (${others.length}) — не проверялись` }),
        el('div', { class: 'vp-list' }, others.map((x) => versionRow(x.track, '', x.why || '')))) : null,
      el('div', { class: 'vp-foot' },
        el('button', { class: 'link-btn', text: busy ? 'Идёт проверка…' : 'Искать заново', disabled: busy, onclick: () => { uncensor.recheck(t); this.render(); } }),
        el('button', { class: 'link-btn', text: 'Сохранить отчёт', onclick: () => diag.save() })),
    ].filter(Boolean));
  },
};

$('#uncensor-on').checked = uncensor.enabled;
$('#uncensor-on').addEventListener('change', () => {
  uncensor.enabled = $('#uncensor-on').checked;
  localStorage.setItem('uncensor', uncensor.enabled ? '1' : '0');
  toast(uncensor.enabled ? 'Зацензуренные треки будут подменяться оригиналом' : 'Подмена треков выключена');
});

function renderSubstitute() {
  const t = player.current;
  $('#uncensored-badge').hidden = !(t && t.substitute);
}

// --- Полноэкранный: живее ------------------------------------------------------------------

// «пульс»: обложка и подсветка дышат в такт басу
const pulse = {
  raf: 0,
  level: 0,
  data: null,
  start() {
    if (this.raf || !eq.analyser || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.data = new Uint8Array(eq.analyser.frequencyBinCount);
    const tick = () => {
      if (!sheet.open || audio.paused || document.body.classList.contains('paused')) {
        this.raf = 0;
        this.level = 0;
        $('#fs').style.setProperty('--beat', '0');
        return;
      }
      eq.analyser.getByteFrequencyData(this.data);
      let sum = 0;
      for (let i = 1; i <= 6; i++) sum += this.data[i];
      const low = sum / 6 / 255;
      const hit = Math.max(0, (low - 0.55) / 0.45);
      this.level = Math.max(hit, this.level * 0.88);
      $('#fs').style.setProperty('--beat', this.level.toFixed(3));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
};
audio.addEventListener('play', () => { eq.init(); pulse.start(); });

// лёгкий наклон обложки за курсором
$('.fs-main').addEventListener('pointermove', (e) => {
  const cover = $('#fs-cover');
  const r = cover.getBoundingClientRect();
  const x = (e.clientX - (r.left + r.width / 2)) / r.width;
  const y = (e.clientY - (r.top + r.height / 2)) / r.height;
  $('#fs').style.setProperty('--ry', `${Math.max(-1, Math.min(1, x)) * 6}deg`);
  $('#fs').style.setProperty('--rx', `${Math.max(-1, Math.min(1, -y)) * 6}deg`);
});
$('.fs-main').addEventListener('pointerleave', () => {
  $('#fs').style.setProperty('--rx', '0deg');
  $('#fs').style.setProperty('--ry', '0deg');
});

// смена трека — обложка и название «въезжают»
let lastSwapKey = null;
function animateSwap() {
  const key = player.current && player.current.key;
  if (!key || key === lastSwapKey) return;
  lastSwapKey = key;
  if (!sheet.open) return;
  for (const node of [$('#fs-cover'), $('.fs-titles')]) {
    node.classList.remove('swap');
    void node.offsetWidth;
    node.classList.add('swap');
  }
}

// режим «только плеер на весь экран»
function setImmersive(on) {
  if (on && !sheet.open) sheet.show();
  document.body.classList.toggle('immersive', on);
  bridge.window(on ? 'fullscreen' : 'exit-fullscreen');
}
$('#fs-immersive').addEventListener('click', () => setImmersive(!document.body.classList.contains('immersive')));

// --- Клавиатура ----------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea');
  if (e.key === 'F11') { e.preventDefault(); setImmersive(!document.body.classList.contains('immersive')); return; }
  if (e.key === 'Escape') {
    if ($('#uc-details')) uncensorDetails.close();
    else if ($('#mix-settings')) mixSettings.close();
    else if (document.body.classList.contains('immersive')) setImmersive(false);
    else if (!$('#eq-panel').hidden) $('#eq-panel').hidden = true;
    else if (!fs.hidden) sheet.hide();
    else if (!loginModal.hidden) closeLogin(true);
    return;
  }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowRight' && !e.altKey) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  else if (e.key === 'ArrowLeft' && !e.altKey) audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.altKey && e.key === 'ArrowLeft') router.back();
  else if (e.altKey && e.key === 'ArrowRight') router.forward();
});

// --- Окно ----------------------------------------------------------------------------------

bridge.onWindowVisible((visible) => {
  document.body.classList.toggle('paused', !visible);
  if (visible) renderProgress();
});

$$('[data-window]').forEach((btn) => btn.addEventListener('click', () => bridge.window(btn.dataset.window)));
bridge.onWindowState(({ maximized, fullscreen }) => {
  $('#window-buttons').classList.toggle('maximized', maximized);
  if (!fullscreen) document.body.classList.remove('immersive');
});

// --- Старт ---------------------------------------------------------------------------------

(async function start() {
  $('#view').replaceChildren(loadingView()); // заглушка сразу, пока ВК отвечает
  setVolume(lastVolume, false);
  renderModes();
  renderNowPlaying();
  bridge.ready();
  const state = await bridge.authState();
  auth.loggedIn = state.loggedIn;
  await refreshMe();
  library.load();
  router.go('home');
})();
