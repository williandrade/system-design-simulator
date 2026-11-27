import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, readFile, rm, symlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readLaunchOptions } from '../src/config.mjs';
import { startUnixBroker } from '../src/relay/unix-broker.mjs';
import { createUnixRelay } from '../src/relay/unix-client.mjs';
import { MAX_FRAME_BYTES } from '../src/relay/canvas-session.mjs';
import { addArgs, sampleNode, sampleState } from './helpers.mjs';

const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));

function paths(t, mode = 'desktop') {
  const namespace = `test-${randomBytes(5).toString('hex')}`;
  const root = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
  const directory = join(root, `woi-${process.getuid()}`, `${mode === 'desktop' ? 'p' : 'd'}-${namespace}`);
  const cleanup = [];
  t.after(async () => {
    try {
      for (const callback of cleanup.reverse()) await callback();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { mode, namespace, directory, descriptor: join(directory, 'endpoint.json'), defer: (callback) => cleanup.push(callback) };
}

function installCanvas(broker, code, canvasId = 'canvas-test', respond = () => {}) {
  let ended = false;
  const session = broker.pair({
    code,
    canvasId,
    send(message) { respond(message, session); },
    onEnd() { ended = true; },
  });
  return { session, ended: () => ended };
}

function resultFor(request, data) {
  return { type: 'result', ok: true, requestId: request.requestId, canvasId: request.canvasId, data };
}

function startClient(t, config) {
  const relay = createUnixRelay(config);
  t.after(() => relay.close());
  return relay;
}

test('selects explicit desktop modes and rejects duplicate arguments', () => {
  assert.deepEqual(readLaunchOptions([], {}), { mode: 'web', namespace: undefined });
  assert.deepEqual(readLaunchOptions(['--mode', 'desktop-dev', '--namespace', 'proof'], {}),
    { mode: 'desktop-dev', namespace: 'proof' });
  assert.throws(() => readLaunchOptions(['--mode', 'desktop', '--mode', 'web'], {}));
  assert.throws(() => readLaunchOptions(['--mode', 'desktop', '--namespace', '../unsafe'], {}));
});

test('the real stdio adapter starts before the app and resumes after it opens', { timeout: 10000 }, async (t) => {
  const config = paths(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--mode', config.mode, '--namespace', config.namespace],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'unix-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'apply_graph' && tool.annotations.destructiveHint));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  assert.equal((await call('get_canvas_pairing')).structuredContent.code, 'APP_UNAVAILABLE');

  const broker = await startUnixBroker(config);
  config.defer(() => broker.close());
  const { code, expiresInSeconds } = (await call('get_canvas_pairing')).structuredContent;
  assert.equal(expiresInSeconds, 300);
  const node = sampleNode;
  const batch = { revision: 1, dryRun: true, createdIds: [], removedIds: [node.id], updatedIds: [], refs: {} };
  const canvas = installCanvas(broker, code, 'canvas-stdio', (message, session) => {
    assert.equal(message.version, 1);
    const responses = { get_canvas_state: sampleState('canvas-stdio'), add_node: { node }, apply_graph: batch };
    const data = responses[message.tool];
    assert.ok(data);
    session.receive(resultFor(message, data));
  });
  assert.ok(canvas.session);
  assert.equal((await call('add_node', addArgs)).structuredContent.code, 'CANVAS_STATE_REQUIRED');
  assert.deepEqual((await call('get_canvas_state')).structuredContent, sampleState('canvas-stdio'));
  assert.deepEqual((await call('add_node', addArgs)).structuredContent, { node });
  const preview = await call('apply_graph', {
    expectedRevision: 1,
    dryRun: true,
    operations: [{ type: 'delete_node', args: { nodeId: node.id } }],
  });
  assert.deepEqual(preview.structuredContent, batch);
});

test('modes and pending codes are isolated while the first valid pair wins atomically', async (t) => {
  const prod = paths(t);
  const dev = paths(t, 'desktop-dev');
  const desktop = await startUnixBroker(prod);
  const development = await startUnixBroker(dev);
  prod.defer(() => desktop.close());
  dev.defer(() => development.close());
  const hosts = Array.from({ length: 5 }, () => startClient(t, prod));
  const devHost = startClient(t, dev);
  const [first, second, third, fourth] = await Promise.all(hosts.slice(0, 4).map((host) => host.issuePairing()));
  assert.ok([first, second, third, fourth].every((result) => result.ok));
  assert.equal((await hosts[4].issuePairing()).error.code, 'TOO_MANY_HOSTS');
  const developmentCode = (await devHost.issuePairing()).data.code;
  const replacement = (await hosts[1].issuePairing()).data.code;
  assert.equal(installCanvas(desktop, second.data.code).session, undefined);
  assert.equal(installCanvas(desktop, developmentCode).session, undefined);
  assert.equal(installCanvas(development, replacement).session, undefined);
  const productionCanvas = installCanvas(desktop, replacement, 'prod', (request, session) => {
    session.receive(resultFor(request, sampleState('prod')));
  });
  const developmentCanvas = installCanvas(development, developmentCode, 'dev', (request, session) => {
    session.receive(resultFor(request, sampleState('dev')));
  });
  assert.ok(productionCanvas.session && developmentCanvas.session);
  assert.equal((await hosts[0].request('get_canvas_state', {})).error.code, 'NOT_CONNECTED');
  assert.equal((await hosts[0].issuePairing()).error.code, 'ALREADY_CONNECTED');
  assert.equal((await hosts[1].request('get_canvas_state', {})).data.canvasId, 'prod');
  assert.equal((await devHost.request('get_canvas_state', {})).data.canvasId, 'dev');

  desktop.endSession();
  assert.equal(installCanvas(desktop, first.data.code).session, undefined);
  assert.equal((await devHost.request('get_canvas_state', {})).data.canvasId, 'dev');
  assert.equal(productionCanvas.ended(), true);
});

test('invalidating the canvas distinguishes dispatched and queued calls without replay', async (t) => {
  const config = paths(t);
  const broker = await startUnixBroker(config);
  config.defer(() => broker.close());
  const host = startClient(t, config);
  const writes = [];
  let observeDispatch;
  const dispatched = new Promise((resolve) => { observeDispatch = resolve; });
  const canvas = installCanvas(broker, (await host.issuePairing()).data.code, 'canvas-before', (request, session) => {
    if (request.tool === 'get_canvas_state') {
      session.receive(resultFor(request, sampleState('canvas-before')));
      return;
    }
    writes.push(request);
    observeDispatch();
  });
  await host.request('get_canvas_state', {});
  const pending = host.request('add_node', addArgs);
  const queued = host.request('add_node', addArgs);
  await dispatched;
  broker.endSession();
  assert.equal((await pending).error.code, 'RESULT_UNKNOWN');
  assert.equal((await queued).error.code, 'SESSION_ENDED');
  canvas.session.receive(resultFor(writes[0], { node: sampleNode }));
  const fresh = installCanvas(broker, (await host.issuePairing()).data.code, 'canvas-after', (request, session) => {
    session.receive(resultFor(request, sampleState('canvas-after', [sampleNode])));
  });
  assert.ok(fresh.session);
  assert.equal((await host.request('get_canvas_state', {})).data.nodes.length, 1);
  assert.equal(writes.length, 1);
});

test('rejects unsafe discovery and leaves a live listener untouched', async (t) => {
  const config = paths(t);
  const broker = await startUnixBroker(config);
  config.defer(() => broker.close());
  const host = startClient(t, config);
  const originalDescriptor = await readFile(config.descriptor, 'utf8');
  const socketPath = join(config.directory, JSON.parse(originalDescriptor));
  assert.equal((await lstat(config.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(config.descriptor)).mode & 0o777, 0o600);
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  await assert.rejects(startUnixBroker(config), { code: 'UNSAFE_CONFIGURATION' });
  assert.equal(await readFile(config.descriptor, 'utf8'), originalDescriptor);
  await chmod(config.descriptor, 0o644);
  try {
    assert.equal((await host.issuePairing()).error.code, 'UNSAFE_CONFIGURATION');
  } finally {
    await chmod(config.descriptor, 0o600);
  }
  assert.equal((await host.issuePairing()).ok, true);
});

test('recovering after a killed process rotates the socket and does not follow symlinks', { timeout: 10000 }, async (t) => {
  const config = paths(t);
  const brokerModule = new URL('../src/relay/unix-broker.mjs', import.meta.url);
  const script = `
    import { startUnixBroker } from ${JSON.stringify(brokerModule.href)};
    await startUnixBroker(${JSON.stringify({ mode: config.mode, namespace: config.namespace })});
    process.stdout.write('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  config.defer(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  assert.equal((await once(child.stdout, 'data'))[0].toString(), 'ready');
  const previous = JSON.parse(await readFile(config.descriptor, 'utf8'));
  child.kill('SIGKILL');
  await exited;
  assert.equal((await lstat(join(config.directory, previous))).isSocket(), true);
  const host = startClient(t, config);
  assert.equal((await host.issuePairing()).error.code, 'APP_UNAVAILABLE');

  const broker = await startUnixBroker(config);
  config.defer(() => broker.close());
  await assert.rejects(lstat(join(config.directory, previous)), { code: 'ENOENT' });
  assert.notEqual(JSON.parse(await readFile(config.descriptor, 'utf8')), previous);
  assert.equal((await host.issuePairing()).ok, true);
  await broker.close();
  await symlink(join(config.directory, 'missing'), config.descriptor);
  assert.equal((await host.issuePairing()).error.code, 'UNSAFE_CONFIGURATION');
  await assert.rejects(startUnixBroker(config), { code: 'UNSAFE_CONFIGURATION' });
});

test('native frames handle fragmentation, coalescing and malformed data', { timeout: 10000 }, async (t) => {
  const config = paths(t, 'desktop-dev');
  const broker = await startUnixBroker(config);
  config.defer(() => broker.close());
  const socketPath = join(config.directory, JSON.parse(await readFile(config.descriptor, 'utf8')));
  async function raw() {
    const socket = createConnection(socketPath);
    // EPIPE or ECONNRESET may be reported when the peer rejects invalid frames.
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  }
  const socket = await raw();
  t.after(() => socket.destroy());
  const received = [];
  let receiveFrames;
  const frames = new Promise((resolve) => { receiveFrames = resolve; });
  socket.setEncoding('utf8');
  let text = '';
  socket.on('data', (data) => {
    text += data;
    for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n')) {
      received.push(JSON.parse(text.slice(0, newline)));
      text = text.slice(newline + 1);
    }
    if (received.length === 2) receiveFrames();
  });
  socket.write('{"version":1,"type":"he');
  socket.write(`llo","mode":"desktop-dev"}\n${JSON.stringify({
    version: 1, type: 'call', id: randomUUID(), tool: 'get_canvas_pairing', args: {},
  })}\n`);
  await frames;
  assert.deepEqual(received.map(({ type }) => type), ['hello-result', 'call-result']);
  assert.ok(received.every(({ result }) => result.ok));

  const rejected = await raw();
  const rejectedClosed = new Promise((resolve) => rejected.once('close', resolve));
  rejected.setEncoding('utf8');
  let rejectedReply = '';
  rejected.on('data', (chunk) => { rejectedReply += chunk; });
  const followUp = { version: 1, type: 'hello', mode: 'desktop-dev' };
  rejected.write(`${JSON.stringify({ ...followUp, mode: 'desktop' })}\n${JSON.stringify(followUp)}\n`);
  await rejectedClosed;
  const rejection = rejectedReply.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(rejection.length, 1);
  assert.equal(rejection[0].type, 'hello-result');
  assert.equal(rejection[0].result.error.code, 'WRONG_MODE');

  for (const badFrame of [Buffer.from([0xc3, 0x28, 0x0a]), Buffer.from('{\n'), Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61)]) {
    const invalid = await raw();
    const closed = new Promise((resolveClose) => invalid.once('close', resolveClose));
    invalid.write(badFrame);
    await closed;
  }
});
