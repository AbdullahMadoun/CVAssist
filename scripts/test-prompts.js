require('dotenv').config();

const { callOpenAI } = require('../server/openai-client');
const { getCoverLetterTemplateForPrompt } = require('../server/cover-letter-template');
const prompts = require('../server/prompts');

const apiKey = process.env.OPENROUTER_API_KEY || '';
const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2';

const dummyJobDesc = `
We are looking for a Senior Software Engineer with experience in React, Node.js, SQL, and cloud deployment.
You will mentor junior developers, build dashboards, and ship measurable product improvements.
Preferred: AWS and cross-functional collaboration.
`.trim();

const dummyCVLatex = `
\\section*{Experience}
\\begin{itemize}
\\item Built React and Node.js applications for internal teams.
\\item Automated reporting workflows with SQL.
\\item Collaborated with product and engineering partners on customer-facing features.
\\end{itemize}
`.trim();

const dummyParsedReq = {
  company: 'Tech Corp',
  title: 'Senior Software Engineer',
  seniority: 'senior',
  required_skills: ['React', 'Node.js', 'SQL'],
  preferred_skills: ['AWS'],
  responsibilities: ['build dashboards', 'mentor junior developers'],
  industry_keywords: ['analytics', 'cloud'],
  soft_skills: ['mentoring', 'collaboration'],
  education: '',
  experience_years: '5+',
  culture_signals: ['cross-functional'],
  keyword_taxonomy: {
    hard_skills: ['React', 'Node.js', 'SQL'],
    tools: ['AWS'],
    certifications: [],
    domain_knowledge: ['analytics'],
  },
};

const dummyAlignment = {
  overall_score: 78,
  overall_verdict: 'Strong stack match with room to sharpen mentoring and cloud emphasis.',
  sections: [
    {
      name: 'Experience',
      score: 82,
      matched_keywords: ['React', 'Node.js', 'SQL'],
      gaps: ['AWS', 'mentoring'],
      suggestions: ['Emphasize impact and mentoring evidence.'],
      story_to_weave: '',
    },
  ],
  missing_from_cv: ['AWS'],
  strongest_matches: ['React dashboards', 'SQL automation'],
  recommended_emphasis: ['Product collaboration'],
  corpus_suggestions: [],
};

async function main() {
  const promptType = process.argv[2] || 'parse-job';
  if (!apiKey) {
    console.log('Skipped: OPENROUTER_API_KEY is not configured.');
    process.exit(0);
  }

  let result;
  switch (promptType) {
    case 'cover-letter':
      result = await callOpenAI(
        apiKey,
        prompts.COVER_LETTER_SYSTEM,
        prompts.COVER_LETTER_USER(dummyParsedReq, dummyCVLatex, dummyAlignment, {}, '', getCoverLetterTemplateForPrompt()),
        { model, maxTokens: 500, temperature: 0.3 }
      );
      break;
    case 'interview-prep':
      result = await callOpenAI(
        apiKey,
        prompts.INTERVIEW_PREP_SYSTEM,
        prompts.INTERVIEW_PREP_USER(dummyParsedReq, dummyCVLatex, dummyAlignment),
        { model, maxTokens: 900, temperature: 0.2 }
      );
      break;
    case 'parse-job':
      result = await callOpenAI(
        apiKey,
        prompts.PARSE_JOB_SYSTEM,
        prompts.PARSE_JOB_USER(dummyJobDesc),
        { model, maxTokens: 900, temperature: 0.1 }
      );
      break;
    default:
      console.error('Unknown prompt type. Use one of: parse-job, cover-letter, interview-prep');
      process.exit(1);
  }

  console.log(JSON.stringify({
    promptType,
    model: result.requestMeta?.model || model,
    usage: result.usage || {},
    data: result.data,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
