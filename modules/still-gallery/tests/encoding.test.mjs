/**
 * Guards the integrity of the Chinese text in every source file.
 *
 * Nearly all user-facing copy in this project is Chinese, and it lives directly in
 * the source. That text has been damaged before, in a way that is easy to miss:
 * the THIRD byte of a 3-byte UTF-8 sequence was overwritten with 0x3F ('?'), so
 * `确` (e7 a1 ae) became `e7 a1 3f`. The file still parses, the app still runs, and
 * only the string content is wrong — which is why it survived a whole session
 * before a test that compared an exact message caught it.
 *
 * Two checks, because they catch different things:
 *   1. U+FFFD anywhere — the decoded symptom, visible to any reader.
 *   2. A truncated multi-byte sequence followed by '?' — the raw byte signature,
 *      which catches damage even if a future decoder papered over it.
 *
 * Reading bytes with node is deliberate: an editor or a language model looking at
 * this file may render it as mojibake while the bytes are perfectly fine, and the
 * reverse — bytes that are broken while the display looks correct — is the case
 * that actually shipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);
const EXTENSIONS = /\.(mjs|js|html|css|json|md)$/;

function sourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

/** Raw-byte scan for `<3-byte lead><continuation>0x3F`, i.e. a truncated char + '?'. */
function truncatedMultibyteSites(buffer) {
  const hits = [];
  for (let i = 0; i < buffer.length - 2; i++) {
    const lead = buffer[i];
    const isThreeByteLead = lead >= 0xe0 && lead <= 0xef;
    const isContinuation = buffer[i + 1] >= 0x80 && buffer[i + 1] <= 0xbf;
    if (isThreeByteLead && isContinuation && buffer[i + 2] === 0x3f) {
      hits.push(i);
    }
  }
  return hits;
}

test('no source file contains a U+FFFD replacement character', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const count = (text.match(/\uFFFD/g) || []).length;
    if (count) offenders.push(`${path.relative(ROOT, file)} (${count})`);
  }
  assert.deepEqual(offenders, [], `U+FFFD found in:\n${offenders.join('\n')}`);
});

test('no source file carries a truncated 3-byte sequence followed by "?"', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const hits = truncatedMultibyteSites(fs.readFileSync(file));
    if (hits.length) offenders.push(`${path.relative(ROOT, file)} (${hits.length})`);
  }
  assert.deepEqual(offenders, [], `truncated multi-byte sequences in:\n${offenders.join('\n')}`);
});

test('the scanner would actually catch the damage it is guarding against', () => {
  // A guard that cannot fail is worse than no guard. Feed it the exact byte
  // pattern that shipped: `确` with its third byte replaced by '?'.
  const damaged = Buffer.from([0xe7, 0xa1, 0x3f]);
  assert.equal(truncatedMultibyteSites(damaged).length, 1);
  assert.equal(damaged.toString('utf8').includes('\uFFFD'), true, 'decodes to U+FFFD');

  // And confirm it does NOT fire on a healthy sequence.
  const healthy = Buffer.from('确', 'utf8');
  assert.equal(healthy.length, 3);
  assert.equal(truncatedMultibyteSites(healthy).length, 0);
});

test('the source tree is actually being scanned', () => {
  // Cheap tripwire for a scanner that silently walks nothing.
  const files = sourceFiles();
  assert.ok(files.length > 15, `expected a real tree, scanned ${files.length} files`);
  assert.ok(
    files.some((file) => file.endsWith('server.mjs')),
    'server.mjs must be in scope',
  );
});
