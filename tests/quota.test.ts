import test from 'node:test'
import assert from 'node:assert/strict'
import { isQuotaFailure, nextQuotaReset, quotaExhausted, validQuota } from '../src/quota.ts'
import { collectQuota } from '../worker/quota.ts'

test('daily quota resets at UTC midnight, Beijing 08:00', () => {
  assert.equal(nextQuotaReset(Date.parse('2026-10-12T23:59:59Z')), Date.parse('2026-10-13T00:00:00Z'))
  assert.equal(nextQuotaReset(Date.parse('2026-10-13T00:00:00Z')), Date.parse('2026-10-14T00:00:00Z'))
})
test('only explicit daily exhaustion blocks, not generic rate limiting or CPU errors', () => {
  assert.equal(isQuotaFailure(503, '<h1>Error 1027</h1>'), true)
  assert.equal(isQuotaFailure(503, '{"code":"QUOTA_EXHAUSTED"}'), true)
  assert.equal(isQuotaFailure(429, 'Too many requests'), false)
  assert.equal(isQuotaFailure(500, 'Error 1102 Worker exceeded resource limits'), false)
  assert.equal(isQuotaFailure(200, '1027'), false)
})
test('unknown and yesterday snapshots do not block; any measured limit can exhaust', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  const q = { day: '2026-10-12', updatedAt: now, resetAt: nextQuotaReset(now), automatic: true, metrics: [{ id: 'writes', label: 'Writes', used: 100000, limit: 100000, unit: 'rows' }] }
  assert.equal(validQuota(q), true)
  assert.equal(validQuota({ ...q, metrics: [{ ...q.metrics[0], used: -1 }] }), false)
  assert.equal(quotaExhausted(null, now), false)
  assert.equal(quotaExhausted(q, now), true)
  assert.equal(quotaExhausted(q, q.resetAt), false)
})
test('account analytics sums Pages and Workers and discounts only WebSocket messages', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ data: { viewer: { accounts: [{
    workersInvocationsAdaptive: [{ sum: { requests: 50 } }],
    pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 100 } }],
    durableObjectsInvocationsAdaptiveGroups: [{ dimensions: { type: 'http' }, sum: { requests: 30 } }, { dimensions: { type: 'alarm' }, sum: { requests: 5 } }, { dimensions: { type: 'hibernation' }, sum: { requests: 200 } }],
    durableObjectsPeriodicGroups: [{ sum: { inboundWebsocketMsgCount: 200, duration: 20, rowsRead: 40, rowsWritten: 10 } }],
  }] } } })
  try {
    const q = await collectQuota('test', 'account', true)
    assert.equal(q.metrics.find(m => m.id === 'requests')?.used, 150)
    assert.equal(q.metrics.find(m => m.id === 'roomRequests')?.used, 45)
  } finally { globalThis.fetch = original }
})
