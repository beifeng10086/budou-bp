import { test, expect } from '@playwright/test'

const snapshot = (used: number) => ({ day: new Date().toISOString().slice(0, 10), updatedAt: Date.now(), resetAt: (Math.floor(Date.now() / 86400000) + 1) * 86400000, automatic: true, metrics: [{ id: 'requests', label: '联网请求', used, limit: 100000, unit: '次' }] })
test('exhaustion disables shared rooms and preserves local BP', async ({ page }) => {
  await page.route('**/quota', route => route.fulfill({ json: snapshot(100000) }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: '创建共享房间' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '加入房间', exact: true })).toBeDisabled()
  await page.getByPlaceholder('填写游戏名 / 圈名').fill('额度测试')
  await page.getByRole('button', { name: '本机演练' }).click()
  await expect(page.getByRole('button', { name: '开始 BP' })).toBeEnabled()
  await page.getByRole('button', { name: '开始 BP' }).click()
  await expect(page.locator('.arena-board')).toBeVisible()
})
test('Cloudflare HTML quota error stops fallback polling and persists across reload', async ({ page }) => {
  let attempts = 0
  await page.route('**/quota', route => route.fulfill({ json: snapshot(10) }))
  await page.routeWebSocket('**/ws?**', socket => socket.close())
  await page.route('**/room?**', route => { attempts++; return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Error 1027</h1>' }) })
  await page.goto('/')
  await page.getByPlaceholder('填写游戏名 / 圈名').fill('网络测试')
  await page.getByRole('button', { name: '创建共享房间' }).click()
  await expect(page.getByRole('button', { name: '创建共享房间' })).toBeDisabled()
  await page.waitForTimeout(4000)
  expect(attempts).toBe(1)
  await page.reload()
  await expect(page.getByRole('button', { name: '创建共享房间' })).toBeDisabled()
})

test('unknown quota is shown honestly without disabling local or shared entry', async ({ page }) => {
  await page.route('**/quota', route => route.fulfill({ json: { unavailable: true } }))
  await page.goto('/')
  await expect(page.getByText('当前剩余额度未知')).toBeVisible()
  await expect(page.getByRole('button', { name: '加入房间', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '本机演练' })).toBeEnabled()
})
test('yesterday exhaustion cache unlocks after the next UTC day', async ({ page }) => {
  const yesterday = snapshot(100000)
  yesterday.updatedAt = Date.now() - 86400000
  yesterday.resetAt = Math.floor(Date.now() / 86400000) * 86400000
  await page.addInitScript(q => {
    localStorage.setItem('wudou-quota-snapshot', JSON.stringify(q))
    localStorage.setItem('wudou-quota-blocked-until', String(q.resetAt))
  }, yesterday)
  await page.route('**/quota', route => route.fulfill({ json: snapshot(20) }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: '创建共享房间' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '加入房间', exact: true })).toBeEnabled()
})
