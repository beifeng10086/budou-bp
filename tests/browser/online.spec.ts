import { test, expect } from '@playwright/test'

test('two browsers join a room and the host keeps 1P after refresh', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()

  try {
    await host.goto('/')
    await expect(host.locator('.select-input option:checked')).toContainText('官网资料汇总池')
    await host.getByRole('button', { name: '创建共享房间', exact: true }).click()
    await expect(host).toHaveURL(/\?room=[A-Z0-9]{5,8}$/)
    await expect(host.locator('.share-strip em')).toHaveText('你是 1P（房主）')

    const inviteUrl = host.url()
    await guest.goto(inviteUrl)
    await expect(guest.locator('.share-strip em')).toHaveText('你是 2P')
    await expect(host.getByText('2P 已加入', { exact: true })).toBeVisible()

    await host.reload()
    await expect(host.locator('.share-strip em')).toHaveText('你是 1P（房主）')
    await expect(host.getByText('2P 已加入', { exact: true })).toBeVisible()
    await host.getByRole('button', { name: '开始 BP', exact: true }).click()
    await expect(host.locator('.stage-status strong')).toHaveText('1P 禁用忍者')
    await expect(guest.locator('.stage-status strong')).toHaveText('1P 禁用忍者')
  } finally {
    await hostContext.close()
    await guestContext.close()
  }
})

for (const guestFallback of [false, true]) {
  test(`blocked mobile WebSocket uses HTTPS with ${guestFallback ? 'HTTPS' : 'WebSocket'} guest`, async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const requests: string[] = []
    await hostContext.routeWebSocket('**/ws?**', socket => socket.close())
    if (guestFallback) await guestContext.routeWebSocket('**/ws?**', socket => socket.close())
    let failedFirstPost = false
    await hostContext.route('**/room?**', route => {
      requests.push(route.request().method())
      if (!failedFirstPost && route.request().method() === 'POST') {
        failedFirstPost = true
        return route.abort()
      }
      return route.continue()
    })
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    try {
      await host.goto('/')
      await expect(host.locator('.select-input option:checked')).toContainText('官网资料汇总池')
      await host.getByRole('button', { name: '创建共享房间', exact: true }).click()
      await expect(host).toHaveURL(/\?room=[A-Z0-9]{5,8}$/, { timeout: 20000 })
      const inviteUrl = host.url()
      await guest.goto(inviteUrl)
      await expect(guest.locator('.share-strip em')).toHaveText('你是 2P', { timeout: 20000 })
      await expect(host.getByText('2P 已加入', { exact: true })).toBeVisible({ timeout: 20000 })
      await host.getByRole('button', { name: '开始 BP', exact: true }).click()
      await expect(host.locator('.stage-status strong')).toHaveText('1P 禁用忍者', { timeout: 20000 })
      await expect(guest.locator('.stage-status strong')).toHaveText('1P 禁用忍者', { timeout: 20000 })
      await host.locator('.item-tile:not([disabled])').first().click()
      await expect(guest.locator('.stage-status strong')).toHaveText('2P 禁用忍者', { timeout: 20000 })
      await guest.locator('.item-tile:not([disabled])').first().click()
      await expect(host.locator('.roster-bans .portrait')).toHaveCount(2, { timeout: 20000 })
      await host.reload()
      await expect(host.locator('.share-strip em')).toHaveText('你是 1P（房主）', { timeout: 20000 })
      await expect(host.locator('.roster-bans .portrait')).toHaveCount(2, { timeout: 20000 })
      expect(requests).toContain('GET')
      expect(requests).toContain('POST')
      const count = requests.length
      await host.getByRole('button', { name: '返回首页' }).click()
      await host.waitForTimeout(3500)
      expect(requests.length).toBe(count)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
}
