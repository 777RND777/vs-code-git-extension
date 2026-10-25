import * as crypto from 'crypto';
import * as vscode from 'vscode';

/** HTML shell for a webview: CSP, codicons, shared and view styles, and the view's bundled script. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: 'log' | 'conflicts' | 'merge'): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${asset('media', 'common.css')}">
<link rel="stylesheet" href="${asset('media', `${view}.css`)}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('dist', 'webview', `${view}.js`)}"></script>
</body>
</html>`;
}
