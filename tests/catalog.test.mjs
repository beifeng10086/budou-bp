import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'

const index = JSON.parse(await readFile('public/data/catalog-index.json', 'utf8'))
const pack = JSON.parse(await readFile(`public${index.packages[0]}`, 'utf8'))
const report = JSON.parse(await readFile('public/data/catalog-report.json', 'utf8'))
const db = new DatabaseSync('data/catalog.sqlite', { readOnly: true })
test.after(() => db.close())

test('official package is complete relative to source and excludes future ninjas', () => {
  assert.equal(pack.ninjas.length, report.playableNinjas)
  assert.equal(pack.ninjas.length + report.excludedFuture.length, report.ninjaRecords)
  assert.equal(pack.scrolls.length, report.scrolls)
  assert.equal(pack.summons.length, report.summons)
  assert.ok(pack.ninjas.every((item) => item.releaseDate <= pack.updatedAt))
  assert.equal(pack.completeness.scrolls, 'recommendations-only')
  assert.equal(pack.completeness.summons, 'recommendations-only')
  assert.deepEqual(report.issues, [])
  for (const group of [pack.ninjas, pack.scrolls, pack.summons]) {
    assert.equal(new Set(group.map((item) => item.id)).size, group.length)
    assert.ok(group.every((item) => item.officialId && item.name && item.image && item.sourceUrls.length))
  }
})

test('every catalog record has a decodable local image and matching database metadata', async () => {
  const items = db.prepare('SELECT * FROM items').all()
  assert.equal(items.length, report.ninjaRecords + report.scrolls + report.summons)
  let total = 0
  for (const row of items) {
    assert.match(row.image_path, /^\/assets\/catalog\/[\w-]+\.webp$/)
    const file = `public${row.image_path}`
    const metadata = await sharp(file).metadata()
    assert.equal(metadata.format, 'webp')
    assert.ok(metadata.width > 0 && metadata.width <= 160)
    assert.ok(metadata.height > 0 && metadata.height <= 160)
    total += (await stat(file)).size
    assert.equal(JSON.parse(row.metadata_json).image, row.image_path)
  }
  console.log(`Verified ${items.length} images, ${(total / 1024 / 1024).toFixed(2)} MiB total`)
  assert.deepEqual(JSON.parse(db.prepare('SELECT metadata_json FROM packages WHERE id = ?').get(pack.id).metadata_json), pack)
})

test('every playable ninja has a real decodable artwork in the package and database', async () => {
  assert.deepEqual(report.artworkIssues, [])
  for (const ninja of pack.ninjas) {
    assert.match(ninja.artwork, /^\/assets\/catalog\/ninja-[\w-]+\.webp$/)
    const metadata = await sharp(`public${ninja.artwork}`).metadata()
    assert.ok(metadata.width > 160 || metadata.height > 160)
    assert.ok(metadata.width <= 640 && metadata.height <= 640)
    const row = db.prepare('SELECT metadata_json FROM items WHERE official_id = ? AND kind = ?').get(ninja.officialId, 'ninja')
    assert.equal(JSON.parse(row.metadata_json).artwork, ninja.artwork)
  }
})
