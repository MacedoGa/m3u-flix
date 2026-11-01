import { $, el, formatTime, icons, toast, escapeHtml } from './util.js';
import { episodeLabel } from './library.js';

// ---------- Carregamento dos motores de reprodução ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => {
      s.remove();
      reject(new Error(`Falha ao carregar ${src}`));
    };
    document.head.appendChild(s);
  });
}

async function loadFirst(globalName, sources) {
  if (window[globalName]) return window[globalName];
  for (const src of sources) {
    try {
      await loadScript(src);
      if (window[globalName]) return window[globalName];
    } catch {}
  }
  throw new Error(`Motor ${globalName} indisponível`);
}

const ensureHls = () =>
  loadFirst('Hls', ['vendor/hls.min.js', '../node_modules/hls.js/dist/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js']);
const ensureMpegts = () =>
  loadFirst('mpegts', ['vendor/mpegts.js', '../node_modules/mpegts.js/dist/mpegts.js', 'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.0/dist/mpegts.js']);

function engineOrder(url, kind) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.includes('.m3u8') || path.endsWith('.m3u')) return ['hls', 'native', 'mpegts'];
  if (path.endsWith('.ts') || path.endsWith('.mpegts')) return ['mpegts', 'hls', 'native'];
  if (/\.(mp4|m4v|webm|mov|mkv|ogg|ogv|mp3|aac)$/.test(path)) return ['native', 'hls', 'mpegts'];
  // URLs sem extensão (ex.: Xtream /live/user/pass/123) normalmente são MPEG-TS.
  return kind === 'live' ? ['mpegts', 'hls', 'native'] : ['native', 'hls', 'mpegts'];
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = $('#player');
    this.video = $('#video');
    this.queue = [];
    this.index = 0;
    this.item = null;
    this.hls = null;
    this.mpegts = null;
    this.autoplayCount = 0;
    this.idleTimer = null;
    this.countdownTimer = null;
    this.lastSave = 0;
    this.bindUi();
  }

  get isOpen() {
    return !this.root.hidden;
  }

  // ---------- UI ----------
  bindUi() {
    const v = this.video;
    const set = (id, icon) => ($(id).innerHTML = icons[icon]);
    set('#p-back', 'arrowLeft');
    set('#p-play', 'play');
    set('#p-back10', 'back10');
    set('#p-fwd10', 'fwd10');
    set('#p-mute', 'volume');
    set('#p-prev', 'prev');
    set('#p-nextbtn', 'next');
    set('#p-episodes', 'episodes');
    set('#p-markers', 'marker');
    set('#p-speed', 'speed');
    set('#p-download', 'download');
    set('#p-fs', 'fullscreen');
    set('#p-panel-close', 'close');

    $('#p-back').onclick = () => this.close();
    $('#p-play').onclick = () => this.togglePlay();
    $('#p-back10').onclick = () => this.seekBy(-10);
    $('#p-fwd10').onclick = () => this.seekBy(10);
    $('#p-mute').onclick = () => this.toggleMute();
    $('#p-vol').oninput = (e) => {
      v.volume = Number(e.target.value);
      v.muted = v.volume === 0;
    };
    $('#p-prev').onclick = () => this.playIndex(this.index - 1);
    $('#p-nextbtn').onclick = () => this.playNext(false);
    $('#p-episodes').onclick = () => this.togglePanel();
    $('#p-panel-close').onclick = () => this.togglePanel(false);
    $('#p-markers').onclick = () => this.toggleMenu('markers');
    $('#p-speed').onclick = () => this.toggleMenu('speed');
    $('#p-download').onclick = () => this.item && this.ctx.download(this.item);
    $('#p-fs').onclick = () => this.toggleFullscreen();
    $('#p-skip-intro').onclick = () => this.skipIntro();
    $('#p-next-play').onclick = () => this.playNext(false);
    $('#p-next-cancel').onclick = () => this.dismissNext();
    $('#p-still-yes').onclick = () => {
      this.autoplayCount = 0;
      $('#p-still').hidden = true;
      this.playNext(false);
    };
    $('#p-still-no').onclick = () => this.close();
    $('#p-error-retry').onclick = () => this.playIndex(this.index, { startAt: this.video.currentTime || undefined });
    $('#p-error-next').onclick = () => this.playIndex(this.index + 1);
    $('#p-error-back').onclick = () => this.close();

    v.addEventListener('click', () => this.togglePlay());
    v.addEventListener('dblclick', () => this.toggleFullscreen());
    v.addEventListener('play', () => this.syncPlayIcon());
    v.addEventListener('pause', () => {
      this.syncPlayIcon();
      this.showChrome();
      this.saveProgress(true);
    });
    v.addEventListener('waiting', () => this.root.classList.add('loading'));
    v.addEventListener('playing', () => {
      this.root.classList.remove('loading');
      this.started = true;
      // Depois de 30s tocando estável, zera o contador de reconexões.
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => (this.retries = 0), 30000);
    });
    v.addEventListener('canplay', () => this.root.classList.remove('loading'));
    v.addEventListener('loadedmetadata', () => this.onMetadata());
    v.addEventListener('timeupdate', () => this.onTime());
    v.addEventListener('progress', () => this.renderBuffered());
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('volumechange', () => {
      $('#p-mute').innerHTML = v.muted || v.volume === 0 ? icons.mute : icons.volume;
      $('#p-vol').value = v.muted ? 0 : v.volume;
      this.ctx.saveVolume(v.volume, v.muted);
    });
    v.addEventListener('error', () => {
      if (this.engine === 'native') this.fallback(v.error ? `Erro de mídia (código ${v.error.code})` : 'Erro de mídia');
    });

    this.root.addEventListener('mousemove', () => this.showChrome());
    this.root.addEventListener('mousedown', () => (this.autoplayCount = 0));
    document.addEventListener('fullscreenchange', () => {
      $('#p-fs').innerHTML = document.fullscreenElement ? icons.exitFullscreen : icons.fullscreen;
    });
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    this.root.addEventListener('click', (e) => {
      const menu = $('#p-menu');
      if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('#p-markers, #p-speed')) menu.hidden = true;
    });

    this.bindProgressBar();
  }

  bindProgressBar() {
    const bar = $('#p-progress');
    const ratioAt = (e) => {
      const r = bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    bar.addEventListener('mousemove', (e) => {
      const d = this.video.duration;
      if (!isFinite(d)) return;
      const ratio = ratioAt(e);
      const ht = $('#p-hover-time');
      ht.textContent = formatTime(ratio * d);
      ht.style.left = `${ratio * 100}%`;
    });
    bar.addEventListener('pointerdown', (e) => {
      if (!isFinite(this.video.duration)) return;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      this.dragging = true;
      const move = (ev) => this.renderPlayed(ratioAt(ev));
      const up = (ev) => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.classList.remove('dragging');
        this.dragging = false;
        this.video.currentTime = ratioAt(ev) * this.video.duration;
      };
      move(e);
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
  }

  showChrome() {
    this.root.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const busy = this.video.paused || !$('#p-menu').hidden || !$('#p-panel').hidden || this.root.matches(':has(.p-bottom:hover)');
      if (!busy) this.root.classList.add('idle');
    }, 3000);
  }

  flash(icon) {
    const f = $('#p-flash');
    f.innerHTML = icons[icon];
    f.classList.remove('show');
    void f.offsetWidth;
    f.classList.add('show');
  }

  syncPlayIcon() {
    $('#p-play').innerHTML = this.video.paused ? icons.play : icons.pause;
  }

  // ---------- Abrir / fechar ----------
  open({ queue, index = 0, startAt }) {
    this.queue = queue;
    this.autoplayCount = 0;
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    const { volume, muted } = this.ctx.getVolume();
    this.video.volume = volume;
    this.video.muted = muted;
    this.playIndex(index, { startAt });
    this.showChrome();
  }

  close() {
    this.saveProgress(true);
    this.stopCountdown();
    clearTimeout(this.retryTimer);
    this.loadToken = null;
    this.destroyEngine();
    this.video.removeAttribute('src');
    this.video.load();
    this.root.hidden = true;
    this.root.classList.remove('loading');
    $('#p-panel').hidden = true;
    $('#p-menu').hidden = true;
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.item = null;
    this.ctx.onClose();
  }

  playIndex(index, { startAt, auto = false } = {}) {
    if (index < 0 || index >= this.queue.length) return;
    if (this.item) this.saveProgress(true);
    this.stopCountdown();
    this.index = index;
    this.item = this.queue[index];
    this.nextDismissed = false;
    this.introSkipped = false;
    this.started = false;
    this.lastSave = 0;
    this.retries = 0;
    this.lastHttpCode = null;
    clearTimeout(this.retryTimer);
    if (!auto) this.autoplayCount = 0;

    const it = this.item;
    const isEp = it.kind === 'episode';
    const series = isEp ? this.ctx.getSeries(it.seriesId) : null;
    $('#p-title').textContent = isEp ? series?.name || it.name : it.name;
    $('#p-subtitle').textContent = isEp ? `${episodeLabel(it)} ${it.epTitle ? '· ' + it.epTitle : ''}` : it.group || '';
    $('#p-center-title').textContent = isEp ? `${series?.name || ''} ${episodeLabel(it)}` : it.name;
    $('#p-next').hidden = true;
    $('#p-still').hidden = true;
    $('#p-error').hidden = true;
    $('#p-skip-intro').classList.remove('show');
    $('#p-prev').disabled = index === 0;
    $('#p-nextbtn').disabled = index >= this.queue.length - 1;
    $('#p-prev').hidden = $('#p-nextbtn').hidden = this.queue.length < 2;
    $('#p-episodes').hidden = this.queue.length < 2;
    $('#p-episodes').title = it.kind === 'live' ? 'Canais' : 'Episódios';
    $('#p-markers').hidden = !isEp;
    $('#p-download').hidden = it.kind === 'live' || !this.ctx.canDownload;
    $('#p-download').innerHTML = this.ctx.downloadState(it) === 'done' ? icons.check : icons.download;
    this.video.playbackRate = 1;
    this.renderPlayed(0);
    $('#p-buffered').style.width = '0';
    $('#p-intro-mark').hidden = true;
    $('#p-time').textContent = '0:00 / 0:00';
    $('#p-live').hidden = it.kind !== 'live';
    $('#p-progress').style.visibility = it.kind === 'live' ? 'hidden' : '';
    if (!$('#p-panel').hidden) this.renderPanel();

    // Retomar de onde parou (como a Netflix).
    let resumeAt = startAt;
    if (resumeAt == null && it.kind !== 'live') {
      const p = this.ctx.getProgress(it.id);
      if (p && p.t > 10 && p.d && p.t < p.d * 0.95) resumeAt = p.t;
    }
    this.pendingSeek = resumeAt;

    const local = this.ctx.localFile(it);
    const url = local || it.url;
    if (!local && it.headers && window.api) window.api.setStreamHeaders(url, it.headers);
    this.engines = engineOrder(url, it.kind);
    this.engineIdx = 0;
    this.url = url;
    this.root.classList.add('loading');
    this.startEngine();
  }

  // ---------- Motores ----------
  destroyEngine() {
    clearTimeout(this.loadTimer);
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.mpegts) {
      try {
        this.mpegts.pause();
        this.mpegts.unload();
        this.mpegts.detachMediaElement();
        this.mpegts.destroy();
      } catch {}
      this.mpegts = null;
    }
    // load() sem src encerra de vez o download anterior; senão a conexão continua aberta
    // e ocupa uma "tela" da assinatura IPTV.
    if (this.video.getAttribute('src')) {
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.engine = null;
  }

  async startEngine() {
    const type = this.engines[this.engineIdx];
    const token = (this.loadToken = Symbol());
    this.destroyEngine();
    if (!type) return;
    // Links IPTV mortos às vezes não geram erro (a playlist só vem vazia): desiste após 25s.
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      if (token === this.loadToken && !this.started && this.isOpen) this.fallback('Tempo esgotado ao conectar');
    }, 25000);
    const isLive = this.item.kind === 'live';
    const lowLatencyLive = isLive && this.ctx.settings().lowLatencyLive;
    try {
      if (type === 'hls') {
        const Hls = await ensureHls();
        if (token !== this.loadToken) return;
        if (!Hls.isSupported()) throw new Error('HLS não suportado');
        const hls = new Hls({ enableWorker: true, lowLatencyMode: lowLatencyLive, maxBufferLength: 60, backBufferLength: 90 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (this.started && data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else this.fallback(`HLS: ${data.details}`, { httpCode: data.response?.code });
        });
        this.hls = hls;
        this.engine = 'hls';
        hls.loadSource(this.url);
        hls.attachMedia(this.video);
      } else if (type === 'mpegts') {
        const mpegts = await ensureMpegts();
        if (token !== this.loadToken) return;
        if (!mpegts.isSupported()) throw new Error('MPEG-TS não suportado');
        const p = mpegts.createPlayer(
          { type: 'mpegts', isLive, url: this.url },
          { enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: lowLatencyLive, autoCleanupSourceBuffer: true }
        );
        p.on(mpegts.Events.ERROR, (type, detail, info) => this.fallback(`MPEG-TS: ${type} ${detail || ''}`, { httpCode: info?.code }));
        this.mpegts = p;
        this.engine = 'mpegts';
        p.attachMediaElement(this.video);
        p.load();
      } else {
        this.engine = 'native';
        this.video.src = this.url;
      }
      const playPromise = this.video.play();
      if (playPromise) playPromise.catch(() => {});
    } catch (err) {
      this.fallback(err.message);
    }
  }

  fallback(message, { httpCode } = {}) {
    const code = Number(httpCode) > 0 ? Number(httpCode) : null;
    if (code) this.lastHttpCode = code;
    // A conexão caiu durante a reprodução (comum em IPTV): reconecta no mesmo motor.
    if (this.started) {
      const max = this.item.kind === 'live' ? 4 : 2;
      if (this.retries < max) return this.reconnect();
      return this.showError(message);
    }
    // O servidor respondeu com erro HTTP: os outros motores pediriam a mesma URL,
    // então só tenta mais uma vez (falhas momentâneas) antes de mostrar o erro.
    if (code >= 400) {
      if (this.retries < 1) return this.reconnect();
      return this.showError(message);
    }
    this.engineIdx++;
    if (this.engineIdx < this.engines.length) this.startEngine();
    else this.showError(message);
  }

  reconnect() {
    this.retries++;
    this.started = false;
    this.pendingSeek = this.item.kind === 'live' ? null : this.video.currentTime || this.pendingSeek;
    this.destroyEngine();
    this.root.classList.add('loading');
    toast(`Conexão perdida — reconectando (${this.retries})...`, 1800);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.isOpen && this.startEngine(), 1200 * this.retries);
  }

  showError(message) {
    this.destroyEngine();
    this.root.classList.remove('loading');
    const code = this.lastHttpCode;
    const kindLabel = this.item?.kind === 'live' ? 'Este canal' : 'Este vídeo';
    let text;
    if (code === 404 || code === 410) text = `${kindLabel} está fora do ar no servidor do provedor (erro ${code}). Tente outro canal ou mais tarde.`;
    else if (code === 401 || code === 403)
      text = `O servidor negou o acesso (erro ${code}). Pode ser o limite de telas da sua assinatura — feche o app ou a TV em outros aparelhos — ou a assinatura expirou.`;
    else if (code === 429 || code === 456 || code === 509) text = `Limite de conexões da assinatura atingido (erro ${code}). Feche a reprodução em outros aparelhos e tente de novo.`;
    else if (code >= 500) text = `O servidor do provedor está com problema (erro ${code}). Tente de novo em instantes.`;
    else if (code) text = `O servidor respondeu com erro ${code}.`;
    else
      text =
        `${message || 'Erro desconhecido'}. Verifique se o link está ativo. ` +
        'Alguns formatos (ex.: MKV com áudio AC3/DTS ou HEVC) podem não ser suportados pelo player embutido.';
    $('#p-error-msg').textContent = text;
    $('#p-error-next').hidden = this.index >= this.queue.length - 1;
    $('#p-error').hidden = false;
  }

  // ---------- Eventos de tempo ----------
  onMetadata() {
    const live = !isFinite(this.video.duration) || this.item?.kind === 'live';
    $('#p-progress').style.visibility = live ? 'hidden' : '';
    $('#p-time').hidden = live;
    $('#p-back10').hidden = $('#p-fwd10').hidden = live;
    $('#p-live').hidden = !live;
    if (this.pendingSeek && !live) {
      this.video.currentTime = this.pendingSeek;
    }
    this.pendingSeek = null;
    this.renderIntroMark();
  }

  onTime() {
    const v = this.video;
    const t = v.currentTime;
    const d = v.duration;
    if (!isFinite(d)) return;
    if (!this.dragging) this.renderPlayed(t / d);
    $('#p-time').textContent = `${formatTime(t)} / ${formatTime(d)}`;
    this.saveProgress(false);
    if (this.item.kind !== 'episode') return;

    // Pular abertura
    const intro = this.introRange(d);
    const inIntro = intro && t >= intro.start && t < intro.end - 1;
    if (inIntro && intro.marked && this.ctx.settings().autoSkipIntro && !this.introSkipped) {
      this.introSkipped = true;
      v.currentTime = intro.end;
      toast('Abertura pulada');
    }
    $('#p-skip-intro').classList.toggle('show', !!inIntro);

    // Próximo episódio
    const hasNext = this.index < this.queue.length - 1;
    if (!hasNext || this.nextDismissed) return;
    const remaining = d - t;
    if (remaining <= this.creditsWindow(d) && $('#p-next').hidden && $('#p-still').hidden) this.showNextCard();
  }

  introRange(d) {
    const marks = this.ctx.getMarks(this.item.seriesId) || {};
    if (marks.introEnd != null) return { start: marks.introStart || 0, end: marks.introEnd, marked: true };
    const def = Number(this.ctx.settings().introDefault) || 0;
    if (!def || d < def * 3) return null;
    return { start: 3, end: def, marked: false };
  }

  creditsWindow(d) {
    const marks = this.ctx.getMarks(this.item.seriesId) || {};
    const cfg = Number(this.ctx.settings().creditsSeconds);
    const secs = marks.creditsFromEnd ?? (isFinite(cfg) ? cfg : 20);
    return Math.min(secs, d * 0.25);
  }

  skipIntro() {
    const intro = this.introRange(this.video.duration);
    if (intro) this.video.currentTime = intro.end;
    $('#p-skip-intro').classList.remove('show');
  }

  renderPlayed(ratio) {
    $('#p-played').style.width = `${ratio * 100}%`;
    $('#p-thumb').style.left = `${ratio * 100}%`;
  }

  renderBuffered() {
    const v = this.video;
    if (!isFinite(v.duration) || !v.buffered.length) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 1) end = Math.max(end, v.buffered.end(i));
    }
    $('#p-buffered').style.width = `${(end / v.duration) * 100}%`;
  }

  renderIntroMark() {
    const m = $('#p-intro-mark');
    const d = this.video.duration;
    const marks = this.item?.kind === 'episode' ? this.ctx.getMarks(this.item.seriesId) : null;
    if (!marks || marks.introEnd == null || !isFinite(d)) {
      m.hidden = true;
      return;
    }
    m.hidden = false;
    m.style.left = `${((marks.introStart || 0) / d) * 100}%`;
    m.style.width = `${((marks.introEnd - (marks.introStart || 0)) / d) * 100}%`;
  }

  saveProgress(force) {
    if (!this.item || this.item.kind === 'live') return;
    const v = this.video;
    if (!isFinite(v.duration) || v.currentTime < 1) return;
    const now = Date.now();
    if (!force && now - this.lastSave < 5000) return;
    this.lastSave = now;
    this.ctx.saveProgress(this.item, v.currentTime, v.duration);
  }

  // ---------- Próximo episódio ----------
  showNextCard() {
    const next = this.queue[this.index + 1];
    const settings = this.ctx.settings();
    $('#p-next-title').textContent = `${episodeLabel(next)} ${next.epTitle ? '· ' + next.epTitle : ''}`;
    $('#p-next-thumb').style.backgroundImage = next.logo ? `url("${encodeURI(next.logo)}")` : '';
    $('#p-next').hidden = false;
    const ring = $('#p-next-play .ring');
    ring.hidden = !settings.autoplayNext;
    if (!settings.autoplayNext) return;

    const total = Math.max(3, Number(settings.countdown) || 10);
    let left = total;
    const render = () => {
      $('#p-next-count').textContent = left;
      $('#p-next-ring').style.strokeDashoffset = String(100.5 * (1 - left / total));
    };
    render();
    this.stopCountdown();
    this.countdownTimer = setInterval(() => {
      left--;
      render();
      if (left <= 0) {
        this.stopCountdown();
        this.playNext(true);
      }
    }, 1000);
  }

  stopCountdown() {
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  dismissNext() {
    this.nextDismissed = true;
    this.stopCountdown();
    $('#p-next').hidden = true;
  }

  onEnded() {
    this.saveProgress(true);
    const hasNext = this.index < this.queue.length - 1;
    if (this.item.kind === 'episode' && hasNext && this.ctx.settings().autoplayNext) this.playNext(true);
    else if (hasNext && this.item.kind === 'episode') this.showNextCard();
    else this.showChrome();
  }

  playNext(auto) {
    if (this.index >= this.queue.length - 1) return;
    this.stopCountdown();
    if (auto) {
      this.autoplayCount++;
      const limit = Number(this.ctx.settings().stillWatchingAfter) || 0;
      if (limit && this.autoplayCount >= limit) {
        this.video.pause();
        $('#p-next').hidden = true;
        $('#p-still').hidden = false;
        return;
      }
    }
    this.playIndex(this.index + 1, { auto, startAt: 0 });
  }

  // ---------- Controles ----------
  togglePlay() {
    if (!this.item || !$('#p-error').hidden) return;
    if (this.video.paused) {
      this.video.play().catch(() => {});
      this.flash('play');
    } else {
      this.video.pause();
      this.flash('pause');
    }
  }

  seekBy(sec) {
    const v = this.video;
    if (!isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration - 0.5, Math.max(0, v.currentTime + sec));
    this.flash(sec > 0 ? 'fwd10' : 'back10');
    this.showChrome();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.5;
  }

  changeVolume(delta) {
    const v = this.video;
    v.muted = false;
    v.volume = Math.min(1, Math.max(0, v.volume + delta));
    toast(`Volume ${Math.round(v.volume * 100)}%`, 900);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.root.requestFullscreen().catch(() => {});
  }

  togglePanel(force) {
    const panel = $('#p-panel');
    const show = force ?? panel.hidden;
    panel.hidden = !show;
    $('#p-menu').hidden = true;
    if (show) this.renderPanel();
  }

  renderPanel() {
    const body = $('#p-panel-body');
    const it = this.item;
    $('#p-panel-title').textContent = it.kind === 'live' ? it.group || 'Canais' : it.kind === 'episode' ? `Temporada ${it.season}` : 'Fila';
    body.innerHTML = '';
    const list = it.kind === 'episode' ? this.queue.filter((e) => e.season === it.season) : this.queue;
    for (const entry of list) {
      const idx = this.queue.indexOf(entry);
      const p = this.ctx.getProgress(entry.id);
      const pct = p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0;
      const row = el(
        'button',
        { class: `episode${idx === this.index ? ' current' : ''}`, onclick: () => this.playIndex(idx) },
        el('div', { class: 'num', text: entry.kind === 'episode' ? entry.episode : idx + 1 }),
        el(
          'div',
          { class: 'thumb' },
          entry.logo ? el('img', { src: entry.logo, loading: 'lazy', onerror: (e) => e.target.remove() }) : null,
          pct ? el('div', { class: 'bar' }, el('div', { style: { width: pct + '%' } })) : null
        ),
        el(
          'div',
          {},
          el('div', { class: 'ep-title', text: entry.kind === 'episode' ? entry.epTitle || `Episódio ${entry.episode}` : entry.name }),
          entry.kind === 'episode' ? el('div', { class: 'ep-sub', text: episodeLabel(entry) }) : null
        )
      );
      body.append(row);
      if (idx === this.index) requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
    }
  }

  toggleMenu(type) {
    const menu = $('#p-menu');
    if (!menu.hidden && menu.dataset.type === type) {
      menu.hidden = true;
      return;
    }
    $('#p-panel').hidden = true;
    menu.dataset.type = type;
    menu.innerHTML = '';
    if (type === 'speed') {
      menu.append(el('h4', { text: 'Velocidade' }));
      for (const s of SPEEDS) {
        menu.append(
          el('button', {
            class: this.video.playbackRate === s ? 'sel' : '',
            text: s === 1 ? 'Normal' : `${s}x`,
            onclick: () => {
              this.video.playbackRate = s;
              menu.hidden = true;
            },
          })
        );
      }
    } else {
      const sid = this.item.seriesId;
      const marks = { ...(this.ctx.getMarks(sid) || {}) };
      const now = () => Math.floor(this.video.currentTime);
      const update = (patch, msg) => {
        Object.assign(marks, patch);
        if (marks.introEnd != null && (marks.introStart || 0) >= marks.introEnd) marks.introStart = 0;
        this.ctx.setMarks(sid, marks);
        this.renderIntroMark();
        menu.hidden = true;
        toast(msg);
      };
      menu.append(
        el('h4', { text: 'Marcações da série' }),
        el('button', { text: `Início da abertura aqui (${formatTime(now())})`, onclick: () => update({ introStart: now() }, 'Início da abertura marcado') }),
        el('button', { text: `Fim da abertura aqui (${formatTime(now())})`, onclick: () => update({ introEnd: now() }, 'Fim da abertura marcado — valerá para todos os episódios') }),
        el('button', {
          text: `Créditos começam aqui (${formatTime(now())})`,
          onclick: () => update({ creditsFromEnd: Math.max(5, Math.floor(this.video.duration - this.video.currentTime)) }, 'Início dos créditos marcado'),
        }),
        el('button', {
          text: 'Limpar marcações',
          onclick: () => {
            this.ctx.setMarks(sid, null);
            this.renderIntroMark();
            menu.hidden = true;
            toast('Marcações removidas');
          },
        })
      );
      if (marks.introEnd != null) {
        menu.append(el('h4', { html: `Abertura: ${escapeHtml(formatTime(marks.introStart || 0))} – ${escapeHtml(formatTime(marks.introEnd))}` }));
      }
    }
    menu.hidden = false;
  }

  onKey(e) {
    if (!this.isOpen) return;
    if (e.target.matches('input[type=text], input[type=search]')) return;
    this.autoplayCount = 0;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack') {
      handled();
      if (!$('#p-menu').hidden) $('#p-menu').hidden = true;
      else if (!$('#p-panel').hidden) $('#p-panel').hidden = true;
      else if (document.fullscreenElement) document.exitFullscreen();
      else this.close();
      return;
    }
    // Deixa Enter/Espaço acionarem botões focados no painel/menu.
    if ((k === 'Enter' || k === ' ') && e.target.closest('#p-panel, #p-menu, .p-overlay-msg, .p-next, .p-skip-intro')) return;
    switch (k) {
      case ' ':
      case 'k':
      case 'K':
      case 'MediaPlayPause':
      case 'Enter':
        handled();
        this.togglePlay();
        break;
      case 'ArrowLeft':
        handled();
        this.seekBy(-10);
        break;
      case 'ArrowRight':
        handled();
        this.seekBy(10);
        break;
      case 'ArrowUp':
        handled();
        this.changeVolume(0.05);
        break;
      case 'ArrowDown':
        handled();
        this.changeVolume(-0.05);
        break;
      case 'f':
      case 'F':
        handled();
        this.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        handled();
        this.toggleMute();
        break;
      case 'n':
      case 'N':
      case 'MediaTrackNext':
      case 'ChannelUp':
        handled();
        this.playNext(false);
        break;
      case 'p':
      case 'P':
      case 'MediaTrackPrevious':
      case 'ChannelDown':
        handled();
        this.playIndex(this.index - 1);
        break;
      case 's':
      case 'S':
        if ($('#p-skip-intro').classList.contains('show')) {
          handled();
          this.skipIntro();
        }
        break;
      case 'e':
      case 'E':
        handled();
        this.togglePanel();
        break;
      default:
        return;
    }
    this.showChrome();
  }
}
