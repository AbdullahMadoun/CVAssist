(function initPendingPage() {
  'use strict';

  var items = [];
  var selectedId = '';
  var bridgeConnected = false;
  var bridgeTargetSelect = document.getElementById('bridgeTargetSelect');

  function badgeClassFor(item) {
    if (item.confidence >= 70) return 'ready';
    if (item.status === 'needs_review') return 'review';
    return 'neutral';
  }

  function confidenceLabel(item) {
    if (item.confidence >= 70) return 'Ready ' + item.confidence;
    return 'Review ' + (item.confidence || 0);
  }

  function editorNotice(message, type) {
    var notice = document.getElementById('editorNotice');
    notice.textContent = message || '';
    notice.className = 'notice' + (type ? ' ' + type : '');
  }

  function setSyncStatus(message, type) {
    var notice = document.getElementById('syncStatus');
    notice.textContent = message || '';
    notice.className = 'sync-text' + (type ? ' ' + type : '');
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

  function updateBridgeButtons() {
    var hasSelected = !!findSelected();
    var readyCount = getSyncReadyItems().length;
    document.getElementById('sendSelectedBtn').disabled = !bridgeConnected || !hasSelected;
    document.getElementById('sendReadyBtn').disabled = !bridgeConnected || !readyCount;
  }

  function buildLegacyJobInfo(item) {
    var parts = [];
    if (item.title) parts.push('Title: ' + item.title);
    if (item.company) parts.push('Company: ' + item.company);
    if (item.location) parts.push('Location: ' + item.location);
    if (item.summary) parts.push(item.summary);
    if (item.qualifications && item.qualifications.length) parts.push('Qualifications\n' + item.qualifications.join('\n'));
    if (item.responsibilities && item.responsibilities.length) parts.push('Responsibilities\n' + item.responsibilities.join('\n'));
    return parts.join('\n\n').trim();
  }

  function normalizeItem(item) {
    var next = Object.assign({}, item || {});
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

  function decorateCapturedJob(item, importChannel) {
    var next = normalizeItem(item);
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

  function findSelected() {
    return items.find(function findItem(item) {
      return item.id === selectedId;
    }) || null;
  }

  function filteredItems() {
    var query = document.getElementById('searchInput').value.trim().toLowerCase();
    var status = document.getElementById('statusFilter').value;
    return items.filter(function keepItem(item) {
      var matchesQuery = !query ||
        (item.title || '').toLowerCase().includes(query) ||
        (item.company || '').toLowerCase().includes(query);
      var matchesStatus = !status || item.status === status;
      return matchesQuery && matchesStatus;
    });
  }

  function getSyncReadyItems() {
    return items.filter(function keepItem(item) {
      return item.status !== 'needs_review' && item.status !== 'applied' && item.title && item.company && (item.jobInfo || '').trim().length >= 60;
    });
  }

  function renderMetrics() {
    document.getElementById('metricTotal').textContent = items.length;
    document.getElementById('metricReview').textContent = items.filter(function filterItem(item) {
      return item.status === 'needs_review';
    }).length;
    document.getElementById('metricPending').textContent = items.filter(function filterItem(item) {
      return item.status === 'pending' || item.status === 'ready';
    }).length;
    document.getElementById('metricApplied').textContent = items.filter(function filterItem(item) {
      return item.status === 'applied';
    }).length;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderList() {
    var list = document.getElementById('jobList');
    var visible = filteredItems();

    if (!visible.length) {
      list.innerHTML = '<div class="job-card"><p>No jobs match the current filters.</p></div>';
      return;
    }

    list.innerHTML = visible.map(function mapItem(item) {
      return [
        '<article class="job-card ' + (item.id === selectedId ? 'active' : '') + '" data-id="' + item.id + '">',
        '<h3>' + escapeHtml(item.title || 'Untitled role') + '</h3>',
        '<p>' + escapeHtml(item.company || 'Unknown company') + '</p>',
        '<div class="job-card-meta">',
        '<span class="badge ' + badgeClassFor(item) + '">' + escapeHtml(confidenceLabel(item)) + '</span>',
        '<span class="badge neutral">' + escapeHtml(item.status || 'pending') + '</span>',
        '<span class="badge neutral">' + escapeHtml(item.site || 'generic') + '</span>',
        '</div>',
        '</article>'
      ].join('');
    }).join('');

    list.querySelectorAll('.job-card').forEach(function eachCard(card) {
      card.addEventListener('click', function onClick() {
        selectedId = card.dataset.id;
        render();
      });
    });
  }

  function renderEditor() {
    var editor = document.getElementById('editorForm');
    var empty = document.getElementById('emptyEditor');
    var item = findSelected();

    if (!item) {
      editor.classList.add('hidden');
      empty.classList.remove('hidden');
      updateBridgeButtons();
      return;
    }

    empty.classList.add('hidden');
    editor.classList.remove('hidden');

    document.getElementById('editorTitle').textContent = item.title || 'Untitled role';
    document.getElementById('editTitle').value = item.title || '';
    document.getElementById('editCompany').value = item.company || '';
    document.getElementById('editLocation').value = item.location || '';
    document.getElementById('editUrl').value = item.sourceUrl || item.url || '';
    document.getElementById('editStatus').value = item.status || 'needs_review';
    document.getElementById('editJobInfo').value = item.jobInfo || '';

    var confidenceBadge = document.getElementById('editorConfidence');
    confidenceBadge.textContent = confidenceLabel(item);
    confidenceBadge.className = 'badge ' + badgeClassFor(item);
    updateBridgeButtons();
  }

  function render() {
    renderMetrics();
    renderList();
    renderEditor();
    updateBridgeButtons();
  }

  function loadItems() {
    return JobCaptureStore.getAll().then(function afterLoad(result) {
      items = result.map(normalizeItem);
      if (!selectedId && items.length) selectedId = items[0].id;
      if (selectedId && !findSelected()) selectedId = items.length ? items[0].id : '';
      render();
    });
  }

  function currentFormItem() {
    var item = normalizeItem(findSelected() || {});
    var sourceLink = document.getElementById('editUrl').value.trim();
    var jobInfo = document.getElementById('editJobInfo').value.trim();
    var title = document.getElementById('editTitle').value.trim();
    var company = document.getElementById('editCompany').value.trim();

    return decorateCapturedJob({
      id: item.id || '',
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
      confidence: item.confidence || 0,
      site: item.site || 'generic',
      sourceMode: item.sourceMode || 'chrome_extension_pending_queue_edit',
      sourcePageTitle: item.sourcePageTitle || title || document.title,
      pageUrl: item.pageUrl || sourceLink || item.url || '',
      title: title,
      company: company,
      location: document.getElementById('editLocation').value.trim(),
      url: sourceLink || item.url || '',
      sourceUrl: sourceLink || item.sourceUrl || '',
      status: document.getElementById('editStatus').value,
      jobInfo: jobInfo,
      summary: item.summary || '',
      qualifications: item.qualifications || [],
      responsibilities: item.responsibilities || [],
      appImportId: item.appImportId || '',
      lastImportedAt: item.lastImportedAt || '',
      sourceSignals: item.sourceSignals || {},
      captureMeta: item.captureMeta || {},
      employmentType: item.employmentType || '',
      workplaceType: item.workplaceType || '',
      salary: item.salary || '',
      datePosted: item.datePosted || '',
      validThrough: item.validThrough || ''
    }, 'pending_form');
  }

  function refreshBridgeStatus() {
    if (!window.CVCustomizerAppBridge) {
      bridgeConnected = false;
      updateBridgeButtons();
      setSyncStatus('App bridge is not available in this build.', 'error');
      return Promise.resolve();
    }

    syncTargetSelect();
    setSyncStatus('Checking ' + bridgeTargetDescription() + '...', '');
    return window.CVCustomizerAppBridge.discoverApp().then(function afterDiscover(result) {
      bridgeConnected = !!(result && result.connected);
      updateBridgeButtons();
      if (bridgeConnected) {
        var runtime = result.health && result.health.runtime ? result.health.runtime : 'server';
        if (String(runtime).toLowerCase() === 'desktop') {
          setSyncStatus('Connected to the CV Customizer desktop app at ' + result.origin, 'success');
        } else {
          setSyncStatus('Connected to the CV Customizer local runtime at ' + result.origin, 'success');
        }
      } else {
        setSyncStatus((result && result.message) || 'CV Customizer is not running.', 'error');
      }
    }).catch(function onError(error) {
      bridgeConnected = false;
      updateBridgeButtons();
      setSyncStatus(error.message || 'Could not check app status.', 'error');
    });
  }

  function markImported(item, importId) {
    return JobCaptureStore.upsert(decorateCapturedJob(Object.assign({}, item, {
      appImportId: importId ? String(importId) : item.appImportId || '',
      lastImportedAt: new Date().toISOString(),
      captureMeta: mergeCaptureMeta(item.captureMeta, {
        lastBridgeImportAt: new Date().toISOString(),
        lastBridgeImportId: importId ? String(importId) : ''
      })
    }), 'pending_import_complete'));
  }

  function sendSelected() {
    var item = decorateCapturedJob(currentFormItem(), 'pending_send_selected');
    if (!item.id) {
      editorNotice('Select a job before sending it to CV Customizer.', 'error');
      return Promise.resolve();
    }
    if (!item.title || !item.company || item.jobInfo.length < 60) {
      editorNotice('Selected job needs more detail before it can be sent.', 'error');
      return Promise.resolve();
    }
    if (!window.CVCustomizerAppBridge) {
      editorNotice('App bridge is not available in this build.', 'error');
      return Promise.resolve();
    }

    editorNotice('Sending selected job to CV Customizer...', '');
    return window.CVCustomizerAppBridge.importJob(item).then(function afterImport(result) {
      return markImported(item, result && result.id).then(function afterSave() {
        editorNotice('Selected job sent to CV Customizer.', 'success');
        return loadItems();
      });
    }).catch(function onError(error) {
      editorNotice(error.message || 'Could not send the selected job.', 'error');
    }).finally(function onFinally() {
      refreshBridgeStatus();
    });
  }

  function sendReadyJobs() {
    var readyJobs = getSyncReadyItems().map(function mapItem(item) {
      return decorateCapturedJob(item, 'pending_send_ready');
    });
    if (!readyJobs.length) {
      editorNotice('No ready jobs are available to send.', 'error');
      return Promise.resolve();
    }
    if (!window.CVCustomizerAppBridge) {
      editorNotice('App bridge is not available in this build.', 'error');
      return Promise.resolve();
    }

    editorNotice('Sending ' + readyJobs.length + ' job(s) to CV Customizer...', '');
    return window.CVCustomizerAppBridge.importJobs(readyJobs).then(function afterImport(result) {
      var importedCount = Number(result && result.imported ? result.imported : readyJobs.length);
      return Promise.all(readyJobs.map(function eachItem(item) {
        return markImported(item, '');
      })).then(function afterSave() {
        editorNotice('Sent ' + importedCount + ' ready job(s) to CV Customizer.', 'success');
        return loadItems();
      });
    }).catch(function onError(error) {
      editorNotice(error.message || 'Could not send ready jobs.', 'error');
    }).finally(function onFinally() {
      refreshBridgeStatus();
    });
  }

  document.getElementById('searchInput').addEventListener('input', renderList);
  document.getElementById('statusFilter').addEventListener('change', renderList);

  document.getElementById('newJobBtn').addEventListener('click', function onNewJob() {
    var next = decorateCapturedJob({
      id: 'job_' + Date.now(),
      title: '',
      company: '',
      location: '',
      url: '',
      sourceUrl: '',
      pageUrl: '',
      sourcePageTitle: '',
      sourceMode: 'chrome_extension_manual',
      jobInfo: '',
      summary: '',
      qualifications: [],
      responsibilities: [],
      confidence: 0,
      site: 'manual',
      status: 'needs_review',
      createdAt: new Date().toISOString(),
      sourceSignals: {},
      captureMeta: {}
    }, 'pending_new_manual');
    JobCaptureStore.upsert(next).then(function afterSave(saved) {
      selectedId = saved.id;
      editorNotice('Blank job added to the queue.', 'success');
      return loadItems();
    });
  });

  document.getElementById('editorForm').addEventListener('submit', function onSubmit(event) {
    event.preventDefault();
    var next = currentFormItem();
    JobCaptureStore.upsert(next).then(function afterSave(saved) {
      selectedId = saved.id;
      editorNotice('Changes saved.', 'success');
      return loadItems();
    }).catch(function onError(error) {
      editorNotice(error.message || 'Could not save changes.', 'error');
    });
  });

  document.getElementById('deleteBtn').addEventListener('click', function onDelete() {
    var item = findSelected();
    if (!item) return;
    JobCaptureStore.remove(item.id).then(function afterDelete() {
      selectedId = '';
      editorNotice('Job removed from the queue.', 'success');
      return loadItems();
    });
  });

  document.getElementById('copySelectedBtn').addEventListener('click', function onCopy() {
    var item = currentFormItem();
    navigator.clipboard.writeText(JSON.stringify(item, null, 2)).then(function afterCopy() {
      editorNotice('Selected job copied as JSON.', 'success');
    }).catch(function onError() {
      editorNotice('Could not copy JSON.', 'error');
    });
  });

  document.getElementById('openSourceBtn').addEventListener('click', function onOpen() {
    var item = findSelected();
    var url = item && (item.sourceUrl || item.url);
    if (url) chrome.tabs.create({ url: url });
  });

  document.getElementById('exportBtn').addEventListener('click', function onExport() {
    JobCaptureStore.exportAll().then(function afterExport(data) {
      var blob = new Blob([data], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'cv-customizer-pending-jobs.json';
      anchor.click();
      URL.revokeObjectURL(url);
    });
  });

  document.getElementById('refreshBridgeBtn').addEventListener('click', refreshBridgeStatus);
  document.getElementById('sendSelectedBtn').addEventListener('click', sendSelected);
  document.getElementById('sendReadyBtn').addEventListener('click', sendReadyJobs);
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
  loadItems();
}());
