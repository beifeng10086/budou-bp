import type { Page } from '@playwright/test'

export async function searchFor(page: Page, text: string) {
  const trigger = page.getByRole('button', { name: '打开忍者搜索', exact: true })
  if (await trigger.count()) {
    await trigger.click()
    await page.getByRole('dialog', { name: '忍者搜索' }).getByRole('searchbox').fill(text)
    await page.getByRole('button', { name: '完成搜索', exact: true }).click()
  } else await page.getByRole('searchbox').fill(text)
}
