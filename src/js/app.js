import { $, $$, el, icons, toast, formatBytes, formatTime } from './util.js';
import { parseM3U } from './m3u.js';
import { buildLibrary, searchLibrary, episodeLabel, hash } from './library.js';
import { load, save, saveNow } from './store.js';
import { Player } from './player.js';
import { initSpatialNav } from './spatial.js';
import { SAMPLE_M3U } from './sample.js';

const api = window.api;
const ROW_LIMIT = 60;
const HOME_GROUPS_PER_KIND = 8;

const DEFAULT_SETTINGS = {
  autoplayNext: true,
  countdown: 10,
  creditsSeconds: 20,
  introDefault: 85,
  autoSkipIntro: false,
  stillWatchingAfter: 3,
  hideAdult: true,
  lowLatencyLive: false,
  userAgent: '',
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  playlists: [],
  activeId: null,
  lib: null,
  rawItems: null,
  progress: {},
  marks: {},
  myList: [],
  volume: { volume: 1, muted: false },
  downloads: [],
  view: 'home',
  viewArg: null,
};

let player;
let rowObserver;
let searchTimer;
let playlistLoadCount = 0;

// =====================================================================
// Inicialização
// =====================================================================
async function init() {
  const [settings, playlists, activeId, progress, marks, myList, volume] = await Promise.all([
    load('settings', {}),
    load('playlists', []),
    load('activePlaylist', null),
    load('progress', {}),
    load('marks', {}),
    load('mylist', []),
    load('volume', { volume: 1, muted: false }),
  ]);
  Object.assign(state, { playlists, activeId, progress, marks, myList, volume });
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  applyNetConfig();

  $('.search-icon').innerHTML = icons.search;
  $('#btn-playlists').innerHTML = icons.list;
  $('#btn-settings').innerHTML = icons.settings;
  $('#btn-playlists').onclick = openPlaylistsModal;
  $('#btn-settings').onclick = openSettingsModal;

  $$('[data-nav]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (playlistLoadCount) return;
      $('#search-input').value = '';
      $('#search').classList.remove('has-value');
      navigate(a.dataset.nav);
    })
  );
  $('[data-nav="home"].brand').addEventListener('keydown', (e) => !playlistLoadCount && e.key === 'Enter' && navigate('home'));

  $('#search-input').addEventListener('input', (e) => {
    const q = e.target.value;
    $('#search').classList.toggle('has-value', !!q);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => (q.trim() ? navigate('search', q) : navigate('home')), 250);
  });

  window.addEventListener('scroll', () => $('#topbar').classList.toggle('solid', window.scrollY > 20), { passive: true });

  document.addEventListener('keydown', (e) => {
    if (player.isOpen) return;
    if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack') {
      const top = $('#modal-root .modal-backdrop:last-child');
      if (top) {
        e.preventDefault();
        top._close();
      }
    } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      $('#search-input').focus();
    }
  });

  rowObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          rowObserver.unobserve(entry.target);
          entry.target._fill?.();
        }
      }
    },
    { rootMargin: '600px 0px' }
  );

  player = new Player(playerContext());
  initSpatialNav(() => player.isOpen);

  if (api) {
    state.downloads = await api.downloads.list();
    api.downloads.onUpdate((list) => {
      const doneSig = (l) => l.filter((d) => d.status === 'done').map((d) => d.id).join('|');
      const finishedNow = doneSig(list) !== doneSig(state.downloads);
      state.downloads = list;
      if (finishedNow && currentDetail && document.contains(currentDetail.modal)) currentDetail.refresh();
      updateDownloadBadge();
      if (state.view === 'downloads' && !player.isOpen) renderDownloads(true);
    });
    updateDownloadBadge();
  }

  const active = state.playlists.find((p) => p.id === state.activeId) || state.playlists[0];
  if (active) await loadPlaylist(active);
  else renderWelcome();
}

function applyNetConfig() {
  api?.setNetConfig({ userAgent: state.settings.userAgent || '' });
}

// =====================================================================
// Listas M3U
// =====================================================================
async function fetchPlaylistText(pl) {
  if (pl.type === 'sample') return SAMPLE_M3U;
  if (pl.type === 'text') return pl.content || '';
  if (pl.type === 'file') {
    if (!api) throw new Error('Arquivo local indisponível');
    return api.readPlaylistFile(pl.path);
  }
  // No Electron o processo principal já grava a cópia offline ao baixar.
  if (api) return api.fetchPlaylist(pl.url, pl.id);
  const res = await fetch(pl.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!isHtmlPage(text)) saveNow(`cache_${pl.id}`, text);
  return text;
}

function readCachedPlaylist(pl) {
  if (pl.type !== 'url') return null;
  return api ? api.readPlaylistCache(pl.id) : load(`cache_${pl.id}`, null);
}

function deleteCachedPlaylist(pl) {
  if (api) api.deletePlaylistCache(pl.id);
  else saveNow(`cache_${pl.id}`, null);
}

function setTopNavigationDisabled(disabled) {
  $('#topbar').classList.toggle('nav-disabled', disabled);
  $$('[data-nav]').forEach((item) => {
    item.inert = disabled;
    item.setAttribute('aria-disabled', String(disabled));
  });
}

async function loadPlaylist(pl, options = {}) {
  playlistLoadCount++;
  setTopNavigationDisabled(true);
  try {
    await loadPlaylistContent(pl, options);
  } finally {
    playlistLoadCount--;
    setTopNavigationDisabled(playlistLoadCount > 0);
  }
}

async function loadPlaylistContent(pl, { force = false } = {}) {
  $('#view').innerHTML = '';
  const status = el('div', { text: `Carregando "${pl.name}"...` });
  $('#view').append(el('div', { class: 'loader' }, el('div', { class: 'spinner' }), status));
  let text = null;
  let reason = '';
  try {
    text = await fetchPlaylistText(pl);
    if (isHtmlPage(text)) {
      // O servidor devolveu uma página web (ex.: "Welcome to nginx!") em vez da lista.
      reason = htmlPageHint(pl);
      text = force ? null : await readCachedPlaylist(pl);
      if (text) toast('O link devolveu uma página web — usando a última cópia salva da lista', 5000);
    }
  } catch (err) {
    text = force ? null : await readCachedPlaylist(pl);
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (!text) reason = /ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)
      ? 'O endereço do servidor não existe (domínio não encontrado). Peça ao seu provedor o link atualizado.'
      : `Erro ao baixar a lista: ${msg}.`;
    else toast('Sem conexão com a lista — usando cópia salva', 4000);
  }
  status.textContent = 'Organizando séries, filmes e canais...';
  await new Promise((r) => setTimeout(r, 30)); // deixa a mensagem aparecer antes do processamento pesado
  const items = parseM3U(text || '', pl.type === 'url' ? pl.url : '');
  text = null;
  if (!items.length) {
    state.lib = null;
    state.rawItems = null;
    renderWelcome(pl, reason || 'O arquivo foi baixado, mas não contém nenhum canal, filme ou episódio (#EXTINF).');
    return;
  }
  state.activeId = pl.id;
  saveNow('activePlaylist', pl.id);
  state.rawItems = items;
  rebuildLibrary();
  navigate(state.view === 'downloads' || state.view === 'search' ? 'home' : state.view, state.viewArg);
}

function rebuildLibrary() {
  if (!state.rawItems) return;
  state.lib = buildLibrary(state.rawItems, { hideAdult: state.settings.hideAdult });
}

async function addPlaylist(pl) {
  pl.id = 'p' + hash(`${pl.type}|${pl.url || pl.path || ''}|${Date.now()}`);
  pl.addedAt = Date.now();
  state.playlists.push(pl);
  await saveNow('playlists', state.playlists);
  closeAllModals();
  await loadPlaylist(pl);
}

function isHtmlPage(text) {
  if (!text || /#EXTINF/i.test(text.slice(0, 200000))) return false;
  return /^\s*(<!doctype html|<html|<head|<body|<\?xml|<)/i.test(text);
}

function htmlPageHint(pl) {
  let bare = false;
  try {
    const u = new URL(pl.url);
    bare = (u.pathname === '/' || u.pathname === '') && !u.search;
  } catch {}
  return bare
    ? 'Esse endereço é só a página inicial do servidor, não a lista. Use o link completo da lista ' +
        '(ex.: http://servidor:porta/get.php?username=...&password=...&type=m3u_plus) ' +
        'ou a aba "Usuário e senha" com os dados que seu provedor enviou.'
    : 'O servidor respondeu com uma página web em vez de uma lista M3U. Confira se o link, o usuário e a senha estão corretos e se a assinatura está ativa.';
}

// Login no formato Xtream Codes (o mais comum entre provedores IPTV).
function xtreamUrl(server, user, pass) {
  let s = server.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  const base = `${u.protocol}//${u.host}`;
  const params = new URLSearchParams({ username: user.trim(), password: pass.trim(), type: 'm3u_plus', output: 'ts' });
  return `${base}/get.php?${params}`;
}

async function addXtreamPlaylist(server, user, pass, name) {
  if (!server.trim() || !user.trim() || !pass.trim()) return toast('Preencha servidor, usuário e senha');
  let url;
  try {
    url = xtreamUrl(server, user, pass);
  } catch {
    return toast('Endereço do servidor inválido');
  }
  await addPlaylist({ type: 'url', url, name: name?.trim() || new URL(url).hostname });
}

async function addUrlPlaylist(url, name) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Informe uma URL começando com http:// ou https://');
  let label = name?.trim();
  if (!label) {
    try {
      label = new URL(url).hostname;
    } catch {
      label = 'Minha lista';
    }
  }
  await addPlaylist({ type: 'url', url, name: label });
}

async function addFilePlaylist() {
  if (api) {
    const f = await api.openPlaylistFile();
    if (f) await addPlaylist({ type: 'file', path: f.path, name: f.name });
    return;
  }
  const input = el('input', { type: 'file', accept: '.m3u,.m3u8,.txt' });
  input.onchange = async () => {
    const file = input.files[0];
    if (file) await addPlaylist({ type: 'text', content: await file.text(), name: file.name.replace(/\.[^.]+$/, '') });
  };
  input.click();
}

function addSamplePlaylist() {
  const existing = state.playlists.find((p) => p.type === 'sample');
  if (existing) {
    closeAllModals();
    return loadPlaylist(existing);
  }
  return addPlaylist({ type: 'sample', name: 'Lista de exemplo' });
}

function playlistAddForm() {
  const urlInput = el('input', { class: 'input', type: 'url', placeholder: 'https://servidor.com/lista.m3u', 'data-focusable': true });
  const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'Nome da lista (opcional)', 'data-focusable': true });
  const submit = () => addUrlPlaylist(urlInput.value, nameInput.value);
  urlInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

  const serverInput = el('input', { class: 'input', type: 'text', placeholder: 'Servidor (ex.: http://servidor.com:8080)', 'data-focusable': true });
  const userInput = el('input', { class: 'input', type: 'text', placeholder: 'Usuário', autocomplete: 'off', 'data-focusable': true });
  const passInput = el('input', { class: 'input', type: 'password', placeholder: 'Senha', autocomplete: 'off', 'data-focusable': true });
  const submitXtream = () => addXtreamPlaylist(serverInput.value, userInput.value, passInput.value, nameInput.value);
  passInput.addEventListener('keydown', (e) => e.key === 'Enter' && submitXtream());

  const urlPane = el('div', { class: 'url-form' }, urlInput, el('button', { class: 'btn btn-red', onclick: submit, text: 'Adicionar' }));
  const xtreamPane = el(
    'div',
    { class: 'xtream-form', hidden: true },
    serverInput,
    el('div', { class: 'xtream-row' }, userInput, passInput),
    el('button', { class: 'btn btn-red', onclick: submitXtream, text: 'Entrar' })
  );
  const tabUrl = el('button', { class: 'chip active', text: 'Link M3U' });
  const tabXtream = el('button', { class: 'chip', text: 'Usuário e senha' });
  const showTab = (xtream) => {
    urlPane.hidden = xtream;
    xtreamPane.hidden = !xtream;
    tabUrl.classList.toggle('active', !xtream);
    tabXtream.classList.toggle('active', xtream);
    (xtream ? serverInput : urlInput).focus();
  };
  tabUrl.onclick = () => showTab(false);
  tabXtream.onclick = () => showTab(true);

  return el(
    'div',
    { class: 'pl-add' },
    el('div', { class: 'chips', style: { margin: '0', justifyContent: 'center' } }, tabUrl, tabXtream),
    nameInput,
    urlPane,
    xtreamPane,
    el(
      'div',
      { class: 'row-btns' },
      el('button', { class: 'btn btn-gray btn-sm', onclick: addFilePlaylist, html: `${icons.folder} Abrir arquivo .m3u` }),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: addSamplePlaylist, html: `${icons.play} Lista de exemplo` })
    )
  );
}

// =====================================================================
// Navegação / telas
// =====================================================================
function navigate(view, arg = null) {
  state.view = view;
  state.viewArg = arg;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  if (view !== 'search') window.scrollTo(0, 0);
  if (view === 'downloads') return renderDownloads();
  if (!state.lib) return renderWelcome();
  const renderers = { home: renderHome, series: renderSeriesPage, movies: renderMoviesPage, live: renderLivePage, mylist: renderMyList, search: renderSearch, group: renderGroup };
  (renderers[view] || renderHome)(arg);
}

function rerenderKeepingScroll() {
  const y = window.scrollY;
  navigate(state.view, state.viewArg);
  window.scrollTo(0, y);
}

function setView(...children) {
  const view = $('#view');
  view.innerHTML = '';
  view.append(...children);
}

function renderWelcome(failed, reason) {
  $$('.nav a').forEach((a) => a.classList.remove('active'));
  setView(
    el(
      'div',
      { class: 'empty' },
      el('h1', { text: failed ? `Não foi possível abrir "${failed.name}"` : 'Bem-vindo ao M3U Flix' }),
      el('p', {
        text: failed
          ? reason || 'Verifique o endereço ou adicione outra lista.'
          : 'Adicione sua lista M3U/M3U8 por URL ou arquivo. Séries, filmes e canais são organizados automaticamente.',
      }),
      failed
        ? el('div', { class: 'row-btns', style: { justifyContent: 'center', marginBottom: '24px' } },
            el('button', { class: 'btn btn-white btn-sm', html: `${icons.refresh} Tentar de novo`, onclick: () => loadPlaylist(failed, { force: true }) }),
            el('button', { class: 'btn btn-ghost btn-sm', html: `${icons.list} Gerenciar listas`, onclick: openPlaylistsModal }))
        : null,
      playlistAddForm()
    )
  );
}

// ---------- Cards ----------
function progressRatio(id) {
  const p = state.progress[id];
  return p && p.d ? Math.min(1, p.t / p.d) : 0;
}

function makeCard(item, opts = {}) {
  const wide = item.kind === 'live';
  const display = opts.series || item;
  const title = display.name;
  const logo = display.logo;
  const card = el('button', { class: `card${wide ? ' wide' : ''}`, title, 'data-focusable': true });
  const fallback = el('div', { class: 'card-fallback', text: title });
  if (logo) {
    const img = el('img', { src: logo, loading: 'lazy', alt: '', decoding: 'async' });
    img.onerror = () => img.replaceWith(fallback);
    card.append(img);
  } else card.append(fallback);

  let sub = '';
  if (item.kind === 'series') sub = `${item.seasons.length} temporada${item.seasons.length > 1 ? 's' : ''} · ${item.episodes.length} ep.`;
  else if (item.kind === 'episode') sub = `${episodeLabel(item)}${item.epTitle ? ' · ' + item.epTitle : ''}`;
  else if (item.kind === 'live') sub = item.group;
  else if (item.kind === 'movie') sub = item.group;
  card.append(el('div', { class: 'card-info' }, title, sub ? el('small', { text: sub }) : null));

  if (item.kind === 'live') card.append(el('span', { class: 'card-tag', text: 'AO VIVO' }));
  if (downloadOf(item)?.status === 'done') card.append(el('span', { class: 'card-dl', html: icons.download }));
  const ratio = opts.ratio ?? (item.kind === 'movie' ? progressRatio(item.id) : 0);
  if (ratio > 0.01) card.append(el('div', { class: 'card-progress' }, el('div', { style: { width: `${ratio * 100}%` } })));

  card.onclick = opts.onClick || (() => openItem(item));
  return card;
}

function openItem(item) {
  if (item.kind === 'series') openSeriesDetail(item);
  else if (item.kind === 'movie') openMovieDetail(item);
  else if (item.kind === 'live') playLive(item);
  else if (item.kind === 'episode') playEpisode(item);
}

// ---------- Linhas ----------
function makeRow({ title, items, more }) {
  const track = el('div', { class: 'row-track' });
  const scrollBy = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  const row = el(
    'section',
    { class: 'row' },
    el('div', { class: 'row-head' }, el('h2', { class: 'row-title', text: title }), more ? el('button', { class: 'row-more', text: 'Ver tudo ›', onclick: more }) : null),
    el(
      'div',
      { class: 'row-viewport' },
      el('button', { class: 'row-arrow left', html: icons.arrowLeft, tabindex: '-1', onclick: () => scrollBy(-1) }),
      track,
      el('button', { class: 'row-arrow right', html: icons.arrowRight, tabindex: '-1', onclick: () => scrollBy(1) })
    )
  );
  const placeholderKind = items[0]?.item?.kind || items[0]?.kind;
  track.style.minHeight = placeholderKind === 'live' ? 'calc(var(--wide-w) * 9 / 16)' : 'calc(var(--card-w) * 1.5)';
  row._fill = () => {
    const frag = document.createDocumentFragment();
    for (const entry of items.slice(0, ROW_LIMIT)) frag.append(entry.card ? entry.card() : makeCard(entry));
    track.append(frag);
    track.style.minHeight = '';
  };
  rowObserver.observe(row);
  return row;
}

function groupRows(kind, map, limit = Infinity) {
  const groups = [...map.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, limit);
  return groups.map(([name, items]) => makeRow({ title: name, items, more: items.length > ROW_LIMIT || limit !== Infinity ? () => navigate('group', { kind, group: name }) : null }));
}

// ---------- Hero ----------
// O destaque é sorteado uma vez por lista carregada (não muda ao voltar do player).
const featuredCache = new WeakMap();
function pickFeatured(pool) {
  if (featuredCache.has(pool)) return featuredCache.get(pool);
  const withLogo = pool.filter((i) => i.logo).slice(0, 300);
  const list = withLogo.length ? withLogo : pool;
  const pick = list[Math.floor(Math.random() * list.length)];
  featuredCache.set(pool, pick);
  return pick;
}

function makeHero(item) {
  if (!item) return el('div', { style: { height: '100px' } });
  const isSeries = item.kind === 'series';
  const playBtn = el('button', { class: 'btn btn-white', html: `${icons.play} Assistir` });
  playBtn.onclick = () => (isSeries ? playEpisode(nextUp(item).ep) : item.kind === 'live' ? playLive(item) : playMovie(item));
  if (isSeries) {
    const nu = nextUp(item);
    if (nu.started) playBtn.innerHTML = `${icons.play} Continuar ${episodeLabel(nu.ep)}`;
  }
  const info = el('button', { class: 'btn btn-gray', html: `${icons.info} Mais informações`, onclick: () => openItem(item) });
  const desc = isSeries ? `${item.seasons.length} temporada(s) · ${item.episodes.length} episódios${item.group ? ' · ' + item.group : ''}` : item.group || '';
  return el(
    'div',
    { class: 'hero' },
    el('div', { class: 'hero-bg blur', style: { backgroundImage: item.logo ? `url("${encodeURI(item.logo)}")` : 'linear-gradient(135deg,#4a0b0f,#141414)' } }),
    item.logo ? el('img', { class: 'hero-poster', src: item.logo, alt: '', onerror: (e) => e.target.remove() }) : null,
    el(
      'div',
      { class: 'hero-content' },
      el('div', { class: 'hero-kicker', html: `<b>N</b> ${isSeries ? 'Série' : item.kind === 'live' ? 'Ao vivo' : 'Filme'}` }),
      el('h1', { class: 'hero-title', text: item.name }),
      el('div', { class: 'hero-desc', text: desc }),
      el('div', { class: 'row-btns' }, playBtn, info)
    )
  );
}

// ---------- Páginas ----------
function continueEntries() {
  const lib = state.lib;
  const out = [];
  const seen = new Set();
  const entries = Object.entries(state.progress).sort((a, b) => b[1].at - a[1].at);
  for (const [id, p] of entries) {
    const item = lib.byId.get(id);
    if (!item || !p.d) continue;
    if (item.kind === 'episode') {
      if (seen.has(item.seriesId)) continue;
      seen.add(item.seriesId);
      const series = lib.byId.get(item.seriesId);
      let target = item;
      if (p.t / p.d >= 0.95) {
        target = series.episodes[item.index + 1];
        if (!target) continue;
      }
      out.push({ card: () => makeCard(target, { series, ratio: progressRatio(target.id) || 0.02, onClick: () => playEpisode(target) }) });
    } else if (item.kind === 'movie' && p.t / p.d < 0.95) {
      out.push({ card: () => makeCard(item, { onClick: () => playMovie(item) }) });
    }
    if (out.length >= 30) break;
  }
  return out;
}

function myListItems() {
  return state.myList.map((id) => state.lib.byId.get(id)).filter(Boolean);
}

function renderHome() {
  const lib = state.lib;
  const rows = [];
  const cont = continueEntries();
  if (cont.length) rows.push(makeRow({ title: 'Continuar assistindo', items: cont }));
  const mine = myListItems();
  if (mine.length) rows.push(makeRow({ title: 'Minha lista', items: mine, more: () => navigate('mylist') }));
  rows.push(...groupRows('series', lib.groups.series, HOME_GROUPS_PER_KIND));
  rows.push(...groupRows('movies', lib.groups.movies, HOME_GROUPS_PER_KIND));
  rows.push(...groupRows('live', lib.groups.live, HOME_GROUPS_PER_KIND));
  setView(makeHero(pickFeatured(lib.series.length ? lib.series : lib.movies.length ? lib.movies : lib.live)), el('div', { class: 'rows' }, rows));
}

function renderCategory(kind, pool, map, emptyText) {
  if (!pool.length) {
    setView(el('div', { class: 'empty' }, el('h1', { text: emptyText }), el('p', { text: 'A lista atual não possui itens desta categoria.' })));
    return;
  }
  const hero = kind === 'live' ? el('div', { class: 'page' }, el('h1', { text: 'TV ao vivo' })) : makeHero(pickFeatured(pool));
  setView(hero, el('div', { class: 'rows', style: kind === 'live' ? { marginTop: '0' } : {} }, groupRows(kind, map)));
}

const renderSeriesPage = () => renderCategory('series', state.lib.series, state.lib.groups.series, 'Nenhuma série');
const renderMoviesPage = () => renderCategory('movies', state.lib.movies, state.lib.groups.movies, 'Nenhum filme');
const renderLivePage = () => renderCategory('live', state.lib.live, state.lib.groups.live, 'Nenhum canal ao vivo');

function renderGrid(title, items, chips) {
  const wide = items.length && items.every((i) => i.kind === 'live');
  const grid = el('div', { class: `grid${wide ? ' wide' : ''}` });
  const page = el('div', { class: 'page' }, el('h1', { text: title }), chips || null, grid);
  setView(page);
  // Renderização incremental para listas enormes.
  let i = 0;
  const step = () => {
    const frag = document.createDocumentFragment();
    for (const end = Math.min(items.length, i + 120); i < end; i++) frag.append(makeCard(items[i]));
    grid.append(frag);
    if (i < items.length) sentinelObserve();
  };
  const sentinel = el('div', { style: { height: '1px' } });
  page.append(sentinel);
  const obs = new IntersectionObserver((e) => {
    if (e[0].isIntersecting) {
      obs.disconnect();
      step();
    }
  }, { rootMargin: '800px 0px' });
  const sentinelObserve = () => obs.observe(sentinel);
  step();
  if (!items.length) grid.replaceWith(el('p', { style: { color: 'var(--muted)' }, text: 'Nada por aqui ainda.' }));
}

function renderGroup({ kind, group }) {
  const map = state.lib.groups[kind];
  const chips = el(
    'div',
    { class: 'chips' },
    [...map.keys()].slice(0, 80).map((g) => el('button', { class: `chip${g === group ? ' active' : ''}`, text: g, onclick: () => navigate('group', { kind, group: g }) }))
  );
  renderGrid(group, map.get(group) || [], chips);
}

function renderMyList() {
  renderGrid('Minha lista', myListItems());
}

function renderSearch(q) {
  const results = searchLibrary(state.lib, q);
  renderGrid(`Resultados para "${q}"`, results);
}

// =====================================================================
// Detalhes (modal)
// =====================================================================
function openModal(content, { small = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const modal = el('div', { class: `modal${small ? ' small' : ''}` });
  const close = () => {
    backdrop.remove();
    onClose?.();
    prevFocus?.focus?.({ preventScroll: true });
  };
  modal.append(el('button', { class: 'modal-close', html: icons.close, onclick: close, title: 'Fechar (Esc)' }), content);
  const backdrop = el('div', { class: 'modal-backdrop' }, modal);
  backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  backdrop._close = close;
  $('#modal-root').append(backdrop);
  requestAnimationFrame(() => modal.querySelector('.btn, input, .episode')?.focus({ preventScroll: true }));
  return { close, modal };
}

function closeAllModals() {
  $$('#modal-root .modal-backdrop').forEach((b) => b._close());
}

function myListButton(item) {
  const btn = el('button', { class: 'circle-btn', 'data-focusable': true });
  const sync = () => {
    const inList = state.myList.includes(item.id);
    btn.innerHTML = inList ? icons.check : icons.plus;
    btn.title = inList ? 'Remover da Minha lista' : 'Adicionar à Minha lista';
  };
  btn.onclick = () => {
    const i = state.myList.indexOf(item.id);
    if (i >= 0) state.myList.splice(i, 1);
    else state.myList.unshift(item.id);
    save('mylist', state.myList);
    sync();
    toast(i >= 0 ? 'Removido da Minha lista' : 'Adicionado à Minha lista');
  };
  sync();
  return btn;
}

function downloadButton(item, { label = false } = {}) {
  const btn = el('button', { class: label ? 'btn btn-gray' : 'circle-btn', 'data-focusable': true });
  const sync = () => {
    const d = downloadOf(item);
    const st = d?.status;
    const text = st === 'done' ? 'Baixado' : st === 'downloading' ? `Baixando ${Math.round((d.progress || 0) * 100)}%` : st === 'queued' ? 'Na fila' : 'Baixar';
    btn.innerHTML = (st === 'done' ? icons.check : icons.download) + (label ? ` ${text}` : '');
    btn.title = text;
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    const d = downloadOf(item);
    if (d?.status === 'done') return toast('Já está nos seus downloads');
    startDownload(item);
    setTimeout(sync, 300);
  };
  sync();
  btn._sync = sync;
  return btn;
}

function openMovieDetail(movie) {
  const content = el(
    'div',
    {},
    el(
      'div',
      { class: 'detail-hero' },
      el('div', { class: 'bg', style: { backgroundImage: movie.logo ? `url("${encodeURI(movie.logo)}")` : '' } }),
      movie.logo ? el('img', { class: 'poster', src: movie.logo, alt: '', onerror: (e) => e.target.remove() }) : null,
      el(
        'div',
        { class: 'detail-hero-content' },
        el('h1', { class: 'detail-title', text: movie.name }),
        el(
          'div',
          { class: 'row-btns' },
          el('button', {
            class: 'btn btn-white',
            html: `${icons.play} ${progressRatio(movie.id) > 0.01 && progressRatio(movie.id) < 0.95 ? 'Continuar' : 'Assistir'}`,
            onclick: () => playMovie(movie),
          }),
          api ? downloadButton(movie, { label: true }) : null,
          myListButton(movie)
        )
      )
    ),
    el(
      'div',
      { class: 'detail-body' },
      el(
        'div',
        { class: 'meta' },
        el('span', { class: 'hl', text: 'Filme' }),
        movie.group ? el('span', { text: movie.group }) : null,
        state.progress[movie.id] ? el('span', { text: `Assistido até ${formatTime(state.progress[movie.id].t)}` }) : null
      )
    )
  );
  openModal(content);
}

function nextUp(series) {
  let best = null;
  for (const ep of series.episodes) {
    const p = state.progress[ep.id];
    if (p && (!best || p.at > best.p.at)) best = { ep, p };
  }
  if (!best) return { ep: series.episodes[0], started: false };
  if (best.p.d && best.p.t / best.p.d >= 0.95) {
    const nxt = series.episodes[best.ep.index + 1];
    return nxt ? { ep: nxt, started: true } : { ep: series.episodes[0], started: false };
  }
  return { ep: best.ep, started: true };
}

function openSeriesDetail(series) {
  const nu = nextUp(series);
  let season = nu.ep.season;
  const list = el('div', {});
  const playBtn = el('button', { class: 'btn btn-white' });
  const syncPlay = () => {
    const n = nextUp(series);
    playBtn.innerHTML = `${icons.play} ${n.started ? `Continuar ${episodeLabel(n.ep)}` : 'Assistir'}`;
    playBtn.onclick = () => playEpisode(n.ep);
  };

  const renderEpisodes = () => {
    list.innerHTML = '';
    for (const ep of series.episodes.filter((e) => e.season === season)) {
      const ratio = progressRatio(ep.id);
      list.append(
        el(
          'div',
          { class: 'episode', tabindex: '0', 'data-focusable': true, onclick: () => playEpisode(ep), onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && playEpisode(ep) },
          el('div', { class: 'num', text: ep.episode }),
          el(
            'div',
            { class: 'thumb' },
            ep.logo || series.logo ? el('img', { src: ep.logo || series.logo, loading: 'lazy', alt: '', onerror: (e) => e.target.remove() }) : null,
            el('div', { class: 'play-ico', html: icons.play }),
            ratio > 0.01 ? el('div', { class: 'bar' }, el('div', { style: { width: `${ratio * 100}%` } })) : null
          ),
          el(
            'div',
            {},
            el('div', { class: 'ep-title', text: ep.epTitle || `Episódio ${ep.episode}` }),
            el('div', { class: 'ep-sub', text: `${episodeLabel(ep)}${ratio >= 0.95 ? ' · Assistido' : ratio > 0.01 ? ` · ${Math.round(ratio * 100)}%` : ''}${downloadOf(ep)?.status === 'done' ? ' · Baixado' : ''}` })
          ),
          el('div', { class: 'ep-actions' }, api ? downloadButton(ep) : null)
        )
      );
    }
  };

  const seasonSelect = el(
    'select',
    { class: 'select', onchange: (e) => ((season = Number(e.target.value)), renderEpisodes()) },
    series.seasons.map((s) => el('option', { value: s, selected: s === season, text: `Temporada ${s}` }))
  );

  const content = el(
    'div',
    {},
    el(
      'div',
      { class: 'detail-hero' },
      el('div', { class: 'bg', style: { backgroundImage: series.logo ? `url("${encodeURI(series.logo)}")` : '' } }),
      series.logo ? el('img', { class: 'poster', src: series.logo, alt: '', onerror: (e) => e.target.remove() }) : null,
      el('div', { class: 'detail-hero-content' }, el('h1', { class: 'detail-title', text: series.name }), el('div', { class: 'row-btns' }, playBtn, myListButton(series)))
    ),
    el(
      'div',
      { class: 'detail-body' },
      el(
        'div',
        { class: 'meta' },
        el('span', { class: 'hl', text: 'Série' }),
        el('span', { text: `${series.seasons.length} temporada${series.seasons.length > 1 ? 's' : ''}` }),
        el('span', { class: 'box', text: `${series.episodes.length} episódios` }),
        series.group ? el('span', { text: series.group }) : null
      ),
      el(
        'div',
        { class: 'episodes-head' },
        el('h3', { text: 'Episódios' }),
        el(
          'div',
          { class: 'row-btns' },
          api ? el('button', { class: 'btn btn-gray btn-sm', html: `${icons.download} Baixar temporada`, onclick: () => downloadSeason(series, season) }) : null,
          series.seasons.length > 1 ? seasonSelect : el('span', { class: 'select', text: `Temporada ${season}` })
        )
      ),
      list
    )
  );
  syncPlay();
  renderEpisodes();
  const modal = openModal(content);
  modal.refresh = () => {
    syncPlay();
    renderEpisodes();
  };
  currentDetail = modal;
}

let currentDetail = null;

// =====================================================================
// Reprodução
// =====================================================================
function playEpisode(ep) {
  const series = state.lib.byId.get(ep.seriesId);
  player.open({ queue: series.episodes, index: ep.index });
}

function playMovie(movie) {
  player.open({ queue: [movie], index: 0 });
}

function playLive(ch) {
  const queue = state.lib.groups.live.get(ch.group || 'Outros') || [ch];
  player.open({ queue, index: Math.max(0, queue.indexOf(ch)) });
}

function playDownload(d) {
  const item = state.lib?.byId.get(d.key);
  if (item) return openItemForPlayback(item);
  player.open({ queue: [{ id: d.key, kind: 'movie', name: d.title, url: d.fileUrl, logo: d.poster, group: 'Downloads' }], index: 0 });
}

function openItemForPlayback(item) {
  if (item.kind === 'episode') playEpisode(item);
  else if (item.kind === 'live') playLive(item);
  else playMovie(item);
}

function playerContext() {
  return {
    settings: () => state.settings,
    getSeries: (id) => state.lib?.byId.get(id),
    getProgress: (id) => state.progress[id],
    saveProgress: (item, t, d) => {
      state.progress[item.id] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };
      const keys = Object.keys(state.progress);
      if (keys.length > 3000) {
        keys.sort((a, b) => state.progress[a].at - state.progress[b].at).slice(0, keys.length - 3000).forEach((k) => delete state.progress[k]);
      }
      save('progress', state.progress, 1000);
    },
    getMarks: (seriesId) => (seriesId ? state.marks[seriesId] : null),
    setMarks: (seriesId, marks) => {
      if (marks) state.marks[seriesId] = marks;
      else delete state.marks[seriesId];
      save('marks', state.marks);
    },
    getVolume: () => state.volume,
    saveVolume: (volume, muted) => {
      state.volume = { volume, muted };
      save('volume', state.volume, 1000);
    },
    canDownload: !!api,
    download: (item) => startDownload(item),
    downloadState: (item) => downloadOf(item)?.status,
    localFile: (item) => {
      const d = downloadOf(item);
      return d?.status === 'done' && d.fileUrl ? d.fileUrl : null;
    },
    onClose: () => {
      if (currentDetail && document.contains(currentDetail.modal)) currentDetail.refresh();
      if (['home', 'series', 'movies'].includes(state.view)) rerenderKeepingScroll();
    },
  };
}

// =====================================================================
// Downloads
// =====================================================================
function downloadOf(item) {
  return state.downloads.find((d) => d.key === item.id && d.status !== 'canceled');
}

function downloadTitle(item) {
  if (item.kind === 'episode') {
    const s = state.lib.byId.get(item.seriesId);
    const se = `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
    return `${s?.name || 'Série'} - ${se}${item.epTitle ? ' - ' + item.epTitle : ''}`;
  }
  return item.name;
}

async function startDownload(item, silent = false) {
  if (!api) return toast('Downloads estão disponíveis no aplicativo para Windows');
  if (item.kind === 'live') return toast('Canais ao vivo não podem ser baixados');
  const series = item.kind === 'episode' ? state.lib.byId.get(item.seriesId) : null;
  await api.downloads.start({
    key: item.id,
    url: item.url,
    title: downloadTitle(item),
    subtitle: series ? episodeLabel(item) : item.group || '',
    poster: item.logo || series?.logo || '',
    kind: item.kind,
    seriesId: item.seriesId || null,
    season: item.season ?? null,
    episode: item.episode ?? null,
  });
  if (!silent) toast(`Download iniciado: ${downloadTitle(item)}`);
}

async function downloadSeason(series, season) {
  const eps = series.episodes.filter((e) => e.season === season && !downloadOf(e));
  if (!eps.length) return toast('Todos os episódios desta temporada já estão nos downloads');
  for (const ep of eps) await startDownload(ep, true);
  toast(`${eps.length} episódio(s) adicionados aos downloads`);
}

function updateDownloadBadge() {
  const active = state.downloads.filter((d) => d.status === 'downloading' || d.status === 'queued').length;
  const badge = $('#dl-badge');
  badge.hidden = !active;
  badge.textContent = active;
}

function dlStatusText(d) {
  switch (d.status) {
    case 'downloading':
      return d.total
        ?`Baixando ${Math.round(d.progress * 100)}% · ${d.total > 10000 ? `${formatBytes(d.received)} de ${formatBytes(d.total)}` : `${d.received}/${d.total} partes`}${d.speed ? ` · ${formatBytes(d.speed)}/s` : ''}`
        : `Baixando... ${formatBytes(d.received)}${d.speed ? ` · ${formatBytes(d.speed)}/s` : ''}`;
    case 'queued':
      return 'Na fila';
    case 'done':
      return 'Concluído';
    case 'error':
      return `Erro: ${d.error || 'falha no download'}`;
    case 'canceled':
      return 'Cancelado';
    default:
      return d.status;
  }
}

function renderDownloads(isUpdate = false) {
  if (!api) {
    setView(el('div', { class: 'empty' }, el('h1', { text: 'Downloads' }), el('p', { text: 'Os downloads estão disponíveis no aplicativo para Windows.' })));
    return;
  }
  const list = state.downloads;
  const container = $('#dl-list');
  const sig = list.map((d) => d.id + d.status).join('|');
  if (isUpdate && container && container.dataset.sig === sig) {
    for (const d of list) {
      const row = container.querySelector(`[data-id="${d.id}"]`);
      if (!row) continue;
      row.querySelector('.dl-status').textContent = dlStatusText(d);
      const bar = row.querySelector('.dl-bar div');
      if (bar) bar.style.width = `${(d.progress || 0) * 100}%`;
    }
    return;
  }

  const folderLabel = el('span', {});
  api.downloads.getFolder().then((f) => (folderLabel.textContent = `Pasta: ${f}`));
  const listEl = el('div', { id: 'dl-list', 'data-sig': sig });
  for (const d of list) {
    const actions = [];
    if (d.status === 'done') {
      actions.push(el('button', { class: 'btn btn-white btn-sm', html: `${icons.play} Assistir`, onclick: () => playDownload(d) }));
      actions.push(el('button', { class: 'circle-btn', title: 'Mostrar na pasta', html: icons.folder, onclick: () => api.downloads.showFile(d.id) }));
    }
    if (d.status === 'downloading' || d.status === 'queued') actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: 'Cancelar', onclick: () => api.downloads.cancel(d.id) }));
    if (d.status === 'error' || d.status === 'canceled') actions.push(el('button', { class: 'circle-btn', title: 'Tentar novamente', html: icons.retry, onclick: () => api.downloads.retry(d.id) }));
    actions.push(
      el('button', {
        class: 'circle-btn',
        title: d.status === 'done' ? 'Excluir arquivo' : 'Remover da lista',
        html: icons.trash,
        onclick: () => {
          if (d.status === 'done' && !confirm(`Excluir o arquivo de "${d.title}" do computador?`)) return;
          api.downloads.remove(d.id, true);
        },
      })
    );
    listEl.append(
      el(
        'div',
        { class: 'dl-item', 'data-id': d.id },
        el('div', { class: 'thumb' }, d.poster ? el('img', { src: d.poster, alt: '', onerror: (e) => e.target.remove() }) : null),
        el(
          'div',
          {},
          el('div', { class: 'dl-title', text: d.title }),
          el('div', { class: `dl-status${d.status === 'error' ? ' err' : ''}`, text: dlStatusText(d) }),
          d.status === 'downloading' || d.status === 'queued' ? el('div', { class: 'dl-bar' }, el('div', { style: { width: `${(d.progress || 0) * 100}%` } })) : null
        ),
        el('div', { class: 'dl-actions' }, actions)
      )
    );
  }
  if (!list.length) listEl.append(el('p', { style: { color: 'var(--muted)' }, text: 'Nenhum download ainda. Use o botão de download em filmes e episódios.' }));

  const y = window.scrollY;
  setView(
    el(
      'div',
      { class: 'page' },
      el('h1', { text: 'Downloads' }),
      el(
        'div',
        { class: 'dl-toolbar' },
        folderLabel,
        el('button', { class: 'btn btn-gray btn-sm', html: `${icons.folder} Abrir pasta`, onclick: () => api.downloads.openFolder() }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Alterar pasta',
          onclick: async () => (folderLabel.textContent = `Pasta: ${await api.downloads.chooseFolder()}`),
        })
      ),
      listEl
    )
  );
  if (isUpdate) window.scrollTo(0, y);
}

// =====================================================================
// Configurações e gerenciamento de listas
// =====================================================================
function openSettingsModal() {
  const s = state.settings;
  const update = (key, value) => {
    s[key] = value;
    save('settings', s);
    if (key === 'userAgent') applyNetConfig();
    if (key === 'hideAdult' && state.rawItems) {
      rebuildLibrary();
      navigate(state.view === 'group' || state.view === 'search' ? 'home' : state.view);
    }
  };
  const toggle = (key, label, hint) =>
    el(
      'div',
      { class: 'field' },
      el('label', {}, label, hint ? el('small', { text: hint }) : null),
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => update(key, e.target.checked) }), el('span'))
    );
  const number = (key, label, hint, min = 0, max = 600) =>
    el(
      'div',
      { class: 'field' },
      el('label', {}, label, hint ? el('small', { text: hint }) : null),
      el('input', { class: 'input', type: 'number', min, max, value: s[key], onchange: (e) => update(key, Math.min(max, Math.max(min, Number(e.target.value) || 0))) })
    );

  const content = el(
    'div',
    { class: 'form' },
    el('h2', { text: 'Configurações' }),
    el('h3', { text: 'Reprodução' }),
    toggle('autoplayNext', 'Reproduzir próximo episódio automaticamente', 'Inicia o próximo episódio sozinho ao chegar nos créditos.'),
    toggle('lowLatencyLive', 'Baixa latência nos canais ao vivo', 'Reduz o atraso da transmissão, mas pode causar mais instabilidade. Desativado por padrão.'),
    number('countdown', 'Contagem regressiva (segundos)', 'Tempo exibido no cartão "Próximo episódio".', 3, 60),
    number('creditsSeconds', 'Mostrar "Próximo episódio" quando faltar (segundos)', 'Pode ser ajustado por série no player (ícone de marcador).', 0, 600),
    number('stillWatchingAfter', 'Perguntar "Ainda está assistindo?" após N episódios seguidos', '0 desativa.', 0, 50),
    el('h3', { text: 'Abertura' }),
    number('introDefault', 'Botão "Pular abertura" padrão (segundos)', 'Pula até esse ponto quando a série não tem marcação. 0 desativa.', 0, 600),
    toggle('autoSkipIntro', 'Pular abertura automaticamente', 'Funciona nas séries em que você marcou a abertura no player.'),
    el('h3', { text: 'Conteúdo' }),
    toggle(
      'hideAdult',
      'Ocultar conteúdo adulto (+18)',
      state.lib?.hidden ? `${state.lib.hidden.toLocaleString('pt-BR')} itens ocultos na lista atual.` : 'Esconde grupos e títulos marcados como adulto/XXX.'
    ),
    el('h3', { text: 'Rede' }),
    el(
      'div',
      { class: 'field' },
      el('label', {}, 'User-Agent personalizado', el('small', { text: 'Alguns servidores IPTV exigem, ex.: VLC/3.0.20 LibVLC/3.0.20' })),
      el('input', { class: 'input', type: 'text', value: s.userAgent, placeholder: 'Padrão', style: { width: '260px' }, onchange: (e) => update('userAgent', e.target.value.trim()) })
    ),
    api
      ? el(
          'div',
          {},
          el('h3', { text: 'Downloads' }),
          (() => {
            const label = el('small', { text: '...' });
            api.downloads.getFolder().then((f) => (label.textContent = f));
            return el(
              'div',
              { class: 'field' },
              el('label', {}, 'Pasta de downloads', label),
              el('button', { class: 'btn btn-gray btn-sm', text: 'Alterar', onclick: async () => (label.textContent = await api.downloads.chooseFolder()) })
            );
          })()
        )
      : null,
    el('h3', { text: 'Atalhos do player' }),
    el('p', {
      style: { color: 'var(--muted)', fontSize: '13px', lineHeight: '1.7', margin: 0 },
      text: 'Espaço: play/pausa · ←/→: 10s · ↑/↓: volume · F: tela cheia · M: mudo · N: próximo · P: anterior · S: pular abertura · E: episódios · Esc: voltar',
    })
  );
  openModal(content, { small: true });
}

function openPlaylistsModal() {
  const listEl = el('div', {});
  const render = () => {
    listEl.innerHTML = '';
    if (!state.playlists.length) listEl.append(el('p', { style: { color: 'var(--muted)' }, text: 'Nenhuma lista adicionada.' }));
    for (const pl of state.playlists) {
      const isActive = pl.id === state.activeId;
      const where = pl.type === 'url' ? pl.url : pl.type === 'file' ? pl.path : pl.type === 'sample' ? 'Vídeos de demonstração' : 'Arquivo importado';
      listEl.append(
        el(
          'div',
          { class: `pl-item${isActive ? ' active' : ''}` },
          el('div', { class: 'pl-name' }, el('b', { text: pl.name }), el('small', { text: where })),
          isActive
            ? el('button', { class: 'circle-btn', title: 'Atualizar lista', html: icons.refresh, onclick: () => (closeAllModals(), loadPlaylist(pl, { force: true })) })
            : el('button', { class: 'btn btn-white btn-sm', text: 'Usar', onclick: () => (closeAllModals(), loadPlaylist(pl)) }),
          el('button', {
            class: 'circle-btn',
            title: 'Remover lista',
            html: icons.trash,
            onclick: async () => {
              if (!confirm(`Remover a lista "${pl.name}"?`)) return;
              state.playlists = state.playlists.filter((p) => p.id !== pl.id);
              await saveNow('playlists', state.playlists);
              deleteCachedPlaylist(pl);
              if (isActive) {
                state.lib = null;
                state.activeId = null;
                const nextPl = state.playlists[0];
                closeAllModals();
                if (nextPl) loadPlaylist(nextPl);
                else renderWelcome();
              } else render();
            },
          })
        )
      );
    }
  };
  render();
  openModal(el('div', { class: 'form' }, el('h2', { text: 'Listas M3U' }), listEl, el('h3', { text: 'Adicionar lista' }), playlistAddForm()), { small: true });
}

init().catch((err) => {
  console.error(err);
  toast(`Erro ao iniciar: ${err.message}`, 6000);
});
