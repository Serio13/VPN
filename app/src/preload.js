'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vpn', {
  loadServers: (refresh) => ipcRenderer.invoke('servers:load', refresh),
  countryServers: (cc) => ipcRenderer.invoke('servers:country', cc),
  connect: (target) => ipcRenderer.invoke('vpn:connect', target),
  disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  getState: () => ipcRenderer.invoke('vpn:state'),
  getLog: () => ipcRenderer.invoke('vpn:log'),
  openvpnStatus: () => ipcRenderer.invoke('sys:openvpn'),
  installOpenvpn: () => ipcRenderer.invoke('sys:install-openvpn'),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('vpn:state', h);
    return () => ipcRenderer.removeListener('vpn:state', h);
  },
});
