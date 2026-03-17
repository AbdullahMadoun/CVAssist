(function initExtractorCore(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.JobExtractorCore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  var JOB_INFO_HINTS = [
    'about the job',
    'job summary',
    'job description',
    'responsibilities',
    'requirements',
    'qualifications',
    'preferred qualifications',
    'minimum qualifications',
    'what you will do',
    'what you will bring',
    'what you bring',
    'what we are looking for',
    'what we\'re looking for',
    'who you are',
    'about the role',
    'in this role',
    'day to day',
    'your background',
    'experience',
    'skills',
    'must have',
    'nice to have'
  ];

  var QUALIFICATION_HINTS = [
    'qualification',
    'requirement',
    'what we are looking for',
    'what we\'re looking for',
    'your background',
    'about you',
    'must have',
    'nice to have',
    'preferred',
    'minimum',
    'skills',
    'experience'
  ];

  var RESPONSIBILITY_HINTS = [
    'responsibilit',
    'what you will do',
    'what you\'ll do',
    'in this role',
    'day to day',
    'what you bring',
    'what you will bring',
    'you will',
    'the role',
    'about the role'
  ];

  var LOCATION_HINTS = [
    'remote',
    'hybrid',
    'onsite',
    'on-site'
  ];

  var NOISE_LINES = [
    /^sign in$/i,
    /^join now$/i,
    /^save$/i,
    /^share$/i,
    /^follow$/i,
    /^report this job$/i,
    /^easy apply$/i,
    /^apply$/i,
    /^apply now$/i,
    /^apply on company site$/i,
    /^show more$/i,
    /^show less$/i,
    /^read more$/i,
    /^read less$/i,
    /^continue reading$/i,
    /^see who .* has hired/i,
    /^people also viewed$/i,
    /^similar jobs$/i,
    /^recommended jobs$/i,
    /^jobs you may be interested in$/i,
    /^set alert for similar jobs$/i
  ];

  var ROLE_WORDS = /\b(engineer|developer|manager|scientist|designer|lead|director|analyst|specialist|architect|consultant|intern|recruiter|marketer|product|sales|operations|qa|security|devops|administrator|owner|technician|writer|editor)\b/i;
  var NOISE_TITLE_WORDS = /\b(apply|sign in|join now|careers|jobs|job search|hiring platform|top job picks|similar jobs|recommended jobs)\b/i;
  var GENERIC_COMPANIES = /^(linkedin|greenhouse|greenhouse recruiting|lever|workday|indeed|smartrecruiters|ashby|ashbyhq|workable|ziprecruiter|icims)$/i;
  var JOB_URL_HINTS = /(\/jobs\/view\/|\/job\/|\/jobs\/|\/careers\/|myworkdayjobs|lever|greenhouse|ashbyhq|smartrecruiters|workable|ziprecruiter|icims)/i;

  function decodeHtmlEntities(text) {
    return String(text || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  function normalizeSpace(text) {
    return decodeHtmlEntities(String(text || ''))
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeMultiline(text) {
    return decodeHtmlEntities(String(text || ''))
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|section|article|h1|h2|h3|h4|li|ul|ol)\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function htmlToText(text) {
    return normalizeMultiline(text);
  }

  function uniqueStrings(items) {
    var seen = new Set();
    return (items || []).map(function mapItem(item) {
      return normalizeSpace(item);
    }).filter(function keepItem(item) {
      if (!item) return false;
      var key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function clip(text, maxLength) {
    var value = String(text || '');
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength - 1).trimEnd() + '...';
  }

  function includesAny(text, needles) {
    var haystack = normalizeSpace(text).toLowerCase();
    return needles.some(function someNeedle(needle) {
      return haystack.includes(needle);
    });
  }

  function expandCandidates(items) {
    var expanded = [];
    (items || []).forEach(function eachItem(item) {
      var value = normalizeSpace(item);
      if (!value) return;
      expanded.push(value);
      value.split(/\s[\-|@|]\s|\s\|\s|\s-\s|\s@\s|\s[\u2013\u2014]\s|\s[\u00b7]\s|\s:\s/).forEach(function eachPart(part) {
        var trimmed = normalizeSpace(part);
        if (trimmed && trimmed !== value) expanded.push(trimmed);
      });
    });
    return uniqueStrings(expanded);
  }

  function scoreRoleCandidate(text) {
    var value = normalizeSpace(text);
    if (!value) return -1;
    var score = 0;
    if (value.length >= 6 && value.length <= 160) score += 3;
    if (/[A-Za-z]/.test(value)) score += 2;
    if (!/[|]/.test(value)) score += 1;
    if (!NOISE_TITLE_WORDS.test(value)) score += 3;
    if (ROLE_WORDS.test(value)) score += 5;
    if (/\b(careers|jobs)\b/i.test(value) && !ROLE_WORDS.test(value)) score -= 6;
    if (/\b(remote|hybrid|riyadh|dubai|london|new york|san francisco)\b/i.test(value) && !ROLE_WORDS.test(value)) score -= 3;
    if (/\d{4}/.test(value)) score -= 2;
    return score;
  }

  function scoreCompanyCandidate(text) {
    var value = normalizeSpace(text);
    if (!value) return -1;
    var score = 0;
    if (value.length >= 2 && value.length <= 100) score += 3;
    if (!/apply|sign in|learn more|save|share|job description/i.test(value)) score += 2;
    if (!/\b(job|jobs|career|careers|location|remote|hybrid)\b/i.test(value)) score += 1;
    if (!/[|]/.test(value)) score += 1;
    if (ROLE_WORDS.test(value)) score -= 4;
    if (GENERIC_COMPANIES.test(value)) score -= 4;
    return score;
  }

  function scoreUrlCandidate(text) {
    var value = normalizeSpace(text);
    if (!/^https?:\/\//i.test(value)) return -1;
    var score = 0;
    if (JOB_URL_HINTS.test(value)) score += 8;
    if (/linkedin\.com\/jobs\/view\//i.test(value)) score += 8;
    if (/jobs\.ashbyhq\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|ziprecruiter\.com|icims\.com/i.test(value)) score += 5;
    if (/currentJobId=/i.test(value)) score += 1;
    if (/\/apply/i.test(value)) score -= 2;
    if (value.length <= 600) score += 2;
    return score;
  }

  function scoreLocationCandidate(text) {
    var value = normalizeSpace(text);
    if (!value) return -1;
    var score = 0;
    if (value.length >= 2 && value.length <= 160) score += 2;
    if (/[A-Za-z]/.test(value)) score += 1;
    if (LOCATION_HINTS.some(function someHint(hint) { return value.toLowerCase().includes(hint); })) score += 3;
    if (/,/.test(value)) score += 1;
    if (/\b(riyadh|dubai|saudi arabia|uae|united states|usa|uk|germany|canada|europe|emea|apac|mena)\b/i.test(value)) score += 2;
    if (/\b(role|team|department|job|career)\b/i.test(value)) score -= 3;
    return score;
  }

  function bestCandidate(candidates, scorer) {
    var bestText = '';
    var bestScore = -1;
    expandCandidates(candidates).forEach(function eachCandidate(candidate) {
      var score = scorer(candidate);
      if (score > bestScore) {
        bestScore = score;
        bestText = normalizeSpace(candidate);
      }
    });
    return bestText;
  }

  function detectSite(hostname) {
    var host = normalizeSpace(hostname).toLowerCase();
    if (host.includes('linkedin.com')) return 'linkedin';
    if (host.includes('greenhouse.io')) return 'greenhouse';
    if (host.includes('lever.co')) return 'lever';
    if (host.includes('myworkdayjobs.com')) return 'workday';
    if (host.includes('ashbyhq.com')) return 'ashby';
    if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (host.includes('workable.com')) return 'workable';
    if (host.includes('indeed.com')) return 'indeed';
    if (host.includes('ziprecruiter.com')) return 'ziprecruiter';
    if (host.includes('icims.com')) return 'icims';
    return 'generic';
  }

  function normalizeStructuredJob(item) {
    if (!item || typeof item !== 'object') return null;

    var normalized = {
      title: normalizeSpace(item.title || item.name),
      company: normalizeSpace(item.company || item.companyName || item.organization || ''),
      location: normalizeSpace(item.location || item.jobLocation || ''),
      description: htmlToText(item.description || item.summary || ''),
      employmentType: normalizeSpace(Array.isArray(item.employmentType) ? item.employmentType.join(', ') : item.employmentType),
      workplaceType: normalizeSpace(item.workplaceType || item.jobLocationType || ''),
      salary: normalizeSpace(item.salary || item.baseSalary || ''),
      datePosted: normalizeSpace(item.datePosted || ''),
      validThrough: normalizeSpace(item.validThrough || ''),
      url: normalizeSpace(item.url || ''),
      identifier: normalizeSpace(item.identifier || item.requisitionId || '')
    };

    if (!normalized.title && !normalized.description && !normalized.company) return null;
    if (!normalized.workplaceType && /\btelecommute\b/i.test(String(item.jobLocationType || ''))) {
      normalized.workplaceType = 'Remote';
    }
    if (!normalized.location && normalized.workplaceType) {
      normalized.location = normalized.workplaceType;
    }
    return normalized;
  }

  function scoreStructuredJob(job) {
    if (!job) return -1;
    var score = 0;
    if (job.title) score += 12;
    if (job.company) score += 8;
    if (job.location) score += 4;
    if (job.description.length >= 160) score += 10;
    if (job.description.length >= 800) score += 8;
    if (job.url) score += 6;
    if (job.identifier) score += 2;
    return score;
  }

  function pickBestStructuredJob(items) {
    var best = null;
    var bestScore = -1;
    (items || []).forEach(function eachItem(item) {
      var score = scoreStructuredJob(item);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    });
    return best;
  }

  function inferLocation(candidates, bodyText, structuredJob) {
    var location = bestCandidate(candidates, scoreLocationCandidate);
    if (location) return location;
    if (structuredJob && structuredJob.location) return structuredJob.location;

    var body = normalizeSpace(bodyText).toLowerCase();
    var hint = LOCATION_HINTS.find(function findHint(item) {
      return body.includes(item);
    });
    return hint ? hint.charAt(0).toUpperCase() + hint.slice(1) : '';
  }

  function removeNoiseLines(lines) {
    return lines.filter(function keepLine(line) {
      var value = normalizeSpace(line);
      if (!value) return false;
      return !NOISE_LINES.some(function somePattern(pattern) {
        return pattern.test(value);
      });
    });
  }

  function cleanJobText(text) {
    var lines = normalizeMultiline(text).split('\n').map(function mapLine(line) {
      return line.trim();
    }).filter(Boolean);

    lines = removeNoiseLines(lines);

    var seen = new Set();
    return lines.filter(function keepLine(line) {
      var key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join('\n');
  }

  function renderSection(section) {
    var parts = [];
    if (section.heading) parts.push(section.heading);
    if (section.items && section.items.length) parts.push(section.items.join('\n'));
    if (section.text) parts.push(section.text);
    return cleanJobText(parts.join('\n'));
  }

  function bestTextCandidate(candidates, site) {
    var best = '';
    var bestScore = -999;

    uniqueStrings(candidates || []).forEach(function eachCandidate(candidate) {
      var value = cleanJobText(candidate);
      if (!value) return;

      var score = 0;
      if (value.length >= 100) score += 8;
      if (value.length >= 250) score += 10;
      if (value.length >= 700) score += 10;
      if (value.length >= 1400) score += 5;
      if (value.length > 24000) score -= 8;
      if (includesAny(value, JOB_INFO_HINTS)) score += 10;
      if (site === 'linkedin' && /about the job/i.test(value)) score += 8;
      if (/people also viewed|recommended jobs|similar jobs|sign in|join now/i.test(value)) score -= 14;
      if (value.split('\n').length >= 4) score += 4;
      if (/qualifications|requirements|responsibilities|experience/i.test(value)) score += 5;

      if (score > bestScore) {
        bestScore = score;
        best = value;
      }
    });

    return best;
  }

  function containsSnippet(haystack, needle) {
    var hay = normalizeSpace(haystack).toLowerCase();
    var ned = clip(normalizeSpace(needle), 160).toLowerCase();
    if (!hay || !ned) return false;
    return hay.includes(ned);
  }

  function renderStructuredDetails(structuredJob) {
    if (!structuredJob) return '';
    var parts = [];
    if (structuredJob.employmentType) parts.push('Employment type: ' + structuredJob.employmentType);
    if (structuredJob.workplaceType) parts.push('Workplace: ' + structuredJob.workplaceType);
    if (structuredJob.salary) parts.push('Compensation: ' + structuredJob.salary);
    if (structuredJob.datePosted) parts.push('Date posted: ' + structuredJob.datePosted);
    if (structuredJob.validThrough) parts.push('Valid through: ' + structuredJob.validThrough);
    if (structuredJob.description) parts.push(structuredJob.description);
    return cleanJobText(parts.join('\n\n'));
  }

  function buildJobInfo(job, snapshot, sections, site, structuredJob) {
    var structuredText = renderStructuredDetails(structuredJob);
    var sectionText = sections.map(renderSection).filter(Boolean).join('\n\n');
    var listText = cleanJobText((snapshot.listItems || []).join('\n'));
    var metaText = cleanJobText(snapshot.metaDescription || '');
    var bodyText = cleanJobText(snapshot.bodyText || '');
    var primary = bestTextCandidate([].concat(
      snapshot.jobInfoCandidates || [],
      structuredText,
      sectionText,
      listText,
      metaText,
      bodyText
    ), site);
    var parts = [];

    if (job.title) parts.push('Title: ' + job.title);
    if (job.company) parts.push('Company: ' + job.company);
    if (job.location) parts.push('Location: ' + job.location);

    if (primary) parts.push(primary);
    if (structuredText && !containsSnippet(parts.join('\n\n'), structuredText)) parts.push(structuredText);
    if (sectionText && !containsSnippet(parts.join('\n\n'), sectionText)) parts.push(sectionText);
    if (metaText && (!primary || primary.length < 400) && !containsSnippet(parts.join('\n\n'), metaText)) parts.push(metaText);
    if (bodyText && (!primary || primary.length < 900 || !containsSnippet(primary, bodyText))) parts.push(bodyText);
    if (listText && !containsSnippet(parts.join('\n\n'), listText)) parts.push(listText);

    return clip(cleanJobText(parts.join('\n\n')), 20000);
  }

  function collectSectionBullets(sections, hints) {
    var bullets = [];
    (sections || []).forEach(function eachSection(section) {
      var heading = normalizeSpace(section.heading).toLowerCase();
      var matches = hints.some(function someHint(hint) {
        return heading.includes(hint);
      });
      if (!matches) return;
      bullets = bullets.concat(section.items || []);
      normalizeMultiline(section.text || '').split('\n').forEach(function eachLine(line) {
        var value = normalizeSpace(line.replace(/^[-\u2022*]+\s*/, ''));
        if (value.length >= 12) bullets.push(value);
      });
    });
    return uniqueStrings(bullets).slice(0, 14);
  }

  function collectFallbackBullets(items, matcher) {
    return uniqueStrings((items || []).filter(function keepItem(item) {
      return matcher.test(normalizeSpace(item));
    })).slice(0, 14);
  }

  function summaryFromText(text) {
    var value = normalizeSpace(text);
    if (!value) return '';
    var firstSentence = value.split(/(?<=[.!?])\s+/)[0];
    return clip(firstSentence || value, 260);
  }

  function buildSummary(jobInfo, metaDescription, structuredJob) {
    var meta = summaryFromText(metaDescription);
    if (meta && meta.length >= 40) return meta;
    if (structuredJob && structuredJob.description) return summaryFromText(structuredJob.description);
    return summaryFromText(jobInfo);
  }

  function calculateConfidence(job, site, signals, structuredJob, metaDescription) {
    var score = 0;
    if (job.title) score += 28;
    if (job.company) score += 18;
    if (job.location) score += 6;
    if (job.jobInfo.length >= 250) score += 12;
    if (job.jobInfo.length >= 800) score += 16;
    if (job.url) score += 8;
    if (job.summary) score += 4;
    if (site !== 'generic') score += 4;
    if (signals.roleCandidates >= 1) score += 4;
    if (signals.companyCandidates >= 1) score += 4;
    if (signals.jobInfoCandidates >= 1) score += 4;
    if (signals.rootScore >= 14) score += 4;
    if (signals.sectionCount >= 2) score += 3;
    if (signals.structuredDataJobs >= 1) score += 8;
    if (structuredJob && structuredJob.description.length >= 160) score += 6;
    if (metaDescription) score += 2;
    if ((job.qualifications || []).length >= 2) score += 3;
    if ((job.responsibilities || []).length >= 2) score += 3;
    return Math.max(0, Math.min(score, 100));
  }

  function pickJobUrl(snapshot, structuredJob) {
    var candidates = [].concat(structuredJob && structuredJob.url ? [structuredJob.url] : [], snapshot.jobUrlCandidates || []);
    var jobUrl = bestCandidate(candidates, scoreUrlCandidate);
    return jobUrl || normalizeSpace(snapshot.url);
  }

  function extractJob(snapshot) {
    var site = detectSite(snapshot.hostname || snapshot.site || '');
    var sections = (snapshot.sections || []).map(function mapSection(section) {
      return {
        heading: normalizeSpace(section.heading),
        text: normalizeMultiline(section.text),
        items: uniqueStrings(section.items || [])
      };
    }).filter(function keepSection(section) {
      return section.heading || section.text || section.items.length;
    });

    var structuredJobs = uniqueStrings((snapshot.structuredData || []).map(function mapStructured(item) {
      return JSON.stringify(normalizeStructuredJob(item) || null);
    })).map(function parseStructured(value) {
      try {
        return JSON.parse(value);
      } catch (error) {
        return null;
      }
    }).filter(Boolean);
    var structuredJob = pickBestStructuredJob(structuredJobs);

    var title = bestCandidate(
      [].concat(
        structuredJob && structuredJob.title ? [structuredJob.title] : [],
        snapshot.roleCandidates || [],
        snapshot.documentTitle || '',
        snapshot.metaTitle || ''
      ),
      scoreRoleCandidate
    );

    var company = bestCandidate(
      [].concat(
        structuredJob && structuredJob.company ? [structuredJob.company] : [],
        snapshot.companyCandidates || [],
        snapshot.metaSiteName || ''
      ),
      scoreCompanyCandidate
    );

    var location = inferLocation(
      [].concat(structuredJob && structuredJob.location ? [structuredJob.location] : [], snapshot.locationCandidates || []),
      snapshot.bodyText || '',
      structuredJob
    );
    var url = pickJobUrl(snapshot, structuredJob);

    var qualifications = collectSectionBullets(sections, QUALIFICATION_HINTS);
    if (!qualifications.length) {
      qualifications = collectFallbackBullets(snapshot.listItems || [], /\b(required|requirements|qualification|qualifications|must have|preferred|experience with|familiarity with|proficient in)\b/i);
    }

    var responsibilities = collectSectionBullets(sections, RESPONSIBILITY_HINTS);
    if (!responsibilities.length) {
      responsibilities = collectFallbackBullets(snapshot.listItems || [], /\b(you will|responsib|build|design|lead|partner|maintain|develop|drive|deliver)\b/i);
    }

    var job = {
      id: '',
      title: title,
      company: company,
      location: location,
      url: url,
      sourceUrl: url,
      pageUrl: normalizeSpace(snapshot.url),
      site: site,
      jobInfo: '',
      summary: '',
      qualifications: qualifications,
      responsibilities: responsibilities,
      employmentType: structuredJob ? structuredJob.employmentType : '',
      workplaceType: structuredJob ? structuredJob.workplaceType : '',
      salary: structuredJob ? structuredJob.salary : '',
      datePosted: structuredJob ? structuredJob.datePosted : '',
      validThrough: structuredJob ? structuredJob.validThrough : '',
      sourceSignals: {
        roleCandidates: uniqueStrings(snapshot.roleCandidates || []).length,
        companyCandidates: uniqueStrings(snapshot.companyCandidates || []).length,
        jobInfoCandidates: uniqueStrings(snapshot.jobInfoCandidates || []).length,
        sectionCount: sections.length,
        rootScore: Number(snapshot.rootScore || 0),
        structuredDataJobs: structuredJobs.length,
        jobUrlCandidates: uniqueStrings(snapshot.jobUrlCandidates || []).length
      }
    };

    job.jobInfo = buildJobInfo(job, snapshot, sections, site, structuredJob);
    job.summary = buildSummary(job.jobInfo, snapshot.metaDescription || '', structuredJob);
    job.confidence = calculateConfidence(job, site, job.sourceSignals, structuredJob, snapshot.metaDescription || '');
    job.status = job.confidence >= 70 ? 'ready' : 'needs_review';
    return job;
  }

  return {
    extractJob: extractJob,
    helpers: {
      normalizeSpace: normalizeSpace,
      normalizeMultiline: normalizeMultiline,
      uniqueStrings: uniqueStrings,
      detectSite: detectSite,
      expandCandidates: expandCandidates,
      cleanJobText: cleanJobText,
      htmlToText: htmlToText,
      normalizeStructuredJob: normalizeStructuredJob
    }
  };
}));
