// Мост между интерфейсом и основным процессом
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vkp', {
  platform: process.platform,
  api: (method, params, options) => ipcRenderer.invoke('api', method, params, options),
  authState: () => ipcRenderer.invoke('auth-state'),
  login: (rect) => ipcRenderer.send('login', rect),
  loginBounds: (rect) => ipcRenderer.send('login-bounds', rect),
  loginCancel: () => ipcRenderer.send('login-cancel'),
  logout: () => ipcRenderer.send('logout'),
  window: (action) => ipcRenderer.send('window', action),
  download: (info) => ipcRenderer.invoke('download', info),
  showFile: (file) => ipcRenderer.send('show-file', file),
  audioData: (url, maxSeconds) => ipcRenderer.invoke('audio-data', url, maxSeconds),
  geniusLyrics: (info) => ipcRenderer.invoke('genius-lyrics', info),
  lrclibLyrics: (info) => ipcRenderer.invoke('lrclib-lyrics', info),
  saveReport: (text) => ipcRenderer.invoke('save-report', text),
  geniusOpen: (info) => ipcRenderer.invoke('genius-open', info),
  onDownloadProgress: (fn) => ipcRenderer.on('download-progress', (_e, data) => fn(data)),
  trackTitle: (title) => ipcRenderer.send('track-title', title),
  ready: () => ipcRenderer.send('shell-ready'),
  onAuthChanged: (fn) => ipcRenderer.on('auth-changed', (_e, state) => fn(state)),
  onLoginClosed: (fn) => ipcRenderer.on('login-closed', () => fn()),
  onWindowState: (fn) => ipcRenderer.on('window-state', (_e, state) => fn(state)),
  onMedia: (fn) => ipcRenderer.on('media', (_e, action) => fn(action)),
  onWindowVisible: (fn) => ipcRenderer.on('window-visible', (_e, visible) => fn(visible)),
  onFocusSearch: (fn) => ipcRenderer.on('focus-search', () => fn()),
});
