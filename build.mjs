import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true })

const options = { bundle: true, platform: 'browser', target: 'es2022', sourcemap: true }

await Promise.all([
  build({
    ...options,
    entryPoints: ['src/index.ts'],
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
