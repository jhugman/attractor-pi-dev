import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['../attractor-cli/dist/index.js'],
  outfile: 'dist/attractor.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: [
    '@mariozechner/pi-coding-agent',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-agent-core',
  ],
  treeShaking: true,
  sourcemap: false,
  logLevel: 'info',
});
