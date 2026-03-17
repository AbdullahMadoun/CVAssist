# Chrome Job Capture Extension

This standalone extension scrapes job details from LinkedIn and similar career pages, keeps a pending queue, and can push normalized captures directly into a running CV Customizer desktop or server runtime.

## What It Does

- Scrapes the active tab for title, company, location, qualifications, responsibilities, and the job URL.
- Prefers the structured job details root, merges highlighted-job extractions, and falls back to full-page heuristics only when needed.
- Labels weak or incomplete captures so the user can decide whether to review before exporting.
- Stores captures in `chrome.storage.local` plus metadata (source site, dedupe hash, capture status).
- Provides a pending queue UI where captures can be filtered, edited, reopened, exported, or imported in bulk.
- Imports directly into CV Customizer via the app bridge (ports `3210`, `3001`, `3000`) when a runtime is detectible.
- Still supports JSON export for offline workflows, copies, or third-party systems.

## Surface Breakdown

- `popup.html`, `popup.js`, `popup.css`: UI that shows the current capture, lets you edit it, and either save to pending or drop it.
- `pending.html`, `pending.js`, `pending.css`: queue dashboard with filters, detailed review, reopen, export buttons, and a direct import hook.
- `content-script.js`: page scraping logic that negotiates between structured DOM roots, highlighted selections, and low-confidence fallbacks.
- `lib/extractor-core.js`: shared heuristics for data cleaning, dedupe, and normalization; reused by Jest-style tests.
- `manifest.json`: permissions, background scripts (if any), and declared content security policies.
- `test/`: automated tests (see below) that run the core extractor and bridge-detecting helpers.
- `demo-pages/`: static HTML fixtures that exercise LinkedIn-ish and generic job listing markup for manual QA.

## Installation

1. Start CV Customizer (desktop or `npm start` server) so the local bridge is live.
2. Visit `chrome://extensions` (or `edge://extensions`) and toggle **Developer mode** on.
3. Click **Load unpacked** and point at this repo's `chrome-job-capture-extension` folder.
4. Pin the extension to the toolbar for quick access.

Once loaded, the popup will display the bridge status at the top and automatically keep the job form in sync with any capture you edit.

## Bridge Detection & Import Flow

- When you click **Import to CV Customizer**, the extension probes the bridge in this priority:
  1. Desktop bridge (`http://127.0.0.1:3210/api/bridge/status`)
  2. Local dev server (`http://127.0.0.1:3001/api/bridge/status`)
  3. Legacy dev fallback (`http://127.0.0.1:3000/api/bridge/status`)
- The popup highlights whichever bridge it detects and only enables import when the bridge responds with a valid `status: ok`.
- Imports use the `/api/jobs/import` endpoint. When a job matches an existing capture by URL/title/company it updates the record instead of duplicating it.
- Pending queue import uses `/api/jobs/import-batch` so you can sync multiple captures with one click.

## Manual Testing

### Live Sites

1. Open a LinkedIn, Indeed, or other job listing page.
2. Click the extension icon; verify the fields populated and the capture score indicator.
3. Click **Add to Pending**.
4. Open the pending queue, filter, edit, and export a capture; confirm the exported JSON matches the edits.
5. While the app bridge is running, import the capture and confirm it appears in CV Customizer's Jobs list.

### Local Fixtures

1. Open `demo-pages/linkedin-like.html` or `demo-pages/generic-like.html` in the browser.
2. Reload the extension if you updated code.
3. Capture and import from the fixtures to ensure deterministic behavior.

## Automated Checks

From the repo root, run:

```powershell
node chrome-job-capture-extension\test\run-tests.js
node --check chrome-job-capture-extension\content-script.js
node --check chrome-job-capture-extension\popup.js
node --check chrome-job-capture-extension\pending.js
```

The `run-tests.js` script exercises `lib/extractor-core` and the bridge helpers without spawning blocked processes.

## Data Handling

- Captures are stored in `chrome.storage.local` under `pendingJobs`.
- Each capture keeps `site`, `sourceUrl`, `capture_meta`, and `jobInfo` for deduping.
- The export JSON preserves all normalized fields so you can replay the import or share it with teammates.

## Troubleshooting

- **Bridge not found?** Ensure CV Customizer is running on one of the bridge ports and the desktop app has started the server (`3210`, fallback to `3001` or `3000`). Reload the extension to refresh the cache.
- **Capture fields blank?** Highlight job sections on the page before clicking the icon; the extractor will merge them.
- **Pending queue stale?** Use the refresh button or open the pending page directly in the extension; it re-reads `chrome.storage.local`.

## Next Steps

1. Add new extraction heuristics in `lib/extractor-core.js` and update the test suite.
2. Wire the extension to the Chrome Web Store or Edge Add-ons when you are ready for distribution.
