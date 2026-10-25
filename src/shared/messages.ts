// Messages exchanged between the extension host and each webview. Types only, no runtime code.
import type { Commit, CommitDetails, FileChange, LogFilter, MergeRegion, RefsInfo, RepoState } from './types';

export type CommitAction = 'copyHash' | 'checkout' | 'newBranch' | 'newTag' | 'cherryPick' | 'revert' | 'reset' | 'rebaseOnto' | 'merge';
export type BranchAction = 'checkout' | 'newBranch' | 'merge' | 'rebaseOnto' | 'delete';
export type OperationAction = 'continue' | 'abort' | 'skip';

// ---- Log -----------------------------------------------------------------

export type LogRequest =
  | { type: 'ready' }
  | { type: 'setRepo'; root: string }
  | { type: 'loadLog'; requestId: number; filter: LogFilter; skip: number }
  /** Hashes ordered oldest first. */
  | { type: 'select'; requestId: number; hashes: string[] }
  | { type: 'openDiff' | 'compareLocal' | 'openRevision'; change: FileChange }
  | { type: 'commitAction'; action: CommitAction; hashes: string[] }
  | { type: 'branchAction'; action: BranchAction; name: string; remote: boolean }
  | { type: 'fetch' }
  | { type: 'resolveConflicts' }
  | { type: 'operation'; action: OperationAction }
  | { type: 'copy'; text: string };

export interface RepoSummary {
  root: string;
  name: string;
}

export type LogResponse =
  | {
      type: 'init';
      repos: RepoSummary[];
      root: string;
      refs: RefsInfo;
      authors: string[];
      me?: string;
      state: RepoState;
      filter: LogFilter;
    }
  | { type: 'log'; requestId: number; commits: Commit[]; append: boolean; hasMore: boolean }
  | { type: 'details'; requestId: number; details?: CommitDetails; count: number; files: FileChange[] }
  /** The repository changed outside the view: refresh refs and reload the log. */
  | { type: 'repoChanged'; refs: RefsInfo; state: RepoState }
  | { type: 'setFilter'; filter: LogFilter }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string };

// ---- Conflicts -----------------------------------------------------------

export type ConflictsRequest =
  | { type: 'ready' }
  | { type: 'accept'; paths: string[]; side: 'ours' | 'theirs' }
  | { type: 'merge'; path: string }
  | { type: 'builtinMerge'; path: string }
  | { type: 'openFile'; path: string }
  | { type: 'operation'; action: OperationAction };

export type ConflictsResponse = { type: 'state'; repoName: string; state: RepoState; busy: boolean };

// ---- Merge tool ----------------------------------------------------------

export type MergeRequest =
  | { type: 'ready' }
  | { type: 'save'; lines: string[]; unresolved: number }
  | { type: 'cancel'; dirty: boolean }
  | { type: 'builtinMerge' };

export type MergeResponse = {
  type: 'init';
  path: string;
  oursLabel: string;
  theirsLabel: string;
  regions: MergeRegion[];
  autoApply: boolean;
};
