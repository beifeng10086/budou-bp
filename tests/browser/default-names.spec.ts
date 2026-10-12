import { test, expect } from '@playwright/test'

test('empty or whitespace names start local BP as 1P and 2P', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('你的圈名').fill('   ')
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await expect(page.locator('.ready-names input').nth(0)).toHaveValue('1P')
  await expect(page.locator('.ready-names input').nth(1)).toHaveValue('2P')
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  await expect(page.locator('.arena-player.blue strong')).toHaveText('1P')
  await expect(page.locator('.arena-player.red strong')).toHaveText('2P')
})

for (const fallback of [false, true]) {
  test(`unnamed players create and join through ${fallback ? 'HTTPS' : 'WebSocket'} with distinct defaults`, async ({ browser }) => {
    const hostContext = await browser.newContext()
    const guestContext = await browser.newContext()
    if (fallback) {
      await hostContext.routeWebSocket('**/ws?**', socket => socket.close())
      await guestContext.routeWebSocket('**/ws?**', socket => socket.close())
    }
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    try {
      await host.goto('/')
      await host.getByRole('button', { name: '创建共享房间', exact: true }).click()
      await expect(host).toHaveURL(/\?room=/)
      await guest.goto(host.url())
      await guest.getByRole('button', { name: '加入房间', exact: true }).click()
      await expect(guest.locator('.share-strip em')).toHaveText('你是 2P')
      await expect(host.getByText('2P 已加入', { exact: true })).toBeVisible()
      await expect(host.locator('.ready-names input').nth(0)).toHaveValue('1P')
      await expect(host.locator('.ready-names input').nth(1)).toHaveValue('2P')
      await host.getByRole('button', { name: '开始 BP', exact: true }).click()
      await expect(guest.locator('.arena-player.blue strong')).toHaveText('1P')
      await expect(guest.locator('.arena-player.red strong')).toHaveText('2P')
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
}
