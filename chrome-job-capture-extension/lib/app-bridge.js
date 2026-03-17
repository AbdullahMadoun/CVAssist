(function initAppBridge(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.CVCustomizerAppBridge = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  var APP_ID = 'cv-customizer';
  var APP_NAME = 'CV Customizer';
  var BRIDGE_PROTOCOL_VERSION = 1;
  var APP_ORIGIN_CANDIDATES = [
    'http://127.0.0.1:3210',
    'http://localhost:3210',
    'http://127.0.0.1:3001',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://localhost:3000'
  ];
  var STATUS_PATH_CANDIDATES = [
    '/api/bridge/status',
    '/api/health'
  ];
  var JOB_IMPORT_PATH = '/api/jobs/import';
  var JOB_IMPORT_BATCH_PATH = '/api/jobs/import-batch';
  var PREFERRED_ORIGIN_KEY = 'cvCustomizerPreferredOrigin';
  var TARGET_MODE_KEY = 'cvCustomizerBridgeTargetMode';
  var TARGET_MODE_AUTO = 'auto';
  var TARGET_MODE_DESKTOP = 'desktop';
  var TARGET_MODE_DEV = 'dev';
  var TARGET_MODE_LABELS = {
    auto: 'Auto (Prefer Desktop)',
    desktop: 'Desktop (3210)',
    dev: 'Dev (3001)'
  };
  var TARGET_MODE_ORIGINS = {
    desktop: ['http://127.0.0.1:3210', 'http://localhost:3210'],
    dev: ['http://127.0.0.1:3001', 'http://localhost:3001']
  };
  var cachedOrigin = '';
  var cachedStatusPath = '';

  function canUseStorage() {
    try {
      return typeof localStorage !== 'undefined';
    } catch (error) {
      return false;
    }
  }

  function readPreferredOrigin() {
    if (!canUseStorage()) return '';
    try {
      return localStorage.getItem(PREFERRED_ORIGIN_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function writePreferredOrigin(origin) {
    if (!canUseStorage() || !origin) return;
    try {
      localStorage.setItem(PREFERRED_ORIGIN_KEY, origin);
    } catch (error) {}
  }

  function normalizeTargetMode(mode) {
    var value = String(mode || '').trim().toLowerCase();
    if (value === TARGET_MODE_DESKTOP || value === TARGET_MODE_DEV) return value;
    return TARGET_MODE_AUTO;
  }

  function readTargetMode() {
    if (!canUseStorage()) return TARGET_MODE_AUTO;
    try {
      return normalizeTargetMode(localStorage.getItem(TARGET_MODE_KEY));
    } catch (error) {
      return TARGET_MODE_AUTO;
    }
  }

  function writeTargetMode(mode) {
    var normalized = normalizeTargetMode(mode);
    if (!canUseStorage()) return normalized;
    try {
      localStorage.setItem(TARGET_MODE_KEY, normalized);
    } catch (error) {}
    return normalized;
  }

  function allowedOriginsForTargetMode(mode) {
    var normalized = normalizeTargetMode(mode);
    if (normalized === TARGET_MODE_DESKTOP || normalized === TARGET_MODE_DEV) {
      return TARGET_MODE_ORIGINS[normalized].slice();
    }
    return APP_ORIGIN_CANDIDATES.slice();
  }

  function orderedOrigins() {
    var targetMode = readTargetMode();
    var allowedOrigins = allowedOriginsForTargetMode(targetMode);
    var preferredOrigin = readPreferredOrigin();
    if (!preferredOrigin || allowedOrigins.indexOf(preferredOrigin) === -1) return allowedOrigins.slice();
    return [preferredOrigin].concat(allowedOrigins.filter(function keepOrigin(origin) {
      return origin !== preferredOrigin;
    }));
  }

  function originPort(origin) {
    var match = String(origin || '').match(/:(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : 0;
  }

  function scoreDiscoveredApp(candidate, preferredOrigin) {
    var score = 0;
    var runtime = candidate && candidate.health && candidate.health.runtime
      ? String(candidate.health.runtime).toLowerCase()
      : '';

    if (runtime === 'desktop') score += 100;
    if (candidate && candidate.origin === preferredOrigin) score += 20;
    if (originPort(candidate && candidate.origin) === 3210) score += 10;
    if (candidate && /^http:\/\/127\.0\.0\.1:/i.test(candidate.origin || '')) score += 1;

    return score;
  }

  function pickBestApp(candidates, preferredOrigin) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    return candidates.reduce(function chooseBest(best, candidate) {
      if (!best) return candidate;
      return scoreDiscoveredApp(candidate, preferredOrigin) > scoreDiscoveredApp(best, preferredOrigin)
        ? candidate
        : best;
    }, null);
  }

  function offlineMessageForTargetMode(mode) {
    var normalized = normalizeTargetMode(mode);
    if (normalized === TARGET_MODE_DESKTOP) {
      return 'CV Customizer desktop app was not detected on localhost port 3210. Start the desktop app and try again.';
    }
    if (normalized === TARGET_MODE_DEV) {
      return 'CV Customizer dev server was not detected on localhost port 3001. Start npm run dev and try again.';
    }
    return 'CV Customizer was not detected on localhost. Start the desktop app first, or a local dev server if you are developing.';
  }

  function buildLegacyStatus(origin, statusPath, payload) {
    return {
      status: 'ok',
      app: APP_ID,
      name: APP_NAME,
      runtime: payload && payload.runtime ? payload.runtime : 'legacy',
      origin: origin || '',
      bridge: {
        protocolVersion: 0,
        transport: 'local_http',
        statusPath: statusPath,
        legacyStatusPath: statusPath,
        importJobPath: JOB_IMPORT_PATH,
        importBatchPath: JOB_IMPORT_BATCH_PATH
      },
      capabilities: {
        jobImport: true,
        jobImportBatch: true
      },
      apiKeyConfigured: Boolean(payload && payload.apiKeyConfigured),
      defaultProvider: payload && payload.defaultProvider ? payload.defaultProvider : null,
      timestamp: payload && payload.timestamp ? payload.timestamp : ''
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

  function normalizeStatusPayload(payload, origin, statusPath) {
    if (isValidBridgeStatus(payload)) {
      if (!payload.origin) payload.origin = origin;
      if (!payload.bridge.statusPath) payload.bridge.statusPath = statusPath;
      return payload;
    }

    if (statusPath === '/api/health' && payload && payload.status === 'ok') {
      return buildLegacyStatus(origin, statusPath, payload);
    }

    throw new Error('Bridge status response is invalid.');
  }

  async function requestJson(fetchImpl, url, options) {
    var response = await fetchImpl(url, options);
    var payload = await response.json().catch(function onError() {
      return {};
    });

    if (!response.ok) {
      var error = new Error(payload.error || response.statusText || 'Request failed.');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function requestStatus(fetchImpl, origin) {
    for (var pathIndex = 0; pathIndex < STATUS_PATH_CANDIDATES.length; pathIndex += 1) {
      var statusPath = STATUS_PATH_CANDIDATES[pathIndex];
      try {
        var status = await requestJson(fetchImpl, origin + statusPath);
        var normalized = normalizeStatusPayload(status, origin, statusPath);
        cachedStatusPath = statusPath;
        return normalized;
      } catch (error) {}
    }

    throw new Error('App status endpoint unavailable.');
  }

  async function discoverApp(fetchImpl) {
    var fetcher = fetchImpl || fetch;
    var candidates = [];
    var preferredOrigin = readPreferredOrigin();
    var targetMode = readTargetMode();
    var allowedOrigins = allowedOriginsForTargetMode(targetMode);

    if (cachedOrigin && allowedOrigins.indexOf(cachedOrigin) !== -1) {
      try {
        var cachedHealth = await requestStatus(fetcher, cachedOrigin);
        var cachedCandidate = { connected: true, origin: cachedOrigin, health: cachedHealth, statusPath: cachedStatusPath };
        if (String(cachedHealth && cachedHealth.runtime || '').toLowerCase() === 'desktop') {
          writePreferredOrigin(cachedOrigin);
          return cachedCandidate;
        }
        candidates.push(cachedCandidate);
      } catch (error) {
        cachedOrigin = '';
        cachedStatusPath = '';
      }
    } else if (cachedOrigin) {
      cachedOrigin = '';
      cachedStatusPath = '';
    }

    var origins = allowedOrigins;
    for (var index = 0; index < origins.length; index += 1) {
      var origin = origins[index];
      if (!origin || origin === cachedOrigin) continue;
      try {
        var health = await requestStatus(fetcher, origin);
        candidates.push({ connected: true, origin: origin, health: health, statusPath: cachedStatusPath });
      } catch (error) {}
    }

    var bestCandidate = pickBestApp(candidates, preferredOrigin || cachedOrigin);
    if (bestCandidate) {
      cachedOrigin = bestCandidate.origin;
      cachedStatusPath = bestCandidate.statusPath || cachedStatusPath;
      writePreferredOrigin(bestCandidate.origin);
      return bestCandidate;
    }

    return {
      connected: false,
      origin: '',
      health: null,
      statusPath: '',
      message: offlineMessageForTargetMode(targetMode)
    };
  }

  function mapImportError(error) {
    if (!error) return new Error('Could not reach CV Customizer.');
    if (/Failed to fetch/i.test(String(error.message || error))) {
      return new Error('Could not reach CV Customizer. Start the app and try again.');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  function shouldRetryImport(error) {
    if (!error) return false;
    if (/Failed to fetch/i.test(String(error.message || error))) return true;
    return Number(error.status || 0) === 404 || Number(error.status || 0) === 405;
  }

  async function withImportRetry(runRequest, fetchImpl) {
    var fetcher = fetchImpl || fetch;
    var app = await discoverApp(fetcher);
    if (!app.connected) throw new Error(app.message);

    try {
      return await runRequest(app, fetcher);
    } catch (error) {
      if (!shouldRetryImport(error)) {
        throw mapImportError(error);
      }

      resetCache();
      var retriedApp = await discoverApp(fetcher);
      if (!retriedApp.connected || retriedApp.origin === app.origin) {
        throw mapImportError(error);
      }
      return runRequest(retriedApp, fetcher).catch(function onRetryError(retryError) {
        throw mapImportError(retryError);
      });
    }
  }

  async function importJob(job, fetchImpl) {
    return withImportRetry(function runRequest(app, fetcher) {
      return requestJson(fetcher, app.origin + JOB_IMPORT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job || {})
      });
    }, fetchImpl);
  }

  async function importJobs(jobs, fetchImpl) {
    return withImportRetry(function runRequest(app, fetcher) {
      return requestJson(fetcher, app.origin + JOB_IMPORT_BATCH_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs: Array.isArray(jobs) ? jobs : [] })
      });
    }, fetchImpl);
  }

  async function openApp(createTab, fetchImpl) {
    var app = await discoverApp(fetchImpl);
    var url = app.connected ? app.origin : orderedOrigins()[0];
    return createTab({ url: url });
  }

  function resetCache() {
    cachedOrigin = '';
    cachedStatusPath = '';
  }

  return {
    APP_ID: APP_ID,
    APP_NAME: APP_NAME,
    BRIDGE_PROTOCOL_VERSION: BRIDGE_PROTOCOL_VERSION,
    TARGET_MODES: {
      auto: TARGET_MODE_AUTO,
      desktop: TARGET_MODE_DESKTOP,
      dev: TARGET_MODE_DEV
    },
    TARGET_MODE_LABELS: Object.assign({}, TARGET_MODE_LABELS),
    APP_ORIGIN_CANDIDATES: APP_ORIGIN_CANDIDATES.slice(),
    STATUS_PATH_CANDIDATES: STATUS_PATH_CANDIDATES.slice(),
    discoverApp: discoverApp,
    importJob: importJob,
    importJobs: importJobs,
    openApp: openApp,
    getTargetMode: readTargetMode,
    setTargetMode: writeTargetMode,
    resetCache: resetCache
  };
}));

