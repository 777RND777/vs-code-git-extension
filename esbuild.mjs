import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Codicon font + stylesheet are served to the webviews from media/codicons.
mkdirSync('media/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  cpSync(`node_modules/@vscode/codicons/dist/${file}`, `media/codicons/${file}`);
}

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const contexts = [
  await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  }),
  await esbuild.context({
    ...common,
    entryPoints: {
      log: 'src/webview/log.ts',
      conflicts: 'src/webview/conflicts.ts',
      merge: 'src/webview/merge.ts',
    },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
];

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
