import { test, expect, type Page } from '@playwright/test'

async function chooseNinja(page: Page) {
  await page.locator('.item-tile:not([disabled])').first().click()
  await page.getByRole('button', { name: /确认禁用|确认选择/ }).click()
}

async function draftThree(page: Page) {
  const tiles = page.locator('.item-tile:not([disabled])')
  const names = await tiles.allTextContents()
  for (let i = 0; i < 3; i++) await tiles.nth(i).click()
  await expect(page.locator('.item-tile[aria-pressed=true]')).toHaveCount(3)
  await tiles.nth(0).click()
  await expect(page.locator('.item-tile[aria-pressed=true]')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /确认三个/ })).toBeDisabled()
  await tiles.nth(3).click()
  const slots = page.locator('.artwork-side').filter({ has: page.locator('.timed-overlay:not([disabled])') }).locator('.timed-overlay > span:not(.portrait)')
  expect(await slots.allTextContents()).toEqual([names[3].trim(), names[1].trim(), names[2].trim()])
  return await slots.allTextContents()
}

test('homepage is folded by default and local drafts retain positions and both seats', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await expect(page.getByRole('switch', { name: '无计时', exact: true })).not.toBeVisible()
  await page.locator('.advanced-settings summary').click()
  await expect(page.getByRole('switch', { name: '无计时', exact: true })).not.toBeChecked()
  await page.getByRole('switch', { name: '无计时', exact: true }).check()
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  await page.clock.fastForward(180000)
  await expect(page.locator('.arena-timer')).toHaveText('无计时')
  await expect(page.locator('.stage-status strong')).toHaveText('1P 禁用忍者')
  for (let i = 0; i < 10; i++) await chooseNinja(page)
  for (const stage of ['秘卷', '通灵']) {
    const blue = await draftThree(page)
    await page.locator('.seat-tabs button').nth(1).click()
    const red = await draftThree(page)
    await page.getByRole('button', { name: '确认三个' + stage }).click()
    await page.locator('.seat-tabs button').nth(0).click()
    expect(await page.locator('.artwork-side.blue .timed-overlay > span:not(.portrait)').allTextContents()).toEqual(blue)
    expect(await page.locator('.artwork-side.red .timed-overlay > span:not(.portrait)').allTextContents()).toEqual(red)
    await page.getByRole('button', { name: '确认三个' + stage }).click()
  }
  await expect(page.locator('.result-entry')).toHaveCount(22)
})

for (const fallback of [false, true]) test('ordered online batches and no timer with ' + (fallback ? 'HTTPS' : 'WebSocket'), async ({ browser }) => {
  test.setTimeout(120000)
  const hostContext = await browser.newContext()
  const guestContext = await browser.newContext()
  if (fallback) await guestContext.routeWebSocket('**/ws?**', socket => socket.close())
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await host.goto('/')
    await expect(host.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
    await host.locator('.advanced-settings summary').click()
    await host.getByRole('switch', { name: '无计时', exact: true }).check()
    await host.getByRole('button', { name: '创建共享房间', exact: true }).click()
    await expect(host).toHaveURL(/\?room=/)
    await guest.goto(host.url())
    await guest.getByRole('button', { name: '加入房间', exact: true }).click()
    await expect(host.getByRole('button', { name: '开始 BP', exact: true })).toBeEnabled({ timeout: 20000 })
    await host.getByRole('button', { name: '开始 BP', exact: true }).click()
    const order = ['blue', 'red', 'red', 'blue', 'blue', 'red', 'red', 'blue', 'blue', 'red']
    for (const [index, seat] of order.entries()) {
      const actor = seat === 'blue' ? host : guest
      await expect(actor.locator('.stage-status strong')).toHaveText((seat === 'blue' ? '1P' : '2P') + (index < 4 ? ' 禁用忍者' : ' 选择忍者'), { timeout: 20000 })
      const before = await actor.locator('.turn-count').innerText()
      await chooseNinja(actor)
      if (index === 9) await expect(actor.locator('.stage-status strong')).toHaveText('选择秘卷', { timeout: 20000 })
      else await expect(actor.locator('.turn-count')).not.toHaveText(before, { timeout: 20000 })
    }
    for (const stage of ['秘卷', '通灵']) {
      await expect(guest.locator('.stage-status strong')).toHaveText('选择' + stage, { timeout: 20000 })
      await expect(guest.locator('.arena-timer')).toHaveText('无计时')
      const red = await draftThree(guest)
      const blue = await draftThree(host)
      await host.getByRole('button', { name: '确认三个' + stage }).click()
      await expect(guest.locator('.timed-count')).toContainText('1P 已确认', { timeout: 20000 })
      expect(await guest.locator('.artwork-side.red .timed-overlay > span:not(.portrait)').allTextContents()).toEqual(red)
      await guest.getByRole('button', { name: '确认三个' + stage }).click()
      if (stage === '秘卷') await expect(host.locator('.stage-status strong')).toHaveText('选择通灵', { timeout: 20000 })
      else {
        await expect(host.locator('.result-entry')).toHaveCount(22, { timeout: 20000 })
        await expect(guest.locator('.result-entry')).toHaveCount(22, { timeout: 20000 })
        const lists = host.locator('.result-side.blue .result-list')
        expect(await lists.nth(3).locator('.result-entry strong').allTextContents()).toEqual(blue)
      }
    }
  } finally { await hostContext.close(); await guestContext.close() }
})
