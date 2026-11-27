const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOST = '127.0.0.1';
const FRONTEND_PORT = 4200;
const BACKEND_PORT = 3001;
const ORIGIN = `http://${HOST}:${FRONTEND_PORT}`;
const DEV_RUNTIME_ENV = 'SIMULATOR_DESKTOP_DEV_RUNTIME';

function listenersOn(port) {
  let output;
  try {
    output = execFileSync(
      '/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_000 },
    );
  } catch (error) {
    // lsof reports no matches with exit 1 and empty output.
    if (error.status === 1 && !error.stdout && !error.stderr) return [];
    throw error;
  }

  const listeners = [];
  let pid;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n')) listeners.push({ pid, address: line.slice(1) });
  }
  return listeners;
}

function ownsListener(port, pid, listeners = listenersOn(port)) {
  return listeners.length === 1 && listeners[0].pid === pid &&
    listeners[0].address === `${HOST}:${port}`;
}

function readDevRuntime({ app }) {
  if (app.isPackaged) return null;
  let metadata;
  try {
    metadata = JSON.parse(process.env[DEV_RUNTIME_ENV] ?? 'null');
  } catch {
    // Ignore malformed metadata and reject startup below.
  }

  const validPid = (pid) => Number.isSafeInteger(pid) && pid > 1;
  if (!metadata || !validPid(metadata.supervisorPid) ||
      !validPid(metadata.frontendPid) || !validPid(metadata.backendPid) ||
      new Set([metadata.supervisorPid, metadata.frontendPid, metadata.backendPid]).size !== 3 ||
      typeof metadata.node !== 'string' || !path.isAbsolute(metadata.node)) {
    throw new Error('Start Electron development with npm run dev --prefix desktop.');
  }
  const isCurrent = () => {
    try {
      return process.ppid === metadata.supervisorPid &&
        ownsListener(FRONTEND_PORT, metadata.frontendPid) &&
        ownsListener(BACKEND_PORT, metadata.backendPid);
    } catch {
      return false;
    }
  };
  if (!isCurrent()) throw new Error('The development server is no longer owned by the supervisor.');

  return {
    origin: ORIGIN,
    launcherPath: metadata.node,
    launcherArgs: [path.join(__dirname, '..', 'mcp', 'src', 'index.mjs'), '--mode', 'desktop-dev'],
    isCurrent,
  };
}

function installDevRuntimeGuard({ session, runtime, onLost }) {
  const hmrOrigin = runtime.origin.replace(/^http:/, 'ws:');
  let lost = false;
  function validate() {
    if (lost) return false;
    if (runtime.isCurrent()) return true;
    lost = true;
    clearInterval(monitor);
    queueMicrotask(onLost);
    return false;
  }
  const monitor = setInterval(validate, 500);
  monitor.unref();

  session.webRequest.onBeforeRequest(
    { urls: ['http://127.0.0.1/*', 'ws://*/*', 'wss://*/*'] },
    ({ url, resourceType }, callback) => {
      const requestUrl = URL.parse(url);
      if (requestUrl?.protocol === 'ws:' || requestUrl?.protocol === 'wss:') {
        // Allow the Angular HMR socket only. Missing preload never enables the browser relay.
        callback({ cancel: requestUrl.origin !== hmrOrigin || !validate() });
        return;
      }
      callback({ cancel: resourceType === 'mainFrame' && !validate() });
    },
  );
}

module.exports = {
  HOST, FRONTEND_PORT, BACKEND_PORT, ORIGIN, DEV_RUNTIME_ENV,
  listenersOn, ownsListener, readDevRuntime, installDevRuntimeGuard,
};
