// Persistência: arquivos JSON no userData (Electron) ou localStorage (navegador / Smart TV).

const api = window.api;
const PREFIX = 'm3uflix:';
const timers = {};

export async function load(name, fallback) {
  try {
    const value = api ? await api.storeGet(name) : JSON.parse(localStorage.getItem(PREFIX + name));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function saveNow(name, data) {
  clearTimeout(timers[name]);
  try {
    if (api) await api.storeSet(name, data);
    else localStorage.setItem(PREFIX + name, JSON.stringify(data));
  } catch (err) {
    console.warn('Falha ao salvar', name, err);
  }
}

export function save(name, data, delay = 400) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => saveNow(name, data), delay);
}
