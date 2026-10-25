import type { ConflictsRequest, ConflictsResponse, OperationAction } from '../shared/messages';
import type { ConflictFile, RepoState } from '../shared/types';
import { button, h, icon, onMessage, post, showMenu } from './ui';

const send = (m: ConflictsRequest) => post(m);

let state: RepoState | undefined;
let repoName = '';
let busy = false;
const selected = new Set<string>();

const app = document.getElementById('app')!;

onMessage<ConflictsResponse>((m) => {
  state = m.state;
  repoName = m.repoName;
  busy = m.busy;
  const paths = new Set(state.conflicts.map((c) => c.path));
  for (const p of [...selected]) if (!paths.has(p)) selected.delete(p);
  if (!selected.size && state.conflicts.length) selected.add(state.conflicts[0].path);
  render();
});

function render(): void {
  if (!state) return;
  const s = state;
  const op = (action: OperationAction) => () => send({ type: 'operation', action });
  const selection = s.conflicts.filter((c) => selected.has(c.path));
  const accept = (side: 'ours' | 'theirs') => () => send({ type: 'accept', side, paths: selection.map((c) => c.path) });

  const heading = h(
    'div',
    { class: 'heading' },
    icon('git-merge'),
    h('div', null, h('div', { class: 'title' }, s.description ?? 'Conflicts'), h('div', { class: 'muted' }, repoName)),
  );

  let body: HTMLElement;
  if (s.conflicts.length) {
    body = h(
      'div',
      { class: 'conflicts-body' },
      h(
        'div',
        { class: 'table' },
        h('div', { class: 'thead' }, h('span', null, 'File'), h('span', { title: s.oursLabel }, `Yours (${s.oursLabel})`), h('span', { title: s.theirsLabel }, `Theirs (${s.theirsLabel})`)),
        ...s.conflicts.map((c) => row(c)),
      ),
      h(
        'div',
        { class: 'side-actions' },
        button('Accept Yours', accept('ours'), { icon: 'arrow-left' }),
        button('Accept Theirs', accept('theirs'), { icon: 'arrow-right' }),
        button('Merge…', () => selection[0] && send({ type: 'merge', path: selection[0].path }), { icon: 'git-merge' }),
        h('div', { class: 'hint muted' }, 'Double-click a file to open the 3-pane merge tool. Cmd/Ctrl-click or Shift-click selects several files.'),
      ),
    );
    const disable = busy || !selection.length;
    body.querySelectorAll<HTMLButtonElement>('.side-actions .btn').forEach((b) => (b.disabled = disable));
    const merge = body.querySelectorAll<HTMLButtonElement>('.side-actions .btn')[2];
    merge.disabled = disable || selection.length !== 1;
  } else if (s.operation) {
    body = h('div', { class: 'done' }, icon('pass-filled', 'ok'), h('div', null, `All conflicts are resolved. Continue the ${s.operation} to finish.`));
  } else {
    body = h('div', { class: 'done' }, icon('pass'), h('div', null, 'No merge, rebase or cherry-pick in progress and no conflicts.'));
  }

  const footer = s.operation
    ? h(
        'div',
        { class: 'footer' },
        h('span', { class: 'spacer' }),
        s.operation !== 'merge' ? button('Skip This Commit', op('skip'), { secondary: true }) : null,
        button(`Abort ${capitalize(s.operation)}`, op('abort'), { secondary: true }),
        button(`Continue ${capitalize(s.operation)}`, op('continue'), { icon: 'debug-continue', class: s.conflicts.length ? 'secondary' : '' }),
      )
    : null;
  footer?.querySelectorAll<HTMLButtonElement>('.btn').forEach((b) => (b.disabled = busy));

  app.replaceChildren(heading, body, footer ?? '');
}

let anchor: string | undefined;

function row(c: ConflictFile): HTMLElement {
  const name = c.path.split('/').pop()!;
  const dir = c.path.slice(0, -name.length - 1);
  return h(
    'div',
    {
      class: `trow${selected.has(c.path) ? ' selected' : ''}`,
      onmousedown: (e: MouseEvent) => {
        if (e.shiftKey && anchor && state) {
          const paths = state.conflicts.map((x) => x.path);
          const [a, b] = [paths.indexOf(anchor), paths.indexOf(c.path)].sort((x, y) => x - y);
          selected.clear();
          paths.slice(a, b + 1).forEach((p) => selected.add(p));
        } else if (e.metaKey || e.ctrlKey) {
          if (selected.has(c.path)) selected.delete(c.path);
          else selected.add(c.path);
          anchor = c.path;
        } else if (!(e.button === 2 && selected.has(c.path))) {
          selected.clear();
          selected.add(c.path);
          anchor = c.path;
        }
        render();
      },
      ondblclick: () => send({ type: 'merge', path: c.path }),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        const paths = [...selected];
        showMenu(e.clientX, e.clientY, [
          { label: 'Merge…', icon: 'git-merge', action: () => send({ type: 'merge', path: c.path }), disabled: paths.length !== 1 },
          { label: 'Accept Yours', icon: 'arrow-left', action: () => send({ type: 'accept', side: 'ours', paths }) },
          { label: 'Accept Theirs', icon: 'arrow-right', action: () => send({ type: 'accept', side: 'theirs', paths }) },
          'separator',
          { label: "Open in VS Code's Merge Editor", icon: 'link-external', action: () => send({ type: 'builtinMerge', path: c.path }) },
          { label: 'Open File', icon: 'go-to-file', action: () => send({ type: 'openFile', path: c.path }) },
        ]);
      },
    },
    h('span', { class: 'file', title: c.path }, icon('file'), h('span', null, name), dir ? h('span', { class: 'muted dir' }, dir) : null),
    h('span', { class: `side ${c.ours}` }, capitalize(c.ours)),
    h('span', { class: `side ${c.theirs}` }, capitalize(c.theirs)),
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

send({ type: 'ready' });
