(function initJobStore(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.JobCaptureStore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  var STORAGE_KEY = 'cvCustomizerPendingJobs';

  function getStorage() {
    return chrome.storage.local;
  }

  function getAll() {
    return getStorage().get(STORAGE_KEY).then(function afterGet(result) {
      return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    });
  }

  function saveAll(items) {
    var payload = {};
    payload[STORAGE_KEY] = items;
    return getStorage().set(payload);
  }

  function nextId() {
    return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function upsert(job) {
    return getAll().then(function afterGet(items) {
      var now = new Date().toISOString();
      var next = Object.assign({}, job);
      next.id = next.id || nextId();
      next.createdAt = next.createdAt || now;
      next.updatedAt = now;

      var index = items.findIndex(function findItem(item) {
        return item.id === next.id;
      });

      if (index >= 0) items[index] = next;
      else items.unshift(next);

      return saveAll(items).then(function afterSave() {
        return next;
      });
    });
  }

  function remove(id) {
    return getAll().then(function afterGet(items) {
      return saveAll(items.filter(function keepItem(item) {
        return item.id !== id;
      }));
    });
  }

  function exportAll() {
    return getAll().then(function afterGet(items) {
      return JSON.stringify(items, null, 2);
    });
  }

  return {
    getAll: getAll,
    upsert: upsert,
    remove: remove,
    exportAll: exportAll
  };
}));
