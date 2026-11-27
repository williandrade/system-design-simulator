import { randomUUID } from 'node:crypto';
import { failure, success } from '../shared/result.mjs';
import { canvasTools } from '../tools/canvas-tools.mjs';
import { isResult } from './protocol.mjs';

export const REQUEST_TIMEOUT_MS = 5000;
export const MAX_REQUESTS = 32;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_TIMEOUT_MS = 3000;

export function resultUnknown() {
  return failure('RESULT_UNKNOWN', 'The canvas did not confirm the dispatched request. Reconnect and read the canvas before retrying.');
}

// A renderer owns one queue from pairing through disconnect. Transports supply the
// send and close operations but share the canvas state gate and ACK handling.
export function createCanvasSession({ canvasId, send, onEnd, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  const queue = [];
  let inFlight;
  let ready = false;
  let ended = false;

  function finish(entry, result) {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(result);
  }

  function end(inFlightResult = resultUnknown()) {
    if (ended) return;
    ended = true;
    if (inFlight) finish(inFlight, inFlightResult);
    inFlight = undefined;
    for (const entry of queue.splice(0)) {
      finish(entry, failure('SESSION_ENDED', 'The canvas disconnected before the request was dispatched.'));
    }
    onEnd();
  }

  function dispatchNext() {
    if (ended || inFlight) return;
    while (queue.length) {
      const entry = queue.shift();
      if (!ready && canvasTools.get(entry.tool).mutates) {
        finish(entry, failure('CANVAS_STATE_REQUIRED', 'Read the canvas with get_canvas_state before editing.'));
        continue;
      }
      inFlight = entry;
      entry.timer = setTimeout(end, requestTimeoutMs);
      send({
        type: 'request', requestId: entry.id, canvasId, tool: entry.tool, args: entry.args,
      }, end);
      return;
    }
  }

  function request(tool, args, signal) {
    if (ended) return Promise.resolve(failure('NOT_CONNECTED', 'Pair the canvas before using this tool.'));
    if (signal?.aborted) return Promise.resolve(failure('SESSION_ENDED', 'The client cancelled before dispatch.'));
    if (queue.length + Number(Boolean(inFlight)) >= MAX_REQUESTS) {
      return Promise.resolve(failure('QUEUE_FULL', 'The canvas request queue is full.'));
    }

    return new Promise((resolve) => {
      const entry = { id: randomUUID(), tool, args, signal, resolve };
      entry.abort = () => {
        if (inFlight === entry) {
          end();
          return;
        }
        const index = queue.indexOf(entry);
        if (index !== -1) {
          queue.splice(index, 1);
          finish(entry, failure('SESSION_ENDED', 'The client cancelled before dispatch.'));
        }
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      queue.push(entry);
      dispatchNext();
    });
  }

  function receive(message) {
    if (ended) return;
    if (!message || message.type !== 'result' || message.canvasId !== canvasId || !isResult(message)) {
      end();
      return;
    }
    const entry = inFlight;
    if (!entry || entry.id !== message.requestId) return;
    if (message.ok && (!canvasTools.get(entry.tool).output.safeParse(message.data).success
      || (entry.tool === 'get_canvas_state' && message.data.canvasId !== canvasId))) {
      end();
      return;
    }
    if (!message.ok && message.error.code === 'RESULT_UNKNOWN') {
      end({ ok: false, error: message.error });
      return;
    }
    if (entry.tool === 'get_canvas_state' && message.ok) ready = true;
    inFlight = undefined;
    finish(entry, message.ok ? success(message.data) : { ok: false, error: message.error });
    dispatchNext();
  }

  return { receive, request, end };
}
