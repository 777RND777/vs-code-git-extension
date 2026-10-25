import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, merge3, splitLines, joinLines } from '../src/merge3.ts';

function apply(a: string[], b: string[]) {
  // Rebuild b from a + hunks to prove the diff is complete and consistent.
  const out: string[] = [];
  let pos = 0;
  for (const h of diffLines(a, b)) {
    out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd));
    pos = h.aEnd;
  }
  return [...out, ...a.slice(pos)];
}

test('diffLines round-trips random edits', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let iter = 0; iter < 500; iter++) {
    const a = Array.from({ length: Math.floor(rnd() * 30) }, () => String(Math.floor(rnd() * 6)));
    const b = Array.from({ length: Math.floor(rnd() * 30) }, () => String(Math.floor(rnd() * 6)));
    assert.deepEqual(apply(a, b), b);
  }
});

test('diffLines finds minimal single change', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'X', 'c']), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines([], []), []);
});

test('merge3 separates one-sided changes from conflicts', () => {
  const base = ['1', '2', '3', '4', '5', '6', '7'];
  const ours = ['1', 'two', '3', '4', '5', 'six-ours', '7'];
  const theirs = ['1', '2', '3', 'four', '5', 'six-theirs', '7', '8'];
  const r = merge3(base, ours, theirs);
  const kinds = r.map((x) => (x.kind === 'same' ? 'same' : x.conflict ? 'conflict' : x.oursChanged ? 'ours' : 'theirs'));
  assert.deepEqual(kinds, ['same', 'ours', 'same', 'theirs', 'same', 'conflict', 'same', 'theirs']);
  const conflict = r[5];
  assert.ok(conflict.kind === 'change');
  assert.deepEqual(conflict.ours, ['six-ours']);
  assert.deepEqual(conflict.theirs, ['six-theirs']);
  assert.deepEqual(conflict.base, ['6']);
});

test('merge3 treats identical changes on both sides as no conflict', () => {
  const r = merge3(['a', 'b'], ['a', 'X'], ['a', 'X']);
  const change = r.find((x) => x.kind === 'change');
  assert.ok(change && change.kind === 'change' && !change.conflict && change.oursChanged && change.theirsChanged);
});

test('merge3 with empty base (both added)', () => {
  const r = merge3([], ['x', 'y'], ['x', 'z']);
  assert.equal(r.length, 1);
  assert.ok(r[0].kind === 'change' && r[0].conflict);
});

test('merge3 regions reassemble each side', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const mutate = (xs: string[]) => xs.flatMap((x) => (rnd() < 0.15 ? [] : rnd() < 0.15 ? [x, 'n' + Math.floor(rnd() * 99)] : rnd() < 0.1 ? ['m' + x] : [x]));
  for (let iter = 0; iter < 300; iter++) {
    const base = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) => 'l' + i);
    const ours = mutate(base);
    const theirs = mutate(base);
    const r = merge3(base, ours, theirs);
    const pick = (k: 'base' | 'ours' | 'theirs') => r.flatMap((x) => (x.kind === 'same' ? x.lines : x[k]));
    assert.deepEqual(pick('base'), base);
    assert.deepEqual(pick('ours'), ours);
    assert.deepEqual(pick('theirs'), theirs);
  }
});

test('splitLines/joinLines preserve EOL style and final newline', () => {
  for (const s of ['', 'a', 'a\n', 'a\r\nb\r\n', '\n', 'a\nb']) {
    const { lines, eol, finalNewline } = splitLines(s);
    assert.equal(joinLines(lines, eol, finalNewline), s);
  }
});
