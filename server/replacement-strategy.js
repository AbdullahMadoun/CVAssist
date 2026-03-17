const { callOpenAI } = require('./openai-client');
const prompts = require('./prompts');
const { buildReplacementSource, buildReplacementInventory, enrichTailoringReport, isMaterialChange } = require('./resume-intelligence');

function isFastFreeModel(apiKey, model) {
  const normalized = String(model || '').toLowerCase();
  return Boolean(
    apiKey &&
    apiKey.startsWith('sk-or-') &&
    (normalized === 'openrouter/free' || normalized.endsWith(':free'))
  );
}

function sumUsage(items = []) {
  return items.reduce((acc, item) => ({
    prompt_tokens: (acc.prompt_tokens || 0) + (item?.prompt_tokens || 0),
    completion_tokens: (acc.completion_tokens || 0) + (item?.completion_tokens || 0),
    total_tokens: (acc.total_tokens || 0) + (item?.total_tokens || 0),
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}

function getAttemptPlan(strictness = 'balanced', fastMode = false, attemptIndex = 0) {
  const normalized = String(strictness || 'balanced').toLowerCase();
  const base = normalized === 'safe'
    ? { lineLimit: 12, storyLimit: 2, maxTokens: 4600, temperature: 0.16 }
    : normalized === 'strategic'
      ? { lineLimit: 18, storyLimit: 4, maxTokens: 7000, temperature: 0.24 }
      : { lineLimit: 16, storyLimit: 3, maxTokens: 5800, temperature: 0.2 };

  if (fastMode) {
    return {
      lineLimit: Math.min(base.lineLimit, 12),
      storyLimit: Math.min(base.storyLimit, 3),
      maxTokens: 3600,
      temperature: Math.min(base.temperature, 0.14),
      disableReasoning: true,
    };
  }

  if (attemptIndex === 0) {
    return {
      ...base,
      disableReasoning: false,
    };
  }

  return {
    lineLimit: base.lineLimit + 4,
    storyLimit: base.storyLimit + 1,
    maxTokens: base.maxTokens + 400,
    temperature: Math.max(0.1, base.temperature - 0.06),
    disableReasoning: false,
  };
}

function trimText(value, limit = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function compactStories(stories = [], limit = 3) {
  return (stories || [])
    .slice(0, limit)
    .map((story) => ({
      title: trimText(story?.title || '', 80),
      tag: trimText(story?.tag || 'general', 32),
      text: trimText(story?.text || '', 260),
      status: story?.status || 'grounded',
      preferred_bullet: trimText(story?.preferred_bullet || '', 220),
    }));
}

function clampCoverage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.7;
  return Math.max(0.6, Math.min(0.8, numeric));
}

function scoreBulletPriority(item = {}, bulletReviewMap = new Map()) {
  const review = bulletReviewMap.get(Number(item?.line_number || 0)) || {};
  const verdict = String(review?.verdict || '').toLowerCase();
  let score = 0;
  if (verdict === 'weak') score += 6;
  else if (verdict === 'adequate') score += 3;
  else if (verdict === 'strong') score -= 2;
  if ((item?.target_keywords || []).length) score += Math.min(4, (item.target_keywords || []).length * 2);
  if (/(critical)/i.test(String(item?.rewrite_goal || ''))) score += 2;
  if (/(quantified|measure|impact)/i.test(String(item?.rewrite_goal || ''))) score += 1;
  return score;
}

function buildRewriteCoveragePlan(inventoryHints = [], bulletReview = [], requestedCoverage = 0.7) {
  const rewriteCoverage = clampCoverage(requestedCoverage);
  const bulletReviewMap = new Map();
  (bulletReview || []).forEach((entry) => {
    const lineNumber = Number(entry?.line_number || 0);
    if (lineNumber > 0) bulletReviewMap.set(lineNumber, entry);
  });
  const itemHints = (inventoryHints || []).filter((item) => String(item?.kind || '') === 'item');
  const totalItemCount = itemHints.length;
  const targetItemEditCount = totalItemCount
    ? Math.max(1, Math.min(totalItemCount, Math.round(totalItemCount * rewriteCoverage)))
    : 0;
  const preferredEditLineNumbers = itemHints
    .map((item) => ({
      line_number: Number(item?.line_number || 0),
      score: scoreBulletPriority(item, bulletReviewMap),
    }))
    .filter((item) => item.line_number > 0)
    .sort((a, b) => b.score - a.score || a.line_number - b.line_number)
    .slice(0, targetItemEditCount)
    .map((item) => item.line_number);

  return {
    rewriteCoverage,
    totalItemCount,
    targetItemEditCount,
    preferredEditLineNumbers,
  };
}

function compactAlignmentForReplacement(alignment = {}) {
  const sections = Array.isArray(alignment?.sections) ? alignment.sections : [];
  const rankedSections = sections
    .map((section) => ({
      name: section?.name || 'General',
      score: Number(section?.score || 0),
      matched_keywords: (section?.matched_keywords || []).slice(0, 4),
      gaps: (section?.gaps || []).slice(0, 4),
      suggestions: (section?.suggestions || []).slice(0, 2).map((item) => trimText(item, 120)),
    }))
    .sort((a, b) => {
      const aGapScore = (a.gaps || []).length * 10 - a.score;
      const bGapScore = (b.gaps || []).length * 10 - b.score;
      return bGapScore - aGapScore;
    })
    .slice(0, 4);

  return {
    overall_score: Number(alignment?.overall_score || 0),
    overall_verdict: trimText(alignment?.overall_verdict || '', 140),
    missing_from_cv: (alignment?.missing_from_cv || []).slice(0, 6),
    strongest_matches: (alignment?.strongest_matches || []).slice(0, 4),
    recommended_emphasis: (alignment?.recommended_emphasis || []).slice(0, 4),
    ats_breakdown: alignment?.ats_breakdown ? {
      matched_critical_count: Number(alignment.ats_breakdown.matched_critical_count || 0),
      total_critical_count: Number(alignment.ats_breakdown.total_critical_count || 0),
      matched_preferred_count: Number(alignment.ats_breakdown.matched_preferred_count || 0),
      total_preferred_count: Number(alignment.ats_breakdown.total_preferred_count || 0),
      strongest_sections: (alignment.ats_breakdown.strongest_sections || []).slice(0, 3),
      missing_keywords: (alignment.ats_breakdown.missing_keywords || []).slice(0, 8),
    } : undefined,
    priority_gaps: (alignment?.priority_gaps || []).slice(0, 5).map((gap) => ({
      keyword: trimText(gap?.keyword || '', 60),
      importance: gap?.importance || 'recommended',
      target_section: trimText(gap?.target_section || '', 40),
      supporting_vault_items: Number(gap?.supporting_vault_items || 0),
      rationale: trimText(gap?.rationale || '', 120),
    })),
    evidence_candidates: (alignment?.evidence_candidates || []).slice(0, 6).map((candidate) => ({
      section_name: trimText(candidate?.section_name || '', 40),
      exact_latex: trimText(candidate?.exact_latex || '', 220),
      current_keywords: (candidate?.current_keywords || []).slice(0, 4),
      target_keywords: (candidate?.target_keywords || []).slice(0, 3),
      rationale: trimText(candidate?.rationale || '', 120),
      quantified: Boolean(candidate?.quantified),
    })),
    sections: rankedSections,
  };
}

function scoreKeywordRelevance(text = '', keyword = '') {
  const normalizedText = trimText(text, 400).toLowerCase();
  const normalizedKeyword = trimText(keyword, 120).toLowerCase();
  if (!normalizedText || !normalizedKeyword) return 0;
  if (normalizedText.includes(normalizedKeyword)) return 3;
  const keywordTokens = normalizedKeyword.split(/[^a-z0-9+#/.-]+/).filter(Boolean);
  const textTokens = new Set(normalizedText.split(/[^a-z0-9+#/.-]+/).filter(Boolean));
  return keywordTokens.reduce((score, token) => score + (textTokens.has(token) ? 1 : 0), 0);
}

function buildReplacementInventoryHints(inventory = [], alignment = {}) {
  const evidenceCandidates = Array.isArray(alignment?.evidence_candidates) ? alignment.evidence_candidates : [];
  const priorityGaps = Array.isArray(alignment?.priority_gaps) ? alignment.priority_gaps : [];

  return (inventory || []).map((item) => {
    const exactEvidence = evidenceCandidates.find((candidate) => String(candidate?.exact_latex || '') === String(item?.latex || ''));
    const sectionPriorityGaps = priorityGaps.filter((gap) => {
      return String(gap?.target_section || '').toLowerCase() === String(item?.section_name || '').toLowerCase();
    });
    const rankedFallbackKeywords = sectionPriorityGaps
      .map((gap) => ({
        keyword: gap.keyword,
        score: scoreKeywordRelevance(item?.plain || item?.latex || '', gap.keyword) + (gap.importance === 'critical' ? 2 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.keyword);
    const targetKeywords = Array.from(new Set([
      ...((exactEvidence?.target_keywords || []).filter(Boolean)),
      ...rankedFallbackKeywords,
    ])).slice(0, 3);
    const rewriteGoal = exactEvidence?.rationale ||
      (targetKeywords.length
        ? `Reframe this line to better surface ${targetKeywords.join(', ')} using only supported evidence.`
        : 'Tighten this line for clearer action, scope, and outcome without changing facts.');

    return {
      section_name: item?.section_name || 'General',
      kind: item?.kind || 'text',
      line_number: item?.line_number || null,
      exact_latex: item?.latex || '',
      current_keywords: exactEvidence?.current_keywords || [],
      target_keywords: targetKeywords,
      rewrite_goal: rewriteGoal,
    };
  });
}

function buildStrategicRewriteBrief(alignment = {}) {
  const sections = Array.isArray(alignment?.sections) ? alignment.sections : [];
  const priorityGaps = Array.isArray(alignment?.priority_gaps) ? alignment.priority_gaps : [];
  const strongestSections = [...sections]
    .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
    .slice(0, 3)
    .map((section) => section?.name)
    .filter(Boolean);
  const compressSections = sections
    .filter((section) => Number(section?.score || 0) < 45 && (section?.matched_keywords || []).length === 0)
    .slice(0, 3)
    .map((section) => section?.name)
    .filter(Boolean);

  return {
    top_priorities: priorityGaps.slice(0, 5).map((gap) => ({
      keyword: trimText(gap?.keyword || '', 60),
      importance: gap?.importance || 'recommended',
      target_section: trimText(gap?.target_section || '', 40),
    })),
    strongest_sections: strongestSections,
    compress_if_space_tight: compressSections,
    rewrite_ladder: [
      'Lead with a strong action and the specific deliverable or problem solved.',
      'Add scope through system, stakeholder, domain, scale, cadence, or ownership details already supported by the CV or vault.',
      'Surface the exact supported tool, skill, or business domain terms that matter for the job.',
      'End with impact, outcome, or enablement value; if no metric exists, sharpen consequence and usefulness instead of inventing numbers.',
      'Prefer accomplishment framing over duty wording and prefer specific evidence over generic adjectives.',
    ],
  };
}

function replacementQualityScore(enriched) {
  const report = enriched?.report || {};
  const metrics = report.metrics || {};
  const totalChanges = (report.changes || []).filter((change) => isMaterialChange(change)).length;
  const totalTargets = Number(report.rewrite_preferences?.target_item_edit_count || report.coverage?.item_targets || report.coverage?.total_targets || 0);
  const microEdits = (report.changes || []).filter((change) => isMaterialChange(change) && isMicroEdit(change)).length;
  const exactFailures = metrics.verification_summary?.exact_match_failures || 0;
  const hallucinations = metrics.verification_summary?.hallucination_flags || 0;
  const atsBefore = metrics.before?.ats_score || 0;
  const atsAfter = metrics.after?.ats_score || 0;
  const preservation = metrics.content_preservation_score || 0;
  const groundedChanges = (report.changes || []).filter((change) => {
    return isMaterialChange(change) && !change.validation?.hallucinated && change.validation?.exact_match !== false;
  }).length;

  return (
    ((atsAfter - atsBefore) * 10) +
    preservation +
    (totalTargets ? (Math.min(totalChanges, totalTargets) / Math.max(totalTargets, 1)) * 160 : 0) +
    (groundedChanges * 25) -
    (microEdits * 14) -
    (exactFailures * 35) -
    (hallucinations * 45) -
    (totalChanges === 0 ? 50 : 0)
  );
}

function shouldRetryReplacement(enriched) {
  const report = enriched?.report || {};
  const metrics = report.metrics || {};
  const totalChanges = (report.changes || []).filter((change) => isMaterialChange(change)).length;
  const targetItemEdits = Number(report.rewrite_preferences?.target_item_edit_count || 0);
  const preferredLineNumbers = new Set(report.rewrite_preferences?.preferred_edit_item_lines || []);
  const coveredPreferredEdits = (report.changes || []).filter((change) => {
    return preferredLineNumbers.has(Number(change?.line_number || 0)) && isMaterialChange(change);
  }).length;
  const microEdits = (report.changes || []).filter((change) => isMaterialChange(change) && isMicroEdit(change)).length;
  const exactFailures = metrics.verification_summary?.exact_match_failures || 0;
  const hallucinations = metrics.verification_summary?.hallucination_flags || 0;
  const atsBefore = metrics.before?.ats_score || 0;
  const atsAfter = metrics.after?.ats_score || 0;

  if (!totalChanges) return true;
  if (targetItemEdits > 0 && coveredPreferredEdits < Math.max(1, Math.floor(targetItemEdits * 0.75))) return true;
  if (hallucinations > Math.max(1, Math.ceil(totalChanges * 0.15))) return true;
  if (exactFailures >= Math.max(2, Math.ceil(totalChanges / 2))) return true;
  // With always-suggest-edits philosophy, micro-edit dominance warrants retry
  if (microEdits >= Math.max(2, Math.ceil(totalChanges * 0.6))) return true;
  // Only retry for ATS regression if it dropped more than 3 points
  if (atsAfter < atsBefore - 3) return true;
  return false;
}

function normalizeTokens(text = '') {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#/.-]+/)
    .filter(Boolean);
}

function isMicroEdit(change = {}) {
  const originalTokens = normalizeTokens(change?.original_text);
  const editedTokens = normalizeTokens(change?.edited_text);
  const originalSet = new Set(originalTokens);
  const editedSet = new Set(editedTokens);
  const introducedTokens = [...editedSet].filter((token) => !originalSet.has(token));
  const removedTokens = [...originalSet].filter((token) => !editedSet.has(token));
  const explicitKeywords = Array.isArray(change?.target_keywords) ? change.target_keywords.length : 0;
  // Only flag as micro-edit if truly cosmetic (1 or fewer token diff)
  return introducedTokens.length + removedTokens.length <= 1 && explicitKeywords <= 0;
}

function isItemChange(change = {}) {
  return String(change?.kind || '') === 'item' || /^\\item\b/.test(String(change?.original_text || '').trim());
}

function describeWeakChange(change = {}) {
  if (change?.validation?.hallucinated) {
    return `introduced unsupported content (${(change.validation.issues || []).join(' ')})`;
  }
  if (change?.validation?.exact_match === false) {
    return 'did not preserve an exact original_text match';
  }
  if (!isMaterialChange(change)) {
    return 'returned keep or no meaningful rewrite';
  }
  if (isMicroEdit(change)) {
    return 'only made a micro-edit instead of a substantive bullet rewrite';
  }
  return 'needs a stronger, more strategic rewrite';
}

function uniqueLineNumbers(values = []) {
  return [...new Set((values || []).map((value) => Number(value || 0)).filter((value) => value > 0))];
}

function buildRetryGuidance(enriched = {}, attemptIndex = 1) {
  const report = enriched?.report || {};
  const preferredLineNumbers = new Set(report.rewrite_preferences?.preferred_edit_item_lines || []);
  const hintsByLine = new Map(
    (report.inventory_hints || [])
      .map((hint) => [Number(hint?.line_number || 0), hint])
      .filter(([lineNumber]) => lineNumber > 0)
  );
  let weakChanges = (report.changes || []).filter((change) => {
    if (!isItemChange(change)) return false;
    const lineNumber = Number(change?.line_number || 0);
    const mustBeEdited = preferredLineNumbers.has(lineNumber);
    return (mustBeEdited && !isMaterialChange(change)) || isMicroEdit(change) || change?.validation?.hallucinated || change?.validation?.exact_match === false;
  });

  if (!weakChanges.length && (report.metrics?.after?.ats_score || 0) <= (report.metrics?.before?.ats_score || 0)) {
    weakChanges = (report.changes || []).filter(isItemChange).slice(0, 8);
  }

  const mustEditLineNumbers = uniqueLineNumbers(weakChanges.map((change) => change?.line_number));
  const diagnostics = weakChanges.slice(0, 10).map((change) => {
    const lineNumber = Number(change?.line_number || 0);
    const hint = hintsByLine.get(lineNumber) || {};
    const targetKeywords = (hint.target_keywords || change?.target_keywords || []).filter(Boolean);
    const previousEdit = isMaterialChange(change)
      ? ` Previous attempt: ${trimText(change?.edited_text || '', 180)}.`
      : '';
    return `Line ${lineNumber || '?'}: ${describeWeakChange(change)}.${targetKeywords.length ? ` Target keywords: ${targetKeywords.join(', ')}.` : ''} Goal: ${trimText(hint.rewrite_goal || 'Strengthen action, scope, specificity, and outcome framing without inventing facts.', 180)}.${previousEdit}`;
  });
  const discardedDiagnostics = (report.discarded_changes || []).slice(0, 6).map((change) => {
    const lineNumber = Number(change?.line_number || 0);
    const issues = (change?.validation?.issues || []).join(' ') || 'unsupported content';
    return `Rejected earlier edit for line ${lineNumber || '?'} because it was unsafe: ${issues}`;
  });
  const feedback = [
    `Retry attempt ${attemptIndex + 1}: the previous output was too weak for ${mustEditLineNumbers.length || weakChanges.length} bullet line(s).`,
    'For every line listed in <must_edit_item_lines>, return a materially different edit. Do not return keep for those lines.',
    'A valid retry must improve one or more of these dimensions: keyword coverage, ownership, scope, stakeholder context, system complexity, or outcome framing.',
    'Invalid retries include adjective-only swaps, punctuation changes, one-word insertions, or repeating the original bullet with cosmetic polish.',
    ...diagnostics,
    ...discardedDiagnostics,
  ].join('\n');

  return {
    mustEditLineNumbers,
    feedback,
  };
}

function enforceGroundedChanges(latex, parsedReq, stories, enriched) {
  const report = enriched?.report || {};
  const safeChanges = (report.changes || []).filter((change) => {
    return !change.validation?.hallucinated && change.validation?.exact_match !== false;
  });

  if (safeChanges.length === (report.changes || []).length) {
    return enriched;
  }

  const discardedChanges = (report.changes || []).filter((change) => !safeChanges.includes(change));
  const rerun = enrichTailoringReport({
    latex,
    parsedReq,
    stories,
    replacements: {
      ...report,
      changes: safeChanges,
      warnings: [
        ...(report.warnings || []),
        discardedChanges.length ? `${discardedChanges.length} unsupported change(s) were automatically removed before presenting the result.` : '',
      ].filter(Boolean),
      risks: [
        ...(report.risks || []),
      ],
    },
  });

  rerun.report.discarded_changes = discardedChanges;
  return rerun;
}

async function runAttempt(apiKey, latex, parsedReq, alignment, stories, options = {}) {
  const replacementInventory = buildReplacementInventory(latex);
  const replacementInventoryHints = buildReplacementInventoryHints(replacementInventory, alignment);
  const strategicRewriteBrief = buildStrategicRewriteBrief(alignment);
  const rewriteCoveragePlan = buildRewriteCoveragePlan(
    replacementInventoryHints,
    options.bulletReview || [],
    options.rewriteCoverage
  );
  const replaceSource = buildReplacementSource(
    latex,
    parsedReq,
    undefined,
    alignment?.evidence_candidates || []
  );
  const compactAlignment = compactAlignmentForReplacement(alignment);
  const compactedStories = compactStories(stories, options.storyLimit || 3);
  const response = await callOpenAI(
    apiKey,
    prompts.REPLACE_SYSTEM,
    prompts.REPLACE_USER(replaceSource, compactAlignment, compactedStories, {
      exhaustiveInventory: true,
      inventory: replacementInventoryHints,
      strategyBrief: strategicRewriteBrief,
      rewriteCoverage: rewriteCoveragePlan.rewriteCoverage,
      targetItemEditCount: rewriteCoveragePlan.targetItemEditCount,
      totalItemCount: rewriteCoveragePlan.totalItemCount,
      preferredEditLineNumbers: rewriteCoveragePlan.preferredEditLineNumbers,
      mustEditLineNumbers: options.mustEditLineNumbers,
      feedback: options.feedback,
      bulletReview: options.bulletReview,
    }),
    {
      maxTokens: options.maxTokens,
      model: options.model,
      temperature: options.temperature,
      disableReasoning: options.disableReasoning,
    }
  );
  const replacementsPayload = response.data && typeof response.data === 'object'
    ? {
      ...response.data,
      inventory_hints: replacementInventoryHints,
      strategy_brief: strategicRewriteBrief,
      rewrite_preferences: {
        rewrite_coverage: rewriteCoveragePlan.rewriteCoverage,
        target_item_edit_count: rewriteCoveragePlan.targetItemEditCount,
        total_item_count: rewriteCoveragePlan.totalItemCount,
        preferred_edit_item_lines: rewriteCoveragePlan.preferredEditLineNumbers,
      },
    }
    : response.data;
  const enriched = enrichTailoringReport({
    latex,
    parsedReq,
    stories,
    replacements: replacementsPayload,
  });
  const groundedEnriched = enforceGroundedChanges(latex, parsedReq, stories, enriched);

  return {
    strategy: options.feedback ? 'full_inventory_retry' : 'full_inventory',
    response,
    enriched: groundedEnriched,
    qualityScore: replacementQualityScore(groundedEnriched),
  };
}

async function generateReplacementsWithValidation(apiKey, latex, parsedReq, alignment, stories = [], opts = {}) {
  const fastMode = isFastFreeModel(apiKey, opts.model);
  const attempts = [];
  const attemptUsages = [];
  const maxAttempts = fastMode ? 1 : 3;
  let best = null;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const retryGuidance = attemptIndex > 0 && best
      ? buildRetryGuidance(best.enriched, attemptIndex)
      : { mustEditLineNumbers: [], feedback: '' };
    const plan = getAttemptPlan(opts.strictness, fastMode, attemptIndex);
    const attempt = await runAttempt(apiKey, latex, parsedReq, alignment, stories, {
      ...plan,
      model: opts.model,
      mustEditLineNumbers: retryGuidance.mustEditLineNumbers,
      feedback: retryGuidance.feedback,
      bulletReview: opts.bulletReview || [],
      rewriteCoverage: opts.rewriteCoverage,
    });
    attemptUsages.push(attempt.response.usage);
    attempts.push({
      strategy: `${attempt.strategy}:attempt_${attemptIndex + 1}`,
      qualityScore: attempt.qualityScore,
      mustEditLineNumbers: retryGuidance.mustEditLineNumbers,
      requestMeta: attempt.response.requestMeta || {},
    });

    if (!best || attempt.qualityScore > best.qualityScore) {
      best = attempt;
    }

    if (!shouldRetryReplacement(best.enriched)) {
      break;
    }
  }

  return {
    replacements: best.enriched.report,
    editedLatex: best.enriched.editedLatex,
    usage: sumUsage(attemptUsages),
    requestMeta: {
      ...(best.response.requestMeta || {}),
      strategy: best.strategy,
      attempts,
    },
  };
}

module.exports = {
  generateReplacementsWithValidation,
  isFastFreeModel,
  replacementQualityScore,
  shouldRetryReplacement,
};
