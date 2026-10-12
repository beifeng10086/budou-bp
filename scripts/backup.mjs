import { execFileSync } from 'node:child_process'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const commit = git('rev-parse', 'HEAD')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const destination = join(dirname(root), '武斗bp备份', `version-${stamp}-${commit.slice(0, 7)}`)
const source = join(destination, 'source')
await mkdir(source, { recursive: true })
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
for (const file of new Set(files)) {
  const target = resolve(source, file)
  if (!target.startsWith(resolve(source) + '\\')) throw new Error('Backup path outside source directory')
  await mkdir(dirname(target), { recursive: true })
  try { await copyFile(join(root, file), target) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
execFileSync('git', ['bundle', 'create', join(destination, 'history.bundle'), '--all'], { cwd: root, stdio: 'inherit' })
const quotePS = value => "'" + value.replace(/'/g, "''") + "'"
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quotePS(source)} -DestinationPath ${quotePS(join(destination, 'source.zip'))} -CompressionLevel Optimal`], { stdio: 'inherit' })
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), commit, gitStatus: git('status', '--short'), publicUrl: 'https://wudou-bp-h5.pages.dev/', files: files.length, restore: 'Extract source.zip into a new directory. Use history.bundle to recover commits. npm ci; npm run build:pages; npm run typecheck:worker. Preserve the existing Durable Object namespace and bindings when redeploying. Live room database and credentials are not included.' }, null, 2))
console.log(`Backup complete: ${destination}`)
