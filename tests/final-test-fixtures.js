'use strict';

const C = require('../tools/final-corpus-lib');
const E = require('../tools/final-evaluation-lib');
const { releaseConfigHash, releaseLessonsHash } = require('../tools/sites-lib');

const reseal = value => { const { hash, ...body } = value; return C.seal(body); };
function makeRelease(lessons) {
  const config = {
    lessons, sites: [], policy: {
      models: { anthropic: { default: 'mock-analyzer', escalated: 'mock-escalation', jury: 'mock-judge' } },
      promptHashes: { analyzer: C.hashText('mock analyzer'), critic: C.hashText('mock critic'), jury: C.hashText('mock jury') },
      rubricHash: C.hashText('mock rubric'),
      versions: Object.fromEntries(['resolver', 'classifier', 'excerpt', 'escalation', 'evaluator', 'siteLookup', 'pipeline'].map(key => [key, C.hashText(key)])),
      limits: { maxLessonsPerTarget: 12 }, selection: { order: 'explicit' }
    }
  };
  return { v: 2, configHash: releaseConfigHash(config), config };
}
function makeLesson(index, target = 'analyzer') {
  const text = `Mock lesson ${index}: quote only statements supported by the source.`;
  return { id: `lsn_${C.hashText(`${target}\n${text}`).slice(0, 16)}`, target, text, scope: 'all', section: null, order: index };
}
function makeGrade(artifact, protocol, overrides = {}) {
  return C.seal({ v: 1, kind: 'step2-grade', ...E.FLAGS, gradeId: `grade-${artifact.artifactId}`, artifactHash: artifact.hash, ...E.evidenceBindings(artifact), reviewer: { kind: 'independent', ...protocol.judge }, accuracy: 1, completeness: 1, fabrications: 0, usage: null, latencyMs: null, ...overrides });
}
function makeFixture() {
  const lessons = Array.from({ length: 6 }, (_, index) => makeLesson(index));
  const controlRelease = makeRelease([]), treatmentRelease = makeRelease(lessons);
  const history = { v: 1, inventoryIncomplete: false, sources: [{ path: 'manifest.json', hash: C.hashText('historical manifest') }], domains: ['old-corpus.com'], organizationIds: ['old organization'], sourceHashes: [C.hashText('old legal text')] };
  const sourceText = 'We collect email addresses. You may request deletion by contacting support.';
  const corpus = C.seal({ v: 1, kind: 'step2-final-corpus', purpose: 'final-evaluation-only', learningAllowed: false, historyHash: C.digest(history), sites: [{ siteId: 'fresh-1', domain: 'fresh-corpus.com', organizationId: 'Fresh Organization', docType: 'other', sourceText, sourceHash: C.hashText(sourceText), provenance: { url: 'https://fresh-corpus.com/privacy', capturedAt: '2026-10-17T00:00:00.000Z', method: 'offline fixture' } }] });
  const protocol = E.createDraftProtocol({ controlRelease, treatmentRelease, selectedLessonIds: lessons.map(l => l.id), corpusHash: corpus.hash, judge: { provider: 'openai', model: 'mock-judge', promptHash: C.hashText('independent mock prompt'), rubricHash: C.hashText('independent mock rubric') } });
  const artifacts = ['control', 'treatment'].map(arm => {
    const release = arm === 'control' ? controlRelease : treatmentRelease;
    const summary = 'We collect email addresses.';
    const critic = { grounded: true };
    return C.seal({ v: 1, kind: 'step2-artifact', split: 'final', purpose: 'final-evaluation-only', learningAllowed: false, artifactId: `${arm}-fresh-1-1`, attempt: 1, previousAttemptHash: null, ...E.FLAGS, arm, siteId: 'fresh-1', docType: 'other', analyzer: { provider: 'anthropic', tier: 'default', model: 'mock-analyzer', promptHash: release.config.policy.promptHashes.analyzer }, criticConfig: { provider: 'anthropic', model: 'mock-analyzer', promptHash: release.config.policy.promptHashes.critic }, sample: 1, status: 'ok', configHash: release.configHash, protocolHash: protocol.hash, sourceHash: C.hashText(sourceText), analysisSource: sourceText, summary, critic, analysisSourceHash: C.hashText(sourceText), summaryHash: C.hashText(summary), criticHash: C.digest(critic), analyzerLessonsHash: releaseLessonsHash(release, 'analyzer', 'other'), criticLessonsHash: releaseLessonsHash(release, 'critic', 'other'), usage: null, latencyMs: null, mock: true });
  });
  return { controlRelease, treatmentRelease, history, corpus, protocol, artifacts, grades: artifacts.map(a => makeGrade(a, protocol)), humanReviews: [] };
}

module.exports = { makeFixture, makeRelease, makeLesson, makeGrade, reseal };
