import * as vscode from 'vscode';
import { shortHash, type GitRepo } from './git';
import type { RepoManager } from './repos';
import type { BranchAction, CommitAction, OperationAction } from './shared/messages';

/** Opens the conflicts view; set by the extension at activation to avoid an import cycle. */
export let showConflicts: (repo: GitRepo) => void = () => undefined;
export function setShowConflicts(fn: (repo: GitRepo) => void): void {
  showConflicts = fn;
}

/**
 * Runs a git command that changes the repository, with progress. When it stops on conflicts,
 * offers to open the conflict resolver. Returns true on success.
 */
export async function runGit(repos: RepoManager, repo: GitRepo, title: string, args: string[]): Promise<boolean> {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => repo.exec(args));
    return true;
  } catch (e) {
    await reportFailure(repo, title, e);
    return false;
  } finally {
    repos.refresh(repo);
  }
}

async function reportFailure(repo: GitRepo, title: string, e: unknown): Promise<void> {
  const state = await repo.state().catch(() => undefined);
  if (state?.operation && state.conflicts.length) {
    const n = state.conflicts.length;
    const choice = await vscode.window.showWarningMessage(
      `${title}: ${n} file${n === 1 ? ' has' : 's have'} conflicts.`,
      'Resolve Conflicts',
    );
    if (choice) showConflicts(repo);
  } else {
    vscode.window.showErrorMessage(`${title} failed: ${(e as Error).message}`);
  }
}

export async function commitAction(repos: RepoManager, repo: GitRepo, action: CommitAction, hashesOldestFirst: string[]): Promise<void> {
  const [first] = hashesOldestFirst;
  const label = hashesOldestFirst.length === 1 ? shortHash(first) : `${hashesOldestFirst.length} commits`;

  switch (action) {
    case 'copyHash':
      await vscode.env.clipboard.writeText(hashesOldestFirst.slice().reverse().join(' '));
      vscode.window.setStatusBarMessage('Copied commit hash', 2000);
      return;
    case 'checkout':
      await runGit(repos, repo, `Checkout ${label}`, ['checkout', first]);
      return;
    case 'newBranch': {
      const name = await askRefName('New branch name', `Create a branch at ${label} and check it out`);
      if (name) await runGit(repos, repo, `Create branch ${name}`, ['checkout', '-b', name, first]);
      return;
    }
    case 'newTag': {
      const name = await askRefName('New tag name', `Create a tag at ${label}`);
      if (name) await runGit(repos, repo, `Create tag ${name}`, ['tag', name, first]);
      return;
    }
    case 'cherryPick': {
      const mainline = (await hasMergeCommit(repo, hashesOldestFirst)) ? ['-m', '1'] : [];
      await runGit(repos, repo, `Cherry-pick ${label}`, ['cherry-pick', ...mainline, ...hashesOldestFirst]);
      return;
    }
    case 'revert': {
      const mainline = (await hasMergeCommit(repo, hashesOldestFirst)) ? ['-m', '1'] : [];
      const newestFirst = hashesOldestFirst.slice().reverse();
      await runGit(repos, repo, `Revert ${label}`, ['revert', '--no-edit', ...mainline, ...newestFirst]);
      return;
    }
    case 'reset': {
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Soft', description: 'Keep all changes staged', flag: '--soft' },
          { label: 'Mixed', description: 'Keep all changes, unstaged', flag: '--mixed' },
          { label: 'Hard', description: 'Discard all changes in the working tree', flag: '--hard' },
          { label: 'Keep', description: 'Discard commits, keep local changes', flag: '--keep' },
        ],
        { placeHolder: `Reset current branch to ${label}` },
      );
      if (!mode) return;
      if (mode.flag === '--hard') {
        const ok = await vscode.window.showWarningMessage(
          `Reset --hard to ${label}? Uncommitted changes will be lost.`,
          { modal: true },
          'Reset',
        );
        if (!ok) return;
      }
      await runGit(repos, repo, `Reset ${mode.label.toLowerCase()} to ${label}`, ['reset', mode.flag, first]);
      return;
    }
    case 'rebaseOnto':
      await runGit(repos, repo, `Rebase onto ${label}`, ['rebase', first]);
      return;
    case 'merge':
      await mergeRef(repos, repo, first, label);
      return;
  }
}

export async function branchAction(repos: RepoManager, repo: GitRepo, action: BranchAction, name: string, remote: boolean): Promise<void> {
  switch (action) {
    case 'checkout': {
      if (!remote) {
        await runGit(repos, repo, `Checkout ${name}`, ['checkout', name]);
        return;
      }
      const local = name.slice(name.indexOf('/') + 1);
      const exists = await repo.tryExec(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`]);
      await runGit(repos, repo, `Checkout ${name}`, exists ? ['checkout', local] : ['checkout', '-b', local, '--track', name]);
      return;
    }
    case 'newBranch': {
      const branch = await askRefName('New branch name', `Create a branch from ${name} and check it out`);
      if (branch) await runGit(repos, repo, `Create branch ${branch}`, ['checkout', '-b', branch, name]);
      return;
    }
    case 'merge':
      await mergeRef(repos, repo, name, name);
      return;
    case 'rebaseOnto':
      await runGit(repos, repo, `Rebase onto ${name}`, ['rebase', name]);
      return;
    case 'delete':
      if (remote) {
        const slash = name.indexOf('/');
        const ok = await vscode.window.showWarningMessage(
          `Delete branch ${name.slice(slash + 1)} on remote ${name.slice(0, slash)}?`,
          { modal: true, detail: 'This pushes the deletion to the remote for everyone.' },
          'Delete Remote Branch',
        );
        if (ok) await runGit(repos, repo, `Delete ${name}`, ['push', name.slice(0, slash), '--delete', name.slice(slash + 1)]);
        return;
      }
      try {
        await repo.exec(['branch', '-d', name]);
        vscode.window.setStatusBarMessage(`Deleted branch ${name}`, 3000);
      } catch (e) {
        const force = await vscode.window.showWarningMessage(
          `Branch ${name} is not fully merged. Delete it anyway?`,
          { modal: true, detail: (e as Error).message },
          'Force Delete',
        );
        if (force) await runGit(repos, repo, `Delete ${name}`, ['branch', '-D', name]);
      } finally {
        repos.refresh(repo);
      }
      return;
  }
}

async function mergeRef(repos: RepoManager, repo: GitRepo, ref: string, label: string): Promise<void> {
  const current = (await repo.tryExec(['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() ?? 'HEAD';
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Merge', description: 'Fast-forward when possible', args: [] as string[] },
      { label: 'Merge (no fast-forward)', description: 'Always create a merge commit', args: ['--no-ff'] },
      { label: 'Squash', description: 'Stage the combined changes without committing', args: ['--squash'] },
    ],
    { placeHolder: `Merge ${label} into ${current}` },
  );
  if (mode) await runGit(repos, repo, `Merge ${label} into ${current}`, ['merge', ...mode.args, ref]);
}

export async function operationAction(repos: RepoManager, repo: GitRepo, action: OperationAction): Promise<void> {
  const { operation } = await repo.state();
  if (!operation) {
    vscode.window.showInformationMessage('No merge, rebase, cherry-pick or revert is in progress.');
    return;
  }
  const name = operation;
  if (action === 'abort') {
    const ok = await vscode.window.showWarningMessage(`Abort the ${name}?`, { modal: true, detail: 'The repository returns to the state before it started.' }, 'Abort');
    if (!ok) return;
  }
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${capitalize(action)} ${name}` }, async () => {
      if (action === 'continue') await repo.continueOperation(operation);
      else if (action === 'abort') await repo.abortOperation(operation);
      else await repo.skipCommit(operation);
    });
    const after = await repo.state();
    if (!after.operation) vscode.window.setStatusBarMessage(`${capitalize(name)} finished`, 4000);
    else if (after.conflicts.length) showConflicts(repo);
  } catch (e) {
    await reportFailure(repo, `${capitalize(action)} ${name}`, e);
  } finally {
    repos.refresh(repo);
  }
}

/** After the last conflict is resolved, offers to continue the merge/rebase/cherry-pick. */
export async function offerContinue(repos: RepoManager, repo: GitRepo): Promise<void> {
  const state = await repo.state();
  if (!state.operation || state.conflicts.length) return;
  const action = await vscode.window.showInformationMessage(
    `All conflicts are resolved. Continue the ${state.operation}?`,
    'Continue',
    'Later',
  );
  if (action === 'Continue') await operationAction(repos, repo, 'continue');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function hasMergeCommit(repo: GitRepo, hashes: string[]): Promise<boolean> {
  const out = await repo.exec(['rev-list', '--no-walk', '--parents', ...hashes]);
  return out.split('\n').some((line) => line.split(' ').length > 2);
}

function askRefName(title: string, prompt: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    validateInput: (v) => (!v.trim() ? 'Enter a name' : /[\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$|^-/.test(v) ? 'Not a valid ref name' : undefined),
  }).then((v) => v?.trim());
}
