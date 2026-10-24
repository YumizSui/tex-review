const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    mainFields: ['module', 'main'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
  });
  await esbuild.build({ entryPoints: ['media/editor.js'], bundle: true, platform: 'browser', format: 'iife', target: ['chrome120'], outfile: 'media/editor.bundle.js', minify: production });
  require('fs').copyFileSync('node_modules/vscode-oniguruma/release/onig.wasm', 'media/onig.wasm');
  require('fs').copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'media/pdf.worker.mjs');
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
