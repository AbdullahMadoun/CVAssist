(function initContentScript() {
  'use strict';

  var ROLE_SELECTORS = [
    '.job-details-jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title a',
    '.jobs-unified-top-card__job-title',
    '.top-card-layout__title',
    '.posting-headline h1',
    '.posting-headline h2',
    '.app-title',
    '.job-title',
    '.job-title-heading',
    '.jobsearch-JobInfoHeader-title',
    '[itemprop="title"]',
    '[itemprop="name"]',
    '[data-testid*="job-title"]',
    '[data-automation-id="jobTitle"]',
    '[data-ui="job-title"]',
    '[class*="job-title"]',
    '[class*="position-title"]',
    '[class*="posting-headline"] h1',
    'main h1',
    'article h1',
    'h1'
  ];

  var COMPANY_SELECTORS = [
    '.job-details-jobs-unified-top-card__company-name',
    '.job-details-jobs-unified-top-card__company-name a',
    '.topcard__org-name-link',
    '.company-name',
    '.jobsearch-InlineCompanyRating div:first-child',
    '.posting-categories__department',
    '[itemprop="hiringOrganization"] [itemprop="name"]',
    '[itemprop="hiringOrganization"]',
    '[data-company]',
    '[data-automation-id="company"]',
    '[data-ui="company-name"]',
    '[class*="company"] a',
    '[class*="company-name"]',
    '[class*="employer"]',
    '[data-testid*="company"]'
  ];

  var LOCATION_SELECTORS = [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.job-details-jobs-unified-top-card__tertiary-description-container',
    '.topcard__flavor--bullet',
    '.location',
    '.job-location',
    '.jobsearch-JobInfoHeader-subtitle',
    '[itemprop="jobLocation"]',
    '[itemprop="jobLocationType"]',
    '[data-automation-id="locations"]',
    '[data-ui="job-location"]',
    '[class*="location"]',
    '[data-testid*="location"]'
  ];

  var ROOT_SELECTORS = [
    '.jobs-search__job-details',
    '.jobs-search__job-details--container',
    '.job-view-layout',
    '.jobs-unified-top-card',
    '.job-details',
    '.job-description',
    '.job-posting',
    '.job-post',
    '.jobsearch-JobComponent',
    '.jobsearch-JobInfoHeader-container',
    '.posting-page',
    '.posting',
    '.careers-job',
    '.job-content',
    '.job-page',
    '.opening',
    '#content',
    '#job-details',
    '#jobDescriptionText',
    '[itemtype*="JobPosting"]',
    'main',
    'article',
    '[role="main"]'
  ];

  var SELECTED_SELECTORS = [
    '.jobs-search-results__list-item--active',
    '[aria-current="page"]',
    '[aria-current="true"]',
    '[aria-selected="true"]',
    '[data-selected="true"]',
    '.selected',
    '.is-selected',
    '.is-active',
    '.active'
  ];

  var JOB_INFO_SELECTORS = [
    '#job-details',
    '#jobDescriptionText',
    '.jobs-box__html-content',
    '.jobs-description__content',
    '.jobs-description',
    '.jobsearch-jobDescriptionText',
    '.jobDescriptionContent',
    '.job-posting__description',
    '.job-description__text',
    '.posting-requirements',
    '.posting-description',
    '.description__text',
    '.content-intro + div',
    '[itemprop="description"]',
    '[data-testid*="job-description"]',
    '[data-automation-id="jobPostingDescription"]',
    '[data-automation-id="jobDescription"]',
    '[data-job-description]',
    '[class*="job-description"]',
    '[class*="description"]'
  ];

  var JOB_LINK_SELECTORS = [
    '.job-details-jobs-unified-top-card__job-title a[href]',
    '.topcard__title a[href]',
    '.job-card-container__link[href]',
    '.job-card-list__title[href]',
    'a[href*="/jobs/view/"]',
    'a[href*="/job/"]',
    'a[href*="/careers/"]',
    'a[href*="greenhouse.io"]',
    'a[href*="lever.co"]',
    'a[href*="ashbyhq.com"]',
    'a[href*="myworkdayjobs.com"]',
    'a[href*="smartrecruiters.com"]',
    'a[href*="workable.com"]',
    'a[href*="ziprecruiter.com"]',
    'a[href*="icims.com"]',
    '[data-job-url]'
  ];

  var HEADING_HINTS = [
    'responsibilit',
    'qualification',
    'requirements',
    'what you will do',
    'what you\'ll do',
    'what you bring',
    'what we are looking for',
    'what we\'re looking for',
    'about the role',
    'basic qualifications',
    'preferred qualifications',
    'skills',
    'experience',
    'day to day',
    'about the job',
    'job summary'
  ];

  var EXTRA_SELECTORS = {
    role: {
      greenhouse: ['#header h1'],
      lever: ['.posting-headline h2', '.posting-headline h1'],
      workday: ['[data-automation-id="jobPostingHeader"] h1', '[data-automation-id="jobPostingHeader"] h2'],
      ashby: ['[data-testid="job-title"]'],
      smartrecruiters: ['.opening-job-title', '.job-title'],
      workable: ['.job-preview h1'],
      indeed: ['.jobsearch-JobInfoHeader-title']
    },
    company: {
      greenhouse: ['#header .company-name'],
      lever: ['.posting-categories .sort-by-time'],
      workday: ['[data-automation-id="company"]'],
      ashby: ['[data-testid="job-company"]'],
      smartrecruiters: ['.opening-job-company']
    },
    location: {
      greenhouse: ['#header .location'],
      lever: ['.posting-categories .location'],
      workday: ['[data-automation-id="locations"]'],
      ashby: ['[data-testid="job-location"]'],
      smartrecruiters: ['.opening-job-location'],
      indeed: ['.jobsearch-JobInfoHeader-subtitle']
    },
    root: {
      greenhouse: ['#content', '#app_body', '.opening'],
      lever: ['.posting-page', '.posting'],
      workday: ['[data-automation-id="jobPostingDescription"]', '[data-automation-id="jobPostingHeader"]'],
      ashby: ['main[data-testid*="job"]', '[data-testid="job-posting"]'],
      smartrecruiters: ['#job-details', '.opening-page'],
      workable: ['.job-preview'],
      indeed: ['#jobsearch-ViewjobPaneWrapper', '.jobsearch-JobComponent'],
      icims: ['#jobDescriptionText', '.iCIMS_JobContent']
    },
    info: {
      greenhouse: ['#content .content', '.opening .content'],
      lever: ['.section-wrapper', '.posting-requirements', '.posting-description'],
      workday: ['[data-automation-id="jobPostingDescription"]'],
      ashby: ['[data-testid="job-description"]'],
      smartrecruiters: ['#job-details .job-sections'],
      workable: ['.job-preview-details'],
      indeed: ['#jobDescriptionText']
    },
    link: {
      greenhouse: ['a[href*="boards.greenhouse.io"]'],
      lever: ['a[href*="jobs.lever.co"]'],
      workday: ['a[href*="myworkdayjobs.com"]'],
      ashby: ['a[href*="jobs.ashbyhq.com"]'],
      smartrecruiters: ['a[href*="smartrecruiters.com"]']
    }
  };

  function detectSite(hostname) {
    var host = String(hostname || '').toLowerCase();
    if (host.indexOf('linkedin.com') >= 0) return 'linkedin';
    if (host.indexOf('greenhouse.io') >= 0) return 'greenhouse';
    if (host.indexOf('lever.co') >= 0) return 'lever';
    if (host.indexOf('myworkdayjobs.com') >= 0) return 'workday';
    if (host.indexOf('ashbyhq.com') >= 0) return 'ashby';
    if (host.indexOf('smartrecruiters.com') >= 0) return 'smartrecruiters';
    if (host.indexOf('workable.com') >= 0) return 'workable';
    if (host.indexOf('indeed.com') >= 0) return 'indeed';
    if (host.indexOf('ziprecruiter.com') >= 0) return 'ziprecruiter';
    if (host.indexOf('icims.com') >= 0) return 'icims';
    return 'generic';
  }

  function selectorsFor(kind, site) {
    var base = {
      role: ROLE_SELECTORS,
      company: COMPANY_SELECTORS,
      location: LOCATION_SELECTORS,
      root: ROOT_SELECTORS,
      info: JOB_INFO_SELECTORS,
      link: JOB_LINK_SELECTORS
    }[kind] || [];
    return base.concat((EXTRA_SELECTORS[kind] && EXTRA_SELECTORS[kind][site]) || []);
  }

  function normalizeSpace(text) {
    return String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeMultiline(text) {
    return String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function clip(text, length) {
    var value = String(text || '').trim();
    if (value.length <= length) return value;
    return value.slice(0, length - 1).trimEnd() + '...';
  }

  function isVisible(element) {
    if (!element) return false;
    var style = window.getComputedStyle(element);
    return style && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function metaContent(selector) {
    var element = document.querySelector(selector);
    return normalizeSpace(element && element.content);
  }

  function linkHref(selector) {
    var element = document.querySelector(selector);
    return absoluteUrl(element && (element.href || element.getAttribute('href') || ''));
  }

  function absoluteUrl(href) {
    var value = normalizeSpace(href);
    if (!value) return '';
    try {
      return new URL(value, window.location.href).href;
    } catch (error) {
      return '';
    }
  }

  function safeJsonParse(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function uniqueElements(elements) {
    var seen = new Set();
    return (elements || []).filter(function keepItem(element) {
      if (!element || seen.has(element)) return false;
      seen.add(element);
      return true;
    });
  }

  function uniqueStrings(values) {
    var seen = new Set();
    return (values || []).map(function mapValue(value) {
      return String(value || '').trim();
    }).filter(function keepValue(value) {
      if (!value) return false;
      var key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function uniqueStructuredJobs(items) {
    var seen = new Set();
    return (items || []).filter(function keepItem(item) {
      if (!item) return false;
      var key = [item.title, item.company, item.url, item.identifier].map(function mapPart(part) {
        return normalizeSpace(part).toLowerCase();
      }).join('|');
      if (!key.replace(/\|/g, '')) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function readText(element, maxLength) {
    var value = normalizeMultiline(element && (element.innerText || element.textContent || ''));
    return maxLength ? clip(value, maxLength) : value;
  }

  function htmlToText(html) {
    if (!html) return '';
    var container = document.createElement('div');
    container.innerHTML = String(html || '');
    return normalizeMultiline(container.innerText || container.textContent || '');
  }

  function firstString(values) {
    var index;
    for (index = 0; index < values.length; index += 1) {
      var value = normalizeSpace(values[index]);
      if (value) return value;
    }
    return '';
  }

  function textFromSchemaValue(value) {
    if (!value) return '';
    if (typeof value === 'string') return normalizeSpace(value);
    if (Array.isArray(value)) return uniqueStrings(value.map(textFromSchemaValue)).join(', ');
    if (typeof value === 'object') {
      return firstString([value.name, value.value, value.text, value.title, value.url, value['@id']]);
    }
    return '';
  }

  function formatSchemaAddress(value) {
    if (!value) return '';
    if (typeof value === 'string') return normalizeSpace(value);
    if (Array.isArray(value)) return uniqueStrings(value.map(formatSchemaAddress)).join(' / ');
    if (typeof value === 'object') {
      var address = value.address || value;
      var parts = [
        address.streetAddress,
        address.addressLocality,
        address.addressRegion,
        address.postalCode,
        address.addressCountry,
        value.name,
        value.addressLocality,
        value.addressRegion,
        value.addressCountry
      ].map(function mapItem(item) {
        return normalizeSpace(item);
      }).filter(Boolean);
      return uniqueStrings(parts).join(', ');
    }
    return '';
  }

  function formatSchemaSalary(value) {
    if (!value) return '';
    if (typeof value === 'string' || typeof value === 'number') return normalizeSpace(value);
    if (Array.isArray(value)) return uniqueStrings(value.map(formatSchemaSalary)).join(' / ');
    if (typeof value === 'object') {
      var currency = normalizeSpace(value.currency || value.currencyCode);
      var unit = normalizeSpace(value.unitText || value.duration || '');
      var amount = value.value && typeof value.value === 'object' ? value.value : value;
      var minValue = normalizeSpace(amount.minValue);
      var maxValue = normalizeSpace(amount.maxValue);
      var exactValue = normalizeSpace(amount.value);
      var figure = exactValue || [minValue, maxValue].filter(Boolean).join(' - ');
      var parts = [];
      if (currency) parts.push(currency);
      if (figure) parts.push(figure);
      if (unit) parts.push(unit);
      return parts.join(' ').trim();
    }
    return '';
  }
  function looksLikeJobPosting(node) {
    if (!node || typeof node !== 'object') return false;
    var type = node['@type'];
    if (typeof type === 'string' && /JobPosting/i.test(type)) return true;
    if (Array.isArray(type) && type.some(function someType(item) { return /JobPosting/i.test(String(item)); })) return true;
    return Boolean(node.title && (node.description || node.hiringOrganization));
  }

  function walkStructuredNodes(node, results, seen) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(function eachItem(item) {
        walkStructuredNodes(item, results, seen);
      });
      return;
    }

    if (looksLikeJobPosting(node)) results.push(node);
    Object.keys(node).forEach(function eachKey(key) {
      if (key === '@context') return;
      walkStructuredNodes(node[key], results, seen);
    });
  }

  function normalizeStructuredJobPosting(node) {
    if (!node || typeof node !== 'object') return null;
    var title = firstString([node.title, node.name]);
    var company = firstString([
      textFromSchemaValue(node.hiringOrganization && node.hiringOrganization.name),
      textFromSchemaValue(node.hiringOrganization),
      textFromSchemaValue(node.organization)
    ]);
    var location = firstString([
      formatSchemaAddress(node.jobLocation),
      formatSchemaAddress(node.applicantLocationRequirements),
      textFromSchemaValue(node.jobLocationType),
      textFromSchemaValue(node.eligibleRegion)
    ]);
    var description = htmlToText(node.description || node.summary || '');
    var employmentType = textFromSchemaValue(node.employmentType);
    var workplaceType = normalizeSpace(node.jobLocationType || '');
    if (/TELECOMMUTE/i.test(workplaceType)) workplaceType = 'Remote';
    var url = absoluteUrl(node.url || node.sameAs || node['@id'] || '');
    var identifier = firstString([
      node.identifier && node.identifier.value,
      node.identifier && node.identifier.name,
      node.identifier
    ]);
    var salary = formatSchemaSalary(node.baseSalary);
    var datePosted = normalizeSpace(node.datePosted || '');
    var validThrough = normalizeSpace(node.validThrough || '');

    if (!title && !description && !company) return null;
    return {
      title: title,
      company: company,
      location: location,
      description: description,
      employmentType: employmentType,
      workplaceType: workplaceType,
      salary: salary,
      datePosted: datePosted,
      validThrough: validThrough,
      url: url,
      identifier: identifier
    };
  }

  function collectJsonLdJobs() {
    var results = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function eachScript(script) {
      var payload = safeJsonParse(script.textContent || '');
      var nodes = [];
      if (!payload) return;
      walkStructuredNodes(payload, nodes, new Set());
      nodes.forEach(function eachNode(node) {
        var normalized = normalizeStructuredJobPosting(node);
        if (normalized) results.push(normalized);
      });
    });
    return results;
  }

  function collectMicrodataJobs() {
    var results = [];
    document.querySelectorAll('[itemtype*="JobPosting"]').forEach(function eachRoot(root) {
      var title = readText(root.querySelector('[itemprop="title"], [itemprop="name"]'), 240);
      var company = readText(root.querySelector('[itemprop="hiringOrganization"] [itemprop="name"], [itemprop="hiringOrganization"]'), 240);
      var location = readText(root.querySelector('[itemprop="jobLocation"], [itemprop="jobLocationType"]'), 240);
      var description = readText(root.querySelector('[itemprop="description"]'), 12000);
      var urlNode = root.querySelector('[itemprop="url"]');
      var url = absoluteUrl(root.getAttribute('itemid') || (urlNode && urlNode.getAttribute('href')) || '');
      var item = normalizeStructuredJobPosting({
        title: title,
        hiringOrganization: company,
        jobLocation: location,
        description: description,
        url: url
      });
      if (item) results.push(item);
    });
    return results;
  }

  function collectStructuredDataJobs() {
    return uniqueStructuredJobs(collectJsonLdJobs().concat(collectMicrodataJobs())).slice(0, 12);
  }

  function findLinkedInJobDetailContainer() {
    var selectors = [
      '.jobs-search__job-details--container',
      '.jobs-search__job-details',
      '.job-view-layout.jobs-details',
      '.jobs-box__html-content',
      '#job-details'
    ];
    for (var index = 0; index < selectors.length; index += 1) {
      var element = document.querySelector(selectors[index]);
      if (element && isVisible(element)) return element;
    }
    return null;
  }

  function collectLinkedInJobInfoText(root, mode) {
    var container = findLinkedInJobDetailContainer();
    if (!container) return '';
    if (mode !== 'whole_site_fallback' && root !== document.body && !root.contains(container)) return '';
    var detail = container.querySelector('#job-details') ||
      container.querySelector('.jobs-box__html-content') ||
      container.querySelector('.jobs-description__content') ||
      container;
    if (!detail) return '';
    var text = readText(detail, mode === 'whole_site_fallback' ? 22000 : 12000);
    return normalizeSpace(text).length ? text : '';
  }

  function queryVisibleTexts(root, selectors, limit) {
    var values = [];
    selectors.forEach(function eachSelector(selector) {
      root.querySelectorAll(selector).forEach(function eachElement(element) {
        if (!isVisible(element)) return;
        var text = normalizeSpace(element.innerText || element.textContent || '');
        if (text) values.push(text);
      });
    });
    return values.slice(0, limit || 20);
  }

  function queryVisibleElements(root, selectors, limit) {
    var values = [];
    selectors.forEach(function eachSelector(selector) {
      root.querySelectorAll(selector).forEach(function eachElement(element) {
        if (isVisible(element)) values.push(element);
      });
    });
    return uniqueElements(values).slice(0, limit || 60);
  }

  function queryVisibleRawTexts(root, selectors, limit, minLength) {
    var values = [];
    queryVisibleElements(root, selectors, limit || 20).forEach(function eachElement(element) {
      var text = readText(element, 12000);
      if (normalizeSpace(text).length >= (minLength || 40)) values.push(text);
    });
    return uniqueStrings(values).slice(0, limit || 20);
  }

  function queryLinks(root, selectors, limit) {
    var values = [];
    selectors.forEach(function eachSelector(selector) {
      root.querySelectorAll(selector).forEach(function eachElement(element) {
        if (element.tagName === 'A' && !isVisible(element)) return;
        var href = '';
        if (element.hasAttribute('href')) href = element.getAttribute('href');
        if (!href && element.hasAttribute('data-job-url')) href = element.getAttribute('data-job-url');
        if (!href) {
          var anchor = element.querySelector('a[href]');
          if (anchor && isVisible(anchor)) href = anchor.getAttribute('href');
        }
        href = absoluteUrl(href);
        if (href) values.push(href);
      });
    });
    return uniqueStrings(values).slice(0, limit || 30);
  }
  function isLikelyJobSelection(element) {
    if (!element || !isVisible(element)) return false;
    if (/^(NAV|HEADER|FOOTER)$/.test(element.tagName)) return false;
    var text = normalizeSpace((element.innerText || element.textContent || '').slice(0, 1400)).toLowerCase();
    if (!text || text.length < 10) return false;
    if (text.length > 1600) return false;
    if (/similar jobs|people also viewed|recommended jobs|sign in|join now/.test(text)) return false;
    if (/engineer|developer|manager|scientist|designer|analyst|director|intern|architect|specialist|consultant/.test(text)) return true;
    if (/job|career|position|role/.test(text)) return true;
    return !!element.querySelector('a[href*="job"], a[href*="career"], h1, h2, h3');
  }

  function nearestScorableContainer(element) {
    var current = element;
    var depth = 0;
    while (current && current !== document.body && depth < 7) {
      if (/^(MAIN|ARTICLE|SECTION|DIV)$/.test(current.tagName)) return current;
      current = current.parentElement;
      depth += 1;
    }
    return element && element.parentElement ? element.parentElement : null;
  }

  function collectCandidateRoots(site) {
    var candidates = [];
    var rootSelectors = selectorsFor('root', site);
    var roleSelectors = selectorsFor('role', site);
    var companySelectors = selectorsFor('company', site);

    rootSelectors.forEach(function eachSelector(selector) {
      document.querySelectorAll(selector).forEach(function eachRoot(element) {
        if (isVisible(element)) candidates.push(element);
      });
    });

    queryVisibleElements(document, roleSelectors, 30)
      .concat(queryVisibleElements(document, companySelectors, 20))
      .forEach(function eachElement(element) {
        var container = nearestScorableContainer(element);
        if (container && isVisible(container)) candidates.push(container);
      });

    queryVisibleElements(document, SELECTED_SELECTORS, 40)
      .filter(isLikelyJobSelection)
      .forEach(function eachSelected(element) {
        var container = nearestScorableContainer(element);
        if (container && isVisible(container)) candidates.push(container);
      });

    document.querySelectorAll('[itemtype*="JobPosting"]').forEach(function eachPostingRoot(element) {
      if (isVisible(element)) candidates.push(element);
    });

    candidates.push(document.body);
    var linkedInRoot = findLinkedInJobDetailContainer();
    if (linkedInRoot) candidates.unshift(linkedInRoot);

    return uniqueElements(candidates);
  }

  function countVisibleListItems(root, limit) {
    var count = 0;
    root.querySelectorAll('li').forEach(function eachItem(item) {
      if (!isVisible(item)) return;
      var text = normalizeSpace(item.innerText || item.textContent || '');
      if (text.length >= 8) count += 1;
    });
    return Math.min(count, limit || 999);
  }

  function headingScore(root) {
    var score = 0;
    root.querySelectorAll('h1, h2, h3, h4, [role="heading"]').forEach(function eachHeading(heading) {
      if (!isVisible(heading)) return;
      var text = normalizeSpace(heading.innerText || heading.textContent || '').toLowerCase();
      if (!text) return;
      if (HEADING_HINTS.some(function someHint(hint) { return text.includes(hint); })) score += 4;
    });
    return score;
  }

  function rootScore(root, site) {
    if (!root || !isVisible(root)) return -999;
    if (/^(NAV|HEADER|FOOTER|ASIDE)$/.test(root.tagName)) return -500;

    var score = 0;
    var roleSelectors = selectorsFor('role', site);
    var companySelectors = selectorsFor('company', site);
    var locationSelectors = selectorsFor('location', site);
    var infoSelectors = selectorsFor('info', site);
    var text = normalizeSpace((root.innerText || root.textContent || '').slice(0, 18000));
    var textLength = text.length;
    var listCount = countVisibleListItems(root, 120);
    var roleCount = queryVisibleTexts(root, roleSelectors, 5).length;
    var companyCount = queryVisibleTexts(root, companySelectors, 5).length;
    var locationCount = queryVisibleTexts(root, locationSelectors, 5).length;
    var jobInfoCount = queryVisibleElements(root, infoSelectors, 8).length;
    var headingHintScore = headingScore(root);
    var relatedLinks = 0;
    var forms = root.querySelectorAll('input, textarea, select').length;
    var className = normalizeSpace(root.className || '');

    root.querySelectorAll('a[href]').forEach(function eachAnchor(anchor) {
      if (relatedLinks >= 25) return;
      var href = String(anchor.getAttribute('href') || '');
      if (/jobs|careers|job\/?\d|view\//i.test(href)) relatedLinks += 1;
    });

    if (/^(MAIN|ARTICLE|SECTION)$/.test(root.tagName)) score += 4;
    if (roleCount) score += 10;
    if (companyCount) score += 6;
    if (locationCount) score += 2;
    if (jobInfoCount) score += 8;
    if (textLength >= 400) score += 6;
    if (textLength >= 1200) score += 5;
    if (textLength > 22000) score -= 6;
    if (listCount >= 3) score += 4;
    if (listCount >= 8) score += 3;
    if (listCount > 80) score -= 4;
    score += Math.min(headingHintScore, 16);
    if (roleCount && headingHintScore) score += 6;
    if (relatedLinks > 12) score -= 6;
    if (/similar jobs|related jobs|recommended jobs|people also viewed/i.test(text)) score -= 5;
    if (/job|posting|career|description/.test(className.toLowerCase())) score += 3;
    if (forms > 12) score -= 4;

    return score;
  }

  function chooseJobRoot(site) {
    var candidates = collectCandidateRoots(site);
    var bestRoot = document.body;
    var bestScore = -999;

    candidates.forEach(function eachRoot(root) {
      var score = rootScore(root, site);
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
      }
    });

    return {
      root: bestRoot,
      score: bestScore
    };
  }

  function collectSections(root) {
    var sections = [];
    var headings = root.querySelectorAll('h1, h2, h3, h4, [role="heading"]');

    headings.forEach(function eachHeading(heading) {
      if (!isVisible(heading)) return;
      var headingText = normalizeSpace(heading.innerText || heading.textContent || '');
      if (!headingText || headingText.length > 120) return;

      var cursor = heading.nextElementSibling;
      var textBlocks = [];
      var items = [];
      var steps = 0;

      while (cursor && steps < 8) {
        if (/^(H1|H2|H3|H4)$/.test(cursor.tagName) || cursor.getAttribute('role') === 'heading') break;
        if (isVisible(cursor)) {
          var text = normalizeMultiline(cursor.innerText || cursor.textContent || '');
          if (normalizeSpace(text)) textBlocks.push(text);
          cursor.querySelectorAll('li').forEach(function eachLi(li) {
            if (!isVisible(li)) return;
            var liText = normalizeSpace(li.innerText || li.textContent || '');
            if (liText.length >= 8) items.push(liText);
          });
        }
        cursor = cursor.nextElementSibling;
        steps += 1;
      }

      if (textBlocks.length || items.length) {
        sections.push({ heading: headingText, text: textBlocks.join('\n'), items: items });
      }
    });

    root.querySelectorAll('dl').forEach(function eachList(list) {
      list.querySelectorAll('dt').forEach(function eachTerm(term) {
        if (!isVisible(term)) return;
        var headingText = normalizeSpace(term.innerText || term.textContent || '');
        var detail = term.nextElementSibling;
        if (!headingText || !detail || !isVisible(detail)) return;
        var detailText = normalizeMultiline(detail.innerText || detail.textContent || '');
        if (!detailText) return;
        sections.push({ heading: headingText, text: detailText, items: [] });
      });
    });

    return sections.slice(0, 36);
  }

  function linkedInCurrentJobId() {
    var match = window.location.href.match(/[?&]currentJobId=(\d+)/i);
    return match ? match[1] : '';
  }

  function linkedInCurrentJobUrl() {
    var jobId = linkedInCurrentJobId();
    if (!jobId) return '';
    return 'https://www.linkedin.com/jobs/view/' + jobId + '/';
  }

  function findLinkedInCurrentJobCard() {
    var jobId = linkedInCurrentJobId();
    var selectors = [];
    if (jobId) {
      selectors = [
        '[data-job-id="' + jobId + '"]',
        'li[data-occludable-job-id="' + jobId + '"] .job-card-container',
        'li[data-occludable-job-id="' + jobId + '"]'
      ];
    }

    for (var index = 0; index < selectors.length; index += 1) {
      var element = document.querySelector(selectors[index]);
      if (!element) continue;
      if (element.matches('.job-card-container') || element.hasAttribute('data-job-id')) return element;
      var card = element.querySelector('.job-card-container') || element.querySelector('[data-job-id]');
      if (card) return card;
    }

    var selected = queryVisibleElements(document, SELECTED_SELECTORS, 10).filter(isLikelyJobSelection)[0];
    if (!selected) return null;
    return selected.matches('.job-card-container') ? selected : (selected.querySelector('.job-card-container') || selected);
  }

  function buildLinkedInStrictSnapshot(structuredData) {
    if (window.location.hostname.indexOf('linkedin.com') < 0) return null;

    var detailRoot = findLinkedInJobDetailContainer();
    if (!detailRoot) return null;

    var detailNode = detailRoot.querySelector('#job-details') ||
      detailRoot.querySelector('.jobs-box__html-content') ||
      detailRoot.querySelector('.jobs-description__content');
    var detailText = readText(detailNode || detailRoot, 14000);
    if (normalizeSpace(detailText).length < 120) return null;

    var card = findLinkedInCurrentJobCard();
    var cardRoot = card && (card.matches('.job-card-container') || card.hasAttribute('data-job-id'))
      ? card
      : (card ? (card.querySelector('.job-card-container') || card.querySelector('[data-job-id]') || card) : null);

    var roleCandidates = [];
    var companyCandidates = [];
    var locationCandidates = [];
    var jobUrlCandidates = [];

    if (cardRoot) {
      roleCandidates = roleCandidates.concat(queryVisibleTexts(cardRoot, [
        '.job-card-container__link',
        '.job-card-list__title--link',
        '.artdeco-entity-lockup__title a'
      ], 5));
      companyCandidates = companyCandidates.concat(queryVisibleTexts(cardRoot, [
        '.artdeco-entity-lockup__subtitle',
        '.job-card-container__primary-description',
        '.job-card-container__company-name'
      ], 5));
      locationCandidates = locationCandidates.concat(queryVisibleTexts(cardRoot, [
        '.job-card-container__metadata-wrapper',
        '.artdeco-entity-lockup__caption',
        '.job-card-container__metadata-item'
      ], 5));
      jobUrlCandidates = jobUrlCandidates.concat(queryLinks(cardRoot, [
        'a[href*="/jobs/view/"]',
        '.job-card-container__link[href]'
      ], 5));
    }

    roleCandidates = roleCandidates.concat(queryVisibleTexts(detailRoot, [
      '.job-details-jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title a'
    ], 5));
    companyCandidates = companyCandidates.concat(queryVisibleTexts(detailRoot, [
      '.job-details-jobs-unified-top-card__company-name',
      '.job-details-jobs-unified-top-card__company-name a'
    ], 5));
    locationCandidates = locationCandidates.concat(queryVisibleTexts(detailRoot, [
      '.job-details-jobs-unified-top-card__primary-description-container',
      '.job-details-jobs-unified-top-card__tertiary-description-container'
    ], 5));
    jobUrlCandidates = jobUrlCandidates.concat(queryLinks(detailRoot, [
      '.job-details-jobs-unified-top-card__job-title a[href]'
    ], 5));

    var ariaLabel = normalizeSpace(detailRoot.getAttribute('aria-label') || '');
    if (ariaLabel) roleCandidates.unshift(ariaLabel);

    var directLinkedInUrl = linkedInCurrentJobUrl();
    if (directLinkedInUrl) jobUrlCandidates.unshift(directLinkedInUrl);

    var listItems = [];
    (detailNode || detailRoot).querySelectorAll('li').forEach(function eachItem(item) {
      if (!isVisible(item)) return;
      var text = normalizeSpace(item.innerText || item.textContent || '');
      if (text.length >= 8) listItems.push(text);
    });

    return {
      hostname: window.location.hostname,
      url: window.location.href,
      documentTitle: document.title,
      metaTitle: metaContent('meta[property="og:title"]') || metaContent('meta[name="twitter:title"]'),
      metaDescription: metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]'),
      metaSiteName: metaContent('meta[property="og:site_name"]'),
      roleCandidates: uniqueStrings(roleCandidates).slice(0, 12),
      companyCandidates: uniqueStrings(companyCandidates).slice(0, 12),
      locationCandidates: uniqueStrings(locationCandidates).slice(0, 12),
      jobUrlCandidates: uniqueStrings(jobUrlCandidates).slice(0, 12),
      jobInfoCandidates: [detailText],
      sections: collectSections(detailNode || detailRoot),
      listItems: uniqueStrings(listItems).slice(0, 80),
      bodyText: detailText,
      rootScore: 100,
      rootTag: detailRoot.tagName,
      rootClassName: normalizeSpace(detailRoot.className || ''),
      scrapeMode: 'linkedin_strict_highlight',
      highlightedSelectionCount: cardRoot ? 1 : 0,
      structuredData: structuredData || []
    };
  }

  function collectHighlightedContext(site) {
    if (site === 'linkedin') {
      var card = findLinkedInCurrentJobCard();
      if (card) {
        return {
          selectedCount: 1,
          roleCandidates: queryVisibleTexts(card, [
            '.job-card-container__link',
            '.job-card-list__title--link',
            '.artdeco-entity-lockup__title a'
          ], 12),
          companyCandidates: queryVisibleTexts(card, [
            '.artdeco-entity-lockup__subtitle',
            '.job-card-container__primary-description',
            '.job-card-container__company-name'
          ], 12),
          locationCandidates: queryVisibleTexts(card, [
            '.job-card-container__metadata-wrapper',
            '.artdeco-entity-lockup__caption',
            '.job-card-container__metadata-item'
          ], 12),
          jobUrlCandidates: uniqueStrings([].concat(
            queryLinks(card, ['a[href*="/jobs/view/"]', '.job-card-container__link[href]'], 6),
            linkedInCurrentJobUrl() ? [linkedInCurrentJobUrl()] : []
          )).slice(0, 12)
        };
      }
    }

    var roleSelectors = selectorsFor('role', site);
    var companySelectors = selectorsFor('company', site);
    var locationSelectors = selectorsFor('location', site);
    var linkSelectors = selectorsFor('link', site);
    var selectedElements = queryVisibleElements(document, SELECTED_SELECTORS, 50).filter(isLikelyJobSelection);
    var roleCandidates = [];
    var companyCandidates = [];
    var locationCandidates = [];
    var jobUrlCandidates = [];

    selectedElements.forEach(function eachElement(element) {
      roleCandidates = roleCandidates.concat(queryVisibleTexts(element, roleSelectors, 5));
      companyCandidates = companyCandidates.concat(queryVisibleTexts(element, companySelectors, 5));
      locationCandidates = locationCandidates.concat(queryVisibleTexts(element, locationSelectors, 5));
      jobUrlCandidates = jobUrlCandidates.concat(queryLinks(element, linkSelectors, 6));

      element.querySelectorAll('h1, h2, h3').forEach(function eachHeading(heading) {
        if (!isVisible(heading)) return;
        var text = normalizeSpace(heading.innerText || heading.textContent || '');
        if (text) roleCandidates.push(text);
      });
    });

    var linkedInUrl = linkedInCurrentJobUrl();
    if (linkedInUrl) jobUrlCandidates.unshift(linkedInUrl);

    return {
      selectedCount: selectedElements.length,
      roleCandidates: uniqueStrings(roleCandidates).slice(0, 12),
      companyCandidates: uniqueStrings(companyCandidates).slice(0, 12),
      locationCandidates: uniqueStrings(locationCandidates).slice(0, 12),
      jobUrlCandidates: uniqueStrings(jobUrlCandidates).slice(0, 12)
    };
  }
  function collectJobInfoCandidates(root, mode, structuredData, site) {
    var candidates = [];
    var infoSelectors = selectorsFor('info', site);

    candidates = candidates.concat(queryVisibleRawTexts(root, infoSelectors, 20, 80));
    var linkedInText = collectLinkedInJobInfoText(root, mode);
    if (linkedInText) candidates.unshift(linkedInText);
    if (structuredData && structuredData.length) {
      candidates = candidates.concat(structuredData.map(function mapItem(item) {
        return item.description;
      }).filter(Boolean));
    }

    if (!candidates.length || mode === 'whole_site_fallback') {
      var rootText = readText(root, mode === 'whole_site_fallback' ? 22000 : 12000);
      if (normalizeSpace(rootText).length >= 120) candidates.push(rootText);
    }

    return uniqueStrings(candidates).slice(0, 20);
  }

  function collectJobUrlCandidates(root, highlighted, structuredData, site) {
    var candidates = [];
    var canonical = linkHref('link[rel="canonical"]');
    var ogUrl = absoluteUrl(metaContent('meta[property="og:url"]'));
    var currentUrl = absoluteUrl(window.location.href);
    var directLinkedInUrl = linkedInCurrentJobUrl();
    var linkSelectors = selectorsFor('link', site);

    if (directLinkedInUrl) candidates.push(directLinkedInUrl);
    if (structuredData && structuredData.length) {
      candidates = candidates.concat(structuredData.map(function mapItem(item) {
        return item.url;
      }).filter(Boolean));
    }
    if (highlighted && highlighted.jobUrlCandidates) candidates = candidates.concat(highlighted.jobUrlCandidates);
    candidates = candidates.concat(queryLinks(root, linkSelectors, 30));
    if (canonical) candidates.push(canonical);
    if (ogUrl) candidates.push(ogUrl);
    if (currentUrl) candidates.push(currentUrl);

    return uniqueStrings(candidates).slice(0, 30);
  }

  function buildStructuredDataSnapshot(structuredData, highlighted) {
    if (!structuredData || !structuredData.length) return null;

    var descriptions = structuredData.map(function mapItem(item) {
      return item.description;
    }).filter(Boolean);
    var listItems = [];

    descriptions.forEach(function eachDescription(description) {
      normalizeMultiline(description).split('\n').forEach(function eachLine(line) {
        var value = normalizeSpace(line.replace(/^[-\u2022*]+\s*/, ''));
        if (value.length >= 8) listItems.push(value);
      });
    });

    return {
      hostname: window.location.hostname,
      url: window.location.href,
      documentTitle: document.title,
      metaTitle: metaContent('meta[property="og:title"]') || metaContent('meta[name="twitter:title"]'),
      metaDescription: metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]'),
      metaSiteName: metaContent('meta[property="og:site_name"]'),
      roleCandidates: uniqueStrings((highlighted.roleCandidates || []).concat(structuredData.map(function mapItem(item) { return item.title; }))).slice(0, 12),
      companyCandidates: uniqueStrings((highlighted.companyCandidates || []).concat(structuredData.map(function mapItem(item) { return item.company; }))).slice(0, 12),
      locationCandidates: uniqueStrings((highlighted.locationCandidates || []).concat(structuredData.map(function mapItem(item) { return item.location || item.workplaceType; }))).slice(0, 12),
      jobUrlCandidates: uniqueStrings((highlighted.jobUrlCandidates || []).concat(structuredData.map(function mapItem(item) { return item.url; }))).slice(0, 12),
      jobInfoCandidates: uniqueStrings(descriptions).slice(0, 12),
      sections: [],
      listItems: uniqueStrings(listItems).slice(0, 80),
      bodyText: descriptions.join('\n\n'),
      rootScore: 26,
      rootTag: 'SCRIPT',
      rootClassName: 'jobposting-structured-data',
      scrapeMode: 'structured_data',
      highlightedSelectionCount: highlighted.selectedCount || 0,
      structuredData: structuredData
    };
  }

  function buildSnapshot(root, rootScoreValue, mode, highlighted, structuredData, site) {
    var roleSelectors = selectorsFor('role', site);
    var companySelectors = selectorsFor('company', site);
    var locationSelectors = selectorsFor('location', site);
    var listItems = [];

    root.querySelectorAll('li').forEach(function eachItem(item) {
      if (!isVisible(item)) return;
      var text = normalizeSpace(item.innerText || item.textContent || '');
      if (text.length >= 8) listItems.push(text);
    });

    return {
      hostname: window.location.hostname,
      url: window.location.href,
      documentTitle: document.title,
      metaTitle: metaContent('meta[property="og:title"]') || metaContent('meta[name="twitter:title"]'),
      metaDescription: metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]'),
      metaSiteName: metaContent('meta[property="og:site_name"]'),
      roleCandidates: uniqueStrings((highlighted.roleCandidates || []).concat(queryVisibleTexts(root, roleSelectors, 20))).slice(0, 20),
      companyCandidates: uniqueStrings((highlighted.companyCandidates || []).concat(queryVisibleTexts(root, companySelectors, 20))).slice(0, 20),
      locationCandidates: uniqueStrings((highlighted.locationCandidates || []).concat(queryVisibleTexts(root, locationSelectors, 20))).slice(0, 20),
      jobUrlCandidates: collectJobUrlCandidates(root, highlighted, structuredData, site),
      jobInfoCandidates: collectJobInfoCandidates(root, mode, structuredData, site),
      sections: collectSections(root),
      listItems: uniqueStrings(listItems).slice(0, 180),
      bodyText: readText(root, 24000),
      rootScore: rootScoreValue,
      rootTag: root.tagName,
      rootClassName: normalizeSpace(root.className || ''),
      scrapeMode: mode,
      highlightedSelectionCount: highlighted.selectedCount || 0,
      structuredData: structuredData || []
    };
  }

  function completenessScore(job) {
    var score = 0;
    if (job.title) score += 20;
    if (job.company) score += 15;
    if (job.location) score += 5;
    if (job.url) score += 10;
    if ((job.jobInfo || '').length >= 250) score += 15;
    if ((job.jobInfo || '').length >= 800) score += 15;
    if ((job.qualifications || []).length >= 2) score += 5;
    if ((job.responsibilities || []).length >= 2) score += 5;
    return score + Number(job.confidence || 0);
  }

  function mergeJobs(primaryJob, fallbackJob) {
    var merged = Object.assign({}, fallbackJob || {}, primaryJob || {});
    if (!merged.title) merged.title = fallbackJob.title || '';
    if (!merged.company) merged.company = fallbackJob.company || '';
    if (!merged.location) merged.location = fallbackJob.location || '';
    if (!merged.url) merged.url = fallbackJob.url || '';
    if (!merged.sourceUrl) merged.sourceUrl = fallbackJob.sourceUrl || fallbackJob.url || '';
    if (!merged.pageUrl) merged.pageUrl = fallbackJob.pageUrl || '';
    if (!merged.sourcePageTitle) merged.sourcePageTitle = fallbackJob.sourcePageTitle || '';
    if (!merged.jobInfo || merged.jobInfo.length < fallbackJob.jobInfo.length) merged.jobInfo = fallbackJob.jobInfo || merged.jobInfo || '';
    if (!merged.summary || (fallbackJob.summary || '').length > merged.summary.length) merged.summary = fallbackJob.summary || merged.summary || '';
    if (!(merged.qualifications || []).length) merged.qualifications = fallbackJob.qualifications || [];
    if (!(merged.responsibilities || []).length) merged.responsibilities = fallbackJob.responsibilities || [];
    if (!merged.employmentType) merged.employmentType = fallbackJob.employmentType || '';
    if (!merged.workplaceType) merged.workplaceType = fallbackJob.workplaceType || '';
    if (!merged.salary) merged.salary = fallbackJob.salary || '';
    if (!merged.datePosted) merged.datePosted = fallbackJob.datePosted || '';
    if (!merged.validThrough) merged.validThrough = fallbackJob.validThrough || '';
    merged.sourceSignals = Object.assign({}, fallbackJob.sourceSignals || {}, primaryJob.sourceSignals || {});
    merged.captureMeta = Object.assign({}, fallbackJob.captureMeta || {}, primaryJob.captureMeta || {});
    merged.confidence = Math.max(Number(primaryJob.confidence || 0), Math.max(0, Number(fallbackJob.confidence || 0) - 8));
    merged.status = merged.confidence >= 70 ? 'ready' : 'needs_review';
    merged.sourceMode = primaryJob.sourceMode === fallbackJob.sourceMode
      ? primaryJob.sourceMode
      : primaryJob.sourceMode + '+' + fallbackJob.sourceMode;
    return merged;
  }

  function chooseBestJobVariant(focusedJob, fallbackJob) {
    var merged = mergeJobs(focusedJob, fallbackJob);
    var focusedScore = completenessScore(focusedJob);
    var fallbackScore = completenessScore(fallbackJob);
    var mergedScore = completenessScore(merged);

    if ((focusedJob.title ? 1 : 0) + (focusedJob.company ? 1 : 0) === 0 && fallbackScore > focusedScore + 12) {
      return fallbackJob;
    }

    if (fallbackScore > mergedScore + 10 && fallbackJob.title && fallbackJob.company) {
      return fallbackJob;
    }

    return mergedScore >= focusedScore ? merged : focusedJob;
  }

  function chooseBestJobSet(jobs) {
    var validJobs = (jobs || []).filter(Boolean);
    if (!validJobs.length) return null;
    return validJobs.reduce(function reduceBest(best, job) {
      if (!best) return job;
      return chooseBestJobVariant(best, job);
    }, null);
  }

  function buildCaptureMeta(snapshot, extra) {
    return Object.assign({
      captureChannel: 'chrome_extension',
      captureVersion: 2,
      engine: 'smart_multi_strategy',
      selectedMode: snapshot && snapshot.scrapeMode ? snapshot.scrapeMode : '',
      rootScore: snapshot && snapshot.rootScore ? snapshot.rootScore : 0,
      rootTag: snapshot && snapshot.rootTag ? snapshot.rootTag : '',
      rootClassName: snapshot && snapshot.rootClassName ? snapshot.rootClassName : '',
      sectionCount: snapshot && snapshot.sections ? snapshot.sections.length : 0,
      listItemCount: snapshot && snapshot.listItems ? snapshot.listItems.length : 0,
      highlightedSelectionCount: snapshot && snapshot.highlightedSelectionCount ? snapshot.highlightedSelectionCount : 0,
      structuredDataJobs: snapshot && snapshot.structuredData ? snapshot.structuredData.length : 0,
      pageTitle: snapshot && snapshot.documentTitle ? snapshot.documentTitle : document.title,
      hostname: snapshot && snapshot.hostname ? snapshot.hostname : window.location.hostname
    }, extra || {});
  }

  function enrichCapturedJob(job, snapshot, extra) {
    var next = Object.assign({}, job || {});
    next.captureMeta = buildCaptureMeta(snapshot, Object.assign({}, next.captureMeta || {}, extra || {}));
    next.sourceUrl = next.sourceUrl || next.url || '';
    next.url = next.url || next.sourceUrl || '';
    return next;
  }

  function collectSnapshotBundle() {
    var site = detectSite(window.location.hostname);
    var structuredData = collectStructuredDataJobs();
    var highlighted = collectHighlightedContext(site);
    var focusedChoice = chooseJobRoot(site);
    return {
      site: site,
      structuredData: structuredData,
      focusedSnapshot: buildSnapshot(focusedChoice.root || document.body, focusedChoice.score, 'focused_root', highlighted, structuredData, site),
      wholeSiteSnapshot: buildSnapshot(document.body, Math.min(focusedChoice.score, 10), 'whole_site_fallback', highlighted, structuredData, site),
      structuredSnapshot: buildStructuredDataSnapshot(structuredData, highlighted)
    };
  }
  function buildEmergencyJob(reason) {
    var structuredData = collectStructuredDataJobs();
    var structuredSnapshot = buildStructuredDataSnapshot(structuredData, { selectedCount: 0, roleCandidates: [], companyCandidates: [], locationCandidates: [], jobUrlCandidates: [] });
    if (structuredSnapshot) {
      var structuredJob = JobExtractorCore.extractJob(structuredSnapshot);
      structuredJob.sourceMode = 'structured_data_emergency';
      structuredJob.sourceUrl = structuredJob.url || window.location.href;
      structuredJob.sourcePageTitle = structuredSnapshot.documentTitle || document.title || structuredJob.title || '';
      return enrichCapturedJob(structuredJob, structuredSnapshot, { fallbackReason: reason || '' });
    }

    var strictSnapshot = buildLinkedInStrictSnapshot(structuredData);
    if (strictSnapshot) {
      var strictJob = JobExtractorCore.extractJob(strictSnapshot);
      var strictUrl = strictJob.url || linkedInCurrentJobUrl() || window.location.href;
      return enrichCapturedJob({
        id: '',
        title: strictJob.title || 'Captured job',
        company: strictJob.company || 'Unknown company',
        location: strictJob.location || '',
        url: strictUrl,
        sourceUrl: strictUrl,
        pageUrl: window.location.href,
        sourcePageTitle: strictSnapshot.documentTitle || document.title || strictJob.title || '',
        site: strictJob.site || window.location.hostname,
        jobInfo: strictJob.jobInfo || clip(strictSnapshot.bodyText || '', 12000),
        summary: strictJob.summary || '',
        qualifications: strictJob.qualifications || [],
        responsibilities: strictJob.responsibilities || [],
        confidence: Math.max(20, Number(strictJob.confidence || 0)),
        status: 'needs_review',
        sourceMode: 'document_emergency_fallback',
        fallbackReason: reason || ''
      }, strictSnapshot, { fallbackReason: reason || '' });
    }

    var firstHeading = document.querySelector('main h1, article h1, h1');
    var title = normalizeSpace((firstHeading && firstHeading.innerText) || document.title || 'Captured job');
    var company = metaContent('meta[property="og:site_name"]') || window.location.hostname.replace(/^www\./, '');
    var location = queryVisibleTexts(document, selectorsFor('location', detectSite(window.location.hostname)), 1)[0] || '';
    var bodyText = readText(document.body, 8000);
    var sourceUrl = collectJobUrlCandidates(document.body, { jobUrlCandidates: [linkedInCurrentJobUrl()] }, structuredData, detectSite(window.location.hostname)).filter(Boolean)[0] || window.location.href;
    var jobInfoParts = [];

    if (title) jobInfoParts.push('Title: ' + title);
    if (company) jobInfoParts.push('Company: ' + company);
    if (location) jobInfoParts.push('Location: ' + location);
    if (bodyText) jobInfoParts.push(bodyText);

    return enrichCapturedJob({
      id: '',
      title: title || 'Captured job',
      company: company || 'Unknown company',
      location: location,
      url: sourceUrl,
      sourceUrl: sourceUrl,
      pageUrl: window.location.href,
      sourcePageTitle: document.title || title || '',
      site: window.location.hostname,
      jobInfo: clip(jobInfoParts.join('\n\n'), 12000),
      summary: '',
      qualifications: [],
      responsibilities: [],
      confidence: 20,
      status: 'needs_review',
      sourceMode: 'document_emergency_fallback',
      fallbackReason: reason || ''
    }, {
      hostname: window.location.hostname,
      documentTitle: document.title,
      scrapeMode: 'document_emergency_fallback',
      rootScore: -1,
      rootTag: 'BODY',
      rootClassName: '',
      sections: [],
      listItems: [],
      highlightedSelectionCount: 0,
      structuredData: structuredData
    }, { fallbackReason: reason || '' });
  }

  chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
    if (!message || message.type !== 'SCRAPE_JOB') return;

    try {
      var bundle = collectSnapshotBundle();
      var strictSnapshot = buildLinkedInStrictSnapshot(bundle.structuredData);
      if (strictSnapshot) {
        var strictJob = JobExtractorCore.extractJob(strictSnapshot);
        strictJob.sourceMode = 'linkedin_strict_highlight';
        strictJob.sourceUrl = strictJob.url;
        strictJob.sourcePageTitle = strictSnapshot.documentTitle;
        strictJob = enrichCapturedJob(strictJob, strictSnapshot, {
          strategies: ['linkedin_strict_highlight', 'structured_data', 'emergency_merge']
        });
        strictJob = mergeJobs(strictJob, buildEmergencyJob('merge_missing_fields'));

        if (strictJob.title && strictJob.sourceUrl && strictJob.jobInfo && strictJob.jobInfo.length >= 120) {
          sendResponse({
            ok: true,
            job: strictJob,
            snapshot: {
              site: strictSnapshot.hostname,
              sections: strictSnapshot.sections.length,
              listItems: strictSnapshot.listItems.length,
              rootScore: strictSnapshot.rootScore,
              rootTag: strictSnapshot.rootTag,
              rootClassName: strictSnapshot.rootClassName,
              sourceMode: strictJob.sourceMode,
              highlightedSelectionCount: strictSnapshot.highlightedSelectionCount,
              structuredDataJobs: strictSnapshot.structuredData.length
            }
          });
          return true;
        }
      }

      var variants = [];
      var focusedJob = JobExtractorCore.extractJob(bundle.focusedSnapshot);
      focusedJob.sourceMode = 'focused_root';
      focusedJob.sourceUrl = focusedJob.url;
      focusedJob.sourcePageTitle = bundle.focusedSnapshot.documentTitle;
      variants.push(enrichCapturedJob(focusedJob, bundle.focusedSnapshot, { strategies: ['focused_root', 'structured_data'] }));

      var wholeSiteJob = JobExtractorCore.extractJob(bundle.wholeSiteSnapshot);
      wholeSiteJob.sourceMode = 'whole_site_fallback';
      wholeSiteJob.sourceUrl = wholeSiteJob.url;
      wholeSiteJob.sourcePageTitle = bundle.wholeSiteSnapshot.documentTitle;
      variants.push(enrichCapturedJob(wholeSiteJob, bundle.wholeSiteSnapshot, { strategies: ['whole_site_fallback', 'structured_data'] }));

      if (bundle.structuredSnapshot) {
        var structuredJob = JobExtractorCore.extractJob(bundle.structuredSnapshot);
        structuredJob.sourceMode = 'structured_data';
        structuredJob.sourceUrl = structuredJob.url;
        structuredJob.sourcePageTitle = bundle.structuredSnapshot.documentTitle;
        variants.push(enrichCapturedJob(structuredJob, bundle.structuredSnapshot, { strategies: ['structured_data'] }));
      }

      var chosenJob = chooseBestJobSet(variants) || variants[0];
      chosenJob = mergeJobs(chosenJob, buildEmergencyJob('merge_missing_fields'));
      chosenJob = enrichCapturedJob(chosenJob, bundle.focusedSnapshot, {
        strategies: uniqueStrings([].concat(chosenJob.captureMeta && chosenJob.captureMeta.strategies || [], chosenJob.sourceMode ? [chosenJob.sourceMode] : []))
      });

      sendResponse({
        ok: true,
        job: chosenJob,
        snapshot: {
          site: bundle.focusedSnapshot.hostname,
          sections: bundle.focusedSnapshot.sections.length,
          listItems: bundle.focusedSnapshot.listItems.length,
          rootScore: bundle.focusedSnapshot.rootScore,
          rootTag: bundle.focusedSnapshot.rootTag,
          rootClassName: bundle.focusedSnapshot.rootClassName,
          sourceMode: chosenJob.sourceMode,
          highlightedSelectionCount: bundle.focusedSnapshot.highlightedSelectionCount,
          structuredDataJobs: bundle.structuredData.length
        }
      });
    } catch (error) {
      var emergencyJob = buildEmergencyJob(error && error.message ? error.message : 'unexpected_error');
      sendResponse({
        ok: true,
        job: emergencyJob,
        snapshot: {
          site: window.location.hostname,
          sections: 0,
          listItems: 0,
          rootScore: -1,
          rootTag: 'BODY',
          rootClassName: '',
          sourceMode: emergencyJob.sourceMode,
          highlightedSelectionCount: 0,
          structuredDataJobs: emergencyJob.captureMeta && emergencyJob.captureMeta.structuredDataJobs || 0,
          error: error && error.message ? error.message : 'unexpected_error'
        }
      });
    }

    return true;
  });

}());
