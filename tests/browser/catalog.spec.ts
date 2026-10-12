import { test, expect } from '@playwright/test'

async function choose(page: import('@playwright/test').Page) {
  while (await page.locator('.item-tile:not([disabled])').count() === 0 && await page.getByTitle('下一页', { exact: true }).isEnabled()) await page.getByTitle('下一页', { exact: true }).click()
  await page.locator('.item-tile:not([disabled])').first().click()
  await page.getByRole('button', { name: /确认禁用|确认选择/ }).click()
}
for (const width of [320, 390, 844, 1280, 1920]) {
  test('official artwork, preview, orientation and export at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
    await page.getByLabel('你的圈名').fill('北风')
    await page.getByLabel('本机 2P 圈名').fill('白面具')
    await page.getByRole('button', { name: '本机演练', exact: true }).click()
    await page.getByRole('button', { name: '开始 BP', exact: true }).click()
    await expect(page.locator('.item-tile')).toHaveCount(20)
    await expect(page.getByLabel('1P阵容')).toBeVisible()
    await expect(page.getByLabel('2P阵容')).toBeVisible()
    await expect(page.locator('.arena-player.blue strong')).toHaveText('北风')
    const avatarLayout = await page.locator('.arena-pool .portrait img').first().evaluate(img => {
      const portrait = img.parentElement!
      const imageStyle = getComputedStyle(img)
      return { fit: imageStyle.objectFit, imageHeight: img.clientHeight, portraitHeight: portrait.clientHeight }
    })
    expect(avatarLayout.fit).toBe('contain')
    expect(avatarLayout.imageHeight).toBeGreaterThan(0)
    expect(avatarLayout.imageHeight).toBeLessThanOrEqual(avatarLayout.portraitHeight)
    if (width >= 1280) {
      const artworkHeight = await page.locator('.artwork-stage').evaluate(el => el.clientHeight)
      const poolHeight = await page.locator('.arena-catalog').evaluate(el => el.clientHeight)
      expect(artworkHeight).toBeLessThanOrEqual(240)
      expect(poolHeight).toBeGreaterThanOrEqual(220)
    }
    await page.locator('.item-tile:not([disabled])').first().click()
    await expect(page.locator('.stage-status strong')).toHaveText('1P 禁用忍者')
    await expect(page.locator('.roster-bans .portrait')).toHaveCount(0)
    const artwork = page.locator('.ninja-artwork').first()
    await expect.poll(() => artwork.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: 'artifacts/arena-' + width + '.png' })
    const confirmBox = await page.getByRole('button', { name: '确认禁用' }).boundingBox()
    expect(confirmBox!.x).toBeGreaterThanOrEqual(0)
    expect(confirmBox!.y).toBeGreaterThanOrEqual(0)
    expect(confirmBox!.x + confirmBox!.width).toBeLessThanOrEqual(width + 1)
    expect(confirmBox!.y + confirmBox!.height).toBeLessThanOrEqual((width === 844 ? 390 : 844) + 1)
    if (width <= 390) {
      await page.getByTitle('切换竖屏', { exact: true }).click()
      await expect(page.locator('.app-shell')).toHaveClass(/portrait-mode/)
      await expect(page.locator('.item-tile')).toHaveCount(12)
      await page.screenshot({ path: 'artifacts/portrait-' + width + '.png' })
      await page.getByTitle('切换横屏', { exact: true }).click()
    }
    await page.getByRole('searchbox').fill('不立土')
    await expect(page.locator('.item-tile')).toHaveCount(1)
    await page.getByRole('searchbox').clear()
    await page.getByLabel('忍者评级').selectOption('S')
    await expect(page.locator('.item-tile .rank').first()).toHaveText('S')
    await page.getByLabel('忍者评级').selectOption('')
    for (let i = 0; i < 10; i++) await choose(page)
    await expect(page.locator('.stage-status strong')).toHaveText('选择秘卷')
    await page.screenshot({ path: 'artifacts/scroll-' + width + '.png' })
    for (let stage = 0; stage < 2; stage++) {
      await page.locator('.seat-tabs button').nth(0).click()
      for (let i = 0; i < 3; i++) await choose(page)
      await page.locator('.seat-tabs button').nth(1).click()
      for (let i = 0; i < 3; i++) await choose(page)
    }
    await expect(page.locator('.result-entry')).toHaveCount(22)
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存 BP 图' }).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toMatch(/\.png$/)
    await download.saveAs('artifacts/result-' + width + '.png')
    if (width <= 390) await page.getByRole('dialog', { name: 'BP 图片' }).getByRole('button', { name: '关闭' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    expect(errors).toEqual([])
  })
}
test('clipboard rejection offers a selectable invitation instead of claiming success', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied') } } })
    document.execCommand = () => false
  })
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await page.getByLabel('你的圈名').fill('北风')
  await page.getByRole('button', { name: '创建共享房间', exact: true }).click()
  await expect(page).toHaveURL(/\?room=/)
  await page.getByRole('button', { name: '复制邀请链接' }).click()
  await expect(page.getByRole('dialog', { name: '邀请链接' })).toContainText('自动复制未成功')
  await expect(page.getByRole('textbox', { name: '邀请链接', exact: true })).toHaveValue(page.url())
})

test('local 60-second timeout ignores previews and completes every phase legally', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await page.getByLabel('你的圈名').fill('北风')
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  for (let turn = 0; turn < 10; turn++) {
    await page.clock.fastForward(61000)
    await expect(page.locator('.arena-timer')).toContainText('60')
  }
  await expect(page.locator('.stage-status strong')).toHaveText('选择秘卷')
  await page.clock.fastForward(61000)
  await expect(page.locator('.stage-status strong')).toHaveText('选择通灵')
  await page.clock.fastForward(61000)
  await expect(page.locator('.result-entry')).toHaveCount(22)
})

test('infinite local series offers host reset or end on exhausted data package', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await page.getByLabel('你的圈名').fill('北风')
  await page.getByLabel('赛制').selectOption('0')
  const pack = await page.request.get('/data/official-collected-2026-10-13.json').then(response => response.json())
  pack.id = 'small-infinite-test'; pack.name = '小池测试'; pack.ninjas = pack.ninjas.slice(0, 22); pack.scrolls = pack.scrolls.slice(0, 9); pack.summons = pack.summons.slice(0, 9)
  await page.locator('input[type=file]').setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) })
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('小池测试')
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  for (let round = 1; round <= 3; round++) {
    for (let turn = 0; turn < 10; turn++) await choose(page)
    for (let stage = 0; stage < 2; stage++) {
      for (let seat = 0; seat < 2; seat++) {
        await page.locator('.seat-tabs button').nth(seat).click()
        for (let item = 0; item < 3; item++) await choose(page)
      }
    }
    await page.getByRole('button', { name: '北风 获胜', exact: true }).click()
    if (round < 3) await page.getByRole('button', { name: '开启第 ' + (round + 1) + ' 局', exact: true }).click()
  }
  await expect(page.locator('.exhausted-panel')).toBeVisible()
  await page.getByRole('button', { name: '结束本场', exact: true }).click()
  await expect(page.locator('.completed-banner')).toContainText('BO 无限 已结束')
  await page.getByRole('button', { name: '下一场准备', exact: true }).click()
  await expect(page.getByRole('button', { name: '交换 1P / 2P' })).toBeVisible()
})
