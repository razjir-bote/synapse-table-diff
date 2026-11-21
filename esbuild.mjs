import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const extensionBuild = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
};

const webviewBuild = {
  entryPoints: { setup: 'webview/setup/main.ts', results: 'webview/results/main.ts' },
  bundle: true,
  outdir: 'dist/webview',
  entryNames: '[name]',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
};

mkdirSync('dist/webview', { recursive: true });
copyFileSync('webview/shared/styles.css', 'dist/webview/styles.css');

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extensionBuild), esbuild.context(webviewBuild)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
  console.log('build complete');
}
