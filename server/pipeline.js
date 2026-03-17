const { callOpenAI } = require('./openai-client');
const prompts = require('./prompts');
const {
  generateReplacementsWithValidation,
  isFastFreeModel,
} = require('./replacement-strategy');
const { buildLocalAlignment } = require('./resume-intelligence');

/**
 * Blend local ATS-computed alignment with LLM-enriched alignment.
 * Local provides deterministic keyword/scoring baseline.
 * LLM provides contextual per-bullet review and nuanced scoring.
 * Scores are averaged 50/50 when both sources exist.
 */
function blendAlignment(local, llm) {
  if (!llm || typeof llm !== 'object') return { ...local, _bulletReviewFlat: flattenBulletReviews(local) };

  const localSections = Array.isArray(local?.sections) ? local.sections : [];
  const llmSections = Array.isArray(llm?.sections) ? llm.sections : [];

  // Build a lookup for LLM sections by name
  const llmSectionMap = new Map();
  llmSections.forEach((s) => {
    const key = String(s?.name || '').trim().toLowerCase();
    if (key) llmSectionMap.set(key, s);
  });

  // Blend each section
  const blendedSections = localSections.map((localSection) => {
    const key = String(localSection?.name || '').trim().toLowerCase();
    const llmSection = llmSectionMap.get(key);

    if (!llmSection) return localSection;

    // Blend scores: 50% local, 50% LLM
    const localScore = Number(localSection?.score || localSection?.scoring?.overall || 0);
    const llmScore = Number(llmSection?.scoring?.overall || llmSection?.score || localScore);
    const blendedScore = Math.round((localScore + llmScore) / 2);

    // Prefer LLM's bullet_review (richer context), fall back to local
    const bulletReview = Array.isArray(llmSection?.bullet_review) && llmSection.bullet_review.length > 0
      ? llmSection.bullet_review
      : (localSection?.bullet_review || []);

    // Merge scoring: blend each axis
    const localScoring = localSection?.scoring || {};
    const llmScoring = llmSection?.scoring || {};
    const blendedScoring = {
      keyword_match: {
        score: Math.round(((Number(localScoring?.keyword_match?.score || 0)) + (Number(llmScoring?.keyword_match?.score || localScoring?.keyword_match?.score || 0))) / 2),
        matched: uniqueStrings([...(localScoring?.keyword_match?.matched || []), ...(llmScoring?.keyword_match?.matched || [])]),
        missing: uniqueStrings([...(localScoring?.keyword_match?.missing || []), ...(llmScoring?.keyword_match?.missing || [])]),
        reasoning: llmScoring?.keyword_match?.reasoning || localScoring?.keyword_match?.reasoning || '',
      },
      evidence_quality: {
        score: Math.round(((Number(localScoring?.evidence_quality?.score || 0)) + (Number(llmScoring?.evidence_quality?.score || localScoring?.evidence_quality?.score || 0))) / 2),
        reasoning: llmScoring?.evidence_quality?.reasoning || localScoring?.evidence_quality?.reasoning || '',
      },
      relevance: {
        score: Math.round(((Number(localScoring?.relevance?.score || 0)) + (Number(llmScoring?.relevance?.score || localScoring?.relevance?.score || 0))) / 2),
        reasoning: llmScoring?.relevance?.reasoning || localScoring?.relevance?.reasoning || '',
      },
      overall: blendedScore,
    };

    return {
      ...localSection,
      score: blendedScore,
      scoring: blendedScoring,
      bullet_review: bulletReview,
      // Merge suggestions (deduplicated)
      suggestions: uniqueStrings([
        ...(localSection?.suggestions || []),
        ...(llmSection?.suggestions || []),
      ]).slice(0, 5),
      // Prefer LLM's matched_keywords (richer context)
      matched_keywords: uniqueStrings([
        ...(localSection?.matched_keywords || []),
        ...(llmScoring?.keyword_match?.matched || []),
      ]).slice(0, 10),
      gaps: uniqueStrings([
        ...(localSection?.gaps || []),
        ...(llmScoring?.keyword_match?.missing || []),
      ]).slice(0, 10),
    };
  });

  // Blend overall score
  const localOverall = Number(local?.overall_score || 0);
  const llmOverall = Number(llm?.overall_score || localOverall);
  const blendedOverall = Math.round((localOverall + llmOverall) / 2);

  const blended = {
    ...local,
    overall_score: blendedOverall,
    overall_verdict: llm?.overall_verdict || local?.overall_verdict || '',
    sections: blendedSections,
    // Merge missing and strongest from both sources
    missing_from_cv: uniqueStrings([
      ...(local?.missing_from_cv || []),
      ...(llm?.missing_from_cv || []),
    ]).slice(0, 10),
    strongest_matches: uniqueStrings([
      ...(local?.strongest_matches || []),
      ...(llm?.strongest_matches || []),
    ]).slice(0, 5),
    recommended_emphasis: uniqueStrings([
      ...(local?.recommended_emphasis || []),
      ...(llm?.recommended_emphasis || []),
    ]).slice(0, 6),
    _llm_enriched: true,
    _bulletReviewFlat: flattenBulletReviews({ sections: blendedSections }),
  };

  return blended;
}

function flattenBulletReviews(alignment) {
  const sections = Array.isArray(alignment?.sections) ? alignment.sections : [];
  const flat = [];
  sections.forEach((section) => {
    (section?.bullet_review || []).forEach((review) => {
      flat.push({
        section_name: section?.name || 'General',
        text: review?.text || '',
        verdict: review?.verdict || 'adequate',
        gap: review?.gap || '',
        suggestion: review?.suggestion || '',
      });
    });
  });
  return flat;
}

function uniqueStrings(items) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function compressJobDescriptionLocally(jobDesc = '', limit = 2200) {
  const lines = String(jobDesc || '')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return '';

  const priority = [];
  const secondary = [];
  lines.forEach((line) => {
    if (
      /^[-*•]/.test(line) ||
      /(require|qualification|responsibil|skill|experience|about the role|what you'll do|what we are looking for)/i.test(line)
    ) {
      priority.push(line);
    } else {
      secondary.push(line);
    }
  });

  const chosen = [...priority, ...secondary];
  let result = '';
  for (const line of chosen) {
    const next = result ? `${result}\n${line}` : line;
    if (next.length > limit) break;
    result = next;
  }
  return result || String(jobDesc || '').slice(0, limit);
}

/**
 * Compress LaTeX for the LLM analysis stage (Stage 2b) only.
 *
 * SAFETY: Never use this output for replacement/editing.
 *         The original LaTeX must flow through Stage 3 and enrichTailoringReport
 *         because original_text exact-match depends on it.
 *
 * Removes:
 *   - Everything before \begin{document} (preamble: \documentclass, \usepackage, etc.)
 *   - % comment lines
 *   - Pure layout/spacing commands that carry no content
 *   - Excessive blank lines
 */
function compressLatexForAnalysis(latex = '', charLimit = 14000) {
  let text = String(latex || '');

  // 1. Strip preamble: everything up to and including \begin{document}
  const docStart = text.indexOf('\\begin{document}');
  if (docStart !== -1) {
    text = text.slice(docStart + '\\begin{document}'.length);
  }

  // 2. Strip \end{document}
  text = text.replace(/\\end\{document\}/g, '');

  // 3. Strip full-line % comments (lines that are only a comment)
  text = text.replace(/^[ \t]*%.*$/gm, '');

  // 4. Strip inline % comments (trailing, after content) — careful: \% is an escaped percent sign
  text = text.replace(/(?<!\\)%[^\n]*/g, '');

  // 5. Strip pure layout/spacing commands with optional arguments — these carry zero content
  const layoutCmds = [
    'vspace', 'hspace', 'vspace\\*', 'hspace\\*',
    'medskip', 'bigskip', 'smallskip', 'vfill', 'hfill',
    'noindent', 'centering', 'raggedright', 'raggedleft',
    'newpage', 'clearpage', 'cleardoublepage', 'pagebreak',
    'setlength', 'addtolength', 'setcounter', 'addtocounter',
    'renewcommand', 'newcommand', 'def', 'let',
    'pagestyle', 'thispagestyle', 'pagenumbering',
    'null', 'par', 'linebreak', 'allowbreak',
    'color', 'textcolor',
    'fontsize', 'selectfont', 'linespread',
    'columnsep', 'columnseprule',
  ];
  // Match lines that consist only of these commands (possibly with args)
  const layoutLineRe = new RegExp(
    `^[ \\t]*\\\\(?:${layoutCmds.map((c) => c.replace(/\\/g, '\\\\')).join('|')})(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})*[ \\t]*$`,
    'gm'
  );
  text = text.replace(layoutLineRe, '');

  // 6. Strip begin/end for purely structural environments (not itemize/enumerate/list)
  text = text.replace(/\\(?:begin|end)\{(?:center|flushleft|flushright|minipage|tabular|multicols?|adjustbox|tabularx|array)\*?\}(?:\[[^\]]*\])?(?:\{[^{}]*\})*/g, '');

  // 7. Collapse 3+ consecutive blank lines → single blank line
  text = text.replace(/\n{3,}/g, '\n\n');

  // 8. Trim leading/trailing whitespace per line, remove lines that became empty
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  // 9. Hard char limit — truncate at a section boundary if possible
  if (text.length > charLimit) {
    const truncated = text.slice(0, charLimit);
    const lastSection = truncated.lastIndexOf('\\section');
    text = lastSection > charLimit * 0.6 ? truncated.slice(0, lastSection).trimEnd() : truncated.trimEnd();
    text += '\n\n[... CV truncated for analysis ...]';
  }

  return text;
}

async function timed(stageTimings, stage, fn) {
  const started = Date.now();
  const result = await fn();
  stageTimings[`${stage}_ms`] = Date.now() - started;
  return result;
}

/**
 * Run the full tailoring pipeline.
 * Each stage stores its result and can be run independently.
 *
 * @param {string} apiKey
 * @param {string} latex       — original LaTeX CV
 * @param {string} jobDesc     — raw job description text
 * @param {Array}  stories     — [{tag, text}] life stories
 * @param {function} onProgress — callback(stage, status) for live updates
 * @returns {Promise<{parsedReq, alignment, editedLatex, replacements, tokenUsage}>}
 */
async function runPipeline(apiKey, latex, jobDesc, stories = [], onProgress = () => { }, opts = {}) {
  const tokenUsage = { total_prompt: 0, total_completion: 0, total_tokens: 0, by_stage: {} };
  const stageTimings = {};
  const fastMode = isFastFreeModel(apiKey, opts.model);

  function trackTokens(stage, usage) {
    tokenUsage.by_stage[stage] = usage;
    tokenUsage.total_prompt += usage.prompt_tokens || 0;
    tokenUsage.total_completion += usage.completion_tokens || 0;
    tokenUsage.total_tokens += usage.total_tokens || 0;
  }

  // ── Stage 0: Condense job description locally ────────────────────────
  onProgress('summarize', 'Condensing job description locally...');
  const { summary, usage: u0 } = await timed(stageTimings, 'summarize', async () => ({
    summary: compressJobDescriptionLocally(jobDesc),
    usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
  }));
  trackTokens('summarize', u0);
  const trimmedJobDesc = summary || jobDesc;

  // ── Stage 1: Parse job requirements ──────────────────────────────────
  onProgress('parse', 'Analyzing job requirements...');
  const { data: parsedReq, usage: u1 } = await timed(stageTimings, 'parse', () => callOpenAI(
    apiKey,
    prompts.PARSE_JOB_SYSTEM,
    prompts.PARSE_JOB_USER(trimmedJobDesc),
    {
      model: opts.model,
      maxTokens: fastMode ? 1100 : 2200,
      disableReasoning: fastMode,
    }
  ));
  trackTokens('parse', u1);

  // ── Stage 2: Hybrid ATS alignment analysis (local + LLM enrichment) ──
  const parsedStories = Array.isArray(stories) ? stories :
    (typeof stories === 'string' ? JSON.parse(stories || '[]') : []);

  // 2a: Local ATS-style scoring (fast, deterministic)
  onProgress('analyze', 'Running local ATS gap analysis...');
  const localAlignment = await timed(stageTimings, 'analyze_local', async () =>
    buildLocalAlignment(parsedReq, latex, parsedStories)
  );

  // 2b + Stage 3: Run LLM alignment enrichment and replacement generation in PARALLEL.
  // Stage 3 uses the local alignment (already computed in 2a) so it can start immediately.
  // Stage 2b runs alongside it — its result enriches the alignment shown in the UI response,
  // but no longer gates the replacement step.
  onProgress('analyze', 'AI reviewing bullets and generating edits in parallel...');

  const localAlignmentForReplace = blendAlignment(localAlignment, null); // local-only blend for Stage 3

  const [llmAlignmentResult, replacementResult] = await Promise.all([
    // 2b: LLM alignment enrichment (runs in background while Stage 3 works)
    fastMode
      ? Promise.resolve({ llmAlignment: null, analyzeUsage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 } })
      : timed(stageTimings, 'analyze_llm', () =>
          callOpenAI(
            apiKey,
            prompts.ANALYZE_ALIGNMENT_SYSTEM,
            prompts.ANALYZE_ALIGNMENT_USER(parsedReq, compressLatexForAnalysis(latex)),
            {
              model: opts.model,
              maxTokens: 4096,
              disableReasoning: false,
            }
          )
        ).then(({ data, usage }) => ({ llmAlignment: data, analyzeUsage: usage }))
          .catch((err) => {
            console.warn('LLM alignment enrichment failed, using local-only:', err.message);
            return { llmAlignment: null, analyzeUsage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 } };
          }),

    // Stage 3: Replacement generation (starts immediately with local alignment)
    timed(stageTimings, 'replace', () => {
      onProgress('replace', 'Generating precise tailoring edits...');
      return generateReplacementsWithValidation(
        apiKey,
        latex,
        parsedReq,
        localAlignmentForReplace,
        parsedStories,
        {
          model: opts.model,
          bulletReview: localAlignmentForReplace._bulletReviewFlat || [],
          rewriteCoverage: opts.rewriteCoverage,
        }
      );
    }),
  ]);

  const analyzeUsage = llmAlignmentResult.analyzeUsage;
  trackTokens('analyze', analyzeUsage);
  trackTokens('replace', replacementResult.usage);

  // 2c: Blend alignment for UI display (Stage 3 already ran with local alignment)
  const alignment = blendAlignment(localAlignment, llmAlignmentResult.llmAlignment);

  // ── Stage 4: Local verification + scoring ────────────────────────────
  onProgress('verify', 'Verifying replacements and computing quality scores...');
  const enriched = await timed(stageTimings, 'verify', async () => ({
    editedLatex: replacementResult.editedLatex,
    report: replacementResult.replacements,
  }));

  onProgress('done', 'Pipeline complete');
  tokenUsage.timings = {
    ...stageTimings,
    total_ms: Object.values(stageTimings).reduce((sum, value) => sum + value, 0),
    fast_mode: fastMode,
  };
  return {
    parsedReq,
    alignment: {
      ...alignment,
      local_scores: enriched.report.metrics,
    },
    editedLatex: enriched.editedLatex,
    replacements: enriched.report,
    tokenUsage,
  };
}

/**
 * Run a single stage of the pipeline (for re-running individual stages).
 */
async function runStage(apiKey, stage, params) {
  switch (stage) {
    case 'parse': {
      const { data, usage } = await callOpenAI(
        apiKey, prompts.PARSE_JOB_SYSTEM, prompts.PARSE_JOB_USER(params.jobDesc),
        { model: params.model, maxTokens: 2200, disableReasoning: true }
      );
      return { data, usage };
    }
    case 'analyze': {
      const stories = Array.isArray(params.stories) ? params.stories :
        JSON.parse(params.stories || '[]');
      const data = buildLocalAlignment(params.parsedReq, params.latex, stories);
      const usage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
      return { data, usage };
    }
    case 'replace': {
      const stories = Array.isArray(params.stories) ? params.stories :
        JSON.parse(params.stories || '[]');
      const { data, usage } = await callOpenAI(
        apiKey, prompts.REPLACE_SYSTEM,
        prompts.REPLACE_USER(params.latex, params.alignment, stories),
        { maxTokens: 2600, model: params.model, disableReasoning: true }
      );
      return { data, usage };
    }
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

module.exports = { runPipeline, runStage };
