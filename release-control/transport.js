'use strict';
// No HTTP/Data API fallback and no app credential lookup.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const RPC = Object.freeze({ read_state: ['text'], read_committed: ['text','text','text'], adopt: ['jsonb','text','jsonb','text'], activate: ['jsonb','text','jsonb','text'] });
function createTransport(config) {
  if (!config || !path.isAbsolute(config.psql || '') || !fs.statSync(config.psql).isFile()) throw Error('Explicit psql executable required');
  if (!/^[a-zA-Z0-9.-]+$/.test(config.host || '') || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw Error('Invalid database endpoint');
  if (!/^[a-zA-Z0-9_]+$/.test(config.database || '') || config.user !== 'tos_release_controller') throw Error('Restricted controller login required');
  if (!path.isAbsolute(config.rootCertificate || '') || !fs.statSync(config.rootCertificate).isFile()) throw Error('Explicit trusted root certificate required');
  if (typeof config.password !== 'string' || !config.password || config.password.includes('\0')) throw Error('Controller credential required');
  const executable=config.psql;
  const env = {};
  for (const key of ['SystemRoot','WINDIR','PATH','TMP','TEMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PGHOST: config.host, PGPORT: String(config.port), PGDATABASE: config.database, PGUSER: config.user, PGPASSWORD: config.password,
    PGSSLMODE: 'verify-full', PGGSSENCMODE: 'disable', PGSSLCERTMODE: 'disable', PGSSLMINPROTOCOLVERSION: 'TLSv1.2', PGSSLROOTCERT: config.rootCertificate, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000', PGTARGETSESSIONATTRS: 'read-write' });
  return Object.freeze({ rpc(name, values) {
    if (!Object.hasOwn(RPC,name) || !Array.isArray(values) || values.length !== RPC[name].length) throw Error('Unknown narrow controller RPC');
    const args = values.map((value,i) => {
      const text = RPC[name][i] === 'jsonb' ? JSON.stringify(value) : value;
      if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > 8000000) throw Error('Invalid bounded RPC argument');
      // Hex literals avoid psql meta-command, backslash and SQL quoting ambiguities.
      return `convert_from(decode('${Buffer.from(text).toString('hex')}','hex'),'UTF8')::${RPC[name][i]}`;
    });
    const result = spawnSync(executable, ['-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1'], { env, input: `select tos_release_control.${name}(${args.join(',')});\n`, encoding:'utf8', timeout:20000, maxBuffer:16000000, windowsHide:true });
    if (result.error || result.status !== 0) throw Error('Controller database RPC failed; inspect restricted database logs');
    const output = result.stdout.trim();
    return output ? JSON.parse(output) : null;
  } });
}
module.exports = { createTransport, RPC };
