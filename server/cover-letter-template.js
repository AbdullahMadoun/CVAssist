const fs = require('fs');
const path = require('path');
const { resolveServerAsset } = require('./runtime-paths');

const TEMPLATE_CANDIDATES = [
  resolveServerAsset('cover-letter-template.tex'),
  path.join(__dirname, '..', 'cover_letter_example.tex'),
];

const DEFAULT_COVER_LETTER_SETTINGS = {
  sender_name: 'Abdullah Madoun',
  sender_email: 'a-madoun@hotmail.com',
  sender_phone: '+966 542 614 583',
  sender_linkedin_url: 'https://www.linkedin.com/in/abdullah-madoun',
  sender_linkedin_label: 'Abdullah Madoun',
  sender_location: 'Riyadh, KSA',
  recipient_name: 'Hiring Manager',
  recipient_location: '',
  signature_image_path: '',
  signature_image_name: '',
  signature_image_data_url: '',
  closing: 'Best regards,',
};

let templateCache = '';
let resolvedTemplatePath = '';

function getTemplatePath() {
  if (resolvedTemplatePath && fs.existsSync(resolvedTemplatePath)) {
    return resolvedTemplatePath;
  }

  resolvedTemplatePath = TEMPLATE_CANDIDATES.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || '';

  if (!resolvedTemplatePath) {
    throw new Error(`Cover letter template not found. Checked: ${TEMPLATE_CANDIDATES.join(', ')}`);
  }

  return resolvedTemplatePath;
}

function loadTemplate() {
  if (!templateCache) {
    templateCache = fs.readFileSync(getTemplatePath(), 'utf8');
  }
  return templateCache;
}

function getCoverLetterTemplateForPrompt() {
  return loadTemplate();
}

function escapeLatex(value = '') {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function escapeLatexUrl(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/([%#&_{}])/g, '\\$1')
    .trim();
}

function normalizeGraphicPath(value = '') {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/');
}

/**
 * Fixes common LaTeX commands that LLMs sometimes generate without braces
 * e.g., \textbfName -> \textbf{Name}
 */
function sanitizeLatexBraces(text = '') {
  return String(text || '')
    .replace(/\\(textbf|textit|emph|underline|href)([a-zA-Z0-9]+)/g, (match, cmd, rest) => {
      // Avoid doubling braces if they are already there (though regex [a-zA-Z0-9]+ shouldn't match '{')
      return `\\${cmd}{${rest}}`;
    });
}


function sanitizeAssetFilename(value = '', fallback = 'signature-upload.png') {
  const base = path.basename(String(value || '').trim() || fallback);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return sanitized || fallback;
}

function normalizeParagraphs(payload) {
  if (Array.isArray(payload?.paragraphs)) {
    return payload.paragraphs
      .map((paragraph) => String(paragraph || '').trim())
      .filter(Boolean);
  }

  const raw = typeof payload === 'string'
    ? payload
    : String(payload?.body || payload?.text || '');

  return raw
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\r?\n/g, ' ').trim())
    .filter(Boolean);
}

function normalizeLatexParagraphs(payload) {
  if (Array.isArray(payload?.body_latex)) {
    return payload.body_latex
      .map((paragraph) => String(paragraph || '').trim())
      .filter(Boolean);
  }

  const raw = String(payload?.body_latex || '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => sanitizeLatexBraces(String(paragraph || '').trim()))
    .filter(Boolean);
}

function latexToPlainText(block = '') {
  return String(block || '')
    .replace(/\\\\/g, '\n')
    .replace(/\\(?:textbf|textit|emph|underline)\{([^}]*)\}/g, '$1')
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+(?:\[[^\]]*\])?\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCoverLetterPayload(payload) {
  const bodyLatex = normalizeLatexParagraphs(payload);
  const paragraphs = normalizeParagraphs(payload);
  return {
    paragraphs: bodyLatex.length ? bodyLatex.map((block) => latexToPlainText(block)).filter(Boolean) : paragraphs,
    body_latex: bodyLatex,
    closing: String(payload?.closing || DEFAULT_COVER_LETTER_SETTINGS.closing).trim() || DEFAULT_COVER_LETTER_SETTINGS.closing,
  };
}

function mergeSettings(settings = {}) {
  return {
    ...DEFAULT_COVER_LETTER_SETTINGS,
    ...Object.fromEntries(
      Object.entries(settings || {}).map(([key, value]) => [key, String(value ?? '').trim()])
    ),
  };
}

function buildSenderBlock(settings) {
  const lines = [
    settings.sender_name ? `\\textbf{${escapeLatex(settings.sender_name)}}` : '',
    settings.sender_email ? escapeLatex(settings.sender_email) : '',
    settings.sender_phone ? escapeLatex(settings.sender_phone) : '',
    settings.sender_linkedin_url
      ? `\\href{${escapeLatexUrl(settings.sender_linkedin_url)}}{LinkedIn: ${escapeLatex(settings.sender_linkedin_label || settings.sender_name || 'Profile')}}`
      : '',
    settings.sender_location ? escapeLatex(settings.sender_location) : '',
  ].filter(Boolean);

  return lines.map((line) => `    ${line} \\\\`).join('\n');
}

function buildRecipientBlock(job = {}, settings = {}) {
  const lines = [
    escapeLatex(settings.recipient_name || 'Hiring Manager'),
    escapeLatex(job.company || ''),
    escapeLatex(settings.recipient_location || job.location || ''),
  ].filter(Boolean);

  return lines.map((line) => `${line} \\\\`).join('\n');
}

function buildSubject(job = {}) {
  const title = escapeLatex(job.title || 'the role');
  const company = escapeLatex(job.company || '');
  return company
    ? `Application for ${title} - ${company}`
    : `Application for ${title}`;
}

function buildGreeting(settings = {}) {
  return `Dear ${escapeLatex(settings.recipient_name || 'Hiring Manager')},`;
}

function buildBodyBlocks(payload = {}) {
  const normalized = normalizeCoverLetterPayload(payload);
  if (normalized.body_latex.length) {
    return normalized.body_latex.join('\n\n');
  }
  return normalized.paragraphs
    .map((paragraph) => escapeLatex(paragraph))
    .join('\n\n');
}

function buildSignatureAsset(settings = {}) {
  const uploadedDataUrl = String(settings.signature_image_data_url || '').trim();
  if (uploadedDataUrl) {
    const filename = sanitizeAssetFilename(settings.signature_image_name || 'signature-upload.png');
    return {
      block: `\\includegraphics[height=1.2cm]{${filename}} \\\\\n`,
      assets: [{ filename, data_url: uploadedDataUrl }],
    };
  }

  const imagePath = normalizeGraphicPath(settings.signature_image_path);
  if (!imagePath) {
    return { block: '', assets: [] };
  }

  return {
    block: `\\includegraphics[height=1.2cm]{${imagePath}} \\\\\n`,
    assets: [],
  };
}

function buildPlainText(job = {}, settings = {}, payload = {}) {
  const normalized = normalizeCoverLetterPayload(payload);
  return [
    buildGreeting(settings),
    '',
    ...normalized.paragraphs,
    '',
    normalized.closing || DEFAULT_COVER_LETTER_SETTINGS.closing,
    settings.sender_name || DEFAULT_COVER_LETTER_SETTINGS.sender_name,
  ].join('\n');
}

function renderCoverLetterTemplate({ job = {}, settings = {}, payload = {} }) {
  const mergedSettings = mergeSettings(settings);
  const normalizedPayload = normalizeCoverLetterPayload(payload);
  const signatureAsset = buildSignatureAsset(mergedSettings);
  const replacements = {
    '{{sender_block}}': buildSenderBlock(mergedSettings),
    '{{letter_date}}': '\\today',
    '{{recipient_block}}': buildRecipientBlock(job, mergedSettings),
    '{{subject}}': buildSubject(job),
    '{{greeting}}': buildGreeting(mergedSettings),
    '{{body_blocks}}': buildBodyBlocks(normalizedPayload),
    '{{closing}}': escapeLatex(normalizedPayload.closing || mergedSettings.closing || DEFAULT_COVER_LETTER_SETTINGS.closing),
    '{{signature_block}}': signatureAsset.block,
    '{{typed_name}}': escapeLatex(mergedSettings.sender_name || DEFAULT_COVER_LETTER_SETTINGS.sender_name),
  };

  let latex = loadTemplate();
  Object.entries(replacements).forEach(([token, value]) => {
    latex = latex.replace(token, value);
  });

  return {
    latex,
    text: buildPlainText(job, mergedSettings, normalizedPayload),
    settings: mergedSettings,
    payload: normalizedPayload,
    assets: signatureAsset.assets,
  };
}

module.exports = {
  DEFAULT_COVER_LETTER_SETTINGS,
  getCoverLetterTemplateForPrompt,
  normalizeCoverLetterPayload,
  renderCoverLetterTemplate,
};
