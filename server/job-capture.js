function normalizeLines(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeTextBlock(value) {
  return typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').trim()
    : '';
}

function normalizeObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function buildImportedJobDescription(payload) {
  const parts = [];
  const jobInfo = normalizeTextBlock(payload.jobInfo);
  const description = normalizeTextBlock(payload.description);
  const location = String(payload.location || '').trim();
  const summary = String(payload.summary || '').trim();
  const qualifications = normalizeLines(payload.qualifications);
  const responsibilities = normalizeLines(payload.responsibilities);

  if (jobInfo) {
    parts.push(jobInfo);
  } else {
    if (summary) parts.push(summary);
    if (location) parts.push(`Location: ${location}`);
    if (qualifications.length) {
      parts.push(`Qualifications:\n${qualifications.map((line) => `- ${line}`).join('\n')}`);
    }
    if (responsibilities.length) {
      parts.push(`Responsibilities:\n${responsibilities.map((line) => `- ${line}`).join('\n')}`);
    }
  }

  if (!parts.length && description) {
    parts.push(description);
  }

  return parts.filter(Boolean).join('\n\n').trim();
}

function normalizeCapturedJobPayload(input = {}) {
  const title = String(input.title || '').trim();
  const company = String(input.company || '').trim();
  const location = String(input.location || '').trim();
  const url = String(input.sourceUrl || input.url || '').trim();
  const pageUrl = String(input.pageUrl || '').trim();
  const jobInfo = normalizeTextBlock(input.jobInfo);
  const summary = String(input.summary || '').trim();
  const qualifications = normalizeLines(input.qualifications);
  const responsibilities = normalizeLines(input.responsibilities);
  const source = String(input.site || input.source || 'manual').trim().toLowerCase() || 'manual';
  const sourceMode = String(input.sourceMode || '').trim();
  const status = String(input.status || '').trim() || 'pending';
  const confidence = Number(input.confidence || 0);
  const sourcePageTitle = String(input.sourcePageTitle || '').trim();
  const description = buildImportedJobDescription({
    jobInfo,
    description: input.description,
    location,
    summary,
    qualifications,
    responsibilities,
  });
  const sourceSignals = normalizeObject(input.sourceSignals);
  const captureMeta = normalizeObject(input.captureMeta || input.capture_meta);
  const employmentType = String(input.employmentType || '').trim();
  const workplaceType = String(input.workplaceType || '').trim();
  const salary = String(input.salary || '').trim();
  const datePosted = String(input.datePosted || '').trim();
  const validThrough = String(input.validThrough || '').trim();

  return {
    title,
    company,
    location,
    url,
    source,
    description,
    capture_meta: JSON.stringify({
      ...captureMeta,
      jobInfo,
      summary,
      qualifications,
      responsibilities,
      sourceMode,
      pageUrl,
      sourcePageTitle,
      confidence,
      status,
      sourceSignals,
      employmentType,
      workplaceType,
      salary,
      datePosted,
      validThrough,
      importedAt: new Date().toISOString(),
    }),
  };
}

module.exports = {
  buildImportedJobDescription,
  normalizeCapturedJobPayload,
  normalizeLines,
};
