import { nextQuotaReset, validQuota, type QuotaSnapshot } from '../src/quota'

export interface QuotaEnv { QUOTA?: KVNamespace; CF_ANALYTICS_TOKEN?: string; CF_ACCOUNT_ID?: string }
export async function collectQuota(token: string, accountId: string, automatic: boolean): Promise<QuotaSnapshot> {
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const filter = `datetime_geq: "${day}T00:00:00Z", datetime_lt: "${new Date(nextQuotaReset(now)).toISOString()}"`
  const query = `{viewer{accounts(filter:{accountTag:"${accountId}"}){
    workersInvocationsAdaptive(limit:1,filter:{${filter}}){sum{requests}}
    pagesFunctionsInvocationsAdaptiveGroups(limit:1,filter:{${filter}}){sum{requests}}
    durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{${filter}}){dimensions{type} sum{requests}}
    durableObjectsPeriodicGroups(limit:1,filter:{${filter}}){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten}}
  }}}`
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000),
  })
  const result = await response.json() as any
  if (!response.ok || result.errors?.length) throw new Error('Analytics unavailable')
  const account = result.data?.viewer?.accounts?.[0]
  if (!account) throw new Error('Analytics account unavailable')
  const sum = (rows: any[], field: string) => rows.reduce((total, row) => total + (row.sum?.[field] ?? 0), 0)
  const periodic = account.durableObjectsPeriodicGroups
  const requests = sum(account.workersInvocationsAdaptive, 'requests') + sum(account.pagesFunctionsInvocationsAdaptiveGroups, 'requests')
  const roomRequests = sum(account.durableObjectsInvocationsAdaptiveGroups.filter((r: any) => r.dimensions.type !== 'hibernation'), 'requests') + sum(periodic, 'inboundWebsocketMsgCount') / 20
  return { day, updatedAt: now, resetAt: nextQuotaReset(now), automatic, metrics: [
    { id: 'requests', label: '联网请求', used: requests, limit: 100000, unit: '次' },
    { id: 'roomRequests', label: '房间服务请求', used: roomRequests, limit: 100000, unit: '次' },
    { id: 'duration', label: '房间运行时长', used: sum(periodic, 'duration'), limit: 13000, unit: 'GB·秒' },
    { id: 'reads', label: '数据库读取', used: sum(periodic, 'rowsRead'), limit: 5000000, unit: '行' },
    { id: 'writes', label: '数据库写入', used: sum(periodic, 'rowsWritten'), limit: 100000, unit: '行' },
  ] }
}
export async function updateQuota(env: QuotaEnv) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !env.QUOTA) return
  const snapshot = await collectQuota(env.CF_ANALYTICS_TOKEN, env.CF_ACCOUNT_ID, true)
  await env.QUOTA.put('daily', JSON.stringify(snapshot))
}
export async function quotaResponse(request: Request, env: QuotaEnv, ctx: ExecutionContext) {
  const key = new Request(new URL('/quota', request.url).toString())
  const cached = await caches.default.match(key)
  if (cached) return cached
  const snapshot = await env.QUOTA?.get('daily', 'json')
  const response = Response.json(validQuota(snapshot) ? snapshot : { unavailable: true }, { headers: { 'Cache-Control': 'public, max-age=60' } })
  ctx.waitUntil(caches.default.put(key, response.clone()))
  return response
}
