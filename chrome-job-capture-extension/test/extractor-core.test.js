const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const extractor = require(path.join(__dirname, '..', 'lib', 'extractor-core.js'));

test('extracts structured LinkedIn-like job data', () => {
  const job = extractor.extractJob({
    hostname: 'www.linkedin.com',
    url: 'https://www.linkedin.com/jobs/view/123',
    documentTitle: 'Machine Learning Engineer | Example AI',
    roleCandidates: ['Machine Learning Engineer'],
    companyCandidates: ['Example AI'],
    locationCandidates: ['Riyadh, Saudi Arabia (Hybrid)'],
    sections: [
      {
        heading: 'Responsibilities',
        text: '',
        items: [
          'Build and deploy production ML systems.',
          'Partner with product and engineering teams.'
        ]
      },
      {
        heading: 'Qualifications',
        text: '',
        items: [
          '3+ years of Python experience.',
          'Experience with PyTorch and model serving.',
          'Strong SQL skills.'
        ]
      }
    ],
    listItems: [],
    bodyText: 'Build and deploy production ML systems. Experience with PyTorch and model serving.',
    rootScore: 18,
    structuredData: []
  });

  assert.equal(job.site, 'linkedin');
  assert.equal(job.title, 'Machine Learning Engineer');
  assert.equal(job.company, 'Example AI');
  assert.match(job.location, /Riyadh/);
  assert.ok(/PyTorch/i.test(job.jobInfo));
  assert.ok(job.qualifications.length >= 2);
  assert.ok(job.responsibilities.length >= 2);
  assert.ok(job.confidence >= 70);
});

test('uses structured data when DOM candidates are weak', () => {
  const job = extractor.extractJob({
    hostname: 'jobs.example.myworkdayjobs.com',
    url: 'https://jobs.example.myworkdayjobs.com/en-US/careers/job/123',
    documentTitle: 'Careers',
    roleCandidates: ['Careers'],
    companyCandidates: [],
    locationCandidates: [],
    sections: [],
    listItems: [],
    bodyText: '',
    rootScore: 4,
    structuredData: [
      {
        title: 'Senior Data Engineer',
        company: 'Example Labs',
        location: 'Remote',
        description: 'Design and maintain reliable ETL systems. Own Spark pipelines.',
        employmentType: 'Full-time',
        workplaceType: 'Remote',
        url: 'https://jobs.example.myworkdayjobs.com/en-US/careers/job/123'
      }
    ]
  });

  assert.equal(job.site, 'workday');
  assert.equal(job.title, 'Senior Data Engineer');
  assert.equal(job.company, 'Example Labs');
  assert.equal(job.location, 'Remote');
  assert.ok(/Spark pipelines/i.test(job.jobInfo));
  assert.equal(job.employmentType, 'Full-time');
});

test('marks weak captures for review', () => {
  const job = extractor.extractJob({
    hostname: 'example.com',
    url: 'https://example.com/job',
    documentTitle: 'Careers',
    roleCandidates: ['Careers'],
    companyCandidates: [],
    locationCandidates: [],
    sections: [],
    listItems: [],
    bodyText: 'Apply now.',
    rootScore: 2,
    structuredData: []
  });

  assert.equal(job.status, 'needs_review');
  assert.ok(job.confidence < 70);
});
