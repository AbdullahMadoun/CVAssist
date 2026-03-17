const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isPackagedCodePath, resolvePublicAsset, resolveTmpDir } = require('./runtime-paths');

const SWIFTLATEX_REMOTE_ORIGIN = 'https://texlive2.swiftlatex.com';
const SWIFTLATEX_CACHE_DIR = path.join(resolveTmpDir(), 'swiftlatex-cache');
const SWIFTLATEX_BUNDLE_DIR = resolvePublicAsset('vendor', 'swiftlatex-cache');
const SWIFTLATEX_ALLOWED_ENGINES = new Set(['pdftex', 'xetex']);

let texFileIndexPromise = null;

function ensureDir(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function commandExists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

function sanitizeSwiftLatexAssetPath(assetPath = '') {
  const normalized = String(assetPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized || normalized.includes('..')) return '';
  return normalized
    .split('/')
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, '_'))
    .filter(Boolean)
    .join('/');
}

function getSwiftLatexFormatAssetPath(engine) {
  return engine === 'xetex'
    ? '10/swiftlatexxetex.fmt'
    : '10/swiftlatexpdftex.fmt';
}

function getSwiftLatexAssetFsPath(rootDir, engine, assetPath) {
  const safeEngine = String(engine || '').trim().toLowerCase();
  const safeAssetPath = sanitizeSwiftLatexAssetPath(assetPath);
  if (!SWIFTLATEX_ALLOWED_ENGINES.has(safeEngine) || !safeAssetPath) return '';
  return path.join(rootDir, safeEngine, ...safeAssetPath.split('/'));
}

function createSwiftLatexFileId(engine, assetPath) {
  return crypto
    .createHash('sha1')
    .update(`${engine}:${assetPath}`)
    .digest('hex')
    .slice(0, 20);
}

function writeSwiftLatexAsset(engine, assetPath, buffer, options = {}) {
  const rootDir = options.rootDir || SWIFTLATEX_CACHE_DIR;
  const targetPath = getSwiftLatexAssetFsPath(rootDir, engine, assetPath);
  if (!targetPath) {
    throw new Error('Invalid SwiftLaTeX asset path');
  }
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

function readSwiftLatexAsset(engine, assetPath, rootDir) {
  const filePath = getSwiftLatexAssetFsPath(rootDir, engine, assetPath);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (!isUsableSwiftLatexAsset(engine, assetPath, buffer)) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
    return null;
  }
  return {
    filePath,
    buffer,
  };
}

function isUsableSwiftLatexAsset(engine, assetPath, buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const normalizedPath = sanitizeSwiftLatexAssetPath(assetPath);
  const isFormatAsset = normalizedPath && normalizedPath === getSwiftLatexFormatAssetPath(engine);
  if (isFormatAsset) {
    return buffer.length > 0;
  }
  return true;
}

function getSystemTeXRoots() {
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    process.env.CV_CUSTOMIZER_SYSTEM_TEX_ROOT || '',
    localAppData ? path.join(localAppData, 'Programs', 'MiKTeX') : '',
    'C:\\Program Files\\MiKTeX',
    'C:\\texlive\\2026',
    'C:\\texlive\\2025',
    'C:\\texlive\\2024',
    '/Library/TeX',
    '/usr/local/texlive',
    '/usr/share/texlive',
  ]
    .filter(Boolean)
    .filter((candidate) => commandExists(candidate));
}

function indexTeXTree(rootDir, index) {
  const stack = [rootDir];
  while (stack.length) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const key = String(entry.name || '').toLowerCase();
      if (key && !index.has(key)) {
        index.set(key, fullPath);
      }
    }
  }
}

async function getSystemTeXFileIndex() {
  if (texFileIndexPromise) return texFileIndexPromise;

  texFileIndexPromise = Promise.resolve().then(() => {
    const index = new Map();
    getSystemTeXRoots().forEach((rootDir) => {
      indexTeXTree(rootDir, index);
    });
    return index;
  });

  return texFileIndexPromise;
}

function buildAssetLookupCandidates(assetPath) {
  const normalized = sanitizeSwiftLatexAssetPath(assetPath);
  if (!normalized || normalized === getSwiftLatexFormatAssetPath('pdftex') || normalized === getSwiftLatexFormatAssetPath('xetex')) {
    return [];
  }

  const parts = normalized.split('/');
  const filename = parts[parts.length - 1] || '';
  const formatCode = parts[0] || '';
  if (!filename) return [];

  const candidates = [filename.toLowerCase()];
  if (filename === 'nul:' || filename === 'xetexfontlist.txt') {
    return candidates;
  }

  if (!filename.includes('.') && formatCode === '3') {
    candidates.unshift(`${filename.toLowerCase()}.tfm`);
  }

  if (!filename.includes('.') && formatCode === '26') {
    candidates.unshift(`${filename.toLowerCase()}.tex`);
    candidates.push(`${filename.toLowerCase()}.ini`);
  }

  return Array.from(new Set(candidates));
}

async function lookupSwiftLatexAssetFromSystem(assetPath) {
  const normalized = sanitizeSwiftLatexAssetPath(assetPath);
  const filename = path.posix.basename(normalized);
  if (filename === 'nul:' || filename === 'xetexfontlist.txt') {
    return {
      filePath: filename,
      buffer: Buffer.alloc(0),
    };
  }

  const fileIndex = await getSystemTeXFileIndex();
  for (const candidate of buildAssetLookupCandidates(assetPath)) {
    const resolved = fileIndex.get(candidate);
    if (!resolved || !fs.existsSync(resolved)) continue;
    return {
      filePath: resolved,
      buffer: fs.readFileSync(resolved),
    };
  }
  return null;
}

function allowSwiftLatexRemoteFetch() {
  if (process.env.CV_CUSTOMIZER_ALLOW_SWIFTLATEX_REMOTE != null) {
    return ['1', 'true', 'yes'].includes(String(process.env.CV_CUSTOMIZER_ALLOW_SWIFTLATEX_REMOTE).trim().toLowerCase());
  }
  return !isPackagedCodePath();
}

async function fetchSwiftLatexAsset(engine, assetPath) {
  const safeEngine = String(engine || '').trim().toLowerCase();
  const safeAssetPath = sanitizeSwiftLatexAssetPath(assetPath);
  if (!SWIFTLATEX_ALLOWED_ENGINES.has(safeEngine) || !safeAssetPath) {
    return {
      status: 400,
      buffer: Buffer.from('Invalid SwiftLaTeX asset path'),
      contentType: 'text/plain; charset=utf-8',
      fileId: '',
      pkId: '',
      fromCache: false,
      source: 'invalid',
    };
  }

  const cachedAsset = readSwiftLatexAsset(safeEngine, safeAssetPath, SWIFTLATEX_CACHE_DIR);
  if (cachedAsset) {
    return {
      status: 200,
      buffer: cachedAsset.buffer,
      contentType: 'application/octet-stream',
      fileId: createSwiftLatexFileId(safeEngine, safeAssetPath),
      pkId: '',
      fromCache: true,
      source: 'cache',
    };
  }

  const bundledAsset = readSwiftLatexAsset(safeEngine, safeAssetPath, SWIFTLATEX_BUNDLE_DIR);
  if (bundledAsset) {
    writeSwiftLatexAsset(safeEngine, safeAssetPath, bundledAsset.buffer);
    return {
      status: 200,
      buffer: bundledAsset.buffer,
      contentType: 'application/octet-stream',
      fileId: createSwiftLatexFileId(safeEngine, safeAssetPath),
      pkId: '',
      fromCache: false,
      source: 'bundle',
    };
  }

  const systemAsset = await lookupSwiftLatexAssetFromSystem(safeAssetPath);
  if (systemAsset) {
    writeSwiftLatexAsset(safeEngine, safeAssetPath, systemAsset.buffer);
    return {
      status: 200,
      buffer: systemAsset.buffer,
      contentType: 'application/octet-stream',
      fileId: createSwiftLatexFileId(safeEngine, safeAssetPath),
      pkId: '',
      fromCache: false,
      source: 'system',
    };
  }

  if (allowSwiftLatexRemoteFetch()) {
    try {
      const response = await fetch(`${SWIFTLATEX_REMOTE_ORIGIN}/${safeEngine}/${safeAssetPath}`, {
        redirect: 'follow',
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (response.ok) {
        writeSwiftLatexAsset(safeEngine, safeAssetPath, buffer);
      }
      return {
        status: response.status,
        buffer,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        fileId: response.headers.get('fileid') || createSwiftLatexFileId(safeEngine, safeAssetPath),
        pkId: response.headers.get('pkid') || '',
        fromCache: false,
        source: 'remote',
      };
    } catch {
      // Fall through to the explicit local-only error below.
    }
  }

  return {
    status: 404,
    buffer: Buffer.from(`SwiftLaTeX asset ${safeEngine}/${safeAssetPath} is unavailable locally.`),
    contentType: 'text/plain; charset=utf-8',
    fileId: '',
    pkId: '',
    fromCache: false,
    source: 'missing',
  };
}

module.exports = {
  SWIFTLATEX_CACHE_DIR,
  SWIFTLATEX_BUNDLE_DIR,
  SWIFTLATEX_REMOTE_ORIGIN,
  sanitizeSwiftLatexAssetPath,
  getSwiftLatexFormatAssetPath,
  writeSwiftLatexAsset,
  fetchSwiftLatexAsset,
};
