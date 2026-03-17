require('dotenv').config();
const assert = require('assert');

const { callOpenAI } = require('../server/openai-client');
const { getCoverLetterTemplateForPrompt } = require('../server/cover-letter-template');
const { runPipeline } = require('../server/pipeline');
const prompts = require('../server/prompts');

const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const jobDescription = `
Product-minded full-stack engineer building React, Node.js, and SQL workflows.
Must communicate clearly, ship measurable improvements, and work cross-functionally.
Preferred: AWS and mentoring experience.
`.trim();

const latex = `
\\section*{Experience}
\\begin{itemize}
\\item Built React interfaces for internal operations teams.
\\item Automated SQL reporting workflows and process handoffs.
\\item Worked with product managers to improve onboarding flows.
\\end{itemize}
`.trim();

async function main() {
  if (!apiKey) {
    console.log('Skipped OpenAI live smoke test: OPENAI_API_KEY is not configured.');
    process.exit(0);
  }

  const parsed = await callOpenAI(
    apiKey,
    prompts.PARSE_JOB_SYSTEM,
    prompts.PARSE_JOB_USER(jobDescription),
    { model, maxTokens: 700, temperature: 0.1 }
  );
  assert.ok(parsed.data && Array.isArray(parsed.data.required_skills), 'Parse response was not valid JSON');

  const result = await runPipeline(
    apiKey,
    latex,
    jobDescription,
    [{ tag: 'leadership', text: 'Mentored teammates during peer reviews and onboarding.' }],
    () => {},
    { model }
  );
  assert.ok(Array.isArray(result.replacements?.changes), 'Pipeline did not return changes');

  const interview = await callOpenAI(
    apiKey,
    prompts.INTERVIEW_PREP_SYSTEM,
    prompts.INTERVIEW_PREP_USER(result.parsedReq, latex, result.alignment),
    { model, maxTokens: 900, temperature: 0.2 }
  );
  assert.ok(Array.isArray(interview.data?.talking_points), 'Interview prep shape was invalid');

  const cover = await callOpenAI(
    apiKey,
    prompts.COVER_LETTER_SYSTEM,
    prompts.COVER_LETTER_USER(result.parsedReq, latex, result.alignment, {}, '', getCoverLetterTemplateForPrompt()),
    { model, maxTokens: 450, temperature: 0.3 }
  );
  assert.ok(Array.isArray(cover.data?.body_latex) && cover.data.body_latex.length >= 2, 'Cover letter payload was invalid');

  console.log(JSON.stringify({
    model,
    parseTokens: parsed.usage?.total_tokens || 0,
    pipelineTokens: result.tokenUsage?.total_tokens || 0,
    pipelineMs: result.tokenUsage?.timings?.total_ms || 0,
    interviewTokens: interview.usage?.total_tokens || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
