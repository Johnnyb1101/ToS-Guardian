'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareDependencySmokeCredentials } = require('../tools/maintenance-dependency-smoke-credentials');

const accounts = Object.freeze({ anthropic: 'wrkspc_fixture_1', openai: 'proj_fixture_1' });
const keys = Object.freeze({ anthropic: 'sk-ant-example-only', openai: 'sk-proj-example-only' });
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows DPAPI required' };

function protectFixture(value) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
    '$key = Microsoft.PowerShell.Security\\ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force',
    'try { [Console]::Write((Microsoft.PowerShell.Security\\ConvertFrom-SecureString -SecureString $key)) }',
    'finally { $key.Dispose() }',
  ].join('\n');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: value, encoding: 'ascii', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, 'DPAPI fixture protection failed');
  assert.match(result.stdout, /^[a-f0-9]+$/i);
  return result.stdout;
}

function fixture(t) {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-smoke-credential-test-')));
  t.after(() => {
    for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
    fs.rmdirSync(folder);
  });
  const files = {
    anthropic: path.join(folder, 'anthropic.dpapi'),
    openai: path.join(folder, 'openai.dpapi'),
  };
  const anthropic = protectFixture(keys.anthropic);
  const openai = protectFixture(keys.openai);
  fs.writeFileSync(files.anthropic, anthropic + '\r\n');
  fs.writeFileSync(files.openai, Buffer.from('\uFEFF' + openai + '\r\n', 'utf16le'));
  return { files, anthropic };
}

test('credential preparation rejects incomplete maps, extra fields and malformed signed accounts', () => {
  const files = { anthropic: 'anthropic.dpapi', openai: 'openai.dpapi' };
  assert.throws(() => prepareDependencySmokeCredentials({ ...files, another: 'key' }, accounts), /exact/i);
  assert.throws(() => prepareDependencySmokeCredentials(files, { anthropic: accounts.anthropic }), /exact/i);
  assert.throws(() => prepareDependencySmokeCredentials(files, { ...accounts, openai: accounts.anthropic }), /account/i);
});

test('the DPAPI reader opens both files before returning and revokes on an account mismatch', windowsOnly, t => {
  const { files } = fixture(t);
  const mutableAccounts = { ...accounts };
  const read = prepareDependencySmokeCredentials(files, mutableAccounts);
  mutableAccounts.openai = 'proj_other';
  fs.unlinkSync(files.openai);
  for (const provider of ['anthropic', 'openai']) {
    assert.equal(read({ provider, accountId: accounts[provider] }), keys[provider]);
  }
  assert.throws(() => read({ provider: 'elsewhere', accountId: accounts.openai }), /unknown/i);
  assert.throws(() => read({ provider: 'openai', accountId: mutableAccounts.openai }), /signed provider account/i);
  assert.throws(() => read({ provider: 'anthropic', accountId: accounts.anthropic }), /revoked/i);
  assert.throws(() => read({ provider: 'openai', accountId: accounts.openai }), /revoked/i);
});

test('DPAPI preparation rejects aliased, noncanonical, oversized, plaintext and wrong-provider files', windowsOnly, t => {
  const { files, anthropic } = fixture(t);
  const error = /credential preparation failed/i;
  assert.throws(() => prepareDependencySmokeCredentials({ ...files, openai: files.anthropic }, accounts), error);
  assert.throws(() => prepareDependencySmokeCredentials({ ...files, openai: path.dirname(files.openai) + '\\.\\openai.dpapi' }, accounts), error);
  fs.unlinkSync(files.openai);
  fs.linkSync(files.anthropic, files.openai);
  assert.throws(() => prepareDependencySmokeCredentials(files, accounts), error);
  fs.unlinkSync(files.openai);
  fs.writeFileSync(files.openai, '0'.repeat(16385));
  assert.throws(() => prepareDependencySmokeCredentials(files, accounts), error);
  fs.writeFileSync(files.openai, keys.openai);
  assert.throws(() => prepareDependencySmokeCredentials(files, accounts), error);
  fs.writeFileSync(files.openai, anthropic);
  assert.throws(() => prepareDependencySmokeCredentials(files, accounts), error);
  fs.writeFileSync(files.openai, protectFixture(keys.openai));
  fs.writeFileSync(files.anthropic, protectFixture('sk-ant-admin-example-only'));
  assert.throws(() => prepareDependencySmokeCredentials(files, accounts), error);
});
