import { test, expect } from '@playwright/test'
import { searchFor } from './search-helper'

for (const width of [390, 844]) test('Ban artwork is complete and centered at ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 390 })
  await page.goto('/')
  await expect(page.getByLabel('数据包').locator('option:checked')).toContainText('官网资料汇总池')
  await page.screenshot({ path: 'artifacts/home-' + width + '.png', fullPage: true })
  await page.getByRole('button', { name: '本机演练', exact: true }).click()
  await page.getByRole('button', { name: '开始 BP', exact: true }).click()
  await searchFor(page, '宇智波带土【十尾人柱力】')
  await page.locator('.item-tile:not([disabled])').click()
  const artwork = page.locator('.ninja-artwork')
  await expect(artwork).toHaveAttribute('src', /^data:image\/png/)
  await artwork.evaluate((img: HTMLImageElement) => img.decode())
  const coverage = await artwork.evaluate((img: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.clientWidth; canvas.height = img.clientHeight
    const ctx = canvas.getContext('2d')!
    const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight)
    const position = getComputedStyle(img).objectPosition.split(' ').map(value => Number.parseFloat(value) / 100)
    ctx.drawImage(img, (canvas.width - img.naturalWidth * scale) * position[0]!, (canvas.height - img.naturalHeight * scale) * position[1]!, img.naturalWidth * scale, img.naturalHeight * scale)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let top = canvas.height, bottom = 0, left = canvas.width, right = 0
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (pixels[(y * canvas.width + x) * 4 + 3]! > 16) {
      top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x)
    }
    return { height: (bottom - top + 1) / canvas.height, width: (right - left + 1) / canvas.width }
  })
  expect(coverage.height).toBeGreaterThan(.8)
  expect(coverage.width).toBeGreaterThan(.15)
  await expect(artwork).toHaveCSS('object-fit', 'contain')
  await page.screenshot({ path: 'artifacts/obito-' + width + '.png' })
  if (width === 390) {
    await page.setViewportSize({ width: 390, height: 480 })
    await page.screenshot({ path: 'artifacts/obito-keyboard.png' })
    await expect(artwork).toBeVisible()
    await expect(page.getByRole('button', { name: '确认禁用' })).toBeVisible()
  }
})
