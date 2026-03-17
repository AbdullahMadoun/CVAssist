const path = require('path');
const os = require('os');

function getElectronApp() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app : null;
  } catch {
    return null;
  }
}

function isPackagedCodePath() {
  if (__dirname.includes('app.asar')) return true;
  const app = getElectronApp();
  return Boolean(app && app.isPackaged);
}

function resolveDataDir() {
  if (process.env.CV_CUSTOMIZER_DATA_DIR) {
    return path.resolve(process.env.CV_CUSTOMIZER_DATA_DIR);
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }
  const app = getElectronApp();
  if (app) {
    return path.join(app.getPath('userData'), 'data');
  }
  if (process.resourcesPath && isPackagedCodePath()) {
    return path.join(process.resourcesPath, '..', 'data');
  }
  return path.join(__dirname, '..', 'data');
}

function resolveTmpDir() {
  if (process.env.CV_CUSTOMIZER_TMP_DIR) {
    return path.resolve(process.env.CV_CUSTOMIZER_TMP_DIR);
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'tmp');
  }
  const app = getElectronApp();
  if (app) {
    return path.join(app.getPath('temp'), 'cv-customizer');
  }
  if (isPackagedCodePath()) {
    return path.join(os.tmpdir(), 'cv-customizer');
  }
  return path.join(__dirname, '..', 'tmp');
}

function resolvePublicDir() {
  return path.join(__dirname, '..', 'public');
}

function resolvePublicAsset(...segments) {
  return path.join(resolvePublicDir(), ...segments);
}

function resolveServerAsset(...segments) {
  return path.join(__dirname, ...segments);
}

module.exports = {
  isPackagedCodePath,
  resolveDataDir,
  resolveTmpDir,
  resolvePublicDir,
  resolvePublicAsset,
  resolveServerAsset,
};
