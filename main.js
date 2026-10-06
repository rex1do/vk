// VK Player — десктопная оболочка для официальной ВК Музыки.
//
// Слева — своя панель (поиск, разделы, «Сейчас играет»), справа — музыкальный раздел
// официального сайта vk.com без шапки-меню и рекламы. Никаких неофициальных API и чужих
// токенов: вход на официальной странице ВК, для ВКонтакте это обычный Chrome.

const {
  app, BaseWindow, Menu, Tray, WebContentsView, ipcMain, nativeImage, nativeTheme, screen, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://vk.com/audio';
const SIDEBAR_WIDTH = 248;
const TITLEBAR_HEIGHT = 40;

// Разделы левой панели → адреса ВК Музыки
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

// Прячем всё, что не относится к музыке: левое меню ВК, рекламу; растягиваем контент
const VK_CSS = `
#layout_sidebar, #ads_wrapper, #ads_with_extra, #ads_left, #ts_wrap { display: none !important; }
#page_layout { width: auto !important; max-width: 1180px !important; margin: 0 auto !important;
  padding: 0 24px !important; box-sizing: border-box !important; }
#page_body, #spa_layout_content { width: 100% !important; max-width: none !important;
  margin-left: 0 !important; float: none !important; }
#page_header { width: auto !important; max-width: 1180px !important; margin: 0 auto !important;
  padding: 0 24px !important; box-sizing: border-box !important; }
::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
::-webkit-scrollbar-thumb { background: #3a3a3d; border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: #4a4a4e; }
`;

const isInternal = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && INTERNAL_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
};

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

function layout() {
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
  vkView.setBounds({ x: SIDEBAR_WIDTH, y: TITLEBAR_HEIGHT, width: Math.max(0, width - SIDEBAR_WIDTH), height: Math.max(0, height - TITLEBAR_HEIGHT) });
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
    minWidth: 900,
    minHeight: 580,
    title: 'VK Player',
    icon: iconPath(),
    backgroundColor: '#141414',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141414', symbolColor: '#e1e3e6', height: TITLEBAR_HEIGHT },
  });
  win.setMenuBarVisibility(false);

  // Наша оболочка: заголовок окна и левая панель
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  shellView.setBackgroundColor('#141414');
  win.contentView.addChildView(shellView);
  shellView.webContents.loadFile(path.join(__dirname, 'shell', 'index.html'));

  // Официальный сайт ВК
  vkView = new WebContentsView({
    webPreferences: {
      partition: 'persist:vk', // вход сохраняется между запусками
      preload: path.join(__dirname, 'preload-vk.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // музыка не тормозит в свёрнутом окне
      spellcheck: false,
    },
  });
  vkView.setBackgroundColor('#141414');
  win.contentView.addChildView(vkView);
  setupVkView(vkView.webContents);
  vkView.webContents.loadURL(HOME_URL);

  layout();
  win.on('resize', () => { layout(); saveSettings(); });
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

  setInterval(pollNowPlaying, 1000);
}

function setupVkView(wc) {
  wc.on('dom-ready', () => wc.insertCSS(VK_CSS).catch(() => {}));
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) {
    wc.on(event, sendNavState);
  }

  // Ссылки на сторонние сайты — в обычный браузер, всё про ВК — здесь же
  wc.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      // Всплывающие окна входа (VK ID, Mail.ru, OK) — дочерние окна с той же сессией
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
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
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
    }
  } catch {
    return;
  }
  const key = JSON.stringify(info);
  if (key === lastNowPlaying) return;
  lastNowPlaying = key;
  sendToShell('now-playing', info);
  const name = info && info.title ? `${info.artist ? info.artist + ' — ' : ''}${info.title}` : '';
  win.setTitle(name ? `${name} — VK Player` : 'VK Player');
  if (tray) tray.setToolTip(name ? `VK Player — ${name}`.slice(0, 127) : 'VK Player');
}

function mediaAction(action) {
  if (!vkView) return;
  vkView.webContents.executeJavaScript(`window.__vkpAction && window.__vkpAction(${JSON.stringify(action)})`, true)
    .then(() => setTimeout(pollNowPlaying, 150))
    .catch(() => {});
}

// --- Команды из левой панели ---------------------------------------------------------------

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
ipcMain.on('media', (_e, action) => {
  if (['play', 'pause', 'previoustrack', 'nexttrack', 'toggle'].includes(action)) mediaAction(action);
});
ipcMain.on('shell-ready', () => {
  sendNavState();
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
      { label: 'Назад', accelerator: 'Alt+Left', click: vk((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
      { label: 'Вперёд', accelerator: 'Alt+Right', click: vk((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
      { label: 'Обновить', accelerator: 'F5', click: vk((wc) => wc.reload()) },
      { type: 'separator' },
      { label: 'Увеличить', accelerator: 'CmdOrCtrl+=', click: vk((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
      { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: vk((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
      { label: 'Обычный размер', accelerator: 'CmdOrCtrl+0', click: vk((wc) => wc.setZoomLevel(0)) },
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
