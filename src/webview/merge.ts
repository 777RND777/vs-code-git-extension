import type { MergeRequest, MergeResponse } from '../shared/messages';
import type { MergeRegion } from '../shared/types';
import { button, h, icon, onMessage, post } from './ui';

const send = (m: MergeRequest) => post(m);

type Side = 'ours' | 'theirs';
type SideState = 'none' | 'pending' | 'applied' | 'ignored';
type ChangeRegion = Extract<MergeRegion, { kind: 'change' }>;

interface RegionState {
  region: MergeRegion;
  ours: SideState;
  theirs: SideState;
  /** Sides in the order they were applied; the result is their lines concatenated. */
  order: Side[];
  /** Text typed by the user; replaces the computed result. */
  edited: string[] | null;
  expanded: boolean;
}

const CONTEXT = 3;

let regions: RegionState[] = [];
let filePath = '';
let oursLabel = '';
let theirsLabel = '';
let dirty = false;
const rowEls: HTMLElement[] = [];

// ---- Layout --------------------------------------------------------------

const status = h('span', { class: 'merge-status' });
const applyButton = button('Apply', () => save(), { icon: 'check', title: 'Save the result and mark the file as resolved' });
const toolbar = h(
  'div',
  { class: 'toolbar' },
  button('Apply Non-Conflicting', () => applyNonConflicting(), { icon: 'wand', secondary: true, title: 'Apply every change that does not conflict' }),
  button('Accept Yours', () => acceptAll('ours'), { icon: 'arrow-right', secondary: true, title: 'Take the left side for the whole file' }),
  button('Accept Theirs', () => acceptAll('theirs'), { icon: 'arrow-left', secondary: true, title: 'Take the right side for the whole file' }),
  button('', () => jump(-1), { icon: 'arrow-up', title: 'Previous unresolved change (Shift+F7)' }),
  button('', () => jump(1), { icon: 'arrow-down', title: 'Next unresolved change (F7)' }),
  status,
  h('span', { class: 'spacer' }),
  button('', () => send({ type: 'builtinMerge' }), { icon: 'link-external', title: "Open in VS Code's merge editor instead" }),
  button('Cancel', () => send({ type: 'cancel', dirty }), { secondary: true }),
  applyButton,
);

const title = h('div', { class: 'merge-title' });
const header = h('div', { class: 'merge-header' });
const grid = h('div', { class: 'merge-grid' });
const scroller = h('div', { class: 'merge-scroll' }, header, grid);
document.getElementById('app')!.append(toolbar, title, scroller);

onMessage<MergeResponse>((m) => {
  if (m.type !== 'init') return;
  filePath = m.path;
  oursLabel = m.oursLabel;
  theirsLabel = m.theirsLabel;
  regions = m.regions.map((region) => ({
    region,
    ours: region.kind === 'change' && region.oursChanged ? 'pending' : 'none',
    theirs: region.kind === 'change' && region.theirsChanged ? 'pending' : 'none',
    order: [],
    edited: null,
    expanded: false,
  }));
  if (m.autoApply) applyNonConflicting(false);
  renderAll();
  jump(1);
});

// ---- Model ---------------------------------------------------------------

function resultLines(s: RegionState): string[] {
  if (s.edited) return s.edited;
  const r = s.region;
  if (r.kind === 'same') return r.lines;
  return s.order.length ? s.order.flatMap((side) => r[side]) : r.base;
}

function isResolved(s: RegionState): boolean {
  if (s.region.kind === 'same') return true;
  return s.edited !== null || (s.ours !== 'pending' && s.theirs !== 'pending');
}

function apply(index: number, side: Side, render = true): void {
  const s = regions[index];
  const r = s.region as ChangeRegion;
  if (s[side] !== 'pending') return;
  if (!r.conflict && r.oursChanged && r.theirsChanged) {
    // Both sides made the same change: taking one takes both.
    s.ours = s.theirs = 'applied';
    s.order = [side];
  } else if (s.edited) {
    s[side] = 'applied';
    s.edited = [...s.edited, ...r[side]];
  } else {
    s[side] = 'applied';
    s.order.push(side);
  }
  dirty = true;
  if (render) update(index);
}

function ignore(index: number, side: Side): void {
  const s = regions[index];
  if (s[side] !== 'pending') return;
  s[side] = 'ignored';
  dirty = true;
  update(index);
}

function reset(index: number): void {
  const s = regions[index];
  const r = s.region as ChangeRegion;
  s.ours = r.oursChanged ? 'pending' : 'none';
  s.theirs = r.theirsChanged ? 'pending' : 'none';
  s.order = [];
  s.edited = null;
  dirty = true;
  update(index);
}

function applyNonConflicting(render = true): void {
  regions.forEach((s, i) => {
    if (s.region.kind !== 'change' || s.region.conflict || s.edited) return;
    if (s.ours === 'pending') apply(i, 'ours', false);
    if (s.theirs === 'pending') apply(i, 'theirs', false);
  });
  if (render) {
    dirty = true;
    renderAll();
  }
}

function acceptAll(side: Side): void {
  const other: Side = side === 'ours' ? 'theirs' : 'ours';
  for (const s of regions) {
    if (s.region.kind !== 'change') continue;
    s.edited = null;
    const r = s.region;
    const changed = side === 'ours' ? r.oursChanged : r.theirsChanged;
    const otherChanged = side === 'ours' ? r.theirsChanged : r.oursChanged;
    s[side] = changed ? 'applied' : 'none';
    s[other] = otherChanged ? (changed && !r.conflict ? 'applied' : 'ignored') : 'none';
    s.order = changed ? [side] : [];
  }
  dirty = true;
  renderAll();
}

function counts(): { conflicts: number; changes: number } {
  let conflicts = 0;
  let changes = 0;
  for (const s of regions) {
    if (isResolved(s)) continue;
    if ((s.region as ChangeRegion).conflict) conflicts++;
    else changes++;
  }
  return { conflicts, changes };
}

function save(): void {
  const { conflicts, changes } = counts();
  send({ type: 'save', lines: regions.flatMap(resultLines), unresolved: conflicts + changes });
}

// ---- Rendering -----------------------------------------------------------

function renderAll(): void {
  title.replaceChildren(icon('git-merge'), h('span', null, filePath));
  header.replaceChildren(
    h('div', { class: 'col-title ours' }, h('span', { class: 'muted' }, 'Yours: '), oursLabel),
    h('div', null),
    h('div', { class: 'col-title' }, 'Result'),
    h('div', null),
    h('div', { class: 'col-title theirs' }, h('span', { class: 'muted' }, 'Theirs: '), theirsLabel),
  );
  const top = scroller.scrollTop;
  rowEls.length = 0;
  let oursLine = 1;
  let theirsLine = 1;
  grid.replaceChildren(
    ...regions.map((s, i) => {
      const el = renderRegion(s, i, oursLine, theirsLine);
      oursLine += sideLines(s, 'ours').length;
      theirsLine += sideLines(s, 'theirs').length;
      rowEls.push(el);
      return el;
    }),
  );
  scroller.scrollTop = top;
  updateStatus();
}

function update(index: number): void {
  let oursLine = 1;
  let theirsLine = 1;
  for (let i = 0; i < index; i++) {
    oursLine += sideLines(regions[i], 'ours').length;
    theirsLine += sideLines(regions[i], 'theirs').length;
  }
  const el = renderRegion(regions[index], index, oursLine, theirsLine);
  rowEls[index].replaceWith(el);
  rowEls[index] = el;
  updateStatus();
}

function sideLines(s: RegionState, side: Side): string[] {
  return s.region.kind === 'same' ? s.region.lines : s.region[side];
}

function updateStatus(): void {
  const { conflicts, changes } = counts();
  const parts: string[] = [];
  if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
  if (changes) parts.push(`${changes} change${changes === 1 ? '' : 's'}`);
  status.replaceChildren(
    parts.length ? icon('warning') : icon('pass-filled', 'ok'),
    h('span', null, parts.length ? `${parts.join(', ')} left` : 'All changes processed'),
  );
  applyButton.classList.toggle('secondary', parts.length > 0);
}

function renderRegion(s: RegionState, index: number, oursStart: number, theirsStart: number): HTMLElement {
  const r = s.region;
  if (r.kind === 'same') {
    const foldable = r.lines.length > CONTEXT * 2 + 2 && !s.expanded && !s.edited;
    if (foldable) {
      const hidden = r.lines.length - CONTEXT * 2;
      const head = r.lines.slice(0, CONTEXT);
      const tail = r.lines.slice(-CONTEXT);
      const fold = (side: 'ours' | 'theirs' | 'result') =>
        h(
          'div',
          { class: `cell same ${side}` },
          linesView(head, side === 'ours' ? oursStart : side === 'theirs' ? theirsStart : undefined),
          h('div', { class: 'fold', title: 'Show unchanged lines', onclick: () => expand(index) }, icon('unfold'), ` ${hidden} unchanged lines`),
          linesView(tail, side === 'ours' ? oursStart + r.lines.length - CONTEXT : side === 'theirs' ? theirsStart + r.lines.length - CONTEXT : undefined),
        );
      return h('div', { class: 'region' }, fold('ours'), h('div', { class: 'gutter' }), fold('result'), h('div', { class: 'gutter' }), fold('theirs'));
    }
    return h(
      'div',
      { class: 'region' },
      h('div', { class: 'cell same ours' }, linesView(r.lines, oursStart)),
      h('div', { class: 'gutter' }),
      h('div', { class: 'cell same result' }, resultEditor(s, index)),
      h('div', { class: 'gutter' }),
      h('div', { class: 'cell same theirs' }, linesView(r.lines, theirsStart)),
    );
  }

  const kind = (side: Side) => {
    if (r.conflict) return 'conflict';
    if (!r.base.length) return 'added';
    if (!r[side].length) return 'deleted';
    return 'modified';
  };
  const sideClass = (side: Side) => {
    const changed = side === 'ours' ? r.oursChanged : r.theirsChanged;
    if (!changed) return 'unchanged';
    return `${kind(side)}${s[side] !== 'pending' ? ' done' : ''}`;
  };
  const resolved = isResolved(s);
  const resultKind = resolved ? 'resolved' : r.conflict ? 'conflict' : kind(r.oursChanged ? 'ours' : 'theirs');

  return h(
    'div',
    { class: `region change${resolved ? ' is-resolved' : ''}`, dataset: { index: String(index) } },
    h('div', { class: `cell ours ${sideClass('ours')}` }, linesView(r.ours, oursStart, true)),
    gutter(s, index, 'ours'),
    h(
      'div',
      { class: `cell result ${resultKind}` },
      resultEditor(s, index),
      s.order.length || s.edited || s.ours === 'ignored' || s.theirs === 'ignored'
        ? h('span', { class: 'codicon codicon-discard reset', title: 'Undo changes to this block', onclick: () => reset(index) })
        : null,
    ),
    gutter(s, index, 'theirs'),
    h('div', { class: `cell theirs ${sideClass('theirs')}` }, linesView(r.theirs, theirsStart, true)),
  );
}

function gutter(s: RegionState, index: number, side: Side): HTMLElement {
  const state = s[side];
  const el = h('div', { class: `gutter ${side}` });
  if (state === 'pending') {
    el.append(
      h('span', { class: 'codicon codicon-' + (side === 'ours' ? 'chevron-right' : 'chevron-left') + ' act apply', title: side === 'ours' ? 'Apply yours' : 'Apply theirs', onclick: () => apply(index, side) }),
      h('span', { class: 'codicon codicon-close act ignore', title: 'Ignore', onclick: () => ignore(index, side) }),
    );
  } else if (state === 'applied') {
    el.append(icon('check', 'state'));
  } else if (state === 'ignored') {
    el.append(h('span', { class: 'codicon codicon-circle-slash state', title: 'Ignored' }));
  }
  return el;
}

function linesView(lines: string[], start: number | undefined, showEmpty = false): HTMLElement {
  if (!lines.length && showEmpty) return h('div', { class: 'empty-marker' });
  return h(
    'div',
    { class: 'lines' },
    ...lines.map((line, i) => h('div', { class: 'line' }, h('span', { class: 'ln' }, start !== undefined ? start + i : ''), h('span', { class: 'code' }, line || ' '))),
  );
}

function resultEditor(s: RegionState, index: number): HTMLTextAreaElement {
  const ta = h('textarea', { class: 'editor', spellcheck: false, wrap: 'off', placeholder: '(empty)' });
  ta.value = resultLines(s).join('\n');
  ta.addEventListener('input', () => {
    s.edited = ta.value === '' ? [] : ta.value.split('\n');
    dirty = true;
    const row = rowEls[index];
    if (s.region.kind === 'change' && !row.classList.contains('is-resolved')) {
      // Typing in a block resolves it; redraw once, keeping the caret.
      const caret = ta.selectionStart;
      update(index);
      const fresh = rowEls[index].querySelector('textarea')!;
      fresh.focus();
      fresh.setSelectionRange(caret, caret);
    } else {
      updateStatus();
    }
  });
  return ta;
}

function expand(index: number): void {
  regions[index].expanded = true;
  update(index);
}

// ---- Navigation ----------------------------------------------------------

let cursor = -1;

function jump(direction: 1 | -1): void {
  const unresolved = regions.map((s, i) => (isResolved(s) ? -1 : i)).filter((i) => i >= 0);
  if (!unresolved.length) return;
  const next = direction > 0 ? (unresolved.find((i) => i > cursor) ?? unresolved[0]) : ([...unresolved].reverse().find((i) => i < cursor) ?? unresolved[unresolved.length - 1]);
  cursor = next;
  const el = rowEls[next];
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'F7') {
    e.preventDefault();
    jump(e.shiftKey ? -1 : 1);
  } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

send({ type: 'ready' });
