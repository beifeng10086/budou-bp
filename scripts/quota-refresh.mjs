import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectQuota } from '../worker/quota.ts'

const config = await readFile(join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8')
const token = config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1]
if (!token) throw new Error('Run wrangler login first')
const snapshot = await collectQuota(token, 'a36ce5587a5fb626db08ea0a1276ce64', false)
const response = await fetch('https://api.cloudflare.com/client/v4/accounts/a36ce5587a5fb626db08ea0a1276ce64/storage/kv/namespaces/6d753c8c3f7744a2b3545b735a2eac66/values/daily', {
  method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(snapshot),
})
if (!response.ok) throw new Error(`Snapshot upload failed (${response.status})`)
console.log(JSON.stringify(snapshot, null, 2))

