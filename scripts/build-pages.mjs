import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: ['pages/index.ts'],
  outfile: 'dist/_worker.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await writeFile(new URL('../dist/_routes.json', import.meta.url), JSON.stringify({
  version: 1,
  include: ['/ws', '/room', '/health'],
  exclude: [],
}, null, 2) + '\n')

console.log('Pages bundle ready. Only /ws, /room and /health invoke Functions.')
