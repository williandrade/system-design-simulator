const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAIR_CHANNEL = 'canvas-mcp:pair';
const RESULT_CHANNEL = 'canvas-mcp:result';
const DISCONNECT_CHANNEL = 'canvas-mcp:disconnect';
const EVENT_CHANNEL = 'canvas-mcp:event';
const TOKEN = /^[a-f0-9-]{36}$/;
const MAX_PENDING_ACTIONS = 8;

async function startDesktopMcp({
  ipcMain, getWindow, authorize, mode, namespace,
  mcpSourceDir = path.join(__dirname, '..', 'mcp', 'src'),
}) {
  const moduleUrl = pathToFileURL(path.join(mcpSourceDir, 'relay', 'unix-broker.mjs'));
  const { startUnixBroker, MAX_FRAME_BYTES, PROTOCOL_VERSION } = await import(moduleUrl.href);
  const broker = await startUnixBroker({ mode, namespace });
  let documentGeneration = 0;
  let rendererSession;
  let stopping = false;
  let action = Promise.resolve();
  let pendingActions = 0;

  function register(channel, handle) {
    ipcMain.handle(channel, (event, ...args) => {
      if (stopping || pendingActions >= MAX_PENDING_ACTIONS || event.sender !== getWindow()?.webContents) return false;
      const generation = documentGeneration;
      pendingActions++;
      const next = action.then(async () => {
        if (stopping || generation !== documentGeneration || event.sender !== getWindow()?.webContents) return false;
        if (!await authorize(event) || generation !== documentGeneration || stopping) return false;
        return handle(event, ...args);
      }).catch(() => false).finally(() => {
        pendingActions--;
      });
      action = next;
      return next;
    });
  }

  function sendToRenderer(context, message) {
    if (context.generation !== documentGeneration || context.frame.detached) return false;
    try {
      context.frame.send(EVENT_CHANNEL, context.token, message);
      return true;
    } catch {
      return false;
    }
  }

  register(PAIR_CHANNEL, (event, token, canvasId, code) => {
    if (typeof token !== 'string' || !TOKEN.test(token) || rendererSession) return false;
    const context = { token, frame: event.senderFrame, generation: documentGeneration };
    const session = broker.pair({
      code,
      canvasId,
      send(message, onError) {
        if (!sendToRenderer(context, JSON.stringify(message))) onError();
      },
      onEnd() {
        if (rendererSession?.context !== context) return;
        rendererSession = undefined;
        sendToRenderer(context, null);
      },
    });
    if (!session) return false;
    rendererSession = { context, session };
    if (sendToRenderer(context, JSON.stringify({ version: PROTOCOL_VERSION, type: 'paired', canvasId }))) return true;
    session.end();
    return false;
  });

  register(RESULT_CHANNEL, (_, token, payload) => {
    if (!rendererSession || rendererSession.context.token !== token) return false;
    const { session } = rendererSession;
    let result;
    if (typeof payload === 'string' && Buffer.byteLength(payload) <= MAX_FRAME_BYTES) {
      try {
        result = JSON.parse(payload);
      } catch {
        // Invalid responses terminate the generation and leave the dispatched outcome unknown.
      }
    }
    session.receive(result?.version === PROTOCOL_VERSION ? result : null);
    return true;
  });

  register(DISCONNECT_CHANNEL, (_, token) => {
    if (rendererSession?.context.token !== token) return false;
    rendererSession.session.end();
    return true;
  });

  function resetDocument() {
    documentGeneration++;
    broker.endSession();
  }

  return {
    resetDocument,
    async close() {
      stopping = true;
      resetDocument();
      for (const channel of [PAIR_CHANNEL, RESULT_CHANNEL, DISCONNECT_CHANNEL]) ipcMain.removeHandler(channel);
      await broker.close();
    },
  };
}

module.exports = { startDesktopMcp };
