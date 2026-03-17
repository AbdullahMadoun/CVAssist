const APP_ID = 'cv-customizer';
const APP_NAME = 'CV Customizer';
const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_STATUS_PATH = '/api/bridge/status';
const LEGACY_HEALTH_PATH = '/api/health';
const JOB_IMPORT_PATH = '/api/jobs/import';
const JOB_IMPORT_BATCH_PATH = '/api/jobs/import-batch';
const LOCAL_ORIGIN_CANDIDATES = [
  'http://127.0.0.1:3210',
  'http://localhost:3210',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];

function createPortCandidates(envPort) {
  return Array.from(new Set(
    [envPort, 3210, 3001, 3000]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));
}

function getRuntimeName() {
  return process.versions && process.versions.electron ? 'desktop' : 'server';
}

function getOriginFromRequest(req) {
  if (!req || typeof req.get !== 'function') return '';
  const host = req.get('host') || '';
  if (!host) return '';
  const forwardedProto = (req.headers && req.headers['x-forwarded-proto']) || '';
  const protocol = forwardedProto || req.protocol || 'http';
  return String(protocol).replace(/:$/, '') + '://' + host;
}

function buildBridgeStatus(req, extras = {}) {
  return {
    status: 'ok',
    app: APP_ID,
    name: APP_NAME,
    runtime: getRuntimeName(),
    origin: getOriginFromRequest(req),
    bridge: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      transport: 'local_http',
      statusPath: BRIDGE_STATUS_PATH,
      legacyStatusPath: LEGACY_HEALTH_PATH,
      importJobPath: JOB_IMPORT_PATH,
      importBatchPath: JOB_IMPORT_BATCH_PATH,
    },
    capabilities: {
      jobImport: true,
      jobImportBatch: true,
      atsAnalyze: true,
      compile: true,
      compileWasmPreview: true,
    },
    ...extras,
    timestamp: new Date().toISOString(),
  };
}

function isValidBridgeStatus(payload) {
  return Boolean(
    payload &&
    payload.status === 'ok' &&
    payload.app === APP_ID &&
    payload.bridge &&
    Number(payload.bridge.protocolVersion) >= BRIDGE_PROTOCOL_VERSION
  );
}

module.exports = {
  APP_ID,
  APP_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_STATUS_PATH,
  LEGACY_HEALTH_PATH,
  JOB_IMPORT_PATH,
  JOB_IMPORT_BATCH_PATH,
  LOCAL_ORIGIN_CANDIDATES,
  createPortCandidates,
  getRuntimeName,
  getOriginFromRequest,
  buildBridgeStatus,
  isValidBridgeStatus,
};
