import * as path from 'path';
import * as vscode from 'vscode';
import { GitRepo } from './git';

// The parts of the built-in vscode.git extension API this extension uses.
interface GitApiRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}
interface GitApi {
  git: { path: string };
  repositories: GitApiRepository[];
  onDidOpenRepository: vscode.Event<GitApiRepository>;
  onDidCloseRepository: vscode.Event<GitApiRepository>;
}

/** Tracks the workspace's git repositories and reports (debounced) when one changes. */
export class RepoManager implements vscode.Disposable {
  private readonly repos = new Map<string, GitRepo>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<GitRepo>();
  private readonly listEmitter = new vscode.EventEmitter<void>();
  private gitPath = 'git';

  readonly onDidChangeRepo = this.changeEmitter.event;
  readonly onDidChangeList = this.listEmitter.event;

  async init(): Promise<void> {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    const api = ext ? (await ext.activate()).getAPI(1) : undefined;
    if (!api) {
      await this.addWorkspaceFolders();
      return;
    }
    this.gitPath = api.git.path || 'git';
    const add = (r: GitApiRepository) => {
      const repo = this.add(r.rootUri.fsPath);
      this.disposables.push(r.state.onDidChange(() => this.refresh(repo)));
      this.listEmitter.fire();
    };
    api.repositories.forEach(add);
    this.disposables.push(
      api.onDidOpenRepository(add),
      api.onDidCloseRepository((r) => {
        this.repos.delete(r.rootUri.fsPath);
        this.listEmitter.fire();
      }),
    );
  }

  private add(root: string): GitRepo {
    let repo = this.repos.get(root);
    if (!repo) {
      repo = new GitRepo(root, this.gitPath);
      this.repos.set(root, repo);
    }
    return repo;
  }

  private async addWorkspaceFolders(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const top = await new GitRepo(folder.uri.fsPath).tryExec(['rev-parse', '--show-toplevel']);
      if (top) this.add(top.trim());
    }
    this.listEmitter.fire();
  }

  list(): GitRepo[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(root: string): GitRepo {
    return this.repos.get(root) ?? this.add(root);
  }

  /** Repository containing the file, if any (deepest match wins for nested repos). */
  forFile(fsPath: string): GitRepo | undefined {
    return this.list()
      .filter((r) => fsPath === r.root || fsPath.startsWith(r.root + path.sep))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  /** The repository for a command: the given file's, the active editor's, the only one, or asks. */
  async pick(uri?: vscode.Uri): Promise<GitRepo | undefined> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const fromFile = target?.scheme === 'file' ? this.forFile(target.fsPath) : undefined;
    if (fromFile) return fromFile;
    const all = this.list();
    if (all.length <= 1) {
      if (!all.length) vscode.window.showWarningMessage('Git Merge Studio: no Git repository is open in this workspace.');
      return all[0];
    }
    const choice = await vscode.window.showQuickPick(
      all.map((r) => ({ label: r.name, description: r.root, repo: r })),
      { placeHolder: 'Choose a repository' },
    );
    return choice?.repo;
  }

  /** Signals that a repository changed; listeners run once things settle. */
  refresh(repo: GitRepo): void {
    clearTimeout(this.timers.get(repo.root));
    this.timers.set(
      repo.root,
      setTimeout(() => this.changeEmitter.fire(repo), 300),
    );
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
    this.listEmitter.dispose();
  }
}
