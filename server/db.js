const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { resolveDataDir } = require('./runtime-paths');

const DATA_DIR = resolveDataDir();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATABASE_PATH = path.join(DATA_DIR, 'cv_customizer.db');

let db;
try {
  db = new Database(DATABASE_PATH);
} catch (error) {
  if (error && error.code === 'ERR_DLOPEN_FAILED') {
    error.message = [
      'Could not load better-sqlite3 for the current runtime.',
      `Node version: ${process.version}`,
      'The native module was likely built for a different Node or Electron ABI.',
      'Run `npm run rebuild:native` from the repo root, then start the server again.',
      '',
      error.message,
    ].join('\n');
  } else if (error && /unable to open database file/i.test(String(error.message))) {
    error.message = [
      'SQLite could not open the database file.',
      `Data directory: ${DATA_DIR}`,
      `Database path: ${DATABASE_PATH}`,
      `Current working directory: ${process.cwd()}`,
      '',
      error.message,
    ].join('\n');
  }
  throw error;
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL DEFAULT 'Default',
    latex       TEXT    NOT NULL,
    stories     TEXT    DEFAULT '[]',
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company     TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL,
    url         TEXT    DEFAULT '',
    source      TEXT    DEFAULT 'manual',
    location    TEXT    DEFAULT '',
    capture_meta TEXT   DEFAULT '{}',
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS genres (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT    NOT NULL,
    description          TEXT    DEFAULT '',
    focus_tags           TEXT    DEFAULT '[]',
    preferred_signals    TEXT    DEFAULT '[]',
    de_emphasized_signals TEXT   DEFAULT '[]',
    created_at           TEXT    DEFAULT (datetime('now')),
    updated_at           TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vault_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    title            TEXT    NOT NULL DEFAULT 'Saved Experience',
    tag              TEXT    DEFAULT 'general',
    section_hint     TEXT    DEFAULT '',
    status           TEXT    DEFAULT 'grounded',
    text             TEXT    NOT NULL,
    preferred_bullet TEXT    DEFAULT '',
    source           TEXT    DEFAULT 'manual',
    created_at       TEXT    DEFAULT (datetime('now')),
    updated_at       TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status          TEXT    DEFAULT 'pending',
    genre_name      TEXT    DEFAULT '',
    strictness      TEXT    DEFAULT 'balanced',
    outcome         TEXT    DEFAULT '',
    outcome_updated_at TEXT DEFAULT NULL,
    parsed_req      TEXT    DEFAULT NULL,
    alignment       TEXT    DEFAULT NULL,
    edited_latex    TEXT    DEFAULT NULL,
    report          TEXT    DEFAULT NULL,
    token_usage     TEXT    DEFAULT '{}',
    created_at      TEXT    DEFAULT (datetime('now')),
    updated_at      TEXT    DEFAULT (datetime('now'))
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

ensureColumn('sessions', 'outcome', `outcome TEXT DEFAULT ''`);
ensureColumn('sessions', 'outcome_updated_at', `outcome_updated_at TEXT DEFAULT NULL`);
ensureColumn('sessions', 'genre_name', `genre_name TEXT DEFAULT ''`);
ensureColumn('sessions', 'strictness', `strictness TEXT DEFAULT 'balanced'`);
ensureColumn('jobs', 'source', `source TEXT DEFAULT 'manual'`);
ensureColumn('jobs', 'location', `location TEXT DEFAULT ''`);
ensureColumn('jobs', 'capture_meta', `capture_meta TEXT DEFAULT '{}'`);
ensureColumn('jobs', 'updated_at', `updated_at TEXT DEFAULT ''`);
ensureColumn('vault_items', 'source', `source TEXT DEFAULT 'manual'`);
ensureColumn('vault_items', 'section_hint', `section_hint TEXT DEFAULT ''`);

// ── Profiles ────────────────────────────────────────────────────────────
const profileStmts = {
  all:    db.prepare('SELECT * FROM profiles ORDER BY updated_at DESC'),
  byId:   db.prepare('SELECT * FROM profiles WHERE id = ?'),
  insert: db.prepare('INSERT INTO profiles (name, latex, stories) VALUES (?, ?, ?)'),
  update: db.prepare('UPDATE profiles SET name=?, latex=?, stories=?, updated_at=datetime(\'now\') WHERE id=?'),
  delete: db.prepare('DELETE FROM profiles WHERE id = ?'),
};

// ── Jobs ────────────────────────────────────────────────────────────────
const jobStmts = {
  all:    db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, created_at DESC'),
  byId:   db.prepare('SELECT * FROM jobs WHERE id = ?'),
  byUrl:  db.prepare('SELECT * FROM jobs WHERE url = ? ORDER BY created_at DESC LIMIT 1'),
  byTitleCompany: db.prepare('SELECT * FROM jobs WHERE lower(company) = lower(?) AND lower(title) = lower(?) ORDER BY created_at DESC LIMIT 1'),
  insert: db.prepare(`
    INSERT INTO jobs (company, title, description, url, source, location, capture_meta, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `),
  updateImported: db.prepare(`
    UPDATE jobs
    SET company=?, title=?, description=?, url=?, source=?, location=?, capture_meta=?, updated_at=datetime('now')
    WHERE id=?
  `),
  delete: db.prepare('DELETE FROM jobs WHERE id = ?'),
};

// ── Vault Items ─────────────────────────────────────────────────────────
const vaultItemStmts = {
  all: db.prepare(`
    SELECT v.*, p.name AS profile_name
    FROM vault_items v
    JOIN profiles p ON v.profile_id = p.id
    ORDER BY v.updated_at DESC, v.created_at DESC
  `),
  byId: db.prepare(`
    SELECT v.*, p.name AS profile_name
    FROM vault_items v
    JOIN profiles p ON v.profile_id = p.id
    WHERE v.id = ?
  `),
  byProfile: db.prepare(`
    SELECT v.*, p.name AS profile_name
    FROM vault_items v
    JOIN profiles p ON v.profile_id = p.id
    WHERE v.profile_id = ?
    ORDER BY v.updated_at DESC, v.created_at DESC
  `),
  countByProfile: db.prepare('SELECT COUNT(*) AS count FROM vault_items WHERE profile_id = ?'),
  insert: db.prepare(`
    INSERT INTO vault_items (profile_id, title, tag, section_hint, status, text, preferred_bullet, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE vault_items
    SET profile_id=?, title=?, tag=?, section_hint=?, status=?, text=?, preferred_bullet=?, source=?, updated_at=datetime('now')
    WHERE id=?
  `),
  delete: db.prepare('DELETE FROM vault_items WHERE id = ?'),
};

// ── Genres ──────────────────────────────────────────────────────────────
const genreStmts = {
  all: db.prepare('SELECT * FROM genres ORDER BY updated_at DESC, created_at DESC'),
  byId: db.prepare('SELECT * FROM genres WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO genres (name, description, focus_tags, preferred_signals, de_emphasized_signals)
    VALUES (?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE genres
    SET name=?, description=?, focus_tags=?, preferred_signals=?, de_emphasized_signals=?, updated_at=datetime('now')
    WHERE id=?
  `),
  delete: db.prepare('DELETE FROM genres WHERE id = ?'),
};

// ── Sessions ────────────────────────────────────────────────────────────
const sessionStmts = {
  all:    db.prepare(`
    SELECT s.*, j.company, j.title as job_title, p.name as profile_name
    FROM sessions s
    JOIN jobs j ON s.job_id = j.id
    JOIN profiles p ON s.profile_id = p.id
    ORDER BY s.created_at DESC
  `),
  byId:   db.prepare(`
    SELECT s.*, j.company, j.title as job_title, p.name as profile_name
    FROM sessions s
    JOIN jobs j ON s.job_id = j.id
    JOIN profiles p ON s.profile_id = p.id
    WHERE s.id = ?
  `),
  insert: db.prepare('INSERT INTO sessions (profile_id, job_id, status, genre_name, strictness) VALUES (?, ?, ?, ?, ?)'),
  update: db.prepare(`
    UPDATE sessions SET status=?, parsed_req=?, alignment=?, edited_latex=?,
    report=?, token_usage=?, updated_at=datetime('now') WHERE id=?
  `),
  updateStage: db.prepare(`
    UPDATE sessions SET status=?, updated_at=datetime('now') WHERE id=?
  `),
  updateOutcome: db.prepare(`
    UPDATE sessions
    SET outcome=?, outcome_updated_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `),
  updateReviewState: db.prepare(`
    UPDATE sessions
    SET edited_latex=?, report=?, token_usage=?, updated_at=datetime('now')
    WHERE id=?
  `),
  delete: db.prepare('DELETE FROM sessions WHERE id = ?'),
};

function parseStories(rawStories) {
  if (!rawStories) return [];
  if (Array.isArray(rawStories)) return rawStories;
  try {
    const parsed = JSON.parse(rawStories);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function deriveVaultTitle(story = {}, index = 0) {
  const source = String(story.title || story.text || story.preferred_bullet || '').trim();
  if (!source) return `Saved Experience ${index + 1}`;
  return source.split(/[.!?]/)[0].slice(0, 80) || `Saved Experience ${index + 1}`;
}

function migrateLegacyStoriesToVault() {
  const profiles = profileStmts.all.all();
  profiles.forEach((profile) => {
    const existing = vaultItemStmts.countByProfile.get(profile.id);
    if ((existing?.count || 0) > 0) return;

    const stories = parseStories(profile.stories);
    stories.forEach((story, index) => {
      const createdAt = story.created_at || profile.created_at || new Date().toISOString();
      const updatedAt = story.updated_at || profile.updated_at || createdAt;
      const text = String(story.text || '').trim();
      if (!text) return;
      vaultItemStmts.insert.run(
        profile.id,
        deriveVaultTitle(story, index),
        String(story.tag || 'general').trim() || 'general',
        String(story.section_hint || '').trim(),
        String(story.status || 'grounded').trim() || 'grounded',
        text,
        String(story.preferred_bullet || '').trim(),
        'legacy-profile-story',
        createdAt,
        updatedAt
      );
    });
  });
}

migrateLegacyStoriesToVault();

module.exports = {
  DATA_DIR,
  DATABASE_PATH,
  db,
  profiles: {
    all:    () => profileStmts.all.all(),
    byId:   (id) => profileStmts.byId.get(id),
    create: (name, latex, stories = '[]') => profileStmts.insert.run(name, latex, stories),
    update: (id, name, latex, stories) => profileStmts.update.run(name, latex, stories, id),
    delete: (id) => profileStmts.delete.run(id),
  },
  jobs: {
    all:    () => jobStmts.all.all(),
    byId:   (id) => jobStmts.byId.get(id),
    byUrl:  (url) => jobStmts.byUrl.get(url),
    byTitleCompany: (company, title) => jobStmts.byTitleCompany.get(company, title),
    create: ({
      company,
      title,
      description,
      url = '',
      source = 'manual',
      location = '',
      capture_meta = '{}',
    }) => jobStmts.insert.run(company, title, description, url, source, location, capture_meta),
    updateImported: (id, {
      company,
      title,
      description,
      url = '',
      source = 'manual',
      location = '',
      capture_meta = '{}',
    }) => jobStmts.updateImported.run(company, title, description, url, source, location, capture_meta, id),
    delete: (id) => jobStmts.delete.run(id),
  },
  vaultItems: {
    all: () => vaultItemStmts.all.all(),
    byId: (id) => vaultItemStmts.byId.get(id),
    byProfile: (profileId) => vaultItemStmts.byProfile.all(profileId),
    create: ({
      profile_id,
      title = 'Saved Experience',
      tag = 'general',
      section_hint = '',
      status = 'grounded',
      text,
      preferred_bullet = '',
      source = 'manual',
      created_at = new Date().toISOString(),
      updated_at = created_at,
    }) => vaultItemStmts.insert.run(
      profile_id,
      title,
      tag,
      section_hint,
      status,
      text,
      preferred_bullet,
      source,
      created_at,
      updated_at
    ),
    update: (id, {
      profile_id,
      title = 'Saved Experience',
      tag = 'general',
      section_hint = '',
      status = 'grounded',
      text,
      preferred_bullet = '',
      source = 'manual',
    }) => vaultItemStmts.update.run(
      profile_id,
      title,
      tag,
      section_hint,
      status,
      text,
      preferred_bullet,
      source,
      id
    ),
    delete: (id) => vaultItemStmts.delete.run(id),
  },
  genres: {
    all: () => genreStmts.all.all(),
    byId: (id) => genreStmts.byId.get(id),
    create: (name, description = '', focusTags = '[]', preferredSignals = '[]', deEmphasizedSignals = '[]') =>
      genreStmts.insert.run(name, description, focusTags, preferredSignals, deEmphasizedSignals),
    update: (id, name, description = '', focusTags = '[]', preferredSignals = '[]', deEmphasizedSignals = '[]') =>
      genreStmts.update.run(name, description, focusTags, preferredSignals, deEmphasizedSignals, id),
    delete: (id) => genreStmts.delete.run(id),
  },
  sessions: {
    all:    () => sessionStmts.all.all(),
    byId:   (id) => sessionStmts.byId.get(id),
    create: (profileId, jobId, status = 'pending', genreName = '', strictness = 'balanced') =>
      sessionStmts.insert.run(profileId, jobId, status, genreName, strictness),
    update: (id, fields) => sessionStmts.update.run(
      fields.status, fields.parsed_req, fields.alignment,
      fields.edited_latex, fields.report, fields.token_usage, id
    ),
    updateStage: (id, status) => sessionStmts.updateStage.run(status, id),
    updateOutcome: (id, outcome) => sessionStmts.updateOutcome.run(outcome, id),
    updateReviewState: (id, {
      edited_latex,
      report,
      token_usage,
    }) => sessionStmts.updateReviewState.run(edited_latex, report, token_usage, id),
    delete: (id) => sessionStmts.delete.run(id),
  },
};
