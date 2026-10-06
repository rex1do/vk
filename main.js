// VK Player — десктопный плеер ВК Музыки со своим интерфейсом.
//
// Как устроено:
//  - интерфейс и плеер целиком наши (shell/), ничего от вёрстки ВК;
//  - данные (треки, подборки, поиск) берутся через API веб-версии ВК (web.api.vk.ru,
//    клиент vk.com). Запросы выполняются внутри невидимой официальной страницы vk.com,
//    с её же токеном — для ВК это ровно те же запросы, что делает сам сайт;
//  - вход — на официальной странице ВК, которая показывается только в момент входа.
//  Неофициальных клиентов и чужих токенов (Kate Mobile и т.п.) нет — аккаунт в безопасности.

const {
  app, BaseWindow, Menu, Tray, WebContentsView, ipcMain, nativeImage, nativeTheme, screen, session,
} = require('electron');
const fs = require('fs');
const path = require('path');

const VK_HOME = 'https://vk.com/audio';
const API_HOST = 'https://web.api.vk.ru';
const API_VERSION = '5.289';
const WEB_CLIENT_ID = '6287487'; // клиент самого сайта vk.com
const VK_PARTITION = 'persist:vk';
// Лёгкая страница того же сайта: после получения токена держим невидимую вкладку на ней,
// а не на тяжёлом vk.com/audio — меньше памяти и процессора, запросы работают так же
const VK_PARKING = 'https://vk.ru/robots.txt';

// Сайт должен видеть обычный Chrome, без «Electron/…» и имени программы
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s(?:vk-player|VK Player)\/\S+/gi, '');

nativeTheme.themeSource = 'dark';

let win = null;
let shellView = null;
let vkView = null;
let tray = null;
let quitting = false;
let settings = {};

let token = null; // актуальный токен страницы ВК (анонимный или пользователя)
let tokenWaiters = [];
let loginMode = false;
let loggedIn = null;
let parkTimer = null;

function parkVkView() {
  clearTimeout(parkTimer);
  parkTimer = setTimeout(() => {
    if (loginMode || !vkView || vkView.webContents.isDestroyed()) return;
    if (!vkView.webContents.getURL().startsWith(VK_PARKING)) vkView.webContents.loadURL(VK_PARKING);
  }, 4000);
}

function wakeVkView() {
  // Страница ВК сама получает свежий токен при загрузке
  clearTimeout(parkTimer);
  token = null;
  vkView.webContents.loadURL(VK_HOME);
}

// --- Настройки окна ------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath('userData'), 'window.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings() {
  if (!win) return;
  settings = { ...settings, bounds: win.getNormalBounds(), maximized: win.isMaximized() };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));
  } catch {
    /* не критично */
  }
}

function visibleBounds(bounds) {
  if (!bounds) return null;
  const ok = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
  return ok ? bounds : null;
}

const iconPath = () => path.join(__dirname, 'build', 'icon.png');

function sendToShell(channel, ...args) {
  if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.send(channel, ...args);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// --- Токен и вход --------------------------------------------------------------------------

function setToken(value) {
  if (!value) return;
  if (!loginMode) parkVkView();
  if (value === token) return;
  token = value;
  const waiters = tokenWaiters;
  tokenWaiters = [];
  waiters.forEach((resolve) => resolve(token));
  const isUser = !token.startsWith('anonym');
  if (isUser !== loggedIn) {
    loggedIn = isUser;
    sendToShell('auth-changed', { loggedIn });
    if (isUser && loginMode) finishLogin();
  }
}

function waitForToken(timeoutMs = 20000) {
  if (token) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    tokenWaiters.push(resolve);
    setTimeout(() => reject(new Error('Нет связи с ВКонтакте')), timeoutMs);
  });
}

function watchToken(ses) {
  // Страница ВК сама получает и обновляет токен — берём его из её запросов к API
  ses.webRequest.onBeforeRequest({ urls: ['https://web.api.vk.ru/method/*', 'https://web.api.vk.com/method/*'] }, (details, callback) => {
    if (details.uploadData) {
      const body = details.uploadData.map((part) => (part.bytes ? part.bytes.toString() : '')).join('');
      const match = body.match(/(?:^|&)access_token=([^&]+)/);
      if (match) setToken(decodeURIComponent(match[1]));
    }
    callback({});
  });
}

function showLogin(rect) {
  loginMode = true;
  if (rect) setVkBounds(rect);
  vkView.setVisible(true);
  vkView.webContents.loadURL('https://vk.com/login');
}

function finishLogin() {
  loginMode = false;
  vkView.setVisible(false);
  wakeVkView();
  sendToShell('login-closed');
  showWindow();
}

function cancelLogin() {
  loginMode = false;
  vkView.setVisible(false);
  wakeVkView();
}

async function logout() {
  await session.fromPartition(VK_PARTITION).clearStorageData();
  loggedIn = null;
  wakeVkView();
  sendToShell('auth-changed', { loggedIn: false });
}

function setVkBounds(rect) {
  vkView.setBounds({
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)),
  });
}

// --- Запросы к API (внутри страницы vk.com) -----------------------------------------------

async function callApi(method, params = {}, retry = true) {
  if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(method)) throw new Error('bad method');
  if (loginMode) throw new Error('Идёт вход во ВКонтакте');
  const accessToken = await waitForToken();
  const body = { lang: 'ru', ...params, access_token: accessToken };
  const script = `(async () => {
    const r = await fetch(${JSON.stringify(`${API_HOST}/method/${method}?v=${API_VERSION}&client_id=${WEB_CLIENT_ID}`)}, {
      method: 'POST', credentials: 'include', body: new URLSearchParams(${JSON.stringify(body)}),
    });
    return r.text();
  })()`;
  const text = await vkView.webContents.executeJavaScript(script, true);
  const data = JSON.parse(text);
  if (data.error) {
    // Токен протух — перезагружаем страницу ВК, она получит новый, и повторяем
    if (retry && [5, 1114, 1116].includes(data.error.error_code)) {
      wakeVkView();
      return callApi(method, params, false);
    }
    const err = new Error(data.error.error_msg || 'Ошибка ВКонтакте');
    err.code = data.error.error_code;
    throw err;
  }
  return data.response;
}

// --- Окно ----------------------------------------------------------------------------------

function createWindow() {
  settings = loadSettings();
  const bounds = visibleBounds(settings.bounds) || { width: 1280, height: 820 };

  win = new BaseWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 540,
    title: 'VK Player',
    icon: iconPath(),
    backgroundColor: '#0c0c10',
    show: false,
    frame: false,
  });
  win.setMenuBarVisibility(false);

  // Наш интерфейс и плеер
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // музыка не тормозит в свёрнутом окне
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  shellView.setBackgroundColor('#0c0c10');
  win.contentView.addChildView(shellView);
  shellView.webContents.loadFile(path.join(__dirname, 'shell', 'index.html'));

  // Невидимая официальная страница ВК: источник данных и место для входа
  const vkSession = session.fromPartition(VK_PARTITION);
  watchToken(vkSession);
  vkView = new WebContentsView({
    webPreferences: {
      partition: VK_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true, // невидимой странице таймеры на полной скорости не нужны
      autoplayPolicy: 'user-gesture-required', // страница ВК ничего не играет сама
      spellcheck: false,
    },
  });
  vkView.setBackgroundColor('#141414');
  if (typeof vkView.setBorderRadius === 'function') vkView.setBorderRadius(16);
  vkView.setVisible(false);
  win.contentView.addChildView(vkView);
  vkView.webContents.setAudioMuted(true);
  setupVkView(vkView.webContents);
  vkView.webContents.loadURL(VK_HOME);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    shellView.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on('resize', () => { layout(); saveSettings(); });
  win.on('move', saveSettings);
  const sendWindowState = () => sendToShell('window-state', { maximized: win.isMaximized() });
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  // Окно свёрнуто или убрано в трей — интерфейс ставит анимации на паузу (музыка играет).
  // Page Visibility API тут не поможет: при backgroundThrottling: false страница всегда «видима».
  const sendVisibility = () => sendToShell('window-visible', win.isVisible() && !win.isMinimized());
  for (const event of ['hide', 'show', 'minimize', 'restore']) win.on(event, sendVisibility);
  if (settings.maximized) win.maximize();
  shellView.webContents.once('did-finish-load', () => win.show());

  // Крестик сворачивает в трей, музыка играет дальше
  win.on('close', (event) => {
    saveSettings();
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
    if (!settings.trayHintShown && process.platform === 'win32') {
      settings.trayHintShown = true;
      saveSettings();
      tray.displayBalloon({
        iconType: 'info',
        title: 'VK Player работает в фоне',
        content: 'Музыка продолжает играть. Открыть или закрыть плеер — значок в трее.',
      });
    }
  });
}

function setupVkView(wc) {
  // Ссылки и всплывающие окна страницы ВК не открываем — она нужна только для входа
  wc.setWindowOpenHandler(({ url }) => {
    const isAuth = /^https:\/\/([\w-]+\.)*(vk\.(com|ru)|mail\.ru|ok\.ru)\//.test(url);
    if (loginMode && isAuth) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true, width: 520, height: 720, backgroundColor: '#141414',
          webPreferences: { partition: VK_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!/^https:\/\/([\w-]+\.)*(vk\.(com|ru)|mail\.ru|ok\.ru)\//.test(url)) event.preventDefault();
  });
  // После входа ВК уводит в ленту — нам она не нужна, держим страницу на музыке
  wc.on('did-navigate', (_e, url) => {
    if (!loginMode && !/\/audio/.test(url) && !url.startsWith(VK_PARKING) && /^https:\/\/(www\.)?vk\.(com|ru)\//.test(url)) wc.loadURL(VK_HOME);
  });
}

// --- Команды из интерфейса -----------------------------------------------------------------

ipcMain.handle('api', async (_e, method, params) => {
  try {
    return { ok: true, data: await callApi(method, params) };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});
ipcMain.handle('auth-state', async () => {
  try {
    await waitForToken(20000);
  } catch {
    /* оффлайн */
  }
  return { loggedIn: Boolean(loggedIn) };
});
ipcMain.on('login', (_e, rect) => showLogin(rect));
ipcMain.on('login-bounds', (_e, rect) => { if (loginMode && rect) setVkBounds(rect); });
ipcMain.on('login-cancel', cancelLogin);
ipcMain.on('logout', logout);
ipcMain.on('window', (_e, action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  if (action === 'close') win.close();
});
ipcMain.on('track-title', (_e, title) => {
  const name = String(title || '').slice(0, 120);
  if (win) win.setTitle(name ? `${name} — VK Player` : 'VK Player');
  if (tray) tray.setToolTip(name ? `VK Player — ${name}`.slice(0, 127) : 'VK Player');
});
ipcMain.on('shell-ready', () => {
  sendToShell('window-state', { maximized: win.isMaximized() });
  if (loggedIn !== null) sendToShell('auth-changed', { loggedIn });
});

// --- Трей и меню ---------------------------------------------------------------------------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip('VK Player');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть VK Player', click: showWindow },
    { type: 'separator' },
    { label: 'Играть / пауза', click: () => sendToShell('media', 'toggle') },
    { label: 'Следующий трек', click: () => sendToShell('media', 'next') },
    { label: 'Предыдущий трек', click: () => sendToShell('media', 'prev') },
    { type: 'separator' },
    { label: 'Выйти из аккаунта ВК', click: logout },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

function createMenu() {
  // Меню не показывается, но его горячие клавиши работают
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Плеер',
    submenu: [
      { label: 'Поиск', accelerator: 'CmdOrCtrl+F', click: () => sendToShell('focus-search') },
      { label: 'Играть / пауза', accelerator: 'CmdOrCtrl+P', click: () => sendToShell('media', 'toggle') },
      { label: 'Свернуть в трей', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
      { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      { label: 'Инструменты разработчика', accelerator: 'CmdOrCtrl+Shift+I', click: () => shellView.webContents.openDevTools({ mode: 'detach' }) },
    ],
  }]));
}

// --- Запуск --------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit(); // второй запуск просто показывает уже открытое окно
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    createMenu();
    createWindow();
    createTray();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', showWindow);
}
