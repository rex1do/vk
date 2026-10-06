// VK Player — десктопный плеер для официальной ВК Музыки.
//
// Окно — наша «стеклянная» оболочка (заголовок, поиск, меню разделов, нижняя панель плеера),
// в центре — музыкальный раздел официального сайта vk.com без шапки, меню соцсети, чатов и
// рекламы. Никаких неофициальных API и чужих токенов: вход на официальной странице ВК,
// для ВКонтакте это обычный Chrome.

const {
  app, BaseWindow, Menu, Tray, WebContentsView, ipcMain, nativeImage, nativeTheme, screen, session,
} = require('electron');
const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://vk.com/audio';

// Разделы меню → адреса ВК Музыки
const SECTIONS = {
  home: 'https://vk.com/audio',
  my: 'https://vk.com/audio?section=all',
  recoms: 'https://vk.com/audio?section=recoms',
  playlists: 'https://vk.com/audio?section=playlists',
  chart: 'https://vk.com/audio?block=chart',
  new: 'https://vk.com/audio?block=new_songs',
};

// Сайты, которые открываем внутри программы (ВК и вход через VK ID / Mail.ru / OK)
const INTERNAL_HOSTS = ['vk.com', 'vk.ru', 'vk.me', 'vk-portal.net', 'vkuser.net', 'vkuserphoto.ru', 'userapi.com', 'vk-cdn.net', 'mail.ru', 'ok.ru'];

// Оставляем от сайта только музыку: без шапки ВК, левого меню, рекламы; фон — прозрачный,
// карточки — полупрозрачные, чтобы сквозь них было видно «стеклянный» фон программы
const VK_CSS = `
#page_header_cont, #layout_sidebar, #ads_wrapper, #ads_with_extra, #ads_left, #ts_wrap { display: none !important; }
:root, body, .vkui__root, .vkui {
  --vkui--color_background: transparent !important;
  --vkui--color_background_page: transparent !important;
  --vkui--color_background_content: rgba(255, 255, 255, 0.045) !important;
  --vkui--color_background_secondary: rgba(255, 255, 255, 0.06) !important;
  --vkui--color_separator_primary: rgba(255, 255, 255, 0.08) !important;
}
html, body, #page_wrap, #spa_root, #layout_wrapper_root, #page_layout, #page_body, #spa_layout_content {
  background: transparent !important;
}
body, #page_wrap, [class*="LayoutWrapper__body"] { padding-top: 0 !important; margin-top: 0 !important; }
#page_layout { width: auto !important; max-width: 1240px !important; margin: 0 auto !important;
  padding: 18px 22px 24px !important; box-sizing: border-box !important; }
#page_body, #spa_layout_content { width: 100% !important; max-width: none !important;
  margin-left: 0 !important; float: none !important; }
::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(255,255,255,.24); }
`;

const isInternal = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && INTERNAL_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
};

// Только плеер: из страниц ВК разрешены музыкальные разделы и вход в аккаунт
const MUSIC_PATH = /^\/(audio|audios|music|artist|audio_playlist)/i;
const AUTH_PATH = /^\/(login|join|restore|challenge|blank\.html|authorize|auth|qr_auth|away\.php)/i;
const VK_SITE = /(^|\.)vk\.(com|ru)$/i;

function pageKind(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  if (u.protocol !== 'https:') return 'other';
  if (!VK_SITE.test(u.hostname)) return isInternal(url) ? 'auth' : 'external'; // VK ID, Mail.ru, OK — вход
  if (u.hostname.startsWith('id.') || u.hostname.startsWith('oauth.') || u.hostname.startsWith('login.')) return 'auth';
  if (MUSIC_PATH.test(u.pathname)) return 'music';
  if (AUTH_PATH.test(u.pathname)) return 'auth';
  if (u.pathname === '/' || u.pathname === '') return 'root'; // главная ВК — бывает при входе
  return 'blocked';
}

// Сайт должен видеть обычный Chrome, без «Electron/…» и имени программы
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s(?:vk-player|VK Player)\/\S+/gi, '');

// Тёмная тема: ВК подхватывает её как системную
nativeTheme.themeSource = 'dark';

let win = null;
let shellView = null;
let vkView = null;
let tray = null;
let quitting = false;
let settings = {};
let lastNowPlaying = '';
let lastUserId;
let vkZoom = 1;

function applyZoom() {
  const wc = vkView && vkView.webContents;
  if (wc && !wc.isDestroyed() && Math.abs(wc.getZoomFactor() - vkZoom) > 0.01) wc.setZoomFactor(vkZoom);
}

// --- Настройки -----------------------------------------------------------------------------

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

// --- Окно ----------------------------------------------------------------------------------

const iconPath = () => path.join(__dirname, 'build', 'icon.png');

function layoutShell() {
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendToShell(channel, payload) {
  if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.send(channel, payload);
}

function sendNavState() {
  const wc = vkView.webContents;
  sendToShell('nav-state', {
    url: wc.getURL(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

function createWindow() {
  settings = loadSettings();
  const bounds = visibleBounds(settings.bounds) || { width: 1280, height: 820 };

  win = new BaseWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 520,
    title: 'VK Player',
    icon: iconPath(),
    backgroundColor: '#0c0c10',
    show: false,
    frame: false, // заголовок и кнопки окна рисует наша оболочка
  });
  win.setMenuBarVisibility(false);

  // Наша оболочка: фон, заголовок, меню, панель плеера
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  shellView.setBackgroundColor('#0c0c10');
  win.contentView.addChildView(shellView);
  shellView.webContents.loadFile(path.join(__dirname, 'shell', 'index.html'));

  // Официальный сайт ВК — поверх оболочки, в области, которую укажет оболочка
  vkView = new WebContentsView({
    webPreferences: {
      partition: 'persist:vk', // вход сохраняется между запусками
      preload: path.join(__dirname, 'preload-vk.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // музыка не тормозит в свёрнутом окне
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', // следующий трек должен стартовать сам
    },
  });
  vkView.setBackgroundColor('#00000000');
  if (typeof vkView.setBorderRadius === 'function') vkView.setBorderRadius(18);
  vkView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  win.contentView.addChildView(vkView);
  setupVkView(vkView.webContents);
  vkView.webContents.loadURL(HOME_URL);

  layoutShell();
  win.on('resize', () => { layoutShell(); saveSettings(); });
  const sendWindowState = () => sendToShell('window-state', { maximized: win.isMaximized() });
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('move', saveSettings);
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

  setInterval(pollNowPlaying, 500);
}

function setupVkView(wc) {
  wc.on('dom-ready', () => {
    wc.insertCSS(VK_CSS, { cssOrigin: 'user' }).catch(() => {});
    applyZoom();
  });
  wc.on('did-navigate', applyZoom);
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) {
    wc.on(event, sendNavState);
  }

  // Если ВК сам увёл со страниц музыки (лента после входа, профиль и т.п.) — возвращаем в плеер.
  // Главная vk.com во время входа допустима, но после входа тоже уводим в музыку.
  const guard = (_e, url) => {
    const kind = pageKind(url);
    if (kind === 'blocked' || (kind === 'root' && lastUserId > 0)) wc.loadURL(HOME_URL);
  };
  wc.on('did-navigate', guard);
  wc.on('did-navigate-in-page', guard);

  // Новые окна — только для входа (VK ID, Mail.ru, OK); всё остальное не открываем
  wc.setWindowOpenHandler(({ url }) => {
    if (pageKind(url) === 'auth') {
      // Всплывающие окна входа (VK ID, Mail.ru, OK) — отдельные окна с той же сессией
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          width: 520,
          height: 720,
          backgroundColor: '#141414',
          webPreferences: { partition: 'persist:vk', contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!['music', 'auth', 'root'].includes(pageKind(url))) event.preventDefault();
  });
}

// --- «Сейчас играет» -----------------------------------------------------------------------

async function pollNowPlaying() {
  if (!vkView || vkView.webContents.isDestroyed()) return;
  let info = null;
  try {
    const state = await vkView.webContents.executeJavaScript(
      '({ np: window.__vkpNowPlaying ? window.__vkpNowPlaying() : null, uid: window.vk && typeof vk.id === "number" ? vk.id : null })', true);
    info = state.np;
    // vk.id === 0 — не вошли; null — страница ещё грузится или это страница входа
    if (state.uid !== null && state.uid !== lastUserId) {
      lastUserId = state.uid;
      sendToShell('auth-state', { loggedIn: state.uid > 0 });
      if (state.uid > 0 && pageKind(vkView.webContents.getURL()) !== 'music') vkView.webContents.loadURL(HOME_URL);
    }
  } catch {
    return;
  }
  const key = JSON.stringify(info);
  if (key === lastNowPlaying) return;
  const titleChanged = !lastNowPlaying || JSON.parse(lastNowPlaying)?.title !== info?.title;
  lastNowPlaying = key;
  sendToShell('now-playing', info);
  if (titleChanged) {
    const name = info && info.title ? `${info.artist ? info.artist + ' — ' : ''}${info.title}` : '';
    win.setTitle(name ? `${name} — VK Player` : 'VK Player');
    if (tray) tray.setToolTip(name ? `VK Player — ${name}`.slice(0, 127) : 'VK Player');
  }
}

function mediaAction(action, value) {
  if (!vkView) return;
  vkView.webContents.executeJavaScript(
    `window.__vkpAction && window.__vkpAction(${JSON.stringify(action)}, ${JSON.stringify(value ?? null)})`, true)
    .then(() => setTimeout(pollNowPlaying, 120))
    .catch(() => {});
}

async function logout() {
  await session.fromPartition('persist:vk').clearStorageData();
  lastUserId = undefined;
  vkView.webContents.loadURL(HOME_URL);
  showWindow();
}

// --- Команды из оболочки -------------------------------------------------------------------

ipcMain.on('stage-bounds', (_e, rect) => {
  // Оболочка сообщает, где у неё «сцена» для страницы ВК (меняется при изменении размеров окна)
  if (!vkView || !rect) return;
  vkView.setBounds({
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)),
  });
  // Адаптивность: в узком окне страница ВК плавно уменьшается, а не обрезается
  vkZoom = Math.max(0.65, Math.min(1, rect.width / 980));
  applyZoom();
});
ipcMain.on('window', (_e, action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  if (action === 'close') win.close();
});
ipcMain.on('navigate', (_e, section) => {
  if (SECTIONS[section]) vkView.webContents.loadURL(SECTIONS[section]);
});
ipcMain.on('login', () => {
  // Нажимаем официальную кнопку «Войти» на странице ВК; если её нет — открываем страницу входа
  vkView.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button, a')].find((el) => /^(войти|sign in|log in)$/i.test(el.textContent.trim()));
    if (btn) { btn.click(); return true; }
    return false;
  })()`, true).then((clicked) => {
    if (!clicked) vkView.webContents.loadURL('https://vk.com/login');
  }).catch(() => vkView.webContents.loadURL('https://vk.com/login'));
});
ipcMain.on('logout', logout);
ipcMain.on('search', (_e, query) => {
  const q = String(query || '').trim();
  if (q) vkView.webContents.loadURL(`https://vk.com/audio?q=${encodeURIComponent(q)}`);
});
ipcMain.on('history', (_e, direction) => {
  const h = vkView.webContents.navigationHistory;
  if (direction === 'back' && h.canGoBack()) h.goBack();
  if (direction === 'forward' && h.canGoForward()) h.goForward();
  if (direction === 'reload') vkView.webContents.reload();
});
ipcMain.on('media', (_e, action, value) => {
  if (['play', 'pause', 'previoustrack', 'nexttrack', 'toggle'].includes(action)) mediaAction(action);
  if (action === 'seek' && Number.isFinite(value)) mediaAction('seek', value);
  if (action === 'volume' && Number.isFinite(value)) mediaAction('volume', value);
});
ipcMain.on('shell-ready', () => {
  sendNavState();
  sendToShell('window-state', { maximized: win.isMaximized() });
  lastNowPlaying = '';
  lastUserId = undefined;
  pollNowPlaying();
});

// --- Трей и меню ---------------------------------------------------------------------------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip('VK Player');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть VK Player', click: showWindow },
    { type: 'separator' },
    { label: 'Играть / пауза', click: () => mediaAction('toggle') },
    { label: 'Следующий трек', click: () => mediaAction('nexttrack') },
    { label: 'Предыдущий трек', click: () => mediaAction('previoustrack') },
    { type: 'separator' },
    { label: 'Выйти из аккаунта ВК', click: logout },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

function createMenu() {
  // Меню не показывается, но его горячие клавиши работают
  const vk = (fn) => () => vkView && fn(vkView.webContents);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Плеер',
    submenu: [
      { label: 'Главная', accelerator: 'CmdOrCtrl+M', click: vk((wc) => wc.loadURL(HOME_URL)) },
      { label: 'Поиск', accelerator: 'CmdOrCtrl+F', click: () => sendToShell('focus-search') },
      { label: 'Играть / пауза', accelerator: 'CmdOrCtrl+P', click: () => mediaAction('toggle') },
      { label: 'Назад', accelerator: 'Alt+Left', click: vk((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
      { label: 'Вперёд', accelerator: 'Alt+Right', click: vk((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
      { label: 'Обновить', accelerator: 'F5', click: vk((wc) => wc.reload()) },
      { type: 'separator' },
      { label: 'Свернуть в трей', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
      { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
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
