require('dotenv').config();
const assert = require('assert');

const { callOpenAI, buildChatRequest } = require('../server/openai-client');
const prompts = require('../server/prompts');
const { buildLocalAlignment, buildReplacementSource, enrichTailoringReport, buildReplacementInventory } = require('../server/resume-intelligence');

const apiKey = process.env.OPENROUTER_API_KEY || '';
const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2';

const jobDescription = `
Senior Software Engineer building React and Node.js systems for analytics workflows.
Requirements: JavaScript, TypeScript, SQL, cloud deployment, mentoring, dashboard development.
Preferred: AWS, product collaboration, measurable impact.
`.trim();

const latex = `
\\section*{Experience}
\\begin{itemize}
\\item Built React dashboards used by enterprise analytics teams.
\\item Automated internal reporting workflows with SQL and Python.
\\item Partnered with engineers and product managers to ship customer-facing features.
\\end{itemize}
`.trim();

const stories = [
  { tag: 'cloud', text: 'Supported AWS deployments and release checklists for analytics dashboards.' },
  { tag: 'leadership', text: 'Mentored junior developers during sprint planning and code review.' },
];

async function main() {
  if (!apiKey) {
    console.log('Skipped OpenRouter smoke test: OPENROUTER_API_KEY is not configured.');
    process.exit(0);
  }

  if (!apiKey.startsWith('sk-or-')) {
    throw new Error('OPENROUTER_API_KEY is present but does not look like an OpenRouter key.');
  }

  const built = buildChatRequest(apiKey, 'Return {"ok":true}', 'Respond with JSON only.', { model, maxTokens: 64 }, { jsonMode: true });
  assert.strictEqual(built.requestMeta.provider, 'openrouter');
  assert.strictEqual(built.requestOptions.model, model);
  assert.deepStrictEqual(built.requestOptions.plugins, [{ id: 'response-healing' }]);
  if (built.requestMeta.freeModel) {
    assert.deepStrictEqual(built.requestOptions.provider, {
      sort: 'latency',
      require_parameters: true,
      allow_fallbacks: true,
    });
  } else {
    assert.strictEqual(built.requestOptions.provider, undefined);
  }

  const parsed = await callOpenAI(
    apiKey,
    prompts.PARSE_JOB_SYSTEM,
    prompts.PARSE_JOB_USER(jobDescription),
    { model, maxTokens: 900, temperature: 0.1 }
  );
  assert.ok(parsed.data && typeof parsed.data === 'object', 'Parse stage did not return an object');
  assert.ok(Array.isArray(parsed.data.required_skills), 'Parse stage required_skills missing');

  const alignment = buildLocalAlignment(parsed.data, latex, stories);
  const replaceSource = buildReplacementSource(latex, parsed.data);
  const replacements = await callOpenAI(
    apiKey,
    prompts.REPLACE_SYSTEM,
    prompts.REPLACE_USER(replaceSource, alignment, stories, { candidateSubset: true }),
    { model, maxTokens: 2000, temperature: 0.2 }
  );
  const enriched = enrichTailoringReport({
    latex,
    parsedReq: parsed.data,
    stories,
    replacements: replacements.data,
  });
  const inventory = buildReplacementInventory(latex);
  assert.ok(Array.isArray(replacements.data?.changes), 'Replacement stage did not return changes');
  assert.strictEqual(enriched.report.coverage.total_targets, inventory.length, 'Replacement coverage did not include every target line');
  assert.strictEqual(enriched.report.changes.length, inventory.length, 'Normalized change list did not cover every target line');
  assert.ok(enriched.report?.metrics?.after?.ats_score >= 0, 'Evaluation metrics missing');

  console.log(JSON.stringify({
    provider: parsed.requestMeta?.provider,
    model: parsed.requestMeta?.model,
    freeModel: parsed.requestMeta?.freeModel,
    parseTokens: parsed.usage?.total_tokens || 0,
    replaceTokens: replacements.usage?.total_tokens || 0,
    replacementCount: replacements.data?.changes?.length || 0,
    atsAfter: enriched.report?.metrics?.after?.ats_score || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
