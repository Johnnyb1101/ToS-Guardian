'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const C = require('../tools/final-corpus-lib');
const { observationMessage } = require('../tools/maintenance-dependency-evidence');
const { verifyDependencySmokeApproval, dependencySmokeApprovalMessage } = require('../tools/maintenance-dependency-smoke-approval');

const now = '2026-11-22T13:00:00.000Z';
const describe = bytes => ({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
const publicPem = key => key.export({ type: 'spki', format: 'pem' });

// All keys and account identifiers here are disposable test fixtures.
function fixture(changes = {}) {
  const owner = crypto.generateKeyPairSync('ed25519');
  const execution = crypto.generateKeyPairSync('ed25519');
  const sign = (body, key, message) => {
    const payload = C.seal(body);
    return { payload, signature: crypto.sign(null, Buffer.from(message(payload)), key.privateKey).toString('base64') };
  };
  const protocol = C.seal({ mode: 'observed', smokeCapMicros: 6_080_000, declaredAt: '2026-11-22T09:00:00.000Z',
    reviewers: { owner: 'test-owner', execution: 'test-execution' }, ...changes.protocol });
  const preregistrationBytes = Buffer.from('offline preregistration attachment');
  const preregistration = sign({ v: 1, kind: 'preregistration', protocolHash: protocol.hash, reviewer: protocol.reviewers.owner,
    observedAt: '2026-11-22T10:00:00.000Z', outcome: 'pass', attachment: describe(preregistrationBytes),
    ...changes.prereg }, changes.wrongPreregSigner ? execution : owner, observationMessage);
  const accounts = { anthropic: 'wrkspc_fixture', openai: 'proj_fixture' };
  const billingEvidenceBytes = Buffer.from(changes.rawBilling || JSON.stringify({ v: 1, kind: 'dependency-smoke-billing-preflight',
    anthropicWorkspaceId: accounts.anthropic, openaiProjectId: accounts.openai, anthropicStandardOnly: true,
    openaiDefaultStandard: true, checkedAt: '2026-11-22T10:30:00.000Z', ...changes.billing }));
  const budgetHash = C.digest('offline budget');
  const journalDirectory = path.join(__dirname, '..', 'tools');
  const outputDirectory = __dirname;
  const approval = sign({ v: 1, kind: 'maintenance-dependency-smoke-live-approval', protocolHash: protocol.hash,
    budgetHash, maximumMicrodollars: 6_080_000, preregistrationHash: C.digest(preregistration), accounts,
    executionKeyFingerprint: describe(execution.publicKey.export({ type: 'spki', format: 'der' })).sha256,
    journalDirectory, outputDirectory, issuedAt: '2026-11-22T11:00:00.000Z', expiresAt: '2026-11-23T11:00:00.000Z',
    billingEvidence: describe(billingEvidenceBytes), ...changes.approval },
  changes.wrongApprovalSigner ? execution : owner, changes.wrongPurpose ? observationMessage : dependencySmokeApprovalMessage);
  return { approval, operatorTrust: { ownerPublicKey: publicPem(owner.publicKey),
    executionPublicKey: publicPem(execution.publicKey), journalDirectory },
  protocol, preregistration, preregistrationBytes, budgetHash, outputDirectory, billingEvidenceBytes };
}

test('owner spending permission and preregistration verify under distinct purposes and return immutable bindings', () => {
  const input = fixture();
  const approval = verifyDependencySmokeApproval(input, now);
  assert.deepEqual(approval, input.approval.payload);
  assert.ok([approval, approval.accounts, approval.billingEvidence].every(Object.isFrozen));
  input.approval.payload.accounts.openai = 'proj_other';
  assert.equal(approval.accounts.openai, 'proj_fixture');
});

test('rejects unrelated keys, invalid seals, changed signatures and a cross-purpose signature', () => {
  for (const changes of [{ wrongPreregSigner: true }, { wrongApprovalSigner: true }, { wrongPurpose: true }]) {
    assert.throws(() => verifyDependencySmokeApproval(fixture(changes), now), /invalid signature/);
  }
  const mutations = [
    [input => { input.operatorTrust.executionPublicKey = input.operatorTrust.ownerPublicKey; }, /independent/],
    [input => { input.operatorTrust.ownerPublicKey = fixture().operatorTrust.ownerPublicKey; }, /invalid signature/],
    [input => { input.operatorTrust.executionPublicKey = fixture().operatorTrust.executionPublicKey; }, /scope/],
    [input => { input.approval.payload.maximumMicrodollars++; }, /seal/],
    [input => { input.approval.signature += '='; }, /signature/],
    [input => { input.approval.payload.ownerPublicKey = input.operatorTrust.ownerPublicKey; }, /fields/],
    [input => { input.protocol.reviewers.owner = 'someone-else'; }, /scope/],
  ];
  for (const [mutate, error] of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyDependencySmokeApproval(input, now), error);
  }
});

test('refuses replay across budgets, accounts, retained evidence, destinations and approval windows', () => {
  for (const [changes, error] of [
    [{ approval: { maximumMicrodollars: 6_080_001 } }, /scope/],
    [{ protocol: { smokeCapMicros: 500_000 } }, /scope/],
    [{ approval: { budgetHash: C.digest('different budget') } }, /scope/],
    [{ approval: { accounts: { anthropic: 'invalid', openai: 'proj_fixture' } } }, /identifiers/],
    [{ approval: { issuedAt: '2026-11-22T14:00:00.000Z' } }, /expired/],
    [{ approval: { expiresAt: now } }, /expired/],
    [{ approval: { expiresAt: '2026-11-23T11:00:00.001Z' } }, /24 hours/],
    [{ prereg: { outcome: 'fail' } }, /stale owner/],
    [{ prereg: { observedAt: '2026-11-22T11:00:00.001Z' } }, /stale owner/],
    [{ approval: { preregistrationHash: C.digest('other preregistration') } }, /Preregistration envelope/],
    [{ approval: { journalDirectory: __dirname } }, /directory mismatch/],
    [{ approval: { outputDirectory: path.dirname(__dirname) } }, /directory mismatch/],
  ]) assert.throws(() => verifyDependencySmokeApproval(fixture(changes), now), error);
  const changed = fixture();
  changed.preregistrationBytes[0] ^= 1;
  assert.throws(() => verifyDependencySmokeApproval(changed, now), /Preregistration attachment: hash mismatch/);
});

test('requires retained, recent billing evidence for Standard service on both approved accounts', () => {
  for (const billing of [{ anthropicStandardOnly: false }, { openaiDefaultStandard: false },
    { anthropicWorkspaceId: 'wrkspc_other' }, { openaiProjectId: 'proj_other' },
    { checkedAt: '2026-11-21T12:59:59.999Z' }, { checkedAt: '2026-11-22T11:00:00.001Z' }, { extra: true }]) {
    assert.throws(() => verifyDependencySmokeApproval(fixture({ billing }), now), /Standard pricing/);
  }
  const duplicate = fixture({ rawBilling: '{"v":1,"v":1}' });
  assert.throws(() => verifyDependencySmokeApproval(duplicate, now), /duplicate/i);
  const changed = fixture();
  changed.billingEvidenceBytes[0] ^= 1;
  assert.throws(() => verifyDependencySmokeApproval(changed, now), /Billing preflight: hash mismatch/);
});
