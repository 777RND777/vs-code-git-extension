import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GitRepo } from './git';
import { joinLines, merge3, splitLines } from './merge3';
import { offerContinue } from './operations';
import type { RepoManager } from './repos';
import type { MergeRequest, MergeResponse } from './shared/messages';
import type { ConflictFile, RepoState } from './shared/types';
import { webviewHtml } from './webviewHtml';

/** The 3-pane merge tool for one conflicted file: Yours | Result | Theirs. */
export class MergePanel {
  private static readonly panels = new Map<string, MergePanel>();

  private readonly disposables: vscode.Disposable[] = [];

  static async open(context: vscode.ExtensionContext, repos: RepoManager, repo: GitRepo, file: ConflictFile, state: RepoState): Promise<void> {
    const key = path.join(repo.root, file.path);
    const existing = MergePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    if (file.ours === 'deleted' || file.theirs === 'deleted') {
      return resolveDeletion(repos, repo, file, state);
    }

    const [base, ours, theirs] = await Promise.all([repo.show(':1', file.path), repo.show(':2', file.path), repo.show(':3', file.path)]);
    if (!ours || !theirs) {
      vscode.window.showErrorMessage(`${file.path} has no conflict stages in the index; it may already be resolved.`);
      return;
    }
    if ([base, ours, theirs].some((b) => b && isBinary(b))) {
      return resolveBinary(repos, repo, file, state);
    }

    const panel = vscode.window.createWebviewPanel('gitWorkbench.merge', `Merge: ${path.basename(file.path)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    const oursText = splitLines(ours.toString('utf8'));
    const init: MergeResponse = {
      type: 'init',
      path: file.path,
      oursLabel: state.oursLabel,
      theirsLabel: state.theirsLabel,
      regions: merge3(splitLines(base?.toString('utf8') ?? '').lines, oursText.lines, splitLines(theirs.toString('utf8')).lines),
      autoApply: vscode.workspace.getConfiguration('gitWorkbench').get<boolean>('merge.autoApplyNonConflicting', true),
    };
    MergePanel.panels.set(key, new MergePanel(panel, context, repos, repo, file, key, init, oursText.eol, oursText.finalNewline));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly repo: GitRepo,
    private readonly file: ConflictFile,
    private readonly key: string,
    private readonly init: MergeResponse,
    private readonly eol: string,
    private readonly finalNewline: boolean,
  ) {
    panel.iconPath = new vscode.ThemeIcon('git-merge');
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'merge');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: MergeRequest) =>
        this.handle(m).catch((e) => vscode.window.showErrorMessage((e as Error).message)),
      ),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private async handle(m: MergeRequest): Promise<void> {
    switch (m.type) {
      case 'ready':
        void this.panel.webview.postMessage(this.init);
        return;
      case 'save': {
        if (m.unresolved > 0) {
          const ok = await vscode.window.showWarningMessage(
            `${m.unresolved} change${m.unresolved === 1 ? ' is' : 's are'} not resolved yet.`,
            { modal: true, detail: 'Unresolved conflicts keep the base version in the result. Save and mark the file as resolved anyway?' },
            'Save and Mark Resolved',
          );
          if (!ok) return;
        }
        await fs.writeFile(this.key, joinLines(m.lines, this.eol, this.finalNewline), 'utf8');
        await this.repo.exec(['add', '--', this.file.path]);
        this.repos.refresh(this.repo);
        this.panel.dispose();
        await offerContinue(this.repos, this.repo);
        return;
      }
      case 'cancel': {
        if (m.dirty) {
          const ok = await vscode.window.showWarningMessage('Discard your merge changes?', { modal: true }, 'Discard');
          if (!ok) return;
        }
        this.panel.dispose();
        return;
      }
      case 'builtinMerge':
        await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(this.key));
        return;
    }
  }

  private dispose(): void {
    MergePanel.panels.delete(this.key);
    this.disposables.forEach((d) => d.dispose());
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function resolveDeletion(repos: RepoManager, repo: GitRepo, file: ConflictFile, state: RepoState): Promise<void> {
  const detail = `Yours (${state.oursLabel}): ${file.ours}.\nTheirs (${state.theirsLabel}): ${file.theirs}.`;
  const keepOurs = file.ours === 'deleted' ? 'Delete File (Yours)' : 'Keep Yours';
  const keepTheirs = file.theirs === 'deleted' ? 'Delete File (Theirs)' : 'Keep Theirs';
  const choice = await vscode.window.showWarningMessage(`${file.path} was deleted on one side.`, { modal: true, detail }, keepOurs, keepTheirs);
  if (!choice) return;
  await repo.acceptSide(file, choice === keepOurs ? 'ours' : 'theirs');
  repos.refresh(repo);
}

async function resolveBinary(repos: RepoManager, repo: GitRepo, file: ConflictFile, state: RepoState): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `${file.path} is a binary file and can't be merged line by line.`,
    { modal: true, detail: `Yours: ${state.oursLabel}\nTheirs: ${state.theirsLabel}` },
    'Accept Yours',
    'Accept Theirs',
  );
  if (!choice) return;
  await repo.acceptSide(file, choice === 'Accept Yours' ? 'ours' : 'theirs');
  repos.refresh(repo);
}
