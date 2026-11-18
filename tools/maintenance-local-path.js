'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $targets = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TOS_MAINTENANCE_PATH)))
  foreach ($target in $targets) {
  $root = [IO.Path]::GetPathRoot($target)
  if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed) { throw 'Only a verified fixed local drive is supported' }
  $cursor = $root
  $parts = @('') + @($target.Substring($root.Length).Split([char]'\\', [StringSplitOptions]::RemoveEmptyEntries))
  for ($i = 0; $i -lt $parts.Length; $i++) {
    if ($parts[$i]) { $cursor = [IO.Path]::Combine($cursor, $parts[$i]) }
    try { $attrs = [IO.File]::GetAttributes($cursor) }
    catch [IO.FileNotFoundException] { if ($env:TOS_MAINTENANCE_NEW -eq '1') { break }; throw }
    catch [IO.DirectoryNotFoundException] { if ($env:TOS_MAINTENANCE_NEW -eq '1') { break }; throw }
    if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points, junctions and placeholders are not permitted' }
    if ($i -lt $parts.Length - 1 -and ($attrs -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Ancestor is not a directory' }
  }
  }
  [Console]::Write('LOCAL_PATH_OK')
} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }
`;

function lexicalPath(file, base = process.cwd()) {
  if (typeof file !== 'string' || !file || /[\x00-\x1f]/.test(file) || /^[\\/]/.test(file) || /^[a-z]:($|[^\\/])/i.test(file)) throw new Error('UNC, device, root-relative and drive-relative paths are not permitted');
  const absolute = path.win32.resolve(base, file);
  if (!/^[a-z]:\\/i.test(absolute) || /[:<>"|?*]/.test(absolute.slice(3))) throw new Error('Expected an ordinary local drive path, not a device or alternate stream');
  for (const part of absolute.slice(3).split('\\')) {
    if (/[ .]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error('Ambiguous or reserved Windows path component');
  }
  return absolute;
}

function localPaths(files, { base = process.cwd(), allowMissing = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Filesystem preparation currently supports verified Windows system-drive paths only');
  if (!Array.isArray(files) || !files.length) throw new Error('Nonempty local path list required');
  const absolute = files.map(file => lexicalPath(file, base));
  const windows = process.env.SystemRoot;
  if (typeof windows !== 'string' || !/^[a-z]:\\Windows$/i.test(windows)) throw new Error('Cannot establish the trusted Windows system directory');
  if (absolute.some(file => path.win32.parse(file).root.toLowerCase() !== path.win32.parse(windows).root.toLowerCase())) throw new Error('Only the Windows system drive is supported; mapped and secondary drives are rejected');
  // Bound each environment value well below Windows' per-variable limit. The
  // same native ancestor/reparse checks apply to every file in the batch.
  for (let at = 0; at < absolute.length; at += 16) {
  const result = spawnSync(path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, TOS_MAINTENANCE_PATH: Buffer.from(JSON.stringify(absolute.slice(at, at + 16)), 'utf8').toString('base64'), TOS_MAINTENANCE_NEW: allowMissing ? '1' : '0' }
    });
  if (result.error || result.status !== 0 || result.stdout !== 'LOCAL_PATH_OK') throw new Error(`Local-path verification failed: ${result.error?.message || result.stderr || 'unverified filesystem'}`);
  }
  return absolute;
}

function localPath(file, options) { return localPaths([file], options)[0]; }

// Enumerate only after checking each entry's native attributes. In particular,
// reject every reparse tag (including cloud placeholders) before descending or
// opening its contents. Node's isSymbolicLink alone does not cover those tags.
const TREE_SCRIPT = SCRIPT.replace("[Console]::Write('LOCAL_PATH_OK')", `
  $queue = [Collections.Generic.Queue[string]]::new()
  $queue.Enqueue($targets[0])
  $files = [Collections.Generic.List[string]]::new()
  $entries = 0
  while ($queue.Count -gt 0) {
    $folder = $queue.Dequeue()
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($folder)) {
      $entries++
      if ($entries -gt 100000) { throw 'Local tree is too large' }
      $attrs = [IO.File]::GetAttributes($entry)
      if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points, junctions and placeholders are not permitted' }
      if (($attrs -band [IO.FileAttributes]::Directory) -ne 0) { $queue.Enqueue($entry) }
      else { $files.Add($entry) }
    }
  }
  [Console]::Write((ConvertTo-Json -InputObject $files.ToArray() -Compress))
`);
function localTree(directory) {
  const absolute = localPath(directory);
  const result = spawnSync(path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', TREE_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16000000,
      env: { ...process.env, TOS_MAINTENANCE_PATH: Buffer.from(JSON.stringify([absolute]), 'utf8').toString('base64'), TOS_MAINTENANCE_NEW: '0' } });
  if (result.error || result.status !== 0) throw new Error(`Local-tree verification failed: ${result.error?.message || result.stderr || 'unverified filesystem'}`);
  const files = JSON.parse(result.stdout);
  if (!Array.isArray(files) || files.some(file => lexicalPath(file) !== file || !file.startsWith(absolute + path.win32.sep))) throw new Error('Unexpected local-tree paths');
  return files;
}

module.exports = { lexicalPath, localPath, localPaths, localTree };
