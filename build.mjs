import { build } from 'esbuild'

const options = { bundle: true, platform: 'browser', target: 'es2022', sourcemap: true }

await Promise.all([
  build({
    ...options,
    entryPoints: ['src/index.ts', 'src/host.ts'],
    outdir: 'dist',
    format: 'esm',
  }),
  build({
    ...options,
    entryPoints: ['src/runtime.ts'],
    outfile: 'dist/runtime.js',
    format: 'iife',
    minify: true,
  }),
])
