'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { localPaths } = require('./maintenance-local-path');

const MAX_FILE_BYTES = 16384;
const MAX_KEY_BYTES = 1000;
const PROVIDERS = ['anthropic', 'openai'];
const ACCOUNT_FORMATS = {
  anthropic: /^wrkspc_[A-Za-z0-9_-]{1,190}$/,
  openai: /^proj_[A-Za-z0-9_-]{1,195}$/,
};
const ANTHROPIC_PREFIX = Buffer.from('sk-ant-');
const ANTHROPIC_ADMIN_PREFIX = Buffer.from('sk-ant-admin');
const OPENAI_PREFIX = Buffer.from('sk-');
const DPAPI_FORMAT = /^01000000d08c9ddf0115d1118c7a00c04fc297eb(?:[a-f0-9]{2})+$/i;

const DECRYPT = Buffer.from(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$secure = $null
$pointer = [IntPtr]::Zero
$bytes = $null
try {
  Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"
  $encrypted = [Console]::In.ReadToEnd()
  $secure = Microsoft.PowerShell.Security\\ConvertTo-SecureString -String $encrypted
  if ($secure.Length -lt 8 -or $secure.Length -gt ${MAX_KEY_BYTES}) { throw 'Invalid key length' }
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
  $bytes = [byte[]]::new($secure.Length)
  for ($index = 0; $index -lt $bytes.Length; $index++) {
    $character = [Runtime.InteropServices.Marshal]::ReadInt16($pointer, 2 * $index)
    if ($character -lt 33 -or $character -gt 126) { throw 'Invalid key byte' }
    $bytes[$index] = [byte]$character
  }
  $output = [Console]::OpenStandardOutput()
  $output.Write($bytes, 0, $bytes.Length)
  $output.Flush()
} catch {
  exit 1
} finally {
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer) }
  if ($null -ne $secure) { $secure.Dispose() }
}
`, 'utf16le').toString('base64');

function exactProviderMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === PROVIDERS.length &&
    PROVIDERS.every(provider => Object.hasOwn(value, provider));
}

function readEncrypted(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.size < 1 || before.size > BigInt(MAX_FILE_BYTES)) throw new Error();
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(Number(before.size) + 1);
  try {
    const opened = fs.fstatSync(handle, { bigint: true });
    // The Windows path check already restricted both files to one drive.
    // lstat can report a zero device ID even when the open handle has one.
    if (!opened.isFile() || opened.ino !== before.ino ||
        opened.size !== before.size || fs.realpathSync.native(file) !== file) throw new Error();
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(handle, buffer, read, buffer.length - read, null);
      if (count === 0) break;
      read += count;
    }
    if (read !== Number(opened.size)) throw new Error();
    const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : 'utf-8';
    const encrypted = new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(0, read))
      .replace(/(?:\r?\n)$/, '');
    if (!DPAPI_FORMAT.test(encrypted)) throw new Error();
    return { encrypted, identity: `${opened.dev}:${opened.ino}` };
  } finally {
    buffer.fill(0);
    fs.closeSync(handle);
  }
}

function decryptCredential(executable, systemRoot, encrypted, provider) {
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', DECRYPT], {
    env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    input: Buffer.from(encrypted, 'ascii'),
    maxBuffer: MAX_KEY_BYTES,
    timeout: 10000,
    windowsHide: true,
  });
  try {
    const bytes = result.stdout;
    const anthropic = Buffer.isBuffer(bytes) && bytes.subarray(0, ANTHROPIC_PREFIX.length).equals(ANTHROPIC_PREFIX);
    const admin = anthropic && bytes.subarray(0, ANTHROPIC_ADMIN_PREFIX.length).equals(ANTHROPIC_ADMIN_PREFIX);
    const openai = Buffer.isBuffer(bytes) && bytes.subarray(0, OPENAI_PREFIX.length).equals(OPENAI_PREFIX) && !anthropic;
    if (result.error || result.status !== 0 || result.stderr?.length ||
        !(provider === 'anthropic' ? anthropic && !admin : openai) ||
        bytes.length < 8 || bytes.length > MAX_KEY_BYTES || bytes.some(byte => byte < 33 || byte > 126)) {
      throw new Error();
    }
    return bytes.toString('ascii');
  } finally {
    result.stdout?.fill(0);
    result.stderr?.fill(0);
  }
}

function prepareDependencySmokeCredentials(credentialFiles, accounts) {
  if (!exactProviderMap(credentialFiles) || !exactProviderMap(accounts)) {
    throw new Error('Exact Anthropic and OpenAI credential file and account maps required');
  }
  const signedAccounts = PROVIDERS.map(provider => accounts[provider]);
  if (signedAccounts.some((account, index) => typeof account !== 'string' || !ACCOUNT_FORMATS[PROVIDERS[index]].test(account))) {
    throw new Error('Invalid signed provider account identifiers');
  }
  const files = PROVIDERS.map(provider => credentialFiles[provider]);
  const credentials = [];
  try {
    const canonical = localPaths(files);
    if (canonical.some((file, index) => file !== files[index]) || canonical[0].toLowerCase() === canonical[1].toLowerCase()) {
      throw new Error();
    }
    const encrypted = canonical.map(readEncrypted);
    if (encrypted[0].identity === encrypted[1].identity) throw new Error();
    const systemRoot = process.env.SystemRoot;
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    for (const [index, provider] of PROVIDERS.entries()) {
      credentials.push(decryptCredential(executable, systemRoot, encrypted[index].encrypted, provider));
    }
  } catch {
    credentials.length = 0;
    throw new Error('Credential preparation failed. Two distinct canonical local DPAPI files with valid provider keys are required.');
  }
  return ({ provider, accountId } = {}) => {
    const index = PROVIDERS.indexOf(provider);
    if (index === -1) throw new Error('Unknown credential provider');
    if (accountId !== signedAccounts[index]) {
      credentials.length = 0;
      throw new Error('Credential request differs from the signed provider account');
    }
    if (credentials.length === 0) throw new Error('Credential reader was revoked');
    return credentials[index];
  };
}

module.exports = { prepareDependencySmokeCredentials };
