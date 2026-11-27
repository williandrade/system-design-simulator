import { randomBytes, timingSafeEqual } from 'node:crypto';
import { failure, success } from '../shared/result.mjs';
import { canvasTools } from '../tools/canvas-tools.mjs';
import { canvasIdSchema } from '../tools/schemas.mjs';
import {
  createCanvasSession, MAX_REQUESTS, PAIRING_TTL_MS, PAIRING_TIMEOUT_MS,
} from './canvas-session.mjs';
import { isPairingCode, PROTOCOL_VERSION } from './protocol.mjs';
import { listenUnixEndpoint } from './unix-endpoint.mjs';
import { attachUnixFrames, UNIX_PROTOCOL_VERSION, writeUnixFrame } from './unix-frames.mjs';

export { MAX_FRAME_BYTES } from './canvas-session.mjs';
export { PROTOCOL_VERSION } from './protocol.mjs';

const MAX_PENDING_HOSTS = 4;
const CLOSE_TIMEOUT_MS = 500;
const ID = /^[a-f0-9-]{36}$/;

export async function startUnixBroker({
  mode, namespace, requestTimeoutMs, pairingTtlMs = PAIRING_TTL_MS,
}) {
  const hosts = new Set();
  let active;
  let closing;

  function armIdleDeadline(host, timeout) {
    clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => host.socket.destroy(), timeout);
    host.idleTimer.unref();
  }

  function issuePairing(host) {
    if (active) return failure('ALREADY_CONNECTED', 'Disconnect the current canvas to pair another.');
    const code = randomBytes(16).toString('base64url');
    host.pairing = { code, expiresAt: Date.now() + pairingTtlMs };
    return success({ code, expiresInSeconds: Math.ceil(pairingTtlMs / 1000) });
  }

  function accept(socket) {
    const host = { socket, calls: new Map(), handshake: 'pending' };
    socket.on('error', () => socket.destroy());
    if (closing) {
      socket.destroy();
      return;
    }
    if (hosts.size - Number(Boolean(active)) >= MAX_PENDING_HOSTS) {
      writeUnixFrame(socket, {
        type: 'hello-result',
        result: failure('TOO_MANY_HOSTS', 'Too many MCP clients are waiting to pair with the app.'),
      });
      socket.destroySoon();
      return;
    }

    hosts.add(host);
    armIdleDeadline(host, PAIRING_TIMEOUT_MS);
    socket.once('close', () => {
      hosts.delete(host);
      clearTimeout(host.idleTimer);
      if (active?.host === host) active.session.end();
      for (const controller of host.calls.values()) controller.abort();
    });
    attachUnixFrames(socket, (message) => {
      if (host.handshake === 'rejected') return;
      if (host.handshake === 'accepted') {
        if (active?.host !== host) armIdleDeadline(host, pairingTtlMs);
        receiveCall(host, message);
        return;
      }
      if (message.type !== 'hello') {
        socket.destroy();
        return;
      }
      const result = message.version !== UNIX_PROTOCOL_VERSION
        ? failure('PROTOCOL_MISMATCH', 'The app and MCP launcher use incompatible protocol versions.')
        : message.mode !== mode
          ? failure('WRONG_MODE', 'This MCP launcher points to a different desktop mode.')
          : success({ mode });
      host.handshake = result.ok ? 'accepted' : 'rejected';
      writeUnixFrame(socket, { type: 'hello-result', result });
      if (!result.ok) {
        socket.destroySoon();
        return;
      }
      armIdleDeadline(host, pairingTtlMs);
    });
  }

  function receiveCall(host, message) {
    const { socket, calls } = host;
    const { id, tool, args } = message;
    if (message.version !== UNIX_PROTOCOL_VERSION || typeof id !== 'string' || !ID.test(id)) {
      socket.destroy();
      return;
    }
    if (message.type === 'cancel') {
      calls.get(id)?.abort();
      return;
    }
    if (message.type !== 'call' || calls.has(id) || calls.size >= MAX_REQUESTS + 1) {
      socket.destroy();
      return;
    }
    const respond = (result) => writeUnixFrame(socket, { type: 'call-result', id, result });
    const input = canvasTools.get(tool)?.input.safeParse(args);
    if (!input?.success) {
      respond(failure('INVALID_ARGUMENT', 'The app received an invalid canvas tool or arguments.'));
      return;
    }
    if (tool === 'get_canvas_pairing') {
      respond(issuePairing(host));
      return;
    }
    if (active?.host !== host) {
      respond(failure('NOT_CONNECTED', 'Pair the canvas before using this tool.'));
      return;
    }

    const controller = new AbortController();
    calls.set(id, controller);
    active.session.request(tool, input.data, controller.signal).then((result) => {
      calls.delete(id);
      if (!socket.destroyed) respond(result);
    });
  }

  function pair({ code, canvasId, send, onEnd }) {
    if (closing || active || !canvasIdSchema.safeParse(canvasId).success || !isPairingCode(code)) return undefined;
    const supplied = Buffer.from(code);
    const host = [...hosts].find(({ pairing, socket }) => pairing
      && !socket.destroyed && Date.now() < pairing.expiresAt
      && timingSafeEqual(supplied, Buffer.from(pairing.code)));
    if (!host) return undefined;

    for (const client of hosts) client.pairing = undefined;
    clearTimeout(host.idleTimer);
    const session = createCanvasSession({
      canvasId,
      send: (message, onError) => send({ version: PROTOCOL_VERSION, ...message }, onError),
      requestTimeoutMs,
      onEnd() {
        active = undefined;
        if (!host.socket.destroyed) armIdleDeadline(host, pairingTtlMs);
        onEnd();
      },
    });
    active = { host, session };
    return session;
  }

  const listener = await listenUnixEndpoint({ mode, namespace, accept });
  return {
    pair,
    endSession: () => active?.session.end(),
    close() {
      closing ??= Promise.resolve().then(async () => {
        active?.session.end();
        // Let the broker report known queued outcomes before closing each connection.
        await Promise.resolve();
        for (const host of hosts) host.socket.destroySoon();
        const deadline = setTimeout(() => {
          for (const host of hosts) host.socket.destroy();
        }, CLOSE_TIMEOUT_MS);
        try {
          await listener.close();
        } finally {
          clearTimeout(deadline);
        }
      });
      return closing;
    },
  };
}
