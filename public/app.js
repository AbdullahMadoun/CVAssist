// ???????????????????????????????????????????????????????????????????????
// CV Customizer ? Main Application (Dual-Mode: Server + Client-Only)
// ???????????????????????????????????????????????????????????????????????
(function () {
  'use strict';

  // ?? State ??????????????????????????????????????????????????????????
  let currentView = 'dashboard';
  let currentSession = null;
  let selectedVaultItemKey = '';
  let serverMode = false; // detected on init
  let serverHasDefaultKey = false;
  let serverDefaultProvider = null;
  let pipelineTimer = null;
  let pipelineStartedAt = 0;


  let bridgeMonitorTimer = null;
  let tailorViewSnapshot = null;
  let tailorPreflightRefreshTimer = null;
  let acceptedChangesApplyTimer = null;
  let activeResultsTab = 'sections';
  let focusedChangeIndex = -1;
  let latexSurfaceFrame = null;
  let queuedLatexSurface = null;
  let hasSeededBridgeImports = false;
  const bridgeImportSeen = new Set();
  const bridgeEventFeed = [];
  const tailorVaultSelection = new Set();
  let tailorVaultSelectionManual = false;
  let tailorVaultSelectionContextKey = '';
  let lastSelectedTailorJobId = 0;
  let manualTailorJobDraft = { company: '', title: '', description: '', url: '' };
  const batchSelection = new Set();
  const stories = [];     // temp buffer for profile form
  const acceptedChanges = new Set();
  const changeDecisionState = new Map();
  const OUTCOME_LABELS = {
    '': 'No Outcome',
    applied: 'Applied',
    interview: 'Interview',
    offer: 'Offer',
    rejected: 'Rejected',
  };
  const STRICTNESS_LABELS = {
    safe: 'Safe',
    balanced: 'Balanced',
    strategic: 'Strategic',
  };
  const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v3.2';
  const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
  const DEFAULT_COMPANY_RESEARCH_MODEL = 'perplexity/sonar-pro-search';
  const BATCH_QUEUE_STORAGE_KEY = 'cv_tailor_batch_queue_v1';
  const BATCH_FILTER_STORAGE_KEY = 'cv_tailor_batch_filter_v1';

  const COVER_LETTER_GUIDANCE_KEY = 'cv_cover_letter_guidance_v1';
  const COVER_LETTER_SETTINGS_KEY = 'cv_cover_letter_settings_v1';
  const REWRITE_COVERAGE_STORAGE_KEY = 'cv_rewrite_coverage_v1';
  const MAX_BRIDGE_EVENTS = 6;

  const REWRITE_COVERAGE_LABELS = {
    0.6: '60%',
    0.7: '70%',
    0.8: '80%',
  };
  const UI_LIMITS = Object.freeze({
    prompt: {
      jobDescriptionChars: 2200,
      alignmentMissing: 6,
      alignmentMatches: 4,
      alignmentEmphasis: 4,
      alignmentSections: 4,
      alignmentSectionKeywords: 4,
      alignmentSectionSuggestions: 2,
      stories: 3,
      reviewChanges: 8,
      reviewRejectedChanges: 6,
      reviewChangeKeywords: 4,
    },
    dashboard: {
      smartActions: 6,
      recentSessions: 12,
    },
    tailor: {
      sectionItemsPerSection: 3,
      recommendedItems: 6,
      topVaultMatches: 6,
      quickVaultMatches: 4,
      genreSuggestions: 4,
    },
    results: {
      strategicRecommendationsPerSection: 2,
      strategicRecommendationsTotal: 6,
      heroPriorityGaps: 4,
      heroMissingKeywords: 4,
    },
    genres: {
      preferredSignals: 6,
    },
  });

  const DEFAULT_COVER_LETTER_SETTINGS = {
    sender_name: '',
    sender_email: '',
    sender_phone: '',
    sender_linkedin_url: '',
    sender_linkedin_label: '',
    sender_location: '',
    recipient_name: '',
    recipient_location: '',
    signature_image_path: '',
    signature_image_name: '',
    signature_image_data_url: '',
    closing: 'Best regards,',
  };
  const COVER_LETTER_TEMPLATE = String.raw`\documentclass[a4paper,10pt]{article}
\usepackage[left=1in, right=1in, top=1in, bottom=1in]{geometry}
\usepackage{parskip}
\usepackage{hyperref}
\usepackage{graphicx}

\begin{document}

\begin{flushright}
{{sender_block}}
{{letter_date}}
\end{flushright}

\vspace{1cm}

{{recipient_block}}

\textbf{Subject: {{subject}}}

{{greeting}}

{{body_blocks}}

{{closing}}

{{signature_block}}
\textbf{{typed_name}}

\end{document}`;
  let batchJobFilter = localStorage.getItem(BATCH_FILTER_STORAGE_KEY) || 'untouched';

  function limitItems(items, limit) {
    const list = Array.isArray(items) ? items : [];
    if (!Number.isFinite(limit) || limit < 0) return list;
    return list.slice(0, limit);
  }

  function setCountHeading(elementId, baseLabel, visibleCount, totalCount = visibleCount) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const visible = Number(visibleCount || 0);
    const total = Number(totalCount || 0);
    el.textContent = total > visible
      ? `${baseLabel} (${visible}/${total})`
      : (total > 0 ? `${baseLabel} (${total})` : baseLabel);
  }

  // ?? Storage (IndexedDB for client-only, server API when available) ?
  const DB_NAME = 'cv_customizer';
  const DB_VER = 3;
  let idb = null;
  let idbInitError = '';
  let serverOrigin = '';
  const SERVER_ORIGIN_CANDIDATES = Array.from(new Set(
    [
      (typeof window !== 'undefined' && /^https?:/i.test(window.location.origin)) ? window.location.origin : '',
      'http://127.0.0.1:3210',
      'http://localhost:3210',
      'http://127.0.0.1:3001',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
    ].filter(Boolean)
  ));

  function storageUnavailableError() {
    const detail = idbInitError ? ` ${idbInitError}` : '';
    return new Error(`Browser storage is unavailable. Start the local server on http://127.0.0.1:3001 or allow IndexedDB for this site.${detail}`);
  }

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (idb) return resolve(idb);
      if (typeof indexedDB === 'undefined') {
        idbInitError = 'IndexedDB is not available in this browser context.';
        return reject(storageUnavailableError());
      }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('genres')) db.createObjectStore('genres', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('vault_items')) db.createObjectStore('vault_items', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => {
        idb = req.result;
        idbInitError = '';
        resolve(idb);
      };
      req.onerror = () => {
        idbInitError = req.error?.message || 'IndexedDB failed to open.';
        reject(storageUnavailableError());
      };
      req.onblocked = () => {
        idbInitError = 'IndexedDB open was blocked.';
        reject(storageUnavailableError());
      };
    });
  }

  function idbAll(store) {
    return openIDB().then(() => new Promise((resolve, reject) => {
      const tx = idb.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbGet(store, id) {
    return openIDB().then(() => new Promise((resolve, reject) => {
      const tx = idb.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbPut(store, obj) {
    return openIDB().then(() => new Promise((resolve, reject) => {
      const tx = idb.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(obj);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbDelete(store, id) {
    return openIDB().then(() => new Promise((resolve, reject) => {
      const tx = idb.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function canPollBridgeMonitor() {
    return serverMode && !document.hidden && (currentView === 'dashboard' || currentView === 'tailor');
  }

  function invalidateTailorSnapshot() {
    tailorViewSnapshot = null;
  }

  async function getTailorViewSnapshot(options = {}) {
    if (!options.force && tailorViewSnapshot) return tailorViewSnapshot;
    const [profiles, jobs, genres, sessions, rawVaultItems] = await Promise.all([
      Store.getProfiles(),
      Store.getJobs(),
      Store.getGenres(),
      Store.getSessions(),
      Store.getVaultItems(),
    ]);
    tailorViewSnapshot = { profiles, jobs, genres, sessions, rawVaultItems };
    return tailorViewSnapshot;
  }

  function scheduleTailorPreflightRefresh(options = {}) {
    if (tailorPreflightRefreshTimer) {
      clearTimeout(tailorPreflightRefreshTimer);
      tailorPreflightRefreshTimer = null;
    }
    const run = () => {
      tailorPreflightRefreshTimer = null;
      refreshTailorPreflight().catch((error) => toast(error.message, 'error'));
    };
    if (options.immediate) {
      run();
      return;
    }
    tailorPreflightRefreshTimer = setTimeout(run, TAILOR_PREFLIGHT_DEBOUNCE_MS);
  }

  function scheduleApplySelectedChanges() {
    if (acceptedChangesApplyTimer) clearTimeout(acceptedChangesApplyTimer);
    acceptedChangesApplyTimer = setTimeout(() => {
      acceptedChangesApplyTimer = null;
      applySelectedChanges().catch((error) => toast(error.message, 'error'));
    }, ACCEPTED_CHANGE_APPLY_DEBOUNCE_MS);
  }

  function queueLatexSurfaceRefresh(latex, originalLatex, options = {}) {
    queuedLatexSurface = {
      latex: latex || '',
      originalLatex: originalLatex || '',
      forceDiff: Boolean(options.forceDiff),
    };
    if (latexSurfaceFrame) return;
    latexSurfaceFrame = window.requestAnimationFrame(() => {
      latexSurfaceFrame = null;
      const nextSurface = queuedLatexSurface || { latex: '', originalLatex: '', forceDiff: false };
      renderLatexPreview(nextSurface.latex);
      if (activeResultsTab === 'latex' || nextSurface.forceDiff) {
        renderEditedLatexCode(nextSurface.originalLatex, nextSurface.latex);
      }
    });
  }

  function revokeCompiledPdfUrl() {}
  function revokeCoverLetterPdfUrl() {}


  async function migrateLegacyVaultItems() {
    const profiles = await idbAll('profiles');
    const existingItems = await idbAll('vault_items');
    const existingProfileIds = new Set(existingItems.map((item) => Number(item.profile_id)));

    for (const profile of profiles) {
      if (existingProfileIds.has(Number(profile.id))) continue;
      const legacyStories = deserializeStories(profile.stories);
      for (const story of legacyStories) {
        if (!story.text) continue;
        await idbPut('vault_items', {
          profile_id: Number(profile.id),
          profile_name: profile.name,
          title: story.title || deriveStoryTitle(story),
          tag: story.tag || 'general',
          status: story.status || 'grounded',
          text: story.text,
          preferred_bullet: story.preferred_bullet || '',
          source: 'legacy-profile-story',
          created_at: story.created_at || profile.created_at || new Date().toISOString(),
          updated_at: story.updated_at || profile.updated_at || new Date().toISOString(),
        });
      }
    }
  }

  // ?? API Layer (auto-switches between server and client-only) ???????
  function getApiKey() { return localStorage.getItem('cv_api_key') || ''; }
  function setApiKey(k) { localStorage.setItem('cv_api_key', k); updateApiStatus(); }
  function isOpenRouterKey(apiKey) { return !!(apiKey && apiKey.startsWith('sk-or-')); }
  function isOpenRouterModel(model) {
    const normalized = String(model || '').trim().toLowerCase();
    return normalized === 'openrouter/free' || normalized.endsWith(':free') || normalized.startsWith('openrouter/') || normalized.includes('/');
  }
  function getEffectiveProvider(apiKey) {
    if (isOpenRouterKey(apiKey)) return 'openrouter';
    if (apiKey) return 'openai';
    return serverDefaultProvider;
  }
  function getCompatibleModel(model, apiKey) {
    const requested = model ||
      localStorage.getItem('cv_model') ||
      (getEffectiveProvider(apiKey) === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_OPENAI_MODEL);
    const provider = getEffectiveProvider(apiKey);
    if (provider === 'openrouter') return resolveModelName(requested, apiKey || 'sk-or-placeholder');
    if (provider === 'openai') {
      if (isOpenRouterModel(requested)) return DEFAULT_OPENAI_MODEL;
      return requested;
    }
    return requested;
  }
  function providerSlug(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  function getModel() {
    return getCompatibleModel(
      localStorage.getItem('cv_model') ||
        ((isOpenRouterKey(getApiKey()) || serverDefaultProvider === 'openrouter')
          ? DEFAULT_OPENROUTER_MODEL
          : DEFAULT_OPENAI_MODEL),
      getApiKey()
    );
  }

  function isKnownModelOption(value) {
    const select = document.getElementById('modelSelect');
    if (!select) return false;
    return Array.from(select.options).some((option) => option.value === value);
  }

  function syncModelSettingsFields(modelValue) {
    const select = document.getElementById('modelSelect');
    const customInput = document.getElementById('customModelInput');
    if (!select || !customInput) return;
    const value = String(modelValue || '').trim();
    if (value && isKnownModelOption(value) && value !== '__custom__') {
      select.value = value;
      customInput.value = '';
      return;
    }
    select.value = '__custom__';
    customInput.value = value;
  }

  function getRequestedModelFromSettings() {
    const select = document.getElementById('modelSelect');
    const customInput = document.getElementById('customModelInput');
    if (!select) return getModel();
    const customValue = String(customInput?.value || '').trim();
    if (customValue) return customValue;
    if (select.value && select.value !== '__custom__') return select.value;
    return getEffectiveProvider(document.getElementById('apiKeyInput')?.value.trim() || getApiKey()) === 'openrouter'
      ? DEFAULT_OPENROUTER_MODEL
      : DEFAULT_OPENAI_MODEL;
  }

  async function detectServer() {
    for (const origin of SERVER_ORIGIN_CANDIDATES) {
      try {
        const res = await fetch(`${origin}/api/bridge/status`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) continue;
        const data = await res.json();
        serverMode = true;
        serverOrigin = origin;
        serverHasDefaultKey = !!data.apiKeyConfigured;
        serverDefaultProvider = data.defaultProvider || null;
        return;
      } catch {}
    }
    serverMode = false;
    serverOrigin = '';
    serverHasDefaultKey = false;
    serverDefaultProvider = null;
  }

  function originPort(origin) {
    const match = String(origin || '').match(/:(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : 0;
  }

  function deriveBridgeTargetLabel(origin, runtime) {
    const port = originPort(origin);
    if (String(runtime || '').toLowerCase() === 'desktop' || port === 3210) return 'Desktop (3210)';
    if (port === 3001) return 'Dev (3001)';
    if (port === 3000) return 'Local (3000)';
    if (serverMode) return 'Connected Runtime';
    return 'Local workspace';
  }

  function parseCaptureMeta(job) {
    return parseJSON(job?.capture_meta) || {};
  }

  function renderBridgeEventFeed() {
    const runtimePanel = document.getElementById('runtimeClarity');
    if (runtimePanel) {
      const feedHtml = bridgeEventFeed.length
        ? bridgeEventFeed.map((event) => `
          <div class="runtime-feed-item">
            <div class="runtime-feed-title">${esc(event.title || 'Imported job')} @ ${esc(event.company || 'Unknown company')}</div>
            <div class="runtime-feed-meta">${esc(event.message || '')} ? ${esc(fmtDate(event.timestamp || event.created_at || ''))}</div>
          </div>
        `).join('')
        : '<p class="empty-state">No extension imports detected yet.</p>';
      runtimePanel.innerHTML = `
        <div class="runtime-status-card">
          <div class="runtime-status-top">
            <div>
              <div class="runtime-title">${esc(bridgeRuntimeState.targetLabel || 'Local workspace')}</div>
              <div class="runtime-subtitle">${esc(bridgeRuntimeState.origin || 'No live bridge detected')}</div>
            </div>
            <div class="runtime-pills">
              <span class="meta-pill">${esc(String(bridgeRuntimeState.runtime || 'client-only'))}</span>
              <span class="meta-pill">${bridgeRuntimeState.pdflatex ? 'Native PDF ready' : (bridgeRuntimeState.wasm_preview ? 'WASM preview ready' : 'No PDF compile')}</span>
            </div>
          </div>
          <div class="runtime-status-copy">
            Active target: ${esc(bridgeRuntimeState.last_bridge_target || bridgeRuntimeState.targetLabel || 'Local workspace')}.
            ${bridgeRuntimeState.status === 'online'
              ? 'Extension imports will land in this runtime.'
              : 'Start the desktop app or local server to receive extension jobs directly.'}
          </div>
          <div class="runtime-feed">${feedHtml}</div>
        </div>
      `;
    }

    const targetEl = document.getElementById('runtimeIndicator');
    if (targetEl) {
      targetEl.textContent = bridgeRuntimeState.targetLabel || 'Local workspace';
      targetEl.dataset.state = bridgeRuntimeState.status || 'offline';
      targetEl.title = bridgeRuntimeState.origin || 'No active runtime detected';
    }
  }

  function buildReadinessState(profiles, jobs, vaultItems) {
    const keyReady = !!getApiKey() || (serverMode && serverHasDefaultKey);
    const importedJobs = countImportedJobs(jobs);
    const requiredSteps = [
      {
        label: 'Runtime',
        done: serverMode,
        detail: serverMode ? `${bridgeRuntimeState.targetLabel || 'Connected'} detected.` : 'Client-only mode is active. Bridge import needs desktop/server, but WASM PDF preview can still run in the editor.',
      },
      {
        label: 'API access',
        done: keyReady,
        detail: keyReady ? 'Model access is configured.' : 'Add an API key or start a runtime with a server-side default key.',
      },
      {
        label: 'Profile',
        done: profiles.length > 0,
        detail: profiles.length ? `${profiles.length} profile${profiles.length === 1 ? '' : 's'} available.` : 'Import or create a base CV profile first.',
      },
      {
        label: 'Job',
        done: jobs.length > 0,
        detail: jobs.length ? `${jobs.length} saved job${jobs.length === 1 ? '' : 's'} ready.${importedJobs ? ` ${importedJobs} came from the bridge.` : ''}` : 'Capture or paste one target job description.',
      },
    ];
    const advisorySteps = [
      {
        label: 'Vault support',
        done: vaultItems.length > 0,
        detail: vaultItems.length ? `${vaultItems.length} source item${vaultItems.length === 1 ? '' : 's'} can back suggestions.` : 'Add a few reusable bullets or projects so the model has grounded proof to pull from.',
      },
      {
        label: 'PDF compile',
        done: !!bridgeRuntimeState.pdflatex || !!bridgeRuntimeState.wasm_preview,
        detail: bridgeRuntimeState.pdflatex
          ? 'Native LaTeX and WASM preview are available.'
          : (bridgeRuntimeState.wasm_preview
            ? 'WASM preview is available in the editor. Native LaTeX export is unavailable.'
            : 'Compile preview is unavailable in this runtime.'),
      },
    ];

    const readiness = document.getElementById('homeReadiness');
    if (readiness) {
      readiness.innerHTML = `
        <div class="readiness-list">
          ${requiredSteps.map((step) => `
            <div class="readiness-item ${step.done ? 'done' : 'next'}">
              <div class="readiness-marker">${step.done ? '?' : '?'}</div>
              <div>
                <div class="readiness-title">${esc(step.label)}</div>
                <div class="readiness-copy">${esc(step.detail)}</div>
              </div>
            </div>
          `).join('')}
          ${advisorySteps.map((step) => `
            <div class="readiness-item advisory ${step.done ? 'done' : ''}">
              <div class="readiness-marker">${step.done ? '?' : '+'}</div>
              <div>
                <div class="readiness-title">${esc(step.label)}</div>
                <div class="readiness-copy">${esc(step.detail)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  async function refreshBridgeRuntimeState() {
    if (!serverMode || !serverOrigin) {
      bridgeRuntimeState = {
        status: 'offline',
        runtime: 'client-only',
        origin: '',
        targetLabel: 'Local workspace',
        last_bridge_target: 'Local workspace',
        pdflatex: false,
        wasm_preview: canUseWasmCompile(),
        apiKeyConfigured: false,
        defaultProvider: null,
        lastCheckedAt: new Date().toISOString(),
      };
      renderBridgeEventFeed();
      return bridgeRuntimeState;
    }

    try {
      const payload = await apiFetch('/health');
      bridgeRuntimeState = {
        status: 'online',
        runtime: payload.runtime || 'server',
        origin: payload.origin || serverOrigin,
        targetLabel: deriveBridgeTargetLabel(payload.origin || serverOrigin, payload.runtime),
        last_bridge_target: deriveBridgeTargetLabel(payload.origin || serverOrigin, payload.runtime),
        pdflatex: false,
        wasm_preview: false,
        apiKeyConfigured: !!payload.apiKeyConfigured,
        defaultProvider: payload.defaultProvider || null,
        lastCheckedAt: payload.timestamp || new Date().toISOString(),
      };

    } catch {
      bridgeRuntimeState = {
        ...bridgeRuntimeState,
        status: 'offline',
        targetLabel: 'Runtime unavailable',
        last_bridge_target: 'Runtime unavailable',
        lastCheckedAt: new Date().toISOString(),
      };
    }
    renderBridgeEventFeed();
    return bridgeRuntimeState;
  }

  function pushBridgeEvent(job, message, announce = false) {
    const meta = parseCaptureMeta(job);
    const event = {
      job_id: Number(job.id || 0),
      title: job.title || 'Imported job',
      company: job.company || '',
      timestamp: meta.importedAt || job.updated_at || job.created_at || new Date().toISOString(),
      message,
    };
    bridgeEventFeed.unshift(event);
    if (bridgeEventFeed.length > MAX_BRIDGE_EVENTS) bridgeEventFeed.length = MAX_BRIDGE_EVENTS;
    renderBridgeEventFeed();
    if (announce) {
      toast(`Received from extension: ${event.title}${event.company ? ` @ ${event.company}` : ''}`, 'success');
    }
  }

  function ingestImportedJobs(jobs, options = {}) {
    (jobs || [])
      .filter((job) => String(job.source || '').trim() && String(job.source || '').trim() !== 'manual')
      .sort((a, b) => String(a.updated_at || a.created_at || '').localeCompare(String(b.updated_at || b.created_at || '')))
      .forEach((job) => {
        const meta = parseCaptureMeta(job);
        const stamp = `${job.id}:${meta.importedAt || job.updated_at || job.created_at || ''}`;
        if (bridgeImportSeen.has(stamp)) return;
        bridgeImportSeen.add(stamp);
        if (!options.seedOnly) {
          pushBridgeEvent(job, `Imported into ${bridgeRuntimeState.targetLabel || 'the active runtime'}`, Boolean(options.announce));
        }
      });
    if (options.seedOnly) {
      renderBridgeEventFeed();
    }
  }

  async function pollBridgeImports(options = {}) {
    if (!serverMode) return;
    try {
      const [jobs] = await Promise.all([
        Store.getJobs(),
        refreshBridgeRuntimeState(),
      ]);
      ingestImportedJobs(jobs, options);
      hasSeededBridgeImports = true;
      if (currentView === 'dashboard') {
        const [profiles, vaultItems] = await Promise.all([Store.getProfiles(), Store.getVaultItems()]);
        buildReadinessState(profiles, jobs, buildVaultItems(vaultItems, profiles, await Store.getSessions()));
      }
    } catch {}
  }

  function startBridgeMonitor() {
    if (bridgeMonitorTimer) clearInterval(bridgeMonitorTimer);
    if (!serverMode) {
      refreshBridgeRuntimeState().catch(() => {});
      return;
    }
    pollBridgeImports({ seedOnly: !hasSeededBridgeImports, announce: false }).catch(() => {});
    bridgeMonitorTimer = setInterval(() => {
      if (!canPollBridgeMonitor()) return;
      pollBridgeImports({ seedOnly: false, announce: true }).catch(() => {});
    }, BRIDGE_MONITOR_INTERVAL_MS);
  }

  async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (getApiKey()) headers['X-API-Key'] = getApiKey();
    if (!headers['X-Model']) headers['X-Model'] = getCompatibleModel(getModel(), getApiKey());
    const apiBase = serverOrigin ? `${serverOrigin}/api` : '/api';
    const res = await fetch(`${apiBase}${path}`, { ...opts, headers });
    if (opts.raw) return res;
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/pdf')) return res.blob();
    return res.json();
  }

  function parseStructuredJson(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const candidates = [text];
    const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedJson?.[1]) candidates.push(String(fencedJson[1]).trim());
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(text.slice(firstBrace, lastBrace + 1));
    }

    const seen = new Set();
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      try { return JSON.parse(normalized); } catch {}
    }
    return null;
  }

  function dedupeStrings(items) {
    return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
  }

  function extractReplaceableLatexTargets(latex) {
    const lines = String(latex || '').split(/\r?\n/);
    let currentSection = 'General';
    const targets = [];

    lines.forEach((rawLine, index) => {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('%')) return;

      const sectionMatch = trimmed.match(/^\\section\*?\{([^}]*)\}/);
      if (sectionMatch) {
        currentSection = String(sectionMatch[1] || 'General').trim() || 'General';
        return;
      }

      if (/^\\item\b/.test(trimmed) || /^\\textbf\{/.test(trimmed) || /^[A-Za-z].{25,}$/.test(trimmed)) {
        targets.push({
          section_name: currentSection,
          kind: /^\\item\b/.test(trimmed) ? 'item' : (/^\\textbf\{/.test(trimmed) ? 'headline' : 'text'),
          latex: trimmed,
          line_number: index + 1,
          inventory_index: targets.length,
        });
      }
    });

    return targets;
  }

  function buildReplacementSourceLocal(latex) {
    const targets = extractReplaceableLatexTargets(latex);
    return targets.length ? targets.map((target) => target.latex).join('\n') : latex;
  }

  function buildReplacementInventoryPromptLocal(latex) {
    return extractReplaceableLatexTargets(latex).map((target) => ({
      section_name: target.section_name,
      kind: target.kind,
      line_number: target.line_number,
      exact_latex: target.latex,
    }));
  }

  function normalizeChangeImportance(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'critical' || normalized === 'recommended' || normalized === 'optional') return normalized;
    return 'optional';
  }

  function getChangeType(change) {
    const raw = String(change?.change_type || '').trim().toLowerCase();
    if (raw === 'keep' || raw === 'edit') return raw;
    return String(change?.original_text || '') === String(change?.edited_text || '') ? 'keep' : 'edit';
  }

  function isMaterialChange(change) {
    return getChangeType(change) === 'edit' &&
      String(change?.original_text || '') !== String(change?.edited_text || '');
  }

  function buildKeepChange(target) {
    return {
      change_type: 'keep',
      section_name: target.section_name || 'General',
      importance: 'optional',
      original_text: target.latex || '',
      edited_text: target.latex || '',
      reason: 'Current wording stays as-is because no grounded rewrite improved this line.',
      target_keywords: [],
      is_hallucinated: false,
      kind: target.kind || 'text',
      line_number: target.line_number ?? null,
      inventory_index: target.inventory_index ?? 0,
      auto_generated: true,
    };
  }

  function normalizeReplacementReport(report, latex) {
    const normalizedReport = report && typeof report === 'object' ? { ...report } : { changes: [] };
    const targets = extractReplaceableLatexTargets(latex);
    const rawChanges = Array.isArray(normalizedReport.changes) ? normalizedReport.changes : [];

    if (!targets.length) {
      normalizedReport.changes = rawChanges.map((change, index) => ({
        ...change,
        importance: normalizeChangeImportance(change?.importance),
        change_type: getChangeType(change),
        inventory_index: index,
        line_number: change?.line_number ?? null,
      }));
      normalizedReport.coverage = {
        total_targets: normalizedReport.changes.length,
        item_targets: normalizedReport.changes.filter((change) => change.kind === 'item').length,
        edited_targets: normalizedReport.changes.filter(isMaterialChange).length,
        kept_targets: normalizedReport.changes.filter((change) => !isMaterialChange(change)).length,
        unmatched_model_changes: 0,
      };
      return normalizedReport;
    }

    const byOriginalText = rawChanges.reduce((acc, change, index) => {
      const key = String(change?.original_text || '');
      if (!key) return acc;
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key).push({ change, index });
      return acc;
    }, new Map());

    const usedIndexes = new Set();
    normalizedReport.changes = targets.map((target) => {
      const matches = byOriginalText.get(target.latex) || [];
      const matched = matches.find((entry) => !usedIndexes.has(entry.index));
      if (!matched) return buildKeepChange(target);
      usedIndexes.add(matched.index);
      const originalText = target.latex;
      const editedText = String(matched.change?.edited_text || '') || originalText;
      const normalizedChange = {
        ...matched.change,
        change_type: getChangeType({
          ...matched.change,
          original_text: originalText,
          edited_text: editedText,
        }),
        section_name: matched.change?.section_name || target.section_name || 'General',
        importance: normalizeChangeImportance(matched.change?.importance),
        original_text: originalText,
        edited_text: editedText,
        reason: String(matched.change?.reason || '').trim() ||
          (editedText === originalText
            ? 'Current wording is already grounded enough to keep as-is.'
            : 'Rewrite candidate generated from the alignment analysis.'),
        target_keywords: dedupeStrings(matched.change?.target_keywords || []),
        kind: target.kind || matched.change?.kind || 'text',
        line_number: target.line_number ?? matched.change?.line_number ?? null,
        inventory_index: target.inventory_index ?? matched.change?.inventory_index ?? 0,
      };
      if (normalizedChange.change_type === 'keep') {
        normalizedChange.edited_text = originalText;
      }
      return normalizedChange;
    });

    normalizedReport.coverage = {
      total_targets: targets.length,
      item_targets: targets.filter((target) => target.kind === 'item').length,
      edited_targets: normalizedReport.changes.filter(isMaterialChange).length,
      kept_targets: normalizedReport.changes.filter((change) => !isMaterialChange(change)).length,
      unmatched_model_changes: rawChanges.filter((_, index) => !usedIndexes.has(index)).length,
    };
    normalizedReport.warnings = dedupeStrings([
      ...(normalizedReport.warnings || []),
      normalizedReport.coverage.total_targets
        ? `Reviewed ${normalizedReport.coverage.total_targets} replaceable line(s): ${normalizedReport.coverage.edited_targets} edited, ${normalizedReport.coverage.kept_targets} kept.`
        : '',
      normalizedReport.coverage.unmatched_model_changes
        ? `${normalizedReport.coverage.unmatched_model_changes} model suggestion(s) were ignored because they did not match an exact source line.`
        : '',
    ]);
    return normalizedReport;
  }

  function ensureEditableChangeState(report) {
    if (!report || !Array.isArray(report.changes)) return report;
    report.changes = report.changes.map((change) => {
      const originalText = String(change?.original_text || '');
      const editedText = String(change?.edited_text || originalText);
      return {
        ...change,
        original_text: originalText,
        edited_text: editedText,
        model_edited_text: String(change?.model_edited_text || editedText),
        manual_override: Boolean(change?.manual_override),
      };
    });
    return report;
  }

  function applyReplacementChanges(latex, changes) {
    let edited = latex || '';
    const actionableChanges = (changes || [])
      .filter((change) => isMaterialChange(change))
      .sort((a, b) => Number(b?.line_number || 0) - Number(a?.line_number || 0));

    actionableChanges.forEach((change) => {
      const originalText = String(change?.original_text || '');
      const editedText = String(change?.edited_text || '');
      const lineNumber = Number(change?.line_number || 0);
      if (lineNumber > 0) {
        const lines = edited.split(/\r?\n/);
        const currentLine = lines[lineNumber - 1];
        if (currentLine != null && String(currentLine).trim() === originalText) {
          const indent = String(currentLine).match(/^\s*/)?.[0] || '';
          lines[lineNumber - 1] = `${indent}${editedText}`;
          edited = lines.join('\n');
          return;
        }
      }
      if (originalText && editedText && edited.includes(originalText)) {
        edited = edited.replace(originalText, editedText);
      }
    });
    return edited;
  }

  function resolveModelName(model, apiKey) {
    const requested = model || getModel();
    const isOR = isOpenRouterKey(apiKey);
    if (!isOR) return requested;
    const openRouterMap = {
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4-turbo': 'openai/gpt-4-turbo',
    };
    return openRouterMap[requested] || requested;
  }

  function extractMessageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => extractMessageText(part)).filter(Boolean).join('\n');
    }
    if (content && typeof content.text === 'string') return content.text;
    if (content && typeof content.content === 'string') return content.content;
    if (content && Array.isArray(content.content)) {
      return content.content.map((part) => extractMessageText(part)).filter(Boolean).join('\n');
    }
    return '';
  }

  function isRoutingParameterErrorMessage(message) {
    const raw = String(message || '');
    return /no endpoints found that can handle the requested parameters/i.test(raw) ||
      /provider routing/i.test(raw) ||
      /unsupported parameter/i.test(raw);
  }

  function isReasoningConstraintErrorMessage(message) {
    const raw = String(message || '');
    return /reasoning is mandatory/i.test(raw) || /cannot be disabled/i.test(raw);
  }

  function isDeveloperInstructionErrorMessage(message) {
    return /developer instruction is not enabled/i.test(String(message || ''));
  }

  function dedupeRequestBodies(variants) {
    const seen = new Set();
    return variants.filter((variant) => {
      const key = JSON.stringify(variant);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function formatOpenRouterReset(value = '') {
    const resetAt = Number(value || 0);
    if (!Number.isFinite(resetAt) || resetAt <= 0) return '';
    try {
      return new Date(resetAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function buildOpenRouterRequestBodies(baseBody) {
    const variants = [baseBody];
    const reasoningPresent = Boolean(baseBody.reasoning);
    const pluginsPresent = Boolean(baseBody.plugins);
    const responseFormatPresent = Boolean(baseBody.response_format);
    const providerPresent = Boolean(baseBody.provider);

    function cloneAndRelax(relax) {
      const next = { ...baseBody };
      if (relax.reasoning) delete next.reasoning;
      if (relax.plugins) delete next.plugins;
      if (relax.responseFormat) delete next.response_format;
      if (relax.provider) delete next.provider;
      return next;
    }

    if (reasoningPresent) {
      variants.push(cloneAndRelax({ reasoning: true }));
    }
    if (pluginsPresent) {
      variants.push(cloneAndRelax({ plugins: true }));
    }
    if (reasoningPresent && pluginsPresent) {
      variants.push(cloneAndRelax({ reasoning: true, plugins: true }));
    }
    if (responseFormatPresent) {
      variants.push(cloneAndRelax({ plugins: true, responseFormat: true }));
    }
    if (reasoningPresent && responseFormatPresent) {
      variants.push(cloneAndRelax({ reasoning: true, plugins: true, responseFormat: true }));
    }
    if (providerPresent) {
      variants.push(cloneAndRelax({ plugins: true, responseFormat: true, provider: true }));
    }
    if (reasoningPresent && providerPresent) {
      variants.push(cloneAndRelax({ reasoning: true, plugins: true, responseFormat: true, provider: true }));
    }

    return dedupeRequestBodies(variants);
  }

  // Direct OpenAI call from browser (for client-only mode)
  async function callOpenAIDirect(systemPrompt, userPrompt, opts = {}) {
    const key = getApiKey();
    if (!key) throw new Error('No API key set');
    const isOR = isOpenRouterKey(key);
    const endpoint = isOR ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    const actualModel = getCompatibleModel(opts.model || getModel(), key);
    const isFreeModel = isOR && (actualModel === 'openrouter/free' || String(actualModel).endsWith(':free'));
    const jsonMode = opts.json !== false;
    const tokenFloor = isFreeModel ? (jsonMode ? 1200 : 900) : 0;
    const requestedMaxTokens = opts.maxTokens || 4096;
    const maxTokens = Math.max(requestedMaxTokens, tokenFloor);

    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
    if (isOR) {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'CV Customizer';
    }

    const baseBody = {
      model: actualModel,
      temperature: opts.temperature || 0.3,
      max_tokens: maxTokens,
      ...(isFreeModel ? {
        provider: {
          sort: 'latency',
          require_parameters: true,
          allow_fallbacks: true,
        }
      } : {}),
      ...(isOR && jsonMode ? { plugins: [{ id: 'response-healing' }] } : {}),
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };
    const requestBodies = isOR ? buildOpenRouterRequestBodies(baseBody) : [baseBody];
    let lastError = null;

    for (let index = 0; index < requestBodies.length; index += 1) {
      const requestBody = requestBodies[index];
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });
      const data = await res.json().catch(() => ({}));
      let errorMessage = data.error?.message || `OpenAI error ${res.status}`;
      if (res.status === 429 && /free-models-per-min/i.test(errorMessage)) {
        const resetTime = formatOpenRouterReset(res.headers.get('x-ratelimit-reset'));
        errorMessage = resetTime
          ? `OpenRouter free-model rate limit reached. Wait until ${resetTime} or switch to a non-free model like deepseek/deepseek-v3.2 or google/gemini-2.5-flash.`
          : 'OpenRouter free-model rate limit reached. Wait a minute or switch to a non-free model like deepseek/deepseek-v3.2 or google/gemini-2.5-flash.';
      }

      if (!res.ok) {
        lastError = new Error(errorMessage);
        if (isOR && index < requestBodies.length - 1 && (
          isRoutingParameterErrorMessage(errorMessage) ||
          isReasoningConstraintErrorMessage(errorMessage) ||
          isDeveloperInstructionErrorMessage(errorMessage)
        )) {
          continue;
        }
        throw lastError;
      }

      const raw = extractMessageText(data?.choices?.[0]?.message?.content || '');
      if (!String(raw || '').trim()) {
        lastError = new Error(data?.choices?.[0]?.message?.reasoning
          ? 'Model returned reasoning without a final answer'
          : 'Model returned empty content');
        if (isOR && index < requestBodies.length - 1) {
          continue;
        }
        throw lastError;
      }

      const usage = data.usage || {};
      if (jsonMode) {
        return { data: parseStructuredJson(raw) ?? raw, usage };
      }
      return { data: raw, usage };
    }

    throw lastError || new Error('OpenAI request failed');
  }

  // ?? Prompts (embedded for client-only mode) ????????????????????????
  const PROMPTS = {
    parseSystem: `You are a precise job-description analyst.

TASK: Extract structured requirements from the job posting below. Be thorough but do not invent requirements that are not stated or clearly implied.

Return a JSON object with EXACTLY this schema:
{
  "company": "",
  "title": "",
  "seniority": "entry/mid/senior/lead/unknown",
  "required_skills": [],
  "preferred_skills": [],
  "responsibilities": [],
  "industry_keywords": [],
  "soft_skills": [],
  "education": "",
  "experience_years": "",
  "culture_signals": [],
  "keyword_taxonomy": {
    "hard_skills": [],
    "tools": [],
    "certifications": [],
    "domain_knowledge": []
  }
}`,

    analyzeSystem: `You are a rigorous CV-to-job alignment analyst. You score HONESTLY based ONLY on evidence present in the CV text. You never inflate scores.

Return a JSON object with EXACTLY this schema:
{
  "overall_score": 0,
  "overall_verdict": "",
  "sections": [
    {
      "name": "",
      "score": 0,
      "matched_keywords": [],
      "gaps": [],
      "suggestions": [],
      "story_to_weave": ""
    }
  ],
  "missing_from_cv": [],
  "strongest_matches": [],
  "recommended_emphasis": [],
  "corpus_suggestions": [
    {
      "story_index": 0,
      "story_tag": "",
      "target_section": "",
      "action": "add | swap | weave",
      "swap_target": "",
      "rationale": "",
      "importance": "critical | recommended | optional",
      "draft_bullet": ""
    }
  ]
}

RULES:
- Suggestions must be specific edits, not vague advice.
- Prefer stronger existing evidence over generic rewriting.`,

    replaceSystem: `You are a precise CV tailoring assistant. You generate exact string-replacements to adapt an existing LaTeX CV to a specific job description.

Return a JSON object with EXACTLY this schema:
{
  "summary": "",
  "alignment_improvement": {
    "before": 0,
    "after": 0,
    "explanation": ""
  },
  "strategic_recommendations": [
    {
      "focus": "summary | experience | projects | skills | education | layout",
      "action": "keep | expand | tighten | de-emphasize | remove | reorder",
      "recommendation": "",
      "reason": ""
    }
  ],
  "changes": [
    {
      "change_type": "edit | keep",
      "section_name": "",
      "importance": "critical | recommended | optional",
      "original_text": "",
      "edited_text": "",
      "reason": "",
      "target_keywords": [],
      "is_hallucinated": false
    }
  ],
  "risks": []
}

RULES:
- Prioritize repeated must-have requirements and recruiter-visible sections first.
- Bullet rewrites should improve this ladder when possible: action, deliverable, tool/domain context, scope/stakeholder detail, and result/value.
- If no metric exists, improve ownership, specificity, complexity, collaboration, or business impact framing instead of inventing numbers.
- Return 3-6 strategic recommendations about what sections to keep, tighten, expand, reorder, or de-emphasize.
- Return exactly one change object for every bullet or sentence provided in the source, in the same order.
- Use "change_type":"keep" when a line should stay unchanged, and in that case "edited_text" must exactly equal "original_text".
- For bullet lines that begin with "\\item", choose between "edit" and "keep" based on the requested rewrite coverage and the value of the rewrite.
- "original_text" MUST be an exact substring of the original LaTeX.
- Rewrite bullets meaningfully, but keep them truthful.
- Do not make low-value edits that only sound stronger.
- Every change must address a concrete requirement, keyword, or evidence gap.
- Preserve LaTeX syntax.
- Keep the resume one-page friendly. Favor sharper wording over longer wording.
- Do not rewrite the whole file.
- A valid edit may tighten wording, improve action/result clarity, or surface already-supported keywords even when no new metric is added.
- Aim to edit roughly the requested share of bullets, not all of them.
- Prefer full bullet rewrites over tiny keyword swaps. Avoid adjective-only tweaks or single-word insertions unless that is the only truthful option.
- A bullet edit is invalid if it only changes tone words without improving specificity, ownership, scope, stakeholder context, or result framing.

MINI EXAMPLE:
- Valid original_text: "\\item Built dashboards for internal teams."
- Invalid original_text: "Built dashboards for internal teams."
- Valid keep entry: {"change_type":"keep","section_name":"Experience","importance":"optional","original_text":"\\item Built dashboards for internal teams.","edited_text":"\\item Built dashboards for internal teams.","reason":"Current wording is already grounded enough to keep as-is.","target_keywords":[],"is_hallucinated":false}`,

    reviewAppliedSystem: `You are a strict final-draft reviewer for a CV tailoring workflow.

Return a JSON object with EXACTLY this schema:
{
  "verdict": "improved | mixed | unchanged | worse",
  "headline": "",
  "summary": "",
  "metric_interpretation": "",
  "wins": [],
  "regressions": [],
  "still_missing": [],
  "next_actions": [],
  "review_readiness": {
    "status": "ready | review_first | revise_again",
    "reason": ""
  }
}

RULES:
- Compare the original CV and the accepted draft directly.
- Use the metric movement as evidence, but call out regressions if the accepted subset weakened the draft.
- Use the accepted, kept-original, and pending change summaries to understand the user's choices.
- Be candid. If the accepted draft did not improve enough, say so.
- Do not rewrite the CV again here.
- Return valid JSON only.`,

    coverLetterSystem: `You are a grounded cover letter writer.

Return a JSON object with EXACTLY this schema:
{
  "body_latex": ["3-4 short raw LaTeX body paragraphs only, no greeting or signature"],
  "closing": "brief professional sign-off such as Best regards,"
}

RULES:
- Use paragraph 1 as a hook tied to the employer's need, middle paragraph(s) as evidence, and the final paragraph as value plus next steps.
- Keep the combined body between 170 and 250 words.
- Reference 2-3 specific achievements from the CV.
- Never fabricate.
- If user story or objectives are provided, use them only as a framing lens. Do not invent unsupported claims.
- Use the provided LaTeX template as structure and tone guidance only. Ignore placeholders and any old personal details in it.
- \`body_latex\` must be raw LaTeX-ready paragraph content only. Do not include document wrappers, the subject line, greeting, signature, or image commands.
- Return valid JSON only.`,

    interviewPrepSystem: `You are an interview preparation coach. Generate targeted interview preparation notes based on the CV tailoring analysis.

Return JSON:
{
  "talking_points": [
    {
      "topic": "",
      "your_strength": "",
      "gap_to_address": "",
      "sample_answer_outline": ""
    }
  ],
  "likely_questions": [
    {
      "question": "",
      "category": "technical | behavioral | situational",
      "suggested_approach": ""
    }
  ],
  "red_flags": [],
  "key_numbers": []
}`,

    companyResearchSystem: `You are a corporate intelligence analyst and interview research specialist.

Return a concise Markdown report that covers:
- mission and culture
- recent news or strategic shifts
- interview style and process signals
- employee sentiment themes
- likely technical or business context relevant to the role

Keep it practical, candid, and high-signal.
- Keep the whole report under 220 words.
- Use 5 short sections max.
- Prefer 1-2 bullets or sentences per section.`
  };

  function compressJobDescriptionLocally(jobDesc, limit = UI_LIMITS.prompt.jobDescriptionChars) {
    const lines = String(jobDesc || '')
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return '';
    const priority = [];
    const secondary = [];
    lines.forEach((line) => {
      if (/^[-*?]/.test(line) || /(require|qualification|responsibil|skill|experience|about the role|what you'll do|what we are looking for)/i.test(line)) {
        priority.push(line);
      } else {
        secondary.push(line);
      }
    });
    const chosen = [...priority, ...secondary];
    let result = '';
    chosen.forEach((line) => {
      const next = result ? `${result}\n${line}` : line;
      if (next.length <= limit) result = next;
    });
    return result || String(jobDesc || '').slice(0, limit);
  }

  function compactAlignmentForPrompt(alignment) {
    const sections = Array.isArray(alignment?.sections) ? alignment.sections : [];
    return {
      overall_score: Number(alignment?.overall_score || 0),
      overall_verdict: String(alignment?.overall_verdict || ''),
      missing_from_cv: limitItems(alignment?.missing_from_cv || [], UI_LIMITS.prompt.alignmentMissing),
      strongest_matches: limitItems(alignment?.strongest_matches || [], UI_LIMITS.prompt.alignmentMatches),
      recommended_emphasis: limitItems(alignment?.recommended_emphasis || [], UI_LIMITS.prompt.alignmentEmphasis),
      sections: limitItems(sections, UI_LIMITS.prompt.alignmentSections).map((section) => ({
        name: section?.name || 'General',
        score: Number(section?.score || 0),
        matched_keywords: limitItems(section?.matched_keywords || [], UI_LIMITS.prompt.alignmentSectionKeywords),
        gaps: limitItems(section?.gaps || [], UI_LIMITS.prompt.alignmentSectionKeywords),
        suggestions: limitItems(section?.suggestions || [], UI_LIMITS.prompt.alignmentSectionSuggestions),
      })),
    };
  }

  function compactStoriesForPrompt(storiesArr, limit = UI_LIMITS.prompt.stories) {
    return limitItems(storiesArr || [], limit).map((story) => ({
      title: story?.title || '',
      tag: story?.tag || 'general',
      text: trunc(String(story?.text || ''), 260),
      preferred_bullet: trunc(String(story?.preferred_bullet || ''), 220),
      status: story?.status || 'grounded',
    }));
  }

  function compactReviewChangeSummary(changes, limit = UI_LIMITS.prompt.reviewChanges) {
    return limitItems(changes || [], limit).map((change) => ({
      section_name: change?.section_name || 'General',
      importance: change?.importance || 'optional',
      target_keywords: limitItems(change?.target_keywords || [], UI_LIMITS.prompt.reviewChangeKeywords),
      reason: trunc(String(change?.reason || ''), 180),
      original_excerpt: trunc(String(change?.original_text || ''), 180),
      edited_excerpt: trunc(String(change?.edited_text || ''), 180),
      trust_state: change?.validation?.hallucinated || change?.validation?.exact_match === false
        ? 'unsupported'
        : (change?.validation?.issues?.length ? 'review' : 'grounded'),
    }));
  }

  function buildMetricDelta(before = {}, after = {}) {
    const numericKeys = [
      'ats_score',
      'recruiter_readability_score',
      'critical_keyword_match',
      'preferred_keyword_match',
      'semantic_keyword_coverage',
      'quantified_impact',
      'section_completeness',
    ];
    const delta = {};
    numericKeys.forEach((key) => {
      delta[key] = {
        before: Number(before?.[key] || 0),
        after: Number(after?.[key] || 0),
        delta: Number(after?.[key] || 0) - Number(before?.[key] || 0),
      };
    });
    return delta;
  }

  function mergeTokenUsage(existingUsage, stage, usage) {
    const current = existingUsage && typeof existingUsage === 'object' ? existingUsage : {};
    const byStage = { ...(current.by_stage || {}) };
    const previous = byStage[stage] || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
    byStage[stage] = usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
    return {
      ...current,
      by_stage: byStage,
      total_prompt: Math.max(0, Number(current.total_prompt || 0) - Number(previous.prompt_tokens || 0) + Number(usage?.prompt_tokens || 0)),
      total_completion: Math.max(0, Number(current.total_completion || 0) - Number(previous.completion_tokens || 0) + Number(usage?.completion_tokens || 0)),
      total_tokens: Math.max(0, Number(current.total_tokens || 0) - Number(previous.total_tokens || 0) + Number(usage?.total_tokens || 0)),
    };
  }

  function sortNumericList(values = []) {
    return [...new Set((values || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b);
  }

  // ?? Pipeline (client-only mode) ????????????????????????????????????
  async function runPipelineClient(latex, jobDesc, storiesArr, onProgress, options = {}) {
    const tokenUsage = { total_prompt: 0, total_completion: 0, total_tokens: 0, by_stage: {} };
    function track(stage, u) {
      tokenUsage.by_stage[stage] = u;
      tokenUsage.total_prompt += u.prompt_tokens || 0;
      tokenUsage.total_completion += u.completion_tokens || 0;
      tokenUsage.total_tokens += u.total_tokens || 0;
    }
    const compactJob = compressJobDescriptionLocally(jobDesc);
    const compactStories = compactStoriesForPrompt(storiesArr, UI_LIMITS.prompt.stories);

    onProgress('parse', 'Parsing requirements...');
    const { data: parsedReq, usage: u1 } = await callOpenAIDirect(
      PROMPTS.parseSystem, `JOB POSTING:\n\`\`\`\n${compactJob}\n\`\`\``,
      { maxTokens: 1100, disableReasoning: true }
    );
    track('parse', u1);

    onProgress('analyze', 'Scoring alignment...');
    const { data: alignment, usage: u2 } = await callOpenAIDirect(
      PROMPTS.analyzeSystem,
      `JOB REQUIREMENTS:\n${JSON.stringify(parsedReq, null, 2)}\n\nCV:\n${latex}`,
      { maxTokens: 1800, disableReasoning: true }
    );
    track('analyze', u2);

    onProgress('replace', 'Generating exact replacements...');
    const replacementSource = buildReplacementSourceLocal(latex);
    const replacementInventory = buildReplacementInventoryPromptLocal(latex);
    const rewriteCoverage = normalizeRewriteCoverage(options.rewriteCoverage || getTailorRewriteCoverage());
    const replacePrompt = compactStories.length > 0
      ? `ALIGNMENT ANALYSIS:\n${JSON.stringify(compactAlignmentForPrompt(alignment), null, 2)}\n\nSELECTED VAULT EXPERIENCE:\n${compactStories.map((s, i) => `${i + 1}. [${s.tag || 'general'}] ${s.text}`).join('\n')}\n\nDESIRED REWRITE COVERAGE:\nEdit about ${Math.round(rewriteCoverage * 100)}% of \\item bullets, prioritizing the highest-value truthful rewrites.\n\nREWRITE INVENTORY:\n${JSON.stringify(replacementInventory, null, 2)}\n\nREPLACEABLE SOURCE (every line needs one output object in the same order):\n${replacementSource}`
      : `ALIGNMENT ANALYSIS:\n${JSON.stringify(compactAlignmentForPrompt(alignment), null, 2)}\n\nDESIRED REWRITE COVERAGE:\nEdit about ${Math.round(rewriteCoverage * 100)}% of \\item bullets, prioritizing the highest-value truthful rewrites.\n\nREWRITE INVENTORY:\n${JSON.stringify(replacementInventory, null, 2)}\n\nREPLACEABLE SOURCE (every line needs one output object in the same order):\n${replacementSource}`;
    const { data: replacementsRaw, usage: u3 } = await callOpenAIDirect(
      PROMPTS.replaceSystem,
      replacePrompt,
      { maxTokens: 1800, disableReasoning: true, temperature: 0.12 }
    );
    track('replace', u3);

    onProgress('verify', 'Applying verified replacements...');
    track('verify', { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 });
    let report = replacementsRaw || { changes: [] };
    if (typeof replacementsRaw === 'string') {
      try { report = parseStructuredJson(replacementsRaw) || JSON.parse(replacementsRaw); }
      catch { report = { summary: '', changes: [], risks: ['Model returned invalid JSON for replacements.'] }; }
    }
    report = normalizeReplacementReport(report, latex);
    report.rewrite_preferences = {
      rewrite_coverage: rewriteCoverage,
    };
    const editedLatex = applyReplacementChanges(latex, report.changes || []);

    onProgress('done', 'Complete');
    return { parsedReq, alignment, editedLatex, replacements: report, report, tokenUsage };
  }

  function splitCsv(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const SECTION_LIBRARY = [
    { key: 'summary', label: 'Summary', aliases: ['summary', 'profile', 'professional summary', 'objective'] },
    { key: 'experience', label: 'Experience', aliases: ['experience', 'professional experience', 'work experience'] },
    { key: 'projects', label: 'Projects', aliases: ['projects', 'project', 'selected projects'] },
    { key: 'skills', label: 'Skills', aliases: ['skills', 'technical skills', 'technologies'] },
    { key: 'education', label: 'Education', aliases: ['education'] },
    { key: 'leadership', label: 'Leadership', aliases: ['leadership', 'activities', 'service'] },
    { key: 'research', label: 'Research', aliases: ['research', 'publications'] },
    { key: 'awards', label: 'Awards', aliases: ['awards', 'honors', 'certifications'] },
  ];

  function normalizeSectionToken(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveSectionMeta(value) {
    const normalized = normalizeSectionToken(value);
    const match = SECTION_LIBRARY.find((entry) => {
      return entry.key === normalized || entry.aliases.some((alias) => normalizeSectionToken(alias) === normalized);
    });
    if (match) {
      return { key: match.key, label: match.label, raw: value || match.label };
    }
    if (!normalized) {
      return { key: 'experience', label: 'Experience', raw: 'Experience' };
    }
    return {
      key: normalized.replace(/\s+/g, '-'),
      label: String(value || normalized).trim(),
      raw: value || normalized,
    };
  }

  function extractProfileSections(latex) {
    const matches = Array.from(String(latex || '').matchAll(/\\section\*?\{([^}]*)\}/g));
    const seen = new Set();
    const sections = [];
    matches.forEach((match) => {
      const meta = resolveSectionMeta(match[1]);
      if (!meta.key || seen.has(meta.key)) return;
      seen.add(meta.key);
      sections.push(meta);
    });
    if (!sections.length) {
      ['summary', 'experience', 'projects', 'skills', 'education'].forEach((key) => {
        const meta = resolveSectionMeta(key);
        if (!seen.has(meta.key)) {
          seen.add(meta.key);
          sections.push(meta);
        }
      });
    }
    return sections;
  }

  function renderSectionOptionsMarkup(selectedHint = '', sections = SECTION_LIBRARY) {
    const normalizedSelected = resolveSectionMeta(selectedHint).key;
    const uniqueSections = [];
    const seen = new Set();
    (sections || []).forEach((section) => {
      const meta = resolveSectionMeta(section.label || section.key || section);
      if (seen.has(meta.key)) return;
      seen.add(meta.key);
      uniqueSections.push(meta);
    });
    return ['<option value="">Target section</option>']
      .concat(uniqueSections.map((section) => `
        <option value="${esc(section.key)}"${section.key === normalizedSelected ? ' selected' : ''}>${esc(section.label)}</option>
      `))
      .join('');
  }

  function itemSectionSignal(item) {
    return normalizeSectionToken(`${item.section_hint || ''} ${item.tag || ''} ${item.title || ''} ${item.text || ''} ${item.preferred_bullet || ''}`);
  }

  function inferVaultSection(item, sections) {
    const available = sections || [];
    const explicit = resolveSectionMeta(item.section_hint);
    if (item.section_hint) {
      const exact = available.find((section) => section.key === explicit.key);
      if (exact) return exact;
    }

    const signal = itemSectionSignal(item);
    const heuristics = [
      { key: 'education', pattern: /\b(university|bachelor|master|degree|coursework|gpa|education)\b/ },
      { key: 'skills', pattern: /\b(skill|python|javascript|typescript|java|aws|sql|react|docker|kubernetes|tool)\b/ },
      { key: 'projects', pattern: /\b(project|built|launched|prototype|portfolio|capstone|shipped)\b/ },
      { key: 'leadership', pattern: /\b(lead|led|mentor|managed|stakeholder|ownership|cross functional)\b/ },
      { key: 'research', pattern: /\b(research|publication|paper|study|experiment)\b/ },
      { key: 'awards', pattern: /\b(award|honor|certification|certified)\b/ },
      { key: 'summary', pattern: /\b(summary|profile|overview)\b/ },
      { key: 'experience', pattern: /\b(experience|role|team|delivery|impact|initiative)\b/ },
    ];
    const matched = heuristics.find((entry) => entry.pattern.test(signal));
    if (matched) {
      const section = available.find((entry) => entry.key === matched.key);
      if (section) return section;
    }

    return available.find((section) => section.key === 'experience')
      || available.find((section) => section.key === 'projects')
      || available[0]
      || resolveSectionMeta('experience');
  }

  function storyStatusClass(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'verified') return 'verified-fact';
    if (normalized === 'grounded') return 'grounded-suggestion';
    if (normalized === 'review') return 'needs-review';
    if (normalized === 'resume-ready') return 'resume-ready';
    return 'reusable';
  }

  function storyStatusLabel(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'verified') return 'Verified Fact';
    if (normalized === 'grounded') return 'Grounded Suggestion';
    if (normalized === 'review') return 'Needs Review';
    if (normalized === 'resume-ready') return 'Resume-Ready';
    return 'Reusable Item';
  }

  function normalizeStory(story, index = 0) {
    if (!story || typeof story !== 'object') {
      return {
        title: `Saved Experience ${index + 1}`,
        tag: 'general',
        section_hint: '',
        text: String(story || ''),
        status: 'grounded',
        preferred_bullet: '',
        created_at: '',
        updated_at: '',
      };
    }
    return {
      title: story.title || story.tag || `Saved Experience ${index + 1}`,
      tag: story.tag || 'general',
      section_hint: story.section_hint || '',
      text: story.text || '',
      status: story.status || 'grounded',
      preferred_bullet: story.preferred_bullet || '',
      created_at: story.created_at || '',
      updated_at: story.updated_at || '',
    };
  }

  function deserializeStories(storiesField) {
    const parsed = typeof storiesField === 'string' ? (parseJSON(storiesField) || []) : (storiesField || []);
    return (parsed || []).map((story, index) => normalizeStory(story, index));
  }

  function serializeStories(storiesArr) {
    return JSON.stringify((storiesArr || []).map((story, index) => normalizeStory(story, index)));
  }

  function buildVaultItemKey(profileId, vaultItemId) {
    return `${profileId}:${vaultItemId}`;
  }

  function buildVaultItems(vaultItems, profiles = [], sessions = []) {
    const profileNames = new Map((profiles || []).map((profile) => [Number(profile.id), profile.name]));
    const profileSections = new Map((profiles || []).map((profile) => [Number(profile.id), extractProfileSections(profile.latex || '')]));
    return (vaultItems || []).map((item, index) => {
      const key = buildVaultItemKey(item.profile_id, item.id || index);
      const referenceText = `${item.text || ''} ${item.preferred_bullet || ''}`.trim();
      const reuseCount = (sessions || []).filter((session) => {
        const haystack = `${session.edited_latex || session.editedLatex || ''} ${JSON.stringify(session.alignment || '')} ${JSON.stringify(session.report || session.replacements || '')}`;
        return referenceText && haystack.includes(referenceText.slice(0, Math.min(referenceText.length, 50)));
      }).length;
      return {
        id: item.id || index,
        key,
        profile_id: Number(item.profile_id),
        profile_name: item.profile_name || profileNames.get(Number(item.profile_id)) || 'Unknown Profile',
        profile_sections: profileSections.get(Number(item.profile_id)) || SECTION_LIBRARY,
        title: item.title || `Saved Experience ${index + 1}`,
        tag: item.tag || 'general',
        section_hint: item.section_hint || '',
        text: item.text || '',
        status: item.status || 'grounded',
        preferred_bullet: item.preferred_bullet || '',
        source: item.source || 'manual',
        reuse_count: reuseCount,
        created_at: item.created_at || '',
        updated_at: item.updated_at || '',
      };
    });
  }

  function tokenSet(text) {
    return new Set(String(text || '').toLowerCase().split(/[^a-z0-9+#/.-]+/).filter((token) => token.length > 2));
  }

  function scoreVaultItem(item, jobText, genre) {
    const itemTokens = tokenSet(`${item.title} ${item.tag} ${item.text} ${item.preferred_bullet}`);
    const jobTokens = tokenSet(jobText);
    const genreTokens = tokenSet(`${genre?.name || ''} ${(genre?.focus_tags || []).join(' ')} ${(genre?.preferred_signals || []).join(' ')}`);
    let score = 0;
    itemTokens.forEach((token) => {
      if (jobTokens.has(token)) score += 2;
      if (genreTokens.has(token)) score += 3;
    });
    if (genre && (genre.focus_tags || []).includes(item.tag)) score += 5;
    if (item.status === 'resume-ready') score += 4;
    if (item.status === 'verified') score += 3;
    return score;
  }

  function buildTailorSelectionContextKey(profile, genre, strictness, jobId, job) {
    const draftKey = [job?.company || '', job?.title || ''].map((part) => String(part || '').trim().toLowerCase()).join('|');
    return [
      Number(profile?.id || 0),
      Number(genre?.id || 0),
      String(strictness || 'balanced').toLowerCase(),
      jobId ? `job:${jobId}` : `draft:${draftKey}`,
    ].join(':');
  }

  function hydrateStoriesFromVaultItems(items) {
    return (items || []).map((item) => ({
      id: Number(item.id),
      title: item.title,
      tag: item.tag,
      section_hint: item.section_hint || '',
      text: item.text,
      status: item.status,
      preferred_bullet: item.preferred_bullet,
    }));
  }

  function buildVaultSectionPlan(profile, vaultItems, jobText, genre, limitPerSection = UI_LIMITS.tailor.sectionItemsPerSection) {
    const sections = extractProfileSections(profile?.latex || '');
    const scoredItems = (vaultItems || [])
      .map((item) => {
        const targetSection = inferVaultSection(item, sections);
        const matchScore = scoreVaultItem(item, jobText, genre);
        return {
          ...item,
          target_section_key: targetSection.key,
          target_section_label: targetSection.label,
          match_score: matchScore,
        };
      })
      .sort((a, b) => {
        return b.match_score - a.match_score
          || b.reuse_count - a.reuse_count
          || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      });

    const groups = sections.map((section) => {
      const items = scoredItems
        .filter((item) => item.target_section_key === section.key)
        .filter((item) => item.match_score > 0 || item.status === 'resume-ready' || item.status === 'verified')
        .slice(0, limitPerSection);
      return {
        key: section.key,
        label: section.label,
        items,
      };
    });

    const recommendedItems = groups
      .flatMap((group) => limitItems(group.items, 1))
      .slice(0, UI_LIMITS.tailor.recommendedItems);

    return {
      sections,
      groups,
      recommendedItems,
      recommendedIds: recommendedItems.map((item) => Number(item.id)),
      topMatches: scoredItems.filter((item) => item.match_score > 0).slice(0, UI_LIMITS.tailor.topVaultMatches),
    };
  }

  function matchVaultItems(vaultItems, jobText, genre, limit = UI_LIMITS.tailor.quickVaultMatches) {
    return (vaultItems || [])
      .map((item) => ({ ...item, match_score: scoreVaultItem(item, jobText, genre) }))
      .filter((item) => item.match_score > 0)
      .sort((a, b) => b.match_score - a.match_score || b.reuse_count - a.reuse_count)
      .slice(0, limit);
  }

  function normalizeGenre(genre) {
    if (!genre) return null;
    return {
      ...genre,
      focus_tags: typeof genre.focus_tags === 'string' ? (parseJSON(genre.focus_tags) || []) : (genre.focus_tags || []),
      preferred_signals: typeof genre.preferred_signals === 'string' ? (parseJSON(genre.preferred_signals) || []) : (genre.preferred_signals || []),
      de_emphasized_signals: typeof genre.de_emphasized_signals === 'string' ? (parseJSON(genre.de_emphasized_signals) || []) : (genre.de_emphasized_signals || []),
    };
  }

  function buildGenreSuggestions(vaultItems) {
    const tagCounts = new Map();
    (vaultItems || []).forEach((item) => {
      const tag = String(item.tag || '').trim().toLowerCase();
      if (!tag) return;
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    });

    const templates = [
      { name: 'ML / AI Engineering', tags: ['ml', 'ai', 'llm', 'model', 'nlp'], preferred: ['experimentation', 'metrics', 'deployment'] },
      { name: 'Backend Engineering', tags: ['backend', 'api', 'platform', 'cloud', 'infra'], preferred: ['reliability', 'scale', 'services'] },
      { name: 'Technical Leadership', tags: ['leadership', 'mentoring', 'manager', 'strategy'], preferred: ['cross-functional', 'mentoring', 'ownership'] },
      { name: 'Data / Analytics', tags: ['data', 'analytics', 'sql', 'reporting'], preferred: ['dashboards', 'experimentation', 'insight'] },
      { name: 'Product / Strategy', tags: ['product', 'growth', 'strategy', 'stakeholder'], preferred: ['prioritization', 'impact', 'alignment'] },
    ];

    return templates
      .map((template) => {
        const strength = template.tags.reduce((sum, tag) => sum + (tagCounts.get(tag) || 0), 0);
        return strength > 0 ? {
          ...template,
          focus_tags: template.tags.filter((tag) => tagCounts.has(tag)),
          strength,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, UI_LIMITS.tailor.genreSuggestions);
  }

  function getRunContext(profile, genre, strictness, jobText, vaultItems, options = {}) {
    const sectionPlan = buildVaultSectionPlan(profile, vaultItems, jobText, genre, UI_LIMITS.tailor.sectionItemsPerSection);
    const likely = sectionPlan.topMatches.slice(0, UI_LIMITS.tailor.quickVaultMatches);
    const preferredIds = new Set((options.selected_vault_ids || []).map((id) => Number(id)));
    const selectedItems = preferredIds.size
      ? (vaultItems || []).filter((item) => preferredIds.has(Number(item.id)))
      : sectionPlan.recommendedItems;
    const selectedStories = hydrateStoriesFromVaultItems(selectedItems);
    const unsupportedRisk = strictness === 'strategic' ? 'Elevated' : (strictness === 'safe' ? 'Low' : 'Moderate');
    return {
      likely,
      selectedItems,
      selectedStories,
      unsupportedRisk,
      sectionPlan,
      selectedCount: selectedItems.length,
    };
  }

  function jobSourceLabel(source) {
    const normalized = String(source || 'manual').trim().toLowerCase();
    if (!normalized || normalized === 'manual') return 'Manual';
    return normalized.split(/[^a-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
  }

  function countImportedJobs(jobs) {
    return (jobs || []).filter((job) => String(job.source || '').trim() && String(job.source || '').trim() !== 'manual').length;
  }

  function normalizeBatchQueueState(rawState) {
    if (!rawState || typeof rawState !== 'object') return null;
    const items = Array.isArray(rawState.items) ? rawState.items : [];
    return {
      ...rawState,
      rewrite_coverage: normalizeRewriteCoverage(rawState.rewrite_coverage),
      selected_vault_ids: Array.isArray(rawState.selected_vault_ids) ? rawState.selected_vault_ids.map((id) => Number(id)) : [],
      items: items.map((item) => ({
        ...item,
        status: item?.status === 'running' ? 'pending' : (item?.status || 'pending'),
      })),
      updated_at: rawState.updated_at || new Date().toISOString(),
    };
  }

  function loadBatchQueueState() {
    const raw = localStorage.getItem(BATCH_QUEUE_STORAGE_KEY);
    const parsed = parseJSON(raw);
    batchQueueState = normalizeBatchQueueState(parsed);
    if (!batchQueueState) {
      localStorage.removeItem(BATCH_QUEUE_STORAGE_KEY);
    }
    return batchQueueState;
  }

  function saveBatchQueueState() {
    if (!batchQueueState) {
      localStorage.removeItem(BATCH_QUEUE_STORAGE_KEY);
      return;
    }
    batchQueueState.updated_at = new Date().toISOString();
    localStorage.setItem(BATCH_QUEUE_STORAGE_KEY, JSON.stringify(batchQueueState));
  }

  function clearBatchQueueState() {
    batchQueueState = null;
    batchQueueRunning = false;
    localStorage.removeItem(BATCH_QUEUE_STORAGE_KEY);
  }

  function formatJobOption(job) {
    const parts = [`${job.title || 'Untitled role'} @ ${job.company || 'Unknown company'}`];
    if (job.location) parts.push(job.location);
    if (job.source && job.source !== 'manual') parts.push(jobSourceLabel(job.source));
    return parts.join(' ? ');
  }

  function normalizeJobLines(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value.split(/\r?\n+/).map((entry) => entry.trim()).filter(Boolean);
    }
    return [];
  }

  function normalizeJobTextBlock(value) {
    return typeof value === 'string'
      ? value.replace(/\r\n/g, '\n').trim()
      : '';
  }

  function buildImportedJobDescription(job) {
    const parts = [];
    const jobInfo = normalizeJobTextBlock(job.jobInfo);
    const description = normalizeJobTextBlock(job.description);
    const summary = String(job.summary || '').trim();
    const location = String(job.location || '').trim();
    const qualifications = normalizeJobLines(job.qualifications);
    const responsibilities = normalizeJobLines(job.responsibilities);

    if (jobInfo) {
      parts.push(jobInfo);
    } else {
      if (summary) parts.push(summary);
      if (location) parts.push(`Location: ${location}`);
      if (qualifications.length) {
        parts.push(`Qualifications:
${qualifications.map((line) => `- ${line}`).join('\n')}`);
      }
      if (responsibilities.length) {
        parts.push(`Responsibilities:
${responsibilities.map((line) => `- ${line}`).join('\n')}`);
      }
    }

    if (!parts.length && description) {
      parts.push(description);
    }

    return parts.join('\n\n').trim();
  }

  function normalizeCaptureMetaInput(job) {
    const directMeta = parseJSON(job && job.captureMeta) || {};
    const storedMeta = parseJSON(job && job.capture_meta) || {};
    return { ...storedMeta, ...directMeta };
  }

  function normalizeCapturedJob(job) {
    const sourceUrl = String(job.sourceUrl || job.url || '').trim();
    const captureMeta = normalizeCaptureMetaInput(job);
    return {
      title: String(job.title || '').trim(),
      company: String(job.company || '').trim(),
      location: String(job.location || '').trim(),
      url: sourceUrl,
      sourceUrl,
      source: String(job.site || job.source || 'manual').trim().toLowerCase() || 'manual',
      description: buildImportedJobDescription(job) || normalizeJobTextBlock(job.description),
      capture_meta: {
        ...captureMeta,
        jobInfo: normalizeJobTextBlock(job.jobInfo),
        summary: String(job.summary || '').trim(),
        qualifications: normalizeJobLines(job.qualifications),
        responsibilities: normalizeJobLines(job.responsibilities),
        sourceMode: String(job.sourceMode || '').trim(),
        confidence: Number(job.confidence || 0),
        status: String(job.status || '').trim() || 'pending',
        sourcePageTitle: String(job.sourcePageTitle || '').trim(),
        pageUrl: String(job.pageUrl || '').trim(),
        sourceSignals: parseJSON(job && job.sourceSignals) || job.sourceSignals || captureMeta.sourceSignals || {},
        employmentType: String(job.employmentType || captureMeta.employmentType || '').trim(),
        workplaceType: String(job.workplaceType || captureMeta.workplaceType || '').trim(),
        salary: String(job.salary || captureMeta.salary || '').trim(),
        datePosted: String(job.datePosted || captureMeta.datePosted || '').trim(),
        validThrough: String(job.validThrough || captureMeta.validThrough || '').trim(),
      },
    };
  }

  function readTailorJobDraft() {
    return {
      company: document.getElementById('newJobCompany')?.value.trim() || '',
      title: document.getElementById('newJobTitle')?.value.trim() || '',
      description: document.getElementById('newJobDesc')?.value.trim() || '',
      url: document.getElementById('newJobUrl')?.value.trim() || '',
    };
  }

  function writeTailorJobDraft(draft = {}) {
    if (document.getElementById('newJobCompany')) document.getElementById('newJobCompany').value = draft.company || '';
    if (document.getElementById('newJobTitle')) document.getElementById('newJobTitle').value = draft.title || '';
    if (document.getElementById('newJobDesc')) document.getElementById('newJobDesc').value = draft.description || '';
    if (document.getElementById('newJobUrl')) document.getElementById('newJobUrl').value = draft.url || '';
  }

  function syncTailorJobDraftFromSelection(jobs) {
    const selectedJobId = Number(document.getElementById('tailorJob')?.value || 0);
    if (!selectedJobId) {
      if (lastSelectedTailorJobId) {
        writeTailorJobDraft(manualTailorJobDraft);
        lastSelectedTailorJobId = 0;
      }
      return;
    }

    const selectedJob = (jobs || []).find((job) => Number(job.id) === selectedJobId);
    if (!selectedJob) return;
    if (!lastSelectedTailorJobId) {
      manualTailorJobDraft = readTailorJobDraft();
    }
    writeTailorJobDraft({
      company: selectedJob.company || '',
      title: selectedJob.title || '',
      description: selectedJob.description || '',
      url: selectedJob.url || '',
    });
    lastSelectedTailorJobId = selectedJobId;
  }

  function rememberTailorManualDraft() {
    if (document.getElementById('tailorJob')?.value) return;
    manualTailorJobDraft = readTailorJobDraft();
  }

  // ?? Unified Data Layer ?????????????????????????????????????????????
  const Store = {
    async getProfiles() {
      if (serverMode) return apiFetch('/profiles');
      return (await idbAll('profiles')).sort((a, b) => (b.id || 0) - (a.id || 0));
    },
    async getProfile(id) {
      if (serverMode) return apiFetch(`/profiles/${id}`);
      return idbGet('profiles', id);
    },
    async saveProfile(p) {
      if (serverMode) {
        if (p.id) { await apiFetch(`/profiles/${p.id}`, { method: 'PUT', body: JSON.stringify(p) }); return p; }
        return apiFetch('/profiles', { method: 'POST', body: JSON.stringify(p) });
      }
      p.created_at = p.created_at || new Date().toISOString();
      p.updated_at = new Date().toISOString();
      const id = await idbPut('profiles', p);
      return { ...p, id: p.id || id };
    },
    async deleteProfile(id) {
      if (serverMode) return apiFetch(`/profiles/${id}`, { method: 'DELETE' });
      return idbDelete('profiles', id);
    },
    async getVaultItems() {
      if (serverMode) return apiFetch('/vault-items');
      return (await idbAll('vault_items')).sort((a, b) => {
        return String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || ((b.id || 0) - (a.id || 0));
      });
    },
    async getVaultItem(id) {
      if (serverMode) return apiFetch(`/vault-items/${id}`);
      return idbGet('vault_items', id);
    },
    async saveVaultItem(item) {
      const payload = {
        ...item,
        profile_id: Number(item.profile_id),
        title: item.title || 'Saved Experience',
        tag: item.tag || 'general',
        section_hint: item.section_hint || '',
        status: item.status || 'grounded',
        text: item.text || '',
        preferred_bullet: item.preferred_bullet || '',
        source: item.source || 'manual',
      };
      if (serverMode) {
        if (payload.id) {
          await apiFetch(`/vault-items/${payload.id}`, { method: 'PUT', body: JSON.stringify(payload) });
          return payload;
        }
        return apiFetch('/vault-items', { method: 'POST', body: JSON.stringify(payload) });
      }
      payload.created_at = payload.created_at || new Date().toISOString();
      payload.updated_at = new Date().toISOString();
      const id = await idbPut('vault_items', payload);
      return { ...payload, id: payload.id || id };
    },
    async deleteVaultItem(id) {
      if (serverMode) return apiFetch(`/vault-items/${id}`, { method: 'DELETE' });
      return idbDelete('vault_items', id);
    },
    async getJobs() {
      if (serverMode) return apiFetch('/jobs');
      return (await idbAll('jobs')).sort((a, b) => (b.id || 0) - (a.id || 0));
    },
    async saveJob(j) {
      if (serverMode) return apiFetch('/jobs', { method: 'POST', body: JSON.stringify(j) });
      j.source = j.source || 'manual';
      j.location = j.location || '';
      j.capture_meta = j.capture_meta || {};
      j.created_at = new Date().toISOString();
      j.updated_at = new Date().toISOString();
      const id = await idbPut('jobs', j);
      return { ...j, id: j.id || id };
    },
    async importJobs(rawJobs = []) {
      const jobs = (rawJobs || []).map(normalizeCapturedJob).filter((job) => job.title && job.company && job.description);
      if (!jobs.length) {
        throw new Error('No valid captured jobs found in the provided JSON');
      }
      if (serverMode) {
        return apiFetch('/jobs/import-batch', {
          method: 'POST',
          body: JSON.stringify({ jobs }),
        });
      }

      const existingJobs = await this.getJobs();
      let created = 0;
      let updated = 0;

      for (const job of jobs) {
        const existing = existingJobs.find((candidate) => {
          if (job.url && candidate.url && candidate.url === job.url) return true;
          return candidate.company === job.company && candidate.title === job.title;
        });
        const payload = existing
          ? {
              ...existing,
              ...job,
              id: existing.id,
              created_at: existing.created_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : {
              ...job,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
        await idbPut('jobs', payload);
        if (existing) updated += 1;
        else created += 1;
      }

      return {
        imported: jobs.length,
        created,
        updated,
      };
    },
    async deleteJob(id) {
      if (serverMode) return apiFetch(`/jobs/${id}`, { method: 'DELETE' });
      return idbDelete('jobs', id);
    },
    async getGenres() {
      if (serverMode) return apiFetch('/genres');
      return (await idbAll('genres')).sort((a, b) => (b.id || 0) - (a.id || 0));
    },
    async getGenre(id) {
      if (serverMode) return apiFetch(`/genres/${id}`);
      return idbGet('genres', id);
    },
    async saveGenre(genre) {
      const payload = {
        ...genre,
        focus_tags: genre.focus_tags || [],
        preferred_signals: genre.preferred_signals || [],
        de_emphasized_signals: genre.de_emphasized_signals || [],
      };
      if (serverMode) {
        if (payload.id) {
          await apiFetch(`/genres/${payload.id}`, { method: 'PUT', body: JSON.stringify(payload) });
          return payload;
        }
        return apiFetch('/genres', { method: 'POST', body: JSON.stringify(payload) });
      }
      payload.created_at = payload.created_at || new Date().toISOString();
      payload.updated_at = new Date().toISOString();
      const id = await idbPut('genres', payload);
      return { ...payload, id: payload.id || id };
    },
    async deleteGenre(id) {
      if (serverMode) return apiFetch(`/genres/${id}`, { method: 'DELETE' });
      return idbDelete('genres', id);
    },
    async getSessions() {
      if (serverMode) return apiFetch('/sessions');
      return (await idbAll('sessions')).sort((a, b) => (b.id || 0) - (a.id || 0));
    },
    async getSession(id) {
      if (serverMode) {
        const s = await apiFetch(`/sessions/${id}`);
        return s;
      }
      return idbGet('sessions', id);
    },
    async updateSessionOutcome(id, outcome) {
      if (serverMode) {
        return apiFetch(`/sessions/${id}/outcome`, {
          method: 'PUT',
          body: JSON.stringify({ outcome }),
        });
      }
      const session = await idbGet('sessions', Number(id));
      if (!session) throw new Error('Session not found');
      session.outcome = outcome;
      session.outcome_updated_at = new Date().toISOString();
      session.updated_at = new Date().toISOString();
      await idbPut('sessions', session);
      return { outcome };
    },
    async reviewAppliedDraft(session, options = {}) {
      const sessionId = Number(session?.id || session?.session_id || 0);
      const report = parseJSON(session?.report || session?.replacements) || {};
      const alignment = parseJSON(session?.alignment) || {};
      const parsedReq = parseJSON(session?.parsed_req || session?.parsedReq) || {};
      const profile = session?.profile_id ? await this.getProfile(Number(session.profile_id)) : null;
      const originalLatex = String(options.original_latex || session?.original_latex || profile?.latex || '');
      const editedLatex = String(options.edited_latex || session?.edited_latex || session?.editedLatex || session?.generated_latex || '');
      const acceptedIndices = sortNumericList(options.accepted_indices || []);
      const rejectedIndices = sortNumericList(options.rejected_indices || []);

      if (!originalLatex || !editedLatex) {
        throw new Error('Original and edited LaTeX are required before review');
      }

      if (serverMode && sessionId) {
        return apiFetch(`/sessions/${sessionId}/review-applied`, {
          method: 'POST',
          body: JSON.stringify({
            original_latex: originalLatex,
            edited_latex: editedLatex,
            accepted_indices: acceptedIndices,
            rejected_indices: rejectedIndices,
            report,
          }),
        });
      }

      const changes = Array.isArray(report?.changes) ? report.changes : [];
      const acceptedSet = new Set(acceptedIndices);
      const rejectedSet = new Set(rejectedIndices);
      const acceptedChanges = changes.filter((change, index) => acceptedSet.has(index) && isMaterialChange(change));
      const keptOriginalChanges = changes.filter((change, index) => rejectedSet.has(index) && isMaterialChange(change));
      const pendingChanges = changes.filter((change, index) => !acceptedSet.has(index) && !rejectedSet.has(index) && isMaterialChange(change));
      const beforeMetrics = report?.metrics?.before || { available: false, note: 'ATS metrics unavailable in client-only mode.' };
      const afterMetrics = { available: false, note: 'Accepted-draft ATS metrics require the local server runtime.' };
      const userChoices = {
        accepted_count: acceptedChanges.length,
        kept_original_count: keptOriginalChanges.length,
        pending_count: pendingChanges.length,
        accepted_changes: compactReviewChangeSummary(acceptedChanges, UI_LIMITS.prompt.reviewChanges),
        kept_original_changes: compactReviewChangeSummary(keptOriginalChanges, UI_LIMITS.prompt.reviewRejectedChanges),
        pending_changes: compactReviewChangeSummary(pendingChanges, UI_LIMITS.prompt.reviewRejectedChanges),
      };

      const reviewPrompt = [
        `JOB REQUIREMENTS:\n${JSON.stringify(parsedReq, null, 2)}`,
        `RUN CONTEXT:\n${JSON.stringify({
          genre_name: session?.genre_name || '',
          strictness: session?.strictness || 'balanced',
          company: session?.company || '',
          title: session?.job_title || '',
        }, null, 2)}`,
        `ORIGINAL ALIGNMENT:\n${JSON.stringify(compactAlignmentForPrompt(alignment), null, 2)}`,
        `ORIGINAL METRICS:\n${JSON.stringify(beforeMetrics, null, 2)}`,
        `ACCEPTED DRAFT METRICS:\n${JSON.stringify(afterMetrics, null, 2)}`,
        `USER CHOICES:\n${JSON.stringify(userChoices, null, 2)}`,
        `ORIGINAL CV:\n${originalLatex}`,
        `ACCEPTED CV:\n${editedLatex}`,
      ].join('\n\n');

      const reviewResult = await callOpenAIDirect(
        PROMPTS.reviewAppliedSystem,
        reviewPrompt,
        { maxTokens: 1500, disableReasoning: false }
      );

      const modelReview = typeof reviewResult.data === 'string'
        ? (parseStructuredJson(reviewResult.data) || {
          verdict: 'mixed',
          headline: 'Review generated',
          summary: trunc(reviewResult.data, 280),
          metric_interpretation: 'ATS metrics are unavailable in client-only mode, so this review is qualitative.',
          wins: [],
          regressions: [],
          still_missing: [],
          next_actions: [],
          review_readiness: {
            status: 'review_first',
            reason: 'Review was generated without structured ATS metrics.',
          },
        })
        : reviewResult.data;

      const tokenUsage = mergeTokenUsage(parseJSON(session?.token_usage || session?.tokenUsage) || {}, 'review_applied', reviewResult.usage || {});
      const appliedReview = {
        reviewed_at: new Date().toISOString(),
        stale: false,
        accepted_indices: acceptedIndices,
        rejected_indices: rejectedIndices,
        edited_latex: editedLatex,
        selection_summary: userChoices,
        metrics: {
          before: beforeMetrics,
          after: afterMetrics,
          suggested_after: report?.metrics?.after || null,
          delta: {},
          keyword_analysis: report?.metrics?.keyword_analysis || {},
        },
        after_alignment: null,
        model_review: modelReview,
      };

      const nextReport = {
        ...report,
        applied_review: appliedReview,
      };
      const nextSession = {
        ...session,
        edited_latex: editedLatex,
        editedLatex: editedLatex,
        report: nextReport,
        token_usage: tokenUsage,
        updated_at: new Date().toISOString(),
      };
      await this.saveSession(nextSession);
      return {
        session_id: sessionId || nextSession.id || 0,
        edited_latex: editedLatex,
        applied_review: appliedReview,
        report: nextReport,
        token_usage: tokenUsage,
      };
    },
    async saveSession(s) {
      s.created_at = s.created_at || new Date().toISOString();
      s.updated_at = new Date().toISOString();
      if (serverMode) {
        // Sessions are saved by the server during tailoring
        return s;
      }
      const id = await idbPut('sessions', s);
      return { ...s, id: s.id || id };
    },
    async tailor(profileId, jobId, options = {}) {
      const profile = await this.getProfile(Number(profileId));
      const job = serverMode ? await apiFetch(`/jobs/${jobId}`) : await idbGet('jobs', Number(jobId));
      const genres = (await this.getGenres()).map(normalizeGenre);
      const genre = normalizeGenre(genres.find((item) => Number(item.id) === Number(options.genre_id)));
      const strictness = options.strictness || 'balanced';
      const rewriteCoverage = normalizeRewriteCoverage(options.rewrite_coverage || getTailorRewriteCoverage());
      const allVaultItems = await this.getVaultItems();
      const vaultItems = buildVaultItems(allVaultItems, [profile], await this.getSessions())
        .filter((item) => Number(item.profile_id) === Number(profile.id));
      const runContext = getRunContext(profile, genre, strictness, job.description, vaultItems, {
        selected_vault_ids: options.selected_vault_ids || [],
      });
      const selectedStories = Array.isArray(options.stories_override) && options.stories_override.length
        ? options.stories_override
        : runContext.selectedStories;

      if (serverMode) {
        const result = await apiFetch('/tailor', {
          method: 'POST',
          body: JSON.stringify({
            profile_id: Number(profileId),
            job_id: Number(jobId),
            genre_id: genre?.id || null,
            genre_name: genre?.name || '',
            strictness,
            rewrite_coverage: rewriteCoverage,
            stories_override: selectedStories,
          }),
        });
        return {
          ...result,
          id: result.id || result.session_id,
          profile_id: Number(profileId),
          job_id: Number(jobId),
          company: job.company,
          job_title: job.title,
          profile_name: profile.name,
          genre_name: result.genre_name || genre?.name || '',
          strictness: result.strictness || strictness,
          rewrite_coverage: result.rewrite_coverage || rewriteCoverage,
          outcome: result.outcome || '',
        };
      }
      // Client-only mode
      const result = await runPipelineClient(profile.latex, job.description, selectedStories, updatePipelineUI, {
        rewriteCoverage,
      });
      const session = {
        profile_id: Number(profileId), job_id: Number(jobId),
        profile_name: profile.name, company: job.company, job_title: job.title,
        status: 'complete',
        genre_name: genre?.name || '',
        strictness,
        rewrite_coverage: rewriteCoverage,
        outcome: '',
        parsed_req: result.parsedReq, alignment: result.alignment,
        edited_latex: result.editedLatex, report: result.replacements || result.report,
        token_usage: result.tokenUsage,
      };
      const saved = await this.saveSession(session);
      return {
        id: saved.id || saved,
        session_id: saved.id || saved,
        ...result,
        company: job.company,
        job_title: job.title,
        genre_name: genre?.name || '',
        strictness,
        rewrite_coverage: rewriteCoverage,
        outcome: '',
      };
    },
  };

  // ?? Toast ??????????????????????????????????????????????????????????
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  function startPipelineTimer() {
    stopPipelineTimer();
    pipelineStartedAt = Date.now();
    const el = document.getElementById('pipelineElapsed');
    if (!el) return;
    el.style.display = 'inline-flex';
    el.textContent = 'Elapsed: 0.0s';
    pipelineTimer = setInterval(() => {
      el.textContent = `Elapsed: ${((Date.now() - pipelineStartedAt) / 1000).toFixed(1)}s`;
    }, PIPELINE_TIMER_INTERVAL_MS);
  }

  function stopPipelineTimer(finalMs) {
    if (pipelineTimer) {
      clearInterval(pipelineTimer);
      pipelineTimer = null;
    }
    const el = document.getElementById('pipelineElapsed');
    if (!el) return;
    if (finalMs != null) {
      el.style.display = 'inline-flex';
      el.textContent = `Elapsed: ${(finalMs / 1000).toFixed(1)}s`;
    } else {
      el.style.display = 'none';
    }
  }

  // ?? Navigation ?????????????????????????????????????????????????????
  window.navigate = function (view) {
    currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');
    const navBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (navBtn) navBtn.classList.add('active');
    if (view === 'dashboard') loadDashboard();
    if (view === 'tailor') loadTailorView();
    if (view === 'interviewtool') loadInterviewTool().catch((err) => toast(err.message, 'error'));
    if (view === 'vault') loadVault();
    if (view === 'genres') loadGenres();
    if (view === 'profiles') loadProfiles();
    if (view === 'history') loadHistory();
    if (view === 'results' && currentSession) {
      renderResults(currentSession).catch((err) => toast(err.message, 'error'));
    }
    if (canPollBridgeMonitor()) {
      pollBridgeImports({ seedOnly: false, announce: false }).catch(() => {});
    }
  };

  function getCoverLetterGuidance() {
    return localStorage.getItem(COVER_LETTER_GUIDANCE_KEY) || '';
  }

  function normalizeRewriteCoverage(value) {
    const numeric = Number(value || 0.7);
    const snapped = [0.6, 0.7, 0.8].find((candidate) => Math.abs(candidate - numeric) < 0.001);
    return snapped || 0.7;
  }

  function getTailorRewriteCoverage() {
    return normalizeRewriteCoverage(localStorage.getItem(REWRITE_COVERAGE_STORAGE_KEY) || 0.7);
  }

  function getCoverLetterTemplateSettings() {
    const parsed = parseJSON(localStorage.getItem(COVER_LETTER_SETTINGS_KEY)) || {};
    return {
      ...DEFAULT_COVER_LETTER_SETTINGS,
      ...parsed,
    };
  }

  function persistCoverLetterTemplateSettings(settings = {}) {
    localStorage.setItem(COVER_LETTER_SETTINGS_KEY, JSON.stringify({
      ...DEFAULT_COVER_LETTER_SETTINGS,
      ...settings,
    }));
  }

  function sanitizeCoverLetterAssetFilename(value = '', fallback = 'signature-upload.png') {
    const source = String(value || '').trim() || fallback;
    const filename = source.split(/[\\/]/).pop() || fallback;
    return filename.replace(/[^a-zA-Z0-9._-]+/g, '_') || fallback;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read the uploaded signature image.'));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToBlob(dataUrl = '') {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?;base64,(.+)$/);
    if (!match) return null;
    const mime = match[1] || 'application/octet-stream';
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mime });
  }

  function updateCoverLetterSignatureStatus(settings = getCoverLetterTemplateSettings()) {
    const status = document.getElementById('coverLetterSignatureStatus');
    if (!status) return;
    if (settings.signature_image_data_url) {
      status.textContent = `Uploaded signature ready: ${settings.signature_image_name || 'signature-upload.png'}. The upload is used for local cover-letter compile and overrides the manual path below.`;
      return;
    }
    if (settings.signature_image_path) {
      status.textContent = 'Using the manual image path in the generated LaTeX. Leave it blank if you only want a typed signature.';
      return;
    }
    status.textContent = 'No signature image selected. Leave both options blank to keep the typed signature only.';
  }

  function populateCoverLetterSettingsFields() {
    const settings = getCoverLetterTemplateSettings();
    const fieldMap = {
      coverLetterSenderName: 'sender_name',
      coverLetterSenderEmail: 'sender_email',
      coverLetterSenderPhone: 'sender_phone',
      coverLetterSenderLinkedInUrl: 'sender_linkedin_url',
      coverLetterSenderLinkedInLabel: 'sender_linkedin_label',
      coverLetterSenderLocation: 'sender_location',
      coverLetterRecipientName: 'recipient_name',
      coverLetterRecipientLocation: 'recipient_location',
      coverLetterSignaturePath: 'signature_image_path',
    };

    Object.entries(fieldMap).forEach(([elementId, key]) => {
      const element = document.getElementById(elementId);
      if (element) element.value = settings[key] || '';
    });

    const guidanceEl = document.getElementById('coverLetterGuidance');
    if (guidanceEl) guidanceEl.value = getCoverLetterGuidance();
    updateCoverLetterSignatureStatus(settings);
  }

  function collectCoverLetterTemplateSettings() {
    const existing = getCoverLetterTemplateSettings();
    const settings = {
      ...existing,
      sender_name: document.getElementById('coverLetterSenderName')?.value.trim() || DEFAULT_COVER_LETTER_SETTINGS.sender_name,
      sender_email: document.getElementById('coverLetterSenderEmail')?.value.trim() || '',
      sender_phone: document.getElementById('coverLetterSenderPhone')?.value.trim() || '',
      sender_linkedin_url: document.getElementById('coverLetterSenderLinkedInUrl')?.value.trim() || '',
      sender_linkedin_label: document.getElementById('coverLetterSenderLinkedInLabel')?.value.trim() || '',
      sender_location: document.getElementById('coverLetterSenderLocation')?.value.trim() || '',
      recipient_name: document.getElementById('coverLetterRecipientName')?.value.trim() || DEFAULT_COVER_LETTER_SETTINGS.recipient_name,
      recipient_location: document.getElementById('coverLetterRecipientLocation')?.value.trim() || '',
      signature_image_path: document.getElementById('coverLetterSignaturePath')?.value.trim() || '',
      closing: DEFAULT_COVER_LETTER_SETTINGS.closing,
    };
    persistCoverLetterTemplateSettings(settings);
    updateCoverLetterSignatureStatus(settings);
    return settings;
  }

  function escapeLatexForTemplate(value = '') {
    return String(value || '')
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/([#$%&_{}])/g, '\\$1')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function escapeLatexUrl(value = '') {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/([%#&_{}])/g, '\\$1')
      .trim();
  }

  function buildCoverLetterSignatureAssetLocal(settings = {}) {
    if (settings.signature_image_data_url) {
      const filename = sanitizeCoverLetterAssetFilename(settings.signature_image_name || 'signature-upload.png');
      return {
        latexPath: filename,
        assets: [{ filename, data_url: settings.signature_image_data_url }],
      };
    }
    if (settings.signature_image_path) {
      return {
        latexPath: String(settings.signature_image_path).trim().replace(/\\/g, '/'),
        assets: [],
      };
    }
    return { latexPath: '', assets: [] };
  }

  function normalizeCoverLetterPayload(payload) {
    const bodyLatex = Array.isArray(payload?.body_latex)
      ? payload.body_latex.map((paragraph) => String(paragraph || '').trim()).filter(Boolean)
      : String(payload?.body_latex || '')
        .split(/\r?\n\s*\r?\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);
    const paragraphs = Array.isArray(payload?.paragraphs)
      ? payload.paragraphs.map((paragraph) => String(paragraph || '').trim()).filter(Boolean)
      : String(payload?.body || payload?.text || payload || '')
        .split(/\r?\n\s*\r?\n/)
        .map((paragraph) => paragraph.replace(/\r?\n/g, ' ').trim())
        .filter(Boolean);
    const plainParagraphs = bodyLatex.length
      ? bodyLatex
        .map((paragraph) => String(paragraph || '')
          .replace(/\\\\/g, '\n')
          .replace(/\\(?:textbf|textit|emph|underline)\{([^}]*)\}/g, '$1')
          .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
          .replace(/\\[a-zA-Z@]+(?:\[[^\]]*\])?\{([^}]*)\}/g, '$1')
          .replace(/\\[a-zA-Z@]+/g, ' ')
          .replace(/[{}]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim())
        .filter(Boolean)
      : paragraphs;
    return {
      paragraphs: plainParagraphs,
      body_latex: bodyLatex,
      closing: String(payload?.closing || DEFAULT_COVER_LETTER_SETTINGS.closing).trim() || DEFAULT_COVER_LETTER_SETTINGS.closing,
    };
  }

  function renderCoverLetterTemplateLocal(job = {}, settings = {}, payload = {}) {
    const mergedSettings = {
      ...DEFAULT_COVER_LETTER_SETTINGS,
      ...settings,
    };
    const normalizedPayload = normalizeCoverLetterPayload(payload);
    const signatureAsset = buildCoverLetterSignatureAssetLocal(mergedSettings);
    const senderLines = [
      mergedSettings.sender_name ? `\\textbf{${escapeLatexForTemplate(mergedSettings.sender_name)}}` : '',
      mergedSettings.sender_email ? escapeLatexForTemplate(mergedSettings.sender_email) : '',
      mergedSettings.sender_phone ? escapeLatexForTemplate(mergedSettings.sender_phone) : '',
      mergedSettings.sender_linkedin_url
        ? `\\href{${escapeLatexUrl(mergedSettings.sender_linkedin_url)}}{LinkedIn: ${escapeLatexForTemplate(mergedSettings.sender_linkedin_label || mergedSettings.sender_name || 'Profile')}}`
        : '',
      mergedSettings.sender_location ? escapeLatexForTemplate(mergedSettings.sender_location) : '',
    ].filter(Boolean).map((line) => `    ${line} \\\\`).join('\n');
    const recipientLines = [
      escapeLatexForTemplate(mergedSettings.recipient_name || 'Hiring Manager'),
      escapeLatexForTemplate(job.company || ''),
      escapeLatexForTemplate(mergedSettings.recipient_location || job.location || ''),
    ].filter(Boolean).map((line) => `${line} \\\\`).join('\n');
    const subject = job.company
      ? `Application for ${escapeLatexForTemplate(job.title || 'the role')} - ${escapeLatexForTemplate(job.company)}`
      : `Application for ${escapeLatexForTemplate(job.title || 'the role')}`;
    const bodyBlocks = normalizedPayload.body_latex?.length
      ? normalizedPayload.body_latex.join('\n\n')
      : normalizedPayload.paragraphs.map((paragraph) => escapeLatexForTemplate(paragraph)).join('\n\n');
    const signatureBlock = signatureAsset.latexPath
      ? `\\includegraphics[height=1.2cm]{${signatureAsset.latexPath}} \\\\\n`
      : '';
    const replacements = {
      '{{sender_block}}': senderLines,
      '{{letter_date}}': '\\today',
      '{{recipient_block}}': recipientLines,
      '{{subject}}': subject,
      '{{greeting}}': `Dear ${escapeLatexForTemplate(mergedSettings.recipient_name || 'Hiring Manager')},`,
      '{{body_blocks}}': bodyBlocks,
      '{{closing}}': escapeLatexForTemplate(normalizedPayload.closing || mergedSettings.closing || DEFAULT_COVER_LETTER_SETTINGS.closing),
      '{{signature_block}}': signatureBlock,
      '{{typed_name}}': escapeLatexForTemplate(mergedSettings.sender_name || DEFAULT_COVER_LETTER_SETTINGS.sender_name),
    };

    let latex = COVER_LETTER_TEMPLATE;
    Object.entries(replacements).forEach(([token, value]) => {
      latex = latex.replace(token, value);
    });

    return {
      latex,
      text: [
        `Dear ${mergedSettings.recipient_name || 'Hiring Manager'},`,
        '',
        ...normalizedPayload.paragraphs,
        '',
        normalizedPayload.closing || mergedSettings.closing || DEFAULT_COVER_LETTER_SETTINGS.closing,
        mergedSettings.sender_name || DEFAULT_COVER_LETTER_SETTINGS.sender_name,
      ].join('\n'),
      payload: normalizedPayload,
      settings: mergedSettings,
      assets: signatureAsset.assets,
    };
  }

  function buildCoverLetterUserPrompt(parsedReq, latex, alignment, job = {}, guidance = '') {
    const normalizedGuidance = String(guidance || '').trim();
    return `JOB REQUIREMENTS:\n${JSON.stringify(parsedReq || {}, null, 2)}\n\nJOB METADATA:\n${JSON.stringify(job || {}, null, 2)}\n\nCV:\n${latex || ''}\n\nALIGNMENT:\n${JSON.stringify(alignment || {}, null, 2)}\n\nCOVER LETTER TEMPLATE:\n${COVER_LETTER_TEMPLATE}\n\nTEMPLATE RULES:\n- Use the LaTeX template as the formatting and narrative structure reference only.\n- Ignore placeholders and any old personal details in the template.\n- Your output will be inserted into the template later, so return raw LaTeX body paragraphs and the closing as JSON.${normalizedGuidance ? `\n\nUSER STORY / OBJECTIVES:\n${normalizedGuidance}` : ''}\n\nWrite the cover letter body JSON.`;
  }

  function buildCompanyResearchUserPrompt(company, role = '') {
    return `Conduct deep interview research for the company "${company}"${role ? ` for the role "${role}"` : ''}. Provide a concise report covering culture, recent news, interview style, employee sentiment, and likely technical or business context.`;
  }

  function buildInterviewPrepUserPrompt(parsedReq, latex, alignment, research = '') {
    let prompt = `JOB REQUIREMENTS:\n${JSON.stringify(parsedReq || {}, null, 2)}\n\nCV:\n${latex || ''}\n\nALIGNMENT:\n${JSON.stringify(alignment || {}, null, 2)}`;
    if (String(research || '').trim()) {
      prompt += `\n\nCOMPANY RESEARCH REPORT:\n${String(research).trim()}`;
    }
    return `${prompt}\n\nGenerate the interview prep JSON.`;
  }

  function renderSimpleMarkdown(markdown = '') {
    const safe = esc(String(markdown || '').trim());
    if (!safe) return '';
    return safe
      .replace(/^### (.+)$/gim, '<h5>$1</h5>')
      .replace(/^## (.+)$/gim, '<h4>$1</h4>')
      .replace(/^# (.+)$/gim, '<h3>$1</h3>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  function renderInterviewPrepHtml(prep = {}, research = '') {
    let html = '';
    if (String(research || '').trim()) {
      html += `
        <div class="company-research-card">
          <h4>Company Research Intelligence</h4>
          <div class="research-content">${renderSimpleMarkdown(research)}</div>
        </div>`;
    }
    if (prep.talking_points?.length) {
      html += `
        <div class="interview-prep-stack${html ? ' stack-gap-sm' : ''}">
          <h4 class="interview-section-heading">Key Talking Points</h4>
          ${prep.talking_points.map((tp) => `
            <div class="interview-prep-card">
              <div class="interview-prep-title">${esc(tp.topic)}</div>
              <div class="interview-prep-copy"><span class="interview-emphasis strength">Strength</span>${esc(tp.your_strength)}</div>
              ${tp.gap_to_address ? `<div class="interview-prep-copy"><span class="interview-emphasis gap">Address Gap</span>${esc(tp.gap_to_address)}</div>` : ''}
              <div class="interview-prep-copy"><span class="interview-emphasis approach">Outline</span>${esc(tp.sample_answer_outline)}</div>
            </div>`).join('')}
        </div>`;
    }
    if (prep.likely_questions?.length) {
      html += `
        <div class="interview-prep-stack stack-gap-sm">
          <h4 class="interview-section-heading">Likely Questions</h4>
          ${prep.likely_questions.map((q) => `
            <div class="interview-prep-card">
              <div class="interview-prep-title">${esc(q.question)} <span class="tag">${esc(q.category)}</span></div>
              <div class="interview-prep-copy"><span class="interview-emphasis approach">Approach</span>${esc(q.suggested_approach)}</div>
            </div>`).join('')}
        </div>`;
    }
    if (prep.key_numbers?.length) {
      html += `
        <div class="interview-prep-stack stack-gap-sm">
          <h4 class="interview-section-heading">Numbers to Memorize</h4>
          <ul class="interview-list">${prep.key_numbers.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>`;
    }
    if (prep.red_flags?.length) {
      html += `
        <div class="interview-prep-stack stack-gap-sm">
          <h4 class="interview-section-heading">Red Flags / Weaknesses to Prepare For</h4>
          <ul class="interview-list danger">${prep.red_flags.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>`;
    }
    return html || '<p class="empty-state">No interview prep generated yet.</p>';
  }

  async function runInterviewPrepForSession(session) {
    const parsedReq = parseJSON(session?.parsed_req || session?.parsedReq) || {};
    const alignment = parseJSON(session?.alignment) || {};
    const interviewLatex = String(
      session?.edited_latex ||
      session?.editedLatex ||
      session?.generated_latex ||
      ''
    ).trim();
    if (serverMode && session?.id) {
      return apiFetch('/interview-prep', {
        method: 'POST',
        body: JSON.stringify({
          session_id: session.id,
          cached_research: session?.interview_research || '',
          latex_override: interviewLatex,
        }),
      });
    }

    const profile = await Store.getProfile(Number(session?.profile_id || 0));
    if (!profile?.latex) throw new Error('Profile not found');
    const sourceLatex = interviewLatex || String(profile.latex || '').trim();

    let research = String(session?.interview_research || '').trim();
    const companyName = String(parsedReq.company || session?.company || '').trim();
    const roleTitle = String(parsedReq.title || session?.job_title || '').trim();
    if (!research && companyName && isOpenRouterKey(getApiKey())) {
      try {
        const researchResult = await callOpenAIDirect(
          PROMPTS.companyResearchSystem,
          buildCompanyResearchUserPrompt(companyName, roleTitle),
          { model: DEFAULT_COMPANY_RESEARCH_MODEL, maxTokens: 700, temperature: 0.1, json: false }
        );
        research = String(researchResult?.data || '').trim();
      } catch (err) {
        console.warn('Company research stage failed:', err.message);
      }
    }

    const interviewResult = await callOpenAIDirect(
      PROMPTS.interviewPrepSystem,
      buildInterviewPrepUserPrompt(parsedReq, sourceLatex, alignment, research),
      { maxTokens: 3000 }
    );
    return {
      prep: typeof interviewResult.data === 'string'
        ? (parseStructuredJson(interviewResult.data) || JSON.parse(interviewResult.data))
        : interviewResult.data,
      research,
    };
  }

  function renderInterviewSessionMeta(session) {
    const meta = document.getElementById('interviewSessionMeta');
    if (!meta) return;
    if (!session) {
      meta.innerHTML = '<p class="empty-state">Select a run to prepare targeted interview notes.</p>';
      return;
    }
    const alignment = parseJSON(session.alignment) || {};
    const score = Number(alignment?.overall_score || 0);
    meta.innerHTML = `
      <div class="interview-session-summary">
        <div class="interview-session-title">${esc(session.job_title || 'Untitled role')} @ ${esc(session.company || 'Unknown company')}</div>
        <div class="interview-session-detail">${esc(session.profile_name || 'Unknown profile')} ? Score ${esc(String(score || 0))} ? ${esc(fmtDate(session.created_at || ''))}</div>
      </div>`;
  }

  async function loadInterviewTool() {
    const select = document.getElementById('interviewSessionSelect');
    const content = document.getElementById('interviewToolContent');
    if (!select || !content) return;

    const sessions = await Store.getSessions();
    if (!sessions.length) {
      interviewToolSessionId = 0;
      select.innerHTML = '<option value="">No saved runs yet</option>';
      renderInterviewSessionMeta(null);
      content.innerHTML = '<p class="empty-state">Run Tailor first, then use that saved session here.</p>';
      return;
    }

    const preferredId = Number(select.value || interviewToolSessionId || currentSession?.id || sessions[0]?.id || 0);
    select.innerHTML = sessions.map((session) => `
      <option value="${session.id}">${esc(session.job_title || 'Untitled role')} @ ${esc(session.company || 'Unknown company')} ? ${esc(fmtDate(session.created_at || ''))}</option>
    `).join('');
    const resolvedId = sessions.some((session) => Number(session.id) === preferredId)
      ? preferredId
      : Number(sessions[0].id || 0);
    select.value = resolvedId ? String(resolvedId) : '';
    interviewToolSessionId = resolvedId;

    const session = currentSession?.id === resolvedId
      ? currentSession
      : await Store.getSession(resolvedId);
    renderInterviewSessionMeta(session);
    content.innerHTML = session?.interview_prep
      ? renderInterviewPrepHtml(session.interview_prep, session.interview_research || '')
      : '<p class="empty-state">Generate interview prep and company research for this run here.</p>';
  }

  ['coverLetterSenderName', 'coverLetterSenderEmail', 'coverLetterSenderPhone', 'coverLetterSenderLinkedInUrl', 'coverLetterSenderLinkedInLabel', 'coverLetterSenderLocation', 'coverLetterRecipientName', 'coverLetterRecipientLocation', 'coverLetterSignaturePath'].forEach((elementId) => {
    document.getElementById(elementId)?.addEventListener('input', () => {
      collectCoverLetterTemplateSettings();
    });
  });
  document.getElementById('coverLetterSignatureUpload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const nextSettings = {
        ...getCoverLetterTemplateSettings(),
        signature_image_name: file.name,
        signature_image_data_url: dataUrl,
      };
      persistCoverLetterTemplateSettings(nextSettings);
      updateCoverLetterSignatureStatus(nextSettings);
      toast('Signature image uploaded for cover-letter compile.', 'success');
    } catch (error) {
      toast(error.message || 'Failed to upload signature image.', 'error');
    } finally {
      event.target.value = '';
    }
  });
  document.getElementById('clearCoverLetterSignatureUpload')?.addEventListener('click', () => {
    const nextSettings = {
      ...getCoverLetterTemplateSettings(),
      signature_image_name: '',
      signature_image_data_url: '',
    };
    persistCoverLetterTemplateSettings(nextSettings);
    updateCoverLetterSignatureStatus(nextSettings);
    toast('Uploaded signature removed.', 'success');
  });
  document.getElementById('coverLetterGuidance')?.addEventListener('input', (event) => {
    localStorage.setItem(COVER_LETTER_GUIDANCE_KEY, event.target.value || '');
  });
  populateCoverLetterSettingsFields();

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });

  // ?? API Status ?????????????????????????????????????????????????????
  function updateApiStatus() {
    const el = document.getElementById('apiStatus');
    const has = !!getApiKey() || (serverMode && serverHasDefaultKey);
    el.classList.toggle('connected', has);
    el.querySelector('.status-text').textContent = getApiKey()
      ? 'Ready'
      : (serverMode && serverHasDefaultKey ? 'Server Key' : 'No Key');
    const badge = document.getElementById('modeBadge');
    badge.textContent = serverMode ? '?' : '?';
    badge.className = `mode-badge ${serverMode ? '' : 'offline'}`;
    badge.title = serverMode ? 'Server mode (full features)' : 'Client-only mode (browser storage)';
    renderBridgeEventFeed();
  }

  function updateModelOptions() {
    const select = document.getElementById('modelSelect');
    const customInput = document.getElementById('customModelInput');
    const hint = document.getElementById('modelHint');
    if (!select) return;
    const apiKey = document.getElementById('apiKeyInput')?.value.trim() || getApiKey();
    const provider = getEffectiveProvider(apiKey);
    const usingOpenRouter = provider === 'openrouter';

    Array.from(select.options).forEach((option) => {
      const allowed = option.value === '__custom__' || usingOpenRouter || !isOpenRouterModel(option.value);
      option.disabled = !allowed;
      option.hidden = false;
      if (!allowed && option.selected) {
        select.value = DEFAULT_OPENAI_MODEL;
      }
    });

    if (customInput) {
      customInput.placeholder = usingOpenRouter
        ? 'Optional custom model id, e.g. deepseek/deepseek-v3.2 or provider/model:free'
        : 'Optional custom OpenAI model id';
    }
    if (hint) {
      hint.textContent = usingOpenRouter
        ? 'Recommended default is DeepSeek V3.2 for budget CV runs. Gemini 2.5 Flash is the stronger step-up; Claude 3.5 Haiku is a writing-focused fallback.'
        : 'OpenAI key detected. OpenAI models are enabled; OpenRouter models remain available if you switch keys.';
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SETTINGS MODAL — tabs: API & Model, Parameters, System Prompts
  // ══════════════════════════════════════════════════════════════════
  const settingsModal = document.getElementById('settingsModal');
  let settingsActiveTab = 'api';
  let settingsPromptsData = {};

  // ── Tab switching ──────────────────────────────────────────────
  document.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      settingsActiveTab = btn.dataset.tab;
      document.querySelectorAll('.settings-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.settings-tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`settings-tab-${settingsActiveTab}`)?.classList.add('active');
      if (settingsActiveTab === 'params') loadParamsTab();
      if (settingsActiveTab === 'prompts') loadPromptsTab();
    });
  });

  // ── Open / close ───────────────────────────────────────────────
  document.getElementById('settingsBtn').addEventListener('click', () => {
    settingsModal.classList.add('open');
    document.getElementById('apiKeyInput').value = getApiKey();
    syncModelSettingsFields(getModel());
    updateModelOptions();
    if (settingsActiveTab === 'params') loadParamsTab();
    if (settingsActiveTab === 'prompts') loadPromptsTab();
  });
  document.getElementById('closeSettings').addEventListener('click', () => settingsModal.classList.remove('open'));
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

  // ── API tab (unchanged behaviour) ─────────────────────────────
  document.getElementById('apiKeyInput').addEventListener('input', updateModelOptions);
  document.getElementById('modelSelect').addEventListener('change', () => {
    const select = document.getElementById('modelSelect');
    const customInput = document.getElementById('customModelInput');
    if (select?.value === '__custom__') {
      customInput?.focus();
    } else if (customInput) {
      customInput.value = '';
    }
  });
  document.getElementById('toggleKeyVis').addEventListener('click', () => {
    const inp = document.getElementById('apiKeyInput');
    const btn = document.getElementById('toggleKeyVis');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  });
  document.getElementById('saveApiKey').addEventListener('click', () => {
    const key = document.getElementById('apiKeyInput').value.trim();
    const model = getCompatibleModel(getRequestedModelFromSettings(), key);
    if (!key && !(serverMode && serverHasDefaultKey)) return toast('Enter a key', 'error');
    setApiKey(key);
    localStorage.setItem('cv_model', model);
    settingsModal.classList.remove('open');
    toast('Settings saved', 'success');
  });
  document.getElementById('clearApiKey').addEventListener('click', () => {
    localStorage.removeItem('cv_api_key');
    document.getElementById('apiKeyInput').value = '';
    syncModelSettingsFields(getModel());
    updateModelOptions();
    updateApiStatus();
    toast('Key cleared');
  });

  // ── Parameters tab ─────────────────────────────────────────────
  const PARAM_LABELS = {
    parse_max_tokens: 'Parse — max tokens',
    analyze_max_tokens: 'Analyze — max tokens',
    replace_max_tokens_balanced: 'Replace — max tokens (balanced)',
    replace_max_tokens_safe: 'Replace — max tokens (safe)',
    replace_max_tokens_strategic: 'Replace — max tokens (strategic)',
    replace_max_attempts: 'Replace — max retry attempts',
    replace_temperature_balanced: 'Replace — temperature (balanced)',
    replace_temperature_safe: 'Replace — temperature (safe)',
    replace_temperature_strategic: 'Replace — temperature (strategic)',
    review_max_tokens: 'Review — max tokens',
    cover_letter_max_tokens: 'Cover Letter — max tokens',
    interview_max_tokens: 'Interview Prep — max tokens',
  };

  async function loadParamsTab() {
    if (!serverMode) {
      document.getElementById('paramsGrid').innerHTML = '<div class="empty-state">Parameter tuning requires the local server to be running.</div>';
      return;
    }
    try {
      const res = await fetch(`${serverOrigin}/api/settings/params`);
      const { params, defaults } = await res.json();
      const grid = document.getElementById('paramsGrid');
      grid.innerHTML = Object.keys(PARAM_LABELS).map((key) => `
        <div class="param-row">
          <span class="param-row-label">${PARAM_LABELS[key] || key}</span>
          <input class="param-row-input" type="number" id="param-${key}" value="${params[key] ?? defaults[key]}" step="${key.includes('temperature') ? '0.01' : '100'}" min="0">
          <span class="param-row-default">def&nbsp;${defaults[key]}</span>
        </div>`).join('');
    } catch {
      document.getElementById('paramsGrid').innerHTML = '<div class="empty-state">Could not load parameters from server.</div>';
    }
  }

  document.getElementById('saveParams').addEventListener('click', async () => {
    if (!serverMode) return toast('Server not connected', 'error');
    const updates = {};
    Object.keys(PARAM_LABELS).forEach((key) => {
      const el = document.getElementById(`param-${key}`);
      if (el) updates[key] = Number(el.value);
    });
    try {
      await fetch(`${serverOrigin}/api/settings/params`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      toast('Parameters applied', 'success');
    } catch { toast('Failed to save parameters', 'error'); }
  });

  document.getElementById('resetParams').addEventListener('click', async () => {
    if (!serverMode) return toast('Server not connected', 'error');
    try {
      await fetch(`${serverOrigin}/api/settings/params/reset`, { method: 'POST' });
      await loadParamsTab();
      toast('Parameters reset to defaults');
    } catch { toast('Failed to reset parameters', 'error'); }
  });

  // ── Prompts tab ─────────────────────────────────────────────────
  async function loadPromptsTab() {
    if (!serverMode) return;
    try {
      const res = await fetch(`${serverOrigin}/api/prompts`);
      settingsPromptsData = await res.json();
      // Refresh editor if a prompt is already selected
      const key = document.getElementById('promptKeySelect')?.value;
      if (key) renderPromptEditor(key);
    } catch { settingsPromptsData = {}; }
  }

  function renderPromptEditor(key) {
    const data = settingsPromptsData[key];
    const shell = document.getElementById('promptEditorShell');
    const hint = document.getElementById('promptSelectHint');
    const badge = document.getElementById('promptOverrideBadge');
    const textarea = document.getElementById('promptEditorTextarea');
    if (!data) { shell.style.display = 'none'; hint.style.display = ''; return; }
    shell.style.display = 'grid';
    hint.style.display = 'none';
    textarea.value = data.current || '';
    badge.style.display = data.overridden ? '' : 'none';
    document.getElementById('promptSaveStatus').textContent = '';
  }

  document.getElementById('promptKeySelect').addEventListener('change', (e) => {
    renderPromptEditor(e.target.value);
  });

  document.getElementById('savePrompt').addEventListener('click', async () => {
    if (!serverMode) return toast('Server not connected', 'error');
    const key = document.getElementById('promptKeySelect').value;
    if (!key) return toast('Select a prompt first', 'error');
    const value = document.getElementById('promptEditorTextarea').value;
    const statusEl = document.getElementById('promptSaveStatus');
    try {
      const res = await fetch(`${serverOrigin}/api/prompts/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      settingsPromptsData[key] = data;
      document.getElementById('promptOverrideBadge').style.display = data.overridden ? '' : 'none';
      statusEl.textContent = '✓ Saved — active until server restart';
      statusEl.style.color = 'var(--green)';
      toast('Prompt updated', 'success');
    } catch {
      statusEl.textContent = '✗ Save failed';
      statusEl.style.color = 'var(--crit)';
      toast('Failed to save prompt', 'error');
    }
  });

  document.getElementById('resetPrompt').addEventListener('click', async () => {
    if (!serverMode) return toast('Server not connected', 'error');
    const key = document.getElementById('promptKeySelect').value;
    if (!key) return toast('Select a prompt first', 'error');
    try {
      const res = await fetch(`${serverOrigin}/api/prompts/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      const data = await res.json();
      settingsPromptsData[key] = data;
      renderPromptEditor(key);
      toast('Prompt reset to default');
    } catch { toast('Failed to reset prompt', 'error'); }
  });

  // ??????????????????????????????????????????????????????????????????
  // DASHBOARD
  // ??????????????????????????????????????????????????????????????????
  async function loadDashboard() {
    try {
      const [profiles, jobs, sessions, genres, rawVaultItems] = await Promise.all([
        Store.getProfiles(), Store.getJobs(), Store.getSessions(), Store.getGenres(), Store.getVaultItems()
      ]);
      const normalizedGenres = genres.map(normalizeGenre);
      const vaultItems = buildVaultItems(rawVaultItems, profiles, sessions);
      await refreshBridgeRuntimeState();
      ingestImportedJobs(jobs, { seedOnly: !hasSeededBridgeImports, announce: false });
      hasSeededBridgeImports = true;
      buildReadinessState(profiles, jobs, vaultItems);
      const importedJobs = countImportedJobs(jobs);
      const totalVaultItems = vaultItems.length;
      const resumeReadyCount = vaultItems.filter((item) => item.status === 'resume-ready' || item.status === 'verified').length;
      const neverUsedCount = vaultItems.filter((item) => !item.reuse_count).length;
      const missingOutcomes = sessions.filter(s => !s.outcome).length;
      const positiveOutcomes = sessions.filter(s => s.outcome === 'interview' || s.outcome === 'offer').length;
      const recent = sessions[0];
      const recentReport = parseJSON(recent?.report || recent?.replacements);
      const recentRisky = recentReport?.changes?.filter(change => change?.validation?.hallucinated || !change?.validation?.exact_match).length || 0;
      const topGenre = normalizedGenres
        .map((genre) => {
          const related = sessions.filter((session) => (session.genre_name || '').toLowerCase() === genre.name.toLowerCase());
          const wins = related.filter((session) => session.outcome === 'interview' || session.outcome === 'offer').length;
          return { genre, related: related.length, wins };
        })
        .sort((a, b) => b.wins - a.wins || b.related - a.related)[0];
      const topVaultItem = [...vaultItems].sort((a, b) => b.reuse_count - a.reuse_count || (b.updated_at || '').localeCompare(a.updated_at || ''))[0];

      document.getElementById('statProfiles').textContent = profiles.length;
      document.getElementById('statVault').textContent = totalVaultItems;
      document.getElementById('statResumeReady').textContent = resumeReadyCount;
      document.getElementById('statGenres').textContent = normalizedGenres.length;

      const heroTitle = document.getElementById('homeHeroTitle');
      const heroText = document.getElementById('homeHeroText');
      const heroCta = document.getElementById('homeHeroCta');
      const smartActions = [];
      let heroAction = () => navigate('profiles');

      if (!profiles.length) {
        heroTitle.textContent = 'Create your first profile';
        heroText.textContent = 'Add a base CV and a few reusable proof items so tailoring stays grounded from the start.';
        heroCta.textContent = 'Go to Profiles';
      } else if (!totalVaultItems) {
        heroTitle.textContent = 'Capture reusable proof into the Vault';
        heroText.textContent = 'Your template exists, but your long-term advantage comes from saved experience. Capture a few proof items before your next tailoring run.';
        heroCta.textContent = 'Open Vault';
        heroAction = () => navigate('vault');
      } else if (!normalizedGenres.length) {
        heroTitle.textContent = 'Create your first genre';
        heroText.textContent = 'Turn related experience into a reusable strategic direction so tailoring stops being a one-off decision every time.';
        heroCta.textContent = 'Open Genres';
        heroAction = () => navigate('genres');
      } else if (!sessions.length) {
        heroTitle.textContent = importedJobs ? 'Tailor one of your captured jobs' : 'Run your first tailoring session';
        heroText.textContent = importedJobs
          ? 'Your Chrome capture flow is feeding live jobs into the app. Pick one and turn it into a grounded tailoring run.'
          : 'You already have the raw ingredients. Tailor one job to see grounded edits, risk labels, and reusable matches.';
        heroCta.textContent = 'Open Tailor';
        heroAction = () => navigate('tailor');
      } else if (recentRisky > 0 && recent?.id) {
        heroTitle.textContent = `Review ${recentRisky} risky suggestion${recentRisky === 1 ? '' : 's'} from your latest run`;
        heroText.textContent = 'The highest-value next step is to inspect unsupported or exact-match-risk changes before reusing this version.';
        heroCta.textContent = 'Review Latest Run';
        heroAction = () => loadSessionResults(Number(recent.id));
      } else if (positiveOutcomes > 0) {
        heroTitle.textContent = 'Reuse what already works';
        heroText.textContent = 'You have successful runs on record. Use them as the baseline for the next job instead of starting from scratch.';
        heroCta.textContent = 'Open Runs';
        heroAction = () => navigate('history');
      } else {
        heroTitle.textContent = 'Tailor a new job';
        heroText.textContent = 'Your profiles and saved experience are ready. Run the next job and keep building grounded reuse over time.';
        heroCta.textContent = 'Open Tailor';
        heroAction = () => navigate('tailor');
      }

      heroCta.onclick = heroAction;

      if (!totalVaultItems) smartActions.push('Capture a few reusable proof items in the Vault so the app can recommend stronger source-backed changes.');
      if (totalVaultItems && !normalizedGenres.length) smartActions.push('Create a genre from your strongest tags so you can reuse strategy, not just wording.');
      if (neverUsedCount > 0) smartActions.push(`${neverUsedCount} vault item${neverUsedCount === 1 ? '' : 's'} have never been reused. Turn the best ones into genre support.`);
      if (missingOutcomes) smartActions.push(`Mark outcomes on ${missingOutcomes} run${missingOutcomes === 1 ? '' : 's'} so the app can learn what works.`);
      if (importedJobs) smartActions.push(`${importedJobs} imported job${importedJobs === 1 ? '' : 's'} are already waiting from the Chrome capture flow.`);
      if (jobs.length < Math.max(1, profiles.length)) smartActions.push('Save a few target jobs so tailoring becomes a repeatable loop instead of one-off work.');
      if (recentRisky > 0) smartActions.push(`Your latest run has ${recentRisky} item${recentRisky === 1 ? '' : 's'} marked for review before reuse.`);
      if (!smartActions.length) smartActions.push('Your system is in good shape. Tailor the next job or review a past run and save the best edits back into your workflow.');

      document.getElementById('smartActions').innerHTML = smartActions
        .slice(0, UI_LIMITS.dashboard.smartActions)
        .map(action => `<div class="smart-action-item">${esc(action)}</div>`)
        .join('');

      document.getElementById('reuseHealth').innerHTML = `
        <div class="health-grid">
          <div class="health-chip"><div class="health-chip-label">Vault Items</div><div class="health-chip-value">${totalVaultItems}</div></div>
          <div class="health-chip"><div class="health-chip-label">Resume-Ready</div><div class="health-chip-value">${resumeReadyCount}</div></div>
          <div class="health-chip"><div class="health-chip-label">Genres</div><div class="health-chip-value">${normalizedGenres.length}</div></div>
          <div class="health-chip"><div class="health-chip-label">Never Used</div><div class="health-chip-value">${neverUsedCount}</div></div>
        </div>
      `;

      document.getElementById('momentumStrip').innerHTML = `
        <div class="momentum-grid">
          <div class="momentum-item featured">
            <div class="momentum-label">Top Genre</div>
            <div class="momentum-value">${esc(topGenre?.genre?.name || 'Create one')}</div>
          </div>
          <div class="momentum-item">
            <div class="momentum-label">Top Vault Item</div>
            <div class="momentum-value">${esc(topVaultItem?.title || 'Capture proof')}</div>
          </div>
          <div class="momentum-item">
            <div class="momentum-label">Latest Successful Run</div>
            <div class="momentum-value">${esc((sessions.find((session) => session.outcome === 'interview' || session.outcome === 'offer')?.job_title) || 'No successful run yet')}</div>
          </div>
          <div class="momentum-item">
            <div class="momentum-label">Positive Outcomes</div>
            <div class="momentum-value">${positiveOutcomes}</div>
          </div>
        </div>
      `;

      const c = document.getElementById('recentSessions');
      if (!sessions.length) {
        setCountHeading('recentSessionsHeading', 'Recent Tailored CVs', 0, 0);
        c.innerHTML = '<p class="empty-state">No sessions yet. Create a profile and start tailoring!</p>';
        return;
      }
      const visibleSessions = limitItems(sessions, UI_LIMITS.dashboard.recentSessions);
      setCountHeading('recentSessionsHeading', 'Recent Tailored CVs', visibleSessions.length, sessions.length);
      c.innerHTML = visibleSessions.map(s => {
        const al = parseJSON(s.alignment);
        const score = al?.overall_score || '?';
        const col = scoreColor(typeof score === 'number' ? score : 0);
        const company = s.company || '';
        const title = s.job_title || '';
        return `<div class="session-item" data-id="${s.id}">
          <div class="session-score" style="border-color:${col};color:${col}">${score}</div>
          <div class="session-info"><div class="session-title">${esc(title)} @ ${esc(company)}</div><div class="session-meta">${s.profile_name || ''}${renderMetaPill(s.genre_name)}${renderMetaPill(STRICTNESS_LABELS[s.strictness] || '')} ? ${fmtDate(s.created_at)} ${renderOutcomeBadge(s.outcome)}</div></div>
          <div class="session-actions"><button class="btn btn-sm btn-ghost session-dl" data-id="${s.id}" title="Download .tex">?</button></div>
        </div>`;
      }).join('');

      c.querySelectorAll('.session-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.session-dl')) return;
          loadSessionResults(Number(el.dataset.id));
        });
      });
      c.querySelectorAll('.session-dl').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sess = await Store.getSession(Number(btn.dataset.id));
          const latex = sess.edited_latex || sess.editedLatex;
          if (latex) downloadTex(latex, sess.company || 'cv', sess.job_title || '');
        });
      });
    } catch (err) { toast(err.message, 'error'); }
  }

  // ??????????????????????????????????????????????????????????????????
  // QUICK TAILOR
  // ??????????????????????????????????????????????????????????????????
  async function loadTailorView() {
    try {
      const { profiles, jobs, genres, sessions, rawVaultItems } = await getTailorViewSnapshot({ force: true });
      const selectedProfile = document.getElementById('tailorProfile').value;
      const selectedGenre = document.getElementById('tailorGenre').value;
      const selectedJob = document.getElementById('tailorJob').value;
      const ps = document.getElementById('tailorProfile');
      ps.innerHTML = profiles.length
        ? '<option value="">Select profile...</option>' + profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
        : '<option value="">No profiles yet</option>';
      const gs = document.getElementById('tailorGenre');
      gs.innerHTML = '<option value="">No genre selected</option>' + genres.map((genre) => `<option value="${genre.id}">${esc(genre.name)}</option>`).join('');
      const js = document.getElementById('tailorJob');
      js.innerHTML = '<option value="">? New job (fill below) ?</option>' +
        jobs.map((job) => `<option value="${job.id}">${esc(formatJobOption(job))}</option>`).join('');
      if (profiles.some((profile) => String(profile.id) === String(selectedProfile))) ps.value = selectedProfile;
      if (genres.some((genre) => String(genre.id) === String(selectedGenre))) gs.value = selectedGenre;
      if (jobs.some((job) => String(job.id) === String(selectedJob))) js.value = selectedJob;
      const coverageSelect = document.getElementById('tailorRewriteCoverage');
      if (coverageSelect) coverageSelect.value = String(getTailorRewriteCoverage());
      await refreshBridgeRuntimeState();
      ingestImportedJobs(jobs, { seedOnly: !hasSeededBridgeImports, announce: false });
      hasSeededBridgeImports = true;
      const importedJobs = countImportedJobs(jobs);
      document.getElementById('jobCaptureCount').textContent = `${importedJobs} imported`;
      document.getElementById('batchJobFilter').value = batchJobFilter;
      syncTailorJobDraftFromSelection(jobs);
      document.getElementById('jobCaptureText').textContent = importedJobs
        ? `Captured jobs are live in ${bridgeRuntimeState.targetLabel || 'the active runtime'}. ${importedJobs} imported job${importedJobs === 1 ? '' : 's'} can be tailored immediately, and exported extension JSON can also be pasted here.`
        : serverMode
          ? `Use the Chrome job capture extension to send jobs straight into ${bridgeRuntimeState.targetLabel || 'this runtime'}, or paste the extension JSON export below.`
          : 'Chrome capture import works when the local server or desktop app is running. You can still paste exported extension JSON below.';
      renderTailorPreflight(profiles, jobs, genres, sessions, rawVaultItems);
      renderBatchJobList(jobs, sessions);
      renderBatchQueueStatus();
      resumeBatchQueueIfNeeded();
      updateTailorBtn();
    } catch (err) { toast(err.message, 'error'); }
  }

  function updateTailorBtn() {
    const hasP = !!document.getElementById('tailorProfile').value;
    const hasJ = !!document.getElementById('tailorJob').value;
    const hasNew = !!(document.getElementById('newJobCompany').value && document.getElementById('newJobTitle').value && document.getElementById('newJobDesc').value);
    const keyAvailable = !!getApiKey() || (serverMode && serverHasDefaultKey);
    document.getElementById('runTailor').disabled = !keyAvailable || !hasP || !(hasJ || hasNew);
    const batchButton = document.getElementById('runBatchTailor');
    if (batchButton) {
      batchButton.disabled = !keyAvailable || !hasP || batchQueueRunning || batchSelection.size === 0;
    }
  }

  ['tailorProfile', 'tailorGenre', 'tailorStrictness', 'tailorRewriteCoverage', 'tailorJob', 'newJobCompany', 'newJobTitle', 'newJobDesc', 'newJobUrl'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateTailorBtn);
    document.getElementById(id).addEventListener('change', updateTailorBtn);
    document.getElementById(id).addEventListener('input', () => scheduleTailorPreflightRefresh());
    document.getElementById(id).addEventListener('change', () => scheduleTailorPreflightRefresh({ immediate: true }));
  });
  document.getElementById('tailorRewriteCoverage')?.addEventListener('change', (event) => {
    localStorage.setItem(REWRITE_COVERAGE_STORAGE_KEY, String(normalizeRewriteCoverage(event.target.value)));
  });
  document.getElementById('tailorJob')?.addEventListener('change', async () => {
    const { jobs } = await getTailorViewSnapshot();
    syncTailorJobDraftFromSelection(jobs);
    updateTailorBtn();
    scheduleTailorPreflightRefresh({ immediate: true });
  });
  ['newJobCompany', 'newJobTitle', 'newJobDesc', 'newJobUrl'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', rememberTailorManualDraft);
    document.getElementById(id)?.addEventListener('change', rememberTailorManualDraft);
  });
  document.getElementById('refreshTailorJobs')?.addEventListener('click', async () => {
    try {
      await loadTailorView();
      toast('Job queue refreshed', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  document.getElementById('importJobsJsonBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('jobImportJson');
    const raw = input.value.trim();
    if (!raw) return toast('Paste exported extension JSON first', 'error');
    try {
      const parsed = JSON.parse(raw);
      const jobs = Array.isArray(parsed) ? parsed : [parsed];
      const result = await Store.importJobs(jobs);
      invalidateTailorSnapshot();
      input.value = '';
      await loadTailorView();
      loadDashboard();
      toast(`Imported ${result.imported || jobs.length} job${(result.imported || jobs.length) === 1 ? '' : 's'} from extension JSON`, 'success');
    } catch (err) {
      toast(err.message || 'Could not import jobs JSON', 'error');
    }
  });
  document.getElementById('selectImportedBatchJobs')?.addEventListener('click', async () => {
    const { jobs, sessions } = await getTailorViewSnapshot();
    jobs
      .filter((job) => String(job.source || '').trim() && String(job.source || '').trim() !== 'manual')
      .forEach((job) => batchSelection.add(Number(job.id)));
    renderBatchJobList(jobs, sessions);
  });
  document.getElementById('clearBatchSelection')?.addEventListener('click', async () => {
    batchSelection.clear();
    const { jobs, sessions } = await getTailorViewSnapshot();
    renderBatchJobList(jobs, sessions);
  });
  document.getElementById('batchJobFilter')?.addEventListener('change', async (event) => {
    batchJobFilter = event.target.value || 'untouched';
    localStorage.setItem(BATCH_FILTER_STORAGE_KEY, batchJobFilter);
    const { jobs, sessions } = await getTailorViewSnapshot();
    renderBatchJobList(jobs, sessions);
  });
  document.getElementById('runBatchTailor')?.addEventListener('click', async () => {
    const profileId = Number(document.getElementById('tailorProfile').value || 0);
    const genreId = Number(document.getElementById('tailorGenre').value || 0) || null;
    const strictness = document.getElementById('tailorStrictness').value || 'balanced';
    const rewriteCoverage = normalizeRewriteCoverage(document.getElementById('tailorRewriteCoverage')?.value || getTailorRewriteCoverage());
    if (!getApiKey() && !(serverMode && serverHasDefaultKey)) {
      settingsModal.classList.add('open');
      return toast('Set your API key first', 'error');
    }
    if (!profileId) return toast('Select a profile before running a batch', 'error');
    if (!batchSelection.size) return toast('Select at least one saved job for the batch queue', 'error');

    const { jobs, genres } = await getTailorViewSnapshot();
    const genre = normalizeGenre(genres.find((item) => Number(item.id) === Number(genreId)));
    const selectedJobs = jobs.filter((job) => batchSelection.has(Number(job.id)));
    batchQueueState = {
      id: Date.now(),
      profile_id: profileId,
      genre_id: genreId,
      genre_name: genre?.name || '',
      strictness,
      rewrite_coverage: rewriteCoverage,
      selected_vault_ids: [...tailorVaultSelection],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items: selectedJobs.map((job) => ({
        job_id: Number(job.id),
        title: job.title,
        company: job.company,
        source: job.source || 'manual',
        status: 'pending',
      })),
    };
    saveBatchQueueState();
    renderBatchQueueStatus();
    updateTailorBtn();
    processBatchQueue().catch((error) => toast(error.message, 'error'));
  });

  async function refreshTailorPreflight() {
    const { profiles, jobs, genres, sessions, rawVaultItems } = await getTailorViewSnapshot();
    renderTailorPreflight(profiles, jobs, genres, sessions, rawVaultItems);
  }

  function filterBatchJobs(jobs, sessions) {
    const tailoredJobIds = new Set((sessions || []).map((session) => Number(session.job_id)));
    if (batchJobFilter === 'imported') {
      return (jobs || []).filter((job) => String(job.source || '').trim() && String(job.source || '').trim() !== 'manual');
    }
    if (batchJobFilter === 'untouched') {
      return (jobs || []).filter((job) => !tailoredJobIds.has(Number(job.id)));
    }
    return jobs || [];
  }

  function renderBatchJobList(jobs, sessions = []) {
    const container = document.getElementById('batchJobList');
    const selectionCount = document.getElementById('batchSelectionCount');
    if (!container || !selectionCount) return;

    const availableJobs = filterBatchJobs(jobs, sessions);
    const validIds = new Set(availableJobs.map((job) => Number(job.id)));
    [...batchSelection].forEach((jobId) => {
      if (!validIds.has(Number(jobId))) batchSelection.delete(Number(jobId));
    });
    selectionCount.textContent = `${batchSelection.size} selected ? ${availableJobs.length} available`;

    if (!availableJobs.length) {
      container.innerHTML = batchJobFilter === 'untouched'
        ? '<p class="empty-state">No untouched jobs left. Switch the filter to imported or all saved jobs.</p>'
        : '<p class="empty-state">No jobs match the current batch filter.</p>';
      updateTailorBtn();
      return;
    }

    container.innerHTML = availableJobs.map((job) => {
      const isSelected = batchSelection.has(Number(job.id));
      return `
        <label class="batch-job-item ${isSelected ? 'active' : ''}">
          <div class="batch-job-main">
            <input class="batch-job-check" type="checkbox" data-job-id="${job.id}" ${isSelected ? 'checked' : ''}>
            <div class="batch-job-copy">
              <div class="batch-job-title">${esc(job.title || 'Untitled role')} @ ${esc(job.company || 'Unknown company')}</div>
              <div class="batch-job-meta">${esc(job.location || 'Location not set')}${renderMetaPill(jobSourceLabel(job.source || 'manual'))}</div>
            </div>
          </div>
        </label>
      `;
    }).join('');

    container.querySelectorAll('.batch-job-check').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const jobId = Number(checkbox.dataset.jobId);
        if (checkbox.checked) batchSelection.add(jobId);
        else batchSelection.delete(jobId);
        renderBatchJobList(jobs, sessions);
      });
    });

    updateTailorBtn();
  }

  function renderBatchQueueStatus() {
    const container = document.getElementById('batchRunStatus');
    if (!container) return;

    if (!batchQueueState || !Array.isArray(batchQueueState.items) || !batchQueueState.items.length) {
      container.innerHTML = '<p class="empty-state">No batch queue running.</p>';
      return;
    }

    const completed = batchQueueState.items.filter((item) => item.status === 'complete').length;
    const failed = batchQueueState.items.filter((item) => item.status === 'failed').length;
    const pending = batchQueueState.items.filter((item) => item.status === 'pending').length;
    const running = batchQueueState.items.filter((item) => item.status === 'running').length;

    container.innerHTML = `
      <div class="batch-run-item">
        <div class="batch-job-copy">
          <div class="batch-job-title">Current Batch</div>
          <div class="batch-run-meta">
            ${completed} complete ? ${running} running ? ${pending} pending ? ${failed} failed
            ${batchQueueState.genre_name ? ` ? ${esc(batchQueueState.genre_name)}` : ''}
            ${batchQueueState.selected_vault_ids?.length ? ` ? ${batchQueueState.selected_vault_ids.length} pinned source item${batchQueueState.selected_vault_ids.length === 1 ? '' : 's'}` : ''}
            ${renderMetaPill(`Rewrite ${REWRITE_COVERAGE_LABELS[normalizeRewriteCoverage(batchQueueState.rewrite_coverage)] || `${Math.round(normalizeRewriteCoverage(batchQueueState.rewrite_coverage) * 100)}%`}`)}
            ${renderMetaPill(STRICTNESS_LABELS[batchQueueState.strictness] || batchQueueState.strictness || 'Balanced')}
          </div>
        </div>
      </div>
      ${batchQueueState.items.map((item) => {
        const summary = item.status === 'complete'
          ? `ATS ${item.ats_before ?? '?'} ? ${item.ats_after ?? '?'} ? ${item.change_count || 0} bullet suggestion${item.change_count === 1 ? '' : 's'}`
          : item.status === 'failed'
            ? (item.error || 'Run failed')
            : item.status === 'running'
              ? 'Tailoring in progress...'
              : 'Waiting in queue';
        return `
          <div class="batch-run-item ${item.status || 'pending'}">
            <div class="batch-job-copy">
              <div class="batch-job-title">${esc(item.title || 'Untitled role')} @ ${esc(item.company || 'Unknown company')}</div>
              <div class="batch-run-meta">${renderMetaPill(item.status || 'pending')}${item.source ? renderMetaPill(jobSourceLabel(item.source)) : ''}</div>
              <div class="batch-run-summary">${esc(summary)}</div>
            </div>
            <div class="batch-run-actions">
              ${item.session_id ? `<button class="btn btn-sm btn-secondary batch-open-session" data-session-id="${item.session_id}">Open</button>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    `;

    container.querySelectorAll('.batch-open-session').forEach((button) => {
      button.addEventListener('click', async () => {
        await loadSessionResults(Number(button.dataset.sessionId));
      });
    });
  }

  async function processBatchQueue() {
    if (batchQueueRunning || !batchQueueState?.items?.length) return;
    batchQueueRunning = true;
    updateTailorBtn();
    renderBatchQueueStatus();

    let completedThisRun = 0;
    let failedThisRun = 0;

    try {
      while (true) {
        const nextItem = batchQueueState.items.find((item) => item.status === 'pending');
        if (!nextItem) break;

        nextItem.status = 'running';
        saveBatchQueueState();
        renderBatchQueueStatus();

        try {
          const result = await Store.tailor(batchQueueState.profile_id, nextItem.job_id, {
            genre_id: batchQueueState.genre_id,
            strictness: batchQueueState.strictness,
            rewrite_coverage: normalizeRewriteCoverage(batchQueueState.rewrite_coverage),
            selected_vault_ids: batchQueueState.selected_vault_ids || [],
          });
          const report = parseJSON(result.replacements || result.report) || {};
          const metrics = report.metrics || {};
          nextItem.status = 'complete';
          nextItem.session_id = Number(result.id || result.session_id || 0);
          nextItem.ats_before = metrics.before?.ats_score ?? null;
          nextItem.ats_after = metrics.after?.ats_score ?? null;
          nextItem.change_count = Array.isArray(report.changes) ? report.changes.length : 0;
          nextItem.warning_count = Array.isArray(report.warnings) ? report.warnings.length : 0;
          completedThisRun += 1;
          if (tailorViewSnapshot) {
            tailorViewSnapshot.sessions = await Store.getSessions();
            renderBatchJobList(tailorViewSnapshot.jobs, tailorViewSnapshot.sessions);
          }
          loadDashboard();
        } catch (error) {
          nextItem.status = 'failed';
          nextItem.error = error.message || 'Batch run failed';
          failedThisRun += 1;
        }

        saveBatchQueueState();
        renderBatchQueueStatus();
      }
    } finally {
      batchQueueRunning = false;
      saveBatchQueueState();
      renderBatchQueueStatus();
      updateTailorBtn();
    }

    if (completedThisRun || failedThisRun) {
      toast(`Batch complete: ${completedThisRun} finished, ${failedThisRun} failed.`, failedThisRun ? 'error' : 'success');
    }
  }

  function resumeBatchQueueIfNeeded() {
    if (!batchQueueState?.items?.some((item) => item.status === 'pending')) return;
    processBatchQueue().catch((error) => toast(error.message, 'error'));
  }

  function renderTailorPreflight(profiles, jobs, genres, sessions, rawVaultItems) {
    const container = document.getElementById('tailorPreflight');
    if (!container) return;
    const profile = profiles.find((item) => Number(item.id) === Number(document.getElementById('tailorProfile').value));
    const selectedJobId = Number(document.getElementById('tailorJob').value);
    const genre = normalizeGenre(genres.find((item) => Number(item.id) === Number(document.getElementById('tailorGenre').value)));
    const strictness = document.getElementById('tailorStrictness').value || 'balanced';
    const job = selectedJobId
      ? jobs.find((item) => Number(item.id) === selectedJobId)
      : {
          company: document.getElementById('newJobCompany').value.trim(),
          title: document.getElementById('newJobTitle').value.trim(),
          description: document.getElementById('newJobDesc').value.trim(),
        };

    if (!profile) {
      tailorVaultSelection.clear();
      tailorVaultSelectionManual = false;
      tailorVaultSelectionContextKey = '';
      container.innerHTML = '<p class="empty-state">Select a profile, genre, and job to preview the run.</p>';
      return;
    }

    const vaultItems = buildVaultItems(rawVaultItems, profiles, sessions)
      .filter((item) => Number(item.profile_id) === Number(profile.id));
    const contextKey = buildTailorSelectionContextKey(profile, genre, strictness, selectedJobId, job);
    const recommendationPreview = buildVaultSectionPlan(profile, vaultItems, job?.description || '', genre, UI_LIMITS.tailor.sectionItemsPerSection);
    if (tailorVaultSelectionContextKey !== contextKey) {
      tailorVaultSelection.clear();
      tailorVaultSelectionManual = false;
      tailorVaultSelectionContextKey = contextKey;
    }
    if (!tailorVaultSelectionManual) {
      tailorVaultSelection.clear();
      (recommendationPreview.recommendedIds || []).forEach((id) => tailorVaultSelection.add(Number(id)));
    }
    const context = getRunContext(profile, genre, strictness, job?.description || '', vaultItems, {
      selected_vault_ids: [...tailorVaultSelection],
    });
    const sectionPlan = context.sectionPlan || recommendationPreview;
    const selectedIds = new Set([...tailorVaultSelection].map((id) => Number(id)));
    container.innerHTML = `
      <div class="preflight-title">Preflight</div>
      <div class="preflight-row"><span class="preflight-label">Profile</span><span class="preflight-value">${esc(profile.name)}</span></div>
      <div class="preflight-row"><span class="preflight-label">Genre</span><span class="preflight-value">${esc(genre?.name || 'No genre')}</span></div>
      <div class="preflight-row"><span class="preflight-label">Job</span><span class="preflight-value">${esc(job?.title || 'New job draft')}</span></div>
      <div class="preflight-row"><span class="preflight-label">Job Source</span><span class="preflight-value">${esc(jobSourceLabel(job?.source || (selectedJobId ? 'manual' : 'draft')))}</span></div>
      <div class="preflight-row"><span class="preflight-label">Mode</span><span class="preflight-value">${esc(STRICTNESS_LABELS[strictness] || 'Balanced')}</span></div>
      <div class="preflight-row"><span class="preflight-label">Rewrite Coverage</span><span class="preflight-value">${esc(REWRITE_COVERAGE_LABELS[rewriteCoverage] || `${Math.round(rewriteCoverage * 100)}%`)}</span></div>
      <div class="preflight-row"><span class="preflight-label">Risk Level</span><span class="preflight-value">${esc(context.unsupportedRisk)}</span></div>
      <div class="preflight-row"><span class="preflight-label">Selected Source Items</span><span class="preflight-value">${context.selectedCount}</span></div>
      <div class="preflight-list">${context.likely.length ? context.likely.map((item) => `<span class="tag">${esc(item.title)}</span>`).join('') : '<span class="field-hint">Select a job to surface matching proof.</span>'}</div>
      <div class="preflight-section-plan">
        <div class="preflight-section-plan-header">
          <div>
            <div class="field-label" style="margin:0">Section-Aware Vault Plan</div>
            <div class="field-hint">Choose which saved source bullets can be pulled into each CV section for this run.</div>
          </div>
          <div class="tailor-batch-actions">
            <button class="btn btn-sm btn-ghost" id="tailorUseRecommendedVault" type="button">Use Recommended</button>
            <button class="btn btn-sm btn-ghost" id="tailorClearVaultSelection" type="button">Clear</button>
          </div>
        </div>
        <div class="preflight-section-groups">
          ${sectionPlan.groups?.length ? sectionPlan.groups.map((group) => `
            <div class="preflight-section-group">
              <div class="preflight-section-title">
                <strong>${esc(group.label)}</strong>
                <span class="meta-pill">${group.items.filter((item) => selectedIds.has(Number(item.id))).length} selected</span>
              </div>
              <div class="preflight-section-items">
                ${group.items.length ? group.items.map((item) => `
                  <label class="preflight-section-item">
                    <input class="tailor-vault-toggle" type="checkbox" data-vault-id="${item.id}" ${selectedIds.has(Number(item.id)) ? 'checked' : ''}>
                    <div class="preflight-section-copy">
                      <strong>${esc(item.title || 'Saved Experience')}</strong>
                      <span>${esc(trunc(item.preferred_bullet || item.text || '', 120))}</span>
                      <span class="preflight-support">${esc(item.tag || 'general')} ? match ${item.match_score || 0}</span>
                    </div>
                  </label>
                `).join('') : '<div class="preflight-section-item"><div class="preflight-section-copy"><strong>No addition suggested</strong><span>No grounded vault item is being recommended for this section yet.</span></div></div>'}
              </div>
            </div>
          `).join('') : '<p class="empty-state">No section-aware source additions matched this job yet. Add more vault items or broaden the job details.</p>'}
        </div>
      </div>
    `;

    container.querySelectorAll('.tailor-vault-toggle').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const vaultId = Number(checkbox.dataset.vaultId);
        tailorVaultSelectionManual = true;
        if (checkbox.checked) tailorVaultSelection.add(vaultId);
        else tailorVaultSelection.delete(vaultId);
        renderTailorPreflight(profiles, jobs, genres, sessions, rawVaultItems);
        updateTailorBtn();
      });
    });
    document.getElementById('tailorUseRecommendedVault')?.addEventListener('click', () => {
      tailorVaultSelectionManual = false;
      renderTailorPreflight(profiles, jobs, genres, sessions, rawVaultItems);
      updateTailorBtn();
    });
    document.getElementById('tailorClearVaultSelection')?.addEventListener('click', () => {
      tailorVaultSelectionManual = true;
      tailorVaultSelection.clear();
      renderTailorPreflight(profiles, jobs, genres, sessions, rawVaultItems);
      updateTailorBtn();
    });
  }

  document.getElementById('runTailor').addEventListener('click', async () => {
    let jobId = document.getElementById('tailorJob').value;
    const profileId = document.getElementById('tailorProfile').value;
    const genreId = document.getElementById('tailorGenre').value;
    const strictness = document.getElementById('tailorStrictness').value || 'balanced';
    const rewriteCoverage = normalizeRewriteCoverage(document.getElementById('tailorRewriteCoverage')?.value || getTailorRewriteCoverage());
    if (!getApiKey() && !(serverMode && serverHasDefaultKey)) {
      settingsModal.classList.add('open');
      return toast('Set your API key first', 'error');
    }
    if (!profileId) return toast('Select a profile', 'error');

    if (!jobId) {
      const company = document.getElementById('newJobCompany').value.trim();
      const title = document.getElementById('newJobTitle').value.trim();
      const description = document.getElementById('newJobDesc').value.trim();
      const url = document.getElementById('newJobUrl').value.trim();
      if (!company || !title || !description) return toast('Fill the job form', 'error');
      try {
        const result = await Store.saveJob({ company, title, description, url });
        invalidateTailorSnapshot();
        jobId = result.id;
      } catch (err) { return toast(err.message, 'error'); }
    }

    // Show pipeline
    const statusEl = document.getElementById('pipelineStatus');
    statusEl.style.display = 'block';
    startPipelineTimer();
    const stages = statusEl.querySelectorAll('.pipeline-stage');
    stages.forEach(s => s.classList.remove('active', 'done'));
    document.getElementById('runTailor').disabled = true;

    // For server mode ? simulate stage progression
    let stageIdx = 0;
    stages[0].classList.add('active');
    const interval = serverMode ? setInterval(() => {
      if (stageIdx < stages.length - 1) {
        stages[stageIdx].classList.remove('active');
        stages[stageIdx].classList.add('done');
        stageIdx++;
        stages[stageIdx].classList.add('active');
      }
    }, 5000) : null;

    try {
      const result = await Store.tailor(profileId, jobId, {
        genre_id: genreId ? Number(genreId) : null,
        strictness,
        rewrite_coverage: rewriteCoverage,
        selected_vault_ids: [...tailorVaultSelection],
      });
      if (interval) clearInterval(interval);
      stopPipelineTimer(result?.tokenUsage?.timings?.total_ms || (Date.now() - pipelineStartedAt));
      stages.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
      toast('Tailoring complete!', 'success');
      setTimeout(() => {
        currentSession = result;
        navigate('results');
      }, 500);
    } catch (err) {
      console.error('Frontend Tailoring Error:', err);
      if (interval) clearInterval(interval);
      stopPipelineTimer();
      stages.forEach(s => s.classList.remove('active'));
      document.getElementById('runTailor').disabled = false;
      toast(err.message, 'error');
    }
  });

  function updatePipelineUI(stage) {
    const stages = document.querySelectorAll('#pipelineStatus .pipeline-stage');
    const order = ['parse', 'analyze', 'replace', 'verify', 'done'];
    const idx = order.indexOf(stage);
    stages.forEach((s, i) => {
      s.classList.remove('active', 'done');
      if (i < idx) s.classList.add('done');
      else if (i === idx && stage !== 'done') s.classList.add('active');
      else if (stage === 'done') s.classList.add('done');
    });
  }

  function deriveStoryTitle(story) {
    const source = String(story.title || story.text || story.preferred_bullet || '').trim();
    if (!source) return 'Saved Experience';
    return source.split(/[.!?]/)[0].slice(0, 56);
  }

  async function saveVaultStory(profileId, vaultItemId, storyInput) {
    const profile = await Store.getProfile(Number(profileId));
    if (!profile) throw new Error('Profile not found for vault item');
    const normalized = normalizeStory({
      ...storyInput,
      title: storyInput.title || deriveStoryTitle(storyInput),
      updated_at: new Date().toISOString(),
      created_at: storyInput.created_at || new Date().toISOString(),
    }, 0);

    await Store.saveVaultItem({
      id: vaultItemId > 0 ? Number(vaultItemId) : undefined,
      profile_id: Number(profileId),
      title: normalized.title,
      tag: normalized.tag,
      section_hint: normalized.section_hint || '',
      status: normalized.status,
      text: normalized.text,
      preferred_bullet: normalized.preferred_bullet,
      source: storyInput.source || 'manual',
      created_at: normalized.created_at,
    });
    invalidateTailorSnapshot();
    return normalized;
  }

  async function removeVaultStory(vaultItemId) {
    await Store.deleteVaultItem(Number(vaultItemId));
    invalidateTailorSnapshot();
  }

  async function buildLikelyVaultMatchesForSession(session) {
    if (!session?.profile_id) return [];
    const [profiles, sessions, jobs, vaultItems] = await Promise.all([
      Store.getProfiles(),
      Store.getSessions(),
      Store.getJobs(),
      Store.getVaultItems(),
    ]);
    const job = jobs.find((item) => Number(item.id) === Number(session.job_id));
    const genre = normalizeGenre(
      (await Store.getGenres()).find((item) => String(item.name || '').toLowerCase() === String(session.genre_name || '').toLowerCase())
    );
    const hydrated = buildVaultItems(vaultItems, profiles, sessions)
      .filter((item) => Number(item.profile_id) === Number(session.profile_id));
    return matchVaultItems(hydrated, job?.description || '', genre, UI_LIMITS.tailor.topVaultMatches);
  }

  function renderEditedLatexCode(originalLatex, editedLatex) {
    const pre = document.getElementById('editedLatexPre');
    if (!pre) return;
    pre.innerHTML = getSemanticDiffHtml(originalLatex || '', editedLatex || '');
  }

  function renderGithubDiffLines(originalText, editedText) {
    const lines = buildLineDiff(originalText, editedText);
    if (!lines.length) {
      return '<div class="github-line context"><span class="github-prefix"> </span><span class="github-code">No visible text change</span></div>';
    }
    return lines.map((line) => {
      const className = line.type === 'added'
        ? 'add'
        : (line.type === 'removed' ? 'remove' : 'context');
      const prefix = line.type === 'added'
        ? '+'
        : (line.type === 'removed' ? '-' : ' ');
      return `<div class="github-line ${className}"><span class="github-prefix">${prefix}</span><span class="github-code">${esc(line.text || '')}</span></div>`;
    }).join('');
  }

  function renderAcceptedChangeStack(changes) {
    const container = document.getElementById('acceptedChangeStack');
    if (!container) return;
    const materialChanges = (changes || [])
      .map((change, index) => ({ change, index }))
      .filter((entry) => isMaterialChange(entry.change));
    const accepted = materialChanges.filter((entry) => changeDecisionState.get(entry.index) === 'accepted');
    const rejected = materialChanges.filter((entry) => changeDecisionState.get(entry.index) === 'rejected');
    const pending = materialChanges.filter((entry) => !changeDecisionState.has(entry.index));

    if (!materialChanges.length) {
      container.innerHTML = '<p class="empty-state">No material edits are being tracked for this run.</p>';
      return;
    }

    container.innerHTML = `
      <div class="github-change-list">
        <div class="github-change-summary">
          ${renderMetaPill(`${accepted.length} accepted`)}
          ${renderMetaPill(`${rejected.length} kept original`)}
          ${renderMetaPill(`${pending.length} pending`)}
        </div>
        ${accepted.map(({ change }) => `
          <div class="github-change-card accepted">
            <div class="github-change-header">
              <div>
                <div class="github-change-title"><span class="github-status accepted">Accepted</span>${esc(change.section_name || 'General')}</div>
                <div class="github-change-copy">${esc(change.reason || 'Approved change')}</div>
              </div>
              <span class="meta-pill">resume.tex</span>
            </div>
            <div class="github-change-lines">${renderGithubDiffLines(change.original_text, change.edited_text)}</div>
          </div>
        `).join('')}
        ${rejected.length ? rejected.map(({ change }) => `
          <div class="github-change-card excluded">
            <div class="github-change-header">
              <div>
                <div class="github-change-title"><span class="github-status excluded">Kept Original</span>${esc(change.section_name || 'General')}</div>
                <div class="github-change-copy">${esc(change.reason || 'Original wording kept')}</div>
              </div>
              <span class="meta-pill">resume.tex</span>
            </div>
            <div class="github-change-lines">${renderGithubDiffLines(change.original_text, change.edited_text)}</div>
          </div>
        `).join('') : ''}
        ${pending.length ? pending.map(({ change }) => `
          <div class="github-change-card pending">
            <div class="github-change-header">
              <div>
                <div class="github-change-title"><span class="github-status pending">Pending</span>${esc(change.section_name || 'General')}</div>
                <div class="github-change-copy">${esc(change.reason || 'Awaiting review')}</div>
              </div>
              <span class="meta-pill">resume.tex</span>
            </div>
            <div class="github-change-lines">${renderGithubDiffLines(change.original_text, change.edited_text)}</div>
          </div>
        `).join('') : ''}
      </div>
    `;
  }

  function setLatexEditorState(text, mode = 'synced') {
    const state = document.getElementById('latexEditorState');
    if (!state) return;
    state.textContent = text;
    state.dataset.mode = mode;
  }

  function setLatexCompileStatus(text) {
    const el = document.getElementById('latexCompileStatus');
    if (el) el.textContent = text;
  }

  function clearDraftAtsInsights(message = '') {
    const metricsEl = document.getElementById('latexDraftMetrics');
    const missingEl = document.getElementById('latexDraftMissing');
    if (metricsEl) {
      metricsEl.innerHTML = message ? `<p class="empty-state">${esc(message)}</p>` : '';
    }
    if (missingEl) {
      missingEl.textContent = '';
    }
  }

  function renderDraftAtsInsights(payload) {
    const metricsEl = document.getElementById('latexDraftMetrics');
    const missingEl = document.getElementById('latexDraftMissing');
    if (!metricsEl || !missingEl) return;

    const metrics = payload?.metrics || {};
    const alignment = payload?.alignment || {};
    const criticalCovered = (metrics.matched_critical || []).length;
    const criticalTotal = criticalCovered + ((metrics.missing_critical || []).length || 0);
    metricsEl.innerHTML = [
      metricChip('Draft ATS', metrics.ats_score ?? '?'),
      metricChip('Critical', criticalTotal ? `${criticalCovered}/${criticalTotal}` : 'n/a', criticalCovered === criticalTotal ? 90 : 60),
      metricChip('Title Fit', metrics.title_alignment_score ?? '?'),
      metricChip('Role Fit', metrics.role_family_score ?? '?'),
      metricChip('Relevance', metrics.bm25_requirement_score ?? '?'),
      metricChip('Readability', metrics.recruiter_readability_score ?? '?'),
      metricChip('Impact', metrics.quantified_impact ?? '?'),
    ].join('');

    const priorities = limitItems(alignment.priority_gaps || [], UI_LIMITS.results.heroPriorityGaps).map((gap) => gap.keyword);
    missingEl.textContent = priorities.length
      ? `Next priorities: ${priorities.join(', ')}`
      : ((metrics.missing_critical || []).length
        ? `Still missing: ${limitItems(metrics.missing_critical || [], UI_LIMITS.results.heroMissingKeywords).join(', ')}`
        : 'All critical requirements are currently represented in the draft.');
  }

  async function refreshDraftAtsInsights(latex) {
    const parsedReq = parseJSON(currentSession?.parsed_req || currentSession?.parsedReq);
    if (!serverMode || !parsedReq || !latex) {
      clearDraftAtsInsights(serverMode ? 'Draft ATS preview will appear after a run.' : '');
      return;
    }

    const requestId = ++draftAtsRequestId;
    try {
      const payload = await apiFetch('/ats/analyze', {
        method: 'POST',
        body: JSON.stringify({
          latex,
          parsed_req: parsedReq,
          stories: (currentSession?.vault_matches || []).map((item) => ({
            tag: item.tag,
            text: item.text,
            preferred_bullet: item.preferred_bullet,
          })),
        }),
      });
      if (requestId !== draftAtsRequestId) return;
      renderDraftAtsInsights(payload);
    } catch (error) {
      if (requestId !== draftAtsRequestId) return;
      clearDraftAtsInsights('Draft ATS preview unavailable.');
    }
  }

  function scheduleDraftAtsRefresh(latex) {
    if (draftAtsTimer) clearTimeout(draftAtsTimer);
    draftAtsTimer = setTimeout(() => {
      refreshDraftAtsInsights(latex);
    }, DRAFT_ATS_DEBOUNCE_MS);
  }

  function setCompiledPdfPreview(latex) {
    const frame = document.getElementById('compiledPdfFrame');
    const empty = document.getElementById('compiledPdfEmpty');
    if (frame) {
      frame.value = latex || '';
      frame.style.display = 'block';
    }
    if (empty) empty.style.display = 'none';
  }


  function clearCompiledPdfPreview() {
    lastCompiledLatex = '';
    const frame = document.getElementById('compiledPdfFrame');
    const empty = document.getElementById('compiledPdfEmpty');
    if (frame) {
      frame.value = '';
      frame.style.display = 'none';
    }
    if (empty) empty.style.display = 'block';
  }


  function setCoverLetterPdfPreview(latex) {
    const frame = document.getElementById('coverLetterPdfFrame');
    const empty = document.getElementById('coverLetterPdfEmpty');
    if (frame) {
      frame.value = latex || '';
      frame.style.display = 'block';
    }
    if (empty) empty.style.display = 'none';
  }


  function clearCoverLetterPdfPreview() {
    const frame = document.getElementById('coverLetterPdfFrame');
    const empty = document.getElementById('coverLetterPdfEmpty');
    if (frame) {
      frame.value = '';
      frame.style.display = 'none';
    }
    if (empty) empty.style.display = 'block';
  }


  function isCvLatexPreviewTab(tab = activeResultsTab) {
    return tab === 'changes' || tab === 'latex';
  }

  function setCoverLetterStatus(state = 'empty', message = '') {
    const content = document.getElementById('coverLetterContent');
    if (!content) return;
    const titles = {
      empty: 'No LaTeX cover letter yet',
      generating: 'Generating LaTeX cover letter',
      ready: 'LaTeX cover letter ready',
      compiled: 'PDF preview up to date',
      error: 'Cover letter LaTeX error',
    };
    const tone = state === 'error'
      ? 'error'
      : (state === 'compiled' ? 'ready' : (state === 'generating' ? 'pending' : 'neutral'));
    content.innerHTML = `
      <div class="cover-letter-status-card ${tone}">
        <div class="cover-letter-status-title">${esc(titles[state] || 'Cover Letter')}</div>
        <div class="cover-letter-status-copy">${esc(message || '')}</div>
      </div>
    `;
  }

  function syncCoverLetterUi(options = {}) {
    const latexPre = document.getElementById('coverLetterLatexPre');
    const copyLatexBtn = document.getElementById('copyCoverLetterLatex');
    const downloadLatexBtn = document.getElementById('downloadCoverLetterTex');
    const compileBtn = document.getElementById('compileCoverLetter');
    const hasLatex = Boolean(currentSession?.cover_letter_latex);
    if (latexPre) {
      latexPre.textContent = currentSession?.cover_letter_latex || 'No cover letter LaTeX generated yet.';
    }
    if (copyLatexBtn) copyLatexBtn.style.display = hasLatex ? 'inline-flex' : 'none';
    if (downloadLatexBtn) downloadLatexBtn.style.display = hasLatex ? 'inline-flex' : 'none';
    if (compileBtn) compileBtn.style.display = hasLatex ? 'inline-flex' : 'none';

    const statusState = options.statusState || (hasLatex ? 'ready' : 'empty');
    const statusMessage = options.statusMessage || (
      hasLatex
        ? 'The generated LaTeX source is loaded and ready for preview.'
        : 'Generate strings to produce the LaTeX source for this cover letter.'
    );
    setCoverLetterStatus(statusState, statusMessage);
  }



  function getCompileBackendChoice(latex = '', options = {}) {
    return {
      backend: 'web',
      label: 'Web Preview',
      reason: 'The web version displays raw LaTeX source directly.',
    };
  }




  async function compileLatexToBlob(latex) {
    return { blob: null, backend: { label: 'Web Preview' }, fallbackUsed: false };
  }


  async function compileCoverLetterLatex(options = {}) {
    const latex = options.latexOverride || currentSession?.cover_letter_latex || '';
    if (!latex) {
      setCoverLetterStatus('empty', 'Generate the cover letter first to preview the LaTeX source.');
      return;
    }
    setCoverLetterPdfPreview(latex);
    setCoverLetterStatus('compiled', 'The LaTeX source preview is up to date.');
  }


  function updateAutoCompileButton() {
    const button = document.getElementById('toggleAutoCompile');
    if (!button) return;
    button.textContent = autoCompileEnabled ? 'Auto Preview On' : 'Auto Preview Off';
    button.classList.toggle('btn-auto-on', autoCompileEnabled);
  }

  function defaultCompileStatusText(isEditing = false, latex = '') {
    return 'The web edition displays raw LaTeX source. Download the .tex file for local compilation.';
  }


  function getCurrentLatexDraft() {
    const editor = document.getElementById('latexEditor');
    if (editor && editor.value) return editor.value;
    return currentSession?.edited_latex || currentSession?.editedLatex || '';
  }

  function syncLatexStudio(latex, originalLatex, options = {}) {
    const editor = document.getElementById('latexEditor');
    if (editor && editor.value !== (latex || '')) editor.value = latex || '';
    queueLatexSurfaceRefresh(latex || '', originalLatex || '', { forceDiff: activeResultsTab === 'latex' });
    setLatexEditorState(options.stateText || 'Synced', options.stateMode || 'synced');
    if (options.statusText) {
      setLatexCompileStatus(options.statusText);
    }
    if (activeResultsTab === 'latex') {
      scheduleDraftAtsRefresh(latex || '');
    }
  }




  async function compileCurrentLatex(options = {}) {
    const latex = options.latexOverride || getCurrentLatexDraft();
    if (!latex) return;
    setCompiledPdfPreview(latex);
    lastCompiledLatex = latex;
    setLatexEditorState('Synced', 'compiled');
    setLatexCompileStatus('Web Preview is up to date.');
  }


  // ??????????????????????????????????????????????????????????????????
  // RESULTS
  // ??????????????????????????????????????????????????????????????????
  async function loadSessionResults(sessionId) {
    try {
      currentSession = await Store.getSession(sessionId);
      navigate('results');
    } catch (err) { toast(err.message, 'error'); }
  }

  // Tabs
  function setActiveTab(tab) {
    activeResultsTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    const workspace = document.getElementById('resultsWorkspace');
    if (workspace) workspace.dataset.activeTab = tab;
    if ((tab === 'changes' || tab === 'latex') && currentSession) {
      const latex = getCurrentLatexDraft();
      const originalLatex = currentSession.original_latex || '';
      queueLatexSurfaceRefresh(latex, originalLatex, { forceDiff: tab === 'latex' });
      if (tab === 'latex') {
        scheduleDraftAtsRefresh(latex);
      }
    }

    if (tab === 'coverletter' && currentSession?.cover_letter_latex && !coverLetterPdfUrl) {
      compileCoverLetterLatex({ quiet: true }).catch(() => {});
    }
  }

  function chooseDefaultResultsTab(report, vaultMatches = []) {
    const safeChanges = report?.changes?.filter((change) => {
      return !change?.validation?.hallucinated && change?.validation?.exact_match !== false;
    }).length || 0;
    if (safeChanges > 0) return 'changes';
    if ((vaultMatches || []).length > 0) return 'corpus';
    if (report?.changes?.length > 0) return 'changes';
    return 'sections';
  }

  function getAcceptedMaterialIndices(report) {
    return sortNumericList((report?.changes || [])
      .map((change, index) => (acceptedChanges.has(index) && isMaterialChange(change) ? index : null))
      .filter((index) => index != null));
  }

  function getRejectedMaterialIndices(report) {
    return sortNumericList((report?.changes || [])
      .map((change, index) => (changeDecisionState.get(index) === 'rejected' && isMaterialChange(change) ? index : null))
      .filter((index) => index != null));
  }

  function syncAppliedReviewState(report, editedLatex, acceptedIndices, rejectedIndices = []) {
    const normalizedReport = report && typeof report === 'object' ? report : {};
    const appliedReview = normalizedReport?.applied_review;
    if (!appliedReview) return normalizedReport;
    const storedAccepted = sortNumericList(appliedReview.accepted_indices || []);
    const storedRejected = sortNumericList(appliedReview.rejected_indices || []);
    const currentAccepted = sortNumericList(acceptedIndices || []);
    const currentRejected = sortNumericList(rejectedIndices || []);
    const sameSelection = JSON.stringify(storedAccepted) === JSON.stringify(currentAccepted);
    const sameKeptOriginal = JSON.stringify(storedRejected) === JSON.stringify(currentRejected);
    const sameLatex = String(appliedReview.edited_latex || '') === String(editedLatex || '');
    normalizedReport.applied_review = {
      ...appliedReview,
      stale: !(sameSelection && sameKeptOriginal && sameLatex),
    };
    return normalizedReport;
  }

  function formatReviewVerdict(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'improved') return 'Improved';
    if (normalized === 'mixed') return 'Mixed';
    if (normalized === 'unchanged') return 'Unchanged';
    if (normalized === 'worse') return 'Worse';
    return 'Review';
  }

  function formatReviewReadiness(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'ready') return 'Ready';
    if (normalized === 'review_first') return 'Review First';
    if (normalized === 'revise_again') return 'Revise Again';
    return 'Pending';
  }

  function renderDeltaChip(label, payload) {
    if (!payload || (!Number.isFinite(Number(payload.before)) && !Number.isFinite(Number(payload.after)))) return '';
    const delta = Number(payload.delta || 0);
    const className = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    return `<span class="delta-chip ${className}">${esc(label)} ${esc(sign)}</span>`;
  }

  function renderAppliedReview(appliedReview) {
    const card = document.getElementById('appliedReviewCard');
    const content = document.getElementById('appliedReviewContent');
    const actions = document.getElementById('appliedReviewHeaderActions');
    if (!card || !content || !actions) return;

    card.style.display = 'block';

    if (!appliedReview) {
      actions.innerHTML = renderMetaPill('Pending');
      content.innerHTML = '<p class="empty-state">Apply your chosen edits, then run a review to compare the accepted draft against the original CV.</p>';
      return;
    }

    const review = appliedReview.model_review || {};
    const readiness = review.review_readiness || {};
    const metricDelta = appliedReview.metrics?.delta || {};
    const selection = appliedReview.selection_summary || {};
    const verdictClass = String(review.verdict || 'unchanged').toLowerCase();
    const wins = review.wins || [];
    const regressions = review.regressions || [];
    const stillMissing = review.still_missing || [];
    const nextActions = review.next_actions || [];
    const keptOriginalCount = Number(selection.kept_original_count ?? selection.rejected_count ?? 0);
    const pendingCount = Number(selection.pending_count ?? 0);
    const deltaMarkup = [
      renderDeltaChip('ATS', metricDelta.ats_score),
      renderDeltaChip('Title Fit', metricDelta.title_alignment_score),
      renderDeltaChip('Role Fit', metricDelta.role_family_score),
      renderDeltaChip('Relevance', metricDelta.bm25_requirement_score),
      renderDeltaChip('Readability', metricDelta.recruiter_readability_score),
      renderDeltaChip('Critical', metricDelta.critical_keyword_match),
      renderDeltaChip('Impact', metricDelta.quantified_impact),
    ].filter(Boolean).join('');

    actions.innerHTML = [
      renderMetaPill(appliedReview.stale ? 'Outdated review' : 'Current review'),
      renderMetaPill(formatReviewReadiness(readiness.status)),
      renderMetaPill(fmtDate(appliedReview.reviewed_at || '')),
    ].join('');

    content.innerHTML = `
      <div class="applied-review-grid">
        <div>
          <div class="applied-review-meta">
            <span class="review-status-badge ${esc(verdictClass)}">${esc(formatReviewVerdict(review.verdict))}</span>
            ${renderMetaPill(`${selection.accepted_count || 0} accepted`)}
            ${renderMetaPill(`${keptOriginalCount} kept original`)}
            ${pendingCount ? renderMetaPill(`${pendingCount} pending`) : ''}
          </div>
          ${appliedReview.stale ? `<div class="applied-review-note review-note-block"><strong>Review is outdated</strong>Selections changed after the last review. Run the review again to refresh the metric delta and final verdict.</div>` : ''}
          <div class="applied-review-copy">
            <strong>${esc(review.headline || 'Applied draft reviewed')}</strong><br>
            ${esc(review.summary || 'Review this accepted draft against the original CV to understand what improved and what still needs attention.')}
          </div>
          ${review.metric_interpretation ? `<div class="review-suggestion review-note-block">${esc(review.metric_interpretation)}</div>` : ''}
          <div class="applied-review-list stack-gap-sm">
            <div class="applied-review-section">
              <h4>Wins</h4>
              ${wins.length ? `<ul>${wins.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="field-hint">No material gains were called out.</p>'}
            </div>
            <div class="applied-review-section">
              <h4>Regressions</h4>
              ${regressions.length ? `<ul>${regressions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="field-hint">No meaningful regressions were identified.</p>'}
            </div>
            <div class="applied-review-section">
              <h4>Still Missing</h4>
              ${stillMissing.length ? `<ul>${stillMissing.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="field-hint">No major unresolved gaps were highlighted.</p>'}
            </div>
          </div>
        </div>
        <div class="applied-review-side">
          <div class="applied-review-note">
            <strong>Metric Movement</strong>
            <div class="delta-chip-row">${deltaMarkup || '<span class="field-hint">Structured ATS delta is not available for this review.</span>'}</div>
          </div>
          <div class="applied-review-note">
            <strong>Readiness</strong>
            <div>${esc(readiness.reason || 'Run the review to get a clear recommendation on whether this accepted draft is ready to move forward.')}</div>
          </div>
          <div class="applied-review-note">
            <strong>Next Actions</strong>
            ${nextActions.length ? `<ul>${nextActions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="field-hint">No next actions yet.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveTab(btn.dataset.tab);
    });
  });

  async function renderResults(data) {
    const alignment = parseJSON(data.alignment);
    const report = ensureEditableChangeState(parseJSON(data.report || data.replacements));
    const parsedReq = parseJSON(data.parsed_req || data.parsedReq);
    const tokens = parseJSON(data.token_usage || data.tokenUsage) || {};
    const appliedReview = report?.applied_review || null;
    const hasCurrentAppliedReview = Boolean(appliedReview && !appliedReview.stale);
    const activeAlignment = hasCurrentAppliedReview && appliedReview?.after_alignment
      ? appliedReview.after_alignment
      : alignment;
    const metrics = hasCurrentAppliedReview
      ? (appliedReview?.metrics || report?.metrics || alignment?.local_scores || null)
      : (report?.metrics || alignment?.local_scores || null);
    const incomingEditedLatex = data.edited_latex || data.editedLatex || '';
    const company = data.company || '';
    const jobTitle = data.job_title || data.jobTitle || '';
    const profile = data.profile_id ? await Store.getProfile(Number(data.profile_id)) : null;
    const originalLatex = profile?.latex || '';
    const likelyVaultMatches = await buildLikelyVaultMatchesForSession(data);
    const defaultTab = chooseDefaultResultsTab(report, likelyVaultMatches);
    activeResultsTab = defaultTab;
    currentSession.parsed_req = parsedReq;
    currentSession.alignment = alignment;
    currentSession.report = report;
    currentSession.applied_review = appliedReview;
    currentSession.token_usage = tokens;
    currentSession.original_latex = originalLatex;
    currentSession.vault_matches = likelyVaultMatches;
    initializeChangeDecisions(report);
    const acceptedDraftLatex = report?.changes
      ? applyReplacementChanges(
        originalLatex,
        report.changes.filter((change, index) => acceptedChanges.has(index) && isMaterialChange(change))
      )
      : incomingEditedLatex;
    const editedLatex = appliedReview
      ? (incomingEditedLatex || acceptedDraftLatex)
      : acceptedDraftLatex;
    currentSession.generated_latex = editedLatex;
    currentSession.edited_latex = editedLatex;
    currentSession.editedLatex = editedLatex;

    // Title
    document.getElementById('resultsTitle').textContent = company ? `${jobTitle} @ ${company}` : 'Results';
    document.getElementById('resultsSubtitle').textContent = [
      data.genre_name ? data.genre_name : '',
      data.strictness ? STRICTNESS_LABELS[data.strictness] || data.strictness : '',
      fmtDate(data.created_at)
    ].filter(Boolean).join(' ? ');
    document.getElementById('sessionOutcome').value = data.outcome || '';
    clearCompiledPdfPreview();
    syncLatexStudio(editedLatex, originalLatex, {
      stateText: 'Synced',
      stateMode: 'synced',
      statusText: defaultCompileStatusText(false, editedLatex),
    });
    const coverLetterGuidance = document.getElementById('coverLetterGuidance');
    if (coverLetterGuidance) {
      coverLetterGuidance.value = currentSession.cover_letter_guidance || getCoverLetterGuidance();
    }
    const interviewContent = document.getElementById('interviewContent');
    if (interviewContent) {
      interviewContent.innerHTML = currentSession.interview_prep
        ? renderInterviewPrepHtml(currentSession.interview_prep, currentSession.interview_research || '')
        : '<p class="empty-state">Click Generate to get targeted interview prep based on this job.</p>';
    }
    clearCoverLetterPdfPreview();
    syncCoverLetterUi();

    renderAppliedReview(appliedReview);

    // Score hero
    if (activeAlignment || metrics?.after) {
      const score = Number(activeAlignment?.overall_score || metrics?.after?.ats_score || 0);
      const circ = 2 * Math.PI * 52;
      const ring = document.getElementById('scoreRingFill');
      ring.style.strokeDasharray = circ;
      ring.style.strokeDashoffset = circ - (circ * score / 100);
      ring.style.stroke = scoreColor(score);
      document.getElementById('scoreNumber').textContent = score;
      document.getElementById('scoreVerdict').textContent = appliedReview?.model_review?.headline || activeAlignment?.overall_verdict || '';

      if (hasCurrentAppliedReview && metrics?.after && metrics?.before) {
        const diff = Number(metrics.after.ats_score || 0) - Number(metrics.before.ats_score || 0);
        const summary = appliedReview?.model_review?.metric_interpretation || appliedReview?.model_review?.summary || '';
        document.getElementById('scoreImprovement').innerHTML = diff > 0
          ? `<span class="score-up">+${diff} ATS</span> ? ${esc(summary)}`
          : (diff < 0
            ? `<span class="score-same">${diff} ATS</span> ? ${esc(summary)}`
            : `<span class="score-same">0 ATS</span> ? ${esc(summary)}`);
      } else if (report?.alignment_improvement) {
        const imp = report.alignment_improvement;
        const diff = (imp.after || 0) - (imp.before || 0);
        document.getElementById('scoreImprovement').innerHTML = diff > 0
          ? `<span class="score-up">+${diff} pts</span> ? Suggested-draft projection only. Accept bullets and run Review Accepted Draft for the actual current-draft movement.`
          : `<span class="score-same">Suggested draft</span> ? Review and accept bullets to confirm the current-draft movement.`;
      } else {
        document.getElementById('scoreImprovement').innerHTML = '<span class="score-same">Suggested draft</span> ? Nothing is applied until you accept individual suggestions.';
      }
    }

    if (metrics?.after) {
      const after = metrics.after;
      const criticalCovered = (after.matched_critical || []).length;
      const criticalTotal = criticalCovered + ((after.missing_critical || []).length || 0);
      document.getElementById('scoreMetrics').innerHTML = [
        metricChip('ATS', after.ats_score),
        metricChip('Recruiter', after.recruiter_readability_score),
        metricChip('Preservation', metrics.content_preservation_score ?? metrics?.suggested_after?.content_preservation_score ?? '?'),
        metricChip('Critical', criticalTotal ? `${criticalCovered}/${criticalTotal}` : 'n/a', criticalCovered === criticalTotal ? 90 : 65),
      ].join('');
      document.getElementById('runMetrics').innerHTML = renderMetrics(metrics);
    } else {
      document.getElementById('scoreMetrics').innerHTML = '';
      document.getElementById('runMetrics').innerHTML = '<p class="empty-state">No metrics yet.</p>';
    }
    renderPriorityGaps(activeAlignment);
    renderEvidenceCandidates(activeAlignment);

    updateResultsRecommendation(report);
    document.getElementById('saveAcceptedToVault').style.display = 'none';

    // Section Review tab
    if (activeAlignment?.sections) {
      document.getElementById('sectionReview').innerHTML = activeAlignment.sections.map((s, i) => {
        const col = scoreColor(s.score || 0);
        return `<div class="section-review-card" data-idx="${i}">
          <div class="section-review-header">
            <span class="section-review-name">${esc(s.name)}</span>
            <div class="section-review-bar"><div class="section-review-fill" style="width:${s.score}%;background:${col}"></div></div>
            <span class="section-review-score" style="color:${col}">${s.score}</span>
            <span class="section-review-toggle">?</span>
          </div>
          <div class="section-review-body">
            <div class="review-detail"><h4>Matched Keywords</h4><div class="keyword-list">${(s.matched_keywords || []).map(k => `<span class="keyword-match">${esc(k)}</span>`).join('')}${(s.matched_keywords || []).length === 0 ? '<span class="review-detail-empty">None</span>' : ''}</div></div>
            <div class="review-detail"><h4>Gaps</h4><div class="keyword-list">${(s.gaps || []).map(k => `<span class="keyword-gap">${esc(k)}</span>`).join('')}${(s.gaps || []).length === 0 ? '<span class="review-detail-empty">None, well covered.</span>' : ''}</div></div>
            <div class="review-detail"><h4>Suggestions</h4>${(s.suggestions || []).map(sg => `<div class="review-suggestion">? ${esc(sg)}</div>`).join('')}${(s.suggestions || []).length === 0 ? '<p class="review-detail-empty">No suggestions</p>' : ''}</div>
            ${s.story_to_weave ? `<div class="review-detail"><h4>Recommended Story</h4><p class="review-story">${esc(s.story_to_weave)}</p></div>` : ''}
          </div>
        </div>`;
      }).join('');

      document.querySelectorAll('.section-review-header').forEach(h => {
        h.addEventListener('click', () => h.closest('.section-review-card').classList.toggle('open'));
      });
    } else {
      document.getElementById('sectionReview').innerHTML = '<p class="empty-state">No section review available.</p>';
    }

    // Changes tab
    if (report?.changes) {
      document.getElementById('changesCount').textContent = getReviewableChangeEntries(report.changes, 'all').length;
      renderChanges(report.changes, 'all');
      renderAcceptedChangeStack(report.changes);
      document.getElementById('applyBar').style.display = report.changes.some((change) => isMaterialChange(change)) ? 'flex' : 'none';
      updateApplyCount(report);
      setActiveTab(defaultTab);
    } else {
      document.getElementById('changesCount').textContent = '0';
      document.getElementById('changesList').innerHTML = '<p class="empty-state">No changes suggested.</p>';
      renderAcceptedChangeStack([]);
      document.getElementById('applyBar').style.display = 'none';
      setActiveTab(defaultTab);
    }

    // Risks (replaces Assumptions)
    if (report?.risks?.length > 0) {
      document.getElementById('assumptionsCard').style.display = 'block';
      document.getElementById('assumptionsList').innerHTML = report.risks.map(r => `
        <div class="assumption-item review">
          <div class="assumption-icon">??</div>
          <div><div>${esc(r)}</div></div>
        </div>`).join('');
    } else {
      document.getElementById('assumptionsCard').style.display = 'none';
    }

    // Vault matches are deterministic local matches, not model-suggested insertions.
    if (likelyVaultMatches.length > 0) {
      document.getElementById('corpusList').innerHTML = likelyVaultMatches.map((item) => `
        <div class="corpus-card recommended">
          <div class="corpus-header">
            <span class="tag tag-recommended">grounded</span>
            <span class="corpus-action">${esc(item.tag || 'general')}</span>
            <span class="corpus-target">? ${esc(item.profile_name || '')}</span>
          </div>
          <div class="corpus-rationale">${esc(item.title || 'Saved Experience')}</div>
          <div class="corpus-draft">${esc(item.text || '')}</div>
          ${item.preferred_bullet ? `<div class="corpus-draft" style="margin-top:0.45rem">${esc(item.preferred_bullet)}</div>` : ''}
        </div>`).join('');
    } else {
      document.getElementById('corpusList').innerHTML = '<p class="empty-state">Add verified source experiences to the Vault to get grounded reuse matches here.</p>';
    }
    setCountHeading('vaultMatchesHeading', 'Best Vault Matches', likelyVaultMatches.length, likelyVaultMatches.length);

    const strategicRecommendations = Array.isArray(report?.strategic_recommendations) && report.strategic_recommendations.length
      ? report.strategic_recommendations
      : (activeAlignment?.sections || [])
        .flatMap((section) => limitItems(section.suggestions || [], UI_LIMITS.results.strategicRecommendationsPerSection).map((suggestion) => ({
          focus: section.name || 'Section',
          action: Number(section.score || 0) < 45 ? 'de-emphasize' : 'tighten',
          recommendation: suggestion,
          reason: `Section score: ${section.score || 0}`,
        })))
        .slice(0, UI_LIMITS.results.strategicRecommendationsTotal);
    setCountHeading('manualSuggestionsHeading', 'Additional Suggestions', strategicRecommendations.length, strategicRecommendations.length);
    document.getElementById('manualSuggestions').innerHTML = strategicRecommendations.length
      ? strategicRecommendations.map((item) => `
        <div class="review-suggestion">
          <strong>${esc(item.focus || 'CV')}</strong> ? ${esc(item.action || 'improve')}<br>
          ${esc(item.recommendation || '')}
          ${item.reason ? `<div class="field-hint">${esc(item.reason)}</div>` : ''}
        </div>`).join('')
      : '<p class="empty-state">No additional CV strategy suggestions yet.</p>';

    // Parsed requirements
    if (parsedReq) {
      document.getElementById('parsedReqPre').textContent = JSON.stringify(parsedReq, null, 2);
    }

    // Token usage
    if (tokens.total_tokens || tokens.by_stage) {
      let html = `<div class="token-row"><span class="token-label">Total</span><span class="token-value">${(tokens.total_tokens || 0).toLocaleString()}</span></div>`;
      if (tokens.by_stage) {
        for (const [k, v] of Object.entries(tokens.by_stage)) {
          html += `<div class="token-row"><span class="token-label">${k}</span><span class="token-value">${(v.total_tokens || 0).toLocaleString()}</span></div>`;
        }
      }
      if (tokens.timings) {
        html += `<div class="token-row"><span class="token-label">Elapsed</span><span class="token-value">${((tokens.timings.total_ms || 0) / 1000).toFixed(1)}s</span></div>`;
        ['parse_ms', 'analyze_ms', 'replace_ms', 'verify_ms'].forEach((key) => {
          if (tokens.timings[key] != null) {
            html += `<div class="token-row"><span class="token-label">${key.replace('_ms', '')}</span><span class="token-value">${(tokens.timings[key] / 1000).toFixed(1)}s</span></div>`;
          }
        });
        html += `<div class="token-row"><span class="token-label">Fast Free Mode</span><span class="token-value">${tokens.timings.fast_mode ? 'on' : 'off'}</span></div>`;
      }
      document.getElementById('tokenUsage').innerHTML = html;
    } else {
      document.getElementById('tokenUsage').innerHTML = '<p class="empty-state">No token usage recorded.</p>';
    }

    // Warnings
    if (report?.warnings?.length > 0) {
      document.getElementById('warningsList').innerHTML = report.warnings.map(w => `<div class="review-suggestion warning">? ${esc(w)}</div>`).join('');
    } else {
      document.getElementById('warningsList').innerHTML = '<p class="empty-state">None</p>';
    }
    
    // Sync the accepted draft preview from the explicitly accepted subset.
    await applySelectedChanges();
  }

  function buildLineDiff(text1, text2) {
    const before = String(text1 || '');
    const after = String(text2 || '');
    if (before === after) {
      return before.length ? [{ type: 'context', text: before }] : [];
    }

    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    let prefixLength = 0;
    while (
      prefixLength < beforeLines.length &&
      prefixLength < afterLines.length &&
      beforeLines[prefixLength] === afterLines[prefixLength]
    ) {
      prefixLength += 1;
    }

    let beforeSuffixIndex = beforeLines.length - 1;
    let afterSuffixIndex = afterLines.length - 1;
    while (
      beforeSuffixIndex >= prefixLength &&
      afterSuffixIndex >= prefixLength &&
      beforeLines[beforeSuffixIndex] === afterLines[afterSuffixIndex]
    ) {
      beforeSuffixIndex -= 1;
      afterSuffixIndex -= 1;
    }

    const beforeMiddle = beforeLines.slice(prefixLength, beforeSuffixIndex + 1);
    const afterMiddle = afterLines.slice(prefixLength, afterSuffixIndex + 1);
    const lcs = Array.from({ length: beforeMiddle.length + 1 }, () => Array(afterMiddle.length + 1).fill(0));
    for (let i = beforeMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = afterMiddle.length - 1; j >= 0; j -= 1) {
        lcs[i][j] = beforeMiddle[i] === afterMiddle[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    const diff = beforeLines.slice(0, prefixLength).map((line) => ({ type: 'context', text: line }));
    let i = 0;
    let j = 0;
    while (i < beforeMiddle.length && j < afterMiddle.length) {
      if (beforeMiddle[i] === afterMiddle[j]) {
        diff.push({ type: 'context', text: beforeMiddle[i] });
        i += 1;
        j += 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        diff.push({ type: 'removed', text: beforeMiddle[i] });
        i += 1;
      } else {
        diff.push({ type: 'added', text: afterMiddle[j] });
        j += 1;
      }
    }
    while (i < beforeMiddle.length) {
      diff.push({ type: 'removed', text: beforeMiddle[i] });
      i += 1;
    }
    while (j < afterMiddle.length) {
      diff.push({ type: 'added', text: afterMiddle[j] });
      j += 1;
    }
    beforeLines.slice(beforeSuffixIndex + 1).forEach((line) => diff.push({ type: 'context', text: line }));
    return diff;
  }

  function getSemanticDiffHtml(text1, text2) {
    return buildLineDiff(text1, text2)
      .map((line, index, all) => {
        const className = line.type === 'added'
          ? 'diff-added-line'
          : (line.type === 'removed' ? 'diff-removed-line' : 'diff-context-line');
        return `<span class="${className}">${esc(line.text || '')}</span>${index < all.length - 1 ? '\n' : ''}`;
      })
      .join('');
  }

  function latexInlineToHtml(raw) {
    let text = String(raw || '');
    const placeholders = [];
    const hold = (html) => {
      const token = `__LATEX_HTML_${placeholders.length}__`;
      placeholders.push({ token, html });
      return token;
    };

    text = text.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, (_, label) => label);
    text = text.replace(/\\textbf\{([^}]*)\}/g, (_, content) => hold(`<strong>${esc(content)}</strong>`));
    text = text.replace(/\\(?:emph|textit)\{([^}]*)\}/g, (_, content) => hold(`<em>${esc(content)}</em>`));
    text = text.replace(/\\\\/g, ' / ');
    text = text.replace(/\\(smallskip|medskip|bigskip|hfill|quad|qquad)\b/g, ' ');
    text = text.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ');
    text = text.replace(/[{}]/g, ' ');
    text = text.replace(/~/g, ' ');
    let html = esc(text).replace(/\s+/g, ' ').trim();
    placeholders.forEach(({ token, html: tokenHtml }) => {
      html = html.replace(token, tokenHtml);
    });
    return html;
  }

  function renderLatexPreview(latex) {
    const container = document.getElementById('latexPreview');
    const fullSourceTextarea = document.getElementById('compiledPdfFrame');
    const emptyState = document.getElementById('compiledPdfEmpty');

    if (fullSourceTextarea) {
      fullSourceTextarea.value = latex || '';
      if (emptyState) emptyState.style.display = 'none';
    }

    if (!container) return;

    const lines = String(latex || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      container.innerHTML = '<p class="empty-state">No preview available.</p>';
      return;
    }

    let html = '';
    let inList = false;

    const closeList = () => {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    };

    lines.forEach((line) => {
      if (line.startsWith('%') || /^\\(documentclass|usepackage|begin\{document\}|end\{document\}|begin\{flushleft\}|end\{flushleft\})/.test(line)) {
        return;
      }
      const section = line.match(/^\\section\*?\{([^}]*)\}/);
      if (section) {
        closeList();
        html += `<div class="latex-preview-section">${esc(section[1])}</div>`;
        return;
      }
      if (/^\\begin\{itemize\}/.test(line)) {
        if (!inList) {
          html += '<ul class="latex-preview-list">';
          inList = true;
        }
        return;
      }
      if (/^\\end\{itemize\}/.test(line)) {
        closeList();
        return;
      }
      if (/^\\item\b/.test(line)) {
        if (!inList) {
          html += '<ul class="latex-preview-list">';
          inList = true;
        }
        html += `<li class="latex-preview-item">${latexInlineToHtml(line.replace(/^\\item\s*/, ''))}</li>`;
        return;
      }

      closeList();
      html += `<div class="latex-preview-line">${latexInlineToHtml(line)}</div>`;
    });

    closeList();
    container.innerHTML = html || '<p class="empty-state">No preview available.</p>';
  }


  function getCurrentChangeFilter() {
    return document.querySelector('#changeFilters .pill.active')?.dataset.filter || 'all';
  }

  function getChangeDecision(index, change) {
    if (!isMaterialChange(change)) return 'unchanged';
    return changeDecisionState.get(index) || 'pending';
  }

  function setChangeDecision(index, change, decision) {
    if (!isMaterialChange(change)) {
      acceptedChanges.delete(index);
      changeDecisionState.delete(index);
      return;
    }
    if (decision === 'accepted') {
      acceptedChanges.add(index);
      changeDecisionState.set(index, 'accepted');
      return;
    }
    if (decision === 'rejected') {
      acceptedChanges.delete(index);
      changeDecisionState.set(index, 'rejected');
      return;
    }
    acceptedChanges.delete(index);
    changeDecisionState.delete(index);
  }

  function getReviewableChangeEntries(changes, filter = 'all') {
    return (changes || [])
      .map((change, index) => ({ change, index }))
      .filter((entry) => isMaterialChange(entry.change))
      .filter((entry) => filter === 'all' || entry.change.importance === filter);
  }

  function getChangeDecisionCounts(changes) {
    const entries = getReviewableChangeEntries(changes, 'all');
    const counts = {
      total: entries.length,
      accepted: 0,
      rejected: 0,
      pending: 0,
    };
    entries.forEach(({ change, index }) => {
      const decision = getChangeDecision(index, change);
      if (decision === 'accepted') counts.accepted += 1;
      else if (decision === 'rejected') counts.rejected += 1;
      else counts.pending += 1;
    });
    return counts;
  }

  function initializeChangeDecisions(report) {
    acceptedChanges.clear();
    changeDecisionState.clear();
    focusedChangeIndex = -1;
    const changes = report?.changes || [];
    const acceptedSet = new Set(sortNumericList(report?.applied_review?.accepted_indices || []));
    acceptedSet.forEach((index) => {
      const change = changes[index];
      if (change && isMaterialChange(change)) {
        setChangeDecision(index, change, 'accepted');
      }
    });
    sortNumericList(report?.applied_review?.rejected_indices || []).forEach((index) => {
      const change = changes[index];
      if (change && isMaterialChange(change) && !acceptedSet.has(index)) {
        setChangeDecision(index, change, 'rejected');
      }
    });
  }

  function buildChangeReviewRecommendation(report) {
    const appliedReview = report?.applied_review || null;
    const hasCurrentAppliedReview = Boolean(appliedReview && !appliedReview.stale);
    const counts = getChangeDecisionCounts(report?.changes || []);

    if (appliedReview?.stale) {
      return 'Selections or draft text changed after the last review. Run Review Accepted Draft again to refresh the metric movement and verdict.';
    }
    if (hasCurrentAppliedReview) {
      return appliedReview?.model_review?.review_readiness?.reason
        || appliedReview?.model_review?.summary
        || 'Applied draft review is available below.';
    }
    if (!counts.total) {
      return 'No grounded bullet rewrites were generated for this run. Use Section Review and Vault Matches to decide what to revise manually.';
    }
    if (counts.accepted === 0 && counts.rejected === 0) {
      return `Nothing is accepted by default. Review ${counts.total} suggestion${counts.total === 1 ? '' : 's'} one by one and click Accept to add a bullet to the draft.`;
    }
    if (counts.pending > 0) {
      return `${counts.accepted} accepted, ${counts.rejected} kept original, ${counts.pending} still pending. Pending suggestions stay out of the draft until you explicitly click Accept.`;
    }
    if (counts.accepted === 0) {
      return `You kept the original wording for all ${counts.total} suggestion${counts.total === 1 ? '' : 's'}. Accept a rewrite or edit the LaTeX draft directly before running the final review.`;
    }
    return `${counts.accepted} accepted and ${counts.rejected} kept original. Run Review Accepted Draft to see the metric movement for the current draft.`;
  }

  function updateResultsRecommendation(report = parseJSON(currentSession?.report || currentSession?.replacements) || {}) {
    const recommendationEl = document.getElementById('resultsRecommendationText');
    if (recommendationEl) {
      recommendationEl.textContent = buildChangeReviewRecommendation(report);
    }
  }

  function findFirstFocusedChangeIndex(changes, filter = getCurrentChangeFilter()) {
    const entries = getReviewableChangeEntries(changes, filter);
    if (!entries.length) return -1;
    return entries.find((entry) => getChangeDecision(entry.index, entry.change) === 'pending')?.index ?? entries[0].index;
  }

  function ensureFocusedChangeIndex(changes, filter = getCurrentChangeFilter()) {
    const entries = getReviewableChangeEntries(changes, filter);
    if (!entries.length) {
      focusedChangeIndex = -1;
      return -1;
    }
    const hasFocused = entries.some((entry) => entry.index === focusedChangeIndex);
    if (!hasFocused) {
      focusedChangeIndex = findFirstFocusedChangeIndex(changes, filter);
    }
    return focusedChangeIndex;
  }

  function scrollFocusedChangeIntoView() {
    const active = document.querySelector(`.change-queue-item[data-idx="${focusedChangeIndex}"]`);
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function getAdjacentFocusedIndex(changes, fromIndex, filter = getCurrentChangeFilter(), direction = 1) {
    const entries = getReviewableChangeEntries(changes, filter);
    if (!entries.length) return -1;
    const currentPos = entries.findIndex((entry) => entry.index === fromIndex);
    if (currentPos === -1) return entries[0].index;
    const nextPos = Math.min(entries.length - 1, Math.max(0, currentPos + direction));
    return entries[nextPos]?.index ?? fromIndex;
  }

  function getNextPendingFocusedIndex(changes, fromIndex, filter = getCurrentChangeFilter()) {
    const entries = getReviewableChangeEntries(changes, filter);
    if (!entries.length) return -1;
    const currentPos = entries.findIndex((entry) => entry.index === fromIndex);
    const startPos = currentPos >= 0 ? currentPos : -1;
    for (let offset = 1; offset <= entries.length; offset += 1) {
      const candidate = entries[(startPos + offset) % entries.length];
      if (candidate && getChangeDecision(candidate.index, candidate.change) === 'pending') {
        return candidate.index;
      }
    }
    return entries[Math.min(Math.max(currentPos, 0), entries.length - 1)]?.index ?? entries[0].index;
  }

  function renderChangeQueueSummary(changes) {
    const container = document.getElementById('changesQueueSummary');
    if (!container) return;
    const counts = getChangeDecisionCounts(changes);
    const totalChanges = Array.isArray(changes) ? changes.length : 0;
    const unchanged = Math.max(0, totalChanges - counts.total);
    if (!counts.total) {
      container.innerHTML = totalChanges
        ? `<p class="empty-state">${totalChanges} line${totalChanges === 1 ? ' was' : 's were'} kept as-is. No suggested bullet rewrites need review for this run.</p>`
        : '<p class="empty-state">No suggested bullet rewrites need review for this run.</p>';
      return;
    }
    const reviewed = counts.accepted + counts.rejected;
    const progress = Math.round((reviewed / Math.max(counts.total, 1)) * 100);
    container.innerHTML = `
      <div class="change-queue-progress">
        <div class="change-queue-progress-copy">
          <strong>${reviewed}/${counts.total} reviewed</strong>
          <span>${counts.pending} pending ? ${counts.accepted} accepted ? ${counts.rejected} kept original${unchanged ? ` ? ${unchanged} unchanged` : ''}</span>
        </div>
        <div class="change-queue-progress-bar"><div class="change-queue-progress-fill" style="width:${progress}%"></div></div>
      </div>
      <div class="change-queue-inline-note">Review each suggestion explicitly. Only accepted suggestions are added to the current draft.</div>
    `;
  }

  function renderFocusedChangeDetail(changes, filter = getCurrentChangeFilter()) {
    const titleEl = document.getElementById('changeReviewTitle');
    const subtitleEl = document.getElementById('changeReviewSubtitle');
    const statusEl = document.getElementById('changeReviewStatus');
    const detailEl = document.getElementById('changeReviewDetail');
    const actionsEl = document.getElementById('changeReviewActions');
    if (!titleEl || !subtitleEl || !statusEl || !detailEl || !actionsEl) return;

    const entries = getReviewableChangeEntries(changes, filter);
    const focused = ensureFocusedChangeIndex(changes, filter);
    if (!entries.length || focused < 0) {
      titleEl.textContent = 'Review Queue';
      subtitleEl.textContent = 'No suggested bullet rewrites match this filter.';
      statusEl.innerHTML = renderMetaPill('No pending suggestions');
      detailEl.innerHTML = '<p class="empty-state">Switch filters or return to Section Review if no line-level changes were suggested.</p>';
      actionsEl.innerHTML = '';
      return;
    }

    const focusedEntry = entries.find((entry) => entry.index === focused) || entries[0];
    const { change, index } = focusedEntry;
    const currentPos = entries.findIndex((entry) => entry.index === index);
    const decision = getChangeDecision(index, change);
    const trustState = getChangeTrustState(change);
    const reviewMeta = deriveChangeReviewMeta(change);
    const counts = getChangeDecisionCounts(changes);
    const hasDraftEdit = String(change.edited_text || '') !== String(change.model_edited_text || change.original_text || '');

    titleEl.textContent = `${change.section_name || 'General'} ? ${currentPos + 1} of ${entries.length}`;
    subtitleEl.textContent = decision === 'accepted'
      ? 'Accepted into the draft. Edit it if needed, or keep the original instead.'
      : (decision === 'rejected'
        ? 'Kept out of the draft. Accept it if you want this rewrite included.'
        : 'Pending review. Nothing is applied until you click Accept.');
    statusEl.innerHTML = `
      <span class="change-decision-badge ${esc(decision)}">${esc(decision === 'accepted' ? 'Accepted' : (decision === 'rejected' ? 'Kept Original' : 'Pending'))}</span>
      <span class="trust-pill ${trustState.className}">${trustState.label}</span>
      ${renderMetaPill(`${counts.pending} pending`)}
    `;

    detailEl.innerHTML = `
      <div class="review-focus-callout">
        <div class="review-focus-callout-title">Decision gate</div>
        <div class="review-focus-callout-copy">This suggestion is <strong>not</strong> in the draft until you click <strong>Accept</strong>. Keeping the original will move on without changing the CV.</div>
      </div>
      <div class="review-focus-meta">
        <span class="tag tag-${change.importance || 'optional'}">${esc(change.importance || 'optional')}</span>
        ${change.manual_override ? '<span class="trust-pill review">Edited Manually</span>' : ''}
        ${renderMetaPill(reviewMeta.targetedRequirement)}
      </div>
      <div class="review-diff-grid">
        <div class="review-diff-panel before">
          <div class="review-diff-label">Current CV Line</div>
          <pre class="review-code" id="focusedChangeOriginalCode">${esc(change.original_text || '')}</pre>
        </div>
        <div class="review-diff-panel after">
          <div class="review-diff-label">Proposed Rewrite</div>
          <pre class="review-code" id="focusedChangeSuggestedCode">${esc(change.edited_text || '')}</pre>
        </div>
      </div>
      <div class="review-github-panel">
        <div class="review-diff-label">GitHub-style diff</div>
        <div class="github-change-card review-focus-diff">
          <div class="github-change-lines" id="focusedChangeGithubDiff">${renderGithubDiffLines(change.original_text, change.edited_text)}</div>
        </div>
      </div>
      <div class="change-meta-grid">
        <div class="change-meta-item">
          <div class="change-meta-label">Reason</div>
          <div class="change-meta-value">${esc(change.reason || 'No recommendation context provided.')}</div>
        </div>
        <div class="change-meta-item">
          <div class="change-meta-label">Support</div>
          <div class="change-meta-value">${esc(reviewMeta.evidenceSource)}</div>
        </div>
        <div class="change-meta-item">
          <div class="change-meta-label">Risk</div>
          <div class="change-meta-value change-risk-${reviewMeta.riskLevel.toLowerCase()}">${esc(reviewMeta.riskLevel)}</div>
        </div>
      </div>
      ${reviewMeta.evidenceQuote ? `<div class="change-support-quote">${esc(reviewMeta.evidenceQuote)}</div>` : ''}
      ${change.target_keywords?.length ? `<div class="change-keywords">${change.target_keywords.map((keyword) => `<span class="tag">${esc(keyword)}</span>`).join('')}</div>` : ''}
      ${change.validation?.issues?.length ? `<div class="change-validation">${change.validation.issues.map((issue) => `<div class="change-validation-item">? ${esc(issue)}</div>`).join('')}</div>` : ''}
      <div class="review-edit-panel">
        <div class="field-label">Editable suggestion</div>
        <textarea class="textarea review-edit-textarea" id="focusedChangeEditor" rows="4" spellcheck="false">${esc(change.edited_text || '')}</textarea>
        <div class="review-edit-actions">
          <div class="review-edit-hint">Edit the rewrite here, then accept it to push your version into the current draft.</div>
          <button class="btn btn-sm btn-ghost" id="focusedChangeReset"${hasDraftEdit ? '' : ' disabled'}>Reset to Suggested</button>
        </div>
      </div>
    `;

    actionsEl.innerHTML = `
      <button class="btn btn-ghost" id="focusedChangePrev"${currentPos <= 0 ? ' disabled' : ''}>Previous</button>
      <button class="btn btn-secondary" id="focusedChangeReject">Keep Original & Next</button>
      <button class="btn btn-primary" id="focusedChangeAccept"${!isMaterialChange(change) ? ' disabled' : ''}>Accept & Next</button>
    `;

    document.getElementById('focusedChangePrev')?.addEventListener('click', () => {
      focusedChangeIndex = getAdjacentFocusedIndex(changes, index, filter, -1);
      renderChanges(changes, filter);
      scrollFocusedChangeIntoView();
    });

    document.getElementById('focusedChangeReject')?.addEventListener('click', () => {
      setChangeDecision(index, change, 'rejected');
      focusedChangeIndex = getNextPendingFocusedIndex(changes, index, filter);
      renderChanges(changes, filter);
      applySelectedChanges();
      scrollFocusedChangeIntoView();
    });

    document.getElementById('focusedChangeAccept')?.addEventListener('click', () => {
      if (!isMaterialChange(change)) return;
      setChangeDecision(index, change, 'accepted');
      focusedChangeIndex = getNextPendingFocusedIndex(changes, index, filter);
      renderChanges(changes, filter);
      applySelectedChanges();
      scrollFocusedChangeIntoView();
    });

    document.getElementById('focusedChangeReset')?.addEventListener('click', () => {
      change.edited_text = String(change.model_edited_text || change.original_text || '');
      change.change_type = getChangeType(change);
      change.manual_override = false;
      renderFocusedChangeDetail(changes, filter);
      const queueAfter = document.querySelector(`.change-queue-item[data-idx="${index}"] .change-queue-snippet.after`);
      if (queueAfter) queueAfter.textContent = `+ ${trunc(change.edited_text || '', 120)}`;
      if (getChangeDecision(index, change) === 'accepted') {
        scheduleApplySelectedChanges();
      }
    });

    document.getElementById('focusedChangeEditor')?.addEventListener('input', (event) => {
      const nextValue = event.target.value;
      change.edited_text = nextValue;
      change.change_type = getChangeType(change);
      change.manual_override = String(nextValue || '') !== String(change.model_edited_text || change.original_text || '');

      if (!isMaterialChange(change)) {
        setChangeDecision(index, change, 'rejected');
        renderChanges(changes, filter);
        applySelectedChanges();
        return;
      }

      const resetBtn = document.getElementById('focusedChangeReset');
      if (resetBtn) {
        resetBtn.disabled = String(change.edited_text || '') === String(change.model_edited_text || change.original_text || '');
      }
      const suggestedCode = document.getElementById('focusedChangeSuggestedCode');
      if (suggestedCode) suggestedCode.textContent = change.edited_text || '';
      const githubDiff = document.getElementById('focusedChangeGithubDiff');
      if (githubDiff) githubDiff.innerHTML = renderGithubDiffLines(change.original_text, change.edited_text);
      const queueAfter = document.querySelector(`.change-queue-item[data-idx="${index}"] .change-queue-snippet.after`);
      if (queueAfter) queueAfter.textContent = `+ ${trunc(change.edited_text || '', 120)}`;

      if (getChangeDecision(index, change) === 'accepted') {
        scheduleApplySelectedChanges();
      }
    });
  }

  function renderChanges(changes, filter) {
    const indexedChanges = getReviewableChangeEntries(changes, filter);
    const container = document.getElementById('changesList');
    renderChangeQueueSummary(changes);
    if (!indexedChanges.length) {
      container.innerHTML = '<p class="empty-state">No suggested rewrites match this filter.</p>';
      renderFocusedChangeDetail(changes, filter);
      return;
    }

    ensureFocusedChangeIndex(changes, filter);
    container.innerHTML = indexedChanges.map(({ change: c, index: globalIdx }, listIndex) => {
      const decision = getChangeDecision(globalIdx, c);
      const trustState = getChangeTrustState(c);
      const isFocused = focusedChangeIndex === globalIdx;
      return `
        <button class="change-queue-item ${isFocused ? 'active' : ''} ${decision}" data-idx="${globalIdx}" type="button">
          <div class="change-queue-topline">
            <span class="change-queue-order">#${listIndex + 1}</span>
            <span class="tag tag-${c.importance || 'optional'}">${esc(c.importance || 'optional')}</span>
            <span class="change-section">${esc(c.section_name || 'General')}</span>
            <span class="trust-pill ${trustState.className}">${trustState.label}</span>
            <span class="change-decision-badge ${decision}">${esc(decision === 'accepted' ? 'Accepted' : (decision === 'rejected' ? 'Kept Original' : 'Pending'))}</span>
          </div>
          <div class="change-queue-reason">${esc(trunc(c.reason || 'Review this rewrite carefully before accepting it.', 150))}</div>
          <div class="change-queue-snippets">
            <div class="change-queue-snippet before">- ${esc(trunc(c.original_text || '', 120))}</div>
            <div class="change-queue-snippet after">+ ${esc(trunc(c.edited_text || '', 120))}</div>
          </div>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.change-queue-item').forEach((button) => {
      button.addEventListener('click', () => {
        focusedChangeIndex = Number(button.dataset.idx);
        renderChanges(changes, filter);
      });
    });

    renderFocusedChangeDetail(changes, filter);
    updateApplyCount({ changes });
  }

  function updateApplyCount(reportInput = parseJSON(currentSession?.report || currentSession?.replacements) || {}) {
    const report = reportInput && typeof reportInput === 'object' ? reportInput : {};
    const counts = getChangeDecisionCounts(report?.changes || []);
    const applyCountEl = document.getElementById('applyCount');
    const acceptAllBtn = document.getElementById('acceptAll');
    const rejectAllBtn = document.getElementById('rejectAll');
    const reviewBtn = document.getElementById('reviewAppliedCv');
    const currentDraft = getCurrentLatexDraft() || currentSession?.edited_latex || currentSession?.editedLatex || currentSession?.generated_latex || '';
    const originalLatex = currentSession?.original_latex || '';
    const hasDraftDelta = String(currentDraft || '') !== String(originalLatex || '');
    const canReviewDraft = counts.accepted > 0 || hasDraftDelta;

    if (applyCountEl) {
      if (!counts.total) {
        applyCountEl.innerHTML = 'No suggested rewrites need review for this run.';
      } else if (counts.pending > 0) {
        applyCountEl.innerHTML = `<strong>${counts.accepted} accepted</strong> ? ${counts.rejected} kept original ? ${counts.pending} pending <span class="apply-bar-note">Pending suggestions are not in the draft.</span>`;
      } else {
        applyCountEl.innerHTML = `<strong>${counts.accepted} accepted</strong> ? ${counts.rejected} kept original <span class="apply-bar-note">All ${counts.total} suggestion${counts.total === 1 ? '' : 's'} reviewed.</span>`;
      }
    }

    if (acceptAllBtn) {
      acceptAllBtn.disabled = counts.pending === 0;
    }
    if (rejectAllBtn) {
      rejectAllBtn.disabled = counts.pending === 0;
    }
    if (reviewBtn) {
      reviewBtn.disabled = !canReviewDraft;
      reviewBtn.textContent = counts.accepted > 0 ? 'Review Accepted Draft' : 'Review Current Draft';
      reviewBtn.title = canReviewDraft
        ? 'Review the current accepted draft and metric movement.'
        : 'Accept at least one suggestion or edit the draft before running the review.';
    }
  }

  // Filter pills
  document.getElementById('changeFilters')?.addEventListener('click', (e) => {
    if (!e.target.classList.contains('pill')) return;
    document.querySelectorAll('#changeFilters .pill').forEach(p => p.classList.remove('active'));
    e.target.classList.add('active');
    const report = parseJSON(currentSession?.report || currentSession?.replacements);
    if (report?.changes) renderChanges(report.changes, e.target.dataset.filter);
  });

  async function applySelectedChanges() {
    if (acceptedChangesApplyTimer) {
      clearTimeout(acceptedChangesApplyTimer);
      acceptedChangesApplyTimer = null;
    }
    const report = parseJSON(currentSession?.report || currentSession?.replacements);
    if (!report?.changes) return;

    const originalLatex = currentSession?.original_latex || (await Store.getProfile(currentSession.profile_id))?.latex || '';
    const acceptedList = report.changes.filter((change, i) => acceptedChanges.has(i) && isMaterialChange(change));

    const edited = applyReplacementChanges(originalLatex, acceptedList);
    const acceptedIndices = getAcceptedMaterialIndices(report);
    const nextReport = syncAppliedReviewState(report, edited, acceptedIndices, getRejectedMaterialIndices(report));

    currentSession.generated_latex = edited;
    currentSession.edited_latex = edited;
    currentSession.editedLatex = edited;
    currentSession.report = nextReport;
    currentSession.applied_review = nextReport?.applied_review || null;
    renderAcceptedChangeStack(nextReport.changes || report.changes);
    renderAppliedReview(currentSession.applied_review);
    updateResultsRecommendation(nextReport);
    updateApplyCount(nextReport);
    syncLatexStudio(edited, originalLatex, {
      stateText: 'Synced',
      stateMode: 'synced',
      statusText: defaultCompileStatusText(false, edited),
    });
  }

  // Accept all
  document.getElementById('acceptAll')?.addEventListener('click', () => {
    const report = parseJSON(currentSession?.report || currentSession?.replacements);
    if (report?.changes) {
      const activeFilter = document.querySelector('#changeFilters .pill.active')?.dataset.filter || 'all';
      report.changes.forEach((change, i) => {
        if (isMaterialChange(change) && getChangeDecision(i, change) === 'pending') {
          setChangeDecision(i, change, 'accepted');
        }
      });
      focusedChangeIndex = findFirstFocusedChangeIndex(report.changes, activeFilter);
      renderChanges(report.changes, activeFilter);
      applySelectedChanges();
    }
  });

  document.getElementById('rejectAll')?.addEventListener('click', () => {
    const report = parseJSON(currentSession?.report || currentSession?.replacements);
    if (report?.changes) {
      const activeFilter = document.querySelector('#changeFilters .pill.active')?.dataset.filter || 'all';
      report.changes.forEach((change, i) => {
        if (isMaterialChange(change) && getChangeDecision(i, change) === 'pending') {
          setChangeDecision(i, change, 'rejected');
        }
      });
      focusedChangeIndex = findFirstFocusedChangeIndex(report.changes, activeFilter);
      renderChanges(report.changes, activeFilter);
      applySelectedChanges();
    }
  });

  document.getElementById('reviewAppliedCv')?.addEventListener('click', async (event) => {
    if (!currentSession) return;
    if (!getApiKey() && !(serverMode && serverHasDefaultKey)) {
      toast('Set API key first', 'error');
      return;
    }

    const button = event.currentTarget;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Reviewing...';

    try {
      const report = parseJSON(currentSession?.report || currentSession?.replacements) || {};
      const originalLatex = currentSession?.original_latex || (await Store.getProfile(currentSession.profile_id))?.latex || '';
      const editedLatex = getCurrentLatexDraft() || currentSession?.edited_latex || currentSession?.editedLatex || currentSession?.generated_latex || '';
      const acceptedIndices = getAcceptedMaterialIndices(report);
      const rejectedIndices = getRejectedMaterialIndices(report);
      if (!acceptedIndices.length && String(editedLatex || '') === String(originalLatex || '')) {
        throw new Error('Accept at least one suggestion or edit the draft before running the review.');
      }

      const result = await Store.reviewAppliedDraft(currentSession, {
        original_latex: originalLatex,
        edited_latex: editedLatex,
        accepted_indices: acceptedIndices,
        rejected_indices: rejectedIndices,
      });

      currentSession.report = ensureEditableChangeState(parseJSON(result.report) || result.report || report);
      currentSession.token_usage = result.token_usage || currentSession.token_usage;
      currentSession.edited_latex = result.edited_latex || editedLatex;
      currentSession.editedLatex = currentSession.edited_latex;
      currentSession.generated_latex = currentSession.edited_latex;
      currentSession.applied_review = parseJSON(result.applied_review) || result.applied_review || currentSession.report?.applied_review || null;
      await renderResults({
        ...currentSession,
        report: currentSession.report,
        edited_latex: currentSession.edited_latex,
        token_usage: currentSession.token_usage,
      });
      setActiveTab('changes');
      toast('Applied draft reviewed', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  // Apply selected (this button does practically nothing now due to auto-apply, but we leave it just in case)
  document.getElementById('applySelected')?.addEventListener('click', applySelectedChanges);

  // Copy + Download
  document.getElementById('copyLatex')?.addEventListener('click', () => {
    const latex = getCurrentLatexDraft();
    navigator.clipboard.writeText(latex).then(() => toast('Copied!', 'success'));
  });

  document.getElementById('downloadTexBtn')?.addEventListener('click', () => {
    const latex = getCurrentLatexDraft();
    downloadTex(latex, currentSession?.company || 'cv', currentSession?.job_title || '');
  });


  document.getElementById('resetLatexEditor')?.addEventListener('click', () => {
    if (!currentSession) return;
    const baseline = currentSession.generated_latex || currentSession.edited_latex || currentSession.editedLatex || '';
    currentSession.edited_latex = baseline;
    currentSession.editedLatex = baseline;
    const report = parseJSON(currentSession?.report || currentSession?.replacements);
    if (report) {
      const nextReport = syncAppliedReviewState(report, baseline, getAcceptedMaterialIndices(report), getRejectedMaterialIndices(report));
      currentSession.report = nextReport;
      currentSession.applied_review = nextReport?.applied_review || null;
      renderAppliedReview(currentSession.applied_review);
      updateResultsRecommendation(nextReport);
      updateApplyCount(nextReport);
    }
    syncLatexStudio(baseline, currentSession.original_latex || '', {
      stateText: 'Synced',
      stateMode: 'synced',
    });
    toast('LaTeX editor reset to the current accepted draft', 'success');
  });
  document.getElementById('latexEditor')?.addEventListener('input', (event) => {
    if (!currentSession) return;
    const value = event.target.value;
    currentSession.edited_latex = value;
    currentSession.editedLatex = value;
    const report = parseJSON(currentSession?.report || currentSession?.replacements);
    if (report) {
      const nextReport = syncAppliedReviewState(report, value, getAcceptedMaterialIndices(report), getRejectedMaterialIndices(report));
      currentSession.report = nextReport;
      currentSession.applied_review = nextReport?.applied_review || null;
      renderAppliedReview(currentSession.applied_review);
      updateResultsRecommendation(nextReport);
      updateApplyCount(nextReport);
    }
    queueLatexSurfaceRefresh(value, currentSession.original_latex || '', { forceDiff: activeResultsTab === 'latex' });
    setLatexEditorState('Edited locally', 'editing');
    if (activeResultsTab === 'latex') {
      scheduleDraftAtsRefresh(value);
    }
  });

  document.getElementById('backToDash')?.addEventListener('click', () => navigate('dashboard'));

  document.getElementById('sessionOutcome')?.addEventListener('change', async (e) => {
    if (!currentSession) return;
    const sessionId = currentSession.id || currentSession.session_id;
    if (!sessionId) return toast('Save a session before tracking outcomes', 'error');
    try {
      await Store.updateSessionOutcome(Number(sessionId), e.target.value);
      currentSession.outcome = e.target.value;
      loadDashboard();
      if (currentView === 'history') loadHistory();
      toast('Outcome updated', 'success');
    } catch (err) {
      e.target.value = currentSession.outcome || '';
      toast(err.message, 'error');
    }
  });

  document.getElementById('saveAcceptedToVault')?.addEventListener('click', () => {
    toast('Vault stores source experiences only. Save facts from the Vault screen instead.', 'error');
  });
  document.getElementById('coverLetterGuidance')?.addEventListener('input', (event) => {
    localStorage.setItem(COVER_LETTER_GUIDANCE_KEY, event.target.value || '');
    if (currentSession) currentSession.cover_letter_guidance = event.target.value || '';
  });

  // ?? Cover Letter ???????????????????????????????????????????????????
  document.getElementById('genCoverLetter')?.addEventListener('click', async () => {
    if (!getApiKey() && !(serverMode && serverHasDefaultKey)) return toast('Set API key first', 'error');
    if (!currentSession) return;
    const btn = document.getElementById('genCoverLetter');
    const copyLatexBtn = document.getElementById('copyCoverLetterLatex');
    const downloadLatexBtn = document.getElementById('downloadCoverLetterTex');
    const compileBtn = document.getElementById('compileCoverLetter');
    const latexPre = document.getElementById('coverLetterLatexPre');
    const guidance = document.getElementById('coverLetterGuidance')?.value.trim() || '';
    const templateSettings = collectCoverLetterTemplateSettings();
    btn.disabled = true; btn.textContent = '? Generating...';
    setCoverLetterStatus('generating', 'Generating cover letter LaTeX from the current tailoring session...');
    if (copyLatexBtn) copyLatexBtn.style.display = 'none';
    if (downloadLatexBtn) downloadLatexBtn.style.display = 'none';
    if (compileBtn) compileBtn.style.display = 'none';
    if (latexPre) latexPre.textContent = 'Generating cover letter LaTeX...';
    clearCoverLetterPdfPreview();
    currentSession.cover_letter_guidance = guidance;
    localStorage.setItem(COVER_LETTER_GUIDANCE_KEY, guidance);

    try {
      if (serverMode && currentSession.id) {
        const res = await apiFetch('/cover-letter', {
          method: 'POST',
          body: JSON.stringify({
            session_id: currentSession.id,
            user_story: guidance,
            template_settings: templateSettings,
          })
        });
        currentSession.cover_letter = res.cover_letter;
        currentSession.cover_letter_latex = res.cover_letter_latex;
        currentSession.cover_letter_payload = res.cover_letter_payload;
        currentSession.cover_letter_assets = res.cover_letter_assets || [];
        currentSession.cover_letter_template_settings = res.template_settings || templateSettings;
      } else {
        // Client-only mode fallback
        const parsedReq = parseJSON(currentSession.parsed_req || currentSession.parsedReq) || {};
        const alignment = parseJSON(currentSession.alignment) || {};
        const profile = await Store.getProfile(currentSession.profile_id);
        const jobMeta = {
          company: currentSession.company || '',
          title: currentSession.job_title || '',
          location: currentSession.location || '',
        };
        const { data } = await callOpenAIDirect(
          PROMPTS.coverLetterSystem,
          buildCoverLetterUserPrompt(parsedReq, profile.latex, alignment, jobMeta, guidance),
          { maxTokens: 1024, disableReasoning: true }
        );
        const rendered = renderCoverLetterTemplateLocal(jobMeta, templateSettings, typeof data === 'string' ? (parseStructuredJson(data) || data) : data);
        currentSession.cover_letter = rendered.text;
        currentSession.cover_letter_latex = rendered.latex;
        currentSession.cover_letter_payload = rendered.payload;
        currentSession.cover_letter_assets = rendered.assets || [];
        currentSession.cover_letter_template_settings = rendered.settings || templateSettings;
      }
      if (latexPre) latexPre.textContent = currentSession.cover_letter_latex || 'No cover letter LaTeX generated yet.';
      syncCoverLetterUi({
        statusState: 'ready',
        statusMessage: 'The generated LaTeX source is ready. Compiling a PDF preview now...',
      });
      if (currentSession.cover_letter_latex) {
        await compileCoverLetterLatex({
          quiet: true,
          latexOverride: currentSession.cover_letter_latex,
          assetsOverride: currentSession.cover_letter_assets || [],
        });
      }
      toast('Cover letter generated!', 'success');
    } catch (err) {
      if (latexPre) latexPre.textContent = 'No cover letter LaTeX generated yet.';
      syncCoverLetterUi({
        statusState: 'error',
        statusMessage: err.message || 'Cover letter generation failed.',
      });
      toast(err.message, 'error');
    }
    btn.disabled = false; btn.textContent = 'Regenerate';
  });

  document.getElementById('copyCoverLetterLatex')?.addEventListener('click', () => {
    if (currentSession?.cover_letter_latex) {
      navigator.clipboard.writeText(currentSession.cover_letter_latex).then(() => toast('LaTeX copied!', 'success'));
    }
  });
  document.getElementById('downloadCoverLetterTex')?.addEventListener('click', () => {
    if (currentSession?.cover_letter_latex) {
      downloadTex(
        currentSession.cover_letter_latex,
        currentSession?.company || 'cover_letter',
        `${currentSession?.job_title || 'cover_letter'}_cover_letter`
      );
      (currentSession?.cover_letter_assets || []).forEach((asset) => {
        const blob = dataUrlToBlob(asset?.data_url || '');
        if (blob) dlBlob(blob, asset?.filename || 'signature-upload.png');
      });
    }
  });
  document.getElementById('compileCoverLetter')?.addEventListener('click', () => {
    compileCoverLetterLatex();
  });

  // ?? Interview Prep ?????????????????????????????????????????????????
  async function generateInterviewPrepInto(session, button, content, onComplete) {
    if (!getApiKey() && !(serverMode && serverHasDefaultKey)) return toast('Set API key first', 'error');
    if (!session) return toast('Select a saved tailoring run first', 'error');
    button.disabled = true;
    button.textContent = '? Generating...';
    content.innerHTML = '<p class="empty-state">Researching company context and generating interview prep...</p>';

    try {
      const result = await runInterviewPrepForSession(session);
      session.interview_prep = result.prep || {};
      session.interview_research = result.research || '';
      if (currentSession?.id === session.id) {
        currentSession.interview_prep = session.interview_prep;
        currentSession.interview_research = session.interview_research;
      }
      content.innerHTML = renderInterviewPrepHtml(session.interview_prep, session.interview_research);
      if (typeof onComplete === 'function') onComplete(session);
      toast('Interview prep generated!', 'success');
    } catch (err) {
      content.innerHTML = `<p class="empty-state" style="color:var(--crit)">Error: ${esc(err.message)}</p>`;
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Regenerate';
    }
  }

  document.getElementById('genInterview')?.addEventListener('click', async () => {
    if (!currentSession) return;
    await generateInterviewPrepInto(
      currentSession,
      document.getElementById('genInterview'),
      document.getElementById('interviewContent')
    );
  });

  document.getElementById('interviewSessionSelect')?.addEventListener('change', async (event) => {
    interviewToolSessionId = Number(event.target.value || 0);
    await loadInterviewTool().catch((err) => toast(err.message, 'error'));
  });

  document.getElementById('refreshInterviewSessions')?.addEventListener('click', () => {
    loadInterviewTool().catch((err) => toast(err.message, 'error'));
  });

  document.getElementById('openInterviewSessionResults')?.addEventListener('click', async () => {
    const sessionId = Number(document.getElementById('interviewSessionSelect')?.value || 0);
    if (!sessionId) return toast('Select a saved tailoring run first', 'error');
    await loadSessionResults(sessionId);
  });

  document.getElementById('genInterviewStandalone')?.addEventListener('click', async () => {
    const sessionId = Number(document.getElementById('interviewSessionSelect')?.value || 0);
    if (!sessionId) return toast('Select a saved tailoring run first', 'error');
    const session = currentSession?.id === sessionId
      ? currentSession
      : await Store.getSession(sessionId);
    interviewToolSessionId = sessionId;
    renderInterviewSessionMeta(session);
    await generateInterviewPrepInto(
      session,
      document.getElementById('genInterviewStandalone'),
      document.getElementById('interviewToolContent'),
      (updatedSession) => {
        renderInterviewSessionMeta(updatedSession);
      }
    );
  });

  // ??????????????????????????????????????????????????????????????????
  // VAULT
  // ??????????????????????????????????????????????????????????????????
  function syncVaultQuickSectionOptions(profiles) {
    const select = document.getElementById('vaultQuickSection');
    const profileId = Number(document.getElementById('vaultQuickProfile')?.value || 0);
    if (!select) return;
    const profile = (profiles || []).find((item) => Number(item.id) === profileId);
    const sections = profile ? extractProfileSections(profile.latex || '') : SECTION_LIBRARY;
    const current = select.value || '';
    select.innerHTML = renderSectionOptionsMarkup(current, sections);
    if (current && Array.from(select.options).some((option) => option.value === current)) {
      select.value = current;
    }
  }

  async function loadVault() {
    try {
      const [profiles, sessions, rawVaultItems] = await Promise.all([Store.getProfiles(), Store.getSessions(), Store.getVaultItems()]);
      const vaultItems = buildVaultItems(rawVaultItems, profiles, sessions);
      const profileFilterValue = document.getElementById('vaultProfileFilter')?.value || '';

      document.getElementById('vaultProfileFilter').innerHTML = '<option value="">All Profiles</option>' +
        profiles.map((profile) => `<option value="${profile.id}">${esc(profile.name)}</option>`).join('');
      document.getElementById('vaultQuickProfile').innerHTML = '<option value="">Choose profile for capture</option>' +
        profiles.map((profile) => `<option value="${profile.id}">${esc(profile.name)}</option>`).join('');
      if (profiles.some((profile) => String(profile.id) === String(profileFilterValue))) {
        document.getElementById('vaultProfileFilter').value = profileFilterValue;
      }
      syncVaultQuickSectionOptions(profiles);

      const suggestions = buildGenreSuggestions(vaultItems);
      document.getElementById('vaultSuggestedGenres').innerHTML = suggestions.length
        ? suggestions.map((suggestion) => `
          <div class="suggestion-card">
            <div class="genre-card-title">${esc(suggestion.name)}</div>
            <div class="genre-card-copy">Focus tags: ${esc(suggestion.focus_tags.join(', '))}</div>
            <button class="btn btn-sm btn-secondary vault-create-genre" data-name="${esc(suggestion.name)}" data-tags="${esc(suggestion.focus_tags.join(','))}" data-signals="${esc(suggestion.preferred.join(','))}">Use as Genre</button>
          </div>`).join('')
        : '<p class="empty-state">Save more experience with tags to unlock genre suggestions.</p>';

      document.querySelectorAll('.vault-create-genre').forEach((button) => {
        button.addEventListener('click', () => {
          document.getElementById('genreName').value = button.dataset.name || '';
          document.getElementById('genreFocusTags').value = button.dataset.tags || '';
          document.getElementById('genrePreferredSignals').value = button.dataset.signals || '';
          document.getElementById('genreDescription').value = `Generated from your saved experience for ${button.dataset.name || 'a reusable direction'}.`;
          navigate('genres');
        });
      });

      renderVaultList(vaultItems);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function applyVaultFilters() {
    const [profiles, sessions, rawVaultItems] = await Promise.all([Store.getProfiles(), Store.getSessions(), Store.getVaultItems()]);
    renderVaultList(buildVaultItems(rawVaultItems, profiles, sessions));
  }

  function renderVaultList(vaultItems) {
    const profileFilter = document.getElementById('vaultProfileFilter')?.value || '';
    const statusFilter = document.getElementById('vaultStatusFilter')?.value || '';
    const tagFilter = (document.getElementById('vaultTagFilter')?.value || '').trim().toLowerCase();
    const search = (document.getElementById('vaultSearch')?.value || '').trim().toLowerCase();
    const filtered = (vaultItems || []).filter((item) => {
      if (profileFilter && String(item.profile_id) !== String(profileFilter)) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (tagFilter && !String(item.tag || '').toLowerCase().includes(tagFilter)) return false;
      if (search) {
        const haystack = `${item.title} ${item.text} ${item.preferred_bullet} ${item.profile_name} ${item.section_hint || ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    const list = document.getElementById('vaultList');
    if (!filtered.length) {
      selectedVaultItemKey = '';
      list.innerHTML = '<p class="empty-state">No vault items match the current filters.</p>';
      renderVaultDetail(null);
      return;
    }

    if (!selectedVaultItemKey || !filtered.some((item) => item.key === selectedVaultItemKey)) {
      selectedVaultItemKey = filtered[0].key;
    }

    list.innerHTML = `<div class="vault-list">${filtered.map((item) => `
      <div class="vault-item ${item.key === selectedVaultItemKey ? 'active' : ''}" data-key="${item.key}">
        <div class="vault-item-header">
          <div>
            <div class="vault-item-title">${esc(item.title)}</div>
            <div class="vault-item-meta">
              <span class="trust-pill ${storyStatusClass(item.status)}">${esc(storyStatusLabel(item.status))}</span>
              <span class="tag">${esc(item.tag)}</span>
              ${item.section_hint ? `<span class="vault-item-section">${esc(resolveSectionMeta(item.section_hint).label)}</span>` : ''}
              <span class="meta-pill">${esc(item.profile_name)}</span>
            </div>
          </div>
          <span class="meta-pill">${item.reuse_count} reuse</span>
        </div>
        <div class="vault-item-text">${esc(trunc(item.text || '', 130))}</div>
        ${item.preferred_bullet ? `<div class="vault-item-bullet">${esc(trunc(item.preferred_bullet, 120))}</div>` : ''}
      </div>`).join('')}</div>`;

    list.querySelectorAll('.vault-item').forEach((element) => {
      element.addEventListener('click', () => {
        selectedVaultItemKey = element.dataset.key;
        renderVaultList(vaultItems);
      });
    });

    renderVaultDetail(filtered.find((item) => item.key === selectedVaultItemKey) || filtered[0]);
  }

  function renderVaultDetail(item) {
    const container = document.getElementById('vaultDetail');
    if (!container) return;
    if (!item) {
      container.innerHTML = '<p class="empty-state">Select a vault item to edit title, tags, proof state, and preferred bullet.</p>';
      return;
    }

    container.innerHTML = `
      <div class="vault-detail-meta">
        <span class="trust-pill ${storyStatusClass(item.status)}">${esc(storyStatusLabel(item.status))}</span>
        <span class="meta-pill">${esc(item.profile_name)}</span>
        ${item.section_hint ? `<span class="vault-item-section">${esc(resolveSectionMeta(item.section_hint).label)}</span>` : ''}
        <span class="meta-pill">${item.reuse_count} reuse</span>
      </div>
      <div class="vault-detail-form">
        <input id="vaultDetailTitle" class="input" value="${esc(item.title)}" placeholder="Title">
        <input id="vaultDetailTag" class="input" value="${esc(item.tag)}" placeholder="Tag">
        <select id="vaultDetailSection" class="select">${renderSectionOptionsMarkup(item.section_hint || '', item.profile_sections || SECTION_LIBRARY)}</select>
        <select id="vaultDetailStatus" class="select">
          <option value="grounded"${item.status === 'grounded' ? ' selected' : ''}>Grounded Suggestion</option>
          <option value="verified"${item.status === 'verified' ? ' selected' : ''}>Verified Fact</option>
          <option value="review"${item.status === 'review' ? ' selected' : ''}>Needs Review</option>
          <option value="resume-ready"${item.status === 'resume-ready' ? ' selected' : ''}>Resume-Ready</option>
        </select>
        <textarea id="vaultDetailText" class="textarea" rows="6" placeholder="Source facts">${esc(item.text)}</textarea>
        <textarea id="vaultDetailBullet" class="textarea" rows="4" placeholder="Preferred bullet">${esc(item.preferred_bullet || '')}</textarea>
        <div class="form-row">
          <button class="btn btn-primary" id="vaultDetailSave">Save Changes</button>
          <button class="btn btn-danger" id="vaultDetailDelete">Delete</button>
        </div>
      </div>
    `;

    document.getElementById('vaultDetailSave').addEventListener('click', async () => {
      await saveVaultStory(item.profile_id, item.id, {
        title: document.getElementById('vaultDetailTitle').value.trim(),
        tag: document.getElementById('vaultDetailTag').value.trim() || 'general',
        section_hint: document.getElementById('vaultDetailSection').value || '',
        status: document.getElementById('vaultDetailStatus').value,
        text: document.getElementById('vaultDetailText').value.trim(),
        preferred_bullet: document.getElementById('vaultDetailBullet').value.trim(),
        created_at: item.created_at,
      });
      toast('Vault item updated', 'success');
      loadVault();
      loadDashboard();
      loadProfiles();
    });

    document.getElementById('vaultDetailDelete').addEventListener('click', async () => {
      if (!confirm('Delete this vault item?')) return;
      await removeVaultStory(item.id);
      selectedVaultItemKey = '';
      toast('Vault item deleted', 'success');
      loadVault();
      loadDashboard();
      loadProfiles();
    });
  }

  document.getElementById('vaultQuickSave')?.addEventListener('click', async () => {
    const profileId = document.getElementById('vaultQuickProfile').value;
    const title = document.getElementById('vaultQuickTitle').value.trim();
    const tag = document.getElementById('vaultQuickTag').value.trim();
    const sectionHint = document.getElementById('vaultQuickSection').value || '';
    const status = document.getElementById('vaultQuickStatus').value;
    const text = document.getElementById('vaultQuickText').value.trim();
    if (!profileId || !text) return toast('Choose a profile and add proof text', 'error');
    await saveVaultStory(profileId, -1, { title, tag: tag || 'general', section_hint: sectionHint, status, text, preferred_bullet: '' });
    document.getElementById('vaultQuickTitle').value = '';
    document.getElementById('vaultQuickTag').value = '';
    document.getElementById('vaultQuickSection').value = '';
    document.getElementById('vaultQuickText').value = '';
    toast('Saved to Vault', 'success');
    loadVault();
    loadDashboard();
    loadProfiles();
  });

  ['vaultSearch', 'vaultProfileFilter', 'vaultStatusFilter', 'vaultTagFilter'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => applyVaultFilters().catch(err => toast(err.message, 'error')));
    document.getElementById(id)?.addEventListener('change', () => applyVaultFilters().catch(err => toast(err.message, 'error')));
  });
  document.getElementById('vaultQuickProfile')?.addEventListener('change', async () => {
    syncVaultQuickSectionOptions(await Store.getProfiles());
  });

  // ??????????????????????????????????????????????????????????????????
  // GENRES
  // ??????????????????????????????????????????????????????????????????
  async function loadGenres() {
    try {
      const [genres, profiles, sessions, rawVaultItems] = await Promise.all([
        Store.getGenres(),
        Store.getProfiles(),
        Store.getSessions(),
        Store.getVaultItems(),
      ]);
      const normalizedGenres = genres.map(normalizeGenre);
      const suggestions = buildGenreSuggestions(buildVaultItems(rawVaultItems, profiles, sessions));

      document.getElementById('genreSuggestions').innerHTML = suggestions.length
        ? suggestions.map((suggestion) => `
          <div class="suggestion-card">
            <div class="genre-card-title">${esc(suggestion.name)}</div>
            <div class="genre-card-copy">Highlights ${esc(suggestion.focus_tags.join(', '))} with ${esc(suggestion.preferred.join(', '))} signals.</div>
            <button class="btn btn-sm btn-secondary genre-use-suggestion" data-name="${esc(suggestion.name)}" data-tags="${esc(suggestion.focus_tags.join(','))}" data-signals="${esc(suggestion.preferred.join(','))}">Use Suggestion</button>
          </div>
        `).join('')
        : '<p class="empty-state">Save more tagged experience in the Vault to generate starter genres.</p>';

      document.querySelectorAll('.genre-use-suggestion').forEach((button) => {
        button.addEventListener('click', () => {
          document.getElementById('genreName').value = button.dataset.name || '';
          document.getElementById('genreFocusTags').value = button.dataset.tags || '';
          document.getElementById('genrePreferredSignals').value = button.dataset.signals || '';
          document.getElementById('genreDescription').value = `Suggested genre for ${button.dataset.name || 'a reusable direction'}.`;
          document.getElementById('editGenreId').value = '';
          document.getElementById('cancelGenreEdit').style.display = 'inline-flex';
        });
      });

      const savedGenres = document.getElementById('savedGenres');
      setCountHeading('savedGenresHeading', 'Saved Genres', normalizedGenres.length, normalizedGenres.length);
      if (!normalizedGenres.length) {
        savedGenres.innerHTML = '<p class="empty-state">No genres yet.</p>';
        return;
      }

      savedGenres.innerHTML = normalizedGenres.map((genre) => `
        <div class="genre-card">
          <div class="genre-card-header">
            <div>
              <div class="genre-card-title">${esc(genre.name)}</div>
              <div class="genre-card-copy">${esc(genre.description || 'No description yet.')}</div>
            </div>
            <div class="list-item-actions">
              <button class="btn btn-sm btn-secondary genre-edit" data-id="${genre.id}">Edit</button>
              <button class="btn btn-sm btn-danger genre-delete" data-id="${genre.id}">?</button>
            </div>
          </div>
          <div class="genre-card-tags">
            ${(genre.focus_tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}
            ${limitItems(genre.preferred_signals || [], UI_LIMITS.genres.preferredSignals).map((signal) => `<span class="meta-pill">${esc(signal)}</span>`).join('')}
          </div>
        </div>
      `).join('');

      savedGenres.querySelectorAll('.genre-edit').forEach((button) => {
        button.addEventListener('click', async () => {
          const genre = normalizeGenre(await Store.getGenre(Number(button.dataset.id)));
          document.getElementById('genreName').value = genre.name;
          document.getElementById('genreDescription').value = genre.description || '';
          document.getElementById('genreFocusTags').value = (genre.focus_tags || []).join(', ');
          document.getElementById('genrePreferredSignals').value = (genre.preferred_signals || []).join(', ');
          document.getElementById('genreDeEmphasizedSignals').value = (genre.de_emphasized_signals || []).join(', ');
          document.getElementById('editGenreId').value = genre.id;
          document.getElementById('cancelGenreEdit').style.display = 'inline-flex';
          toast('Genre loaded for editing');
        });
      });

      savedGenres.querySelectorAll('.genre-delete').forEach((button) => {
        button.addEventListener('click', async () => {
          if (!confirm('Delete genre?')) return;
          await Store.deleteGenre(Number(button.dataset.id));
          invalidateTailorSnapshot();
          toast('Genre deleted', 'success');
          loadGenres();
          loadDashboard();
          loadTailorView();
        });
      });
    } catch (err) { toast(err.message, 'error'); }
  }

  document.getElementById('saveGenre')?.addEventListener('click', async () => {
    const name = document.getElementById('genreName').value.trim();
    if (!name) return toast('Enter a genre name', 'error');
    const payload = {
      name,
      description: document.getElementById('genreDescription').value.trim(),
      focus_tags: splitCsv(document.getElementById('genreFocusTags').value),
      preferred_signals: splitCsv(document.getElementById('genrePreferredSignals').value),
      de_emphasized_signals: splitCsv(document.getElementById('genreDeEmphasizedSignals').value),
    };
    const editId = document.getElementById('editGenreId').value;
    if (editId) payload.id = Number(editId);
    await Store.saveGenre(payload);
    invalidateTailorSnapshot();
    document.getElementById('genreName').value = '';
    document.getElementById('genreDescription').value = '';
    document.getElementById('genreFocusTags').value = '';
    document.getElementById('genrePreferredSignals').value = '';
    document.getElementById('genreDeEmphasizedSignals').value = '';
    document.getElementById('editGenreId').value = '';
    document.getElementById('cancelGenreEdit').style.display = 'none';
    toast(editId ? 'Genre updated' : 'Genre saved', 'success');
    loadGenres();
    loadDashboard();
    loadTailorView();
  });

  document.getElementById('cancelGenreEdit')?.addEventListener('click', () => {
    document.getElementById('genreName').value = '';
    document.getElementById('genreDescription').value = '';
    document.getElementById('genreFocusTags').value = '';
    document.getElementById('genrePreferredSignals').value = '';
    document.getElementById('genreDeEmphasizedSignals').value = '';
    document.getElementById('editGenreId').value = '';
    document.getElementById('cancelGenreEdit').style.display = 'none';
  });

  // ??????????????????????????????????????????????????????????????????
  // PROFILES
  // ??????????????????????????????????????????????????????????????????
  async function loadProfiles() {
    try {
      const [profiles, rawVaultItems] = await Promise.all([Store.getProfiles(), Store.getVaultItems()]);
      const vaultCounts = new Map();
      rawVaultItems.forEach((item) => {
        const profileId = Number(item.profile_id);
        vaultCounts.set(profileId, (vaultCounts.get(profileId) || 0) + 1);
      });
      const c = document.getElementById('savedProfiles');
      setCountHeading('savedProfilesHeading', 'Saved Profiles', profiles.length, profiles.length);
      if (!profiles.length) { c.innerHTML = '<p class="empty-state">No profiles yet.</p>'; return; }
      c.innerHTML = profiles.map(p => `
        <div class="list-item">
          <div class="list-item-info"><div class="list-item-name">${esc(p.name)}</div><div class="list-item-sub">${fmtDate(p.created_at || p.updated_at)} ? ${(p.latex || '').length} chars ? ${(vaultCounts.get(Number(p.id)) || 0)} vault item${(vaultCounts.get(Number(p.id)) || 0) === 1 ? '' : 's'}</div></div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-secondary profile-edit" data-id="${p.id}">Edit</button>
            <button class="btn btn-sm btn-danger profile-delete" data-id="${p.id}">?</button>
          </div>
        </div>`).join('');

      c.querySelectorAll('.profile-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
          const p = await Store.getProfile(serverMode ? Number(btn.dataset.id) : Number(btn.dataset.id));
          document.getElementById('profileName').value = p.name;
          document.getElementById('profileLatex').value = p.latex;
          document.getElementById('editProfileId').value = p.id;
          stories.length = 0;
          deserializeStories(p.stories).forEach(s => stories.push(s));
          renderStories();
          document.getElementById('cancelEdit').style.display = 'inline-flex';
          document.getElementById('saveProfile').textContent = 'Update Profile';
          toast('Profile loaded for editing');
        });
      });
      c.querySelectorAll('.profile-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete profile?')) return;
          await Store.deleteProfile(Number(btn.dataset.id));
          invalidateTailorSnapshot();
          loadProfiles();
          loadVault();
          loadDashboard();
          toast('Deleted', 'success');
        });
      });
    } catch (err) { toast(err.message, 'error'); }
  }

  // Cancel edit
  document.getElementById('cancelEdit')?.addEventListener('click', () => {
    document.getElementById('profileName').value = '';
    document.getElementById('profileLatex').value = '';
    document.getElementById('editProfileId').value = '';
    stories.length = 0;
    renderStories();
    document.getElementById('cancelEdit').style.display = 'none';
    document.getElementById('saveProfile').textContent = 'Save Profile';
  });

  // File upload
  const uploadArea = document.getElementById('latexUploadArea');
  const fileInput = document.getElementById('latexFileInput');
  uploadArea?.addEventListener('click', () => fileInput.click());
  uploadArea?.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea?.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea?.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('dragover'); if (e.dataTransfer.files[0]) readTex(e.dataTransfer.files[0]); });
  fileInput?.addEventListener('change', () => { if (fileInput.files[0]) readTex(fileInput.files[0]); });

  function readTex(file) {
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('profileLatex').value = reader.result;
      uploadArea.innerHTML = `<p>? <strong>${esc(file.name)}</strong></p>`;
      toast('File loaded', 'success');
    };
    reader.readAsText(file);
  }

  // Stories
  document.getElementById('addStory')?.addEventListener('click', () => {
    const tag = document.getElementById('storyTag').value.trim();
    const text = document.getElementById('storyText').value.trim();
    if (!text) return toast('Enter reusable proof', 'error');
    stories.push(normalizeStory({
      title: deriveStoryTitle({ text }),
      tag: tag || 'general',
      text,
      status: 'grounded',
      preferred_bullet: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, stories.length));
    document.getElementById('storyTag').value = '';
    document.getElementById('storyText').value = '';
    renderStories();
  });

  function renderStories() {
    const el = document.getElementById('storiesList');
    el.innerHTML = stories.map((s, i) => `
      <div class="story-item"><span class="tag">${esc(s.tag)}</span><span class="story-text">${esc(trunc(s.title || s.text, 70))}</span>
      <button class="story-remove" data-idx="${i}">?</button></div>`).join('');
    el.querySelectorAll('.story-remove').forEach(btn => {
      btn.addEventListener('click', () => { stories.splice(Number(btn.dataset.idx), 1); renderStories(); });
    });
  }

  // Save profile
  document.getElementById('saveProfile')?.addEventListener('click', async () => {
    const name = document.getElementById('profileName').value.trim() || 'Default';
    const latex = document.getElementById('profileLatex').value.trim();
    if (!latex) return toast('Paste or upload LaTeX', 'error');
    const editId = document.getElementById('editProfileId').value;
    try {
      const p = { name, latex, stories: serializeStories(stories) };
      if (editId) p.id = Number(editId);
      await Store.saveProfile(p);
      invalidateTailorSnapshot();
      toast(editId ? 'Profile updated!' : 'Profile saved!', 'success');
      document.getElementById('profileName').value = '';
      document.getElementById('profileLatex').value = '';
      document.getElementById('editProfileId').value = '';
      stories.length = 0;
      renderStories();
      document.getElementById('cancelEdit').style.display = 'none';
      document.getElementById('saveProfile').textContent = 'Save Profile';
      uploadArea.innerHTML = '<p>?? Drag & drop .tex file or click</p>';
      loadProfiles();
      loadVault();
      loadDashboard();
    } catch (err) { toast(err.message, 'error'); }
  });

  // ??????????????????????????????????????????????????????????????????
  // HISTORY
  // ??????????????????????????????????????????????????????????????????
  async function loadHistory() {
    try {
      const genres = await Store.getGenres();
      document.getElementById('historyGenreFilter').innerHTML = '<option value="">All Genres</option>' +
        genres.map((genre) => `<option value="${esc(genre.name)}">${esc(genre.name)}</option>`).join('');
      await applyHistoryFilters();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function applyHistoryFilters() {
    const q = document.getElementById('historySearch')?.value.trim().toLowerCase() || '';
    const outcome = document.getElementById('historyOutcomeFilter')?.value || '';
    const genre = document.getElementById('historyGenreFilter')?.value || '';
    const sessions = await Store.getSessions();
    const filtered = sessions.filter(s => {
      const matchesQuery = !q || (
      (s.company || '').toLowerCase().includes(q) ||
      (s.job_title || '').toLowerCase().includes(q) ||
      (s.profile_name || '').toLowerCase().includes(q)
      );
      const matchesOutcome = !outcome ||
        (outcome === 'none' ? !s.outcome : s.outcome === outcome);
      const matchesGenre = !genre || (s.genre_name || '') === genre;
      return matchesQuery && matchesOutcome && matchesGenre;
    });
    setCountHeading('allSessionsHeading', 'All Sessions', filtered.length, sessions.length);
    renderSessionList(filtered, document.getElementById('allSessions'));
  }

  document.getElementById('historySearch')?.addEventListener('input', () => {
    applyHistoryFilters().catch(err => toast(err.message, 'error'));
  });
  document.getElementById('historyOutcomeFilter')?.addEventListener('change', () => {
    applyHistoryFilters().catch(err => toast(err.message, 'error'));
  });
  document.getElementById('historyGenreFilter')?.addEventListener('change', () => {
    applyHistoryFilters().catch(err => toast(err.message, 'error'));
  });

  function renderSessionList(sessions, container) {
    if (!sessions.length) { container.innerHTML = '<p class="empty-state">No sessions found.</p>'; return; }
    container.innerHTML = sessions.map(s => {
      const al = parseJSON(s.alignment);
      const score = al?.overall_score || '?';
      const col = scoreColor(typeof score === 'number' ? score : 0);
      return `<div class="session-item" data-id="${s.id}">
        <div class="session-score" style="border-color:${col};color:${col}">${score}</div>
        <div class="session-info"><div class="session-title">${esc(s.job_title || '')} @ ${esc(s.company || '')}</div><div class="session-meta">${s.profile_name || ''}${renderMetaPill(s.genre_name)}${renderMetaPill(STRICTNESS_LABELS[s.strictness] || '')} ? ${s.status || ''} ${renderOutcomeBadge(s.outcome)}</div></div>
        <div class="session-date">${fmtDate(s.created_at)}</div>
        <div class="session-actions">
          <button class="btn btn-sm btn-ghost session-dl-h" data-id="${s.id}">?</button>
          <button class="btn btn-sm btn-danger session-del" data-id="${s.id}">?</button>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.session-dl-h') || e.target.closest('.session-del')) return;
        loadSessionResults(serverMode ? Number(el.dataset.id) : Number(el.dataset.id));
      });
    });
    container.querySelectorAll('.session-dl-h').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sess = await Store.getSession(Number(btn.dataset.id));
        downloadTex(sess.edited_latex || sess.editedLatex || '', sess.company || 'cv', sess.job_title || '');
      });
    });
    container.querySelectorAll('.session-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete session?')) return;
        if (serverMode) await apiFetch(`/sessions/${btn.dataset.id}`, { method: 'DELETE' });
        else await idbDelete('sessions', Number(btn.dataset.id));
        loadHistory(); toast('Deleted', 'success');
      });
    });
  }

  // ??????????????????????????????????????????????????????????????????
  // HELPERS
  // ??????????????????????????????????????????????????????????????????
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function trunc(s, n) { return s.length > n ? s.slice(0, n) + '?' : s; }
  function scoreColor(s) { return s >= 75 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444'; }
  function metricChip(label, value, colorScore) {
    const score = typeof colorScore === 'number' ? colorScore : Number(value);
    const color = Number.isFinite(score) ? scoreColor(score) : 'var(--ta)';
    return `<div class="metric-chip"><span class="metric-chip-label">${esc(label)}</span><span class="metric-chip-value" style="color:${color}">${esc(String(value ?? '?'))}</span></div>`;
  }
  function renderPriorityGaps(alignment) {
    const el = document.getElementById('priorityGapsList');
    if (!el) return;
    const gaps = alignment?.priority_gaps || [];
    if (!gaps.length) {
      el.innerHTML = '<p class="empty-state">No priority gaps detected.</p>';
      return;
    }
    el.innerHTML = gaps.map((gap) => `
      <div class="insight-card">
        <div class="insight-card-header">
          <span class="tag tag-${gap.importance === 'critical' ? 'critical' : 'recommended'}">${esc(gap.importance || 'recommended')}</span>
          <span class="insight-title">${esc(gap.keyword || '')}</span>
          ${gap.target_section ? renderMetaPill(`Target: ${gap.target_section}`) : ''}
          ${gap.supporting_vault_items ? renderMetaPill(`Vault: ${gap.supporting_vault_items}`) : ''}
        </div>
        <div class="insight-body">${esc(gap.rationale || '')}</div>
      </div>
    `).join('');
  }
  function renderEvidenceCandidates(alignment) {
    const el = document.getElementById('evidenceCandidatesList');
    if (!el) return;
    const candidates = alignment?.evidence_candidates || [];
    if (!candidates.length) {
      el.innerHTML = '<p class="empty-state">No rewrite anchors ranked yet.</p>';
      return;
    }
    el.innerHTML = candidates.map((candidate) => `
      <div class="insight-card">
        <div class="insight-card-header">
          <span class="tag">${esc(candidate.section_name || 'General')}</span>
          ${candidate.quantified ? renderMetaPill('Quantified') : ''}
          ${(candidate.target_keywords || []).length ? renderMetaPill(`Targets: ${(candidate.target_keywords || []).join(', ')}`) : ''}
        </div>
        <pre class="code-block insight-code">${esc(candidate.exact_latex || '')}</pre>
        <div class="insight-body">${esc(candidate.rationale || '')}</div>
      </div>
    `).join('');
  }
  function getChangeTrustState(change) {
    if (!change) return { label: 'Grounded', className: 'grounded' };
    if (change.manual_override) {
      return { label: 'Manual Edit', className: 'review' };
    }
    if (change.validation?.hallucinated || change.validation?.exact_match === false) {
      return { label: 'Unsupported', className: 'unsupported' };
    }
    if (change.validation?.issues?.length) {
      return { label: 'Needs Review', className: 'review' };
    }
    return { label: 'Grounded', className: 'grounded' };
  }
  function getChangeCoverageState(change) {
    if (!change || !isMaterialChange(change)) {
      return { label: 'Kept', className: 'kept' };
    }
    return { label: 'Edited', className: 'edited' };
  }
  function countTokenOverlap(tokensA, tokensB) {
    let score = 0;
    tokensA.forEach((token) => {
      if (tokensB.has(token)) score += 1;
    });
    return score;
  }
  function deriveChangeReviewMeta(change) {
    if (!isMaterialChange(change)) {
      return {
        targetedRequirement: 'No grounded rewrite required',
        evidenceSource: 'Existing CV evidence',
        evidenceQuote: trunc(change?.original_text || '', 150),
        riskLevel: 'Low',
      };
    }

    const alignment = parseJSON(currentSession?.alignment) || {};
    const vaultMatches = currentSession?.vault_matches || [];
    const changeTokens = tokenSet(`${(change?.target_keywords || []).join(' ')} ${change?.reason || ''} ${change?.section_name || ''}`);
    const strongestGap = (alignment.priority_gaps || [])
      .map((gap) => ({
        gap,
        score: countTokenOverlap(changeTokens, tokenSet(`${gap.keyword || ''} ${gap.rationale || ''} ${(gap.example_requirements || []).join(' ')}`)),
      }))
      .sort((a, b) => b.score - a.score)[0];
    const strongestVault = (vaultMatches || [])
      .map((item) => ({
        item,
        score: countTokenOverlap(changeTokens, tokenSet(`${item.title || ''} ${item.tag || ''} ${item.text || ''} ${item.preferred_bullet || ''}`)),
      }))
      .sort((a, b) => b.score - a.score)[0];

    let riskLevel = 'Low';
    if (change?.validation?.hallucinated || change?.validation?.exact_match === false) riskLevel = 'High';
    else if (change?.validation?.issues?.length) riskLevel = 'Medium';

    const targetedRequirement = strongestGap?.score
      ? (strongestGap.gap.keyword || change?.target_keywords?.[0] || change?.reason || 'General alignment improvement')
      : (change?.target_keywords?.[0] || change?.reason || 'General alignment improvement');
    const evidenceSource = strongestVault?.score
      ? `Vault: ${strongestVault.item.title || strongestVault.item.tag || 'Saved Experience'}`
      : (strongestGap?.score ? `ATS guidance: ${strongestGap.gap.keyword || 'priority gap'}` : 'Existing CV evidence');
    const evidenceQuote = strongestVault?.score
      ? trunc(strongestVault.item.preferred_bullet || strongestVault.item.text || '', 150)
      : trunc(strongestGap?.gap?.rationale || change?.reason || '', 150);

    return {
      targetedRequirement,
      evidenceSource,
      evidenceQuote,
      riskLevel,
    };
  }
  function formatOutcome(outcome) {
    return OUTCOME_LABELS[outcome || ''] || OUTCOME_LABELS[''];
  }
  function renderMetaPill(text) {
    if (!text) return '';
    return `<span class="meta-pill">${esc(String(text))}</span>`;
  }
  function renderOutcomeBadge(outcome) {
    if (!outcome) return '';
    return `<span class="outcome-badge ${esc(outcome)}">${esc(formatOutcome(outcome))}</span>`;
  }
  function renderMetrics(metrics) {
    const before = metrics.before || {};
    const after = metrics.after || {};
    const keywordAnalysis = metrics.keyword_analysis || {};
    const rows = [
      ['ATS Score', before.ats_score, after.ats_score],
      ['Title Alignment', before.title_alignment_score, after.title_alignment_score],
      ['Role Family Fit', before.role_family_score, after.role_family_score],
      ['BM25 Relevance', before.bm25_requirement_score, after.bm25_requirement_score],
      ['Recruiter Readability', before.recruiter_readability_score, after.recruiter_readability_score],
      ['Critical Keyword Match', before.critical_keyword_match, after.critical_keyword_match],
      ['Preferred Keyword Match', before.preferred_keyword_match, after.preferred_keyword_match],
      ['Weighted Keyword Score', before.weighted_keyword_score, after.weighted_keyword_score],
      ['Semantic Coverage', before.semantic_keyword_coverage, after.semantic_keyword_coverage],
      ['Keyword Balance', before.keyword_balance_score, after.keyword_balance_score],
      ['Quantified Impact', before.quantified_impact, after.quantified_impact],
      ['Section Completeness', before.section_completeness, after.section_completeness],
    ];

    let html = '<div class="metrics-grid">';
    rows.forEach(([label, beforeValue, afterValue]) => {
      html += `<div class="metric-row"><span class="metric-row-label">${esc(label)}</span><span class="metric-row-before">${beforeValue ?? '?'}</span><span class="metric-row-arrow">?</span><span class="metric-row-after" style="color:${scoreColor(Number(afterValue) || 0)}">${afterValue ?? '?'}</span></div>`;
    });
    html += `<div class="metric-row"><span class="metric-row-label">Content Preservation</span><span class="metric-row-before">?</span><span class="metric-row-arrow">?</span><span class="metric-row-after" style="color:${scoreColor(metrics.content_preservation_score || 0)}">${metrics.content_preservation_score ?? '?'}</span></div>`;
    html += '</div>';

    if (keywordAnalysis.newly_covered_critical?.length || keywordAnalysis.newly_covered_preferred?.length) {
      html += `<div class="metrics-note"><strong>New Coverage:</strong> ${esc([
        ...(keywordAnalysis.newly_covered_critical || []),
        ...(keywordAnalysis.newly_covered_preferred || []),
      ].join(', '))}</div>`;
    }

    if (keywordAnalysis.missing_critical?.length) {
      html += `<div class="metrics-note warn"><strong>Still Missing:</strong> ${esc(keywordAnalysis.missing_critical.join(', '))}</div>`;
    }

    return html;
  }
  function fmtDate(d) {
    if (!d) return '';
    try { return new Date(d + (d.includes('T') ? '' : 'T00:00:00')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return d; }
  }
  function parseJSON(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  }
  function sanitize(s) { return (s || '').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30); }
  function downloadTex(latex, company, title) {
    const name = `CV_${sanitize(company)}${title ? '_' + sanitize(title) : ''}.tex`;
    dlBlob(new Blob([latex], { type: 'text/x-tex' }), name);
  }
  function dlBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }



  // ??????????????????????????????????????????????????????????????????
  // INIT
  // ??????????????????????????????????????????????????????????????????
  (async () => {
    await detectServer();
    loadBatchQueueState();
    if (!serverMode) {
      try {
        await openIDB();
        await migrateLegacyVaultItems();
      } catch (error) {
        console.error(error);
        toast(error.message || 'Browser storage is unavailable.', 'error');
      }
    }
    localStorage.setItem('cv_model', getModel());
    updateApiStatus();
    updateModelOptions();
    if (!getApiKey() && !(serverMode && serverHasDefaultKey)) {
      setTimeout(() => settingsModal.classList.add('open'), 400);
    }
    navigate('dashboard');
  })();
})();

