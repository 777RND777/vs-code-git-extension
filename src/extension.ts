import * as path from 'path';
import * as vscode from 'vscode';
import { ConflictsPanel } from './conflictsPanel';
import type { GitRepo } from './git';
import { LogPanel } from './logPanel';
import { MergePanel } from './mergePanel';
import { setShowConflicts } from './operations';
import { RepoManager } from './repos';
import { RevisionContentProvider, SCHEME } from './revisions';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repos = new RepoManager();
  context.subscriptions.push(repos);
  setShowConflicts((repo) => ConflictsPanel.show(context, repos, repo));

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(repos)),

    vscode.commands.registerCommand('gitWorkbench.openLog', async (arg?: unknown) => {
      const repo = await repos.pick(uriOf(arg));
      if (repo) LogPanel.show(context, repos, repo);
    }),

    vscode.commands.registerCommand('gitWorkbench.fileHistory', async (arg?: unknown) => {
      const uri = uriOf(arg) ?? vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme !== 'file') return;
      const repo = repos.forFile(uri.fsPath);
      if (!repo) {
        vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} is not in a Git repository.`);
        return;
      }
      const rel = path.relative(repo.root, uri.fsPath).split(path.sep).join('/');
      LogPanel.show(context, repos, repo, { path: rel || undefined });
    }),

    vscode.commands.registerCommand('gitWorkbench.resolveConflicts', async (arg?: unknown) => {
      const repo = await repos.pick(uriOf(arg));
      if (repo) ConflictsPanel.show(context, repos, repo);
    }),

    vscode.commands.registerCommand('gitWorkbench.openMergeTool', async (arg?: unknown) => {
      const uri = uriOf(arg) ?? vscode.window.activeTextEditor?.document.uri;
      const repo = uri?.scheme === 'file' ? repos.forFile(uri.fsPath) : await repos.pick();
      if (!repo) return;
      const state = await repo.state();
      const rel = uri ? path.relative(repo.root, uri.fsPath).split(path.sep).join('/') : undefined;
      const file = state.conflicts.find((c) => c.path === rel);
      if (file) await MergePanel.open(context, repos, repo, file, state);
      else ConflictsPanel.show(context, repos, repo);
    }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(status);
  const updateStatus = async (repo: GitRepo) => {
    const states = await Promise.all(repos.list().map((r) => r.state().catch(() => undefined)));
    const conflicted = states.reduce((n, s) => n + (s?.conflicts.length ?? 0), 0);
    void vscode.commands.executeCommand('setContext', 'gitWorkbench.hasConflicts', conflicted > 0);
    const state = await repo.state().catch(() => undefined);
    if (!state?.operation) {
      if (!states.some((s) => s?.operation)) status.hide();
      return;
    }
    const n = state.conflicts.length;
    status.text = n ? `$(git-merge) ${n} conflict${n === 1 ? '' : 's'}` : `$(git-merge) ${state.operation} in progress`;
    status.tooltip = `${state.description ?? state.operation}: click to resolve or continue`;
    status.command = { command: 'gitWorkbench.resolveConflicts', title: 'Resolve Conflicts', arguments: [vscode.Uri.file(repo.root)] };
    status.backgroundColor = n ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.show();
  };
  context.subscriptions.push(repos.onDidChangeRepo((repo) => void updateStatus(repo)));

  await repos.init();
  for (const repo of repos.list()) void updateStatus(repo);
  context.subscriptions.push(repos.onDidChangeList(() => repos.list().forEach((r) => void updateStatus(r))));
}

export function deactivate(): void {}

/**
 * Commands receive a Uri from explorer/editor menus, a SourceControlResourceState from SCM resource
 * menus, or a SourceControl (with rootUri) from the SCM title bar.
 */
function uriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const { resourceUri, rootUri } = (arg ?? {}) as { resourceUri?: unknown; rootUri?: unknown };
  const uri = resourceUri ?? rootUri;
  return uri instanceof vscode.Uri ? uri : undefined;
}
