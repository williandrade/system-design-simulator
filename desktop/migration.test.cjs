const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { createMigrationUrl, migrateStorage } = require('./migration.cjs');

const WORKSPACE = 'aws-system-design-simulator-workspace';
const PROJECT = 'aws-system-design-simulator-project';
const MARKER = 'sds.desktopStorageMigration.v1';
const THEME = 'sr-architect-darkmode';
const workspace = { activeIndex: 0, tabs: [{ name: 'Legacy', nodes: [], connections: [] }] };
const project = { name: 'Legacy', nodes: [], connections: [] };

function fixture() {
  const legacy = new Map([[WORKSPACE, JSON.stringify(workspace)], [PROJECT, JSON.stringify(project)], [THEME, 'true']]);
  const destination = new Map();
  const handlers = new Map();
  let flushed = 0;
  const migrationUrl = createMigrationUrl();
  const session = {
    protocol: {
      handle: (scheme, listener) => handlers.set(scheme, listener),
      unhandle: (scheme) => handlers.delete(scheme),
    },
    flushStorageData: () => flushed++,
  };

  class BrowserWindow {
    webContents = {
      setWindowOpenHandler() {},
      on() {},
      executeJavaScript: (script) => runInNewContext(script, { localStorage: this.storage }),
    };

    loadURL(url) {
      const source = url.startsWith('http:');
      if (source) assert.equal(handlers.get('http')({ url, method: 'GET' }).status, 200);
      const storage = source ? legacy : destination;
      this.storage = {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      };
    }

    isDestroyed() { return false; }
    destroy() {}
  }

  return {
    legacy, destination, handlers,
    flushes: () => flushed,
    migrate: () => migrateStorage({ BrowserWindow, session, migrationUrl, serviceIds: new Set(['client']) }),
  };
}

test('keeps the project pair together and resumes when the workspace matches the legacy copy', async () => {
  const state = fixture();
  state.destination.set(WORKSPACE, JSON.stringify({ ...workspace, tabs: [{ ...workspace.tabs[0], name: 'Edited' }] }));
  assert.equal(await state.migrate(), 'conflict');
  assert.equal(state.destination.has(PROJECT), false);
  assert.equal(state.destination.has(MARKER), false);
  assert.equal(state.destination.get(THEME), 'true');
  assert.equal(state.handlers.has('http'), false);

  state.destination.set(WORKSPACE, state.legacy.get(WORKSPACE));
  assert.equal(await state.migrate(), 'migrated');
  assert.equal(state.destination.get(PROJECT), state.legacy.get(PROJECT));
  assert.equal(state.destination.get(MARKER), 'true');
  assert.equal(await state.migrate(), 'already-migrated');
  assert.equal(state.flushes(), 3);
});

test('rejects malformed members before writing anything to the destination', async (t) => {
  t.mock.method(console, 'error', () => {});
  const state = fixture();
  for (const key of ['nodes', 'connections', 'annotations']) {
    const malformed = JSON.stringify({ ...workspace, tabs: [{ ...workspace.tabs[0], [key]: [null] }] });
    state.legacy.set(WORKSPACE, malformed);
    assert.equal(await state.migrate(), 'error');
    assert.equal(state.destination.size, 0);
    assert.equal(state.legacy.get(WORKSPACE), malformed);
    assert.equal(state.handlers.has('http'), false);
  }
});
