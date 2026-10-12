import { readFile, writeFile, mkdir, access, rename, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = 'https://hyrz.qq.com/act/a20240723fashion/ninja-data/prod/'
const listUrl = `${base}ninja_list.json`
const args = process.argv.slice(2)
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const input = option('--input')
const cutoff = option('--date') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('Use --date YYYY-MM-DD')
const refresh = args.includes('--refresh')
const cache = resolve(root, 'data/source-cache')
const assetDir = resolve(root, 'public/assets/catalog')
const packageDir = resolve(root, 'public/data')
await Promise.all([cache, assetDir, packageDir].map((dir) => mkdir(dir, { recursive: true })))
const issues = []

// The downloaded file is JSONP. Parse its payload without executing source code.
export function parseData(text) {
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  const wrapped = cleaned.match(/^[a-zA-Z_$][\w$]*\s*\(([\s\S]*)\)\s*;?$/)
  return JSON.parse(wrapped ? wrapped[1] : cleaned)
}

function officialUrl(value) {
  const url = new URL(value.startsWith('//') ? `https:${value}` : value)
  if (url.protocol !== 'https:' || !['hyrz.qq.com', 'ninja.hyrz.qq.com', 'game.gtimg.cn', 'ossweb-img.qq.com'].includes(url.hostname)) {
    throw new Error(`Unrecognized source host: ${url.hostname}`)
  }
  return url.href
}

async function request(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(officialUrl(url), { signal: AbortSignal.timeout(20000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > 10_000_000) throw new Error('Response too large')
      return body
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise((done) => setTimeout(done, 500 * (attempt + 1)))
    }
  }
}

function decode(bytes) {
  const utf8 = new TextDecoder().decode(bytes)
  return utf8.includes('\ufffd') ? new TextDecoder('gb18030').decode(bytes) : utf8
}

async function getDetail(id) {
  const path = resolve(cache, `${id}.json`)
  if (!refresh) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { /* Missing cache is fetched below. */ }
  }
  const value = parseData(decode(await request(`${base}${id}.json`)))
  await writeFile(path, JSON.stringify(value))
  return value
}

async function pool(items, task, label) {
  let cursor = 0
  let completed = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await task(items[index], index)
      completed++
      if (completed % 50 === 0 || completed === items.length) console.log(`${label}: ${completed}/${items.length}`)
    }
  }))
}

const listBytes = input ? await readFile(resolve(input)) : await request(listUrl)
const raw = parseData(decode(listBytes))
if (!Array.isArray(raw.list) || raw.list.length < 22) throw new Error('Invalid ninja list')
const seen = new Set()
const ninjas = raw.list.map((row) => {
  const officialId = String(row.rzwyID)
  if (!/^\d+$/.test(officialId) || seen.has(officialId) || !row.rzzmc) throw new Error(`Invalid/duplicate ninja: ${officialId}`)
  seen.add(officialId)
  return {
    id: `ninja-${officialId}`, officialId, kind: 'ninja',
    name: `${row.rzzmc}${row.rzfmc ? `【${row.rzfmc}】` : ''}`,
    rank: row.rzzxd, tags: (row.rzdwbq || '').split(/[,，]/).filter(Boolean),
    aliases: (row.rzbm || '').split(/[,，]/).filter(Boolean),
    releaseDate: (row.rzsxsj || '').slice(0, 10),
    imageSource: officialUrl(row.lbtx), sourceUrls: [listUrl, `${base}${officialId}.json`],
  }
})
await writeFile(resolve(cache, 'ninja-list.json'), JSON.stringify(raw))
const details = new Array(ninjas.length)
await pool(ninjas, async (item, index) => {
  try { details[index] = await getDetail(item.officialId) }
  catch (error) { issues.push({ type: 'detail', id: item.id, error: error.message }) }
}, 'Ninja details')

const extra = new Map()
for (let i = 0; i < details.length; i++) {
  const recommendations = details[i]?.tjtlmj ?? {}
  for (const [key, row] of Object.entries(recommendations)) {
    const match = key.match(/^(tjmj|tjtls)(\d+)$/)
    if (!match) continue
    const [, prefix, number] = match
    const kind = prefix === 'tjmj' ? 'scroll' : 'summon'
    const officialId = String(row[`${prefix}ID${number}`] ?? '')
    const name = String(row[`${prefix}mc${number}`] ?? '').trim()
    const image = row[`${prefix === 'tjmj' ? 'tjmjtx' : 'tjtlsicon'}${number}`]
    if (!/^\d+$/.test(officialId) || !name || !image) {
      issues.push({ type: 'recommendation', ninja: ninjas[i].id, key, error: 'Missing ID, name or image' })
      continue
    }
    const id = `${kind}-${officialId}`
    const source = `${base}${ninjas[i].officialId}.json`
    if (extra.has(id)) {
      const item = extra.get(id)
      if (!item.sourceUrls.includes(source)) item.sourceUrls.push(source)
      if (item.name !== name && !item.aliases.includes(name)) item.aliases.push(name)
    } else {
      try {
        extra.set(id, { id, officialId, kind, name, tags: [], aliases: [],
          description: row[`${prefix}ms${number}`] || '', imageSource: officialUrl(image), sourceUrls: [source] })
      } catch (error) { issues.push({ type: 'recommendation', id, error: error.message }) }
    }
  }
}
const extras = [...extra.values()].sort((a, b) => a.id.localeCompare(b.id))
const items = [...ninjas, ...extras]
const { default: sharp } = await import('sharp')
const artworkIssues = []
await pool(ninjas, async (item, index) => {
  const display = details[index]?.zhanshi?.rzzs
  item.description = display?.rzyjhgl || ''
  if (!display?.bslhcc1) {
    artworkIssues.push({ id: item.id, error: 'Official artwork source missing' })
    return
  }
  try {
    item.artworkSource = officialUrl(display.bslhcc1)
    const hash = createHash('sha256').update(item.artworkSource).digest('hex').slice(0, 10)
    const filename = `${item.id}-art-${hash}.webp`
    const path = resolve(assetDir, filename)
    try { await access(path) } catch {
      const bytes = await request(item.artworkSource)
      const optimized = await sharp(bytes).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer()
      await writeFile(`${path}.tmp`, optimized)
      await rename(`${path}.tmp`, path)
    }
    item.artwork = `/assets/catalog/${filename}`
  } catch (error) { artworkIssues.push({ id: item.id, error: error.message }) }
}, 'Official standing artwork')
await pool(items, async (item) => {
  const hash = createHash('sha256').update(item.imageSource).digest('hex').slice(0, 10)
  const filename = `${item.id}-${hash}.webp`
  const path = resolve(assetDir, filename)
  try {
    try { await access(path) }
    catch {
      const bytes = await request(item.imageSource)
      // Decode raster bytes before storing, rejecting HTML error pages and invalid assets.
      const optimized = await sharp(bytes).rotate().resize(160, 160, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
      await writeFile(`${path}.tmp`, optimized)
      await rename(`${path}.tmp`, path)
    }
    item.image = `/assets/catalog/${filename}`
  } catch (error) { issues.push({ type: 'image', id: item.id, source: item.imageSource, error: error.message }) }
}, 'Portraits and icons')

const collectedAt = new Date().toISOString()
const db = new DatabaseSync(resolve(root, 'data/catalog.sqlite'))
db.exec(`CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, official_id TEXT NOT NULL, name TEXT NOT NULL,
  image_path TEXT, source_image_url TEXT, release_date TEXT, metadata_json TEXT NOT NULL, collected_at TEXT NOT NULL
); CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);`)
const insert = db.prepare('INSERT OR REPLACE INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
db.exec('BEGIN')
try {
  for (const item of items) insert.run(item.id, item.kind, item.officialId, item.name, item.image ?? null, item.imageSource, item.releaseDate ?? null, JSON.stringify(item), collectedAt)
  db.exec('COMMIT')
} catch (error) { db.exec('ROLLBACK'); throw error }

const future = ninjas.filter((item) => item.releaseDate > cutoff)
const playableNinjas = ninjas.filter((item) => !item.releaseDate || item.releaseDate <= cutoff)
const pack = {
  id: `official-collected-${cutoff}`, name: '官网资料汇总池（非赛事池）', updatedAt: cutoff,
  source: '忍者来自官网列表；秘卷、通灵来自官网推荐搭配汇总，尚未核实全量覆盖',
  collectedAt, completeness: { ninjas: 'provided-list', scrolls: 'recommendations-only', summons: 'recommendations-only' },
  ninjas: playableNinjas, scrolls: extras.filter((item) => item.kind === 'scroll'), summons: extras.filter((item) => item.kind === 'summon'),
}
const report = {
  collectedAt, cutoff, input: input ? 'user-provided ninja_list.json' : listUrl,
  inputSha256: createHash('sha256').update(listBytes).digest('hex'),
  ninjaRecords: ninjas.length, playableNinjas: playableNinjas.length,
  unknownReleaseDates: ninjas.filter((item) => !item.releaseDate).map((item) => item.id),
  excludedFuture: future.map(({ id, name, releaseDate }) => ({ id, name, releaseDate })),
  scrolls: pack.scrolls.length, summons: pack.summons.length,
  imagesDownloaded: items.filter((item) => item.image).length,
  artworksDownloaded: ninjas.filter((item) => item.artwork).length,
  artworkIssues,
  coverage: pack.completeness, issues,
}
if (pack.scrolls.length < 9 || pack.summons.length < 9) throw new Error('Not enough verified records to publish a BO3 package')
db.prepare('INSERT OR REPLACE INTO packages VALUES (?, ?)').run(pack.id, JSON.stringify(pack))
db.close()
await writeFile(resolve(packageDir, `${pack.id}.json`), JSON.stringify(pack, null, 2))
await writeFile(resolve(packageDir, 'catalog-report.json'), JSON.stringify(report, null, 2))
const versions = (await readdir(packageDir)).filter((name) => /^official-collected-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse()
await writeFile(resolve(packageDir, 'catalog-index.json'), JSON.stringify({ packages: versions.map((name) => `/data/${name}`) }, null, 2))
console.log(JSON.stringify(report, null, 2))
