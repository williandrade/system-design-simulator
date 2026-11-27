const { accessSync, constants, statSync } = require('node:fs');

const SERVER_IDS = new Map([
  ['desktop', 'willis-overengineer-inator'],
  ['desktop-dev', 'willis-overengineer-inator-dev'],
]);

function getSetup({ launcherPath, launcherArgs, mode, namespace }) {
  const serverId = SERVER_IDS.get(mode);
  if (!serverId) return null;
  const args = namespace ? [...launcherArgs, '--namespace', namespace] : [...launcherArgs];
  const argv = [launcherPath, ...args];
  if (argv.some((value) => typeof value !== 'string' || /\p{Cc}/u.test(value))) return null;
  try {
    if (!statSync(launcherPath).isFile()) return null;
    accessSync(launcherPath, constants.X_OK);
  } catch {
    return null;
  }

  // Keep each argument literal, including spaces, apostrophes and shell expansions in paths.
  const launchCommand = argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  return {
    mode,
    serverId,
    launcherPath,
    launcherArgs: args,
    commands: {
      codex: `codex mcp add ${serverId} -- ${launchCommand}`,
      claude: `claude mcp add --transport stdio --scope user ${serverId} -- ${launchCommand}`,
    },
  };
}

function registerMcpSetup({
  ipcMain, clipboard, getWindow, origin, launcherPath, launcherArgs = [],
  mode = 'desktop', namespace, isCurrent = () => true,
}) {
  const expected = URL.parse(origin);
  const launcher = { launcherPath, launcherArgs, mode, namespace };
  function isAllowed({ sender, senderFrame }) {
    if (!senderFrame || sender !== getWindow()?.webContents ||
      senderFrame !== sender.mainFrame || senderFrame.origin !== origin) return false;
    const url = URL.parse(senderFrame.url);
    return url && expected && url.protocol === expected.protocol && url.host === expected.host &&
      !url.username && !url.password && (url.pathname === '/' || url.pathname === '/playground') &&
      isCurrent();
  }

  ipcMain.handle('mcp-setup:get', (event) => isAllowed(event) ? getSetup(launcher) : null);

  ipcMain.handle('mcp-setup:copy', (event, client) => {
    if (!isAllowed(event) || (client !== 'codex' && client !== 'claude')) return false;
    const setup = getSetup(launcher);
    if (!setup) return false;

    try {
      clipboard.writeText(setup.commands[client]);
      return true;
    } catch {
      return false;
    }
  });
}

module.exports = { registerMcpSetup };
