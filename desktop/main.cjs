const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, session, shell } = require('electron');
const { mkdirSync } = require('node:fs');
const { access } = require('node:fs/promises');
const path = require('node:path');
const { registerMcpSetup } = require('./mcp-setup.cjs');
const { APP_ORIGIN, SPA_ROUTES, isAppUrl, registerAppScheme, installAppProtocol } = require('./protocol.cjs');
const { createMigrationUrl, migrateStorage, reportMigrationIssue } = require('./migration.cjs');
const { name, productName } = require('./package.json');

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

const mode = app.isPackaged ? 'desktop' : 'desktop-dev';
const namespace = process.env.SIMULATOR_MCP_NAMESPACE;
const windowTitle = app.isPackaged ? productName : `${productName} — Development`;
const PLAYGROUND_ROUTES = new Set(['/', '/playground']);

let mainWindow;
let docsWindow;
let devRuntime;
let desktopMcp;
let docServiceIds;
let readyToOpen = false;
let stopping = false;
let startupStep = 'profile selection';
let origin = APP_ORIGIN;

if (app.isPackaged) registerAppScheme(protocol);

function isLocalPage(url) {
  if (!url || !SPA_ROUTES.has(url.pathname)) return false;
  if (!devRuntime) return isAppUrl(url);
  return url.origin === origin && !url.username && !url.password && devRuntime.isCurrent();
}

function isServiceDocs(url) {
  return isLocalPage(url) && url.pathname === '/docs' && url.searchParams.size === 1 &&
    docServiceIds.has(url.searchParams.get('service')) && !url.hash;
}

function linkOutsideCanvas(url) {
  if (!url || url.username || url.password) return;
  if (isServiceDocs(url)) {
    showServiceDocs(url).catch(() => dialog.showErrorBox(windowTitle, 'Could not open service documentation.'));
    return;
  }

  if (EXTERNAL_LINKS.has(url.href)) {
    shell.openExternal(url.href).catch(() => {
      dialog.showErrorBox(windowTitle, 'Could not open the link in your browser.');
    });
  }
}

function protectWindow(window, allowNavigation, handleLink) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    handleLink?.(URL.parse(url));
    return { action: 'deny' };
  });
  window.webContents.on('will-frame-navigate', (event) => {
    const url = URL.parse(event.url);
    if (event.isMainFrame && allowNavigation(url)) return;
    event.preventDefault();
    if (event.isMainFrame) handleLink?.(url);
  });
  window.webContents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !allowNavigation(URL.parse(event.url))) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (devRuntime) {
    window.on('page-title-updated', (event) => event.preventDefault());
  }
}

async function showServiceDocs(url) {
  if (!docsWindow) {
    const window = new BrowserWindow({
      parent: mainWindow,
      title: windowTitle,
      width: 1100,
      height: 820,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    docsWindow = window;
    window.on('closed', () => { docsWindow = undefined; });
    protectWindow(window, isServiceDocs, linkOutsideCanvas);
  }
  const window = docsWindow;
  await window.loadURL(url.href);
  if (!window.isDestroyed()) window.show();
}

async function showPlayground() {
  if (!readyToOpen || stopping || (devRuntime && !devRuntime.isCurrent())) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    title: windowTitle,
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
  window.on('closed', () => {
    mainWindow = undefined;
    desktopMcp?.resetDocument();
  });
  protectWindow(window, isLocalPage, linkOutsideCanvas);
  window.webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) desktopMcp?.resetDocument();
  });
  window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && !PLAYGROUND_ROUTES.has(URL.parse(url)?.pathname)) desktopMcp?.resetDocument();
  });
  window.webContents.on('render-process-gone', () => desktopMcp?.resetDocument());
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
    await window.loadURL(`${origin}/`);
  } catch (error) {
    if (!window.isDestroyed()) throw error;
    return;
  }
  if (!window.isDestroyed()) window.show();
}

function isPlaygroundSender({ sender, senderFrame }) {
  if (!senderFrame || sender !== mainWindow?.webContents || senderFrame !== sender.mainFrame ||
    senderFrame.origin !== origin) return false;
  const url = URL.parse(senderFrame.url);
  return isLocalPage(url) && PLAYGROUND_ROUTES.has(url.pathname);
}

async function start() {
  startupStep = 'session configuration';
  const resources = path.join(process.resourcesPath, 'simulator');
  const currentSession = session.defaultSession;
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  currentSession.on('will-download', (event, item, sender, senderFrame) => {
    const localCanvasExport = isPlaygroundSender({ sender, senderFrame }) &&
      item.getInitiatorOrigin() === origin && item.getURL().startsWith(`blob:${origin}/`) &&
      item.getMimeType() === 'application/json' && item.getFilename().toLowerCase().endsWith('.json');
    if (!localCanvasExport) event.preventDefault();
  });

  let migrationStatus;
  if (app.isPackaged) {
    startupStep = 'app protocol';
    const staticDir = path.join(resources, 'frontend');
    const pricingFile = path.join(resources, 'data', 'us-east-1.json');
    await Promise.all([access(path.join(staticDir, 'index.html')), access(pricingFile)]);
    docServiceIds = new Set(require(path.join(resources, 'data', 'docs-service-ids.json')));
    const { createPricing } = require(path.join(resources, 'backend', 'pricing.js'));
    const migrationUrl = createMigrationUrl();
    await installAppProtocol({
      session: currentSession, staticDir, pricing: createPricing({ pricingFile }), migrationUrl,
    });
    startupStep = 'storage migration';
    migrationStatus = await migrateStorage({ BrowserWindow, session: currentSession, migrationUrl, serviceIds: docServiceIds });
  } else {
    startupStep = 'development supervisor';
    const { readDevRuntime, installDevRuntimeGuard } = require('./dev-runtime.cjs');
    devRuntime = readDevRuntime({ app });
    const { services } = require('../frontend/src/app/core/config/aws-services.json');
    docServiceIds = new Set(services.map(({ type }) => type));
    origin = devRuntime.origin;
    installDevRuntimeGuard({
      session: currentSession,
      runtime: devRuntime,
      onLost: () => forceStop(1),
    });
  }

  startupStep = 'MCP broker';
  const { startDesktopMcp } = require('./desktop-mcp.cjs');
  desktopMcp = await startDesktopMcp({
    ipcMain, mode, namespace, getWindow: () => mainWindow, authorize: isPlaygroundSender,
    mcpSourceDir: app.isPackaged ? path.join(resources, 'mcp', 'src') : undefined,
  });
  if (stopping) {
    await desktopMcp.close();
    return;
  }
  registerMcpSetup({
    ipcMain,
    clipboard,
    getWindow: () => mainWindow,
    origin, mode, namespace,
    launcherPath: devRuntime?.launcherPath ?? path.join(resources, 'willis-overengineer-inator-mcp'),
    launcherArgs: devRuntime?.launcherArgs,
    isCurrent: devRuntime?.isCurrent,
  });

  startupStep = 'playground window';
  readyToOpen = true;
  await showPlayground();
  await reportMigrationIssue({ status: migrationStatus, profilePath: app.getPath('userData'), window: mainWindow, dialog });
}

function failStartup(error) {
  if (stopping) return;
  console.error(`[desktop] Could not start during ${startupStep} (${error.code ?? error.name}).`);
  if (app.isPackaged) {
    dialog.showErrorBox(windowTitle, 'Could not start the local simulator. Rebuild or reinstall the application and try again.');
  }
  forceStop(1);
}

async function forceStop(code) {
  if (stopping) return;
  stopping = true;
  readyToOpen = false;
  if (app.isReady()) {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  }
  const deadline = setTimeout(() => app.exit(code), 1500);
  try {
    await desktopMcp?.close();
  } catch {
    console.error('[desktop] Could not clean up the MCP broker.');
  } finally {
    clearTimeout(deadline);
    app.exit(code);
  }
}

function launch() {
  if (namespace !== undefined && !/^[a-z0-9][a-z0-9-]{0,23}$/.test(namespace)) {
    throw new Error('Invalid MCP namespace');
  }
  // The profile must match the socket namespace so one Electron lock protects both.
  const profileName = namespace ? `${name}-${mode}-${namespace}` :
    mode === 'desktop' ? name : `${name}-dev`;
  const profilePath = path.join(app.getPath('appData'), profileName);
  if (app.commandLine.hasSwitch('user-data-dir') &&
    (!namespace || app.commandLine.getSwitchValue('user-data-dir') !== profilePath)) {
    throw new Error('User data directory does not match the MCP namespace');
  }
  mkdirSync(profilePath, { recursive: true });
  app.setPath('userData', profilePath);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const openWindow = () => showPlayground().catch(failStartup);
  app.on('second-instance', openWindow);
  app.on('activate', openWindow);
  // Keep the broker available for reopening the window from the macOS Dock.
  app.on('window-all-closed', () => {});
  app.on('will-quit', (event) => {
    if (stopping || !desktopMcp) return;
    event.preventDefault();
    forceStop(0);
  });
  process.once('SIGTERM', () => forceStop(0));
  process.once('SIGINT', () => forceStop(0));
  app.whenReady().then(start).catch(failStartup);
}

try {
  launch();
} catch (error) {
  failStartup(error);
}
