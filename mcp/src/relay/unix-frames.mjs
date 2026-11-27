import { isObject } from '../shared/result.mjs';
import { MAX_FRAME_BYTES } from './canvas-session.mjs';

export const UNIX_PROTOCOL_VERSION = 1;
const decoder = new TextDecoder('utf-8', { fatal: true });

// TCP-like stream reads can split a UTF-8 sequence or contain multiple frames.
// The frame cap applies before UTF-8 decoding or allocating a contiguous copy.
export function attachUnixFrames(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  let size = 0;
  socket.on('error', () => socket.destroy());
  socket.on('data', (data) => {
    let start = 0;
    while (start < data.length && !socket.destroyed) {
      const separator = data.indexOf(0x0a, start);
      const end = separator < 0 ? data.length : separator;
      const nextSize = size + end - start;
      if (nextSize > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      if (separator < 0) {
        if (buffer.length < nextSize) {
          const grown = Buffer.allocUnsafe(Math.max(nextSize, Math.min(buffer.length * 2, MAX_FRAME_BYTES)));
          buffer.copy(grown, 0, 0, size);
          buffer = grown;
        }
        data.copy(buffer, size, start, end);
        size = nextSize;
        return;
      }

      let message;
      try {
        const tail = data.subarray(start, end);
        const frame = size ? Buffer.concat([buffer.subarray(0, size), tail], nextSize) : tail;
        message = JSON.parse(decoder.decode(frame));
      } catch {
        socket.destroy();
        return;
      }
      if (!isObject(message)) {
        socket.destroy();
        return;
      }
      size = 0;
      onMessage(message);
      start = separator + 1;
    }
  });
}

export function writeUnixFrame(socket, message) {
  const payload = JSON.stringify({ version: UNIX_PROTOCOL_VERSION, ...message });
  const bytes = Buffer.byteLength(payload);
  if (socket.destroyed || bytes > MAX_FRAME_BYTES || socket.writableLength + bytes + 1 > MAX_FRAME_BYTES * 2) {
    socket.destroy();
    return false;
  }
  // A false return from socket.write means backpressure. The write is already queued.
  socket.write(`${payload}\n`);
  return true;
}
