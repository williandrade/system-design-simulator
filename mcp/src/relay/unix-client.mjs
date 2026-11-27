import { randomUUID } from 'node:crypto';
import { failure } from '../shared/result.mjs';
import {
  MAX_REQUESTS, PAIRING_TIMEOUT_MS, REQUEST_TIMEOUT_MS, resultUnknown,
} from './canvas-session.mjs';
import { isResult } from './protocol.mjs';
import { connectUnixEndpoint } from './unix-endpoint.mjs';
import { attachUnixFrames, UNIX_PROTOCOL_VERSION, writeUnixFrame } from './unix-frames.mjs';

const RESULT_TIMEOUT_MS = (MAX_REQUESTS + 1) * REQUEST_TIMEOUT_MS;

function unavailable() {
  return failure('APP_UNAVAILABLE', 'Open this desktop app and try the MCP tool again.');
}

export function createUnixRelay({ mode, namespace }) {
  let connection;
  let opening;
  let closed = false;

  async function open() {
    let socket;
    try {
      socket = await connectUnixEndpoint(mode, namespace);
    } catch (error) {
      const missing = ['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code);
      return missing ? unavailable()
        : failure('UNSAFE_CONFIGURATION', 'The app’s MCP endpoint has unsafe ownership, permissions or metadata.');
    }
    if (closed) {
      socket.destroy();
      return unavailable();
    }

    return new Promise((resolve) => {
      const state = { socket, pending: new Map() };
      let negotiated = false;
      const timer = setTimeout(() => socket.destroy(), PAIRING_TIMEOUT_MS);
      socket.once('close', () => {
        clearTimeout(timer);
        if (connection === state) connection = undefined;
        if (!negotiated) resolve(unavailable());
        for (const entry of state.pending.values()) entry.finish(resultUnknown());
      });
      attachUnixFrames(socket, (message) => {
        if (!negotiated) {
          clearTimeout(timer);
          if (message.type !== 'hello-result' || message.version !== UNIX_PROTOCOL_VERSION
            || !isResult(message.result)) {
            resolve(failure('PROTOCOL_MISMATCH', 'The app and MCP launcher use incompatible protocol versions.'));
            socket.destroy();
            return;
          }
          if (!message.result.ok) {
            resolve(message.result);
            socket.destroy();
            return;
          }
          if (message.result.data.mode !== mode) {
            resolve(failure('WRONG_MODE', 'This launcher points to a different desktop mode.'));
            socket.destroy();
            return;
          }
          negotiated = true;
          connection = state;
          resolve({ ok: true });
          return;
        }
        if (message.version !== UNIX_PROTOCOL_VERSION || message.type !== 'call-result'
          || !isResult(message.result)) {
          socket.destroy();
          return;
        }
        state.pending.get(message.id)?.finish(message.result);
      });
      writeUnixFrame(socket, { type: 'hello', mode });
    });
  }

  async function request(tool, args, signal) {
    if (closed) return unavailable();
    if (!connection || connection.socket.destroyed) {
      opening ??= open().finally(() => { opening = undefined; });
      const result = await opening;
      if (!result.ok) return result;
    }
    const state = connection;
    if (!state || state.socket.destroyed || closed) return unavailable();
    if (signal?.aborted) return failure('SESSION_ENDED', 'The client cancelled before dispatch.');
    if (state.pending.size >= MAX_REQUESTS + 1) {
      return failure('QUEUE_FULL', 'The canvas request queue is full.');
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const { socket, pending } = state;
      const abort = () => writeUnixFrame(socket, { type: 'cancel', id });
      // The broker may dispatch the full queue sequentially. A wedged peer
      // invalidates the connection so ambiguous calls are never sent again.
      const timer = setTimeout(() => socket.destroy(), RESULT_TIMEOUT_MS);
      const finish = (result) => {
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      pending.set(id, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      writeUnixFrame(socket, { type: 'call', id, tool, args });
    });
  }

  return {
    issuePairing: () => request('get_canvas_pairing', {}),
    request,
    close() {
      closed = true;
      connection?.socket.destroy();
    },
  };
}
