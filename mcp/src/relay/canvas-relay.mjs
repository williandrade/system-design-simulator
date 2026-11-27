import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { failure, success } from '../shared/result.mjs';
import { canvasIdSchema } from '../tools/schemas.mjs';
import { createCanvasSession, MAX_FRAME_BYTES, PAIRING_TTL_MS, PAIRING_TIMEOUT_MS } from './canvas-session.mjs';
import { isPairingCode, readFrame, send } from './protocol.mjs';

export const DEFAULT_RELAY_PORT = 4301;
const ORIGINS = new Set(['http://localhost:4200', 'http://127.0.0.1:4200']);
const PAIRING_PATH = '/canvas';
const CODE_BYTES = 16;

export async function startCanvasRelay({
  port = DEFAULT_RELAY_PORT,
  operatorCode,
  pairingTtlMs = PAIRING_TTL_MS,
  requestTimeoutMs,
} = {}) {
  const operatorPairing = operatorCode !== undefined;
  if (operatorPairing && !isPairingCode(operatorCode)) {
    throw new Error('The operator pairing code must encode 16 random bytes as base64url.');
  }

  let pairing = operatorPairing ? { code: operatorCode, expiresAt: Date.now() + pairingTtlMs } : null;
  operatorCode = undefined;
  let waitingSocket = null;
  let active = null;
  const httpServer = createServer((_, response) => response.writeHead(404).end());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, closeTimeout: 1000 });

  function issuePairing() {
    if (active) return failure('ALREADY_CONNECTED', 'Disconnect the current canvas to pair another.');
    if (operatorPairing) return failure('OPERATOR_PAIRING', 'Pairing is managed by the local operator.');
    const code = randomBytes(CODE_BYTES).toString('base64url');
    pairing = { code, expiresAt: Date.now() + pairingTtlMs };
    return success({ code, expiresInSeconds: Math.ceil(pairingTtlMs / 1000) });
  }

  function accept(socket) {
    socket.on('error', () => socket.terminate());
    if (active || waitingSocket) {
      socket.close(1008, 'Canvas already connected');
      return;
    }
    waitingSocket = socket;
    let session;
    const timer = setTimeout(() => socket.close(1008, 'Pairing timed out'), PAIRING_TIMEOUT_MS);

    socket.on('close', () => {
      clearTimeout(timer);
      if (waitingSocket === socket) waitingSocket = null;
      if (session) session.end();
    });
    socket.on('message', (data, isBinary) => {
      const message = readFrame(data, isBinary);
      if (session) {
        session.receive(message);
        return;
      }
      if (waitingSocket !== socket || socket.readyState !== socket.OPEN) return;
      if (message?.type !== 'pair' || !canvasIdSchema.safeParse(message.canvasId).success
        || !pairing || Date.now() >= pairing.expiresAt || !isPairingCode(message.code)
        || !timingSafeEqual(Buffer.from(pairing.code), Buffer.from(message.code))) {
        socket.close(1008, 'Invalid or expired pairing code');
        return;
      }

      pairing = null;
      waitingSocket = null;
      clearTimeout(timer);
      session = createCanvasSession({
        canvasId: message.canvasId,
        requestTimeoutMs,
        send: (frame, onError) => send(socket, frame, onError),
        onEnd() {
          active = null;
          socket.close(1000, 'Canvas session ended');
        },
      });
      active = session;
      send(socket, { type: 'paired', canvasId: message.canvasId }, () => session.end());
    });
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const relayPort = httpServer.address().port;
    const validHost = request.headers.host === `127.0.0.1:${relayPort}` || request.headers.host === `localhost:${relayPort}`;
    if (!validHost || !ORIGINS.has(request.headers.origin) || request.url !== PAIRING_PATH) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, accept);
  });

  httpServer.listen(port, '127.0.0.1');
  await once(httpServer, 'listening');

  return {
    port: httpServer.address().port,
    issuePairing,
    request(tool, args, signal) {
      return active?.request(tool, args, signal) ??
        Promise.resolve(failure('NOT_CONNECTED', 'Pair the canvas before using this tool.'));
    },
    async close() {
      pairing = null;
      active?.end();
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all([
        new Promise((resolve) => sockets.close(resolve)),
        new Promise((resolve) => httpServer.close(resolve)),
      ]);
    },
  };
}
