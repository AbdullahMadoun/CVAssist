const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));

test('manifest references files that exist', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(extensionRoot, manifest.action.default_popup)));

  manifest.content_scripts.forEach((entry) => {
    entry.js.forEach((file) => {
      assert.ok(fs.existsSync(path.join(extensionRoot, file)), file + ' should exist');
    });
  });
});