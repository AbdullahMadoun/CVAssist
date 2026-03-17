(function initPopup() {
  'use strict';

  var currentJob = null;
  var bridgeConnected = false;
  var loadingState = document.getElementById('loadingState');
  var errorState = document.getElementById('errorState');
  var errorMessage = document.getElementById('errorMessage');
  var jobForm = document.getElementById('jobForm');
  var formNotice = document.getElementById('formNotice');
  var bridgeStatus = document.getElementById('bridgeStatus');
  var bridgeTargetSelect = document.getElementById('bridgeTargetSelect');
  var sendToAppBtn = document.getElementById('sendToAppBtn');

  function setNotice(message, type) {
    formNotice.textContent = message || '';
    formNotice.className = 'notice' + (type ? ' ' + type : '');
  }

  function setBridgeMessage(message, type) {
    bridgeStatus.textContent = message || '';
    bridgeStatus.className = 'connection-text' + (type ? ' ' + type : '');
  }

  function currentTargetMode() {
    if (!window.CVCustomizerAppBridge || typeof window.CVCustomizerAppBridge.getTargetMode !== 'function') {
      return 'auto';
    }
    return window.CVCustomizerAppBridge.getTargetMode();
  }

  function syncTargetSelect() {
    if (!bridgeTargetSelect) return;
    bridgeTargetSelect.value = currentTargetMode();
  }

  function bridgeTargetDescription() {
    var mode = currentTargetMode();
    if (mode === 'desktop') return 'desktop app on port 3210';
    if (mode === 'dev') return 'dev server on port 3001';
    return 'desktop app first, then localhost dev runtime';
  }

  function normalizeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.assign({}, value);
  }

  function mergeCaptureMeta(base, extra) {
    return Object.assign({}, normalizeObject(base), normalizeObject(extra));
  }

  function updateBridgeControls() {
    sendToAppBtn.disabled = !bridgeConnected;
  }

  function showState(state) {
    loadingState.classList.toggle('hidden', state !== 'loading');
    errorState.classList.toggle('hidden', state !== 'error');
    jobForm.classList.toggle('hidden', state !== 'ready');
  }

  function activeTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function afterQuery(tabs) {
      return tabs[0];
    });
  }

  function setBadgeText(element, text, className) {
    element.textContent = text;
    element.className = 'badge ' + className;
  }

  function buildLegacyJobInfo(job) {
    var parts = [];
    if (job.title) parts.push('Title: ' + job.title);
    if (job.company) parts.push('Company: ' + job.company);
    if (job.location) parts.push('Location: ' + job.location);
    if (job.summary) parts.push(job.summary);
    if (job.qualifications && job.qualifications.length) parts.push('Qualifications\n' + job.qualifications.join('\n'));
    if (job.responsibilities && job.responsibilities.length) parts.push('Responsibilities\n' + job.responsibilities.join('\n'));
    return parts.join('\n\n').trim();
  }

  function normalizeJob(job) {
    var next = Object.assign({}, job || {});
    next.jobInfo = (next.jobInfo || buildLegacyJobInfo(next) || '').trim();
    next.sourceUrl = next.sourceUrl || next.url || '';
    next.url = next.url || next.sourceUrl || '';
    next.pageUrl = next.pageUrl || next.sourceUrl || next.url || '';
    next.status = next.status || 'needs_review';
    next.site = next.site || 'generic';
    next.summary = String(next.summary || '').trim();
    next.confidence = Number(next.confidence || 0);
    next.qualifications = Array.isArray(next.qualifications) ? next.qualifications.filter(Boolean) : [];
    next.responsibilities = Array.isArray(next.responsibilities) ? next.responsibilities.filter(Boolean) : [];
    next.sourceSignals = normalizeObject(next.sourceSignals);
    next.captureMeta = mergeCaptureMeta(next.captureMeta || next.capture_meta, {});
    next.employmentType = String(next.employmentType || '').trim();
    next.workplaceType = String(next.workplaceType || '').trim();
    next.salary = String(next.salary || '').trim();
    next.datePosted = String(next.datePosted || '').trim();
    next.validThrough = String(next.validThrough || '').trim();
    return next;
  }

  function decorateCapturedJob(job, importChannel) {
    var next = normalizeJob(job);
    next.captureMeta = mergeCaptureMeta(next.captureMeta, {
      captureChannel: 'chrome_extension',
      captureVersion: 2,
      desktopPreferred: true,
      bridgeTargetMode: currentTargetMode(),
      importChannel: importChannel,
      lastPreparedAt: new Date().toISOString()
    });
    return next;
  }

  function populateForm(job) {
    var item = normalizeJob(job);
    document.getElementById('roleTitle').value = item.title || '';
    document.getElementById('company').value = item.company || '';
    document.getElementById('location').value = item.location || '';
    document.getElementById('jobUrl').value = item.sourceUrl || item.url || '';
    document.getElementById('jobInfo').value = item.jobInfo || '';

    setBadgeText(document.getElementById('siteBadge'), item.site || 'generic', 'neutral');
    setBadgeText(
      document.getElementById('confidenceBadge'),
      item.confidence >= 70 ? ('Ready ' + item.confidence) : ('Review ' + item.confidence),
      item.confidence >= 70 ? 'ready' : 'review'
    );
  }

  function collectFormJob() {
    var base = normalizeJob(currentJob || {});
    var roleTitle = document.getElementById('roleTitle').value.trim();
    var company = document.getElementById('company').value.trim();
    var sourceLink = document.getElementById('jobUrl').value.trim();
    var jobInfo = document.getElementById('jobInfo').value.trim();

    return decorateCapturedJob({
      id: base.id || '',
      createdAt: base.createdAt || '',
      updatedAt: base.updatedAt || '',
      title: roleTitle,
      company: company,
      location: document.getElementById('location').value.trim(),
      url: sourceLink || base.url || '',
      sourceUrl: sourceLink || base.sourceUrl || '',
      pageUrl: base.pageUrl || sourceLink || base.url || '',
      sourcePageTitle: base.sourcePageTitle || roleTitle || document.title,
      sourceMode: base.sourceMode || 'chrome_extension_popup_review',
      jobInfo: jobInfo,
      summary: base.summary || '',
      qualifications: base.qualifications || [],
      responsibilities: base.responsibilities || [],
      confidence: Number(base.confidence || 0),
      site: base.site || 'generic',
      status: roleTitle && company && jobInfo.length >= 60 ? 'pending' : 'needs_review',
      appImportId: base.appImportId || '',
      lastImportedAt: base.lastImportedAt || '',
      sourceSignals: base.sourceSignals || {},
      captureMeta: base.captureMeta || {},
      employmentType: base.employmentType || '',
      workplaceType: base.workplaceType || '',
      salary: base.salary || '',
      datePosted: base.datePosted || '',
      validThrough: base.validThrough || ''
    }, 'popup_form');
  }

  function refreshBridgeStatus() {
    if (!window.CVCustomizerAppBridge) {
      bridgeConnected = false;
      updateBridgeControls();
      setBridgeMessage('App bridge is not available in this build.', 'error');
      return Promise.resolve();
    }

    syncTargetSelect();
    setBridgeMessage('Checking ' + bridgeTargetDescription() + '...', '');
    return window.CVCustomizerAppBridge.discoverApp().then(function afterDiscover(result) {
      bridgeConnected = !!(result && result.connected);
      updateBridgeControls();
      if (bridgeConnected) {
        var runtime = result.health && result.health.runtime ? result.health.runtime : 'server';
        if (String(runtime).toLowerCase() === 'desktop') {
          setBridgeMessage('Connected to the CV Customizer desktop app at ' + result.origin, 'success');
        } else {
          setBridgeMessage('Connected to the CV Customizer local runtime at ' + result.origin, 'success');
        }
      } else {
        setBridgeMessage((result && result.message) || 'CV Customizer is not running.', 'error');
      }
    }).catch(function onError(error) {
      bridgeConnected = false;
      updateBridgeControls();
      setBridgeMessage(error.message || 'Could not check app status.', 'error');
    });
  }

  function scrape() {
    setNotice('');
    showState('loading');

    return activeTab().then(function afterTab(tab) {
      if (!tab || !tab.id) throw new Error('No active tab found.');
      return chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_JOB' });
    }).then(function afterScrape(response) {
      if (!response || !response.ok || !response.job) {
        throw new Error((response && response.error) || 'The current page did not return job data.');
      }
      currentJob = decorateCapturedJob(response.job, 'popup_scrape');
      if (response.snapshot) {
        currentJob.captureMeta = mergeCaptureMeta(currentJob.captureMeta, {
          structuredDataJobs: Number(response.snapshot.structuredDataJobs || currentJob.captureMeta.structuredDataJobs || 0),
          selectedMode: response.snapshot.sourceMode || currentJob.captureMeta.selectedMode || '',
          rootScore: Number(response.snapshot.rootScore || currentJob.captureMeta.rootScore || 0)
        });
      }
      populateForm(currentJob);
      showState('ready');
      if (currentJob.sourceMode && (currentJob.sourceMode.indexOf('fallback') >= 0 || currentJob.sourceMode.indexOf('structured_data') >= 0)) {
        setNotice('Capture used smart fallback mode: ' + currentJob.sourceMode.replace(/_/g, ' '), 'success');
      }
    }).catch(function onError(error) {
      errorMessage.textContent = error.message || 'Failed to scrape the current page.';
      showState('error');
    });
  }

  function copyJson() {
    var payload = JSON.stringify(collectFormJob(), null, 2);
    return navigator.clipboard.writeText(payload).then(function afterCopy() {
      setNotice('Captured job copied as JSON.', 'success');
    }).catch(function onError() {
      setNotice('Could not copy JSON to clipboard.', 'error');
    });
  }

  function openPending() {
    return chrome.tabs.create({ url: chrome.runtime.getURL('pending.html') });
  }

  function saveToPending() {
    var job = collectFormJob();
    return JobCaptureStore.upsert(job).then(function afterSave(saved) {
      currentJob = normalizeJob(saved);
      setNotice('Saved to the pending capture queue with the source link.', 'success');
    }).catch(function onError(error) {
      setNotice(error.message || 'Could not save the job.', 'error');
    });
  }

  function sendToApp() {
    var job = decorateCapturedJob(collectFormJob(), 'popup_send_to_app');
    if (!job.title || !job.company || job.jobInfo.length < 60) {
      setNotice('Review the captured job before sending it to CV Customizer.', 'error');
      return Promise.resolve();
    }
    if (!window.CVCustomizerAppBridge) {
      setNotice('App bridge is not available in this build.', 'error');
      return Promise.resolve();
    }

    sendToAppBtn.disabled = true;
    setNotice('Sending captured job to CV Customizer...', '');

    return window.CVCustomizerAppBridge.importJob(job).then(function afterImport(result) {
      var savedJob = decorateCapturedJob(Object.assign({}, job, {
        appImportId: result && result.id ? String(result.id) : '',
        lastImportedAt: new Date().toISOString(),
        captureMeta: mergeCaptureMeta(job.captureMeta, {
          lastBridgeImportAt: new Date().toISOString(),
          lastBridgeImportId: result && result.id ? String(result.id) : ''
        })
      }), 'popup_import_complete');
      return JobCaptureStore.upsert(savedJob).then(function afterSave(saved) {
        currentJob = normalizeJob(saved);
        currentJob.appImportId = savedJob.appImportId;
        currentJob.lastImportedAt = savedJob.lastImportedAt;
        setNotice('Sent to CV Customizer and saved locally.', 'success');
      });
    }).catch(function onError(error) {
      setNotice(error.message || 'Could not send the job to CV Customizer.', 'error');
    }).finally(function onFinally() {
      refreshBridgeStatus();
    });
  }

  document.getElementById('jobForm').addEventListener('submit', function onSubmit(event) {
    event.preventDefault();
    saveToPending();
  });

  document.getElementById('copyJsonBtn').addEventListener('click', copyJson);
  document.getElementById('openPendingBtn').addEventListener('click', openPending);
  document.getElementById('openPendingBtnError').addEventListener('click', openPending);
  document.getElementById('retryBtn').addEventListener('click', scrape);
  document.getElementById('rescrapeBtn').addEventListener('click', scrape);
  document.getElementById('refreshBridgeBtn').addEventListener('click', refreshBridgeStatus);
  document.getElementById('sendToAppBtn').addEventListener('click', sendToApp);
  if (bridgeTargetSelect) {
    bridgeTargetSelect.addEventListener('change', function onTargetChange() {
      if (window.CVCustomizerAppBridge && typeof window.CVCustomizerAppBridge.setTargetMode === 'function') {
        window.CVCustomizerAppBridge.setTargetMode(bridgeTargetSelect.value);
        window.CVCustomizerAppBridge.resetCache();
      }
      refreshBridgeStatus();
    });
  }

  syncTargetSelect();
  refreshBridgeStatus();
  scrape();
}());
