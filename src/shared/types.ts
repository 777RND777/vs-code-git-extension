// Data shapes shared by the extension host and the webviews. Types only, no runtime code.

export type RefType = 'head' | 'local' | 'remote' | 'tag';

export interface RefLabel {
  name: string;
  type: RefType;
  /** The branch HEAD points at. */
  current?: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, seconds since epoch. */
  date: number;
  refs: RefLabel[];
  subject: string;
}

export interface LogFilter {
  /** A ref to show history of; undefined means all branches. */
  branch?: string;
  /** "Name <email>" strings; commits by any of them match. */
  authors?: string[];
  /** Message text or a commit hash. */
  text?: string;
  /** Restrict to commits touching this repo-relative path. */
  path?: string;
}

export interface BranchInfo {
  name: string;
  hash: string;
  upstream?: string;
  /** e.g. "ahead 1, behind 2" */
  track?: string;
}

export interface RefsInfo {
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: string[];
  /** Current branch name, undefined when HEAD is detached. */
  current?: string;
  head?: string;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R';

/** One file in the changes of one or more commits, with what to show on each side of a diff. */
export interface FileChange {
  status: FileStatus;
  /** Path after the change (or before it, when deleted). */
  path: string;
  leftRef?: string;
  leftPath?: string;
  rightRef?: string;
  rightPath?: string;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  message: string;
  refs: RefLabel[];
}

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface RepoState {
  operation?: OperationKind;
  /** Human readable, e.g. "Rebasing feature onto main". */
  description?: string;
  oursLabel: string;
  theirsLabel: string;
  conflicts: ConflictFile[];
}

export type SideState = 'modified' | 'added' | 'deleted';

export interface ConflictFile {
  path: string;
  /** Porcelain XY code: UU, AA, DU, UD, AU, UA, DD. */
  code: string;
  ours: SideState;
  theirs: SideState;
}

/** A piece of a 3-way merge. "same" is unchanged on both sides; "change" differs on one or both. */
export type MergeRegion =
  | { kind: 'same'; lines: string[] }
  | {
      kind: 'change';
      base: string[];
      ours: string[];
      theirs: string[];
      oursChanged: boolean;
      theirsChanged: boolean;
      /** Both sides changed this region differently. */
      conflict: boolean;
    };
