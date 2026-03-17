const assert = require('assert');
const path = require('path');

const { buildChatRequest, buildRequestVariants } = require('../server/openai-client');
const { normalizeCapturedJobPayload } = require('../server/job-capture');
const { enrichTailoringReport, buildLocalAlignment, computeAtsScore, buildReplacementInventory } = require('../server/resume-intelligence');
const { renderCoverLetterTemplate } = require('../server/cover-letter-template');
const { startServer } = require('../server/server');
const { checkPdflatex } = require('../server/compiler');
const prompts = require('../server/prompts');
const db = require('../server/db');
const appBridge = require(path.join(__dirname, '..', 'chrome-job-capture-extension', 'lib', 'app-bridge.js'));

function testResumeIntelligence() {
  const latex = `
\\section*{Experience}
\\begin{itemize}
\\item Built React dashboards for 5 enterprise clients.
\\item Automated reporting workflows with SQL and Python.
\\end{itemize}
    `.trim();
  const input = enrichTailoringReport({
    latex,
    parsedReq: {
      required_skills: ['React', 'Python'],
      preferred_skills: ['AWS'],
      responsibilities: ['build dashboards'],
      keyword_taxonomy: {
        hard_skills: ['SQL'],
        tools: ['Python'],
        certifications: [],
        domain_knowledge: ['analytics'],
      },
    },
    stories: [
      { tag: 'cloud', text: 'Supported AWS analytics deployments for internal dashboards.' },
    ],
    replacements: {
      summary: 'Smoke test',
      changes: [
        {
          section_name: 'Experience',
          importance: 'critical',
          original_text: '\\item Built React dashboards for 5 enterprise clients.',
          edited_text: '\\item Built React dashboards for 5 enterprise clients and supported AWS analytics deployments.',
          reason: 'Better keyword alignment',
          target_keywords: ['React', 'AWS', 'analytics'],
          is_hallucinated: false,
        },
      ],
      risks: [],
    },
  });

  assert.ok(input.editedLatex.includes('AWS analytics deployments'));
  assert.ok(input.report.metrics.after.ats_score >= input.report.metrics.before.ats_score);
  assert.ok(Array.isArray(input.report.changes));
  assert.ok(input.report.metrics.verification_summary.applied_changes >= 1);
  assert.strictEqual(input.report.coverage.total_targets, buildReplacementInventory(latex).length);
  assert.ok(input.report.coverage.edited_targets >= 1);
  assert.strictEqual(input.report.changes.length, 2);
  assert.notStrictEqual(input.report.changes[1].edited_text, '');
  const localAlignment = buildLocalAlignment({
    required_skills: ['React', 'Python'],
    preferred_skills: ['AWS'],
    responsibilities: ['build dashboards'],
    keyword_taxonomy: {
      hard_skills: ['SQL'],
      tools: ['Python'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  }, input.editedLatex, [
    { tag: 'cloud', text: 'Supported AWS analytics deployments for internal dashboards.' },
  ]);
  assert.ok(Array.isArray(localAlignment.priority_gaps));
  assert.ok(Array.isArray(localAlignment.evidence_candidates));
  const score = computeAtsScore(input.editedLatex, {
    required_skills: ['React', 'Python'],
    preferred_skills: ['AWS'],
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    responsibilities: ['build dashboards'],
    keyword_taxonomy: {
      hard_skills: ['SQL'],
      tools: ['Python'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  assert.ok(score.ats_score >= 0);
  assert.ok(typeof score.weighted_keyword_score === 'number');
  assert.ok(typeof score.keyword_balance_score === 'number');
  assert.ok(typeof score.bm25_requirement_score === 'number');
  assert.ok(typeof score.role_family_score === 'number' || score.role_family_score === null);

  const titleAligned = computeAtsScore(`
\\section*{Summary}
Senior Frontend Engineer building React analytics platforms with Python and SQL.
\\section*{Experience}
\\begin{itemize}
\\item Built React dashboards for 5 enterprise clients.
\\item Automated reporting workflows with SQL and Python.
\\end{itemize}
  `.trim(), {
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    required_skills: ['React', 'Python'],
    preferred_skills: ['AWS'],
    responsibilities: ['build dashboards'],
    keyword_taxonomy: {
      hard_skills: ['SQL'],
      tools: ['Python'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  const titleMissing = computeAtsScore(`
\\section*{Summary}
Software engineer building customer dashboards with modern web tooling.
\\section*{Experience}
\\begin{itemize}
\\item Built React dashboards for 5 enterprise clients.
\\item Automated reporting workflows with SQL and Python.
\\end{itemize}
  `.trim(), {
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    required_skills: ['React', 'Python'],
    preferred_skills: ['AWS'],
    responsibilities: ['build dashboards'],
    keyword_taxonomy: {
      hard_skills: ['SQL'],
      tools: ['Python'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  assert.ok((titleAligned.title_alignment_score || 0) > (titleMissing.title_alignment_score || 0));

  const balanced = computeAtsScore(`
\\section*{Summary}
Senior Frontend Engineer building React analytics platforms on AWS.
\\section*{Experience}
\\begin{itemize}
\\item Built React dashboards for analytics teams and partnered with AWS platform owners.
\\item Automated Python reporting workflows with SQL for cloud operations reviews.
\\end{itemize}
  `.trim(), {
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    required_skills: ['React', 'Python', 'AWS'],
    preferred_skills: ['SQL'],
    responsibilities: ['build dashboards'],
    keyword_taxonomy: {
      hard_skills: ['SQL'],
      tools: ['Python', 'AWS'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  const stuffed = computeAtsScore(`
\\section*{Summary}
Engineer.
\\section*{Experience}
\\begin{itemize}
\\item AWS AWS AWS React React React Python Python analytics analytics dashboards dashboards.
\\item Maintained systems.
\\end{itemize}
  `.trim(), {
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    required_skills: ['React', 'Python', 'AWS'],
    preferred_skills: ['SQL'],
    responsibilities: ['build dashboards'],
    keyword_taxonomy: {
      hard_skills: ['SQL'],
      tools: ['Python', 'AWS'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  assert.ok(balanced.keyword_balance_score > stuffed.keyword_balance_score);
  assert.ok(balanced.bm25_requirement_score > stuffed.bm25_requirement_score);

  const frontendFit = computeAtsScore(`
\\section*{Summary}
Senior frontend engineer shipping React and TypeScript interfaces for analytics products.
\\section*{Experience}
\\begin{itemize}
\\item Built React dashboards and improved UI performance for enterprise clients.
\\end{itemize}
  `.trim(), {
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    required_skills: ['React', 'TypeScript'],
    preferred_skills: ['CSS'],
    responsibilities: ['build user interfaces'],
    keyword_taxonomy: {
      hard_skills: ['React'],
      tools: ['TypeScript'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  const backendFit = computeAtsScore(`
\\section*{Summary}
Backend engineer working on APIs, databases, and distributed services.
\\section*{Experience}
\\begin{itemize}
\\item Built Node.js APIs and optimized PostgreSQL queries for internal services.
\\end{itemize}
  `.trim(), {
    title: 'Senior Frontend Engineer',
    seniority: 'senior',
    required_skills: ['React', 'TypeScript'],
    preferred_skills: ['CSS'],
    responsibilities: ['build user interfaces'],
    keyword_taxonomy: {
      hard_skills: ['React'],
      tools: ['TypeScript'],
      certifications: [],
      domain_knowledge: ['analytics'],
    },
  });
  assert.ok((frontendFit.role_family_score || 0) > (backendFit.role_family_score || 0));
}

function testDatabaseColumns() {
  const sessionColumns = db.db.prepare('PRAGMA table_info(sessions)').all().map((entry) => entry.name);
  const jobColumns = db.db.prepare('PRAGMA table_info(jobs)').all().map((entry) => entry.name);
  const vaultColumns = db.db.prepare('PRAGMA table_info(vault_items)').all().map((entry) => entry.name);
  assert.ok(sessionColumns.includes('outcome'));
  assert.ok(sessionColumns.includes('outcome_updated_at'));
  assert.ok(jobColumns.includes('source'));
  assert.ok(jobColumns.includes('location'));
  assert.ok(jobColumns.includes('capture_meta'));
  assert.ok(vaultColumns.includes('section_hint'));
}

function testCoverLetterTemplate() {
  const rendered = renderCoverLetterTemplate({
    job: {
      company: 'Acme Analytics',
      title: 'Backend Engineer',
      location: 'Remote',
    },
    settings: {
      sender_name: 'Jane Doe',
      sender_email: 'jane@example.com',
      signature_image_path: 'C:/signatures/jane.png',
    },
    payload: {
      body_latex: [
        'I build backend systems that turn analytics requirements into production workflows.',
        'My recent work focused on improving data quality and delivery speed for internal stakeholders.',
      ],
      closing: 'Best regards,',
    },
  });

  assert.ok(rendered.text.includes('Dear Hiring Manager,'));
  assert.ok(rendered.text.includes('Jane Doe'));
  assert.ok(rendered.latex.includes('Application for Backend Engineer - Acme Analytics'));
  assert.ok(rendered.latex.includes('\\includegraphics[height=1.2cm]{C:/signatures/jane.png}'));

  const uploadedSignature = renderCoverLetterTemplate({
    job: { company: 'Acme Analytics', title: 'Backend Engineer' },
    settings: {
      sender_name: 'Jane Doe',
      signature_image_name: 'jane-signature.png',
      signature_image_data_url: 'data:image/png;base64,AA==',
    },
    payload: {
      body_latex: ['\\textbf{Selected impact:} Improved delivery reliability for analytics stakeholders.'],
      closing: 'Best regards,',
    },
  });

  assert.ok(uploadedSignature.latex.includes('\\includegraphics[height=1.2cm]{jane-signature.png}'));
  assert.strictEqual(uploadedSignature.assets.length, 1);
  assert.strictEqual(uploadedSignature.assets[0].filename, 'jane-signature.png');
}

function testInterviewPrepPromptResearchContext() {
  const prompt = prompts.INTERVIEW_PREP_USER(
    { company: 'Acme Analytics', title: 'Backend Engineer' },
    '\\section*{Experience}',
    { overall_score: 78 },
    '# Culture\nLean teams\n\n## Interview Style\nSystem design plus behavioral depth.'
  );

  assert.ok(prompt.includes('<company_research_report>'));
  assert.ok(prompt.includes('System design plus behavioral depth.'));
}

function testOpenRouterRequestShape() {
  const built = buildChatRequest('sk-or-test-key', 'Return JSON', 'Return {"ok":true}', {
    model: 'openrouter/free',
    maxTokens: 64,
  }, { jsonMode: true });

  assert.strictEqual(built.requestMeta.provider, 'openrouter');
  assert.strictEqual(built.requestOptions.model, 'openrouter/free');
  assert.deepStrictEqual(built.requestOptions.provider, {
    sort: 'latency',
    require_parameters: true,
    allow_fallbacks: true,
  });
  assert.deepStrictEqual(built.requestOptions.plugins, [{ id: 'response-healing' }]);
  assert.strictEqual(built.requestOptions.reasoning, undefined);
  assert.strictEqual(built.requestMeta.reasoningDisabled, false);
  assert.ok(built.requestOptions.max_tokens >= 1200);
  assert.deepStrictEqual(built.requestOptions.response_format, { type: 'json_object' });
}

function testOpenAIRouterMismatchGuard() {
  assert.throws(() => {
    buildChatRequest('sk-test-key', 'System', 'User', { model: 'openrouter/free' }, { jsonMode: true });
  }, /OpenRouter models require an OpenRouter API key/);
}

function testOpenRouterRequestVariants() {
  const variants = buildRequestVariants(
    'sk-or-test-key',
    'Return JSON',
    'Return {"ok":true}',
    {
      model: 'openrouter/free',
      maxTokens: 64,
      disableReasoning: true,
    },
    { jsonMode: true }
  );

  assert.ok(variants.length >= 4);
  assert.ok(variants.some((variant) => !variant.requestOptions.reasoning));
  assert.ok(variants.some((variant) => !variant.requestOptions.plugins));
  assert.ok(variants.some((variant) => !variant.requestOptions.response_format));
  assert.ok(variants.some((variant) => !variant.requestOptions.provider));
}

function testCapturedJobNormalization() {
  const normalized = normalizeCapturedJobPayload({
    title: 'Machine Learning Engineer',
    company: 'Example AI',
    location: 'Riyadh',
    sourceUrl: 'https://www.linkedin.com/jobs/view/123',
    site: 'linkedin',
    jobInfo: 'Machine Learning Engineer\nExample AI\nRiyadh\nBuild and deploy applied ML systems with Python and PyTorch.',
  });

  assert.strictEqual(normalized.source, 'linkedin');
  assert.strictEqual(normalized.location, 'Riyadh');
  assert.ok(normalized.description.includes('Build and deploy applied ML systems'));
  const meta = JSON.parse(normalized.capture_meta);
  assert.ok(meta.jobInfo.includes('Machine Learning Engineer'));
}

async function testBridgeStatusRoute() {
  const started = await startServer(0);
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/bridge/status`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.runtime === 'server' || body.runtime === 'desktop');
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'apiKeyConfigured'));
    assert.strictEqual(body.capabilities.compileWasmPreview, true);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

async function testJobImportRoute() {
  const started = await startServer(0);
  const baseUrl = `http://127.0.0.1:${started.port}`;
  let importedId = 0;

  try {
    const payload = {
      title: 'Extension Integration Engineer',
      company: 'CV Customizer QA',
      sourceUrl: `https://example.com/jobs/${Date.now()}`,
      site: 'linkedin',
      jobInfo: 'Extension Integration Engineer\nCV Customizer QA\nRemote\nOwn the browser-to-app intake flow and maintain grounded captured job payloads.',
    };

    const createdResponse = await fetch(`${baseUrl}/api/jobs/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(createdResponse.status, 201);
    const createdBody = await createdResponse.json();
    importedId = createdBody.id;
    assert.strictEqual(createdBody.created, true);
    assert.strictEqual(createdBody.job.source, 'linkedin');
    assert.ok(createdBody.job.description.includes('browser-to-app intake flow'));

    const updatedResponse = await fetch(`${baseUrl}/api/jobs/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, jobInfo: payload.jobInfo + '\nUpdated source detail for dedupe check.' }),
    });
    assert.strictEqual(updatedResponse.status, 200);
    const updatedBody = await updatedResponse.json();
    assert.strictEqual(updatedBody.created, false);
    assert.strictEqual(updatedBody.id, importedId);

    const jobsResponse = await fetch(`${baseUrl}/api/jobs`);
    assert.strictEqual(jobsResponse.status, 200);
    const jobs = await jobsResponse.json();
    const importedJob = jobs.find((job) => Number(job.id) === Number(importedId));
    assert.ok(importedJob);
    assert.strictEqual(importedJob.source, 'linkedin');
    assert.ok(importedJob.description.includes('Updated source detail for dedupe check.'));
  } finally {
    if (importedId) {
      db.jobs.delete(importedId);
    }
    await new Promise((resolve) => started.server.close(resolve));
  }
}

async function testAtsAnalyzeRoute() {
  const started = await startServer(0);
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/ats/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latex: '\\section*{Experience}\n\\begin{itemize}\n\\item Built React dashboards with Python and SQL.\n\\end{itemize}',
        parsed_req: {
          required_skills: ['React', 'Python'],
          preferred_skills: ['AWS'],
          responsibilities: ['build dashboards'],
          keyword_taxonomy: {
            hard_skills: ['SQL'],
            tools: ['Python'],
            certifications: [],
            domain_knowledge: ['analytics'],
          },
        },
        stories: [
          { tag: 'cloud', text: 'Supported AWS analytics deployments for internal dashboards.' },
        ],
      }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.ok(body.metrics);
    assert.ok(body.alignment);
    assert.ok(Array.isArray(body.alignment.priority_gaps));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

async function testVaultSectionHintRoute() {
  const started = await startServer(0);
  const baseUrl = `http://127.0.0.1:${started.port}`;
  let profileId = 0;
  let vaultId = 0;

  try {
    const profileResponse = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke Test Profile',
        latex: '\\section*{Projects}\n\\section*{Experience}\n\\section*{Skills}',
        stories: '[]',
      }),
    });
    assert.strictEqual(profileResponse.status, 201);
    profileId = Number((await profileResponse.json()).id);

    const createResponse = await fetch(`${baseUrl}/api/vault-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        title: 'Project Launch',
        tag: 'project',
        section_hint: 'projects',
        status: 'verified',
        text: 'Shipped a production internal platform with measurable adoption.',
        preferred_bullet: 'Shipped a production internal platform adopted across 4 teams.',
      }),
    });
    assert.strictEqual(createResponse.status, 201);
    vaultId = Number((await createResponse.json()).id);

    const vaultResponse = await fetch(`${baseUrl}/api/vault-items/${vaultId}`);
    assert.strictEqual(vaultResponse.status, 200);
    const createdVault = await vaultResponse.json();
    assert.strictEqual(createdVault.section_hint, 'projects');

    const updateResponse = await fetch(`${baseUrl}/api/vault-items/${vaultId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        section_hint: 'experience',
      }),
    });
    assert.strictEqual(updateResponse.status, 200);

    const updatedResponse = await fetch(`${baseUrl}/api/vault-items/${vaultId}`);
    assert.strictEqual(updatedResponse.status, 200);
    const updatedVault = await updatedResponse.json();
    assert.strictEqual(updatedVault.section_hint, 'experience');
  } finally {
    if (vaultId) db.vaultItems.delete(vaultId);
    if (profileId) db.profiles.delete(profileId);
    await new Promise((resolve) => started.server.close(resolve));
  }
}

async function testExtensionBridgeAgainstLiveServer() {
  const started = await startServer(0);
  const baseUrl = `http://127.0.0.1:${started.port}`;
  let importedId = 0;

  try {
    appBridge.resetCache();
    const result = await appBridge.importJob({
      title: 'Bridge Verified Role',
      company: 'CV Customizer QA',
      sourceUrl: `https://example.com/bridge/${Date.now()}`,
      site: 'linkedin',
      jobInfo: 'Bridge Verified Role\nCV Customizer QA\nRemote\nVerify that the extension bridge can import directly into the live app.',
    }, (url, options) => {
      const forwarded = String(url || '')
        .replace('http://127.0.0.1:3001', baseUrl)
        .replace('http://localhost:3001', baseUrl)
        .replace('http://127.0.0.1:3210', baseUrl)
        .replace('http://localhost:3210', baseUrl)
        .replace('http://127.0.0.1:3000', baseUrl)
        .replace('http://localhost:3000', baseUrl);
      return fetch(forwarded, options);
    });

    importedId = Number(result.id);
    assert.ok(importedId > 0);

    const jobsResponse = await fetch(`${baseUrl}/api/jobs`);
    assert.strictEqual(jobsResponse.status, 200);
    const jobs = await jobsResponse.json();
    const importedJob = jobs.find((job) => Number(job.id) === importedId);
    assert.ok(importedJob);
    assert.match(importedJob.description, /extension bridge can import directly/i);
  } finally {
    if (importedId) db.jobs.delete(importedId);
    await new Promise((resolve) => started.server.close(resolve));
  }
}

async function testCompileRouteWhenAvailable() {
  const available = await checkPdflatex();
  if (!available) return;

  const started = await startServer(0);
  const baseUrl = `http://127.0.0.1:${started.port}`;
  const latex = String.raw`\documentclass{article}
\begin{document}
Hello CV Customizer
\end{document}`;

  try {
    const response = await fetch(`${baseUrl}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latex }),
    });
    assert.strictEqual(response.status, 200);
    const contentType = response.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/pdf'));
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.length > 100);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

async function main() {
  testResumeIntelligence();
  testDatabaseColumns();
  testCoverLetterTemplate();
  testInterviewPrepPromptResearchContext();
  testOpenRouterRequestShape();
  testOpenRouterRequestVariants();
  testOpenAIRouterMismatchGuard();
  testCapturedJobNormalization();
  await testBridgeStatusRoute();
  await testJobImportRoute();
  await testAtsAnalyzeRoute();
  await testVaultSectionHintRoute();
  await testExtensionBridgeAgainstLiveServer();
  await testCompileRouteWhenAvailable();
  console.log('Smoke tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
