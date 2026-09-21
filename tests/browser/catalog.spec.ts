import { test, expect } from '@playwright/test'

for (const width of [320, 390, 844, 1280]) {
  test(`official portraits, filtering and result export at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await expect(page.locator('.select-input option:checked')).toContainText('官网资料汇总池')
    await page.getByRole('button', { name: '本机演练', exact: true }).click()
    await page.getByRole('button', { name: '开始 BP', exact: true }).click()
    await expect(page.locator('.item-tile')).toHaveCount(451)
    const ranks = await page.locator('.item-tile').evaluateAll(elements => elements.map(el => el.getAttribute('data-rank') || ''))
    const order: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 }
    expect(ranks).toEqual([...ranks].sort((a, b) => (order[a] ?? 4) - (order[b] ?? 4)))
    await expect(page.getByLabel('1P阵容')).toBeVisible()
    await expect(page.getByLabel('2P阵容')).toBeVisible()
    const firstImage = page.locator('.item-tile img').first()
    await expect(firstImage).toBeVisible()
    await expect.poll(() => firstImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await page.getByRole('searchbox').fill('不立土')
    await expect(page.locator('.item-tile')).toHaveCount(1)
    await page.getByRole('searchbox').clear()
    await page.getByLabel('忍者评级').selectOption('S')
    await expect(page.locator('.item-tile .rank').first()).toHaveText('S')
    await page.getByLabel('忍者评级').selectOption('')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `artifacts/catalog-${width}.png` })
    if (width === 844) {
      const roster = await page.getByLabel('1P阵容').boundingBox()
      expect(roster!.y + roster!.height).toBeLessThanOrEqual(390)
    }
    for (let i = 0; i < 10; i++) await page.locator('.item-tile:not([disabled])').first().click()
    await expect(page.locator('.draft-roster .ninja .filled')).toHaveCount(6)
    await expect(page.locator('.stage-status strong')).toHaveText('选择秘卷')
    await expect(page.locator('.item-tile')).toHaveCount(42)
    for (let stage = 0; stage < 2; stage++) {
      await page.locator('.seat-tabs button').nth(0).click()
      for (let i = 0; i < 3; i++) await page.locator('.item-tile:not([disabled])').filter({ hasNot: page.locator('.tile-state') }).first().click()
      await page.locator('.seat-tabs button').nth(1).click()
      for (let i = 0; i < 3; i++) await page.locator('.item-tile:not([disabled])').filter({ hasNot: page.locator('.tile-state') }).first().click()
    }
    await expect(page.locator('.result-entry')).toHaveCount(22)
    for (const img of await page.locator('.result-entry img').all()) {
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    }
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存 BP 图' }).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toMatch(/\.png$/)
    await download.saveAs(`artifacts/result-${width}.png`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    expect(errors).toEqual([])
  })
}
