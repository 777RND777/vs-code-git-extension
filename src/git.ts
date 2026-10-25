import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Commit,
  CommitDetails,
  ConflictFile,
  FileChange,
  LogFilter,
  OperationKind,
  RefLabel,
  RefsInfo,
  RepoState,
  SideState,
} from './shared/types';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const FS = '\x1f';
const RS = '\x1e';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  /** Extra environment, e.g. GIT_EDITOR for --continue. */
  env?: Record<string, string>;
}

export class GitRepo {
  private gitDirCache?: string;

  constructor(
    readonly root: string,
    private readonly gitPath = 'git',
  ) {}

  get name(): string {
    return path.basename(this.root);
  }

  run(args: string[], opts: ExecOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
        cwd: this.root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), code }));
      child.stdin.end();
    });
  }

  async exec(args: string[], opts?: ExecOptions): Promise<string> {
    const r = await this.run(args, opts);
    if (r.code !== 0) {
      const detail = (r.stderr.trim() || r.stdout.toString('utf8').trim()).split('\n').filter(Boolean);
      throw new GitError(detail.slice(-3).join('\n') || `git ${args[0]} failed`, r.stderr, r.code);
    }
    return r.stdout.toString('utf8');
  }

  async tryExec(args: string[]): Promise<string | undefined> {
    const r = await this.run(args);
    return r.code === 0 ? r.stdout.toString('utf8') : undefined;
  }

  async gitDir(): Promise<string> {
    this.gitDirCache ??= (await this.exec(['rev-parse', '--absolute-git-dir'])).trim();
    return this.gitDirCache;
  }

  // ---- Log ----------------------------------------------------------------

  async log(filter: LogFilter, skip: number, limit: number): Promise<Commit[]> {
    const format = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';
    const args = ['log', '--decorate=full', `--format=${format}`, '--date-order', `--skip=${skip}`, `--max-count=${limit}`];
    const text = filter.text?.trim();
    if (text) args.push('-i', `--grep=${text}`);
    for (const author of filter.authors ?? []) args.push(`--author=${author}`);
    if (text || filter.authors?.length) args.push('--fixed-strings');
    if (filter.branch) args.push(filter.branch);
    else args.push('--branches', '--remotes', '--tags', 'HEAD');
    args.push('--');
    if (filter.path) args.push(filter.path);

    const commits = parseLog(await this.exec(args));

    // A hash typed in the search box shows that commit first, even if its message doesn't match.
    if (text && skip === 0 && /^[0-9a-f]{4,40}$/i.test(text)) {
      const exact = await this.tryExec(['log', '--decorate=full', `--format=${format}`, '-1', `${text}^{commit}`, '--']);
      const found = exact ? parseLog(exact) : [];
      if (found.length) return [found[0], ...commits.filter((c) => c.hash !== found[0].hash)];
    }
    return commits;
  }

  async refs(): Promise<RefsInfo> {
    const out = await this.exec([
      'for-each-ref',
      `--format=%(refname)${FS}%(objectname)${FS}%(upstream:short)${FS}%(upstream:track,nobracket)`,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]);
    const info: RefsInfo = { local: [], remote: [], tags: [] };
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [ref, hash, upstream, track] = line.split(FS);
      if (ref.startsWith('refs/heads/')) {
        info.local.push({ name: ref.slice(11), hash, upstream: upstream || undefined, track: track || undefined });
      } else if (ref.startsWith('refs/remotes/')) {
        if (!ref.endsWith('/HEAD')) info.remote.push({ name: ref.slice(13), hash });
      } else if (ref.startsWith('refs/tags/')) {
        info.tags.push(ref.slice(10));
      }
    }
    info.current = (await this.tryExec(['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || undefined;
    info.head = (await this.tryExec(['rev-parse', 'HEAD']))?.trim() || undefined;
    return info;
  }

  async authors(): Promise<string[]> {
    const out = (await this.tryExec(['shortlog', '-sne', '--branches', '--remotes', '--tags', 'HEAD'])) ?? '';
    return out
      .split('\n')
      .map((l) => l.replace(/^\s*\d+\t/, '').trim())
      .filter(Boolean);
  }

  async me(): Promise<string | undefined> {
    const name = (await this.tryExec(['config', 'user.name']))?.trim();
    const email = (await this.tryExec(['config', 'user.email']))?.trim();
    return name && email ? `${name} <${email}>` : undefined;
  }

  // ---- Commit contents -------------------------------------------------------

  async details(hash: string): Promise<CommitDetails> {
    const format = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%B'].join('%x1f');
    const out = await this.exec(['show', '-s', '--decorate=full', `--format=${format}`, hash]);
    const [h, parents, author, email, at, committer, committerEmail, ct, decorations, ...body] = out.split(FS);
    return {
      hash: h,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      authorDate: Number(at),
      committer,
      committerEmail,
      commitDate: Number(ct),
      refs: parseDecorations(decorations),
      message: body.join(FS).trimEnd(),
    };
  }

  /** Files changed by one commit, compared with its first parent. */
  async commitFiles(hash: string): Promise<FileChange[]> {
    const parents = (await this.exec(['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
    const parent = parents[0];
    const args = ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id'];
    args.push(...(parent ? [parent, hash] : ['--root', hash]));
    return parseNameStatus(await this.exec(args)).map((c) => ({
      status: c.status,
      path: c.path,
      leftRef: c.status === 'A' ? undefined : (parent ?? EMPTY_TREE),
      leftPath: c.status === 'A' ? undefined : (c.oldPath ?? c.path),
      rightRef: c.status === 'D' ? undefined : hash,
      rightPath: c.status === 'D' ? undefined : c.path,
    }));
  }

  /**
   * Combined changes of several commits, oldest first. For each file the left side is the version
   * before the first selected commit that touched it, the right side the version after the last one.
   */
  async combinedFiles(hashesOldestFirst: string[]): Promise<FileChange[]> {
    const byPath = new Map<string, FileChange>();
    for (const hash of hashesOldestFirst) {
      for (const change of await this.commitFiles(hash)) {
        const before = change.leftPath ?? change.path;
        const earlier = byPath.get(before);
        byPath.delete(before);
        const merged: FileChange = earlier
          ? { ...earlier, rightRef: change.rightRef, rightPath: change.rightPath }
          : change;
        byPath.set(merged.rightPath ?? before, merged);
      }
    }
    const result: FileChange[] = [];
    for (const c of byPath.values()) {
      if (!c.leftRef && !c.rightRef) continue; // added then deleted
      const status = !c.leftRef ? 'A' : !c.rightRef ? 'D' : c.leftPath !== c.rightPath ? 'R' : 'M';
      result.push({ ...c, status, path: c.rightPath ?? c.leftPath! });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** File contents at a revision, or at an index stage (":1", ":2", ":3"). */
  async show(ref: string, file: string): Promise<Buffer | undefined> {
    const r = await this.run(['show', `${ref}:${file}`]);
    return r.code === 0 ? r.stdout : undefined;
  }

  // ---- Operation state & conflicts -----------------------------------------

  async state(): Promise<RepoState> {
    const gitDir = await this.gitDir();
    const exists = (p: string) => fs.existsSync(path.join(gitDir, p));
    const read = (p: string) => {
      try {
        return fs.readFileSync(path.join(gitDir, p), 'utf8').trim();
      } catch {
        return '';
      }
    };

    let operation: OperationKind | undefined;
    if (exists('rebase-merge') || exists('rebase-apply')) operation = 'rebase';
    else if (exists('MERGE_HEAD')) operation = 'merge';
    else if (exists('CHERRY_PICK_HEAD')) operation = 'cherry-pick';
    else if (exists('REVERT_HEAD')) operation = 'revert';

    const current = (await this.tryExec(['symbolic-ref', '--short', '-q', 'HEAD']))?.trim();
    const describe = async (rev: string) => {
      const out = await this.tryExec(['log', '-1', '--format=%h %s', rev, '--']);
      return out?.trim() || rev;
    };

    let oursLabel = current ? `${current} (HEAD)` : 'HEAD';
    let theirsLabel = 'incoming';
    let description: string | undefined;
    switch (operation) {
      case 'merge': {
        const mergeHead = read('MERGE_HEAD').split('\n')[0];
        const name = (await this.tryExec(['name-rev', '--name-only', '--exclude=refs/tags/*', mergeHead]))?.trim();
        theirsLabel = name && name !== 'undefined' ? name : mergeHead.slice(0, 8);
        description = `Merging ${theirsLabel} into ${current ?? 'HEAD'}`;
        break;
      }
      case 'cherry-pick':
        theirsLabel = await describe('CHERRY_PICK_HEAD');
        description = `Cherry-picking ${theirsLabel}`;
        break;
      case 'revert':
        theirsLabel = `revert of ${await describe('REVERT_HEAD')}`;
        description = `Reverting ${await describe('REVERT_HEAD')}`;
        break;
      case 'rebase': {
        const dir = exists('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
        const branch = read(`${dir}/head-name`).replace(/^refs\/heads\//, '') || 'HEAD';
        const onto = read(`${dir}/onto`);
        const ontoName = onto ? (await this.tryExec(['name-rev', '--name-only', '--exclude=refs/tags/*', onto]))?.trim() : '';
        const ontoLabel = ontoName && ontoName !== 'undefined' ? ontoName : onto.slice(0, 8);
        // During a rebase "ours" is the branch being rebased onto and "theirs" is your commit being replayed.
        oursLabel = `${ontoLabel} (rebasing onto)`;
        theirsLabel = exists('REBASE_HEAD') ? `your commit ${await describe('REBASE_HEAD')}` : branch;
        const step = read(`${dir}/msgnum`);
        const total = read(`${dir}/end`);
        description = `Rebasing ${branch} onto ${ontoLabel}` + (step && total ? ` (${step}/${total})` : '');
        break;
      }
    }

    return { operation, description, oursLabel, theirsLabel, conflicts: await this.conflicts() };
  }

  async conflicts(): Promise<ConflictFile[]> {
    const out = await this.exec(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
    const tokens = out.split('\0');
    const files: ConflictFile[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++; // the original path follows a rename
      const side = SIDES[code];
      if (side) files.push({ path: file, code, ours: side[0], theirs: side[1] });
    }
    return files;
  }

  // ---- Mutations -------------------------------------------------------------

  async acceptSide(file: ConflictFile, side: 'ours' | 'theirs'): Promise<void> {
    const state = side === 'ours' ? file.ours : file.theirs;
    if (state === 'deleted') {
      await this.exec(['rm', '--quiet', '--', file.path]);
    } else {
      await this.exec(['checkout', `--${side}`, '--', file.path]);
      await this.exec(['add', '--', file.path]);
    }
  }

  async continueOperation(op: OperationKind): Promise<void> {
    // GIT_EDITOR=true accepts the prepared commit message (minus git's "# Conflicts" comments)
    // instead of opening an editor.
    await this.exec([op, '--continue'], { env: { GIT_EDITOR: 'true' } });
  }

  abortOperation(op: OperationKind): Promise<string> {
    return this.exec([op, '--abort']);
  }

  skipCommit(op: OperationKind): Promise<string> {
    return this.exec([op, '--skip'], { env: { GIT_EDITOR: 'true' } });
  }
}

const SIDES: Record<string, [SideState, SideState]> = {
  UU: ['modified', 'modified'],
  AA: ['added', 'added'],
  AU: ['added', 'modified'],
  UA: ['modified', 'added'],
  DU: ['deleted', 'modified'],
  UD: ['modified', 'deleted'],
  DD: ['deleted', 'deleted'],
};

function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of out.split(RS)) {
    const rec = record.replace(/^\n/, '');
    if (!rec) continue;
    const [hash, parents, author, email, date, decorations, subject] = rec.split(FS);
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      refs: parseDecorations(decorations),
      subject: subject ?? '',
    });
  }
  return commits;
}

/** Parses %D output produced with --decorate=full. */
export function parseDecorations(decorations: string | undefined): RefLabel[] {
  if (!decorations) return [];
  const labels: RefLabel[] = [];
  for (const raw of decorations.split(', ')) {
    const d = raw.trim();
    if (d === 'HEAD') labels.push({ name: 'HEAD', type: 'head' });
    else if (d.startsWith('HEAD -> ')) labels.push({ name: d.slice(8).replace(/^refs\/heads\//, ''), type: 'local', current: true });
    else if (d.startsWith('tag: ')) labels.push({ name: d.slice(5).replace(/^refs\/tags\//, ''), type: 'tag' });
    else if (d.startsWith('refs/heads/')) labels.push({ name: d.slice(11), type: 'local' });
    else if (d.startsWith('refs/remotes/') && !d.endsWith('/HEAD')) labels.push({ name: d.slice(13), type: 'remote' });
  }
  return labels;
}

function parseNameStatus(out: string): Array<{ status: 'A' | 'M' | 'D' | 'R'; path: string; oldPath?: string }> {
  const tokens = out.split('\0');
  const changes: Array<{ status: 'A' | 'M' | 'D' | 'R'; path: string; oldPath?: string }> = [];
  for (let i = 0; i < tokens.length - 1; ) {
    const code = tokens[i++];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      changes.push(letter === 'R' ? { status: 'R', path: newPath, oldPath } : { status: 'A', path: newPath });
    } else {
      const p = tokens[i++];
      changes.push({ status: letter === 'A' || letter === 'D' ? letter : 'M', path: p });
    }
  }
  return changes;
}

export function shortHash(ref: string | undefined): string {
  if (!ref) return 'none';
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}
