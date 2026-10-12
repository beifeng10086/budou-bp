import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectQuota } from '../worker/quota.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = await readFile(new URL('../.env.analytics', import.meta.url), 'utf8')
const token = source.match(/^CF_ANALYTICS_TOKEN=(.+)$/m)?.[1]?.trim()
if (!token || token === 'PASTE_READ_ONLY_TOKEN_HERE') throw new Error('Fill CF_ANALYTICS_TOKEN in .env.analytics first. Do not send the token in chat.')
await collectQuota(token, 'a36ce5587a5fb626db08ea0a1276ce64', true)
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'secret', 'put', 'CF_ANALYTICS_TOKEN'], { cwd: root, input: token, encoding: 'utf8' })
if (result.status !== 0) throw new Error('Secret installation failed. Check wrangler authentication.')
console.log('Read-only analytics secret installed. Scheduled statistics update every five minutes. Token was not printed.')
