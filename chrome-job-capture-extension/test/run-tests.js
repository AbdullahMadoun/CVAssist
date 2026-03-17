const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const extractor = require(path.join(__dirname, '..', 'lib', 'extractor-core.js'));
const appBridge = require(path.join(__dirname, '..', 'lib', 'app-bridge.js'));
const jobCapture = require(path.join(__dirname, '..', '..', 'server', 'job-capture.js'));

const extensionRoot = path.join(__dirname, '..');

async function run(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name);
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

function createLocalStorageMock(initial) {
  const store = Object.assign({}, initial || {});
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    }
  };
}

async function main() {
  await run('manifest references required files and icons', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(fs.existsSync(path.join(extensionRoot, manifest.action.default_popup)));
    Object.values(manifest.icons).forEach((file) => {
      assert.ok(fs.existsSync(path.join(extensionRoot, file)), file + ' should exist');
    });
    manifest.content_scripts.forEach((entry) => {
      entry.js.forEach((file) => {
        assert.ok(fs.existsSync(path.join(extensionRoot, file)), file + ' should exist');
      });
    });
  });

  await run('extracts structured LinkedIn-like job data', async () => {
    const job = extractor.extractJob({
      hostname: 'www.linkedin.com',
      url: 'https://www.linkedin.com/jobs/view/123',
      documentTitle: 'Machine Learning Engineer | Example AI',
      roleCandidates: ['Machine Learning Engineer'],
      companyCandidates: ['Example AI'],
      locationCandidates: ['Riyadh, Saudi Arabia (Hybrid)'],
      sections: [
        {
          heading: 'Responsibilities',
          text: '',
          items: [
            'Build and deploy production ML systems.',
            'Partner with product and engineering teams.',
            'Improve model latency and reliability.'
          ]
        },
        {
          heading: 'Qualifications',
          text: '',
          items: [
            '3+ years of Python experience.',
            'Experience with PyTorch and model serving.',
            'Strong SQL skills.'
          ]
        }
      ],
      listItems: [],
      bodyText: 'Build and deploy production ML systems. Experience with PyTorch and model serving.',
      rootScore: 18,
      structuredData: []
    });

    assert.equal(job.site, 'linkedin');
    assert.equal(job.title, 'Machine Learning Engineer');
    assert.equal(job.company, 'Example AI');
    assert.match(job.location, /Riyadh/);
    assert.ok(/PyTorch/i.test(job.jobInfo));
    assert.ok(/Improve model latency and reliability/i.test(job.jobInfo));
    assert.ok(job.qualifications.length >= 2);
    assert.ok(job.responsibilities.length >= 2);
    assert.ok(job.confidence >= 70);
  });

  await run('supports structured-data-first extraction for ATS-style sites', async () => {
    const job = extractor.extractJob({
      hostname: 'jobs.example.myworkdayjobs.com',
      url: 'https://jobs.example.myworkdayjobs.com/en-US/careers/job/123',
      documentTitle: 'Senior Data Engineer',
      roleCandidates: [],
      companyCandidates: [],
      locationCandidates: [],
      sections: [],
      listItems: [],
      bodyText: '',
      rootScore: 8,
      structuredData: [
        {
          title: 'Senior Data Engineer',
          company: 'Example Labs',
          location: 'Remote',
          description: 'Build reliable ETL systems. Own Spark pipelines. Partner with analytics and platform teams.',
          employmentType: 'Full-time',
          workplaceType: 'Remote',
          salary: 'USD 140000 - 180000 yearly',
          datePosted: '2026-03-01',
          validThrough: '2026-04-01',
          url: 'https://jobs.example.myworkdayjobs.com/en-US/careers/job/123',
          identifier: 'REQ-123'
        }
      ]
    });

    assert.equal(job.site, 'workday');
    assert.equal(job.title, 'Senior Data Engineer');
    assert.equal(job.company, 'Example Labs');
    assert.equal(job.location, 'Remote');
    assert.equal(job.employmentType, 'Full-time');
    assert.equal(job.workplaceType, 'Remote');
    assert.ok(/Spark pipelines/i.test(job.jobInfo));
    assert.ok(job.confidence >= 70);
  });

  await run('supports broader qualification and responsibility headings', async () => {
    const job = extractor.extractJob({
      hostname: 'example.com',
      url: 'https://example.com/role',
      documentTitle: 'Senior Data Engineer - Example Labs',
      roleCandidates: ['Senior Data Engineer'],
      companyCandidates: ['Example Labs'],
      locationCandidates: ['Remote'],
      sections: [
        {
          heading: "What we're looking for",
          text: '',
          items: [
            'Experience with Spark and large-scale pipelines.',
            '5+ years of data engineering experience.'
          ]
        },
        {
          heading: 'In this role',
          text: '',
          items: [
            'Design and maintain reliable ETL systems.',
            'Partner with analytics and platform teams.'
          ]
        }
      ],
      listItems: [],
      bodyText: 'Design and maintain reliable ETL systems.',
      rootScore: 16,
      structuredData: []
    });

    assert.ok(/Spark/i.test(job.jobInfo));
    assert.ok(/ETL systems/i.test(job.jobInfo));
    assert.ok(job.qualifications.some((line) => /Spark/i.test(line)));
    assert.ok(job.responsibilities.some((line) => /ETL systems/i.test(line)));
  });

  await run('falls back to generic extraction when headings are weak', async () => {
    const job = extractor.extractJob({
      hostname: 'jobs.example.com',
      url: 'https://jobs.example.com/backend-role',
      documentTitle: 'Backend Engineer - Example Cloud',
      roleCandidates: ['Backend Engineer'],
      companyCandidates: ['Example Cloud'],
      locationCandidates: ['Remote'],
      sections: [],
      listItems: [
        'Required: experience with Node.js and PostgreSQL.',
        'You will build APIs and maintain backend services.',
        'Nice to have: experience with Docker.'
      ],
      bodyText: 'Required: experience with Node.js and PostgreSQL. You will build APIs and maintain backend services.',
      rootScore: 12,
      structuredData: []
    });

    assert.equal(job.site, 'generic');
    assert.equal(job.title, 'Backend Engineer');
    assert.equal(job.company, 'Example Cloud');
    assert.ok(/Node\.js/i.test(job.jobInfo));
    assert.ok(/build APIs/i.test(job.jobInfo));
    assert.ok(job.qualifications.some((line) => /Node\.js/i.test(line)));
    assert.ok(job.responsibilities.some((line) => /build APIs/i.test(line)));
  });

  await run('marks weak captures for review', async () => {
    const job = extractor.extractJob({
      hostname: 'example.com',
      url: 'https://example.com/job',
      documentTitle: 'Careers',
      roleCandidates: ['Careers'],
      companyCandidates: [],
      locationCandidates: [],
      sections: [],
      listItems: [],
      bodyText: 'Apply now.',
      rootScore: 2,
      structuredData: []
    });

    assert.equal(job.status, 'needs_review');
    assert.ok(job.confidence < 70);
  });

  await run('preserves richer extension capture metadata for app import', async () => {
    const payload = jobCapture.normalizeCapturedJobPayload({
      title: 'Senior Data Engineer',
      company: 'Example Labs',
      location: 'Remote',
      sourceUrl: 'https://jobs.example.com/123',
      jobInfo: 'Build reliable ETL systems and own Spark pipelines.',
      sourceMode: 'structured_data+focused_root',
      confidence: 88,
      sourceSignals: { structuredDataJobs: 1, rootScore: 22 },
      captureMeta: {
        captureChannel: 'chrome_extension',
        strategies: ['structured_data', 'focused_root'],
        selectedMode: 'structured_data',
        structuredDataJobs: 1
      },
      employmentType: 'Full-time',
      workplaceType: 'Remote',
      salary: 'USD 140000 - 180000 yearly',
      datePosted: '2026-03-01',
      validThrough: '2026-04-01'
    });

    const meta = JSON.parse(payload.capture_meta);
    assert.equal(payload.title, 'Senior Data Engineer');
    assert.equal(payload.company, 'Example Labs');
    assert.equal(meta.captureChannel, 'chrome_extension');
    assert.deepEqual(meta.strategies, ['structured_data', 'focused_root']);
    assert.equal(meta.sourceSignals.structuredDataJobs, 1);
    assert.equal(meta.employmentType, 'Full-time');
    assert.equal(meta.workplaceType, 'Remote');
  });

  await run('discovers the first available CV Customizer app origin', async () => {
    appBridge.resetCache();
    const calls = [];
    async function fakeFetch(url) {
      calls.push(url);
      if (url === 'http://127.0.0.1:3210/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'desktop'
          })
        };
      }
      throw new Error('offline');
    }

    const result = await appBridge.discoverApp(fakeFetch);
    assert.equal(result.connected, true);
    assert.equal(result.origin, 'http://127.0.0.1:3210');
    assert.equal(result.statusPath, '/api/bridge/status');
    assert.ok(calls.includes('http://127.0.0.1:3210/api/bridge/status'));
  });

  await run('falls back to legacy health discovery when needed', async () => {
    appBridge.resetCache();
    const calls = [];
    async function fakeFetch(url) {
      calls.push(url);
      if (url === 'http://127.0.0.1:3210/api/bridge/status') {
        return { ok: false, json: async () => ({ error: 'missing' }) };
      }
      if (url === 'http://127.0.0.1:3210/api/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        };
      }
      throw new Error('offline');
    }

    const result = await appBridge.discoverApp(fakeFetch);
    assert.equal(result.connected, true);
    assert.equal(result.statusPath, '/api/health');
    assert.ok(calls.includes('http://127.0.0.1:3210/api/bridge/status'));
    assert.ok(calls.includes('http://127.0.0.1:3210/api/health'));
  });

  await run('imports a captured job through the app bridge', async () => {
    appBridge.resetCache();
    const requests = [];
    async function fakeFetch(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/api/bridge/status')) {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'desktop'
          })
        };
      }
      if (url.endsWith('/api/jobs/import')) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.title, 'Imported Role');
        assert.ok(/grounded job info/i.test(payload.jobInfo));
        return {
          ok: true,
          json: async () => ({ id: 12, created: true })
        };
      }
      throw new Error('Unexpected request');
    }

    const result = await appBridge.importJob({
      title: 'Imported Role',
      company: 'Example Company',
      jobInfo: 'Grounded job info with enough detail for import.'
    }, fakeFetch);

    assert.equal(result.id, 12);
    assert.ok(requests.some((entry) => entry.url.endsWith('/api/jobs/import')));
  });

  await run('prefers the desktop runtime when desktop and dev server are both available', async () => {
    appBridge.resetCache();

    async function fakeFetch(url) {
      if (url === 'http://127.0.0.1:3210/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'desktop'
          })
        };
      }
      if (url === 'http://127.0.0.1:3001/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'server'
          })
        };
      }
      throw new Error('offline');
    }

    const result = await appBridge.discoverApp(fakeFetch);
    assert.equal(result.connected, true);
    assert.equal(result.origin, 'http://127.0.0.1:3210');
    assert.equal(result.health.runtime, 'desktop');
  });

  await run('switches away from a cached dev server when a desktop app becomes available', async () => {
    appBridge.resetCache();

    async function devOnlyFetch(url) {
      if (url === 'http://127.0.0.1:3001/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'server'
          })
        };
      }
      throw new Error('offline');
    }

    const first = await appBridge.discoverApp(devOnlyFetch);
    assert.equal(first.origin, 'http://127.0.0.1:3001');

    async function desktopAndDevFetch(url) {
      if (url === 'http://127.0.0.1:3001/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'server'
          })
        };
      }
      if (url === 'http://127.0.0.1:3210/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'desktop'
          })
        };
      }
      throw new Error('offline');
    }

    const second = await appBridge.discoverApp(desktopAndDevFetch);
    assert.equal(second.origin, 'http://127.0.0.1:3210');
    assert.equal(second.health.runtime, 'desktop');
  });

  await run('respects an explicit dev target even when desktop is available', async () => {
    global.localStorage = createLocalStorageMock();
    appBridge.resetCache();
    appBridge.setTargetMode('dev');

    async function fakeFetch(url) {
      if (url === 'http://127.0.0.1:3001/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'server'
          })
        };
      }
      if (url === 'http://127.0.0.1:3210/api/bridge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'cv-customizer',
            bridge: { protocolVersion: 1 },
            runtime: 'desktop'
          })
        };
      }
      throw new Error('offline');
    }

    const result = await appBridge.discoverApp(fakeFetch);
    assert.equal(appBridge.getTargetMode(), 'dev');
    assert.equal(result.origin, 'http://127.0.0.1:3001');
    delete global.localStorage;
  });

  await run('reports a dev-target-specific error when port 3001 is unavailable', async () => {
    global.localStorage = createLocalStorageMock();
    appBridge.resetCache();
    appBridge.setTargetMode('dev');

    const result = await appBridge.discoverApp(async function fakeFetch() {
      throw new Error('offline');
    });

    assert.equal(result.connected, false);
    assert.match(result.message, /port 3001/i);
    delete global.localStorage;
  });

  if (!process.exitCode) {
    console.log('All extension checks passed.');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
