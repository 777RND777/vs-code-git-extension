# Git Merge Studio

A PyCharm-style Git workflow for VS Code: a flat commit log with real filters, commit inspection, cherry-pick / rebase / merge from the log, and a 3-pane conflict resolver.

## Features

**Git Log** (`Git Merge Studio: Show Log`, or the commit icon in the Source Control title bar)
- One flat list of commits from all branches, newest first, with branch and tag labels.
- Filter by branch (sidebar or dropdown), by one or more users (including "me"), by message text or hash, and by path.
- Click a commit to see its changed files and message. Cmd/Ctrl-click or Shift-click several commits to see their **combined** changes.
- Click a file to open its diff. Right-click a file to compare it with your working copy, open it at that revision, or show its history.
- Right-click commits to cherry-pick, revert, reset, rebase onto, merge, check out, or create a branch or tag.
- Right-click branches to check them out, merge them, rebase onto them or delete them.

**Conflicts** (`Git Merge Studio: Resolve Conflicts`, the status bar item, or the banner in the log)
- Lists conflicted files with what each side did (modified, added or deleted).
- Accept Yours, Accept Theirs, or Merge… for one or several files.
- Continue, Skip or Abort the merge, rebase, cherry-pick or revert.

**3-pane merge tool**: Yours | Result | Theirs
- Non-conflicting changes are applied automatically. Conflicts are shown in red.
- `»` / `«` applies a side's block. Applying both sides keeps both, in the order you click. `×` ignores a side. `↺` undoes a block.
- The Result pane is editable everywhere.
- F7 / Shift+F7 jumps between unresolved blocks. Cmd/Ctrl+S or **Apply** saves the file and stages it.

**File history**: right-click a file in the Explorer or an editor tab and choose **Show History**.

## Develop

```bash
npm install
npm run build      # or: npm run watch
npm test           # unit + git integration tests
```

Press **F5** in VS Code to start an Extension Development Host with the extension loaded.

To try it on a repository that is stuck mid-merge:

```bash
scripts/make-demo-repo.sh /tmp/gw-demo
code /tmp/gw-demo
```

### Layout

| Path | What |
| --- | --- |
| `src/extension.ts` | Activation, commands, status bar |
| `src/git.ts` | Git CLI wrapper: log, refs, diffs, conflict state |
| `src/merge3.ts` | Myers diff + 3-way merge into same/changed/conflict regions |
| `src/operations.ts` | Cherry-pick, rebase, merge, reset… with progress and conflict handling |
| `src/logPanel.ts`, `conflictsPanel.ts`, `mergePanel.ts` | Webview panels (extension side) |
| `src/webview/*.ts` | Webview UIs (plain TypeScript, no framework) |
| `src/shared/` | Types and messages shared by both sides |

## Publish

1. Set `publisher` in `package.json` to your Marketplace publisher ID. Also add `repository`, an `icon` (128×128 PNG) and a `LICENSE` file.
2. `npx @vscode/vsce package` builds a `.vsix`. `npx @vscode/vsce publish` publishes to the Marketplace.
