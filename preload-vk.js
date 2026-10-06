// Выполняется на странице ВК до её собственных скриптов.
// Запоминаем обработчики Media Session, которые ставит плеер ВК (те же, что срабатывают
// от медиаклавиш), чтобы левая панель могла показывать трек и управлять воспроизведением.
const { contextBridge, webFrame } = require('electron');

function hookMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms || window.__vkpAction) return;
  const handlers = {};
  const original = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (action, handler) => {
    if (handler) handlers[action] = handler;
    else delete handlers[action];
    return original(action, handler);
  };
  const media = () => [...document.querySelectorAll('audio, video')];
  const isPlaying = () => {
    if (ms.playbackState === 'playing') return true;
    if (ms.playbackState === 'paused') return false;
    return media().some((m) => !m.paused);
  };
  Object.defineProperty(window, '__vkpAction', {
    value: (action) => {
      if (action === 'toggle') action = isPlaying() ? 'pause' : 'play';
      if (handlers[action]) {
        handlers[action]({ action });
        return true;
      }
      const el = media()[0];
      if (el && action === 'play') el.play();
      else if (el && action === 'pause') el.pause();
      return Boolean(el);
    },
  });
  Object.defineProperty(window, '__vkpNowPlaying', {
    value: () => {
      const m = ms.metadata;
      if (!m || !m.title) return null;
      const art = Array.from(m.artwork || []);
      return {
        title: m.title,
        artist: m.artist,
        artwork: art.length ? art[art.length - 1].src : '',
        playing: isPlaying(),
        actions: Object.keys(handlers),
      };
    },
  });
}

if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({ func: hookMediaSession });
} else {
  webFrame.executeJavaScript(`(${hookMediaSession.toString()})()`);
}
