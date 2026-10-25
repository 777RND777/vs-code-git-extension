import * as path from 'path';
import * as vscode from 'vscode';
import type { GitRepo } from './git';
import { MergePanel } from './mergePanel';
import { offerContinue, operationAction } from './operations';
import type { RepoManager } from './repos';
import type { ConflictsRequest, ConflictsResponse } from './shared/messages';
import { webviewHtml } from './webviewHtml';

/** Lists conflicted files of a repository with Accept Yours / Accept Theirs / Merge… actions. */
export class ConflictsPanel {
  private static readonly panels = new Map<string, ConflictsPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;

  static show(context: vscode.ExtensionContext, repos: RepoManager, repo: GitRepo): void {
    const existing = ConflictsPanel.panels.get(repo.root);
    if (existing) {
      existing.panel.reveal();
      void existing.sendState();
      return;
    }
    const panel = vscode.window.createWebviewPanel('gitWorkbench.conflicts', `Conflicts: ${repo.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    ConflictsPanel.panels.set(repo.root, new ConflictsPanel(panel, context, repos, repo));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly repo: GitRepo,
  ) {
    panel.iconPath = new vscode.ThemeIcon('git-merge');
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'conflicts');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ConflictsRequest) =>
        this.handle(m).catch((e) => vscode.window.showErrorMessage((e as Error).message)),
      ),
      repos.onDidChangeRepo((r) => {
        if (r === repo) void this.sendState();
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) void this.sendState();
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private async sendState(): Promise<void> {
    const state = await this.repo.state();
    const message: ConflictsResponse = { type: 'state', repoName: this.repo.name, state, busy: this.busy };
    void this.panel.webview.postMessage(message);
  }

  private async withBusy(fn: () => Promise<unknown>): Promise<void> {
    this.busy = true;
    await this.sendState();
    try {
      await fn();
    } finally {
      this.busy = false;
      this.repos.refresh(this.repo);
      await this.sendState();
    }
  }

  private async handle(m: ConflictsRequest): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.sendState();
      case 'accept': {
        const conflicts = await this.repo.conflicts();
        await this.withBusy(async () => {
          for (const file of conflicts.filter((c) => m.paths.includes(c.path))) {
            await this.repo.acceptSide(file, m.side);
          }
        });
        return offerContinue(this.repos, this.repo);
      }
      case 'merge': {
        const state = await this.repo.state();
        const file = state.conflicts.find((c) => c.path === m.path);
        if (file) await MergePanel.open(this.context, this.repos, this.repo, file, state);
        return;
      }
      case 'builtinMerge':
        await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(path.join(this.repo.root, m.path)));
        return;
      case 'openFile':
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.repo.root, m.path)));
        return;
      case 'operation':
        return this.withBusy(() => operationAction(this.repos, this.repo, m.action));
    }
  }

  private dispose(): void {
    ConflictsPanel.panels.delete(this.repo.root);
    this.disposables.forEach((d) => d.dispose());
  }
}
