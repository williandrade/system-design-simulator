import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

const SOCK_NAME = /^g-[a-f0-9]{24}\.sock$/;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const DISCOVERY_TIMEOUT = 1000;

function unsafe(message) {
  return Object.assign(new Error(message), { code: 'UNSAFE_CONFIGURATION' });
}

function locations(mode, namespace) {
  const prefixes = new Map([['desktop', 'p'], ['desktop-dev', 'd']]);
  const prefix = prefixes.get(mode);
  if (!prefix || (namespace !== undefined && (typeof namespace !== 'string' || !NAMESPACE.test(namespace)))) {
    throw unsafe('The desktop MCP mode or namespace is invalid.');
  }
  const base = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
  const root = join(base, `woi-${process.getuid()}`);
  const directory = join(root, `${prefix}-${namespace ?? '_'}`);
  if (Buffer.byteLength(join(directory, `g-${'0'.repeat(24)}.sock`)) >= 103) {
    throw unsafe('The desktop MCP socket path is too long.');
  }
  return { root, directory, descriptor: join(directory, 'endpoint.json') };
}

function verify(stat, predicate, mode) {
  if (!predicate(stat) || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== mode) {
    throw unsafe('The desktop MCP endpoint has unsafe ownership, type or permissions.');
  }
  return stat;
}

function sameEntry(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

async function checkDirectories({ root, directory }, create = false) {
  for (const dir of [root, directory]) {
    if (create) {
      await mkdir(dir, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    verify(await lstat(dir), (entry) => entry.isDirectory(), 0o700);
  }
}

async function readDescriptor({ directory, descriptor }) {
  const stat = verify(await lstat(descriptor), (entry) => entry.isFile(), 0o600);
  if (stat.size > 128) throw unsafe('The desktop MCP descriptor is too large.');
  const file = await open(descriptor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = verify(await file.stat(), (entry) => entry.isFile(), 0o600);
    if (!sameEntry(stat, opened)) throw unsafe('The desktop MCP descriptor changed during discovery.');
    const source = Buffer.alloc(129);
    const { bytesRead } = await file.read(source, 0, source.length, 0);
    const descriptorText = source.subarray(0, bytesRead).toString('utf8');
    let name;
    try {
      name = JSON.parse(descriptorText);
    } catch {
      throw unsafe('The desktop MCP descriptor is invalid.');
    }
    if (typeof name !== 'string' || !SOCK_NAME.test(name)) {
      throw unsafe('The desktop MCP descriptor contains an invalid socket name.');
    }
    return { socketPath: join(directory, name), descriptorStat: opened };
  } finally {
    await file.close();
  }
}

async function socketStat(socketPath) {
  return verify(await lstat(socketPath), (entry) => entry.isSocket(), 0o600);
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    // The consumer takes over after connect. Keep a listener for errors during that handoff.
    socket.on('error', reject);
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error('Desktop MCP connection timed out.'), { code: 'ETIMEDOUT' }));
    }, DISCOVERY_TIMEOUT);
    socket.once('error', () => clearTimeout(timer));
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

export async function connectUnixEndpoint(mode, namespace) {
  const paths = locations(mode, namespace);
  await checkDirectories(paths);
  const { socketPath } = await readDescriptor(paths);
  await socketStat(socketPath);
  return connect(socketPath);
}

async function recover(paths) {
  let previous;
  try {
    previous = await readDescriptor(paths);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const { socketPath, descriptorStat } = previous;
  const stat = await socketStat(socketPath).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat) {
    try {
      const live = await connect(socketPath);
      live.destroy();
      throw unsafe('Another desktop process already owns this MCP endpoint.');
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') throw error;
    }
    if (!sameEntry(stat, await socketStat(socketPath))) {
      throw unsafe('The desktop MCP socket changed during crash recovery.');
    }
    if (!sameEntry(descriptorStat, (await readDescriptor(paths)).descriptorStat)) {
      throw unsafe('The desktop MCP descriptor changed during crash recovery.');
    }
    await unlink(socketPath);
  }
}

export async function listenUnixEndpoint({ mode, namespace, accept }) {
  const paths = locations(mode, namespace);
  await checkDirectories(paths, true);
  await recover(paths);

  const token = randomBytes(12).toString('hex');
  const socketName = `g-${token}.sock`;
  const socketPath = join(paths.directory, socketName);
  const publishing = join(paths.directory, `publish-${token}.json`);
  const server = createServer(accept);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await socketStat(socketPath);
    await writeFile(publishing, JSON.stringify(socketName), { flag: 'wx', mode: 0o600 });
    await rename(publishing, paths.descriptor);
  } catch (error) {
    if (server.listening) server.close();
    await unlink(publishing).catch(() => {});
    throw error;
  }

  return {
    async close() {
      if (!server.listening) return;
      try {
        const current = await readDescriptor(paths).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (current?.socketPath === socketPath) await unlink(paths.descriptor);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
