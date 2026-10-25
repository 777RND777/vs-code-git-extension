import type { BranchAction, CommitAction, LogRequest, LogResponse, OperationAction, RepoSummary } from '../shared/messages';
import type { Commit, CommitDetails, FileChange, LogFilter, RefLabel, RefsInfo, RepoState } from '../shared/types';
import { button, formatDate, h, icon, makeSplitter, MenuItem, onMessage, post, setChildren, showMenu, showPicker } from './ui';

const send = (m: LogRequest) => post(m);

// ---- State ---------------------------------------------------------------

let repos: RepoSummary[] = [];
let root = '';
let refs: RefsInfo = { local: [], remote: [], tags: [] };
let authors: string[] = [];
let me: string | undefined;
let repoState: RepoState | undefined;
let filter: LogFilter = {};

let commits: Commit[] = [];
let hasMore = false;
let loading = false;
let logRequestId = 0;

const selected = new Set<string>();
let anchorIndex = -1;
let focusIndex = -1;
let detailsRequestId = 0;
let detailsTimer: number | undefined;

const collapsed = new Set<string>(['tags']);
let branchQuery = '';

// ---- Layout --------------------------------------------------------------

const repoSelect = h('select', { title: 'Repository', onchange: () => send({ type: 'setRepo', root: repoSelect.value }) });
const branchDropdown = h('button', { class: 'dropdown', title: 'Filter by branch' });
const userDropdown = h('button', { class: 'dropdown', title: 'Filter by user' });
const searchInput = h('input', { type: 'text', placeholder: 'Text or hash', title: 'Search commit messages, or enter a hash', style: 'width: 200px' });
const pathChip = h('span', { class: 'chip' });
const fetchButton = button('', () => send({ type: 'fetch' }), { icon: 'cloud-download', title: 'Fetch all remotes' });
const toolbar = h(
  'div',
  { class: 'toolbar' },
  repoSelect,
  branchDropdown,
  userDropdown,
  h('span', { class: 'search' }, icon('search'), searchInput),
  pathChip,
  h('span', { class: 'spacer' }),
  fetchButton,
  button('', () => reload(), { icon: 'refresh', title: 'Refresh' }),
);

const banner = h('div', { class: 'banner' });
const errorBar = h('div', { class: 'error-bar' });

const branchFilterInput = h('input', { type: 'text', placeholder: 'Filter branches', class: 'branch-filter' });
const branchTree = h('div', { class: 'branch-tree', tabIndex: 0 });
const sidebar = h('div', { class: 'sidebar' }, branchFilterInput, branchTree);

const commitList = h('div', { class: 'commit-list', tabIndex: 0 });
const commitPane = h(
  'div',
  { class: 'commit-pane' },
  h('div', { class: 'commit-header' }, h('span', null, 'Subject'), h('span', null, 'Author'), h('span', null, 'Date'), h('span', null, 'Hash')),
  commitList,
);

const filesHeader = h('div', { class: 'pane-header' });
const fileTree = h('div', { class: 'file-tree' });
const messagePane = h('div', { class: 'message-pane' });
const detailsPane = h('div', { class: 'details' }, filesHeader, fileTree, messagePane);

const splitA = h('div', { class: 'splitter' });
const splitB = h('div', { class: 'splitter' });
const main = h('div', { class: 'main' }, sidebar, splitA, commitPane, splitB, detailsPane);
makeSplitter(splitA, sidebar, 'left');
makeSplitter(splitB, detailsPane, 'right', 200);

document.getElementById('app')!.append(toolbar, banner, errorBar, main);
banner.hidden = true;
errorBar.hidden = true;

// ---- Messages from the extension -----------------------------------------

onMessage<LogResponse>((m) => {
  switch (m.type) {
    case 'init':
      repos = m.repos;
      root = m.root;
      refs = m.refs;
      authors = m.authors;
      me = m.me;
      repoState = m.state;
      filter = m.filter;
      selected.clear();
      renderToolbar();
      renderBanner();
      renderBranches();
      reload();
      break;
    case 'log':
      if (m.requestId !== logRequestId) return;
      loading = false;
      hasMore = m.hasMore;
      if (m.append) {
        const start = commits.length;
        commits.push(...m.commits);
        appendRows(start);
      } else {
        const scrollTop = commitList.scrollTop;
        commits = m.commits;
        const visible = new Set(commits.map((c) => c.hash));
        for (const hash of [...selected]) if (!visible.has(hash)) selected.delete(hash);
        renderCommits();
        commitList.scrollTop = scrollTop;
        if (!selected.size && commits.length) selectIndex(0, false, false);
        else requestDetails();
      }
      break;
    case 'details':
      if (m.requestId === detailsRequestId) renderDetails(m.details, m.count, m.files);
      break;
    case 'repoChanged':
      refs = m.refs;
      repoState = m.state;
      renderBanner();
      renderBranches();
      renderToolbar();
      reload();
      break;
    case 'setFilter':
      filter = m.filter;
      renderToolbar();
      renderBranches();
      reload();
      break;
    case 'busy':
      fetchButton.disabled = m.busy;
      fetchButton.querySelector('.codicon')!.classList.toggle('codicon-modifier-spin', m.busy);
      break;
    case 'error':
      loading = false;
      showError(m.message);
      break;
  }
});

function showError(message: string): void {
  errorBar.replaceChildren(icon('error'), h('span', { class: 'text' }, message), button('', () => (errorBar.hidden = true), { icon: 'close', title: 'Dismiss' }));
  errorBar.hidden = false;
}

// ---- Filters -------------------------------------------------------------

function reload(): void {
  loading = true;
  errorBar.hidden = true;
  send({ type: 'loadLog', requestId: ++logRequestId, filter, skip: 0 });
}

function loadMore(): void {
  if (loading || !hasMore) return;
  loading = true;
  send({ type: 'loadLog', requestId: ++logRequestId, filter, skip: commits.length });
}

function setFilter(change: Partial<LogFilter>): void {
  filter = { ...filter, ...change };
  renderToolbar();
  renderBranches();
  commitList.scrollTop = 0;
  reload();
}

function shortRef(ref: string | undefined): string {
  return ref ? ref.replace(/^refs\/(heads|remotes|tags)\//, '') : '';
}

function renderToolbar(): void {
  repoSelect.replaceChildren(...repos.map((r) => h('option', { value: r.root, selected: r.root === root }, r.name)));
  repoSelect.hidden = repos.length < 2;

  branchDropdown.replaceChildren(icon('git-branch'), h('span', { class: 'value' }, filter.branch ? shortRef(filter.branch) : 'All branches'), icon('chevron-down'));
  branchDropdown.classList.toggle('active', !!filter.branch);

  const users = filter.authors ?? [];
  const userText = !users.length ? 'All users' : users.length === 1 ? (users[0] === me ? 'me' : users[0].replace(/\s*<.*>$/, '')) : `${users.length} users`;
  userDropdown.replaceChildren(icon('person'), h('span', { class: 'value' }, userText), icon('chevron-down'));
  userDropdown.classList.toggle('active', users.length > 0);

  if (searchInput.value !== (filter.text ?? '') && document.activeElement !== searchInput) searchInput.value = filter.text ?? '';

  pathChip.hidden = !filter.path;
  if (filter.path) {
    pathChip.replaceChildren(
      icon('file'),
      h('span', { title: filter.path }, filter.path),
      h('span', { class: 'codicon codicon-close chip-close', title: 'Clear path filter', onclick: () => setFilter({ path: undefined }) }),
    );
  }
}

branchDropdown.addEventListener('click', () =>
  showPicker(branchDropdown, {
    placeholder: 'Filter branches',
    multi: false,
    selected: [filter.branch ?? ''],
    items: [
      { value: '', label: 'All branches', icon: 'list-flat' },
      ...(refs.current ? [{ value: 'HEAD', label: 'HEAD', description: refs.current, icon: 'target' }] : []),
      ...refs.local.map((b) => ({ value: `refs/heads/${b.name}`, label: b.name, icon: 'git-branch', description: b.track })),
      ...refs.remote.map((b) => ({ value: `refs/remotes/${b.name}`, label: b.name, icon: 'cloud' })),
      ...refs.tags.map((t) => ({ value: `refs/tags/${t}`, label: t, icon: 'tag' })),
    ],
    onChange: ([value]) => setFilter({ branch: value || undefined }),
  }),
);

userDropdown.addEventListener('click', () =>
  showPicker(userDropdown, {
    placeholder: 'Filter users',
    multi: true,
    selected: filter.authors ?? [],
    items: [
      ...(me ? [{ value: me, label: 'me', description: me }] : []),
      ...authors.filter((a) => a !== me).map((a) => {
        const match = /^(.*?)\s*(<.*>)$/.exec(a);
        return { value: a, label: match ? match[1] : a, description: match?.[2] };
      }),
    ],
    onChange: (values) => setFilter({ authors: values.length ? values : undefined }),
  }),
);

let searchTimer: number | undefined;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => setFilter({ text: searchInput.value.trim() || undefined }), 300);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchInput.value) {
    searchInput.value = '';
    setFilter({ text: undefined });
  }
});

// ---- Operation banner ----------------------------------------------------

function renderBanner(): void {
  const s = repoState;
  banner.hidden = !s?.operation;
  if (!s?.operation) return;
  const n = s.conflicts.length;
  const op = (action: OperationAction) => () => send({ type: 'operation', action });
  setChildren(
    banner,
    icon('warning'),
    h('span', { class: 'text' }, s.description ?? s.operation, n ? ` with ${n} conflicted file${n === 1 ? '' : 's'}` : ''),
    n ? button('Resolve Conflicts', () => send({ type: 'resolveConflicts' }), { icon: 'git-merge' }) : button('Continue', op('continue'), { icon: 'debug-continue' }),
    s.operation !== 'merge' ? button('Skip', op('skip'), { secondary: true }) : null,
    button('Abort', op('abort'), { secondary: true }),
  );
}

// ---- Branch sidebar ------------------------------------------------------

interface TreeNode {
  children: Map<string, TreeNode>;
  ref?: { full: string; name: string; remote: boolean; tag: boolean; track?: string; current?: boolean };
}

function buildTree(names: Array<{ name: string; full: string; remote: boolean; tag: boolean; track?: string; current?: boolean }>): TreeNode {
  const rootNode: TreeNode = { children: new Map() };
  for (const n of names) {
    const parts = n.name.split('/');
    let node = rootNode;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part + '/')) node.children.set(part + '/', { children: new Map() });
      node = node.children.get(part + '/')!;
    }
    node.children.set(parts[parts.length - 1], { children: new Map(), ref: n });
  }
  return rootNode;
}

function renderBranches(): void {
  const q = branchQuery.toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const sections: Array<{ key: string; label: string; icon: string; tree: TreeNode; count: number }> = [];
  const local = refs.local.filter((b) => match(b.name));
  const remote = refs.remote.filter((b) => match(b.name));
  const tags = refs.tags.filter(match);
  sections.push({
    key: 'local',
    label: 'Local',
    icon: 'git-branch',
    count: local.length,
    tree: buildTree(local.map((b) => ({ name: b.name, full: `refs/heads/${b.name}`, remote: false, tag: false, track: b.track, current: b.name === refs.current }))),
  });
  sections.push({ key: 'remote', label: 'Remote', icon: 'cloud', count: remote.length, tree: buildTree(remote.map((b) => ({ name: b.name, full: `refs/remotes/${b.name}`, remote: true, tag: false }))) });
  sections.push({ key: 'tags', label: 'Tags', icon: 'tag', count: tags.length, tree: buildTree(tags.map((t) => ({ name: t, full: `refs/tags/${t}`, remote: false, tag: true }))) });

  const rows: HTMLElement[] = [
    branchRow(0, icon('list-flat'), 'All branches', !filter.branch, () => setFilter({ branch: undefined })),
    branchRow(0, icon('target'), refs.current ? `HEAD (${refs.current})` : 'HEAD (detached)', filter.branch === 'HEAD', () => setFilter({ branch: 'HEAD' })),
  ];
  for (const s of sections) {
    const isCollapsed = collapsed.has(s.key) && !q;
    rows.push(folderRow(0, s.key, `${s.label}`, s.count, isCollapsed));
    if (!isCollapsed) renderTreeNodes(s.tree, 1, s.key, rows);
  }
  branchTree.replaceChildren(...rows);
}

function renderTreeNodes(node: TreeNode, depth: number, path: string, rows: HTMLElement[]): void {
  const entries = [...node.children.entries()].sort(([a, x], [b, y]) => Number(!!x.ref) - Number(!!y.ref) || a.localeCompare(b));
  for (const [name, child] of entries) {
    if (child.ref) {
      const r = child.ref;
      const row = branchRow(
        depth,
        icon(r.current ? 'star-full' : r.tag ? 'tag' : 'git-branch', r.current ? 'current' : ''),
        name,
        filter.branch === r.full,
        () => setFilter({ branch: r.full }),
        r.track,
      );
      row.title = r.full.replace(/^refs\/(heads|remotes|tags)\//, '');
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, branchMenu(r.full, r.name, r.remote, r.tag, !!r.current));
      });
      rows.push(row);
    } else {
      const key = `${path}/${name}`;
      const isCollapsed = collapsed.has(key) && !branchQuery;
      rows.push(folderRow(depth, key, name.slice(0, -1), countLeaves(child), isCollapsed));
      if (!isCollapsed) renderTreeNodes(child, depth + 1, key, rows);
    }
  }
}

function countLeaves(node: TreeNode): number {
  let n = 0;
  for (const c of node.children.values()) n += c.ref ? 1 : countLeaves(c);
  return n;
}

function folderRow(depth: number, key: string, label: string, count: number, isCollapsed: boolean): HTMLElement {
  return h(
    'div',
    {
      class: 'tree-row folder',
      style: `padding-left: ${4 + depth * 14}px`,
      onclick: () => {
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        renderBranches();
      },
    },
    icon(isCollapsed ? 'chevron-right' : 'chevron-down'),
    h('span', { class: 'label' }, label),
    h('span', { class: 'count' }, count),
  );
}

function branchRow(depth: number, iconEl: HTMLElement, label: string, isSelected: boolean, onClick: () => void, detail?: string): HTMLElement {
  return h(
    'div',
    { class: `tree-row${isSelected ? ' selected' : ''}`, style: `padding-left: ${4 + depth * 14 + 16}px`, onclick: onClick },
    iconEl,
    h('span', { class: 'label' }, label),
    detail ? h('span', { class: 'track' }, detail.replace('ahead ', '↑').replace('behind ', '↓').replace(', ', ' ')) : null,
  );
}

function branchMenu(full: string, name: string, remote: boolean, tag: boolean, current: boolean): MenuItem[] {
  const act = (action: BranchAction) => () => send({ type: 'branchAction', action, name, remote });
  const cur = refs.current ?? 'HEAD';
  if (tag) {
    return [
      { label: 'Show Log', icon: 'list-flat', action: () => setFilter({ branch: full }) },
      { label: `Merge '${name}' into '${cur}'`, icon: 'git-merge', action: () => send({ type: 'commitAction', action: 'merge', hashes: [name] }) },
      { label: 'Copy Name', icon: 'copy', action: () => send({ type: 'copy', text: name }) },
    ];
  }
  return [
    { label: 'Checkout', icon: 'check', action: act('checkout'), disabled: current },
    { label: `New Branch from '${name}'…`, icon: 'git-branch-create', action: act('newBranch') },
    { label: 'Show Log', icon: 'list-flat', action: () => setFilter({ branch: full }) },
    'separator',
    { label: `Merge '${name}' into '${cur}'`, icon: 'git-merge', action: act('merge'), disabled: current },
    { label: `Rebase '${cur}' onto '${name}'`, icon: 'git-pull-request', action: act('rebaseOnto'), disabled: current },
    'separator',
    { label: 'Copy Name', icon: 'copy', action: () => send({ type: 'copy', text: name }) },
    { label: remote ? 'Delete Remote Branch…' : 'Delete', icon: 'trash', action: act('delete'), disabled: current },
  ];
}

branchFilterInput.addEventListener('input', () => {
  branchQuery = branchFilterInput.value;
  renderBranches();
});

// ---- Commit list ---------------------------------------------------------

function renderCommits(): void {
  commitList.replaceChildren();
  if (!commits.length) {
    commitList.append(h('div', { class: 'empty' }, 'No commits match the current filters.'));
    renderDetails(undefined, 0, []);
    return;
  }
  appendRows(0);
}

function appendRows(start: number): void {
  const frag = document.createDocumentFragment();
  for (let i = start; i < commits.length; i++) frag.append(commitRow(commits[i], i));
  commitList.append(frag);
}

function commitRow(c: Commit, index: number): HTMLElement {
  const isMerge = c.parents.length > 1;
  const row = h(
    'div',
    {
      class: `commit-row${selected.has(c.hash) ? ' selected' : ''}${isMerge ? ' merge' : ''}`,
      dataset: { index: String(index) },
    },
    h('span', { class: 'subject' }, ...refLabels(c.refs), h('span', { class: 'text', title: c.subject }, c.subject)),
    h('span', { class: 'author', title: `${c.author} <${c.email}>` }, c.author),
    h('span', { class: 'date', title: new Date(c.date * 1000).toLocaleString() }, formatDate(c.date)),
    h('span', { class: 'hash' }, c.hash.slice(0, 8)),
  );
  return row;
}

function refLabels(labels: RefLabel[]): HTMLElement[] {
  const shown = labels.slice(0, 3).map((l) =>
    h(
      'span',
      { class: `ref ref-${l.type}${l.current ? ' current' : ''}`, title: l.name },
      icon(l.type === 'tag' ? 'tag' : l.type === 'remote' ? 'cloud' : l.type === 'head' ? 'target' : 'git-branch'),
      l.name,
    ),
  );
  if (labels.length > 3) {
    shown.push(h('span', { class: 'ref ref-more', title: labels.slice(3).map((l) => l.name).join('\n') }, `+${labels.length - 3}`));
  }
  return shown;
}

function rowAt(index: number): HTMLElement | undefined {
  return commitList.querySelector<HTMLElement>(`.commit-row[data-index="${index}"]`) ?? undefined;
}

function syncSelectionClasses(): void {
  for (const row of commitList.querySelectorAll<HTMLElement>('.commit-row')) {
    const c = commits[Number(row.dataset.index)];
    row.classList.toggle('selected', !!c && selected.has(c.hash));
    row.classList.toggle('focused', Number(row.dataset.index) === focusIndex);
  }
}

function selectIndex(index: number, extend: boolean, toggle: boolean): void {
  if (index < 0 || index >= commits.length) return;
  if (extend && anchorIndex >= 0) {
    selected.clear();
    const [a, b] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    for (let i = a; i <= b; i++) selected.add(commits[i].hash);
  } else if (toggle) {
    const hash = commits[index].hash;
    if (selected.has(hash) && selected.size > 1) selected.delete(hash);
    else selected.add(hash);
    anchorIndex = index;
  } else {
    selected.clear();
    selected.add(commits[index].hash);
    anchorIndex = index;
  }
  focusIndex = index;
  syncSelectionClasses();
  rowAt(index)?.scrollIntoView({ block: 'nearest' });
  requestDetails();
}

/** Selected hashes ordered oldest first (the list is newest first). */
function selectedOldestFirst(): string[] {
  return commits
    .map((c, i) => [c.hash, i] as const)
    .filter(([hash]) => selected.has(hash))
    .sort((a, b) => b[1] - a[1])
    .map(([hash]) => hash);
}

function requestDetails(): void {
  clearTimeout(detailsTimer);
  detailsTimer = window.setTimeout(() => {
    const hashes = selectedOldestFirst();
    if (!hashes.length) {
      renderDetails(undefined, 0, []);
      return;
    }
    send({ type: 'select', requestId: ++detailsRequestId, hashes });
  }, 60);
}

commitList.addEventListener('mousedown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.commit-row');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (e.button === 2) {
    if (!selected.has(commits[index].hash)) selectIndex(index, false, false);
    return;
  }
  selectIndex(index, e.shiftKey, e.metaKey || e.ctrlKey);
});

commitList.addEventListener('contextmenu', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.commit-row');
  if (!row) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, commitMenu());
});

commitList.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = Math.max(0, Math.min(commits.length - 1, focusIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    selectIndex(next, e.shiftKey, false);
    if (next >= commits.length - 20) loadMore();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    send({ type: 'commitAction', action: 'copyHash', hashes: selectedOldestFirst() });
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    e.preventDefault();
    commits.forEach((c) => selected.add(c.hash));
    syncSelectionClasses();
    requestDetails();
  }
});

commitList.addEventListener('scroll', () => {
  if (commitList.scrollTop + commitList.clientHeight > commitList.scrollHeight - 400) loadMore();
});

function commitMenu(): MenuItem[] {
  const hashes = selectedOldestFirst();
  const single = hashes.length === 1;
  const cur = refs.current ?? 'HEAD';
  const act = (action: CommitAction) => () => send({ type: 'commitAction', action, hashes });
  const n = single ? '' : ` ${hashes.length} Commits`;
  return [
    { label: single ? 'Copy Revision Number' : 'Copy Revision Numbers', icon: 'copy', action: act('copyHash') },
    { label: 'Create Branch…', icon: 'git-branch-create', action: act('newBranch'), disabled: !single },
    { label: 'Create Tag…', icon: 'tag', action: act('newTag'), disabled: !single },
    { label: 'Checkout Revision', icon: 'check', action: act('checkout'), disabled: !single },
    'separator',
    { label: `Cherry-Pick${n}`, icon: 'git-commit', action: act('cherryPick') },
    { label: `Revert${n || ' Commit'}`, icon: 'discard', action: act('revert') },
    'separator',
    { label: `Reset '${cur}' to Here…`, icon: 'history', action: act('reset'), disabled: !single },
    { label: `Rebase '${cur}' onto Here`, icon: 'git-pull-request', action: act('rebaseOnto'), disabled: !single },
    { label: `Merge into '${cur}'…`, icon: 'git-merge', action: act('merge'), disabled: !single },
  ];
}

// ---- Details -------------------------------------------------------------

interface DirNode {
  dirs: Map<string, DirNode>;
  files: FileChange[];
}

const collapsedDirs = new Set<string>();
// Inputs of the last render, so folder toggles can redraw without a round trip.
let lastDetails: CommitDetails | undefined;
let lastCount = 0;
let lastFiles: FileChange[] = [];

function renderDetails(details: CommitDetails | undefined, count: number, files: FileChange[]): void {
  lastDetails = details;
  lastCount = count;
  lastFiles = files;
  filesHeader.replaceChildren(
    h('span', null, count > 1 ? `${count} commits selected` : count === 1 ? 'Changed files' : 'No selection'),
    h('span', { class: 'muted' }, files.length ? ` ${files.length} file${files.length === 1 ? '' : 's'}` : ''),
  );

  const tree: DirNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push(f);
  }
  const rows: HTMLElement[] = [];
  renderDir(tree, '', 0, rows);
  fileTree.replaceChildren(...rows);
  if (!files.length && count) fileTree.append(h('div', { class: 'empty' }, 'No file changes'));

  if (!details) {
    messagePane.hidden = true;
    return;
  }
  messagePane.hidden = false;
  const [subject, ...body] = details.message.split('\n');
  const sameCommitter = details.committer === details.author && details.committerEmail === details.email;
  setChildren(
    messagePane,
    h('div', { class: 'msg-subject' }, subject),
    body.join('\n').trim() ? h('pre', { class: 'msg-body' }, body.join('\n').trim()) : null,
    h(
      'div',
      { class: 'msg-meta' },
      h(
        'span',
        { class: 'hash-link', title: 'Copy full hash', onclick: () => send({ type: 'copy', text: details.hash }) },
        details.hash.slice(0, 10),
        icon('copy'),
      ),
      ` ${details.author} <${details.email}> on ${new Date(details.authorDate * 1000).toLocaleString()}`,
    ),
    sameCommitter ? null : h('div', { class: 'msg-meta' }, `Committed by ${details.committer} on ${new Date(details.commitDate * 1000).toLocaleString()}`),
    details.parents.length > 1 ? h('div', { class: 'msg-meta' }, `Merge of ${details.parents.map((p) => p.slice(0, 8)).join(', ')} (changes shown against the first parent)`) : null,
    details.refs.length ? h('div', { class: 'msg-refs' }, ...refLabels(details.refs)) : null,
  );
}

function renderDir(node: DirNode, prefix: string, depth: number, rows: HTMLElement[]): void {
  for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Compress chains of single-child folders: "src/webview" instead of "src" > "webview".
    let label = name;
    let dir = child;
    while (dir.files.length === 0 && dir.dirs.size === 1) {
      const [nextName, next] = [...dir.dirs.entries()][0];
      label += '/' + nextName;
      dir = next;
    }
    const key = prefix + label;
    const isCollapsed = collapsedDirs.has(key);
    rows.push(
      h(
        'div',
        {
          class: 'tree-row folder',
          style: `padding-left: ${4 + depth * 14}px`,
          onclick: () => {
            if (collapsedDirs.has(key)) collapsedDirs.delete(key);
            else collapsedDirs.add(key);
            renderDetails(lastDetails, lastCount, lastFiles);
          },
        },
        icon(isCollapsed ? 'chevron-right' : 'chevron-down'),
        icon('folder'),
        h('span', { class: 'label' }, label),
      ),
    );
    if (!isCollapsed) renderDir(dir, key + '/', depth + 1, rows);
  }
  for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) rows.push(fileRow(f, depth));
}

function fileRow(f: FileChange, depth: number): HTMLElement {
  const name = f.path.split('/').pop()!;
  const renamedFrom = f.status === 'R' ? f.leftPath : undefined;
  const row = h(
    'div',
    {
      class: 'tree-row file-row',
      style: `padding-left: ${4 + depth * 14 + 16}px`,
      title: renamedFrom ? `${renamedFrom} → ${f.path}` : f.path,
      onclick: () => {
        fileTree.querySelectorAll('.file-row.selected').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        send({ type: 'openDiff', change: f });
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Show Diff', icon: 'diff', action: () => send({ type: 'openDiff', change: f }) },
          { label: 'Compare with Local', icon: 'compare-changes', action: () => send({ type: 'compareLocal', change: f }), disabled: f.status === 'D' && !f.leftRef },
          { label: 'Open Version at Revision', icon: 'go-to-file', action: () => send({ type: 'openRevision', change: f }) },
          'separator',
          { label: 'Show History for File', icon: 'history', action: () => setFilter({ path: f.path }) },
          { label: 'Copy Path', icon: 'copy', action: () => send({ type: 'copy', text: f.path }) },
        ]);
      },
    },
    h('span', { class: `status status-${f.status}` }, f.status),
    h('span', { class: `label status-${f.status}` }, name),
    renamedFrom ? h('span', { class: 'muted rename' }, `← ${renamedFrom}`) : null,
  );
  return row;
}

send({ type: 'ready' });
