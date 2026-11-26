const { accessSync, constants, statSync } = require('node:fs');

const COMMANDS = {
  codex: 'codex mcp add willis-overengineer-inator -- ',
  claude: 'claude mcp add --transport stdio --scope user willis-overengineer-inator -- ',
};

function getSetup(launcherPath) {
  if (/\p{Cc}/u.test(launcherPath)) return null;
  try {
    if (!statSync(launcherPath).isFile()) return null;
    accessSync(launcherPath, constants.X_OK);
  } catch {
    return null;
  }

  // Keep every character in the path literal, including apostrophes and shell expansions.
  const quotedPath = `'${launcherPath.replaceAll("'", "'\\''")}'`;
  return {
    launcherPath,
    commands: {
      codex: COMMANDS.codex + quotedPath,
      claude: COMMANDS.claude + quotedPath,
    },
  };
}

function registerMcpSetup({ ipcMain, clipboard, getWindow, origin, launcherPath }) {
  function isAllowed({ sender, senderFrame }) {
    if (!senderFrame || sender !== getWindow()?.webContents ||
      senderFrame !== sender.mainFrame || senderFrame.origin !== origin) return false;
    const pathname = URL.parse(senderFrame.url)?.pathname;
    return pathname === '/' || pathname === '/playground';
  }

  ipcMain.handle('mcp-setup:get', (event) => isAllowed(event) ? getSetup(launcherPath) : null);

  ipcMain.handle('mcp-setup:copy', (event, client) => {
    if (!isAllowed(event) || (client !== 'codex' && client !== 'claude')) return false;
    const setup = getSetup(launcherPath);
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
