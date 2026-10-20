const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  storeGet: invoke('store:get'),
  storeSet: invoke('store:set'),
  setNetConfig: invoke('net:config'),
  setStreamHeaders: invoke('net:streamHeaders'),
  fetchPlaylist: invoke('playlist:fetch'),
  openPlaylistFile: invoke('playlist:openFile'),
  readPlaylistFile: invoke('playlist:readFile'),
  readPlaylistCache: invoke('playlist:readCache'),
  deletePlaylistCache: invoke('playlist:deleteCache'),
  downloads: {
    list: invoke('dl:list'),
    start: invoke('dl:start'),
    cancel: invoke('dl:cancel'),
    retry: invoke('dl:retry'),
    remove: invoke('dl:remove'),
    showFile: invoke('dl:showFile'),
    openFolder: invoke('dl:openFolder'),
    getFolder: invoke('dl:getFolder'),
    chooseFolder: invoke('dl:chooseFolder'),
    onUpdate: (cb) => {
      const listener = (_e, list) => cb(list);
      ipcRenderer.on('dl:update', listener);
      return () => ipcRenderer.removeListener('dl:update', listener);
    },
  },
});
