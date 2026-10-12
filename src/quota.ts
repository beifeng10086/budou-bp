export interface QuotaMetric { id: string; label: string; used: number; limit: number; unit: string }
export interface QuotaSnapshot {
  day: string
  updatedAt: number
  resetAt: number
  metrics: QuotaMetric[]
  automatic: boolean
}
export const nextQuotaReset = (now = Date.now()) => (Math.floor(now / 86400000) + 1) * 86400000
export function validQuota(value: unknown): value is QuotaSnapshot {
  const q = value as QuotaSnapshot | null
  return !!q && typeof q.day === 'string' && Number.isFinite(q.updatedAt) && Number.isFinite(q.resetAt)
    && q.resetAt > q.updatedAt && typeof q.automatic === 'boolean' && Array.isArray(q.metrics) && q.metrics.length > 0
    && q.metrics.every(m => typeof m.id === 'string' && typeof m.label === 'string' && typeof m.unit === 'string' && Number.isFinite(m.used) && m.used >= 0 && Number.isFinite(m.limit) && m.limit > 0)
}
export function quotaExhausted(q: QuotaSnapshot | null, now = Date.now()) {
  return !!q && q.resetAt > now && q.metrics.some(m => m.used >= m.limit)
}
// A generic 429/5xx or CPU limit is not evidence of daily quota exhaustion.
export function isQuotaFailure(status: number, body: string) {
  if (status < 400) return false
  return /\bQUOTA_EXHAUSTED\b|\b1027\b|daily (?:request |usage )?limit (?:exceeded|reached)|exceeded (?:the )?(?:daily|free tier) (?:limit|quota)|(?:daily|free tier).{0,50}(?:quota|limit).{0,30}exceeded/i.test(body)
}

