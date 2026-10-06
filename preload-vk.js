// Выполняется на странице ВК до её собственных скриптов (в основном мире страницы).
//  - запоминает обработчики Media Session плеера ВК (те же, что у медиаклавиш), чтобы наша
//    панель могла показывать трек, перематывать и переключать;
//  - сам переключает на следующий трек, если плеер ВК встал на паузу в конце трека;
//  - говорит странице, что она всегда видима (в свёрнутом окне плеер не засыпает);
//  - прячет всплывающий список чатов.
const { contextBridge, webFrame } = require('electron');

function inject() {
  if (window.__vkpAction) return;
  const ms = navigator.mediaSession;
  const handlers = {};
  if (ms) {
    const original = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => {
      if (handler) handlers[action] = handler;
      else delete handlers[action];
      return original(action, handler);
    };
  }

  // --- Все аудио/видео-элементы плеера, даже те, что не вставлены в страницу ---
  const elements = new Set();
  let current = null;
  let desiredVolume = null;
  const register = (el) => {
    if (!(el instanceof HTMLMediaElement)) return;
    current = el;
    if (elements.has(el)) return;
    elements.add(el);
    el.addEventListener('ended', () => scheduleAdvance(el));
  };
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    register(this);
    if (desiredVolume !== null) this.volume = desiredVolume;
    return originalPlay.apply(this, args);
  };
  document.addEventListener('play', (e) => register(e.target), true);
  const allMedia = () => [...new Set([...elements, ...document.querySelectorAll('audio, video')])];
  const anyPlaying = () => allMedia().some((m) => !m.paused && !m.ended);

  // --- Автопереход к следующему треку ---
  let advanceTimer = null;
  function scheduleAdvance(el) {
    clearTimeout(advanceTimer);
    // Даём плееру ВК 1,5 секунды переключиться самому; если он стоит — жмём «следующий»
    advanceTimer = setTimeout(() => {
      if (anyPlaying() || el !== current) return;
      if (handlers.nexttrack) handlers.nexttrack({ action: 'nexttrack' });
    }, 1500);
  }
  const wasPlaying = new WeakMap();
  setInterval(() => {
    for (const el of allMedia()) {
      const playing = !el.paused && !el.ended;
      const nearEnd = el.duration > 0 && isFinite(el.duration) && el.currentTime >= el.duration - 1.2;
      if (wasPlaying.get(el) && !playing && nearEnd) scheduleAdvance(el);
      wasPlaying.set(el, playing);
    }
  }, 500);

  // --- Страница всегда «видима» ---
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(Document.prototype, 'webkitHidden', { get: () => false, configurable: true });
    window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {}

  // --- Прячем чаты: всплывающие (fixed) блоки со ссылками на диалоги ---
  const CHAT_SELECTOR = 'a[href^="/im"], a[href*="vk.com/im"], a[href*="vk.ru/im"], [aria-label*="список чатов" i], [aria-label*="chat list" i]';
  function hideChats() {
    for (const node of document.querySelectorAll(CHAT_SELECTOR)) {
      for (let el = node; el && el !== document.body; el = el.parentElement) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed') {
          if (el.id !== 'page_header_cont') el.style.setProperty('display', 'none', 'important');
          break;
        }
      }
    }
  }
  let hideQueued = false;
  new MutationObserver(() => {
    if (hideQueued) return;
    hideQueued = true;
    setTimeout(() => { hideQueued = false; hideChats(); }, 300);
  }).observe(document, { childList: true, subtree: true });

  // --- Только плеер: клики по ссылкам на немузыкальные страницы ВК не срабатывают ---
  const MUSIC_PATH = /^\/(audio|audios|music|artist|audio_playlist)/i;
  const AUTH_PATH = /^\/(login|join|restore|challenge|authorize|auth|qr_auth)/i;
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a) return;
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch { return; }
    if (u.protocol === 'javascript:' || (u.origin === location.origin && u.pathname === location.pathname && u.hash)) return;
    const vkSite = /(^|\.)vk\.(com|ru)$/i.test(u.hostname) && !/^(id|oauth|login)\./i.test(u.hostname);
    const allowed = vkSite ? MUSIC_PATH.test(u.pathname) || AUTH_PATH.test(u.pathname) : /^(id|oauth|login)\.vk\./i.test(u.hostname);
    if (!allowed) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // --- API для нашей панели ---
  const isPlaying = () => {
    if (ms && ms.playbackState === 'playing') return true;
    if (ms && ms.playbackState === 'paused') return false;
    return anyPlaying();
  };
  Object.defineProperty(window, '__vkpAction', {
    value: (action, value) => {
      const el = current || allMedia()[0];
      if (action === 'toggle') action = isPlaying() ? 'pause' : 'play';
      if (action === 'seek') {
        if (handlers.seekto) handlers.seekto({ action: 'seekto', seekTime: value });
        else if (el) el.currentTime = value;
        return true;
      }
      if (action === 'volume') {
        desiredVolume = Math.max(0, Math.min(1, value));
        allMedia().forEach((m) => { m.volume = desiredVolume; });
        return true;
      }
      if (handlers[action]) {
        handlers[action]({ action });
        return true;
      }
      if (el && action === 'play') el.play();
      else if (el && action === 'pause') el.pause();
      return Boolean(el);
    },
  });
  Object.defineProperty(window, '__vkpNowPlaying', {
    value: () => {
      const m = ms && ms.metadata;
      if (!m || !m.title) return null;
      const art = Array.from(m.artwork || []);
      const el = current;
      const duration = el && isFinite(el.duration) ? el.duration : 0;
      return {
        title: m.title,
        artist: m.artist,
        artwork: art.length ? art[art.length - 1].src : '',
        playing: isPlaying(),
        position: el ? el.currentTime : 0,
        duration,
        volume: desiredVolume !== null ? desiredVolume : el ? el.volume : 1,
        canSeek: Boolean(handlers.seekto || el),
      };
    },
  });
}

if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({ func: inject });
} else {
  webFrame.executeJavaScript(`(${inject.toString()})()`);
}
