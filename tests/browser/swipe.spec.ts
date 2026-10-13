import { test, expect, type Page } from '@playwright/test'

test.use({ hasTouch: true })

async function swipe(page: Page, direction: 'next' | 'previous', rotated: boolean) {
  const box = (await page.locator('.arena-pool').boundingBox())!
  const sign = direction === 'next' ? 1 : -1
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const distance = (rotated ? box.height : box.width) * .28 * sign
  const from = rotated ? { x: center.x, y: center.y + distance } : { x: center.x + distance, y: center.y }
  const to = rotated ? { x: center.x, y: center.y - distance } : { x: center.x - distance, y: center.y }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] })
  for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 5, y: from.y + (to.y - from.y) * step / 5, id: 1 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  // The browser may synthesize a click after touchend; allow the suppression window to expire.
  await page.waitForTimeout(500)
}

for (const mode of ['landscape', 'rotated', 'portrait'] as const) test('touch pagination preserves selections in ' + mode, async ({ page }) => {
  await page.setViewportSize(mode === 'landscape' ? { width: 844, height: 390 } : { width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await page.locator('.advanced-settings summary').click()
  await page.getByRole('switch', { name: '无计时', exact: true }).check()
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  if (mode === 'portrait') await page.getByTitle('切换竖屏', { exact: true }).click()
  const rotated = mode === 'rotated'
  const indicator = page.locator('.page-indicator')
  const first = await page.locator('.item-tile').first().getAttribute('title')
  await swipe(page, 'previous', rotated)
  await expect(indicator).toHaveText(/^1 \/ /)
  await swipe(page, 'next', rotated)
  await expect(indicator).toHaveText(/^2 \/ /)
  expect(await page.locator('.item-tile').first().getAttribute('title')).not.toBe(first)
  await expect(page.locator('.ninja-artwork')).toHaveCount(0)
  await expect(page.locator('.item-tile[aria-pressed=true]')).toHaveCount(0)
  await swipe(page, 'previous', rotated)
  await expect(page.locator('.item-tile').first()).toHaveAttribute('title', first!)
  await page.getByTitle('下一页', { exact: true }).click()
  await expect(indicator).toHaveText(/^2 \/ /)
  await page.getByTitle('上一页', { exact: true }).click()
  for (let index = 0; index < 10; index++) {
    await page.locator('.item-tile:not([disabled])').first().click()
    await page.getByRole('button', { name: /确认禁用|确认选择/ }).click()
  }
  for (const stage of ['秘卷', '通灵']) {
    await expect(page.locator('.stage-status strong')).toHaveText('选择' + stage)
    await expect(page.locator('.item-tile')).toHaveCount(mode === 'portrait' ? 12 : 20)
    const selected = page.locator('.timed-overlay.previewing-item:not([disabled])')
    const name = await page.locator('.item-tile:not([disabled])').first().getAttribute('title')
    await page.locator('.item-tile:not([disabled])').first().click()
    await swipe(page, 'next', rotated)
    await expect(indicator).toHaveText(/^2 \/ /)
    await expect(selected).toHaveCount(1)
    await expect(selected.first()).toContainText(name!)
    await page.locator('.item-tile:not([disabled])').first().click()
    await swipe(page, 'previous', rotated)
    await expect(selected).toHaveCount(2)
    await page.locator('.item-tile:not([disabled]):not([aria-pressed=true])').first().click()
    await expect(selected).toHaveCount(3)
    await page.getByRole('button', { name: '确认三个' + stage, exact: true }).click()
    await page.locator('.seat-tabs button').nth(1).click()
    for (let index = 0; index < 3; index++) await page.locator('.item-tile:not([disabled]):not([aria-pressed=true])').first().click()
    await page.screenshot({ path: 'artifacts/' + mode + (stage === '秘卷' ? '-scroll' : '-summon') + '.png' })
    await page.getByRole('button', { name: '确认三个' + stage, exact: true }).click()
  }
  await expect(page.locator('.result-entry')).toHaveCount(22)
})
