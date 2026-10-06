// Мост между интерфейсом и основным процессом
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vkp', {
  platform: process.platform,
  api: (method, params) => ipcRenderer.invoke('api', method, params),
  authState: () => ipcRenderer.invoke('auth-state'),
  login: (rect) => ipcRenderer.send('login', rect),
  loginBounds: (rect) => ipcRenderer.send('login-bounds', rect),
  loginCancel: () => ipcRenderer.send('login-cancel'),
  logout: () => ipcRenderer.send('logout'),
  window: (action) => ipcRenderer.send('window', action),
  trackTitle: (title) => ipcRenderer.send('track-title', title),
  ready: () => ipcRenderer.send('shell-ready'),
  onAuthChanged: (fn) => ipcRenderer.on('auth-changed', (_e, state) => fn(state)),
  onLoginClosed: (fn) => ipcRenderer.on('login-closed', () => fn()),
  onWindowState: (fn) => ipcRenderer.on('window-state', (_e, state) => fn(state)),
  onMedia: (fn) => ipcRenderer.on('media', (_e, action) => fn(action)),
  onFocusSearch: (fn) => ipcRenderer.on('focus-search', () => fn()),
});
