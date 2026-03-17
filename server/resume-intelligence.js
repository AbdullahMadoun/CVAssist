// ===========================================================================
// Resume Intelligence - ATS Scoring Engine
// Uses the 'natural' NLP library for industry-standard stemming, TF-IDF,
// and string distance, combined with a custom synonym dictionary and
// smart matching for accurate ATS-style keyword analysis.
// ===========================================================================

const natural = require('natural');
const crypto = require('crypto');
const PorterStemmer = natural.PorterStemmer;
const JaroWinklerDistance = natural.JaroWinklerDistance;
const TfIdf = natural.TfIdf;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'with',
  'your', 'you', 'will', 'our', 'we', 'us', 'using', 'used', 'build', 'built',
]);

const ACTION_VERBS = new Set([
  'accelerated', 'architected', 'automated', 'built', 'collaborated', 'created',
  'defined', 'delivered', 'designed', 'developed', 'drove', 'enabled', 'improved',
  'implemented', 'launched', 'led', 'managed', 'optimized', 'owned', 'reduced',
  'scaled', 'shipped', 'streamlined', 'supported',
]);

const ATS_CACHE_LIMIT = 80;
const atsScoreCache = new Map();

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0));
}

function uniqueStrings(items) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function getAtsCacheKey(latex = '', parsedReq = {}) {
  return crypto
    .createHash('sha1')
    .update(String(latex || ''))
    .update('\n')
    .update(stableStringify(parsedReq || {}))
    .digest('hex');
}

function getCachedAtsScore(cacheKey) {
  const cached = atsScoreCache.get(cacheKey);
  if (!cached) return null;
  atsScoreCache.delete(cacheKey);
  atsScoreCache.set(cacheKey, cached);
  return cached;
}

function setCachedAtsScore(cacheKey, payload) {
  atsScoreCache.set(cacheKey, payload);
  while (atsScoreCache.size > ATS_CACHE_LIMIT) {
    const oldestKey = atsScoreCache.keys().next().value;
    atsScoreCache.delete(oldestKey);
  }
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\bC\+\+\b/gi, ' cpp ')
    .replace(/\bC#\b/gi, ' csharp ')
    .replace(/\.net/gi, ' dotnet ')
    .replace(/node\.js/gi, ' nodejs ')
    .replace(/next\.js/gi, ' nextjs ')
    .replace(/react\.js/gi, ' react ')
    .replace(/vue\.js/gi, ' vue ')
    .replace(/[\u2013\u2014]/g, ' ')
    .replace(/[^a-zA-Z0-9+#.%/\s-]/g, ' ')
    .replace(/[\/_.-]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Use natural's Porter Stemmer instead of hand-rolled
function porterStem(word) {
  if (!word || word.length <= 2) return word;
  try {
    return PorterStemmer.stem(word);
  } catch {
    return word;
  }
}

function canonicalToken(token) {
  const clean = String(token || '').trim().toLowerCase();
  if (!clean) return '';
  return porterStem(clean);
}

// Use natural's Jaro-Winkler for fuzzy matching (better for names/tech terms)
function jaroWinklerSimilarity(a, b) {
  try {
    return JaroWinklerDistance(String(a || ''), String(b || ''));
  } catch {
    return 0;
  }
}

// TF-IDF semantic similarity using natural's TfIdf
function tfidfSimilarity(textA, textB) {
  try {
    const tfidf = new TfIdf();
    tfidf.addDocument(normalizeText(textA));
    tfidf.addDocument(normalizeText(textB));
    // Get terms from document A and compute similarity
    const termsA = new Map();
    const termsB = new Map();
    tfidf.listTerms(0).forEach((item) => { termsA.set(item.term, item.tfidf); });
    tfidf.listTerms(1).forEach((item) => { termsB.set(item.term, item.tfidf); });
    if (!termsA.size || !termsB.size) return 0;
    let dot = 0, magA = 0, magB = 0;
    termsA.forEach((val, key) => {
      magA += val * val;
      if (termsB.has(key)) {
        dot += val * termsB.get(key);
      } else {
        // Try stemmed match
        for (const [bKey, bVal] of termsB) {
          if (porterStem(key) === porterStem(bKey) || jaroWinklerSimilarity(key, bKey) >= 0.88) {
            dot += val * bVal * 0.75;
            break;
          }
        }
      }
    });
    termsB.forEach((val) => { magB += val * val; });
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  } catch {
    return 0;
  }
}

// -- Synonym / Alias Dictionary for ATS matching ----------------------------
const SYNONYM_MAP = new Map([
  // Programming languages & variants
  ['js', 'javascript'], ['ts', 'typescript'], ['py', 'python'],
  ['cpp', 'c++'], ['csharp', 'c#'], ['golang', 'go'],
  ['nodejs', 'node.js'], ['nextjs', 'next.js'], ['reactjs', 'react'],
  ['vuejs', 'vue'], ['angularjs', 'angular'],
  ['dotnet', '.net'], ['aspnet', 'asp.net'],

  // Cloud & infrastructure
  ['aws', 'amazon web services'], ['gcp', 'google cloud platform'],
  ['azure', 'microsoft azure'], ['k8s', 'kubernetes'],
  ['tf', 'terraform'], ['iac', 'infrastructure as code'],

  // Data & ML
  ['ml', 'machine learning'], ['dl', 'deep learning'],
  ['ai', 'artificial intelligence'], ['nlp', 'natural language processing'],
  ['cv', 'computer vision'], ['llm', 'large language model'],
  ['etl', 'extract transform load'], ['sql', 'structured query language'],
  ['nosql', 'non-relational database'], ['bi', 'business intelligence'],

  // DevOps & tools
  ['ci', 'continuous integration'], ['cd', 'continuous deployment'],
  ['cicd', 'ci/cd'], ['scm', 'source control management'],
  ['vcs', 'version control'],

  // Methodologies
  ['agile', 'scrum'], ['sdlc', 'software development lifecycle'],
  ['tdd', 'test-driven development'], ['bdd', 'behavior-driven development'],
  ['oop', 'object-oriented programming'],

  // Roles & titles
  ['swe', 'software engineer'], ['sde', 'software development engineer'],
  ['pm', 'product manager'], ['em', 'engineering manager'],
  ['qa', 'quality assurance'], ['ux', 'user experience'],
  ['ui', 'user interface'], ['fe', 'frontend'], ['be', 'backend'],

  // Common pairs
  ['api', 'application programming interface'],
  ['rest', 'restful'], ['graphql', 'graph query language'],
  ['db', 'database'], ['rdbms', 'relational database'],
  ['saas', 'software as a service'], ['paas', 'platform as a service'],
]);

// Build reverse map for bidirectional lookup
const REVERSE_SYNONYM_MAP = new Map();
SYNONYM_MAP.forEach((target, alias) => {
  if (!REVERSE_SYNONYM_MAP.has(target)) REVERSE_SYNONYM_MAP.set(target, new Set());
  REVERSE_SYNONYM_MAP.get(target).add(alias);
});

function expandSynonyms(token) {
  const clean = String(token || '').trim().toLowerCase();
  if (!clean) return [clean];
  const results = new Set([clean]);
  // Direct alias → canonical
  if (SYNONYM_MAP.has(clean)) results.add(SYNONYM_MAP.get(clean));
  // Canonical → all aliases
  if (REVERSE_SYNONYM_MAP.has(clean)) {
    REVERSE_SYNONYM_MAP.get(clean).forEach((alias) => results.add(alias));
  }
  // Also check as stemmed form
  const stemmed = porterStem(clean);
  results.add(stemmed);
  return [...results];
}

// -- Smart token matching (stems + synonyms + Jaro-Winkler fuzzy) -----------
function tokenMatchesSmart(tokenA, tokenB) {
  const a = String(tokenA || '').toLowerCase();
  const b = String(tokenB || '').toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  // Stem match (using natural's Porter Stemmer)
  if (porterStem(a) === porterStem(b)) return true;
  // Synonym match
  const expandedA = expandSynonyms(a);
  const expandedB = expandSynonyms(b);
  for (const ea of expandedA) {
    for (const eb of expandedB) {
      if (ea === eb) return true;
      if (porterStem(ea) === porterStem(eb)) return true;
    }
  }
  // Jaro-Winkler fuzzy match (only for tokens >= 4 chars to avoid false positives)
  if (a.length >= 4 && b.length >= 4 && jaroWinklerSimilarity(a, b) >= 0.88) return true;
  return false;
}

function tokenize(text = '') {
  return normalizeText(text)
    .split(' ')
    .map(canonicalToken)
    .filter((token) => token && token.length > 1 && !STOPWORDS.has(token));
}

// Build an expanded token set for smarter matching
function buildSmartTokenSet(text = '') {
  const raw = normalizeText(text).split(' ').filter(Boolean);
  const result = new Set();
  for (const token of raw) {
    if (token.length <= 1 || STOPWORDS.has(token)) continue;
    const stemmed = canonicalToken(token);
    result.add(stemmed);
    result.add(token);
    expandSynonyms(token).forEach((syn) => {
      result.add(syn);
      result.add(porterStem(syn));
    });
  }
  return result;
}

function stripLatex(latex = '') {
  return String(latex)
    .replace(/%.*$/gm, '')
    .replace(/\\\\/g, '\n')
    .replace(/\\item\b/g, '\n• ')
    .replace(/\\(?:section|subsection|subsubsection)\*?\{([^}]*)\}/g, '\n$1\n')
    .replace(/\\(?:textbf|textit|emph|underline|href)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+(?:\[[^\]]*\])?\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/~/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function buildSourceCorpus(latex, stories = []) {
  const storyText = (stories || [])
    .map((story) => `${story?.tag || ''} ${story?.text || ''}`.trim())
    .filter(Boolean)
    .join('\n');

  return {
    sourceText: [stripLatex(latex), storyText].filter(Boolean).join('\n'),
    storyText,
  };
}

function extractSections(latex = '') {
  const sections = [];
  const regex = /\\section\*?\{([^}]*)\}/g;
  let match;
  while ((match = regex.exec(String(latex)))) {
    sections.push(String(match[1] || '').trim().toLowerCase());
  }
  return sections;
}

function extractSectionBlocks(latex = '') {
  const source = String(latex || '');
  const matches = [...source.matchAll(/\\section\*?\{([^}]*)\}/g)];
  if (!matches.length) {
    return [{ name: 'General', latex: source }];
  }

  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index || source.length) : source.length;
    return {
      name: String(match[1] || 'General').trim(),
      latex: source.slice(start, end),
    };
  });
}

function extractBullets(latex = '') {
  const plain = stripLatex(latex);
  const lines = plain
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const bullets = lines
    .filter((line) => line.startsWith('•') || line.startsWith('-'))
    .map((line) => line.replace(/^[•-]\s*/, '').trim())
    .filter(Boolean);

  return bullets.length ? bullets : lines;
}

function extractNumbers(text = '') {
  return new Set(String(text).match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
}

function phraseAppears(haystack = '', phrase = '') {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  // Exact substring match
  if (normalizedHaystack.includes(normalizedPhrase)) return true;
  // Smart token matching: every token in the phrase must match at least one in the haystack
  const phraseTokens = normalizedPhrase.split(' ').filter(Boolean);
  const haystackSmartSet = buildSmartTokenSet(haystack);
  const haystackRawTokens = normalizeText(haystack).split(' ').filter(Boolean);
  return phraseTokens.length > 0 && phraseTokens.every((pt) => {
    // Check stemmed/synonym set first
    if (haystackSmartSet.has(pt) || haystackSmartSet.has(porterStem(pt))) return true;
    // Then check synonym expansion
    for (const syn of expandSynonyms(pt)) {
      if (haystackSmartSet.has(syn) || haystackSmartSet.has(porterStem(syn))) return true;
    }
    // Finally fuzzy match against raw tokens
    return haystackRawTokens.some((ht) => tokenMatchesSmart(pt, ht));
  });
}

function phraseCoverage(phrase, tokenSet) {
  const tokens = tokenize(phrase);
  if (!tokens.length) return 0;
  // Use smart matching: each phrase token can match via stem, synonym, or fuzzy
  const matched = tokens.filter((token) => {
    if (tokenSet.has(token)) return true;
    // Check synonym expansions
    for (const syn of expandSynonyms(token)) {
      if (tokenSet.has(syn) || tokenSet.has(porterStem(syn))) return true;
    }
    // Fuzzy match against set entries
    for (const setEntry of tokenSet) {
      if (tokenMatchesSmart(token, setEntry)) return true;
    }
    return false;
  }).length;
  return matched / tokens.length;
}

function cosineSimilarity(textA = '', textB = '') {
  // Use natural's TF-IDF for proper semantic similarity
  return tfidfSimilarity(textA, textB);
}

function tokenOverlap(textA = '', textB = '') {
  const a = buildSmartTokenSet(textA);
  const b = buildSmartTokenSet(textB);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((token) => {
    if (b.has(token)) {
      shared += 1;
    } else {
      // Try smart matching
      for (const bToken of b) {
        if (tokenMatchesSmart(token, bToken)) {
          shared += 0.7;
          break;
        }
      }
    }
  });
  return shared / Math.max(Math.min(a.size, b.size), 1);
}

function upsertWeightedRequirement(map, phrases = [], weight = 0, bucket = 'preferred') {
  (phrases || []).forEach((phrase) => {
    const clean = String(phrase || '').trim();
    if (!clean) return;

    const existing = map.get(clean);
    if (!existing) {
      map.set(clean, { phrase: clean, weight, bucket });
      return;
    }

    existing.weight = Math.max(Number(existing.weight || 0), Number(weight || 0));
    if (bucket === 'critical' || existing.bucket !== 'critical') {
      existing.bucket = bucket;
    }
  });
}

function requirementBuckets(parsedReq = {}) {
  const taxonomy = parsedReq.keyword_taxonomy || {};
  const weighted = new Map();

  upsertWeightedRequirement(weighted, parsedReq.required_skills, 1.0, 'critical');
  upsertWeightedRequirement(weighted, taxonomy.hard_skills, 0.95, 'critical');
  upsertWeightedRequirement(weighted, taxonomy.tools, 0.9, 'critical');
  upsertWeightedRequirement(weighted, taxonomy.certifications, 0.85, 'critical');
  upsertWeightedRequirement(weighted, parsedReq.responsibilities, 0.8, 'critical');
  upsertWeightedRequirement(weighted, parsedReq.title ? [parsedReq.title] : [], 0.78, 'critical');
  upsertWeightedRequirement(weighted, parsedReq.education ? [parsedReq.education] : [], 0.55, 'critical');
  upsertWeightedRequirement(weighted, parsedReq.experience_years ? [parsedReq.experience_years] : [], 0.5, 'critical');

  upsertWeightedRequirement(weighted, parsedReq.preferred_skills, 0.45, 'preferred');
  upsertWeightedRequirement(weighted, parsedReq.industry_keywords, 0.5, 'preferred');
  upsertWeightedRequirement(weighted, taxonomy.domain_knowledge, 0.45, 'preferred');
  upsertWeightedRequirement(weighted, parsedReq.soft_skills, 0.3, 'preferred');
  upsertWeightedRequirement(weighted, parsedReq.culture_signals, 0.2, 'preferred');

  const entries = [...weighted.values()].sort((a, b) =>
    Number(b.weight || 0) - Number(a.weight || 0) || String(a.phrase).localeCompare(String(b.phrase))
  );
  const critical = entries.filter((entry) => entry.bucket === 'critical').map((entry) => entry.phrase);
  const preferred = entries.filter((entry) => entry.bucket !== 'critical').map((entry) => entry.phrase);

  return {
    critical,
    preferred,
    all: uniqueStrings([...critical, ...preferred]),
    weighted: entries,
  };
}

function analyzeKeywordCoverage(parsedReq = {}, text = '') {
  const buckets = requirementBuckets(parsedReq);
  const tokenSet = new Set(tokenize(text));
  const inspect = (entries) => entries.map((entry) => {
    const phrase = typeof entry === 'string' ? entry : entry?.phrase;
    const exact = phraseAppears(text, phrase);
    const coverage = phraseCoverage(phrase, tokenSet);
    return {
      phrase,
      weight: Number(entry?.weight || 1),
      bucket: entry?.bucket || 'preferred',
      exact,
      coverage,
      matched: exact || coverage >= 0.6,
    };
  });

  const weightedEntries = Array.isArray(buckets.weighted) && buckets.weighted.length
    ? buckets.weighted
    : buckets.all.map((phrase) => ({ phrase, weight: 1, bucket: 'preferred' }));
  const critical = inspect(weightedEntries.filter((entry) => entry.bucket === 'critical'));
  const preferred = inspect(weightedEntries.filter((entry) => entry.bucket !== 'critical'));
  const all = inspect(weightedEntries);

  const averageCoverage = (items) => {
    if (!items.length) return 0;
    return items.reduce((sum, item) => sum + item.coverage, 0) / items.length;
  };

  const weightedAverage = (items, field, fallback = 0) => {
    if (!items.length) return fallback;
    const totalWeight = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
    if (!totalWeight) return fallback;
    return items.reduce((sum, item) => sum + (Number(item.weight || 0) * Number(item[field] || 0)), 0) / totalWeight;
  };

  return {
    matched_critical: critical.filter((item) => item.matched).map((item) => item.phrase),
    missing_critical: critical.filter((item) => !item.matched).map((item) => item.phrase),
    matched_preferred: preferred.filter((item) => item.matched).map((item) => item.phrase),
    missing_preferred: preferred.filter((item) => !item.matched).map((item) => item.phrase),
    critical_keyword_match: round((critical.filter((item) => item.matched).length / Math.max(critical.length, 1)) * 100),
    preferred_keyword_match: round((preferred.filter((item) => item.matched).length / Math.max(preferred.length, 1)) * 100),
    weighted_keyword_score: round(weightedAverage(all, 'matched', 0) * 100),
    semantic_keyword_coverage: round(averageCoverage(all) * 100),
  };
}

function computeSectionCompleteness(latex = '') {
  const sections = extractSections(latex);
  const expected = ['summary', 'experience', 'education', 'skills'];
  const present = expected.filter((name) => sections.some((section) => section.includes(name)));
  return round((present.length / expected.length) * 100);
}

function computeQuantifiedImpact(latex = '') {
  const bullets = extractBullets(latex);
  if (!bullets.length) return 0;
  const quantified = bullets.filter((bullet) => /\b\d+(?:[.,]\d+)?%?\b/.test(bullet)).length;
  return round((quantified / bullets.length) * 100);
}

function computeRecruiterReadability(latex = '') {
  const bullets = extractBullets(latex);
  if (!bullets.length) return 0;

  const lengths = bullets.map((bullet) => tokenize(bullet).length).filter(Boolean);
  const conciseShare = lengths.length
    ? lengths.filter((count) => count >= 8 && count <= 32).length / lengths.length
    : 0;
  const quantifiedShare = bullets.filter((bullet) => /\b\d+(?:[.,]\d+)?%?\b/.test(bullet)).length / bullets.length;
  const actionShare = bullets.filter((bullet) => {
    const first = canonicalToken(tokenize(bullet)[0] || '');
    return ACTION_VERBS.has(first);
  }).length / bullets.length;
  const longPenalty = lengths.length
    ? lengths.filter((count) => count > 38).length / lengths.length
    : 0;
  const tooShortPenalty = lengths.length
    ? lengths.filter((count) => count < 5).length / lengths.length
    : 0;

  const score = 20 + (conciseShare * 30) + (quantifiedShare * 20) + (actionShare * 25) - (longPenalty * 20) - (tooShortPenalty * 10);
  return clamp(round(score));
}

function extractResumeLeadText(latex = '') {
  const plain = stripLatex(latex);
  return plain
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .join(' ');
}

function computeTitleAlignment(latex = '', parsedReq = {}) {
  const title = String(parsedReq.title || '').trim();
  const seniority = String(parsedReq.seniority || '').trim().toLowerCase();
  const hasTitle = Boolean(title);
  const hasSeniority = Boolean(seniority && seniority !== 'unknown');
  if (!hasTitle && !hasSeniority) return null;

  const leadText = extractResumeLeadText(latex);
  const fullText = stripLatex(latex);
  const components = [];

  if (hasTitle) {
    const exactLead = phraseAppears(leadText, title);
    const exactFull = phraseAppears(fullText, title);
    const coverage = Math.max(
      phraseCoverage(title, new Set(tokenize(leadText))),
      phraseCoverage(title, new Set(tokenize(fullText))),
      tokenOverlap(leadText, title)
    );
    const similarity = Math.max(
      cosineSimilarity(leadText, title),
      cosineSimilarity(fullText.slice(0, 600), title)
    );
    const titleScore = exactLead
      ? 100
      : exactFull
        ? 92
        : clamp(round(Math.max(coverage, similarity) * 100));
    components.push({ score: titleScore, weight: 0.82 });
  }

  if (hasSeniority) {
    const senioritySignals = {
      entry: ['junior', 'associate', 'intern', 'entry'],
      mid: ['mid', 'intermediate'],
      senior: ['senior', 'sr', 'staff'],
      lead: ['lead', 'principal', 'head', 'manager'],
    };
    const signals = senioritySignals[seniority] || [];
    const found = signals.some((signal) => phraseAppears(leadText, signal) || phraseAppears(fullText, signal));
    components.push({ score: found ? 100 : 45, weight: 0.18 });
  }

  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0) || 1;
  const weightedScore = components.reduce((sum, item) => sum + (item.score * item.weight), 0) / totalWeight;
  return clamp(round(weightedScore));
}

function countPhraseOccurrences(text = '', phrase = '') {
  const normalizedText = normalizeText(text);
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedText || !normalizedPhrase) return 0;

  let count = 0;
  let offset = 0;
  while (offset < normalizedText.length) {
    const found = normalizedText.indexOf(normalizedPhrase, offset);
    if (found === -1) break;
    count += 1;
    offset = found + normalizedPhrase.length;
  }
  return count;
}

function computeKeywordBalance(latex = '', parsedReq = {}) {
  const buckets = requirementBuckets(parsedReq);
  const weightedTargets = (buckets.weighted || []).slice(0, 12);
  if (!weightedTargets.length) return 70;

  const bullets = extractBullets(latex);
  if (!bullets.length) return 70;

  const plain = stripLatex(latex);
  const matchedTargets = weightedTargets
    .map((entry) => {
      const bulletHits = bullets.filter((bullet) => phraseAppears(bullet, entry.phrase)).length;
      if (!bulletHits) return null;

      const occurrences = Math.max(
        bulletHits,
        countPhraseOccurrences(plain, entry.phrase)
      );
      return {
        ...entry,
        bulletHits,
        occurrences,
      };
    })
    .filter(Boolean);

  if (!matchedTargets.length) return 70;

  const totalWeight = matchedTargets.reduce((sum, entry) => sum + Number(entry.weight || 0), 0) || 1;
  const dispersion = matchedTargets.reduce((sum, entry) => (
    sum + (Number(entry.weight || 0) * Math.min(1, entry.bulletHits / 2))
  ), 0) / totalWeight;

  const stuffingPenalty = matchedTargets.reduce((sum, entry) => {
    const softCap = Math.max(2, entry.bulletHits + 1);
    const overflow = Math.max(0, Number(entry.occurrences || 0) - softCap);
    return sum + (Number(entry.weight || 0) * Math.min(1, overflow / 3));
  }, 0) / totalWeight;

  return clamp(round(
    55 +
    (dispersion * 35) -
    (stuffingPenalty * 30)
  ));
}

function buildDocumentCorpus(latex = '') {
  const bullets = extractBullets(latex);
  const lines = stripLatex(latex)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const docs = (bullets.length ? bullets : lines).filter(Boolean);
  return docs.length ? docs : [stripLatex(latex)].filter(Boolean);
}

function bm25TokenFrequency(tokens = [], queryToken = '') {
  return tokens.reduce((count, token) => count + (tokenMatchesSmart(token, queryToken) ? 1 : 0), 0);
}

function bm25DocumentFrequency(docTokens = [], queryToken = '') {
  return docTokens.reduce((count, tokens) => (
    count + (tokens.some((token) => tokenMatchesSmart(token, queryToken)) ? 1 : 0)
  ), 0);
}

function computeBm25RequirementScore(latex = '', parsedReq = {}) {
  const corpus = buildDocumentCorpus(latex);
  const docTokens = corpus
    .map((doc) => tokenize(doc))
    .filter((tokens) => tokens.length > 0);
  if (!docTokens.length) return 0;

  const avgDocLength = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docTokens.length;
  const k1 = 1.2;
  const b = 0.75;
  const weightedRequirements = (requirementBuckets(parsedReq).weighted || []).slice(0, 18);
  if (!weightedRequirements.length) return 0;

  const totalWeight = weightedRequirements.reduce((sum, entry) => sum + Number(entry.weight || 0), 0) || 1;
  const weightedScore = weightedRequirements.reduce((sum, entry) => {
    const queryTokens = uniqueStrings(tokenize(entry.phrase));
    if (!queryTokens.length) return sum;

    const bestDocScore = docTokens.reduce((best, tokens, docIndex) => {
      const docLength = tokens.length || 1;
      const score = queryTokens.reduce((docScore, queryToken) => {
        const tf = bm25TokenFrequency(tokens, queryToken);
        if (!tf) return docScore;
        const df = bm25DocumentFrequency(docTokens, queryToken);
        const idf = Math.log(1 + ((docTokens.length - df + 0.5) / (df + 0.5)));
        const norm = tf + k1 * (1 - b + (b * (docLength / Math.max(avgDocLength, 1))));
        return docScore + (idf * ((tf * (k1 + 1)) / Math.max(norm, 1e-9)));
      }, 0);
      const exactBoost = phraseAppears(corpus[docIndex], entry.phrase) ? 0.35 : 0;
      return Math.max(best, score + exactBoost);
    }, 0);

    const normalized = clamp(round((1 - Math.exp(-(bestDocScore / Math.max(queryTokens.length, 1)))) * 100));
    return sum + (normalized * Number(entry.weight || 0));
  }, 0);

  return clamp(round(weightedScore / totalWeight));
}

function inferRoleFamilies(parsedReq = {}) {
  const text = normalizeText([
    parsedReq.title,
    ...(parsedReq.required_skills || []),
    ...(parsedReq.preferred_skills || []),
    ...(parsedReq.industry_keywords || []),
    ...(parsedReq.responsibilities || []),
    ...((parsedReq.keyword_taxonomy || {}).hard_skills || []),
    ...((parsedReq.keyword_taxonomy || {}).tools || []),
    ...((parsedReq.keyword_taxonomy || {}).domain_knowledge || []),
  ].filter(Boolean).join(' '));

  const families = [
    { name: 'frontend', signals: ['frontend', 'front end', 'react', 'vue', 'angular', 'javascript', 'typescript', 'css', 'html', 'ui', 'web'] },
    { name: 'backend', signals: ['backend', 'back end', 'api', 'microservice', 'node', 'java', 'spring', 'dotnet', 'go', 'database', 'distributed'] },
    { name: 'data', signals: ['data', 'analytics', 'dashboard', 'sql', 'etl', 'warehouse', 'dbt', 'airflow', 'tableau', 'power bi', 'reporting'] },
    { name: 'ml', signals: ['machine learning', 'artificial intelligence', 'ml', 'ai', 'nlp', 'tensorflow', 'pytorch', 'llm'] },
    { name: 'devops', signals: ['devops', 'platform', 'sre', 'infrastructure', 'kubernetes', 'docker', 'terraform', 'aws', 'gcp', 'azure', 'ci cd'] },
    { name: 'mobile', signals: ['mobile', 'ios', 'android', 'swift', 'kotlin', 'react native', 'flutter'] },
  ];

  return families
    .map((family) => ({
      name: family.name,
      score: family.signals.reduce((sum, signal) => sum + (text.includes(normalizeText(signal)) ? 1 : 0), 0),
      signals: family.signals,
    }))
    .filter((family) => family.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

function computeRoleFamilyScore(latex = '', parsedReq = {}) {
  const targetFamilies = inferRoleFamilies(parsedReq);
  if (!targetFamilies.length) return null;

  const leadText = extractResumeLeadText(latex);
  const fullText = stripLatex(latex);
  const roleScore = targetFamilies.reduce((sum, family) => {
    const familyWeight = family.score / targetFamilies.reduce((total, item) => total + item.score, 0);
    const leadHits = family.signals.filter((signal) => phraseAppears(leadText, signal)).length;
    const fullHits = family.signals.filter((signal) => phraseAppears(fullText, signal)).length;
    const bestSignalCount = family.signals.length || 1;
    const leadCoverage = leadHits / Math.max(1, Math.min(bestSignalCount, 4));
    const fullCoverage = fullHits / Math.max(1, Math.min(bestSignalCount, 6));
    const familyScore = clamp(round((leadCoverage * 65 + fullCoverage * 35) * 100 / 100));
    return sum + (familyScore * familyWeight);
  }, 0);

  return clamp(round(roleScore));
}

function computeAtsScore(latex, parsedReq) {
  const cacheKey = getAtsCacheKey(latex, parsedReq);
  const cached = getCachedAtsScore(cacheKey);
  if (cached) return cached;

  const coverage = analyzeKeywordCoverage(parsedReq, stripLatex(latex));
  const sectionCompleteness = computeSectionCompleteness(latex);
  const quantifiedImpact = computeQuantifiedImpact(latex);
  const recruiterReadabilityScore = computeRecruiterReadability(latex);
  const titleAlignmentScore = computeTitleAlignment(latex, parsedReq);
  const roleFamilyScore = computeRoleFamilyScore(latex, parsedReq);
  const keywordBalanceScore = computeKeywordBalance(latex, parsedReq);
  const bm25RequirementScore = computeBm25RequirementScore(latex, parsedReq);
  const scoreComponents = [
    { score: coverage.critical_keyword_match, weight: 0.24 },
    { score: coverage.weighted_keyword_score, weight: 0.15 },
    { score: bm25RequirementScore, weight: 0.15 },
    { score: coverage.preferred_keyword_match, weight: 0.08 },
    { score: coverage.semantic_keyword_coverage, weight: 0.10 },
    { score: sectionCompleteness, weight: 0.08 },
    { score: quantifiedImpact, weight: 0.08 },
    { score: recruiterReadabilityScore, weight: 0.06 },
    { score: keywordBalanceScore, weight: 0.06 },
  ];
  if (titleAlignmentScore != null) {
    scoreComponents.push({ score: titleAlignmentScore, weight: 0.10 });
  }
  if (roleFamilyScore != null) {
    scoreComponents.push({ score: roleFamilyScore, weight: 0.08 });
  }
  const totalWeight = scoreComponents.reduce((sum, item) => sum + item.weight, 0) || 1;
  const atsScore = clamp(round(
    scoreComponents.reduce((sum, item) => sum + (item.score * item.weight), 0) / totalWeight
  ));

  const result = {
    ats_score: atsScore,
    recruiter_readability_score: recruiterReadabilityScore,
    section_completeness: sectionCompleteness,
    quantified_impact: quantifiedImpact,
    title_alignment_score: titleAlignmentScore,
    role_family_score: roleFamilyScore,
    keyword_balance_score: keywordBalanceScore,
    bm25_requirement_score: bm25RequirementScore,
    ...coverage,
  };
  setCachedAtsScore(cacheKey, result);
  return result;
}

function buildStorySuggestions(parsedReq = {}, stories = [], limit = 3) {
  const buckets = requirementBuckets(parsedReq);
  const targetPhrases = [...buckets.critical, ...buckets.preferred];

  return (stories || [])
    .map((story, index) => {
      const storyText = `${story?.tag || ''} ${story?.text || ''}`.trim();
      const matched = targetPhrases.filter((phrase) => phraseAppears(storyText, phrase));
      return {
        story_index: index + 1,
        story_tag: story?.tag || 'general',
        target_section: matched.length ? 'Experience' : 'Projects',
        action: matched.length ? 'weave' : 'add',
        swap_target: '',
        rationale: matched.length
          ? `Supports ${matched.slice(0, 3).join(', ')} with verified experience from your corpus.`
          : 'Potentially useful supporting evidence if you need a stronger, truthful example.',
        importance: matched.length >= 2 ? 'critical' : (matched.length ? 'recommended' : 'optional'),
        draft_bullet: story?.text || '',
        _score: matched.length,
      };
    })
    .filter((entry) => entry._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...entry }) => entry);
}

function extractLatexCandidates(latex = '') {
  const lines = String(latex || '').split(/\r?\n/);
  let currentSection = 'General';
  const candidates = [];

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('%')) return;

    const sectionMatch = trimmed.match(/^\\section\*?\{([^}]*)\}/);
    if (sectionMatch) {
      currentSection = String(sectionMatch[1] || 'General').trim() || 'General';
      candidates.push({
        section_name: currentSection,
        kind: 'section',
        latex: trimmed,
        plain: stripLatex(trimmed),
        line_number: index + 1,
      });
      return;
    }

    if (/^\\item\b/.test(trimmed) || /^\\textbf\{/.test(trimmed) || /^[A-Za-z].{25,}$/.test(trimmed)) {
      candidates.push({
        section_name: currentSection,
        kind: /^\\item\b/.test(trimmed) ? 'item' : (/^\\textbf\{/.test(trimmed) ? 'headline' : 'text'),
        latex: trimmed,
        plain: stripLatex(trimmed),
        line_number: index + 1,
      });
    }
  });

  return candidates.filter((candidate) => candidate.plain && candidate.plain.length >= 12);
}

function buildReplacementInventory(latex = '') {
  return extractLatexCandidates(latex)
    .filter((candidate) => candidate.kind !== 'section')
    .map((candidate, inventoryIndex) => ({
      ...candidate,
      inventory_index: inventoryIndex,
    }));
}

function normalizeImportance(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'recommended' || normalized === 'optional') {
    return normalized;
  }
  return 'optional';
}

function normalizeChangeType(change = {}) {
  const raw = String(change?.change_type || '').trim().toLowerCase();
  if (raw === 'keep' || raw === 'edit') return raw;
  return String(change?.original_text || '') === String(change?.edited_text || '') ? 'keep' : 'edit';
}

function isMaterialChange(change = {}) {
  return normalizeChangeType(change) === 'edit' &&
    String(change?.original_text || '') !== String(change?.edited_text || '');
}

function buildKeepEntry(candidate = {}, hint = {}) {
  const suggestedKeywords = uniqueStrings(hint?.target_keywords || []);
  const rewriteGoal = String(hint?.rewrite_goal || '').trim();
  return {
    section_name: candidate.section_name || 'General',
    importance: 'optional',
    original_text: candidate.latex || '',
    edited_text: candidate.latex || '',
    reason: rewriteGoal || 'Current wording stays as-is because no grounded rewrite improved this line.',
    target_keywords: suggestedKeywords,
    is_hallucinated: false,
    change_type: 'keep',
    kind: candidate.kind || 'text',
    line_number: candidate.line_number ?? null,
    inventory_index: candidate.inventory_index ?? 0,
    auto_generated: true,
  };
}

function normalizeMatchedChange(change = {}, candidate = {}) {
  const originalText = candidate.latex || String(change?.original_text || '');
  const editedText = String(change?.edited_text || '');
  const normalized = {
    ...change,
    section_name: change?.section_name || candidate.section_name || 'General',
    importance: normalizeImportance(change?.importance),
    original_text: originalText,
    edited_text: editedText || originalText,
    reason: String(change?.reason || '').trim() || 'Rewrite candidate generated from the alignment analysis.',
    target_keywords: uniqueStrings(change?.target_keywords || []),
    change_type: normalizeChangeType({
      ...change,
      original_text: originalText,
      edited_text: editedText || originalText,
    }),
    kind: candidate.kind || change?.kind || 'text',
    line_number: candidate.line_number ?? change?.line_number ?? null,
    inventory_index: candidate.inventory_index ?? change?.inventory_index ?? 0,
  };

  if (normalized.change_type === 'keep' && !String(change?.reason || '').trim()) {
    normalized.reason = 'Current wording is already grounded enough to keep as-is.';
  }

  return normalized;
}

function normalizeReplacementCoverage(latex = '', report = {}) {
  const inventory = buildReplacementInventory(latex);
  const rawChanges = Array.isArray(report?.changes) ? report.changes : [];
  const inventoryHints = Array.isArray(report?.inventory_hints) ? report.inventory_hints : [];
  const hintsByLatex = new Map(
    inventoryHints
      .filter((hint) => hint?.exact_latex)
      .map((hint) => [String(hint.exact_latex), hint])
  );

  if (!inventory.length) {
    const passthrough = rawChanges.map((change, index) => ({
      ...change,
      importance: normalizeImportance(change?.importance),
      change_type: normalizeChangeType(change),
      inventory_index: index,
      line_number: change?.line_number || null,
    }));
    return {
      changes: passthrough,
      coverage: {
        total_targets: passthrough.length,
        item_targets: passthrough.filter((change) => change.kind === 'item').length,
        edited_targets: passthrough.filter(isMaterialChange).length,
        kept_targets: passthrough.filter((change) => !isMaterialChange(change)).length,
        unmatched_model_changes: 0,
      },
    };
  }

  const byOriginalText = rawChanges.reduce((acc, change, index) => {
    const key = String(change?.original_text || '');
    if (!key) return acc;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push({ change, index });
    return acc;
  }, new Map());

  const usedChangeIndexes = new Set();
  const normalizedChanges = inventory.map((candidate) => {
    const matches = byOriginalText.get(candidate.latex) || [];
    const matched = matches.find((entry) => !usedChangeIndexes.has(entry.index));
    const hint = hintsByLatex.get(String(candidate.latex || '')) || {};
    if (!matched) return buildKeepEntry(candidate, hint);
    usedChangeIndexes.add(matched.index);
    return normalizeMatchedChange(matched.change, candidate);
  });

  const unmatchedModelChanges = rawChanges.filter((_, index) => !usedChangeIndexes.has(index)).length;
  return {
    changes: normalizedChanges,
    coverage: {
      total_targets: inventory.length,
      item_targets: inventory.filter((candidate) => candidate.kind === 'item').length,
      edited_targets: normalizedChanges.filter(isMaterialChange).length,
      kept_targets: normalizedChanges.filter((change) => !isMaterialChange(change)).length,
      unmatched_model_changes: unmatchedModelChanges,
    },
  };
}

function preferredSectionForGap(gap = '', sections = []) {
  const normalized = String(gap || '').toLowerCase();
  const prefer = (patterns = []) => {
    return sections.find((section) => patterns.some((pattern) => pattern.test(String(section.name || '').toLowerCase())));
  };

  if (/(degree|bachelor|master|phd|education|certif|license)/i.test(normalized)) {
    return prefer([/education/, /cert/]) || sections[0];
  }
  if (/(leadership|mentor|stakeholder|communication|collaboration|cross functional|ownership)/i.test(normalized)) {
    return prefer([/summary/, /experience/, /lead/, /project/]) || sections[0];
  }
  if (/(aws|azure|gcp|docker|kubernetes|terraform|react|python|java|sql|spark|airflow|tableau|power bi|node|typescript|golang|cpp|csharp)/i.test(normalized)) {
    return prefer([/skill/, /experience/, /project/, /technical/]) || sections[0];
  }
  if (/(analysis|dashboard|roadmap|strategy|product|customer|market|growth)/i.test(normalized)) {
    return prefer([/experience/, /project/, /summary/]) || sections[0];
  }
  return prefer([/experience/, /project/, /summary/, /skill/]) || sections[0];
}

function buildPriorityGaps(parsedReq = {}, overall = {}, sections = [], stories = [], limit = 8) {
  const storyPool = Array.isArray(stories) ? stories : [];
  const critical = (overall.missing_critical || []).map((keyword) => ({ keyword, importance: 'critical' }));
  const preferred = (overall.missing_preferred || []).map((keyword) => ({ keyword, importance: 'recommended' }));

  return [...critical, ...preferred]
    .map((entry) => {
      const section = preferredSectionForGap(entry.keyword, sections);
      const supportingStories = storyPool.filter((story) => {
        const haystack = `${story?.tag || ''} ${story?.text || ''} ${story?.preferred_bullet || ''}`.trim();
        return phraseAppears(haystack, entry.keyword) || tokenOverlap(haystack, entry.keyword) >= 0.5;
      });
      return {
        keyword: entry.keyword,
        importance: entry.importance,
        target_section: section?.name || 'Experience',
        supporting_vault_items: supportingStories.length,
        rationale: supportingStories.length
          ? `Missing from the CV today, but supported by ${supportingStories.length} saved experience item(s).`
          : 'Missing from the CV today. Only add it if a truthful source bullet can support it.',
      };
    })
    .sort((a, b) => {
      const importanceWeight = { critical: 2, recommended: 1 };
      return (
        (importanceWeight[b.importance] || 0) - (importanceWeight[a.importance] || 0) ||
        Number(b.supporting_vault_items || 0) - Number(a.supporting_vault_items || 0) ||
        String(a.keyword || '').localeCompare(String(b.keyword || ''))
      );
    })
    .slice(0, limit);
}

function buildEvidenceCandidates(parsedReq = {}, latex = '', overall = {}, sections = [], priorityGaps = [], limit = 8) {
  const supportedGaps = (priorityGaps || []).filter((gap) => Number(gap.supporting_vault_items || 0) > 0);
  const unsupportedGaps = (priorityGaps || []).filter((gap) => Number(gap.supporting_vault_items || 0) === 0);
  const missingCritical = uniqueStrings([
    ...supportedGaps.filter((gap) => gap.importance === 'critical').map((gap) => gap.keyword),
    ...unsupportedGaps.filter((gap) => gap.importance === 'critical').map((gap) => gap.keyword),
    ...(overall.missing_critical || []),
  ]).slice(0, 6);
  const missingPreferred = uniqueStrings([
    ...supportedGaps.filter((gap) => gap.importance !== 'critical').map((gap) => gap.keyword),
    ...unsupportedGaps.filter((gap) => gap.importance !== 'critical').map((gap) => gap.keyword),
    ...(overall.missing_preferred || []),
  ]).slice(0, 4);
  const candidates = extractLatexCandidates(latex);

  return candidates
    .map((candidate) => {
      const coverage = analyzeKeywordCoverage(parsedReq, candidate.plain);
      const quantified = /\b\d+(?:[.,]\d+)?%?\b/.test(candidate.plain);
      const leadToken = canonicalToken(tokenize(candidate.plain)[0] || '');
      const actionVerb = ACTION_VERBS.has(leadToken);
      const sectionName = String(candidate.section_name || '').toLowerCase();
      const sectionBonus = /experience|project|employment|work/.test(sectionName)
        ? 4
        : /summary|profile/.test(sectionName)
          ? 3
          : /skill/.test(sectionName)
            ? 2
            : 1;
      const targetKeywords = uniqueStrings([
        ...missingCritical
          .map((keyword) => ({ keyword, score: tokenOverlap(candidate.plain, keyword) }))
          .sort((a, b) => b.score - a.score || missingCritical.indexOf(a.keyword) - missingCritical.indexOf(b.keyword))
          .map((item) => item.keyword),
        ...missingPreferred
          .map((keyword) => ({ keyword, score: tokenOverlap(candidate.plain, keyword) }))
          .sort((a, b) => b.score - a.score || missingPreferred.indexOf(a.keyword) - missingPreferred.indexOf(b.keyword))
          .map((item) => item.keyword),
      ]).slice(0, 3);
      const matchedKeywords = uniqueStrings([
        ...(coverage.matched_critical || []),
        ...(coverage.matched_preferred || []),
      ]).slice(0, 4);
      const priorityScore =
        ((coverage.matched_critical || []).length * 6) +
        ((coverage.matched_preferred || []).length * 3) +
        sectionBonus +
        (quantified ? 3 : 0) +
        (actionVerb ? 2 : 0) -
        ((coverage.missing_critical || []).length > 6 ? 2 : 0);

      let rationale = 'Useful anchor for a stronger, more targeted rewrite.';
      if (quantified && matchedKeywords.length) {
        rationale = 'Already contains concrete evidence and role-relevant language, so it can absorb better keywords safely.';
      } else if (quantified) {
        rationale = 'Contains measurable evidence that should be preserved while sharpening the framing.';
      } else if (matchedKeywords.length) {
        rationale = 'Already overlaps with the job and can be rewritten without stretching the underlying claim.';
      } else if (/skill/.test(sectionName)) {
        rationale = 'Good place to surface exact tools or stack terms without inflating experience claims.';
      }

      return {
        section_name: candidate.section_name,
        kind: candidate.kind,
        exact_latex: candidate.latex,
        current_keywords: matchedKeywords,
        target_keywords: targetKeywords,
        quantified,
        action_verb: actionVerb,
        rationale,
        priority_score: priorityScore,
      };
    })
    .filter((candidate) => candidate.priority_score > 0)
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, limit);
}

function buildAtsBreakdown(parsedReq = {}, overall = {}, sections = [], stories = []) {
  const buckets = requirementBuckets(parsedReq);
  const storyMatches = buildStorySuggestions(parsedReq, stories, 4);
  return {
    matched_critical_count: (overall.matched_critical || []).length,
    total_critical_count: buckets.critical.length,
    matched_preferred_count: (overall.matched_preferred || []).length,
    total_preferred_count: buckets.preferred.length,
    matched_keywords: uniqueStrings([
      ...(overall.matched_critical || []),
      ...(overall.matched_preferred || []),
    ]).slice(0, 12),
    missing_keywords: uniqueStrings([
      ...(overall.missing_critical || []),
      ...(overall.missing_preferred || []),
    ]).slice(0, 12),
    strongest_sections: [...(sections || [])]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 3)
      .map((section) => section.name),
    supporting_story_count: storyMatches.length,
  };
}

function buildReplacementSource(latex = '', parsedReq = {}, limit = Number.POSITIVE_INFINITY, prioritizedCandidates = []) {
  const seeded = (prioritizedCandidates || []).map((candidate) => candidate?.exact_latex).filter(Boolean);
  const inventory = buildReplacementInventory(latex).map((candidate) => candidate.latex);
  const allCandidates = [...seeded, ...inventory];
  if (!allCandidates.length) return latex;

  const cappedLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : allCandidates.length;
  if (allCandidates.length <= cappedLimit) {
    return allCandidates.join('\n');
  }

  const keywords = requirementBuckets(parsedReq).all.map((phrase) => normalizeText(phrase));
  const scored = allCandidates
    .map((line) => {
      const normalized = normalizeText(line);
      const keywordHits = keywords.filter((keyword) => keyword && normalized.includes(keyword)).length;
      const structuralBonus = line.includes('\\item') ? 2 : 1;
      return { line, score: keywordHits + structuralBonus };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, cappedLimit).map((entry) => entry.line).join('\n');
}

function buildLocalAlignment(parsedReq = {}, latex = '', stories = []) {
  const overall = computeAtsScore(latex, parsedReq);
  const sections = extractSectionBlocks(latex).map((section) => {
    const sectionScores = computeAtsScore(section.latex, parsedReq);
    const sectionName = String(section.name || '').toLowerCase();
    const suggestions = [];
    if (sectionScores.missing_critical.length) {
      suggestions.push(`Reword a bullet here to surface ${sectionScores.missing_critical.slice(0, 2).join(' / ')} if true.`);
    }
    if (sectionScores.quantified_impact < 40) {
      suggestions.push('Add a measurable result in this section if the underlying experience supports it.');
    }
    if (sectionScores.recruiter_readability_score < 50) {
      suggestions.push('Tighten bullet wording so each line states action, scope, and result more directly.');
    }
    if (/summary|profile|overview/.test(sectionName)) {
      suggestions.push('Use this section to front-load role title, stack, and domain fit in 2-3 lines instead of generic self-description.');
    }
    if (/experience|project/.test(sectionName)) {
      suggestions.push('Prefer bullets that show action, system scope, tool context, and business outcome rather than duty-only wording.');
    }
    if (/skill|technical/.test(sectionName)) {
      suggestions.push('Keep only supported tools and exact stack terms here; remove filler categories that do not help this target role.');
    }
    if (/education/.test(sectionName)) {
      suggestions.push('Keep Education concise; trim low-signal coursework unless it directly supports the target job.');
    }
    if (sectionScores.ats_score >= 75 && sectionScores.matched_critical.length >= 2) {
      suggestions.push('Keep this section prominent and lead with the strongest role-relevant evidence.');
    }
    if (sectionScores.ats_score < 45 && sectionScores.matched_critical.length === 0) {
      suggestions.push('If space is tight, compress or de-emphasize this section because it is not carrying much target-role evidence yet.');
    }

    const bestStory = buildStorySuggestions(
      { ...parsedReq, required_skills: sectionScores.missing_critical },
      stories,
      1
    )[0];

    // Build per-bullet review for the new multi-dimensional schema
    const sectionBullets = extractBullets(section.latex);
    const sectionTokenSet = new Set(tokenize(section.latex));
    const allJobKeywords = uniqueStrings([
      ...(parsedReq.required_skills || []),
      ...(parsedReq.preferred_skills || []),
      ...(parsedReq.industry_keywords || []),
      ...((parsedReq.keyword_taxonomy || {}).hard_skills || []),
      ...((parsedReq.keyword_taxonomy || {}).tools || []),
    ]);
    const bulletReview = sectionBullets.map((bullet) => {
      const bulletTokens = new Set(tokenize(bullet));
      const matchedKeywords = allJobKeywords.filter((kw) => {
        const kwTokens = tokenize(kw);
        return kwTokens.length > 0 && kwTokens.filter((t) => bulletTokens.has(t)).length / kwTokens.length >= 0.6;
      });
      const hasMetric = /\b\d+(?:[.,]\d+)?%?\b/.test(bullet);
      const leadToken = canonicalToken(tokenize(bullet)[0] || '');
      const startsWithAction = ACTION_VERBS.has(leadToken);
      const wordCount = tokenize(bullet).length;

      let verdict = 'adequate';
      let gap = '';
      let suggestion = '';

      if (matchedKeywords.length >= 2 && hasMetric && startsWithAction && wordCount >= 8 && wordCount <= 30) {
        verdict = 'strong';
      } else if (matchedKeywords.length === 0 && !hasMetric && !startsWithAction) {
        verdict = 'weak';
        gap = 'No job keywords, no metrics, no action verb lead.';
        suggestion = 'Rewrite with a strong action verb, add scope/context, and surface at least one job-relevant keyword if truthfully supported.';
      } else {
        const gaps = [];
        if (matchedKeywords.length === 0) gaps.push('no job keywords');
        if (!hasMetric) gaps.push('no quantified result');
        if (!startsWithAction) gaps.push('weak action verb lead');
        if (wordCount < 8) gaps.push('too short — lacks specificity');
        if (wordCount > 32) gaps.push('too long — tighten for recruiter scanning');
        gap = gaps.join('; ');
        if (!startsWithAction) {
          suggestion = 'Lead with a strong action verb and clarify the deliverable or outcome.';
        } else if (matchedKeywords.length === 0) {
          suggestion = 'Surface a supported job keyword by specifying tools, domain, or context already in the CV.';
        } else if (!hasMetric) {
          suggestion = 'Add a quantified result or clarify scope/scale if the underlying experience supports it.';
        } else {
          suggestion = 'Tighten wording for clarity, specificity, or stronger outcome framing.';
        }
      }

      return { text: bullet, verdict, gap, suggestion };
    });

    // Compute multi-dimensional scoring
    const keywordMatchScore = clamp(round(
      (sectionScores.critical_keyword_match * 0.7) + (sectionScores.preferred_keyword_match * 0.3)
    ));
    const evidenceQualityScore = clamp(round(
      (sectionScores.quantified_impact * 0.4) + (sectionScores.recruiter_readability_score * 0.6)
    ));
    const relevanceBulletCount = bulletReview.length || 1;
    const relevantBullets = bulletReview.filter((b) => b.verdict !== 'weak').length;
    const relevanceScore = clamp(round((relevantBullets / relevanceBulletCount) * 100));
    const sectionOverall = clamp(round(
      (keywordMatchScore * 0.40) + (evidenceQualityScore * 0.35) + (relevanceScore * 0.25)
    ));

    return {
      name: section.name,
      score: sectionOverall,
      scoring: {
        keyword_match: {
          score: keywordMatchScore,
          matched: uniqueStrings([
            ...sectionScores.matched_critical,
            ...sectionScores.matched_preferred,
          ]).slice(0, 8),
          missing: uniqueStrings([
            ...sectionScores.missing_critical,
            ...sectionScores.missing_preferred,
          ]).slice(0, 8),
          reasoning: `${sectionScores.matched_critical.length}/${(sectionScores.matched_critical.length + sectionScores.missing_critical.length) || 1} critical keywords present`,
        },
        evidence_quality: {
          score: evidenceQualityScore,
          reasoning: `Quantified impact: ${sectionScores.quantified_impact}%, Readability: ${sectionScores.recruiter_readability_score}%`,
        },
        relevance: {
          score: relevanceScore,
          reasoning: `${relevantBullets}/${relevanceBulletCount} bullets rated adequate or strong for this role`,
        },
        overall: sectionOverall,
      },
      bullet_review: bulletReview,
      matched_keywords: uniqueStrings([
        ...sectionScores.matched_critical,
        ...sectionScores.matched_preferred,
      ]).slice(0, 8),
      gaps: uniqueStrings([
        ...sectionScores.missing_critical,
        ...sectionScores.missing_preferred,
      ]).slice(0, 8),
      suggestions: uniqueStrings(suggestions).slice(0, 5),
      story_to_weave: bestStory ? `${bestStory.story_tag}: ${bestStory.rationale}` : '',
    };
  });

  const verdict = overall.ats_score >= 80
    ? 'Strong match with a few optimization opportunities.'
    : overall.ats_score >= 60
      ? 'Moderate match; targeted rewrites should materially improve alignment.'
      : 'The CV has useful overlap, but several important job requirements are still under-emphasized.';
  const priorityGaps = buildPriorityGaps(parsedReq, overall, sections, stories, 8);
  const evidenceCandidates = buildEvidenceCandidates(parsedReq, latex, overall, sections, priorityGaps, 8);

  return {
    overall_score: overall.ats_score,
    overall_verdict: verdict,
    sections,
    missing_from_cv: overall.missing_critical,
    strongest_matches: uniqueStrings([
      ...overall.matched_critical,
      ...overall.matched_preferred,
    ]).slice(0, 3),
    recommended_emphasis: uniqueStrings([
      ...overall.matched_critical,
      ...overall.missing_critical.slice(0, 2),
    ]).slice(0, 5),
    corpus_suggestions: buildStorySuggestions(parsedReq, stories, 3),
    ats_breakdown: buildAtsBreakdown(parsedReq, overall, sections, stories),
    priority_gaps: priorityGaps,
    evidence_candidates: evidenceCandidates,
  };
}

function validateChange(change, latex, sourceText, parsedReq) {
  const originalText = String(change?.original_text || '');
  const editedText = String(change?.edited_text || '');
  const originalFound = Boolean(originalText) && latex.includes(originalText);
  const sourceNumbers = extractNumbers(sourceText);
  const introducedNumbers = [...extractNumbers(editedText)].filter((value) => !sourceNumbers.has(value));
  const introducedKeywords = requirementBuckets(parsedReq).all.filter((keyword) => {
    return phraseAppears(editedText, keyword) && !phraseAppears(sourceText, keyword);
  });

  const issues = [];
  if (!originalFound) {
    issues.push('Original text is not an exact substring of the source LaTeX.');
  }
  if (introducedKeywords.length) {
    issues.push(`Introduces unsupported job keywords: ${introducedKeywords.join(', ')}.`);
  }
  if (introducedNumbers.length) {
    issues.push(`Introduces unsupported numbers: ${introducedNumbers.join(', ')}.`);
  }

  return {
    exact_match: originalFound,
    introduced_keywords: introducedKeywords,
    introduced_numbers: introducedNumbers,
    issues,
    hallucinated: Boolean(change?.is_hallucinated || introducedKeywords.length || introducedNumbers.length),
  };
}

function applyChanges(latex, changes = []) {
  let editedLatex = String(latex || '');
  let appliedChanges = 0;
  let exactMatchFailures = 0;

  const actionableChanges = (changes || [])
    .filter((change) => isMaterialChange(change))
    .sort((a, b) => Number(b?.line_number || 0) - Number(a?.line_number || 0));

  actionableChanges.forEach((change) => {
    const originalText = String(change?.original_text || '');
    const editedText = String(change?.edited_text || '');
    const lineNumber = Number(change?.line_number || 0);

    if (lineNumber > 0) {
      const lines = editedLatex.split(/\r?\n/);
      const currentLine = lines[lineNumber - 1];
      if (currentLine != null && String(currentLine).trim() === originalText) {
        const indent = String(currentLine).match(/^\s*/)?.[0] || '';
        lines[lineNumber - 1] = `${indent}${editedText}`;
        editedLatex = lines.join('\n');
        appliedChanges += 1;
        return;
      }
    }

    if (originalText && editedText && editedLatex.includes(originalText)) {
      editedLatex = editedLatex.replace(originalText, editedText);
      appliedChanges += 1;
    } else {
      exactMatchFailures += 1;
    }
  });

  return { editedLatex, appliedChanges, exactMatchFailures };
}

function enrichTailoringReport({ latex, parsedReq, stories = [], replacements }) {
  const report = replacements && typeof replacements === 'object' ? { ...replacements } : {};
  const normalizedCoverage = normalizeReplacementCoverage(latex, report);
  const candidateChanges = normalizedCoverage.changes;
  const { sourceText } = buildSourceCorpus(latex, stories);

  const verifiedChanges = candidateChanges.map((change) => {
    const validation = validateChange(change, latex, sourceText, parsedReq);
    return {
      ...change,
      is_hallucinated: validation.hallucinated,
      validation,
    };
  });

  const { editedLatex, appliedChanges, exactMatchFailures } = applyChanges(latex, verifiedChanges);
  const beforeScores = computeAtsScore(latex, parsedReq);
  const afterScores = computeAtsScore(editedLatex, parsedReq);
  const contentPreservationScore = round(cosineSimilarity(stripLatex(latex), stripLatex(editedLatex)) * 100);
  const hallucinationFlags = verifiedChanges.filter((change) => change.validation?.hallucinated).length;
  const finalCoverage = {
    ...normalizedCoverage.coverage,
    edited_targets: verifiedChanges.filter(isMaterialChange).length,
    kept_targets: verifiedChanges.filter((change) => !isMaterialChange(change)).length,
  };

  const keywordAnalysis = {
    matched_critical: afterScores.matched_critical,
    missing_critical: afterScores.missing_critical,
    matched_preferred: afterScores.matched_preferred,
    missing_preferred: afterScores.missing_preferred,
    newly_covered_critical: afterScores.matched_critical.filter((item) => !beforeScores.matched_critical.includes(item)),
    newly_covered_preferred: afterScores.matched_preferred.filter((item) => !beforeScores.matched_preferred.includes(item)),
  };

  const warnings = uniqueStrings([
    ...(report.warnings || []),
    finalCoverage.total_targets
      ? `Reviewed ${finalCoverage.total_targets} replaceable line(s): ${finalCoverage.edited_targets} edited, ${finalCoverage.kept_targets} kept.`
      : '',
    finalCoverage.unmatched_model_changes
      ? `${finalCoverage.unmatched_model_changes} model suggestion(s) were ignored because they did not match an exact source line.`
      : '',
    exactMatchFailures ? `${exactMatchFailures} suggested change(s) could not be auto-applied because the original text was not an exact LaTeX match.` : '',
    hallucinationFlags ? `${hallucinationFlags} change(s) need manual review for unsupported keywords or numbers.` : '',
    keywordAnalysis.missing_critical.length ? `Critical job gaps still missing: ${keywordAnalysis.missing_critical.join(', ')}.` : '',
    contentPreservationScore < 70 ? `Content preservation dropped to ${contentPreservationScore}%. Review whether the tailored CV still reflects the original story accurately.` : '',
  ]);

  const risks = uniqueStrings([
    ...(report.risks || []),
    ...verifiedChanges
      .filter((change) => change.validation?.hallucinated)
      .map((change) => change.validation.issues.join(' ')),
  ]);

  return {
    editedLatex,
    report: {
      ...report,
      changes: verifiedChanges,
      coverage: finalCoverage,
      warnings,
      risks,
      metrics: {
        before: beforeScores,
        after: afterScores,
        content_preservation_score: contentPreservationScore,
        keyword_analysis: keywordAnalysis,
        verification_summary: {
          applied_changes: appliedChanges,
          exact_match_failures: exactMatchFailures,
          hallucination_flags: hallucinationFlags,
        },
      },
    },
  };
}

module.exports = {
  computeAtsScore,
  buildLocalAlignment,
  buildReplacementSource,
  buildReplacementInventory,
  stripLatex,
  enrichTailoringReport,
  isMaterialChange,
};
