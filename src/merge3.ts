import type { MergeRegion } from './shared/types';

/** A differing range between two line arrays, half-open on both sides. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

// Beyond this edit distance the Myers trace gets too large; treat the middle as one big change.
const MAX_EDIT_DISTANCE = 4000;

/** Line diff of a → b (Myers O(ND)), returned as the hunks where they differ. */
export function diffLines(a: string[], b: string[]): Hunk[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return [];

  const matches = myersMatches(midA, midB);
  if (!matches) {
    return [{ aStart: prefix, aEnd: a.length - suffix, bStart: prefix, bEnd: b.length - suffix }];
  }

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [midA.length, midB.length] as [number, number]]) {
    if (ma > ai || mb > bi) {
      hunks.push({ aStart: prefix + ai, aEnd: prefix + ma, bStart: prefix + bi, bEnd: prefix + mb });
    }
    ai = ma + 1;
    bi = mb + 1;
  }
  return hunks;
}

/** Matching index pairs in ascending order, or undefined if the edit distance is too large. */
function myersMatches(a: string[], b: string[]): Array<[number, number]> | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d-1 .. d+1] as it was before step d.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], n: number, m: number): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return matches.reverse();
}

interface SideHunk {
  side: 'ours' | 'theirs';
  oStart: number;
  oEnd: number;
  sStart: number;
  sEnd: number;
}

/**
 * Three-way merge of ours and theirs against their common base, split into regions
 * that are unchanged, changed on one side, or conflicting.
 */
export function merge3(base: string[], ours: string[], theirs: string[]): MergeRegion[] {
  const hunks: SideHunk[] = [
    ...diffLines(base, ours).map((h) => toSide('ours', h)),
    ...diffLines(base, theirs).map((h) => toSide('theirs', h)),
  ].sort((x, y) => x.oStart - y.oStart || x.oEnd - y.oEnd);

  const regions: MergeRegion[] = [];
  let oPos = 0;
  const pushSame = (end: number) => {
    if (end > oPos) regions.push({ kind: 'same', lines: base.slice(oPos, end) });
  };

  let i = 0;
  while (i < hunks.length) {
    // Group hunks that overlap or touch in base coordinates.
    const group = [hunks[i]];
    const regionStart = hunks[i].oStart;
    let regionEnd = hunks[i].oEnd;
    i++;
    while (i < hunks.length && hunks[i].oStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[i].oEnd);
      group.push(hunks[i]);
      i++;
    }

    pushSame(regionStart);
    const baseLines = base.slice(regionStart, regionEnd);
    const sideLines = (side: 'ours' | 'theirs', lines: string[]) => {
      const own = group.filter((h) => h.side === side);
      if (own.length === 0) return baseLines;
      const first = own[0];
      const last = own[own.length - 1];
      return lines.slice(first.sStart - (first.oStart - regionStart), last.sEnd + (regionEnd - last.oEnd));
    };
    const oursLines = sideLines('ours', ours);
    const theirsLines = sideLines('theirs', theirs);
    const oursChanged = group.some((h) => h.side === 'ours');
    const theirsChanged = group.some((h) => h.side === 'theirs');
    const conflict = oursChanged && theirsChanged && !sameLines(oursLines, theirsLines);
    regions.push({ kind: 'change', base: baseLines, ours: oursLines, theirs: theirsLines, oursChanged, theirsChanged, conflict });
    oPos = regionEnd;
  }
  pushSame(base.length);
  return regions;
}

function toSide(side: 'ours' | 'theirs', h: Hunk): SideHunk {
  return { side, oStart: h.aStart, oEnd: h.aEnd, sStart: h.bStart, sEnd: h.bEnd };
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

export interface SplitText {
  lines: string[];
  eol: string;
  finalNewline: boolean;
}

export function splitLines(text: string): SplitText {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text;
  return { lines: body.length === 0 && !finalNewline ? [] : body.split(/\r?\n/), eol, finalNewline };
}

export function joinLines(lines: string[], eol: string, finalNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (finalNewline ? eol : '');
}
