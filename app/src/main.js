'use strict';
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const vpngate = require('./vpngate');
const { VpnManager, findOpenVpn, installOpenVpn } = require('./openvpn');

let win = null;
let servers = [];
let manager = null;

async function publicIp() {
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) });
  return (await res.text()).trim();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 600,
    backgroundColor: '#0b1220', title: 'FreeVPN', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function setupIpc() {
  const cacheDir = path.join(app.getPath('userData'), 'cache');
  manager = new VpnManager({ runDir: path.join(app.getPath('userData'), 'run'), ipLookup: publicIp });
  manager.on('state', (s) => send('vpn:state', s));

  ipcMain.handle('servers:load', async (_e, refresh) => {
    const r = await vpngate.loadServers({ cacheDir, refresh: !!refresh });
    servers = r.servers;
    return { countries: vpngate.summarize(servers), total: servers.length, fetchedAt: r.fetchedAt, stale: r.stale, warning: r.warning };
  });

  ipcMain.handle('servers:country', (_e, cc) =>
    servers.filter((s) => s.cc === String(cc).toUpperCase()).sort((a, b) => b.score - a.score).map(vpngate.publicView));

  ipcMain.handle('vpn:connect', async (_e, { cc, ip } = {}) => {
    let pool = servers;
    if (ip) pool = servers.filter((s) => s.ip === ip);
    else if (cc) pool = servers.filter((s) => s.cc === String(cc).toUpperCase());
    const candidates = ip ? pool : await vpngate.rank(pool, { limit: 5 });
    manager.connect(candidates).catch((e) => send('vpn:state', { state: 'error', message: e.message }));
    return { started: true, candidates: candidates.length };
  });

  ipcMain.handle('vpn:disconnect', () => manager.disconnect());
  ipcMain.handle('vpn:state', () => manager.state);
  ipcMain.handle('vpn:log', () => manager.log.slice(-80));
  ipcMain.handle('sys:openvpn', () => ({ installed: !!findOpenVpn(), platform: process.platform }));
  ipcMain.handle('sys:install-openvpn', () => installOpenVpn());
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    setupIpc();
    createWindow();
  });
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !manager) return;
    quitting = true;
    e.preventDefault();
    manager.disconnect().finally(() => app.quit()); // no dejar el túnel ni las rutas colgadas
  });
  app.on('window-all-closed', () => app.quit());
}
