// Мост между оболочкой и основным процессом
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vkp', {
  platform: process.platform,
  navigate: (section) => ipcRenderer.send('navigate', section),
  search: (query) => ipcRenderer.send('search', query),
  login: () => ipcRenderer.send('login'),
  logout: () => ipcRenderer.send('logout'),
  history: (direction) => ipcRenderer.send('history', direction),
  media: (action, value) => ipcRenderer.send('media', action, value),
  window: (action) => ipcRenderer.send('window', action),
  onWindowState: (fn) => ipcRenderer.on('window-state', (_e, state) => fn(state)),
  stageBounds: (rect) => ipcRenderer.send('stage-bounds', rect),
  ready: () => ipcRenderer.send('shell-ready'),
  onNavState: (fn) => ipcRenderer.on('nav-state', (_e, state) => fn(state)),
  onNowPlaying: (fn) => ipcRenderer.on('now-playing', (_e, info) => fn(info)),
  onAuthState: (fn) => ipcRenderer.on('auth-state', (_e, state) => fn(state)),
  onFocusSearch: (fn) => ipcRenderer.on('focus-search', () => fn()),
});
