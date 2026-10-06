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
    isLicensed: Boolean(a.is_licensed) || a.owner_id < 0,
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
    thumb,
    cover: (size) => pickPhoto(thumb, size),
  };
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

function trackRow(track, list, index, { number = false } = {}) {
  const row = el('div', {
    class: 'row' + (player.current && player.current.key === track.key ? ' playing' : ''),
    dataset: { key: track.key },
    title: `${track.artist} — ${track.title}`,
    onclick: () => player.playList(list, index),
  },
  number ? el('div', { class: 'row-num', text: String(index + 1) }) : null,
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

function trackGrid(tracks) {
  return el('div', { class: 'track-grid' }, tracks.map((t, i) => trackRow(t, tracks, i)));
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
    el('div', { class: 'card-sub', text: p.sub }));
}

function sectionHead(title, action) {
  return el('div', { class: 'section-head' },
    el('h2', { class: 'section-title', text: title || '' }),
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
        : trackGrid(block.tracks.slice(0, 12));
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
      el('div', { class: 'mix-sub', text: auth.loggedIn ? 'Бесконечный поток музыки под ваш вкус' : 'Войдите, чтобы слушать микс под ваш вкус' })),
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

async function viewHome() {
  const data = parseCatalog(await vk('catalog.getAudio', { url: 'https://vk.ru/audio', need_blocks: 1 }));
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
  // «Слушать всё» — сначала догружаем весь список
  const all = async () => { while (offset < total) { const before = offset; await more(); if (offset === before) break; } return tracks; };
  return [pageHead('Медиатека', 'Моя музыка', tracksWord(total), playButtons(all)), list];
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
  chart: () => viewPublicList('https://vk.ru/audio?block=chart', 'Открыть новое', 'Чарт VK Музыки'),
  new: () => viewPublicList('https://vk.ru/audio?block=new_songs', 'Открыть новое', 'Новинки'),
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
    try {
      const resp = await vk('audio.getStreamMixAudios', { mix_id: 'common', count: 10, append: append ? 1 : 0 }, { cache: false });
      return (Array.isArray(resp) ? resp : resp.items || []).map(normTrack);
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
    if (uncensor.applies(track) && track.key in uncensor.memo && uncensor.memo[track.key]) {
      const alt = uncensor.memo[track.key];
      const altUrl = await uncensor.urlOf(alt);
      if (id !== this.loadId) return;
      if (altUrl) { track.substitute = { ...alt, url: altUrl }; playUrl = altUrl; }
    } else if (uncensor.applies(track)) {
      uncensor.analyze(track).then(async (alt) => {
        if (!alt || id !== this.loadId) return;
        const altUrl = await uncensor.urlOf(alt);
        if (!altUrl || id !== this.loadId) return;
        track.substitute = { ...alt, url: altUrl };
        renderSubstitute();
        this.attach(altUrl, id, track, false, audio.currentTime);
        toast('Включена версия без цензуры');
      });
    }
    renderSubstitute();
    if (!playUrl) {
      toast(auth.loggedIn ? 'Трек недоступен' : 'Полная версия — после входа');
      return this.skipBroken();
    }
    this.attach(playUrl, id, track);
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

audio.addEventListener('playing', () => {
  player.skips = 0;
  prepareNext();
});

// Пока играет трек, тихо получаем ссылку на следующий — переход будет без паузы
let preparedKey = null;
async function prepareNext() {
  const nextPos = player.pos + 1 < player.order.length ? player.pos + 1 : (player.repeat === 'all' ? 0 : -1);
  const next = nextPos >= 0 ? player.queue[player.order[nextPos]] : null;
  if (next && uncensor.applies(next) && !(next.key in uncensor.memo)) uncensor.analyze(next);
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
    // у ВК текста нет — ищем на Genius
    if (!parsed && player.current && player.current.key === t.key) {
      lyricsBox.replaceChildren(el('div', { class: 'lyric-empty', text: 'Ищем текст на Genius…' }));
      const genius = await bridge.geniusLyrics({ artist: t.artist, title: t.title }).catch(() => null);
      if (genius && genius.lines && genius.lines.length) {
        parsed = { synced: false, lines: genius.lines.map((text) => ({ time: 0, text })), source: 'Genius' };
      }
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
        class: 'lyric', text: line.text || '♪',
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
    fsModes.set(fsModes.current);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.set(0); this.cover(true); return; }
    // появляется оттуда, где была нижняя панель
    this.set(window.innerHeight);
    this.springTo(0, { velocity: 0, damping: 1, response: 0.42 }, () => this.cover(true));
  },

  hide(velocity = 0) {
    this.open = false;
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
    this.loaded = false;
    if (!auth.loggedIn || !auth.me) return renderAddState();
    // список «Моих аудио» нужен только чтобы знать, что уже добавлено — грузим порциями в фоне
    try {
      let offset = 0;
      for (let guard = 0; guard < 60; guard++) {
        const resp = await vk('audio.get', { owner_id: auth.me.id, count: MY_PAGE, offset });
        const items = resp.items || [];
        items.forEach((a) => this.keys.add(`${a.owner_id}_${a.id}`));
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
    $('#eq-btn').classList.toggle('on', this.enabled);
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

$('#eq-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('#eq-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) eq.render();
});
$('#eq-on').addEventListener('change', () => {
  eq.enabled = $('#eq-on').checked;
  eq.save();
  eq.apply();
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#eq-panel, #eq-btn')) $('#eq-panel').hidden = true;
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
  memo: JSON.parse(localStorage.getItem('uncensorMemo2') || '{}'), // вердикты: ключ трека → версия или null
  jobs: new Map(), // идущие проверки
  decodeCtx: null,

  remember(key, value) {
    this.memo[key] = value;
    const keys = Object.keys(this.memo);
    if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach((k) => delete this.memo[k]);
    localStorage.setItem('uncensorMemo2', JSON.stringify(this.memo));
  },

  // нужно ли вообще проверять этот трек
  applies(track) {
    return this.enabled && auth.loggedIn && track && !track.explicit && track.isLicensed && track.duration > 30;
  },

  isCandidate(orig, c) {
    if (c.key === orig.key) return false;
    const origTag = notOriginalRe.test(`${orig.title} ${orig.subtitle}`);
    if (!origTag && notOriginalRe.test(`${c.title} ${c.subtitle}`)) return false;
    if (Math.abs(c.duration - orig.duration) > 4) return false;
    const a = baseTitle(orig.title), b = baseTitle(c.title);
    if (!(b === a || b.startsWith(a + ' ') || similar(a, b) >= 0.85)) return false;
    const mainArtist = normText((orig.artists[0] && orig.artists[0].name) || orig.artist.split(/,|&/)[0]);
    const cArtist = normText(c.artist);
    if (!cArtist.includes(mainArtist) && similar(cArtist, normText(orig.artist)) < 0.8) return false;
    // другая лицензионная версия без отметки 18+ — почти наверняка та же цензура
    if (c.owner_id < 0 && !c.explicit) return false;
    return true;
  },

  async candidates(track) {
    const artist = (track.artists[0] && track.artists[0].name) || track.artist.split(/,|&/)[0];
    const queries = [`${artist} ${baseTitle(track.title) || track.title}`, `${artist} ${track.title}`];
    const seen = new Map();
    for (const q of [...new Set(queries)]) {
      try {
        const resp = await vk('audio.search', { q, count: 60, auto_complete: 0 }, { cache: false });
        (resp.items || []).map(normTrack).forEach((t) => seen.set(t.key, t));
      } catch {
        /* следующий запрос */
      }
    }
    const score = (c) => (c.explicit ? 4 : 0) + (EVIDENCE_RE.test(`${c.title} ${c.subtitle}`) ? 2 : 0)
      + (normText(c.title) !== normText(track.title) ? 1 : 0) - Math.abs(c.duration - track.duration) * 0.1;
    return [...seen.values()].filter((c) => this.isCandidate(track, c)).sort((a, b) => score(b) - score(a)).slice(0, 3);
  },

  async urlOf(t) {
    if (t.url) return t.url;
    try {
      const [fresh] = await vk('audio.getById', { audios: t.fullId }, { cache: false });
      return (fresh && fresh.url) || '';
    } catch {
      return '';
    }
  },

  // карта громкости трека: скачиваем звук, декодируем в 8 кГц (экономно) и считаем уровни
  async envelope(url) {
    const res = await bridge.audioData(url);
    if (!res.ok) throw new Error(res.error);
    if (!this.decodeCtx) this.decodeCtx = new OfflineAudioContext(1, 1, 8000);
    const bytes = res.data;
    const buffer = await this.decodeCtx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return envelopeFromBuffer(buffer);
  },

  // Полная проверка трека. Результат запоминается.
  analyze(track) {
    if (!this.applies(track)) return Promise.resolve(null);
    if (track.key in this.memo) return Promise.resolve(this.memo[track.key]);
    if (this.jobs.has(track.key)) return this.jobs.get(track.key);
    const job = (async () => {
      const list = await this.candidates(track);
      if (!list.length) { this.remember(track.key, null); return null; }
      const origUrl = await this.urlOf(track);
      if (!origUrl) return null;
      const origEnv = await this.envelope(origUrl);
      for (const c of list) {
        const url = await this.urlOf(c);
        if (!url) continue;
        let env;
        try {
          env = await this.envelope(url);
        } catch {
          continue;
        }
        const result = compareEnvelopes(origEnv, env);
        if (result.verdict === 'uncensored') {
          const found = { key: c.key, fullId: c.fullId, title: c.title, artist: c.artist };
          this.remember(track.key, found);
          return found;
        }
      }
      this.remember(track.key, null);
      return null;
    })().catch(() => null).finally(() => this.jobs.delete(track.key));
    this.jobs.set(track.key, job);
    return job;
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
    if (document.body.classList.contains('immersive')) setImmersive(false);
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
