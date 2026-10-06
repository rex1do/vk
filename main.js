// VK Player — отдельное окно для официальной ВК Музыки.
//
// Никаких неофициальных API и чужих токенов: открывается обычный сайт vk.com,
// вход — на официальной странице ВК. Для ВКонтакте это выглядит как обычный Chrome,
// поэтому нет риска заморозки, как у сторонних клиентов на токенах Kate Mobile.

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const START_URL = 'https://vk.com/audio';

// Сайты, которые открываем внутри окна (ВК, вход через VK ID и партнёров). Остальное — в браузере.
const INTERNAL_HOSTS = ['vk.com', 'vk.ru', 'vk.me', 'vkuser.net', 'userapi.com', 'vk-cdn.net', 'mail.ru', 'ok.ru'];

const isInternal = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return INTERNAL_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
};

// Убираем «Electron/…» и имя программы из User-Agent — сайт видит обычный Chrome
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName().replace(/[^\w-]/g, '\\$&')}\\/\\S+`, 'i'), '')
  .replace(/\svk-player\/\S+/i, '');

let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

// --- Настройки (размер окна и т.п.) --------------------------------------------------------

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
  const data = { ...loadSettings(), bounds: win.getNormalBounds(), maximized: win.isMaximized(), trayHintShown };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(data));
  } catch {
    /* не критично */
  }
}

function visibleBounds(bounds) {
  if (!bounds) return null;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
  return onScreen ? bounds : null;
}

// --- Окно ----------------------------------------------------------------------------------

function iconPath() {
  return path.join(__dirname, 'build', 'icon.png');
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const settings = loadSettings();
  trayHintShown = Boolean(settings.trayHintShown);
  const bounds = visibleBounds(settings.bounds) || { width: 1200, height: 800 };

  win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 560,
    title: 'VK Player',
    icon: iconPath(),
    backgroundColor: '#19191a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: 'persist:vk', // вход сохраняется между запусками
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // музыка не должна притормаживать в свёрнутом окне
      spellcheck: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.loadURL(START_URL);

  // Ссылки на другие сайты — в обычный браузер, всё про ВК — здесь же
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      // Всплывающие окна входа (VK ID, Mail.ru, OK) открываем как дочерние окна
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win,
          autoHideMenuBar: true,
          width: 520,
          height: 700,
          webPreferences: { partition: 'persist:vk', contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Заголовок окна = название трека (ВК пишет его в title страницы во время игры)
  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    const clean = title.replace(/\s*\|\s*ВКонтакте\s*$/i, '').trim();
    win.setTitle(clean ? `${clean} — VK Player` : 'VK Player');
    if (tray) tray.setToolTip(clean ? `VK Player — ${clean}`.slice(0, 127) : 'VK Player');
  });

  // Крестик сворачивает в трей, музыка играет дальше
  win.on('close', (event) => {
    saveSettings();
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
    if (!trayHintShown && process.platform === 'win32') {
      trayHintShown = true;
      saveSettings();
      tray.displayBalloon({
        iconType: 'info',
        title: 'VK Player работает в фоне',
        content: 'Музыка продолжает играть. Открыть или закрыть плеер — значок в трее.',
      });
    }
  });
  win.on('resize', saveSettings);
  win.on('move', saveSettings);
}

// --- Трей и меню ---------------------------------------------------------------------------

function createTray() {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('VK Player');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть VK Player', click: showWindow },
      { type: 'separator' },
      { label: 'Моя музыка', click: () => { showWindow(); win.loadURL(START_URL); } },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

function createMenu() {
  // Меню скрыто (появляется по Alt), но горячие клавиши из него работают всегда
  const nav = (fn) => () => win && fn(win.webContents);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Плеер',
        submenu: [
          { label: 'Моя музыка', accelerator: 'CmdOrCtrl+M', click: nav((wc) => wc.loadURL(START_URL)) },
          { label: 'Назад', accelerator: 'Alt+Left', click: nav((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
          { label: 'Вперёд', accelerator: 'Alt+Right', click: nav((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
          { label: 'Обновить', accelerator: 'F5', click: nav((wc) => wc.reload()) },
          { type: 'separator' },
          { label: 'Увеличить', accelerator: 'CmdOrCtrl+=', click: nav((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
          { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: nav((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
          { label: 'Обычный размер', accelerator: 'CmdOrCtrl+0', click: nav((wc) => wc.setZoomLevel(0)) },
          { type: 'separator' },
          { label: 'Свернуть в трей', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
          { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
        ],
      },
    ]),
  );
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
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', showWindow);
}
