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
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// --- API ВКонтакте -------------------------------------------------------------------------

// Ответы на «читающие» запросы кэшируем ненадолго: назад/вперёд и повторные открытия — мгновенно
const CACHEABLE = /^(catalog\.|audio\.(get|getPlaylists|getPlaylistById|getRecommendations|search)$|users\.get$)/;
const apiCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

async function vk(method, params = {}, { cache = CACHEABLE.test(method) } = {}) {
  const key = cache ? method + JSON.stringify(params) : null;
  if (key) {
    const hit = apiCache.get(key);
    if (hit && Date.now() - hit.time < CACHE_TTL) return hit.promise;
  }
  const promise = bridge.api(method, params).then((res) => {
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
    key: `${a.owner_id}_${a.id}`,
    fullId: `${a.owner_id}_${a.id}${a.access_key ? '_' + a.access_key : ''}`,
    title: a.title || '',
    subtitle: a.subtitle || '',
    artist: a.artist || '',
    artists: (a.main_artists || []).map((x) => x.name),
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
function parseCatalog(resp) {
  const audios = new Map((resp.audios || []).map((a) => [`${a.owner_id}_${a.id}`, a]));
  const playlists = new Map((resp.playlists || []).map((p) => [`${p.owner_id}_${p.id}`, p]));
  const catalog = resp.catalog;
  const section = resp.section
    || (catalog && (catalog.sections.find((s) => s.id === catalog.default_section) || catalog.sections[0]))
    || { blocks: [] };
  const blocks = [];
  let header = null;
  const idOf = (raw) => String(raw).split('_').slice(0, 2).join('_');
  for (const b of section.blocks || []) {
    const layout = (b.layout && b.layout.name) || '';
    if (layout === 'header') {
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
    }
    header = null;
  }
  return { title: section.title || '', id: section.id, blocks, nextFrom: section.next_from };
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
    el('div', { class: 'row-artist', text: track.artist })),
  el('div', { class: 'row-dur', text: fmt(track.duration) }));
  return row;
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
    action ? el('button', { class: 'more', text: 'Все', onclick: () => router.go('section', { id: action.section_id, title }) }) : null);
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
        : trackGrid(block.tracks.slice(0, 9));
      frag.append(el('section', { class: 'section' }, sectionHead(block.title, block.action), list));
    } else if (block.kind === 'playlists') {
      frag.append(el('section', { class: 'section' }, sectionHead(block.title, block.action),
        el('div', { class: 'card-row' }, block.items.map(playlistCard))));
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

function pagedTrackList(tracks, sectionId, nextFrom) {
  const list = trackList(tracks);
  const more = async (from) => {
    if (!from || !sectionId) return;
    try {
      const resp = await vk('catalog.getSection', { section_id: sectionId, start_from: from });
      const parsed = parseCatalog(resp);
      const extra = parsed.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks);
      const seen = new Set(tracks.map((t) => t.key));
      const fresh = extra.filter((t) => !seen.has(t.key));
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

async function viewHome() {
  const data = parseCatalog(await vk('catalog.getAudio', { url: 'https://vk.ru/audio', need_blocks: 1 }));
  const allTracks = data.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks);
  return [
    pageHead('Обзор', auth.me ? `Привет, ${auth.me.first_name}` : 'Музыка для вас', 'Подборки, новинки и чарты', playButtons(() => allTracks)),
    renderBlocks(data.blocks, { limit: 8 }),
  ];
}

async function viewCatalogList(url, eyebrow, title) {
  const data = parseCatalog(await vk('catalog.getAudio', { url, need_blocks: 1 }));
  const block = data.blocks.find((b) => b.kind === 'tracks');
  if (!block) return [pageHead(eyebrow, title), renderBlocks(data.blocks)];
  const tracks = block.tracks;
  return [
    pageHead(eyebrow, title, tracksWord(tracks.length) + (block.nextFrom ? '+' : ''), playButtons(() => tracks)),
    pagedTrackList(tracks, data.id, block.nextFrom || data.nextFrom),
  ];
}

async function viewSection({ id, title }) {
  const data = parseCatalog(await vk('catalog.getSection', { section_id: id }));
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

async function viewMy() {
  if (!auth.loggedIn) return loginPrompt('Моя музыка');
  const uid = auth.me && auth.me.id;
  let tracks = [];
  try {
    const resp = await vk('audio.get', { owner_id: uid, count: 2000 });
    tracks = (resp.items || []).map(normTrack);
  } catch {
    const data = parseCatalog(await vk('catalog.getAudio', { url: `https://vk.ru/audios${uid}`, need_blocks: 1 }));
    tracks = data.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks);
  }
  if (!tracks.length) return [pageHead('Медиатека', 'Моя музыка'), el('div', { class: 'state' }, el('div', { class: 'state-title', text: 'Здесь пока пусто' }), 'Добавляйте треки во ВКонтакте — они появятся тут.')];
  return [pageHead('Медиатека', 'Моя музыка', tracksWord(tracks.length), playButtons(() => tracks)), trackList(tracks)];
}

async function viewRecs() {
  if (!auth.loggedIn) return loginPrompt('Для вас');
  try {
    const data = parseCatalog(await vk('catalog.getAudio', { url: 'https://vk.ru/audio?section=recoms', need_blocks: 1 }));
    if (data.blocks.length) {
      const all = data.blocks.filter((b) => b.kind === 'tracks').flatMap((b) => b.tracks);
      return [pageHead('Подобрано алгоритмами', 'Для вас', null, all.length ? playButtons(() => all) : []), renderBlocks(data.blocks)];
    }
  } catch {
    /* попробуем другой способ */
  }
  const resp = await vk('audio.getRecommendations', { count: 100 });
  const tracks = (resp.items || []).map(normTrack);
  return [pageHead('Подобрано алгоритмами', 'Для вас', tracksWord(tracks.length), playButtons(() => tracks)), trackList(tracks)];
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
  const head = pageHead('Поиск', `«${query}»`);
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
  chart: () => viewCatalogList('https://vk.ru/audio?block=chart', 'Открыть новое', 'Чарт'),
  new: () => viewCatalogList('https://vk.ru/audio?block=new_songs', 'Открыть новое', 'Новинки'),
  section: viewSection,
  playlist: viewPlaylist,
  search: viewSearch,
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
  let items = suggestCache.get(q.toLowerCase());
  if (!items) {
    try {
      const resp = await vk('audio.search', { q, count: 7, auto_complete: 1 });
      items = (resp.items || []).map(normTrack);
      suggestCache.set(q.toLowerCase(), items);
      if (suggestCache.size > 100) suggestCache.delete(suggestCache.keys().next().value);
    } catch {
      items = []; // покажем хотя бы строку поиска
    }
  }
  if (token !== suggestToken) return;
  const artists = [...new Set(items.flatMap((t) => t.artists.length ? t.artists : [t.artist]).filter(Boolean))]
    .filter((name) => name.toLowerCase().includes(q.toLowerCase().split(' ')[0])).slice(0, 3);
  const nodes = [
    el('button', { class: 'suggest-item', onclick: () => runSearch(q) },
      el('span', { class: 's-icon', html: ICON.search }),
      el('span', { class: 's-text' }, el('div', { class: 's-title', text: `Искать «${q}»` }), el('div', { class: 's-sub', text: 'Все треки, альбомы и плейлисты' }))),
  ];
  if (artists.length) {
    nodes.push(el('div', { class: 'suggest-head', text: 'Артисты' }));
    artists.forEach((name) => nodes.push(el('button', { class: 'suggest-item', onclick: () => { searchInput.value = name; runSearch(name); } },
      el('span', { class: 's-icon', html: ICON.user }),
      el('span', { class: 's-text' }, el('div', { class: 's-title', text: name }), el('div', { class: 's-sub', text: 'Артист' })))));
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

  playList(tracks, index, { shuffle } = {}) {
    if (!tracks || !tracks.length) return;
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
    if (!track.url) {
      toast(auth.loggedIn ? 'Трек недоступен' : 'Полная версия — после входа');
      return this.skipBroken();
    }
    this.attach(track.url, id, track);
  },

  attach(url, id, track, retried = false) {
    this.destroyHls();
    if (/\.m3u8/.test(url) && window.Hls && Hls.isSupported()) {
      const hls = new Hls({
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
    }
    audio.play().catch(() => {});
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
  $('#bar-artist').textContent = t ? t.artist : 'Выберите трек';
  const small = t ? t.cover(135) : '';
  const big = t ? t.cover(1200) || t.cover(600) : '';
  const barImg = $('#bar-cover img');
  if (small) barImg.src = small; else barImg.removeAttribute('src');
  const fsImg = $('#fs-cover img');
  if (big) fsImg.src = big; else fsImg.removeAttribute('src');
  $('#fs-title').textContent = t ? t.title : '';
  $('#fs-artist').textContent = t ? t.artist : '';
  const tiny = t ? t.cover(68) : '';
  setAmbient(tiny);
  $('#fs-glow').style.backgroundImage = tiny ? `url("${tiny.replace(/"/g, '%22')}")` : 'none';
  bridge.trackTitle(t ? `${t.artist} — ${t.title}` : '');
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
    renderQueue();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.set(0); this.cover(true); return; }
    // появляется оттуда, где была нижняя панель
    this.set(window.innerHeight);
    this.springTo(0, { velocity: 0, damping: 1, response: 0.42 }, () => this.cover(true));
  },

  hide(velocity = 0) {
    this.open = false;
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

$('#bar-track').addEventListener('click', () => sheet.show());
$('#expand').addEventListener('click', () => sheet.show());
$('#fs-close').addEventListener('click', () => sheet.hide());

// --- Клавиатура ----------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea');
  if (e.key === 'Escape') {
    if (!fs.hidden) sheet.hide();
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
bridge.onWindowState(({ maximized }) => $('#window-buttons').classList.toggle('maximized', maximized));

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
  router.go('home');
})();
