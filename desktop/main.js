const { app, BrowserWindow, dialog, shell } = require('electron');
const { startServer } = require('../server/server');
const { BRIDGE_STATUS_PATH, createPortCandidates } = require('../server/bridge');

let mainWindow = null;
let httpServer = null;
let serverPort = null;
let isQuitting = false;
const DESKTOP_PORT_CANDIDATES = createPortCandidates(process.env.PORT);

async function canUseExistingServer(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_STATUS_PATH}`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function bootServer() {
  if (httpServer || serverPort) return;

  for (const port of DESKTOP_PORT_CANDIDATES) {
    try {
      const started = await startServer(port);
      httpServer = started.server;
      serverPort = started.port;
      return;
    } catch (error) {
      if (error?.code === 'EADDRINUSE' && await canUseExistingServer(port)) {
        serverPort = port;
        return;
      }
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw new Error(`Could not start or connect to a local CV Customizer server on ports ${DESKTOP_PORT_CANDIDATES.join(', ')}.`);
}

async function closeServer() {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise((resolve) => server.close(() => resolve()));
}

function createWindow() {
  if (!serverPort) {
    throw new Error('Desktop shell tried to create a window before the local server was ready.');
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b0d14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function bootDesktop() {
  await bootServer();
  createWindow();
}

app.whenReady()
  .then(bootDesktop)
  .catch((error) => {
    dialog.showErrorBox('CV Customizer failed to start', String(error?.stack || error));
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', async () => {
  await closeServer();
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit();
  }
});
