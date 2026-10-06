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
  app, BaseWindow, BrowserWindow, Menu, Tray, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, net, screen, session, shell,
} = require('electron');
const crypto = require('crypto');
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
    // свои запросы помечены vkp=1 — из них токен не берём (иначе гостевой токен «разлогинит»)
    if (details.uploadData && !/[?&]vkp=1(&|$)/.test(details.url)) {
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

// Гостевой токен — тот же, что сайт ВК получает для незалогиненных посетителей.
// Нужен как запасной путь к публичным разделам (чарт, новинки), если для аккаунта
// ВК не отдал их отдельной вкладкой.
let anonToken = null;
async function getAnonToken() {
  if (anonToken && anonToken.expires * 1000 > Date.now() + 60000) return anonToken.token;
  const text = await vkView.webContents.executeJavaScript(`(async () => {
    const body = new URLSearchParams({ client_secret: 'QbYic1K3lEV5kTGiqlq2', client_id: '${WEB_CLIENT_ID}', scopes: 'audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous', isApiOauthAnonymEnabled: 'false', version: '1', app_id: '${WEB_CLIENT_ID}' });
    // без cookie: гостевой токен не должен трогать вход пользователя
    const r = await fetch('https://login.vk.ru/?act=get_anonym_token', { method: 'POST', body, credentials: 'omit' });
    return r.text();
  })()`, true);
  const data = JSON.parse(text).data;
  if (!data || !data.access_token) throw new Error('Нет связи с ВКонтакте');
  anonToken = { token: data.access_token, expires: data.expires || data.expired_at || 0 };
  return anonToken.token;
}

async function callApi(method, params = {}, retry = true, { anonymous = false } = {}) {
  if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(method)) throw new Error('bad method');
  if (loginMode) throw new Error('Идёт вход во ВКонтакте');
  await waitForToken(); // страница ВК должна быть загружена
  const accessToken = anonymous ? await getAnonToken() : token;
  const body = { lang: 'ru', ...params, access_token: accessToken };
  const script = `(async () => {
    const r = await fetch(${JSON.stringify(`${API_HOST}/method/${method}?v=${API_VERSION}&client_id=${WEB_CLIENT_ID}&vkp=1`)}, {
      method: 'POST', credentials: ${anonymous ? "'omit'" : "'include'"}, body: new URLSearchParams(${JSON.stringify(body)}),
    });
    return r.text();
  })()`;
  const text = await vkView.webContents.executeJavaScript(script, true);
  const data = JSON.parse(text);
  if (data.error) {
    // Токен протух — перезагружаем страницу ВК, она получит новый, и повторяем
    if (retry && [5, 1114, 1116].includes(data.error.error_code)) {
      if (anonymous) anonToken = null;
      else wakeVkView();
      return callApi(method, params, false, { anonymous });
    }
    const err = new Error(data.error.error_msg || 'Ошибка ВКонтакте');
    err.code = data.error.error_code;
    throw err;
  }
  return data.response;
}

// --- Скачивание трека ---------------------------------------------------------------------
// ВК отдаёт трек потоком HLS: плейлист из кусочков MPEG-TS, часть зашифрована AES-128.
// Скачиваем кусочки, расшифровываем, достаём звук из контейнера и пишем MP3 с тегами.

async function fetchBuffer(url) {
  const r = await net.fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function hlsSegments(playlistUrl) {
  const text = (await fetchBuffer(playlistUrl)).toString('utf-8');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // мастер-плейлист — берём первый вариант
  const variant = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (variant >= 0 && lines[variant + 1]) return hlsSegments(new URL(lines[variant + 1], playlistUrl).href);
  const segments = [];
  let key = null;
  let seq = 0;
  let duration = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.split(':')[1], 10) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const method = /METHOD=([^,]+)/.exec(line);
      const uri = /URI="([^"]+)"/.exec(line);
      const iv = /IV=0x([0-9a-f]+)/i.exec(line);
      key = method && method[1] === 'AES-128' && uri ? { uri: new URL(uri[1], playlistUrl).href, iv: iv ? Buffer.from(iv[1].padStart(32, '0'), 'hex') : null } : null;
    } else if (!line.startsWith('#')) {
      segments.push({ url: new URL(line, playlistUrl).href, key, seq, duration });
      seq += 1;
    }
  }
  return segments;
}

// Достаём аудиопоток из MPEG-TS (PES с stream_id 0xC0–0xDF)
function demuxTs(buf) {
  if (buf[0] !== 0x47) return buf; // не TS — отдаём как есть
  const out = [];
  let audioPid = -1;
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    const start = (buf[i + 1] & 0x40) !== 0;
    const afc = (buf[i + 3] >> 4) & 3;
    let off = i + 4;
    if (afc === 2) continue;
    if (afc === 3) off += 1 + buf[off];
    if (off >= i + 188) continue;
    if (start && buf[off] === 0 && buf[off + 1] === 0 && buf[off + 2] === 1) {
      const streamId = buf[off + 3];
      if (audioPid === -1 && streamId >= 0xc0 && streamId <= 0xdf) audioPid = pid;
      if (pid !== audioPid) continue;
      off += 9 + buf[off + 8]; // заголовок PES
    } else if (pid !== audioPid) continue;
    out.push(buf.subarray(off, i + 188));
  }
  return Buffer.concat(out);
}

function id3Tag({ title, artist, album }, cover) {
  const text = (id, value) => {
    if (!value) return Buffer.alloc(0);
    const body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(String(value), 'utf16le'), Buffer.from([0, 0])]);
    const head = Buffer.alloc(10);
    head.write(id, 0, 'ascii');
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const frames = [text('TIT2', title), text('TPE1', artist), text('TALB', album)];
  if (cover) {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3, 0]), cover]);
    const head = Buffer.alloc(10);
    head.write('APIC', 0, 'ascii');
    head.writeUInt32BE(body.length, 4);
    frames.push(head, body);
  }
  const content = Buffer.concat(frames);
  const size = content.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([header, content]);
}

// Звук трека целиком (MP3/AAC без контейнера): для скачивания и для сравнения версий
// maxSeconds — только начало трека (для быстрой проверки версий)
async function fetchAudioData(url, onProgress = () => {}, maxSeconds = 0) {
  if (!/\.m3u8/.test(url)) return fetchBuffer(url);
  let segments = await hlsSegments(url);
  if (maxSeconds > 0) {
    let total = 0;
    segments = segments.filter((seg) => { const keep = total < maxSeconds; total += seg.duration || 10; return keep; });
  }
  const keys = new Map();
  const parts = new Array(segments.length);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < segments.length) {
      const index = next++;
      const seg = segments[index];
      let data = await fetchBuffer(seg.url);
      if (seg.key) {
        if (!keys.has(seg.key.uri)) keys.set(seg.key.uri, fetchBuffer(seg.key.uri));
        const keyBytes = await keys.get(seg.key.uri);
        const iv = seg.key.iv || Buffer.from(seg.seq.toString(16).padStart(32, '0'), 'hex');
        const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
        data = Buffer.concat([decipher.update(data), decipher.final()]);
      }
      parts[index] = demuxTs(data);
      done += 1;
      onProgress(done / segments.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return Buffer.concat(parts);
}

async function downloadTrack(info) {
  const safeName = `${info.artist} - ${info.title}`.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'track';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Сохранить трек',
    defaultPath: path.join(app.getPath('music'), `${safeName}.mp3`),
    filters: [{ name: 'MP3', extensions: ['mp3'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const progress = (p) => sendToShell('download-progress', { key: info.key, progress: p });
  progress(0);

  const audioData = await fetchAudioData(info.url, progress);

  let target = filePath;
  // в редких случаях звук внутри — AAC, а не MP3: сохраняем с правильным расширением
  const isAac = audioData[0] === 0xff && (audioData[1] & 0xf6) === 0xf0;
  if (isAac) target = filePath.replace(/\.mp3$/i, '.aac');
  const cover = info.cover ? await fetchBuffer(info.cover).catch(() => null) : null;
  fs.writeFileSync(target, Buffer.concat([id3Tag(info, cover), audioData]));
  progress(1);
  return { ok: true, path: target };
}

// --- Genius: ссылка на песню и текст -------------------------------------------------------
// Genius прикрыт Cloudflare, поэтому при отказе обычного запроса открываем страницу
// в скрытом окне Chromium — как обычный браузер.

let geniusWin = null;
function geniusPage() {
  if (!geniusWin || geniusWin.isDestroyed()) {
    geniusWin = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:genius', sandbox: true, contextIsolation: true, images: false } });
    geniusWin.webContents.setAudioMuted(true);
  }
  return geniusWin.webContents;
}

async function geniusLoad(url, script, timeoutMs = 20000) {
  const wc = geniusPage();
  await Promise.race([wc.loadURL(url), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
  // ждём, пока пройдёт проверка Cloudflare и появится содержимое
  for (let i = 0; i < 20; i++) {
    const result = await wc.executeJavaScript(script, true).catch(() => null);
    if (result) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const geniusClean = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function geniusFind({ artist, title }) {
  const q = `${artist.split(/,|&| feat/i)[0]} ${title.replace(/\(.*?\)|\[.*?\]/g, '')}`.trim();
  const api = `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`;
  let data = null;
  try {
    const r = await net.fetch(api, { headers: { 'User-Agent': app.userAgentFallback, Accept: 'application/json' } });
    if (r.ok) data = await r.json();
  } catch {
    data = null;
  }
  if (!data) {
    const text = await geniusLoad(api, `(() => { try { return JSON.parse(document.body.innerText) && document.body.innerText; } catch { return null; } })()`).catch(() => null);
    data = text ? JSON.parse(text) : null;
  }
  if (!data) return null;
  const hits = (data.response.sections || []).flatMap((s) => s.hits || []).filter((h) => h.type === 'song').map((h) => h.result);
  const wantTitle = geniusClean(title);
  const wantArtist = geniusClean(artist.split(/,|&| feat/i)[0]);
  const best = hits.find((h) => geniusClean(h.title).includes(wantTitle) && geniusClean(h.primary_artist && h.primary_artist.name).includes(wantArtist))
    || hits.find((h) => geniusClean(h.title).includes(wantTitle));
  return best ? best.url : null;
}

async function geniusLyrics(info) {
  const url = await geniusFind(info);
  if (!url) return null;
  const text = await geniusLoad(url, `(() => {
    const boxes = [...document.querySelectorAll('[data-lyrics-container="true"]')];
    if (!boxes.length) return null;
    return boxes.map((b) => {
      const c = b.cloneNode(true);
      c.querySelectorAll('[data-exclude-from-selection="true"]').forEach((x) => x.remove());
      c.querySelectorAll('br').forEach((br) => br.replaceWith('\\n'));
      return c.textContent;
    }).join('\\n');
  })()`);
  if (!text) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()));
  return { url, lines };
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
  const sendWindowState = () => sendToShell('window-state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('enter-full-screen', sendWindowState);
  win.on('leave-full-screen', sendWindowState);
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

ipcMain.handle('api', async (_e, method, params, options) => {
  try {
    return { ok: true, data: await callApi(method, params, true, { anonymous: Boolean(options && options.anonymous) }) };
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
ipcMain.handle('download', async (_e, info) => {
  try {
    return await downloadTrack(info);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.on('show-file', (_e, file) => { if (file) shell.showItemInFolder(file); });
ipcMain.handle('audio-data', async (_e, url, maxSeconds) => {
  try {
    const data = await fetchAudioData(url, () => {}, Number(maxSeconds) || 0);
    return { ok: true, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('genius-lyrics', async (_e, info) => {
  try {
    return await geniusLyrics(info);
  } catch {
    return null;
  }
});
ipcMain.handle('genius-open', async (_e, info) => {
  let url = null;
  try {
    url = await geniusFind(info);
  } catch {
    url = null;
  }
  shell.openExternal(url || `https://genius.com/search?q=${encodeURIComponent(`${info.artist} ${info.title}`)}`);
});
ipcMain.on('window', (_e, action) => {
  if (!win) return;
  if (action === 'fullscreen') { win.setFullScreen(!win.isFullScreen()); return; }
  if (action === 'exit-fullscreen') { win.setFullScreen(false); return; }
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
