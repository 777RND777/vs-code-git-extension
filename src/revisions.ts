import * as path from 'path';
import * as vscode from 'vscode';
import { shortHash } from './git';
import type { RepoManager } from './repos';
import type { FileChange } from './shared/types';

/** Read-only documents holding a file's contents at a revision: gitwb:/<path>?{"root","ref"} */
export const SCHEME = 'gitwb';

export function revisionUri(root: string, ref: string | undefined, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + file, query: JSON.stringify({ root, ref: ref ?? '' }) });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repos: RepoManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = JSON.parse(uri.query) as { root: string; ref: string };
    if (!ref) return '';
    const content = await this.repos.get(root).show(ref, uri.path.slice(1));
    return content?.toString('utf8') ?? '';
  }
}

export function openChangeDiff(root: string, change: FileChange): Thenable<unknown> {
  const left = revisionUri(root, change.leftRef, change.leftPath ?? change.path);
  const right = revisionUri(root, change.rightRef, change.rightPath ?? change.path);
  const title = `${path.basename(change.path)} (${shortHash(change.leftRef)} ↔ ${shortHash(change.rightRef)})`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

export function compareWithLocal(root: string, change: FileChange): Thenable<unknown> {
  const ref = change.rightRef ?? change.leftRef;
  const file = change.rightRef ? (change.rightPath ?? change.path) : (change.leftPath ?? change.path);
  const left = revisionUri(root, ref, file);
  const right = vscode.Uri.file(path.join(root, change.path));
  const title = `${path.basename(change.path)} (${shortHash(ref)} ↔ Working Tree)`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

export async function openAtRevision(root: string, change: FileChange): Promise<void> {
  const ref = change.rightRef ?? change.leftRef;
  const file = change.rightRef ? (change.rightPath ?? change.path) : (change.leftPath ?? change.path);
  const doc = await vscode.workspace.openTextDocument(revisionUri(root, ref, file));
  await vscode.window.showTextDocument(doc, { preview: true });
}
