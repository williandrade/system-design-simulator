const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerMcpSetup } = require('./mcp-setup.cjs');

const origin = 'http://127.0.0.1:4200';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mcp-setup-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const launcherPath = path.join(directory, "Cópia ' $(echo expanded) `echo expanded` $USER");
  writeFileSync(launcherPath, '', { mode: 0o700 });
  const senderFrame = { origin, url: `${origin}/` };
  const sender = { mainFrame: senderFrame };
  const handlers = new Map();
  const writes = [];
  registerMcpSetup({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    clipboard: { writeText: (text) => writes.push(text) },
    getWindow: () => ({ webContents: sender }),
    origin,
    launcherPath,
  });
  return {
    event: { sender, senderFrame },
    launcherPath,
    get: handlers.get('mcp-setup:get'),
    copy: handlers.get('mcp-setup:copy'),
    writes,
  };
}

test('quotes the bundled launcher as one literal argument for both clients', (t) => {
  const { event, get, copy, launcherPath, writes } = fixture(t);
  const setup = get(event);
  assert.equal(setup.launcherPath, launcherPath);
  for (const client of ['codex', 'claude']) {
    assert.equal(copy(event, client), true);
    assert.equal(writes.at(-1), setup.commands[client]);
    const prefix = client === 'codex'
      ? 'codex mcp add willis-overengineer-inator -- '
      : 'claude mcp add --transport stdio --scope user willis-overengineer-inator -- ';
    assert.ok(setup.commands[client].startsWith(prefix));
    const quotedPath = setup.commands[client].slice(prefix.length);
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${quotedPath}`], { encoding: 'utf8' }), launcherPath);
  }
  event.senderFrame.url = `${origin}/playground?mode=architect`;
  assert.deepEqual(get(event), setup);
});

test('rejects other clients, windows, frames, origins, routes and missing launchers', (t) => {
  const { event, get, copy, launcherPath, writes } = fixture(t);
  for (const rejected of [
    { ...event, senderFrame: null },
    { ...event, sender: { mainFrame: event.senderFrame } },
    { ...event, senderFrame: { ...event.senderFrame } },
  ]) {
    assert.equal(get(rejected), null);
    assert.equal(copy(rejected, 'codex'), false);
  }
  assert.equal(copy(event, 'terminal command'), false);

  event.senderFrame.origin = 'http://localhost:4200';
  assert.equal(get(event), null);
  assert.equal(copy(event, 'claude'), false);

  event.senderFrame.origin = origin;
  event.senderFrame.url = `${origin}/docs`;
  assert.equal(get(event), null);
  assert.equal(copy(event, 'claude'), false);

  event.senderFrame.url = `${origin}/playground`;
  rmSync(launcherPath);
  assert.equal(get(event), null);
  assert.equal(copy(event, 'claude'), false);
  assert.deepEqual(writes, []);
});
