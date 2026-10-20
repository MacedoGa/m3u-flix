const { net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { once } = require('events');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const MAX_PARALLEL = 2;
const SEGMENT_RETRIES = 4;

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function sanitize(name) {
  return (name || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';
}

async function uniquePath(folder, base, ext) {
  let candidate = path.join(folder, base + ext);
  for (let n = 2; ; n++) {
    try {
      await fsp.access(candidate);
      candidate = path.join(folder, `${base} (${n})${ext}`);
    } catch {
      return candidate;
    }
  }
}

function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\.(mp4|mkv|avi|mov|m4v|webm|ts|mp3|aac|flv|wmv)$/i);
    return m ? `.${m[1].toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function parseAttrs(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  return attrs;
}

class DownloadManager {
  constructor({ dataFile, configFile, defaultFolder, headersFor, notify }) {
    this.dataFile = dataFile;
    this.configFile = configFile;
    this.defaultFolder = defaultFolder;
    this.headersFor = headersFor;
    this.notifyFn = notify;
    this.items = [];
    this.config = {};
    this.controllers = new Map();
    this.notifyTimer = null;
  }

  async init() {
    try {
      this.items = JSON.parse(await fsp.readFile(this.dataFile, 'utf8'));
    } catch {
      this.items = [];
    }
    try {
      this.config = JSON.parse(await fsp.readFile(this.configFile, 'utf8'));
    } catch {
      this.config = {};
    }
    for (const it of this.items) {
      if (it.status === 'downloading' || it.status === 'queued') {
        it.status = 'error';
        it.error = 'Interrompido (o app foi fechado)';
      }
      if (it.status === 'done' && it.file && !fs.existsSync(it.file)) {
        it.status = 'error';
        it.error = 'Arquivo não encontrado';
      }
    }
  }

  folder() {
    return this.config.folder || this.defaultFolder;
  }

  async setFolder(folder) {
    this.config.folder = folder;
    await this.persist(this.configFile, this.config);
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  list() {
    return this.items.map(({ _speedAt, _speedBytes, ...i }) => ({ ...i, fileUrl: i.file ? `app://media/${encodeURIComponent(i.file)}` : null }));
  }

  isKnownFile(file) {
    const target = path.resolve(file);
    return this.items.some((i) => i.status === 'done' && i.file && path.resolve(i.file) === target);
  }

  async persist(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(data));
    await fsp.rename(`${file}.tmp`, file);
  }

  save() {
    return this.persist(this.dataFile, this.items).catch(() => {});
  }

  notify(immediate = false) {
    if (immediate) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      this.notifyFn(this.list());
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notifyFn(this.list());
    }, 400);
  }

  start(req) {
    const existing = this.items.find((i) => i.key === req.key && ['queued', 'downloading', 'done'].includes(i.status));
    if (existing) return existing.id;
    const item = {
      id: crypto.randomUUID(),
      key: req.key,
      url: req.url,
      title: req.title,
      subtitle: req.subtitle || '',
      poster: req.poster || '',
      kind: req.kind || 'movie',
      seriesId: req.seriesId || null,
      season: req.season ?? null,
      episode: req.episode ?? null,
      status: 'queued',
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      file: null,
      error: null,
      createdAt: Date.now(),
    };
    this.items.unshift(item);
    this.save();
    this.notify(true);
    this.pump();
    return item.id;
  }

  retry(id) {
    const item = this.get(id);
    if (!item || item.status === 'downloading' || item.status === 'queued') return;
    Object.assign(item, { status: 'queued', progress: 0, received: 0, total: 0, error: null });
    this.save();
    this.notify(true);
    this.pump();
  }

  cancel(id) {
    const item = this.get(id);
    if (!item) return;
    const ctrl = this.controllers.get(id);
    if (ctrl) ctrl.abort();
    else if (item.status === 'queued') {
      item.status = 'canceled';
      this.save();
      this.notify(true);
    }
  }

  async remove(id, deleteFile) {
    const item = this.get(id);
    if (!item) return;
    this.controllers.get(id)?.abort();
    if (deleteFile && item.file) await fsp.unlink(item.file).catch(() => {});
    this.items = this.items.filter((i) => i.id !== id);
    this.save();
    this.notify(true);
  }

  pump() {
    const active = this.items.filter((i) => i.status === 'downloading').length;
    let slots = MAX_PARALLEL - active;
    for (const item of [...this.items].reverse()) {
      if (slots <= 0) break;
      if (item.status === 'queued') {
        slots--;
        this.run(item);
      }
    }
  }

  async run(item) {
    const ctrl = new AbortController();
    this.controllers.set(item.id, ctrl);
    item.status = 'downloading';
    item.error = null;
    this.notify(true);
    let tmpFile = null;
    try {
      const folder = this.folder();
      await fsp.mkdir(folder, { recursive: true });
      const base = sanitize(item.title);
      const isHls = /\.m3u8($|\?)/i.test(item.url) || (await this.looksLikeHls(item.url, ctrl.signal));
      let result;
      if (isHls) result = await this.downloadHls(item, folder, base, ctrl.signal, (f) => (tmpFile = f));
      else result = await this.downloadDirect(item, folder, base, ctrl.signal, (f) => (tmpFile = f));
      tmpFile = null;
      item.file = result;
      if (/\.ts$/i.test(result)) item.file = await this.remuxToMp4(result, item);
      item.status = 'done';
      item.progress = 1;
      item.speed = 0;
    } catch (err) {
      item.speed = 0;
      if (ctrl.signal.aborted) {
        item.status = 'canceled';
        item.error = null;
      } else {
        item.status = 'error';
        item.error = err && err.message ? err.message : String(err);
      }
      if (tmpFile) await fsp.unlink(tmpFile).catch(() => {});
    } finally {
      this.controllers.delete(item.id);
      this.save();
      this.notify(true);
      this.pump();
    }
  }

  async fetch(url, signal) {
    const res = await net.fetch(url, { headers: this.headersFor(url), signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  async looksLikeHls(url, signal) {
    try {
      const res = await net.fetch(url, { method: 'HEAD', headers: this.headersFor(url), signal });
      return /mpegurl/i.test(res.headers.get('content-type') || '');
    } catch {
      return false;
    }
  }

  trackSpeed(item, bytes) {
    const now = Date.now();
    if (!item._speedAt) {
      item._speedAt = now;
      item._speedBytes = 0;
    }
    item._speedBytes += bytes;
    if (now - item._speedAt >= 1000) {
      item.speed = Math.round((item._speedBytes * 1000) / (now - item._speedAt));
      item._speedAt = now;
      item._speedBytes = 0;
    }
  }

  async downloadDirect(item, folder, base, signal, setTmp) {
    const res = await this.fetch(item.url, signal);
    const type = res.headers.get('content-type') || '';
    let ext = extFromUrl(res.url || item.url);
    if (!ext) ext = /mp2t/i.test(type) ? '.ts' : /matroska/i.test(type) ? '.mkv' : /webm/i.test(type) ? '.webm' : '.mp4';
    const target = await uniquePath(folder, base, ext);
    const tmp = `${target}.part`;
    setTmp(tmp);
    item.total = Number(res.headers.get('content-length')) || 0;
    item.received = 0;

    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      item.received += chunk.length;
      item.progress = item.total ? item.received / item.total : 0;
      this.trackSpeed(item, chunk.length);
      this.notify();
    });
    await pipeline(source, fs.createWriteStream(tmp), { signal });
    await fsp.rename(tmp, target);
    return target;
  }

  async fetchText(url, signal) {
    return (await this.fetch(url, signal)).text();
  }

  async fetchBuffer(url, signal) {
    let lastErr;
    for (let attempt = 0; attempt < SEGMENT_RETRIES; attempt++) {
      if (signal.aborted) throw new Error('Cancelado');
      try {
        return Buffer.from(await (await this.fetch(url, signal)).arrayBuffer());
      } catch (err) {
        lastErr = err;
        if (signal.aborted) throw err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async downloadHls(item, folder, base, signal, setTmp) {
    let url = item.url;
    let text = await this.fetchText(url, signal);

    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const lines = text.split(/\r?\n/);
      let best = null;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const bw = Number(parseAttrs(lines[i]).BANDWIDTH) || 0;
        const uri = (lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#')) || '').trim();
        if (uri && (!best || bw > best.bw)) best = { bw, uri };
      }
      if (!best) throw new Error('Playlist HLS sem variantes');
      url = new URL(best.uri, url).href;
      text = await this.fetchText(url, signal);
    }
    if (!/#EXT-X-ENDLIST/i.test(text)) throw new Error('Transmissões ao vivo não podem ser baixadas');

    const segments = [];
    let mediaSeq = 0;
    let key = null;
    let mapUri = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = Number(line.split(':')[1]) || 0;
      else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line.slice(11));
        if (a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128') key = { uri: new URL(a.URI, url).href, iv: a.IV || null };
        else throw new Error(`Criptografia ${a.METHOD} não suportada para download`);
      } else if (line.startsWith('#EXT-X-MAP:')) {
        mapUri = new URL(parseAttrs(line.slice(11)).URI, url).href;
      } else if (!line.startsWith('#')) {
        segments.push({ uri: new URL(line, url).href, key, seq: mediaSeq + segments.length });
      }
    }
    if (!segments.length) throw new Error('Nenhum segmento encontrado');

    const target = await uniquePath(folder, base, mapUri ? '.mp4' : '.ts');
    const tmp = `${target}.part`;
    setTmp(tmp);
    const out = fs.createWriteStream(tmp);
    const write = async (buf) => {
      if (!out.write(buf)) await once(out, 'drain');
    };
    const keys = new Map();

    item.total = segments.length;
    item.received = 0;
    try {
      if (mapUri) await write(await this.fetchBuffer(mapUri, signal));
      for (const seg of segments) {
        let buf = await this.fetchBuffer(seg.uri, signal);
        if (seg.key) {
          if (!keys.has(seg.key.uri)) keys.set(seg.key.uri, await this.fetchBuffer(seg.key.uri, signal));
          let iv;
          if (seg.key.iv) iv = Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
          else {
            iv = Buffer.alloc(16);
            iv.writeUInt32BE(seg.seq, 12);
          }
          const decipher = crypto.createDecipheriv('aes-128-cbc', keys.get(seg.key.uri), iv);
          buf = Buffer.concat([decipher.update(buf), decipher.final()]);
        }
        await write(buf);
        item.received++;
        item.progress = item.received / item.total;
        this.trackSpeed(item, buf.length);
        this.notify();
      }
    } finally {
      out.end();
      await once(out, 'close');
    }
    await fsp.rename(tmp, target);
    return target;
  }

  // .ts não toca nativamente no Chromium; se o ffmpeg estiver disponível,
  // converte (sem recodificar) para .mp4 para permitir avanço/retrocesso offline.
  async remuxToMp4(input, item) {
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) return input;
    const output = await uniquePath(path.dirname(input), path.basename(input, '.ts'), '.mp4');
    const run = (args) =>
      new Promise((resolve) => {
        const p = spawn(ffmpeg, args, { windowsHide: true });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
      });
    const base = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy'];
    const ok =
      (await run([...base, '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', output])) ||
      (await run([...base, '-movflags', '+faststart', output]));
    if (!ok) {
      await fsp.unlink(output).catch(() => {});
      return input;
    }
    await fsp.unlink(input).catch(() => {});
    return output;
  }
}

module.exports = { DownloadManager };
