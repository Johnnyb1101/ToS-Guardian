'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { localPath } = require('./maintenance-local-path');
const { canonicalJson } = require('./final-corpus-lib');
const { Budget, budgetPolicy } = require('./maintenance-runner-lib');
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());

class Journal {
  #budget; #binding; #fd; #lockFd; #lock; #previous = null; #sequence = 0; #closed = false; #poisoned = false;
  constructor(directory, bindingHash, limitMicrodollars) {
    if (!/^[a-f0-9]{64}$/.test(bindingHash)) throw new Error('Exact plan hash required');
    this.#budget = new Budget(limitMicrodollars);
    this.#binding = bindingHash;
    const root = localPath(directory);
    if (!fs.statSync(root).isDirectory()) throw new Error('Existing local journal directory required');
    this.#lock = localPath(path.join(root, 'maintenance-budget.lock'), { allowMissing: true });
    this.#lockFd = fs.openSync(this.#lock, 'wx');
    try {
      fs.writeFileSync(this.#lockFd, 'Exclusive synthetic evaluation journal lock; never auto-remove a stale lock.\n');
      fs.fsyncSync(this.#lockFd);
      const file = localPath(path.join(root, 'maintenance-budget.jsonl'), { allowMissing: true });
      if (fs.existsSync(file)) {
        this.#fd = fs.openSync(localPath(file), 'r+');
        if (!fs.fstatSync(this.#fd).isFile() || fs.fstatSync(this.#fd).size > 10000000) throw new Error('Invalid or oversized journal');
        const bytes = fs.readFileSync(this.#fd, 'utf8');
        if (!bytes.endsWith('\n')) throw new Error('Incomplete journal; operator reconciliation required');
        const rows = bytes.slice(0, -1).split('\n');
        rows.forEach((row, index) => {
          const record = JSON.parse(row);
          if (!exact(record, ['sequence', 'previous', 'event', 'hash']) || record.sequence !== index || record.previous !== this.#previous || record.hash !== hash({ sequence: record.sequence, previous: record.previous, event: record.event })) throw new Error('Journal integrity mismatch');
          const event = record.event;
          if (index === 0) {
            if (!exact(event, ['type', 'bindingHash', 'limitMicrodollars', 'mode', 'policyHash']) || event.type !== 'header' || event.mode !== 'synthetic-only' || event.bindingHash !== bindingHash || event.limitMicrodollars !== limitMicrodollars || event.policyHash !== hash(budgetPolicy())) throw new Error('Journal plan or budget mismatch');
          } else if (exact(event, ['type', 'id', 'stage']) && event.type === 'reserve') this.#budget.reserve(event.id, event.stage);
          else if (exact(event, ['type', 'id', 'stage']) && event.type === 'exhausted') {
            if (this.#budget.snapshot().halted) throw new Error('Repeated exhausted transition');
            let exhausted = false;
            try { this.#budget.reserve(event.id, event.stage); }
            catch (error) { exhausted = error.message === 'Budget exhausted before dispatch' && this.#budget.snapshot().halted; }
            if (!exhausted) throw new Error('Invalid exhausted transition');
          }
          else if (exact(event, ['type', 'id', 'usage']) && event.type === 'settle') this.#budget.settle(event.id, event.usage);
          else if (exact(event, ['type', 'id']) && event.type === 'fail') this.#budget.fail(event.id);
          else throw new Error('Unsupported journal event');
          this.#previous = record.hash; this.#sequence++;
        });
        if (this.#budget.snapshot().attempts.some(a => a.status === 'reserved')) throw new Error('Unresolved attempt; do not replay dispatch');
      } else {
        this.#fd = fs.openSync(file, 'wx+');
        this.#append({ type: 'header', bindingHash, limitMicrodollars, mode: 'synthetic-only', policyHash: hash(budgetPolicy()) });
      }
    } catch (error) {
      if (this.#fd !== undefined) fs.closeSync(this.#fd);
      fs.closeSync(this.#lockFd);
      this.#closed = true;
      // Leave the lock as evidence of failure; never silently reset spending state.
      throw error;
    }
  }
  #ready() { if (this.#closed || this.#poisoned) throw new Error('Journal closed or poisoned'); }
  #append(event) {
    this.#ready();
    const body = { sequence: this.#sequence, previous: this.#previous, event };
    const record = { ...body, hash: hash(body) };
    const bytes = Buffer.from(canonicalJson(record) + '\n');
    try {
      const end = fs.fstatSync(this.#fd).size;
      for (let offset = 0; offset < bytes.length;) {
        const written = fs.writeSync(this.#fd, bytes, offset, bytes.length - offset, end + offset);
        if (written <= 0) throw new Error('Journal write made no progress');
        offset += written;
      }
      fs.fsyncSync(this.#fd);
      this.#previous = record.hash; this.#sequence++;
    } catch (error) { this.#poisoned = true; throw error; }
  }
  reserve(id, stage) {
    this.#ready();
    const alreadyHalted = this.#budget.snapshot().halted;
    let amount;
    try { amount = this.#budget.reserve(id, stage); }
    catch (error) {
      if (!alreadyHalted && this.#budget.snapshot().halted) this.#append({ type: 'exhausted', id, stage });
      throw error;
    }
    this.#append({ type: 'reserve', id, stage });
    return amount;
  }
  settle(id, usage) {
    this.#ready();
    const wasPending = this.#budget.snapshot().attempts.find(a => a.id === id)?.status === 'reserved';
    try { this.#budget.settle(id, usage); }
    catch (error) {
      if (wasPending && this.#budget.snapshot().attempts.find(a => a.id === id)?.status === 'unknown-cost') this.#append({ type: 'fail', id });
      throw error;
    }
    this.#append({ type: 'settle', id, usage });
  }
  fail(id) { this.#ready(); this.#budget.fail(id); this.#append({ type: 'fail', id }); }
  snapshot() { this.#ready(); return this.#budget.snapshot(); }
  bindingHash() { this.#ready(); return this.#binding; }
  abandon() {
    if (this.#closed) throw new Error('Journal closed');
    fs.closeSync(this.#fd); fs.closeSync(this.#lockFd); this.#closed = true;
    // Keep lock and all evidence. Only manual reconciliation may recover this run.
  }
  close() {
    this.#ready();
    if (this.#budget.snapshot().attempts.some(a => a.status === 'reserved')) throw new Error('Pending attempts require reconciliation; lock retained');
    fs.closeSync(this.#fd); fs.closeSync(this.#lockFd); this.#closed = true;
    fs.unlinkSync(localPath(this.#lock));
  }
}

module.exports = { Journal };
