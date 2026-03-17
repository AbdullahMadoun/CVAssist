const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const {
  fetchSwiftLatexAsset,
  writeSwiftLatexAsset,
  SWIFTLATEX_BUNDLE_DIR,
} = require('../server/swiftlatex-assets');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let staticServer = null;

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.css': return 'text/css; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function startStaticServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (pathname.startsWith('/swiftlatex-assets/')) {
        const segments = pathname.replace(/^\/swiftlatex-assets\//, '').split('/');
        const engine = String(segments.shift() || '').trim().toLowerCase();
        const assetPath = segments.join('/');

        if (req.method === 'POST' && /^\/swiftlatex-assets\/[^/]+\/prime-format$/i.test(pathname)) {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const buffer = Buffer.from(String(payload.data_base64 || ''), 'base64');
              // Write to runtime cache (Electron temp)
              const cachePath = writeSwiftLatexAsset(engine, payload.asset_path || '', buffer);
              // Also write to the vendor bundle dir so it ships in the packaged EXE
              let bundlePath = null;
              try {
                bundlePath = writeSwiftLatexAsset(engine, payload.asset_path || '', buffer, { rootDir: SWIFTLATEX_BUNDLE_DIR });
                console.log('[smoke] bundled fmt:', bundlePath, buffer.length, 'bytes');
              } catch (bundleErr) {
                console.warn('[smoke] could not write to bundle dir:', bundleErr.message);
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({
                cached: true,
                asset_path: payload.asset_path || '',
                bytes: buffer.length,
                cache_path: cachePath,
                bundle_path: bundlePath,
              }));
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: error.message || 'Invalid format payload' }));
            }
          });
          return;
        }

        if (!assetPath || assetPath.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad request');
          return;
        }

        try {
          const response = await fetchSwiftLatexAsset(engine, assetPath);
          const headers = {};
          const { status, buffer, contentType, fileId, pkId, fromCache } = response;
          if (contentType) headers['Content-Type'] = contentType;
          if (fileId) headers.fileid = fileId;
          if (pkId) headers.pkid = pkId;
          if (status === 200) {
            headers['Cache-Control'] = fromCache ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';
          }
          res.writeHead(status, headers);
          res.end(buffer);
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(error.message || 'Proxy request failed');
        }
        return;
      }

      const requested = pathname === '/' ? '/swiftlatex-smoke.html' : pathname;
      const filePath = path.join(PUBLIC_DIR, requested.replace(/^\/+/, ''));

      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(error.code === 'ENOENT' ? 404 : 500);
          res.end(error.code === 'ENOENT' ? 'Not found' : error.message);
          return;
        }
        res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
        res.end(data);
      });
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function waitForSmokeResult(win, timeoutMs = 360000) {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await win.webContents.executeJavaScript(`(() => ({
      status: document.getElementById('status')?.textContent || '',
      log: document.getElementById('log')?.textContent || ''
    }))()`, true);

    if (state.status === 'PASS' || state.status === 'FAIL') {
      return state;
    }

    const now = Date.now();
    if (now - lastLoggedAt >= 10000) {
      const elapsed = ((now - startedAt) / 1000).toFixed(0);
      const lastLine = state.log ? state.log.trim().split('\n').pop() : '';
      console.log(`[smoke +${elapsed}s] status=${state.status || 'pending'} | ${lastLine}`);
      lastLoggedAt = now;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error('Timed out waiting for SwiftLaTeX smoke result (180s)');
}

async function cleanup(exitCode = 0) {
  if (staticServer) {
    await new Promise((resolve) => staticServer.close(resolve));
  }
  app.exit(exitCode);
}

async function main() {
  const electronTempPath = app.getPath('temp');
  console.log('[smoke] Electron temp path:', electronTempPath);
  const swiftlatexCacheDir = require('path').join(electronTempPath, 'cv-customizer', 'swiftlatex-cache');
  console.log('[smoke] Expected SwiftLaTeX cache dir:', swiftlatexCacheDir);

  staticServer = await startStaticServer(0);
  const address = staticServer.address();
  const url = `http://127.0.0.1:${address.port}/swiftlatex-smoke.html`;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const source = sourceId ? ` ${sourceId}:${line}` : '';
    console.log(`[browser:${level}]${source} ${message}`);
  });

  await win.loadURL(url);
  const result = await waitForSmokeResult(win);
  console.log(JSON.stringify(result, null, 2));
  win.destroy();

  if (result.status !== 'PASS') {
    throw new Error(result.log || 'SwiftLaTeX browser smoke failed');
  }

  // Copy the warmed runtime cache to the vendor bundle dir so the EXE ships with pre-baked formats
  const { SWIFTLATEX_CACHE_DIR, SWIFTLATEX_BUNDLE_DIR: bundleDir } = require('../server/swiftlatex-assets');
  function copyDirSync(src, dst) {
    if (!fs.existsSync(src)) {
      console.log('[smoke] runtime cache not found at', src, '— skipping bundle copy');
      return 0;
    }
    fs.mkdirSync(dst, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        count += copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
        count += 1;
      }
    }
    return count;
  }
  console.log('[smoke] copying runtime cache →', bundleDir);
  const copied = copyDirSync(SWIFTLATEX_CACHE_DIR, bundleDir);
  console.log(`[smoke] bundled ${copied} files into`, bundleDir);
}


app.disableHardwareAcceleration();
app.whenReady()
  .then(main)
  .then(() => cleanup(0))
  .catch(async (error) => {
    console.error(error.stack || error.message || String(error));
    await cleanup(1);
  });
