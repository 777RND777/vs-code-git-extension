import * as vscode from 'vscode';
import type { GitRepo } from './git';
import { branchAction, commitAction, operationAction, showConflicts } from './operations';
import type { RepoManager } from './repos';
import { compareWithLocal, openAtRevision, openChangeDiff } from './revisions';
import type { LogRequest, LogResponse } from './shared/messages';
import type { LogFilter, RefsInfo, RepoState } from './shared/types';
import { webviewHtml } from './webviewHtml';

/** The Git Log editor tab: commit list with filters, branch sidebar and commit details. */
export class LogPanel {
  private static current?: LogPanel;

  private readonly disposables: vscode.Disposable[] = [];
  private refsSignature = '';

  static show(context: vscode.ExtensionContext, repos: RepoManager, repo: GitRepo, filter: LogFilter = {}): void {
    if (LogPanel.current) {
      const p = LogPanel.current;
      p.panel.reveal();
      if (p.repo !== repo) {
        p.repo = repo;
        p.filter = filter;
        void p.sendInit();
      } else {
        p.filter = filter;
        p.post({ type: 'setFilter', filter });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('gitWorkbench.log', 'Git Log', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    LogPanel.current = new LogPanel(panel, context, repos, repo, filter);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private repo: GitRepo,
    private filter: LogFilter,
  ) {
    panel.iconPath = new vscode.ThemeIcon('git-commit');
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'log');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: LogRequest) => this.handle(m).catch((e) => this.fail(e))),
      repos.onDidChangeRepo((r) => {
        if (r === this.repo) void this.onRepoChanged();
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(message: LogResponse): void {
    void this.panel.webview.postMessage(message);
  }

  private fail(e: unknown): void {
    this.post({ type: 'error', message: (e as Error).message });
  }

  private async sendInit(): Promise<void> {
    const repo = this.repo;
    this.panel.title = `Git Log: ${repo.name}`;
    const [refs, authors, me, state] = await Promise.all([repo.refs(), repo.authors(), repo.me(), repo.state()]);
    this.refsSignature = signature(refs, state);
    this.post({
      type: 'init',
      repos: this.repos.list().map((r) => ({ root: r.root, name: r.name })),
      root: repo.root,
      refs,
      authors,
      me,
      state,
      filter: this.filter,
    });
  }

  private async onRepoChanged(): Promise<void> {
    const [refs, state] = await Promise.all([this.repo.refs(), this.repo.state()]);
    // Working tree edits also fire change events; only reload when refs or the operation state moved.
    const sig = signature(refs, state);
    if (sig === this.refsSignature) return;
    this.refsSignature = sig;
    this.post({ type: 'repoChanged', refs, state });
  }

  private async handle(m: LogRequest): Promise<void> {
    const repo = this.repo;
    switch (m.type) {
      case 'ready':
        return this.sendInit();
      case 'setRepo':
        this.repo = this.repos.get(m.root);
        this.filter = {};
        return this.sendInit();
      case 'loadLog': {
        const pageSize = vscode.workspace.getConfiguration('gitWorkbench').get<number>('log.pageSize', 500);
        this.filter = m.filter;
        const commits = await repo.log(m.filter, m.skip, pageSize);
        this.post({ type: 'log', requestId: m.requestId, commits, append: m.skip > 0, hasMore: commits.length >= pageSize });
        return;
      }
      case 'select': {
        if (m.hashes.length === 1) {
          const [details, files] = await Promise.all([repo.details(m.hashes[0]), repo.commitFiles(m.hashes[0])]);
          this.post({ type: 'details', requestId: m.requestId, details, count: 1, files });
        } else {
          const files = await repo.combinedFiles(m.hashes);
          this.post({ type: 'details', requestId: m.requestId, count: m.hashes.length, files });
        }
        return;
      }
      case 'openDiff':
        await openChangeDiff(repo.root, m.change);
        return;
      case 'compareLocal':
        await compareWithLocal(repo.root, m.change);
        return;
      case 'openRevision':
        await openAtRevision(repo.root, m.change);
        return;
      case 'commitAction':
        return commitAction(this.repos, repo, m.action, m.hashes);
      case 'branchAction':
        return branchAction(this.repos, repo, m.action, m.name, m.remote);
      case 'fetch':
        this.post({ type: 'busy', busy: true });
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Fetching all remotes' },
            () => repo.exec(['fetch', '--all', '--prune']),
          );
        } finally {
          this.post({ type: 'busy', busy: false });
          this.repos.refresh(repo);
        }
        return;
      case 'resolveConflicts':
        showConflicts(repo);
        return;
      case 'operation':
        return operationAction(this.repos, repo, m.action);
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
    }
  }

  private dispose(): void {
    LogPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

function signature(refs: RefsInfo, state: RepoState): string {
  const branches = [...refs.local, ...refs.remote].map((b) => b.name + b.hash);
  return [refs.head, state.operation, state.conflicts.length, ...branches, ...refs.tags].join(',');
}
