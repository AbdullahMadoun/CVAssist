require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { callOpenAI } = require('../server/openai-client');
const prompts = require('../server/prompts');
const {
  buildLocalAlignment,
} = require('../server/resume-intelligence');
const { generateReplacementsWithValidation } = require('../server/replacement-strategy');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'prompt-evals');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'prompt-evals');

function loadFixtures(filterId = '') {
  return fs.readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')))
    .filter((fixture) => !filterId || fixture.id === filterId);
}

function normalizeList(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function keywordRecall(expected, parsedReq) {
  const actual = normalizeList([
    ...(parsedReq.required_skills || []),
    ...(parsedReq.preferred_skills || []),
    ...(parsedReq.industry_keywords || []),
    ...(parsedReq.soft_skills || []),
    ...((parsedReq.keyword_taxonomy || {}).hard_skills || []),
    ...((parsedReq.keyword_taxonomy || {}).tools || []),
    ...((parsedReq.keyword_taxonomy || {}).domain_knowledge || []),
  ]);
  const wanted = normalizeList(expected);
  const matched = wanted.filter((item) => actual.some((candidate) => candidate.includes(item) || item.includes(candidate)));
  return {
    matched,
    missed: wanted.filter((item) => !matched.includes(item)),
    score: wanted.length ? Math.round((matched.length / wanted.length) * 100) : 100,
  };
}

function countGenericReasons(changes = []) {
  const genericPatterns = [
    /better alignment/i,
    /improve relevance/i,
    /tailor/i,
    /match the job/i,
    /stronger fit/i,
  ];
  return changes.filter((change) => {
    const reason = String(change.reason || '').trim();
    if (!reason) return true;
    return genericPatterns.some((pattern) => pattern.test(reason));
  }).length;
}

function countDirectImprovements(changes = [], directKeywords = []) {
  const keywords = normalizeList(directKeywords);
  return changes.filter((change) => {
    const haystack = normalizeList([
      change.edited_text,
      ...(change.target_keywords || []),
      change.reason,
    ]).join(' ');
    return keywords.some((keyword) => haystack.includes(keyword));
  }).length;
}

function countForbiddenTerms(changes = [], forbiddenTerms = []) {
  const forbidden = normalizeList(forbiddenTerms);
  return changes.reduce((count, change) => {
    const text = normalizeList([change.edited_text, ...(change.target_keywords || [])]).join(' ');
    return count + forbidden.filter((term) => text.includes(term)).length;
  }, 0);
}

function isOpenRouterFreeModel(model = '') {
  const normalized = String(model || '').toLowerCase();
  return normalized === 'openrouter/free' || normalized.endsWith(':free');
}

function summarizeFixtureResult(fixture, parsedReq, enriched) {
  const report = enriched.report || {};
  const metrics = report.metrics || {};
  const changes = report.changes || [];
  const exactMatches = changes.filter((change) => change.validation?.exact_match !== false).length;
  const hallucinations = changes.filter((change) => change.validation?.hallucinated).length;
  const unsupported = changes.filter((change) => change.validation?.issues?.length).length;
  const parseScore = keywordRecall(fixture.expected?.required_skills, parsedReq);
  const directImprovements = countDirectImprovements(changes, fixture.expected?.direct_keywords);
  const genericReasons = countGenericReasons(changes);
  const forbiddenTerms = countForbiddenTerms(changes, fixture.expected?.forbidden_terms);
  const score =
    (parseScore.score * 0.25) +
    ((metrics.after?.ats_score || 0) * 0.2) +
    ((metrics.content_preservation_score || 0) * 0.15) +
    ((changes.length ? (exactMatches / changes.length) * 100 : 100) * 0.2) +
    ((changes.length ? (directImprovements / changes.length) * 100 : 0) * 0.2) -
    (hallucinations * 20) -
    (genericReasons * 8) -
    (forbiddenTerms * 25) -
    (unsupported * 5);

  return {
    fixture: fixture.id,
    parse: parseScore,
    metrics: {
      ats_before: metrics.before?.ats_score || 0,
      ats_after: metrics.after?.ats_score || 0,
      preservation: metrics.content_preservation_score || 0,
    },
    changes: {
      total: changes.length,
      exactMatches,
      hallucinations,
      unsupported,
      directImprovements,
      genericReasons,
      forbiddenTerms,
    },
    score: Math.max(0, Math.round(score)),
  };
}

async function evaluateFixture(apiKey, model, fixture) {
  const freeModel = isOpenRouterFreeModel(model);
  const parsed = await callOpenAI(
    apiKey,
    prompts.PARSE_JOB_SYSTEM,
    prompts.PARSE_JOB_USER(fixture.jobDescription),
    { model, maxTokens: 1100, temperature: 0.1, disableReasoning: freeModel }
  );

  const alignment = buildLocalAlignment(parsed.data, fixture.latex, fixture.stories || []);
  const replacements = await generateReplacementsWithValidation(
    apiKey,
    fixture.latex,
    parsed.data,
    alignment,
    fixture.stories || [],
    { model }
  );

  return {
    fixture: fixture.id,
    requestMeta: {
      parse: parsed.requestMeta || {},
      replace: replacements.requestMeta || {},
    },
    summary: summarizeFixtureResult(fixture, parsed.data, {
      report: replacements.replacements,
      editedLatex: replacements.editedLatex,
    }),
  };
}

async function main() {
  const fixtureArg = process.argv.find((arg) => arg.startsWith('--fixture=')) ||
    (process.env.npm_config_fixture ? `--fixture=${process.env.npm_config_fixture}` : '');
  const modelArg = process.argv.find((arg) => arg.startsWith('--model=')) ||
    (process.env.npm_config_model ? `--model=${process.env.npm_config_model}` : '');
  const fixtureId = fixtureArg.split('=')[1] || '';
  const requestedModel = modelArg.split('=')[1] || '';
  const preferOpenRouter = requestedModel
    ? (requestedModel === 'openrouter/free' || requestedModel.endsWith(':free') || requestedModel.includes('/'))
    : Boolean(process.env.OPENROUTER_API_KEY);
  const model = requestedModel || (preferOpenRouter
    ? (process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2')
    : (process.env.OPENAI_MODEL || 'gpt-4o-mini'));
  const apiKey = preferOpenRouter
    ? (process.env.OPENROUTER_API_KEY || '')
    : (process.env.OPENAI_API_KEY || '');

  if (!apiKey) {
    console.log('Skipped prompt eval: compatible API key is not configured for the selected model.');
    process.exit(0);
  }

  const fixtures = loadFixtures(fixtureId);
  if (!fixtures.length) {
    throw new Error(fixtureId ? `No fixture found for ${fixtureId}` : 'No prompt eval fixtures found');
  }

  const started = Date.now();
  const results = [];
  for (const fixture of fixtures) {
    try {
      results.push(await evaluateFixture(apiKey, model, fixture));
    } catch (error) {
      results.push({
        fixture: fixture.id,
        error: error.message,
        summary: {
          fixture: fixture.id,
          parse: { matched: [], missed: [], score: 0 },
          metrics: { ats_before: 0, ats_after: 0, preservation: 0 },
          changes: {
            total: 0,
            exactMatches: 0,
            hallucinations: 0,
            unsupported: 0,
            directImprovements: 0,
            genericReasons: 0,
            forbiddenTerms: 0,
          },
          score: 0,
          error: error.message,
        },
      });
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = {
    generated_at: new Date().toISOString(),
    model,
    total_ms: Date.now() - started,
    results,
    average_score: Math.round(results.reduce((sum, item) => sum + (item.summary?.score || 0), 0) / Math.max(results.length, 1)),
  };
  const outPath = path.join(OUTPUT_DIR, `latest-${model.replace(/[^a-zA-Z0-9]+/g, '_')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify({
    model,
    total_ms: output.total_ms,
    average_score: output.average_score,
    results: results.map((item) => item.summary),
    output_file: outPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
