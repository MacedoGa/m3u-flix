const { app, BrowserWindow, ipcMain, dialog, session, shell, net, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');
const { DownloadManager } = require('./downloads');

let mainWindow = null;
let downloads = null;

// Perfil separado para testes (não mexe nas listas/downloads do app instalado).
if (process.env.M3UFLIX_PROFILE) app.setPath('userData', process.env.M3UFLIX_PROFILE);

// A interface é servida por app://ui/ (permite ES modules) e os arquivos baixados
// por app://media/<caminho> (com suporte a Range para avançar/retroceder).
// O esquema não é "secure" de propósito: streams IPTV costumam ser http://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const ROOT = path.join(__dirname, '..');
const UI_DIRS = ['src', path.join('node_modules', 'hls.js'), path.join('node_modules', 'mpegts.js')].map((d) => path.join(ROOT, d) + path.sep);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
};

async function serveFile(file, request) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start >= stat.size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } });
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.host === 'ui') {
      const file = path.normalize(path.join(ROOT, rel));
      if (!UI_DIRS.some((d) => file.startsWith(d))) return new Response('Forbidden', { status: 403 });
      return serveFile(file, request);
    }
    if (url.host === 'media') {
      if (!downloads.isKnownFile(rel)) return new Response('Forbidden', { status: 403 });
      return serveFile(rel, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

// Configuração de rede definida pelo renderer (User-Agent global) e cabeçalhos
// específicos por origem vindos de #EXTVLCOPT (http-user-agent / http-referrer).
const netConfig = { userAgent: '' };
const streamHeaders = new Map();

const storePath = (name) => path.join(app.getPath('userData'), 'store', `${name.replace(/[^\w.-]/g, '_')}.json`);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

function headersFor(url) {
  const out = {};
  try {
    const extra = streamHeaders.get(new URL(url).origin) || {};
    const ua = extra.userAgent || netConfig.userAgent;
    if (ua) out['User-Agent'] = ua;
    if (extra.referer) out['Referer'] = extra.referer;
  } catch {}
  return out;
}

function setupNetwork() {
  const ses = session.defaultSession;

  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = details.requestHeaders;
    if (/^https?:/i.test(details.url)) Object.assign(headers, headersFor(details.url));
    cb({ requestHeaders: headers });
  });

  // Servidores IPTV raramente enviam cabeçalhos CORS; o player (hls.js/mpegts.js)
  // precisa deles para ler os segmentos via XHR/fetch.
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!/^https?:/i.test(details.url)) return cb({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!/^access-control-allow-/i.test(k)) headers[k] = v;
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    const result = { responseHeaders: headers };
    if (details.method === 'OPTIONS') result.statusLine = 'HTTP/1.1 200 OK';
    cb(result);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    title: 'M3U Flix',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadURL('app://ui/src/index.html');
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function registerIpc() {
  ipcMain.handle('store:get', (_e, name) => readJson(storePath(name), null));
  ipcMain.handle('store:set', (_e, name, data) => writeJson(storePath(name), data));

  ipcMain.handle('net:config', (_e, cfg) => {
    netConfig.userAgent = (cfg && cfg.userAgent) || '';
  });
  ipcMain.handle('net:streamHeaders', (_e, url, headers) => {
    try {
      const origin = new URL(url).origin;
      if (headers && (headers.userAgent || headers.referer)) streamHeaders.set(origin, headers);
    } catch {}
  });

  // Listas IPTV podem ter 100 MB+: a cópia offline é salva direto em arquivo aqui,
  // sem passar de volta pelo renderer.
  const cachePath = (id) => path.join(app.getPath('userData'), 'cache', `${String(id).replace(/[^\w-]/g, '_')}.m3u`);
  ipcMain.handle('playlist:fetch', async (_e, url, cacheId) => {
    const res = await net.fetch(url, { headers: headersFor(url) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar a lista`);
    const text = await res.text();
    if (cacheId && /#EXTINF/i.test(text.slice(0, 100000))) {
      await fsp.mkdir(path.dirname(cachePath(cacheId)), { recursive: true });
      await fsp.writeFile(cachePath(cacheId), text);
    }
    return text;
  });
  ipcMain.handle('playlist:readCache', (_e, id) => fsp.readFile(cachePath(id), 'utf8').catch(() => null));
  ipcMain.handle('playlist:deleteCache', (_e, id) => fsp.unlink(cachePath(id)).catch(() => {}));
  ipcMain.handle('playlist:openFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Abrir lista M3U',
      properties: ['openFile'],
      filters: [{ name: 'Listas M3U', extensions: ['m3u', 'm3u8', 'txt'] }, { name: 'Todos', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    return { path: file, name: path.basename(file).replace(/\.[^.]+$/, ''), content: await fsp.readFile(file, 'utf8') };
  });
  ipcMain.handle('playlist:readFile', (_e, file) => fsp.readFile(file, 'utf8'));

  ipcMain.handle('dl:list', () => downloads.list());
  ipcMain.handle('dl:start', (_e, req) => downloads.start(req));
  ipcMain.handle('dl:cancel', (_e, id) => downloads.cancel(id));
  ipcMain.handle('dl:retry', (_e, id) => downloads.retry(id));
  ipcMain.handle('dl:remove', (_e, id, deleteFile) => downloads.remove(id, deleteFile));
  ipcMain.handle('dl:showFile', (_e, id) => {
    const item = downloads.get(id);
    if (item && item.file && fs.existsSync(item.file)) shell.showItemInFolder(item.file);
    else shell.openPath(downloads.folder());
  });
  ipcMain.handle('dl:openFolder', async () => {
    await fsp.mkdir(downloads.folder(), { recursive: true });
    shell.openPath(downloads.folder());
  });
  ipcMain.handle('dl:getFolder', () => downloads.folder());
  ipcMain.handle('dl:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Escolher pasta de downloads',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: downloads.folder(),
    });
    if (r.canceled || !r.filePaths[0]) return downloads.folder();
    await downloads.setFolder(r.filePaths[0]);
    return downloads.folder();
  });
}

app.whenReady().then(async () => {
  setupNetwork();
  downloads = new DownloadManager({
    dataFile: storePath('downloads-db'),
    configFile: storePath('downloads-config'),
    defaultFolder: path.join(app.getPath('videos'), 'M3U Flix'),
    headersFor,
    notify: (list) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dl:update', list);
    },
  });
  await downloads.init();
  registerAppProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
