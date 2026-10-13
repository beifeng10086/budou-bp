import { test, expect, type Page } from '@playwright/test'

async function selectNinja(page: Page) {
  while (!await page.locator('.item-tile:not([disabled])').count()) await page.getByTitle('下一页', { exact: true }).click()
  await page.locator('.item-tile:not([disabled])').first().click()
  await page.getByRole('button', { name: /确认禁用|确认选择/ }).click()
}
async function selectBatch(page: Page) {
  while (await page.locator('.item-tile:not([disabled]):not([aria-pressed=true])').count() < 3) await page.getByTitle('下一页', { exact: true }).click()
  for (let i = 0; i < 3; i++) await page.locator('.item-tile:not([disabled]):not([aria-pressed=true])').first().click()
  await page.getByRole('button', { name: /确认三个/ }).click()
}

for (const fallback of [false, true]) test('third-party host invitations, swap, spectate, BO3 and restore via ' + (fallback ? 'mixed HTTPS' : 'WebSocket'), async ({ browser }) => {
  test.setTimeout(240000)
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1280, height: 844 } })))
  if (fallback) for (const index of [0, 2]) await contexts[index]!.routeWebSocket('**/ws?**', socket => socket.close())
  const [host, first, second] = await Promise.all(contexts.map(context => context.newPage())) as [Page, Page, Page]
  try {
    await host.goto('/')
    await expect(host.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
    await host.getByRole('radio', { name: '第三方房主', exact: true }).check()
    await host.locator('.advanced-settings summary').click()
    await host.getByRole('switch', { name: '无计时', exact: true }).check()
    await host.getByRole('button', { name: '创建共享房间', exact: true }).click()
    await expect(host.locator('.share-strip em')).toHaveText('你是 房主（观战）', { timeout: 20000 })
    await expect(host.getByRole('button', { name: '开始 BP', exact: true })).toBeDisabled()
    const invitations: Record<string, string> = {}
    for (const [seat, name] of [['blue', '1P'], ['red', '2P']]) {
      await host.getByRole('button', { name: '邀请 ' + name + ' · 待加入', exact: true }).click()
      invitations[seat!] = await host.getByRole('textbox', { name: '邀请链接', exact: true }).inputValue()
      expect(invitations[seat!]).toContain('&seat=' + seat)
      await host.getByRole('dialog', { name: '邀请链接' }).getByRole('button', { name: '关闭', exact: true }).click()
    }
    // 2P joins first to prove that targeted invitations do not depend on arrival order.
    await second.goto(invitations.red!)
    await second.getByLabel('你的圈名').fill('乙选手')
    await second.getByRole('button', { name: '加入房间', exact: true }).click()
    await expect(second.locator('.share-strip em')).toHaveText('你是 2P', { timeout: 20000 })
    await expect(host.getByRole('button', { name: '开始 BP', exact: true })).toBeDisabled()
    await first.goto(invitations.blue!)
    await first.getByLabel('你的圈名').fill('甲选手')
    await first.getByRole('button', { name: '加入房间', exact: true }).click()
    await expect(first.locator('.share-strip em')).toHaveText('你是 1P', { timeout: 20000 })
    await expect(host.getByRole('button', { name: '开始 BP', exact: true })).toBeEnabled({ timeout: 20000 })
    await expect(first.getByRole('button', { name: '开始 BP', exact: true })).toHaveCount(0)
    await host.getByRole('button', { name: '交换 1P / 2P', exact: true }).click()
    await expect(first.locator('.share-strip em')).toHaveText('你是 2P', { timeout: 20000 })
    await expect(second.locator('.share-strip em')).toHaveText('你是 1P', { timeout: 20000 })
    await expect(host.locator('.share-strip em')).toHaveText('你是 房主（观战）')
    await host.reload()
    await expect(host.locator('.share-strip em')).toHaveText('你是 房主（观战）', { timeout: 20000 })
    await host.getByRole('button', { name: '开始 BP', exact: true }).click()
    for (let round = 1; round <= 2; round++) {
      for (let i = 0; i < 10; i++) {
        const blueTurn = [0, 3, 4, 7, 8].includes(i)
        const actor = blueTurn ? second : first
        const phase = i < 4 ? '禁用忍者' : '选择忍者'
        await expect(actor.locator('.stage-status strong')).toHaveText((blueTurn ? '1P ' : '2P ') + phase, { timeout: 20000 })
        await expect(actor.locator('.turn-count')).toHaveText('第 ' + (i < 4 ? i + 1 : i - 3) + ' / ' + (i < 4 ? 4 : 6) + ' 手', { timeout: 20000 })
        await selectNinja(actor)
        await expect(host.getByRole('button', { name: /确认禁用|确认选择/ })).toHaveCount(0)
      }
      await expect(host.locator('.stage-status strong')).toHaveText('选择秘卷', { timeout: 20000 })
      for (const side of ['blue', 'red']) {
        const positions = await host.locator('.artwork-side.' + side + ' .artwork-slot').evaluateAll(slots => slots.map(slot => ({ position: Number((slot as HTMLElement).dataset.position), left: (slot as HTMLElement).offsetLeft })).sort((a, b) => a.left - b.left).map(slot => slot.position))
        expect(positions).toEqual(side === 'blue' ? [3, 2, 1] : [1, 2, 3])
      }
      for (const stage of ['秘卷', '通灵']) {
        for (const actor of [first, second]) {
          await expect(actor.locator('.stage-status strong')).toHaveText('选择' + stage, { timeout: 20000 })
          await selectBatch(actor)
        }
      }
      await expect(host.locator('.result-entry')).toHaveCount(22, { timeout: 20000 })
      await expect(first.getByRole('button', { name: '乙选手 获胜', exact: true })).toHaveCount(0)
      await host.getByRole('button', { name: '乙选手 获胜', exact: true }).click()
      await host.getByRole('button', { name: round === 1 ? '开启第 2 局' : '完成 BO3', exact: true }).click()
    }
    await expect(host.locator('.completed-banner')).toContainText('BO3 已结束 · 2 : 0', { timeout: 20000 })
    await host.getByRole('button', { name: '下一场准备', exact: true }).click()
    await expect(host.getByRole('button', { name: '交换 1P / 2P', exact: true })).toBeEnabled({ timeout: 20000 })
    await host.getByRole('button', { name: '交换 1P / 2P', exact: true }).click()
    await expect(first.locator('.share-strip em')).toHaveText('你是 1P', { timeout: 20000 })
    await expect(host.locator('.share-strip em')).toHaveText('你是 房主（观战）')
  } finally { for (const context of contexts) await context.close() }
})

test('rotated mobile search matches the device and ranks never open a native menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  await expect(page.locator('.app-shell')).toHaveClass(/mobile-landscape/)
  await page.getByRole('button', { name: '打开忍者搜索', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '忍者搜索', exact: true })
  await expect(dialog.getByRole('searchbox')).toBeFocused()
  expect(await dialog.evaluate(el => el.closest('.app-shell'))).toBeNull()
  await page.setViewportSize({ width: 390, height: 480 })
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await dialog.getByRole('searchbox').fill('不立土')
  await page.screenshot({ path: 'artifacts/mobile-search.png' })
  await page.getByRole('button', { name: '完成搜索', exact: true }).click()
  await expect(page.locator('.item-tile')).toHaveCount(1)
  await page.getByRole('group', { name: '忍者评级' }).getByRole('button', { name: 'S', exact: true }).click()
  await expect(page.locator('.arena-toolbar select')).toHaveCount(0)
  await expect(page.getByRole('group', { name: '忍者评级' }).getByRole('button', { name: 'S', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: 'artifacts/mobile-rank.png' })
})
