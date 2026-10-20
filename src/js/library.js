// Organiza os itens da lista M3U em Séries (com temporadas/episódios),
// Filmes e Canais ao vivo, agrupados por group-title.

const EPISODE_PATTERNS = [
  /\b[ST](\d{1,2})\s*[|.\-_ ]?\s*EP?\s*(\d{1,4})\b/i, // S01E02, T01 E02, S1.EP2, T01|EP02
  /\b(\d{1,2})x(\d{1,3})\b/i, // 1x02
  /temporada\s*(\d{1,2})\D{0,20}?epis[oó]dio\s*(\d{1,4})/i, // Temporada 1 Episódio 2
];

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|m4v|webm|flv)(\?|#|$)/i;
// Grupos de VOD costumam ter esses nomes mesmo quando o link é .m3u8 / sem extensão.
const MOVIE_GROUP = /\b(filmes?|movies?|vod|cinema|lan[cç]amentos?)\b/i;
// Painéis XUI/Xtream: ao vivo = /play/<token>/ts (ou /m3u8), VOD = /play/<token> sem sufixo.
const XUI_LIVE = /\/play\/[^/?#]+\/(ts|m3u8|hls)(\?|#|$)/i;
const XUI_VOD = /\/play\/[^/?#]+(\?|#|$)/i;
const ADULT = /adult|\bxxx\b|\+18|onlyfans|\[trans\]|bella da semana|porn/i;

export function isAdult(raw) {
  return ADULT.test(raw.group) || /^\s*\[?xxx\b/i.test(raw.name);
}

export function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function matchEpisode(name) {
  for (const re of EPISODE_PATTERNS) {
    const m = name.match(re);
    if (m) return m;
  }
  return null;
}

function cleanShowTitle(s) {
  return s
    .replace(/[\s\-–—|:._(\[]+$/g, '')
    .replace(/^[\s\-–—|:._]+/g, '')
    .trim();
}

function pushGroup(map, group, item) {
  const g = group || 'Outros';
  if (!map.has(g)) map.set(g, []);
  map.get(g).push(item);
}

export function buildLibrary(rawItems, { hideAdult = false } = {}) {
  const byId = new Map();
  const live = [];
  const movies = [];
  const seriesMap = new Map();
  const groups = { live: new Map(), movies: new Map(), series: new Map() };

  let hidden = 0;
  for (const raw of rawItems) {
    if (hideAdult && isAdult(raw)) {
      hidden++;
      continue;
    }
    const url = raw.url;
    const lowerUrl = url.toLowerCase();
    const isXuiLive = XUI_LIVE.test(url);
    const m = isXuiLive ? null : matchEpisode(raw.name);
    const id = 'i' + hash(url + '|' + raw.name);
    if (byId.has(id)) continue;

    if (m || /\/series\//.test(lowerUrl)) {
      const show = cleanShowTitle(m ? raw.name.slice(0, m.index) : raw.name) || raw.group || 'Série';
      const seriesKey = show.toLowerCase().replace(/\s+/g, ' ');
      const seriesId = 's' + hash(seriesKey);
      let series = seriesMap.get(seriesId);
      if (!series) {
        series = { id: seriesId, kind: 'series', name: show, logo: raw.logo, group: raw.group, episodes: [], seasons: [] };
        seriesMap.set(seriesId, series);
        byId.set(seriesId, series);
      }
      if (!series.logo && raw.logo) series.logo = raw.logo;
      // Os itens são anotados no próprio objeto (sem cópia): listas IPTV têm centenas de milhares.
      const ep = Object.assign(raw, {
        id,
        kind: 'episode',
        seriesId,
        season: m ? Number(m[1]) : 1,
        episode: m ? Number(m[2]) : series.episodes.length + 1,
        epTitle: m ? raw.name.slice(m.index + m[0].length).replace(/^[\s\-–—|:._]+/, '').trim() : raw.name,
      });
      series.episodes.push(ep);
      byId.set(id, ep);
    } else if (
      !isXuiLive &&
      (/\/movie\//.test(lowerUrl) || VIDEO_EXT.test(lowerUrl) || XUI_VOD.test(url) || raw.duration > 0 || MOVIE_GROUP.test(raw.group))
    ) {
      const movie = Object.assign(raw, { id, kind: 'movie' });
      movies.push(movie);
      byId.set(id, movie);
      pushGroup(groups.movies, raw.group, movie);
    } else {
      const ch = Object.assign(raw, { id, kind: 'live' });
      live.push(ch);
      byId.set(id, ch);
      pushGroup(groups.live, raw.group, ch);
    }
  }

  const series = [...seriesMap.values()];
  for (const s of series) {
    s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    s.seasons = [...new Set(s.episodes.map((e) => e.season))];
    s.episodes.forEach((e, i) => (e.index = i));
    pushGroup(groups.series, s.group, s);
  }

  return { byId, live, movies, series, groups, total: rawItems.length, hidden };
}

export function episodeLabel(ep) {
  return `T${ep.season}:E${ep.episode}`;
}

export function searchLibrary(lib, query, limit = 300) {
  const q = query
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  if (!q) return [];
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out = [];
  for (const list of [lib.series, lib.movies, lib.live]) {
    for (const it of list) {
      // Nome normalizado calculado uma vez (listas IPTV podem ter centenas de milhares de itens).
      if ((it._search ??= norm(it.name)).includes(q)) {
        out.push(it);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
