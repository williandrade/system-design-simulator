import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import runtime from '../dev-runtime.cjs';

const { HOST, FRONTEND_PORT, BACKEND_PORT, ORIGIN, DEV_RUNTIME_ENV, listenersOn, ownsListener } = runtime;
const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const frontendDir = fileURLToPath(new URL('../../frontend/', import.meta.url));
const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
const mcpDir = fileURLToPath(new URL('../../mcp/', import.meta.url));
const angularCli = join(frontendDir, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const children = [];
const shutdown = new AbortController();
let exitCode = 0;

function stop(code) {
  if (shutdown.signal.aborted) return;
  exitCode = code;
  shutdown.abort();
}

function spawnChild(label, executable, args, options) {
  // Only these direct children and their dedicated process groups belong to this supervisor.
  const child = spawn(executable, args, { ...options, detached: true, stdio: 'inherit' });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`[desktop dev] Could not start ${label}: ${error.message}`);
      stop(1);
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (!shutdown.signal.aborted) {
        if (code !== 0 || label !== 'Electron') {
          console.error(`[desktop dev] ${label} exited (${signal ?? code}).`);
          stop(1);
        } else {
          stop(0);
        }
      }
      resolve();
    });
  });
  children.push({ child, exited });
  return child;
}

function enforceOwnership(port, pid) {
  const listeners = listenersOn(port);
  if (!listeners.length) return false;
  if (!ownsListener(port, pid, listeners)) throw new Error(`Port ${port} is in use by a different listener.`);
  return true;
}

async function waitForDevServers(frontend, backend) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    const angularReady = enforceOwnership(FRONTEND_PORT, frontend.pid);
    const backendReady = enforceOwnership(BACKEND_PORT, backend.pid);
    if (angularReady && backendReady) {
      const status = await fetch(`${ORIGIN}/api/status`, {
        redirect: 'error',
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(3_000)]),
      });
      if (status.status !== 200 || !status.headers.get('content-type')?.startsWith('application/json')) {
        throw new Error('Angular proxy did not return a successful JSON pricing status.');
      }
      const body = await status.json();
      if (!Array.isArray(body?.cachedRegions) || !body.cachedRegions.every((region) => typeof region === 'string') ||
          typeof body.kvConfigured !== 'boolean') {
        throw new Error('Angular proxy returned an unexpected pricing status.');
      }
      if (enforceOwnership(FRONTEND_PORT, frontend.pid) &&
          enforceOwnership(BACKEND_PORT, backend.pid)) return;
    }
    await delay(250, undefined, { signal: shutdown.signal });
  }
  throw new Error('Angular and the pricing backend did not become ready in time.');
}

function signalProcessGroups(signal) {
  for (const { child } of children.toReversed()) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`[desktop dev] Could not stop process ${child.pid}.`);
    }
  }
}

async function stopChildren() {
  signalProcessGroups('SIGTERM');
  const exited = Promise.all(children.map((child) => child.exited));
  // A modal dialog or a stubborn descendant must not keep dev terminals or ports occupied.
  const graceful = await Promise.race([exited.then(() => true), delay(2_000, false, { ref: false })]);
  signalProcessGroups('SIGKILL');
  if (!graceful) await Promise.race([exited, delay(500, undefined, { ref: false })]);
}

// npm may forward a signal that the terminal already sent to the foreground group.
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Electron development requires an Apple Silicon Mac.');
  }
  for (const directory of [frontendDir, backendDir, mcpDir]) {
    try {
      await access(join(directory, 'node_modules'));
    } catch {
      throw new Error(`Install the dependencies with npm ci --prefix "${directory}".`);
    }
  }
  for (const port of [FRONTEND_PORT, BACKEND_PORT]) {
    if (listenersOn(port).length) throw new Error(`Port ${port} is already in use.`);
  }
  shutdown.signal.throwIfAborted();

  const backend = spawnChild('pricing backend', process.execPath, [join(backendDir, 'server.js')], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(BACKEND_PORT), BIND_HOST: HOST },
  });
  const frontendEnv = { ...process.env };
  delete frontendEnv.PORT;
  const frontend = spawnChild('Angular', process.execPath, [
    angularCli, 'serve', '--host', HOST, '--port', String(FRONTEND_PORT), '--hmr', '--live-reload',
  ], { cwd: frontendDir, env: frontendEnv });

  await waitForDevServers(frontend, backend);
  shutdown.signal.throwIfAborted();
  const electronEnv = {
    ...process.env,
    [DEV_RUNTIME_ENV]: JSON.stringify({
      supervisorPid: process.pid,
      frontendPid: frontend.pid,
      backendPid: backend.pid,
      node: process.execPath,
    }),
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  delete electronEnv.NODE_OPTIONS;
  console.log(`[desktop dev] Opening Electron at ${ORIGIN}.`);
  const waitForStop = new Promise((resolve) => shutdown.signal.addEventListener('abort', resolve, { once: true }));
  spawnChild('Electron', electron, [join(desktopDir, 'main.cjs')], { cwd: desktopDir, env: electronEnv });
  await waitForStop;
} catch (error) {
  if (!shutdown.signal.aborted) {
    console.error(`[desktop dev] ${error.message}`);
    stop(1);
  }
} finally {
  await stopChildren();
  process.exitCode = exitCode;
}
