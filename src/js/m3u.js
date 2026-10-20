// Parser de listas M3U / M3U8 "estendidas" (formato IPTV).
// Suporta atributos do #EXTINF (tvg-id, tvg-name, tvg-logo, group-title...),
// #EXTGRP e #EXTVLCOPT (http-user-agent / http-referrer).

function splitExtinf(line) {
  // "#EXTINF:-1 tvg-logo="a,b" group-title="X",Nome do canal"
  // A vírgula que separa o título é a primeira fora de aspas.
  let inQuotes = false;
  for (let i = 8; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) return [line.slice(8, i), line.slice(i + 1)];
  }
  return [line.slice(8), ''];
}

function parseAttributes(header) {
  const attrs = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(header))) attrs[m[1].toLowerCase()] = m[2].trim();
  const dur = header.trim().match(/^-?\d+(\.\d+)?/);
  attrs.duration = dur ? Number(dur[0]) : -1;
  return attrs;
}

function resolveUrl(url, base) {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

export function parseM3U(text, baseUrl = '') {
  const items = [];
  if (!text) return items;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let cur = null;
  let opts = {};
  let groupFromTag = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const [header, title] = splitExtinf(line);
      const attrs = parseAttributes(header);
      cur = {
        name: (title || attrs['tvg-name'] || '').trim(),
        logo: attrs['tvg-logo'] || attrs['logo'] || '',
        // Remove enfeites do início (ex.: "♦️  REDE RECORD" → "REDE RECORD").
        group: (attrs['group-title'] || '').replace(/^[^\p{L}\p{N}[(]+/u, '').replace(/\s{2,}/g, ' ').trim(),
        tvgId: attrs['tvg-id'] || '',
        duration: attrs.duration,
      };
    } else if (line.startsWith('#EXTGRP:')) {
      groupFromTag = line.slice(8).trim();
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=');
      const value = v.join('=').trim();
      if (/http-user-agent/i.test(k)) opts.userAgent = value;
      if (/http-referr?er/i.test(k)) opts.referer = value;
    } else if (line.startsWith('#')) {
      continue;
    } else {
      const url = resolveUrl(line, baseUrl);
      const item = cur || { name: '', logo: '', group: '', tvgId: '', duration: -1 };
      item.url = url;
      if (!item.group && groupFromTag) item.group = groupFromTag;
      if (!item.name) item.name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url);
      if (opts.userAgent || opts.referer) item.headers = opts;
      items.push(item);
      cur = null;
      opts = {};
      groupFromTag = '';
    }
  }
  return items;
}
