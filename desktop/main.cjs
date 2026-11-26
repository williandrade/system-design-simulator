const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } = require('electron');
const { once } = require('node:events');
const { access } = require('node:fs/promises');
const path = require('node:path');
const { registerMcpSetup } = require('./mcp-setup.cjs');

const HOST = '127.0.0.1';
const PORT = 4200;
const HOST_HEADER = `${HOST}:${PORT}`;
const ORIGIN = `http://${HOST_HEADER}`;
const PLAYGROUND_URL = `${ORIGIN}/playground?mode=architect`;
const EXTERNAL_LINKS = new Set([
  'https://000sushant.github.io/sushant-portfolio/',
  'https://forms.gle/2Kh6TKqcwYUSnYnHA',
  'https://forms.gle/RJwRybjgRPPi11jg7',
  'https://github.com/000Sushant',
  'https://github.com/000Sushant/system-design-simulator/',
  'https://github.com/000Sushant/system-design-simulator/blob/main/CONTRIBUTING.md',
  'https://github.com/000Sushant/system-design-simulator/issues',
  'https://github.com/harsh-dwivedi',
  'https://github.com/sponsors/000Sushant',
  'https://linkedin.com/in/sushant--kumar',
]);

let server;
let mainWindow;

function isLocalPage(url) {
  return url?.protocol === 'http:' && url.origin === ORIGIN && !url.username && !url.password;
}

function openInBrowser(url) {
  if (!url || url.username || url.password) return;
  const isServiceDocs = isLocalPage(url) &&
    url.pathname === '/docs' &&
    url.searchParams.size === 1 &&
    /^[A-Za-z0-9-]+$/.test(url.searchParams.get('service') ?? '') &&
    !url.hash;

  if (isServiceDocs || EXTERNAL_LINKS.has(url.href)) {
    shell.openExternal(url.href).catch(() => {
      dialog.showErrorBox('System Design Simulator', 'Could not open the link in your browser.');
    });
  }
}

async function showPlayground() {
  if (!server?.listening) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: true,
    },
  });
  mainWindow = window;
  window.on('closed', () => { mainWindow = undefined; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(URL.parse(url));
    return { action: 'deny' };
  });
  window.webContents.on('will-frame-navigate', (event) => {
    const url = URL.parse(event.url);
    if (event.isMainFrame && isLocalPage(url)) return;
    event.preventDefault();
    if (event.isMainFrame) openInBrowser(url);
  });
  window.webContents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isLocalPage(URL.parse(event.url))) event.preventDefault();
  });
  // Electron needs a native prompt to honor the SPA's beforeunload guard.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      message: 'You have unsaved changes in the simulator.',
      detail: 'Save your canvas before leaving or discard the changes.',
      buttons: ['Keep Editing', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });

  try {
    await window.loadURL(PLAYGROUND_URL);
  } catch (error) {
    if (!window.isDestroyed()) throw error;
    return;
  }
  if (!window.isDestroyed()) window.show();
}

async function start() {
  const resources = path.join(process.resourcesPath, 'simulator');
  const staticDir = path.join(resources, 'frontend');
  const pricingFile = path.join(resources, 'data', 'us-east-1.json');
  await Promise.all([access(path.join(staticDir, 'index.html')), access(pricingFile)]);

  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerMcpSetup({
    ipcMain,
    clipboard,
    getWindow: () => mainWindow,
    origin: ORIGIN,
    launcherPath: path.join(resources, 'system-design-simulator-mcp'),
  });

  const { createApp } = require(path.join(resources, 'backend', 'server.js'));
  server = createApp({ desktop: { staticDir, pricingFile, hostHeader: HOST_HEADER } })
    .listen(PORT, HOST);
  await once(server, 'listening');
  server.on('error', failStartup);
  await showPlayground();
}

function failStartup(error) {
  if (server?.listening) {
    server.close();
    server.closeAllConnections();
  }
  const message = error.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Close the local service using it and reopen the simulator.`
    : 'Could not start the local simulator. Rebuild or reinstall the application and try again.';
  dialog.showErrorBox('System Design Simulator', message);
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const openWindow = () => showPlayground().catch(failStartup);
  app.on('second-instance', openWindow);
  app.on('activate', openWindow);
  // Keep the server available for reopening the window from the macOS Dock.
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => {
    if (!server?.listening) return;
    server.close();
    server.closeAllConnections();
  });
  app.whenReady().then(start).catch(failStartup);
}
