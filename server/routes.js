const express = require('express');
const router = express.Router();
const db = require('./db');
const { runPipeline, runStage } = require('./pipeline');
const prompts = require('./prompts');

const {
  computeAtsScore,
  buildLocalAlignment,
  isMaterialChange,
  stripLatex,
} = require('./resume-intelligence');

const VALID_OUTCOMES = new Set(['', 'applied', 'interview', 'offer', 'rejected']);
const VALID_STRICTNESS = new Set(['safe', 'balanced', 'strategic']);

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uniqueStrings(items = []) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function truncText(value, limit = 220) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function compactAlignmentSummary(alignment) {
  const sections = Array.isArray(alignment?.sections) ? alignment.sections : [];
  return {
    overall_score: Number(alignment?.overall_score || 0),
    overall_verdict: String(alignment?.overall_verdict || ''),
    missing_from_cv: (alignment?.missing_from_cv || []).slice(0, 8),
    strongest_matches: (alignment?.strongest_matches || []).slice(0, 5),
    recommended_emphasis: (alignment?.recommended_emphasis || []).slice(0, 5),
    priority_gaps: (alignment?.priority_gaps || []).slice(0, 6),
    sections: sections.slice(0, 5).map((section) => ({
      name: section?.name || 'General',
      score: Number(section?.score || 0),
      matched_keywords: (section?.matched_keywords || []).slice(0, 5),
      gaps: (section?.gaps || []).slice(0, 5),
      suggestions: (section?.suggestions || []).slice(0, 3),
    })),
  };
}

function summarizeReviewChanges(changes = [], limit = 8) {
  return (changes || [])
    .filter(Boolean)
    .slice(0, limit)
    .map((change) => ({
      section_name: change?.section_name || 'General',
      importance: change?.importance || 'optional',
      target_keywords: (change?.target_keywords || []).slice(0, 4),
      reason: truncText(change?.reason || '', 180),
      original_excerpt: truncText(change?.original_text || '', 180),
      edited_excerpt: truncText(change?.edited_text || '', 180),
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
    'weighted_keyword_score',
    'bm25_requirement_score',
    'semantic_keyword_coverage',
    'quantified_impact',
    'section_completeness',
    'title_alignment_score',
    'role_family_score',
    'keyword_balance_score',
  ];
  const delta = {};
  numericKeys.forEach((key) => {
    delta[key] = {
      before: Number(before?.[key] || 0),
      after: Number(after?.[key] || 0),
      delta: Number(after?.[key] || 0) - Number(before?.[key] || 0),
    };
  });
  delta.matched_critical = {
    before: (before?.matched_critical || []).length,
    after: (after?.matched_critical || []).length,
    delta: (after?.matched_critical || []).length - (before?.matched_critical || []).length,
  };
  delta.missing_critical = {
    before: (before?.missing_critical || []).length,
    after: (after?.missing_critical || []).length,
    delta: (after?.missing_critical || []).length - (before?.missing_critical || []).length,
  };
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

function upsertImportedJob(rawJob) {
  const normalized = normalizeCapturedJobPayload(rawJob);
  if (!normalized.company || !normalized.title || !normalized.description) {
    throw new Error('Imported jobs need company, title, and enough detail to build a description');
  }

  const existing = normalized.url
    ? db.jobs.byUrl(normalized.url)
    : db.jobs.byTitleCompany(normalized.company, normalized.title);

  if (existing) {
    db.jobs.updateImported(existing.id, normalized);
    return { id: Number(existing.id), created: false, job: { ...existing, ...normalized, id: Number(existing.id) } };
  }

  const result = db.jobs.create(normalized);
  const id = Number(result.lastInsertRowid);
  return { id, created: true, job: { ...normalized, id } };
}

function toVaultStory(item) {
  return {
    title: item.title || 'Saved Experience',
    tag: item.tag || 'general',
    text: item.text || '',
    status: item.status || 'grounded',
    preferred_bullet: item.preferred_bullet || '',
  };
}

function getDefaultProvider() {
  const defaultKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
  return {
    apiKeyConfigured: Boolean(defaultKey),
    defaultProvider: defaultKey.startsWith('sk-or-') ? 'openrouter' : (defaultKey ? 'openai' : null),
  };
}

async function safePdflatexStatus() {
  return false;
}


// ── Middleware: extract API key from header ──────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return res.status(401).json({ error: 'Missing X-API-Key header and no default set' });
  req.apiKey = key;
  req.model = req.headers['x-model'] || '';
  next();
}

// Health Check
router.get('/health', async (req, res) => {
  res.json(buildBridgeStatus(req, getDefaultProvider()));
});

router.post('/ats/analyze', (req, res) => {


// ══════════════════════════════════════════════════════════════════════════
// GENRES
// ══════════════════════════════════════════════════════════════════════════
router.get('/genres', (req, res) => {
  res.json(db.genres.all());
});

router.get('/genres/:id', (req, res) => {
  const genre = db.genres.byId(Number(req.params.id));
  if (!genre) return res.status(404).json({ error: 'Genre not found' });
  res.json(genre);
});

router.post('/genres', (req, res) => {
  const {
    name,
    description,
    focus_tags,
    preferred_signals,
    de_emphasized_signals,
  } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = db.genres.create(
    name,
    description || '',
    typeof focus_tags === 'string' ? focus_tags : JSON.stringify(focus_tags || []),
    typeof preferred_signals === 'string' ? preferred_signals : JSON.stringify(preferred_signals || []),
    typeof de_emphasized_signals === 'string' ? de_emphasized_signals : JSON.stringify(de_emphasized_signals || [])
  );
  res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Genre created' });
});

router.put('/genres/:id', (req, res) => {
  const genre = db.genres.byId(Number(req.params.id));
  if (!genre) return res.status(404).json({ error: 'Genre not found' });

  const {
    name,
    description,
    focus_tags,
    preferred_signals,
    de_emphasized_signals,
  } = req.body || {};

  db.genres.update(
    Number(req.params.id),
    name || genre.name,
    description != null ? description : genre.description,
    typeof focus_tags === 'string' ? focus_tags : JSON.stringify(focus_tags || JSON.parse(genre.focus_tags || '[]')),
    typeof preferred_signals === 'string' ? preferred_signals : JSON.stringify(preferred_signals || JSON.parse(genre.preferred_signals || '[]')),
    typeof de_emphasized_signals === 'string' ? de_emphasized_signals : JSON.stringify(de_emphasized_signals || JSON.parse(genre.de_emphasized_signals || '[]'))
  );
  res.json({ message: 'Genre updated' });
});

router.delete('/genres/:id', (req, res) => {
  db.genres.delete(Number(req.params.id));
  res.json({ message: 'Genre deleted' });
});

// ══════════════════════════════════════════════════════════════════════════
// PROFILES
// ══════════════════════════════════════════════════════════════════════════
router.get('/profiles', (req, res) => {
  res.json(db.profiles.all());
});

router.get('/profiles/:id', (req, res) => {
  const p = db.profiles.byId(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json(p);
});

router.post('/profiles', (req, res) => {
  const { name, latex, stories } = req.body;
  if (!latex) return res.status(400).json({ error: 'latex is required' });
  const result = db.profiles.create(
    name || 'Default',
    latex,
    typeof stories === 'string' ? stories : JSON.stringify(stories || [])
  );
  res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Profile created' });
});

router.put('/profiles/:id', (req, res) => {
  const { name, latex, stories } = req.body;
  const existing = db.profiles.byId(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Profile not found' });
  db.profiles.update(
    Number(req.params.id),
    name || existing.name,
    latex || existing.latex,
    typeof stories === 'string' ? stories : JSON.stringify(stories || JSON.parse(existing.stories))
  );
  res.json({ message: 'Profile updated' });
});

router.delete('/profiles/:id', (req, res) => {
  db.profiles.delete(Number(req.params.id));
  res.json({ message: 'Profile deleted' });
});

// ══════════════════════════════════════════════════════════════════════════
// VAULT ITEMS
// ══════════════════════════════════════════════════════════════════════════
router.get('/vault-items', (req, res) => {
  res.json(db.vaultItems.all());
});

router.get('/vault-items/:id', (req, res) => {
  const item = db.vaultItems.byId(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Vault item not found' });
  res.json(item);
});

router.post('/vault-items', (req, res) => {
  const {
    profile_id,
    title,
    tag,
    section_hint,
    status,
    text,
    preferred_bullet,
    source,
  } = req.body || {};

  if (!profile_id || !text) {
    return res.status(400).json({ error: 'profile_id and text are required' });
  }
  const profile = db.profiles.byId(Number(profile_id));
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const result = db.vaultItems.create({
    profile_id: Number(profile_id),
    title: title || 'Saved Experience',
    tag: tag || 'general',
    section_hint: section_hint || '',
    status: status || 'grounded',
    text,
    preferred_bullet: preferred_bullet || '',
    source: source || 'manual',
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Vault item created' });
});

router.put('/vault-items/:id', (req, res) => {
  const existing = db.vaultItems.byId(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Vault item not found' });

  const payload = {
    profile_id: Number(req.body?.profile_id || existing.profile_id),
    title: req.body?.title || existing.title,
    tag: req.body?.tag || existing.tag,
    section_hint: req.body?.section_hint != null ? req.body.section_hint : existing.section_hint,
    status: req.body?.status || existing.status,
    text: req.body?.text || existing.text,
    preferred_bullet: req.body?.preferred_bullet != null ? req.body.preferred_bullet : existing.preferred_bullet,
    source: req.body?.source || existing.source,
  };

  const profile = db.profiles.byId(payload.profile_id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  db.vaultItems.update(Number(req.params.id), payload);
  res.json({ message: 'Vault item updated' });
});

router.delete('/vault-items/:id', (req, res) => {
  db.vaultItems.delete(Number(req.params.id));
  res.json({ message: 'Vault item deleted' });
});

// ══════════════════════════════════════════════════════════════════════════
// JOBS
// ══════════════════════════════════════════════════════════════════════════
router.get('/jobs', (req, res) => {
  res.json(db.jobs.all());
});

router.get('/jobs/:id', (req, res) => {
  const j = db.jobs.byId(Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json(j);
});

router.post('/jobs', (req, res) => {
  const { company, title, description, url, source, location, capture_meta } = req.body || {};
  if (!company || !title || !description) {
    return res.status(400).json({ error: 'company, title, and description are required' });
  }
  const result = db.jobs.create({
    company,
    title,
    description,
    url: url || '',
    source: source || 'manual',
    location: location || '',
    capture_meta: typeof capture_meta === 'string' ? capture_meta : JSON.stringify(capture_meta || {}),
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Job saved' });
});

router.post('/jobs/import', (req, res) => {
  try {
    const imported = upsertImportedJob(req.body || {});
    res.status(imported.created ? 201 : 200).json({
      id: imported.id,
      created: imported.created,
      message: imported.created ? 'Imported captured job' : 'Updated captured job',
      job: imported.job,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/jobs/import-batch', (req, res) => {
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : null;
  if (!jobs?.length) {
    return res.status(400).json({ error: 'jobs array is required' });
  }

  const results = [];
  const errors = [];

  jobs.forEach((job, index) => {
    try {
      const imported = upsertImportedJob(job);
      results.push(imported);
    } catch (error) {
      errors.push({ index, error: error.message });
    }
  });

  res.status(errors.length ? 207 : 200).json({
    imported: results.length,
    created: results.filter((item) => item.created).length,
    updated: results.filter((item) => !item.created).length,
    results: results.map((item) => ({
      id: item.id,
      created: item.created,
      job: item.job,
    })),
    errors,
  });
});

router.delete('/jobs/:id', (req, res) => {
  db.jobs.delete(Number(req.params.id));
  res.json({ message: 'Job deleted' });
});

// ══════════════════════════════════════════════════════════════════════════
// TAILORING SESSIONS
// ══════════════════════════════════════════════════════════════════════════
router.get('/sessions', (req, res) => {
  res.json(db.sessions.all());
});

router.get('/sessions/:id', (req, res) => {
  const s = db.sessions.byId(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  // Parse JSON fields for convenience
  try {
    s.parsed_req = s.parsed_req ? JSON.parse(s.parsed_req) : null;
    s.alignment = s.alignment ? JSON.parse(s.alignment) : null;
    s.report = s.report ? JSON.parse(s.report) : null;
    s.token_usage = s.token_usage ? JSON.parse(s.token_usage) : {};
  } catch { }
  res.json(s);
});

router.put('/sessions/:id/outcome', (req, res) => {
  const { outcome } = req.body || {};
  const normalized = String(outcome || '').trim().toLowerCase();
  if (!VALID_OUTCOMES.has(normalized)) {
    return res.status(400).json({ error: 'Invalid outcome value' });
  }

  const existing = db.sessions.byId(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Session not found' });

  db.sessions.updateOutcome(Number(req.params.id), normalized);
  res.json({ message: 'Outcome updated', outcome: normalized });
});

router.delete('/sessions/:id', (req, res) => {
  db.sessions.delete(Number(req.params.id));
  res.json({ message: 'Session deleted' });
});

// ── Run full pipeline ───────────────────────────────────────────────────
router.post('/tailor', requireApiKey, async (req, res) => {
  const { profile_id, job_id, genre_name, strictness, stories_override, rewrite_coverage } = req.body;
  if (!profile_id || !job_id) {
    return res.status(400).json({ error: 'profile_id and job_id are required' });
  }
  const normalizedStrictness = VALID_STRICTNESS.has(String(strictness || '').toLowerCase())
    ? String(strictness).toLowerCase()
    : 'balanced';
  const normalizedRewriteCoverage = Math.max(0.6, Math.min(0.8, Number(rewrite_coverage || 0.7) || 0.7));

  const profile = db.profiles.byId(Number(profile_id));
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const job = db.jobs.byId(Number(job_id));
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Create session
  const sessionResult = db.sessions.create(
    Number(profile_id),
    Number(job_id),
    'running',
    String(genre_name || '').trim(),
    normalizedStrictness
  );
  const sessionId = Number(sessionResult.lastInsertRowid);

  try {
    const stories = Array.isArray(stories_override)
      ? stories_override
      : db.vaultItems.byProfile(Number(profile_id)).map(toVaultStory);

    const result = await runPipeline(
      req.apiKey,
      profile.latex,
      job.description,
      stories,
      (stage, status) => {
        // Update session status as pipeline progresses
        db.sessions.updateStage(sessionId, `running:${stage}`);
      },
      { model: req.model, rewriteCoverage: normalizedRewriteCoverage }
    );

    // Save all results
    db.sessions.update(sessionId, {
      status: 'complete',
      parsed_req: JSON.stringify(result.parsedReq),
      alignment: JSON.stringify(result.alignment),
      edited_latex: result.editedLatex,
      report: JSON.stringify(result.replacements),
      token_usage: JSON.stringify(result.tokenUsage),
    });

    res.json({
      id: sessionId,
      session_id: sessionId,
      status: 'complete',
      outcome: '',
      genre_name: String(genre_name || '').trim(),
      strictness: normalizedStrictness,
      rewrite_coverage: normalizedRewriteCoverage,
      ...result,
    });
  } catch (err) {
    console.error('Tailoring Error:', err);
    db.sessions.updateStage(sessionId, `error: ${err.message}`);
    res.status(500).json({ error: err.message, session_id: sessionId });
  }
});

// Compilation disabled in web version
router.post('/compile', async (req, res) => {
  res.status(501).json({ error: 'LaTeX compilation is disabled in this version. Please use the "Download .tex" option.' });
});


// ── Apply selective changes (accept/reject per bullet) ──────────────────
router.post('/apply-changes', requireApiKey, async (req, res) => {
  const { original_latex, changes, accepted_indices } = req.body;
  if (!original_latex || !changes) {
    return res.status(400).json({ error: 'original_latex and changes are required' });
  }

  // Build a prompt that asks the AI to apply ONLY the accepted changes
  const accepted = (accepted_indices || []).map(i => changes[i]).filter(Boolean);
  if (accepted.length === 0) {
    return res.json({ edited_latex: original_latex });
  }

  try {
    let edited = original_latex;
    // Perform non-invasive precise native string replacement
    accepted.forEach(c => {
      // original_text and edited_text as generated in the new pipeline
      if (c.original_text && c.edited_text) {
        edited = edited.replace(c.original_text, c.edited_text);
      }
    });

    res.json({ edited_latex: edited, usage: { total_tokens: 0 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Review the accepted draft against the original CV ──────────────────────
router.post('/sessions/:id/review-applied', requireApiKey, async (req, res) => {
  const sessionId = Number(req.params.id);
  const session = db.sessions.byId(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const profile = db.profiles.byId(Number(session.profile_id));
  const job = db.jobs.byId(Number(session.job_id));
  if (!profile || !job) {
    return res.status(404).json({ error: 'Profile or job not found' });
  }

  const parsedReq = safeJsonParse(session.parsed_req, {}) || {};
  const originalAlignment = safeJsonParse(session.alignment, {}) || {};
  const storedReport = safeJsonParse(session.report, {}) || {};
  const reportOverride = safeJsonParse(req.body?.report, null);
  const report = reportOverride && typeof reportOverride === 'object'
    ? {
      ...storedReport,
      ...reportOverride,
      changes: Array.isArray(reportOverride?.changes) ? reportOverride.changes : (storedReport.changes || []),
    }
    : { ...storedReport };
  const originalLatex = String(req.body?.original_latex || profile.latex || '');
  const editedLatex = String(req.body?.edited_latex || session.edited_latex || '');

  if (!originalLatex || !editedLatex) {
    return res.status(400).json({ error: 'original_latex and edited_latex are required' });
  }

  try {
    delete report.applied_review;
    const allChanges = Array.isArray(report.changes) ? report.changes : [];
    const acceptedIndices = sortNumericList(
      Array.isArray(req.body?.accepted_indices)
        ? req.body.accepted_indices
        : (report?.applied_review?.accepted_indices || [])
    );
    const requestedRejectedIndices = sortNumericList(
      Array.isArray(req.body?.rejected_indices)
        ? req.body.rejected_indices
        : (report?.applied_review?.rejected_indices || [])
    );
    const acceptedSet = new Set(acceptedIndices);
    const rejectedIndices = requestedRejectedIndices.filter((index) => !acceptedSet.has(index));
    const rejectedSet = new Set(rejectedIndices);
    const acceptedChanges = allChanges.filter((change, index) => acceptedSet.has(index) && isMaterialChange(change));
    const keptOriginalChanges = allChanges.filter((change, index) => rejectedSet.has(index) && isMaterialChange(change));
    const pendingChanges = allChanges.filter((change, index) => !acceptedSet.has(index) && !rejectedSet.has(index) && isMaterialChange(change));
    const stories = db.vaultItems.byProfile(Number(profile.id)).map(toVaultStory);

    const beforeMetrics = report?.metrics?.before || computeAtsScore(originalLatex, parsedReq);
    const suggestedMetrics = report?.metrics?.after || null;
    const afterMetrics = computeAtsScore(editedLatex, parsedReq);
    const afterAlignment = buildLocalAlignment(parsedReq, editedLatex, stories);

    const keywordAnalysis = {
      newly_covered_critical: uniqueStrings((afterMetrics.matched_critical || []).filter((item) => !(beforeMetrics.matched_critical || []).includes(item))),
      newly_covered_preferred: uniqueStrings((afterMetrics.matched_preferred || []).filter((item) => !(beforeMetrics.matched_preferred || []).includes(item))),
      still_missing_critical: afterMetrics.missing_critical || [],
    };

    const userChoices = {
      accepted_count: acceptedChanges.length,
      kept_original_count: keptOriginalChanges.length,
      pending_count: pendingChanges.length,
      grounded_accepted_count: acceptedChanges.filter((change) => !(change?.validation?.hallucinated || change?.validation?.exact_match === false || change?.validation?.issues?.length)).length,
      risky_accepted_count: acceptedChanges.filter((change) => change?.validation?.hallucinated || change?.validation?.exact_match === false || change?.validation?.issues?.length).length,
      accepted_changes: summarizeReviewChanges(acceptedChanges, 8),
      kept_original_changes: summarizeReviewChanges(keptOriginalChanges, 6),
      pending_changes: summarizeReviewChanges(pendingChanges, 6),
    };

    const runContext = {
      session_id: sessionId,
      genre_name: String(session.genre_name || '').trim(),
      strictness: String(session.strictness || 'balanced').trim(),
      company: String(job.company || '').trim(),
      title: String(job.title || '').trim(),
      source: String(job.source || 'manual').trim(),
    };

    const { callOpenAI } = require('./openai-client');
    const { data: modelReview, usage } = await callOpenAI(
      req.apiKey,
      prompts.REVIEW_APPLIED_CV_SYSTEM,
      prompts.REVIEW_APPLIED_CV_USER({
        parsedReq,
        job: {
          company: job.company || '',
          title: job.title || '',
          location: job.location || '',
          source: job.source || 'manual',
        },
        originalCv: stripLatex(originalLatex),
        acceptedCv: stripLatex(editedLatex),
        originalMetrics: beforeMetrics,
        suggestedMetrics,
        acceptedMetrics: {
          ...afterMetrics,
          delta: buildMetricDelta(beforeMetrics, afterMetrics),
          keyword_analysis: keywordAnalysis,
        },
        originalAlignment: compactAlignmentSummary(originalAlignment),
        acceptedAlignment: compactAlignmentSummary(afterAlignment),
        userChoices,
        runContext,
      }),
      {
        model: req.model,
        maxTokens: 1800,
        disableReasoning: false,
      }
    );

    const tokenUsage = mergeTokenUsage(safeJsonParse(session.token_usage, {}) || {}, 'review_applied', usage || {});
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
        suggested_after: suggestedMetrics,
        delta: buildMetricDelta(beforeMetrics, afterMetrics),
        keyword_analysis: keywordAnalysis,
      },
      after_alignment: afterAlignment,
      model_review: modelReview,
    };

    const nextReport = {
      ...report,
      applied_review: appliedReview,
    };

    db.sessions.updateReviewState(sessionId, {
      edited_latex: editedLatex,
      report: JSON.stringify(nextReport),
      token_usage: JSON.stringify(tokenUsage),
    });

    res.json({
      session_id: sessionId,
      edited_latex: editedLatex,
      applied_review: appliedReview,
      report: nextReport,
      token_usage: tokenUsage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not review applied draft' });
  }
});

// ── Re-tailor: use an existing session's profile+job with fresh run ─────
router.post('/retailor', requireApiKey, async (req, res) => {
  const { session_id, genre_name, strictness, stories_override, rewrite_coverage } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const oldSession = db.sessions.byId(Number(session_id));
  if (!oldSession) return res.status(404).json({ error: 'Session not found' });

  const profile = db.profiles.byId(oldSession.profile_id);
  const job = db.jobs.byId(oldSession.job_id);
  if (!profile || !job) return res.status(404).json({ error: 'Profile or job no longer exists' });

  const normalizedStrictness = VALID_STRICTNESS.has(String(strictness || oldSession.strictness || '').toLowerCase())
    ? String(strictness || oldSession.strictness).toLowerCase()
    : 'balanced';
  let priorCoverage = 0.7;
  try {
    priorCoverage = Number(JSON.parse(oldSession.report || '{}')?.rewrite_preferences?.rewrite_coverage || 0.7) || 0.7;
  } catch {}
  const normalizedRewriteCoverage = Math.max(0.6, Math.min(0.8, Number(rewrite_coverage || priorCoverage || 0.7) || 0.7));
  const sessionResult = db.sessions.create(
    profile.id,
    job.id,
    'running',
    String(genre_name || oldSession.genre_name || '').trim(),
    normalizedStrictness
  );
  const sessionId = Number(sessionResult.lastInsertRowid);

  try {
    const stories = Array.isArray(stories_override)
      ? stories_override
      : db.vaultItems.byProfile(Number(profile.id)).map(toVaultStory);
    const result = await runPipeline(
      req.apiKey,
      profile.latex,
      job.description,
      stories,
      (stage) => db.sessions.updateStage(sessionId, `running:${stage}`),
      { model: req.model, rewriteCoverage: normalizedRewriteCoverage }
    );

    db.sessions.update(sessionId, {
      status: 'complete',
      parsed_req: JSON.stringify(result.parsedReq),
      alignment: JSON.stringify(result.alignment),
      edited_latex: result.editedLatex,
      report: JSON.stringify(result.replacements),
      token_usage: JSON.stringify(result.tokenUsage),
    });

    res.json({
      id: sessionId,
      session_id: sessionId,
      status: 'complete',
      outcome: '',
      genre_name: String(genre_name || oldSession.genre_name || '').trim(),
      strictness: normalizedStrictness,
      rewrite_coverage: normalizedRewriteCoverage,
      ...result
    });
  } catch (err) {
    db.sessions.updateStage(sessionId, `error: ${err.message}`);
    res.status(500).json({ error: err.message, session_id: sessionId });
  }
});

// ── Session search (by company/title) ───────────────────────────────────
router.get('/sessions/search/:query', (req, res) => {
  const q = `%${req.params.query}%`;
  const stmt = db.db.prepare(`
    SELECT s.*, j.company, j.title as job_title, p.name as profile_name
    FROM sessions s
    JOIN jobs j ON s.job_id = j.id
    JOIN profiles p ON s.profile_id = p.id
    WHERE j.company LIKE ? OR j.title LIKE ? OR p.name LIKE ?
    ORDER BY s.created_at DESC
    LIMIT 50
  `);
  res.json(stmt.all(q, q, q));
});

// ── Cover Letter Generator ──────────────────────────────────────────────
router.post('/cover-letter', requireApiKey, async (req, res) => {
  const { session_id, user_story, template_settings } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const session = db.sessions.byId(Number(session_id));
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const profile = db.profiles.byId(session.profile_id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const job = db.jobs.byId(session.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  try {
    const { COVER_LETTER_SYSTEM, COVER_LETTER_USER } = require('./prompts');
    const { callOpenAI } = require('./openai-client');
    const { getCoverLetterTemplateForPrompt, renderCoverLetterTemplate } = require('./cover-letter-template');
    const parsedReq = JSON.parse(session.parsed_req || '{}');
    const alignment = JSON.parse(session.alignment || '{}');
    const coverLetterTemplate = getCoverLetterTemplateForPrompt();

    const { data: coverLetterPayload, usage } = await callOpenAI(
      req.apiKey, COVER_LETTER_SYSTEM,
      COVER_LETTER_USER(parsedReq, profile.latex, alignment, job, user_story, coverLetterTemplate),
      { maxTokens: 1024, temperature: 0.4, model: req.model }
    );
    const rendered = renderCoverLetterTemplate({
      job,
      settings: template_settings || {},
      payload: coverLetterPayload,
    });
    res.json({
      cover_letter: rendered.text,
      cover_letter_latex: rendered.latex,
      cover_letter_payload: rendered.payload,
      cover_letter_assets: rendered.assets,
      template_settings: rendered.settings,
      usage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Interview Prep ──────────────────────────────────────────────────────
router.post('/interview-prep', requireApiKey, async (req, res) => {
  const { session_id, cached_research = '', latex_override = '' } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const session = db.sessions.byId(Number(session_id));
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const profile = db.profiles.byId(session.profile_id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const job = db.jobs.byId(session.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  try {
    const {
      INTERVIEW_PREP_SYSTEM,
      INTERVIEW_PREP_USER,
      COMPANY_RESEARCH_SYSTEM,
      COMPANY_RESEARCH_USER,
    } = require('./prompts');
    const { callOpenAI, callOpenAIText, isOpenRouterKey } = require('./openai-client');
    const parsedReq = JSON.parse(session.parsed_req || '{}');
    const alignment = JSON.parse(session.alignment || '{}');
    const interviewLatex = String(latex_override || session.edited_latex || profile.latex || '').trim();
    let research = String(cached_research || '').trim();
    let researchUsage = null;

    const companyName = String(parsedReq.company || job.company || '').trim();
    const roleTitle = String(parsedReq.title || job.title || '').trim();

    if (!research && companyName && isOpenRouterKey(req.apiKey)) {
      try {
        const { data: researchReport, usage } = await callOpenAIText(
          req.apiKey,
          COMPANY_RESEARCH_SYSTEM,
          COMPANY_RESEARCH_USER(companyName, roleTitle),
          { model: 'perplexity/sonar-pro-search', maxTokens: 700, temperature: 0.1 }
        );
        research = String(researchReport || '').trim();
        researchUsage = usage || null;
      } catch (researchErr) {
        console.warn('Company research stage failed:', researchErr.message);
      }
    }

    const { data: prep, usage } = await callOpenAI(
      req.apiKey, INTERVIEW_PREP_SYSTEM,
      INTERVIEW_PREP_USER(parsedReq, interviewLatex, alignment, research),
      { maxTokens: 3000, model: req.model }
    );
    res.json({
      prep,
      research,
      usage: {
        ...(usage || {}),
        research_used: Boolean(research),
        research_usage: researchUsage,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── System Prompts — read + live-edit in the UI ─────────────────────────
// NOTE: Overrides are in-memory only. Server restart resets to defaults.
// This is intentional — the source of truth stays in prompts.js, and the UI
// is an editing surface, not persistent storage.
const PROMPT_OVERRIDES = {};
const EDITABLE_PROMPT_KEYS = [
  'PARSE_JOB_SYSTEM',
  'ANALYZE_ALIGNMENT_SYSTEM',
  'REPLACE_SYSTEM',
  'REVIEW_APPLIED_CV_SYSTEM',
  'COVER_LETTER_SYSTEM',
  'INTERVIEW_PREP_SYSTEM',
  'COMPANY_RESEARCH_SYSTEM',
  'JOB_SUMMARY_SYSTEM',
];

function getEffectivePrompt(key) {
  if (PROMPT_OVERRIDES[key] != null) return PROMPT_OVERRIDES[key];
  return typeof prompts[key] === 'string' ? prompts[key] : null;
}

router.get('/prompts', (req, res) => {
  const result = {};
  EDITABLE_PROMPT_KEYS.forEach((key) => {
    result[key] = {
      key,
      current: getEffectivePrompt(key),
      overridden: PROMPT_OVERRIDES[key] != null,
      default: typeof prompts[key] === 'string' ? prompts[key] : null,
    };
  });
  res.json(result);
});

router.put('/prompts/:key', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!EDITABLE_PROMPT_KEYS.includes(key)) {
    return res.status(400).json({ error: `Unknown prompt key: ${key}` });
  }
  const { value, reset } = req.body || {};
  if (reset) {
    delete PROMPT_OVERRIDES[key];
    return res.json({ key, overridden: false, current: prompts[key] });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string' });
  }
  PROMPT_OVERRIDES[key] = value;
  // Patch the live prompts module so all pipeline calls use the new value
  prompts[key] = value;
  return res.json({ key, overridden: true, current: value });
});

// ── Pipeline Parameter Overrides ─────────────────────────────────────────
// Stage-level LLM parameter tuning stored in memory.
const PARAM_DEFAULTS = {
  parse_max_tokens: 2200,
  analyze_max_tokens: 4096,
  replace_max_tokens_balanced: 5800,
  replace_max_tokens_safe: 4600,
  replace_max_tokens_strategic: 7000,
  replace_max_attempts: 3,
  replace_temperature_balanced: 0.2,
  replace_temperature_safe: 0.16,
  replace_temperature_strategic: 0.24,
  review_max_tokens: 1800,
  cover_letter_max_tokens: 1024,
  interview_max_tokens: 3000,
};
const paramStore = { ...PARAM_DEFAULTS };

router.get('/settings/params', (req, res) => {
  res.json({
    params: paramStore,
    defaults: PARAM_DEFAULTS,
  });
});

router.put('/settings/params', (req, res) => {
  const updates = req.body || {};
  Object.keys(updates).forEach((key) => {
    if (key in PARAM_DEFAULTS) {
      const val = Number(updates[key]);
      if (Number.isFinite(val) && val > 0) {
        paramStore[key] = val;
      }
    }
  });
  res.json({ params: paramStore });
});

router.post('/settings/params/reset', (req, res) => {
  Object.assign(paramStore, PARAM_DEFAULTS);
  res.json({ params: paramStore });
});

module.exports = router;
