const $ = (id) => document.getElementById(id);
const api = window.vkp;

// --- Сцена: сообщаем основному процессу, куда поставить страницу ВК ---
const stage = $('stage');
function reportStage() {
  const r = stage.getBoundingClientRect();
  api.stageBounds({ x: r.left + 1, y: r.top + 1, width: r.width - 2, height: r.height - 2 });
}
new ResizeObserver(reportStage).observe(stage);
window.addEventListener('resize', reportStage);

// --- Навигация ---
function sectionFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/^\/(audio|music)/.test(u.pathname)) return null;
    if (u.searchParams.get('q')) return 'search';
    const section = u.searchParams.get('section');
    const block = u.searchParams.get('block');
    if (section === 'all') return 'my';
    if (section === 'recoms') return 'recoms';
    if (section === 'playlists') return 'playlists';
    if (block === 'chart') return 'chart';
    if (block === 'new_songs') return 'new';
    if (u.pathname === '/audio' && !section && !block) return 'home';
  } catch {}
  return null;
}

document.querySelectorAll('[data-section]').forEach((btn) => {
  btn.addEventListener('click', () => api.navigate(btn.dataset.section));
});
$('back').addEventListener('click', () => api.history('back'));
$('forward').addEventListener('click', () => api.history('forward'));
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  api.search($('search').value);
});
$('login-btn').addEventListener('click', () => api.login());
api.onFocusSearch(() => {
  $('search').focus();
  $('search').select();
});

api.onNavState((state) => {
  const section = sectionFromUrl(state.url);
  document.querySelectorAll('[data-section]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });
  if (section === 'search') $('search').value = new URL(state.url).searchParams.get('q') || '';
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  $('spinner').classList.toggle('on', state.loading);
  if (!state.loading) $('stage-loading').hidden = true;
});

api.onAuthState(({ loggedIn }) => {
  $('login-btn').hidden = loggedIn;
});

// --- Плеер ---
const player = $('player');
const seek = $('seek');
const volume = $('volume');
let track = null; // последнее состояние от страницы
let syncedAt = 0; // когда пришло
let seeking = false;
let volumeTouched = 0;

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const setFill = (input) => {
  const p = (input.value - input.min) / (input.max - input.min || 1) * 100;
  input.style.setProperty('--p', `${p}%`);
};

document.querySelectorAll('[data-media]').forEach((btn) => {
  btn.addEventListener('click', () => api.media(btn.dataset.media));
});

seek.addEventListener('input', () => {
  seeking = true;
  setFill(seek);
  if (track && track.duration) $('pos').textContent = fmt((seek.value / 1000) * track.duration);
});
seek.addEventListener('change', () => {
  if (track && track.duration) {
    const t = (seek.value / 1000) * track.duration;
    api.media('seek', t);
    track.position = t;
    syncedAt = performance.now();
  }
  seeking = false;
});

let lastVolume = 1;
volume.addEventListener('input', () => {
  volumeTouched = performance.now();
  setFill(volume);
  const v = volume.value / 100;
  if (v > 0) lastVolume = v;
  $('mute').parentElement.classList.toggle('muted', v === 0);
  api.media('volume', v);
});
$('mute').addEventListener('click', () => {
  volume.value = volume.value > 0 ? 0 : Math.round(lastVolume * 100) || 70;
  volume.dispatchEvent(new Event('input'));
});

// Фон из обложки: плавная смена двух слоёв
let ambientUrl = '';
let ambientFront = 'ambient-a';
function setAmbient(url) {
  if (url === ambientUrl) return;
  ambientUrl = url;
  document.body.classList.toggle('has-art', Boolean(url));
  const back = ambientFront === 'ambient-a' ? 'ambient-b' : 'ambient-a';
  if (!url) {
    $(ambientFront).classList.remove('on');
    $(back).classList.remove('on');
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (ambientUrl !== url) return;
    $(back).style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
    $(back).classList.add('on');
    $(ambientFront).classList.remove('on');
    ambientFront = back;
  };
  img.src = url;
}

api.onNowPlaying((info) => {
  track = info ? { ...info } : null;
  syncedAt = performance.now();
  player.classList.toggle('idle', !info);
  player.classList.toggle('playing', Boolean(info && info.playing));
  $('now-title').textContent = info ? info.title : 'Ничего не играет';
  $('now-artist').textContent = info ? info.artist || '' : 'Выберите трек';
  $('now-title').title = $('now-title').textContent;
  $('now-artist').title = $('now-artist').textContent;

  const img = $('cover-img');
  if (info && info.artwork) {
    if (img.getAttribute('src') !== info.artwork) img.src = info.artwork;
    $('cover').classList.add('has-art');
  } else {
    $('cover').classList.remove('has-art');
    img.removeAttribute('src');
  }
  setAmbient(info && info.artwork ? info.artwork : '');

  seek.disabled = !(info && info.canSeek && info.duration);
  // громкость берём со страницы, если пользователь только что её не крутил
  if (info && performance.now() - volumeTouched > 1500) {
    volume.value = Math.round((info.volume ?? 1) * 100);
    setFill(volume);
    $('mute').parentElement.classList.toggle('muted', Number(volume.value) === 0);
  }
  renderProgress();
});

// Плавный ход прогресса между обновлениями от страницы
function renderProgress() {
  if (!track || !track.duration) {
    if (!seeking) {
      seek.value = 0;
      setFill(seek);
    }
    $('pos').textContent = fmt(0);
    $('dur').textContent = fmt(track ? track.duration : 0);
    return;
  }
  let pos = track.position;
  if (track.playing) pos += (performance.now() - syncedAt) / 1000;
  pos = Math.min(pos, track.duration);
  $('dur').textContent = fmt(track.duration);
  if (!seeking) {
    seek.value = Math.round((pos / track.duration) * 1000);
    setFill(seek);
    $('pos').textContent = fmt(pos);
  }
}
setInterval(renderProgress, 250);

// Кнопки окна
document.querySelectorAll('[data-window]').forEach((btn) => {
  btn.addEventListener('click', () => api.window(btn.dataset.window));
});
api.onWindowState(({ maximized }) => {
  $('window-buttons').classList.toggle('maximized', maximized);
});

setFill(seek);
setFill(volume);
reportStage();
api.ready();
