const { randomUUID } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { APP_ORIGIN, storageDocument } = require('./protocol.cjs');

const WORKSPACE = 'aws-system-design-simulator-workspace';
const PROJECT = 'aws-system-design-simulator-project';
const THEME = 'sr-architect-darkmode';
const PROGRESS = 'sds.challengeProgress';
const ONBOARDING = 'sds.onboardingComplete';
const HOTKEYS = 'sds.hotkeysSeen';
const VOTES = 'sds.challengeVotes';
const DATA_KEYS = [WORKSPACE, PROJECT, THEME, PROGRESS, ONBOARDING, HOTKEYS, VOTES];
const MIGRATION_MARKER = 'sds.desktopStorageMigration.v1';
const MAX_SNAPSHOT_CHARS = 5 * 1024 * 1024;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value, keys) => keys.every((key) => typeof value[key] === 'string');
const numbers = (value, keys) => keys.every((key) => Number.isFinite(value[key]));
const optionalNumbers = (value, keys) => keys.every((key) => value[key] === undefined || Number.isFinite(value[key]));
const members = (value, validate) => Array.isArray(value) && value.every(validate);

function isPort(value) {
  return object(value) && strings(value, ['id', 'label', 'direction', 'type']);
}

function isNode(value, serviceIds) {
  return object(value) && strings(value, ['id', 'type', 'name']) && serviceIds.has(value.type) &&
    numbers(value, ['x', 'y']) && object(value.config) && members(value.ports, isPort) &&
    object(value.metrics) && optionalNumbers(value.metrics, [
      'processed', 'received', 'dropped', 'retried', 'queueSize', 'avgLatency', 'cpuPressure',
      'memoryPressure', 'errorRate', 'throughput',
    ]);
}

function isConnection(value) {
  return object(value) && strings(value, ['id', 'sourceNodeId', 'sourcePortId', 'targetNodeId', 'targetPortId', 'type']) &&
    object(value.traffic) && numbers(value.traffic, ['requestsPerSecond', 'latency', 'errorRate', 'intensity']);
}

function isAnnotation(value) {
  return object(value) && strings(value, ['id', 'text']) &&
    numbers(value, ['x', 'y', 'width', 'height', 'fontSize']);
}

function isGraph(value, serviceIds) {
  return object(value) && members(value.nodes, (node) => isNode(node, serviceIds)) &&
    members(value.connections, isConnection) &&
    (value.annotations === undefined || members(value.annotations, isAnnotation)) &&
    ['id', 'name', 'projectName', 'currency', 'region'].every((key) =>
      value[key] === undefined || typeof value[key] === 'string');
}

function validateSnapshot(snapshot, serviceIds) {
  for (const [key, raw] of Object.entries(snapshot)) {
    if (raw === null) continue;
    const value = JSON.parse(raw);
    switch (key) {
      case WORKSPACE:
        if (!object(value) || !members(value.tabs, (tab) => isGraph(tab, serviceIds)) ||
          !Number.isSafeInteger(value.activeIndex ?? 0)) throw new Error('Invalid workspace');
        break;
      case PROJECT:
        if (!isGraph(value, serviceIds)) throw new Error('Invalid project');
        break;
      case THEME:
      case ONBOARDING:
      case HOTKEYS:
        if (typeof value !== 'boolean') throw new Error('Invalid preference');
        break;
      case PROGRESS:
        if (!object(value) || !Object.values(value).every(object)) throw new Error('Invalid progress');
        break;
      case VOTES:
        if (!object(value) || !Object.values(value).every((vote) => [null, 'up', 'down'].includes(vote))) {
          throw new Error('Invalid votes');
        }
        break;
    }
  }
}

function decideMigration(source, target) {
  const updates = {};
  const differs = (key) => target[key] !== null && source[key] !== target[key];
  const conflicts = [];
  const hasLegacyProject = source[WORKSPACE] !== null || source[PROJECT] !== null;
  const projectConflict = hasLegacyProject && (differs(WORKSPACE) || differs(PROJECT));
  for (const key of DATA_KEYS) {
    if (key === WORKSPACE || key === PROJECT) {
      if (projectConflict) {
        conflicts.push(key);
        continue;
      }
    } else if (source[key] !== null && differs(key)) {
      conflicts.push(key);
      continue;
    }
    if (source[key] !== null && target[key] === null) updates[key] = source[key];
  }
  return { updates, conflicts };
}

function newStorageWindow(BrowserWindow, session) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  return window;
}

async function readSnapshot(window) {
  const snapshot = await window.webContents.executeJavaScript(`(() => {
    let length = 0;
    const snapshot = {};
    for (const key of ${JSON.stringify(DATA_KEYS)}) {
      const value = localStorage.getItem(key);
      length += value?.length ?? 0;
      if (length > ${MAX_SNAPSHOT_CHARS}) return null;
      snapshot[key] = value;
    }
    return snapshot;
  })()`);
  if (!snapshot) throw new Error('Storage snapshot too large');
  return snapshot;
}

async function readLegacy(BrowserWindow, session) {
  const legacyUrl = `http://127.0.0.1:4200/__storage_migration?token=${randomUUID()}`;
  const window = newStorageWindow(BrowserWindow, session);
  let installed = false;
  try {
    session.protocol.handle('http', (request) =>
      request.url === legacyUrl && request.method === 'GET' && request.initiatorOrigin === undefined
        ? storageDocument(request) : new Response(null, { status: 403 }));
    installed = true;
    await window.loadURL(legacyUrl);
    return await readSnapshot(window);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    if (installed) session.protocol.unhandle('http');
  }
}

function createMigrationUrl() {
  return `${APP_ORIGIN}/__storage_migration?token=${randomUUID()}`;
}

async function migrateStorage({ BrowserWindow, session, migrationUrl, serviceIds }) {
  const destination = newStorageWindow(BrowserWindow, session);
  let step = 'open destination';
  try {
    await destination.loadURL(migrationUrl);
    const marker = JSON.stringify(MIGRATION_MARKER);
    const alreadyMigrated = await destination.webContents.executeJavaScript(`localStorage.getItem(${marker}) === 'true'`);
    if (alreadyMigrated) return 'already-migrated';
    step = 'read legacy storage';
    const source = await readLegacy(BrowserWindow, session);
    step = 'validate legacy storage';
    validateSnapshot(source, serviceIds);
    step = 'read destination storage';
    const target = await readSnapshot(destination);
    const { updates, conflicts } = decideMigration(source, target);
    step = 'write destination storage';
    const moved = await destination.webContents.executeJavaScript(`(() => {
      const updates = ${JSON.stringify(updates)};
      for (const [key, value] of Object.entries(updates)) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
      return Object.entries(updates).every(([key, value]) => localStorage.getItem(key) === value);
    })()`);
    if (!moved) return 'conflict';
    session.flushStorageData();
    if (conflicts.length) return 'conflict';
    await destination.webContents.executeJavaScript(`localStorage.setItem(${marker}, 'true')`);
    session.flushStorageData();
    return DATA_KEYS.every((key) => source[key] === null) ? 'no-data' : 'migrated';
  } catch (error) {
    console.error(`[desktop] Could not ${step} during migration (${error.code ?? error.name}).`);
    return 'error';
  } finally {
    if (!destination.isDestroyed()) destination.destroy();
  }
}

async function reportMigrationIssue({ status, profilePath, window, dialog }) {
  if (status !== 'conflict' && status !== 'error') return;
  const notice = path.join(profilePath, 'desktop-storage-migration-v1-notice');
  try {
    if (await readFile(notice, 'utf8') === status) return;
  } catch {
    // A new profile has no notice.
  }
  try {
    await writeFile(notice, status, { mode: 0o600 });
  } catch {
    // An unwritable profile may also prevent recording the warning.
  }
  if (!window || window.isDestroyed()) return;
  await dialog.showMessageBox(window, {
    type: 'warning',
    message: 'Some saved simulator data could not be moved.',
    detail: 'Your previous data is still available in the earlier app. Export saved canvases there and import them here.',
    buttons: ['OK'],
  });
}

module.exports = { createMigrationUrl, migrateStorage, reportMigrationIssue };
