<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import html2canvas from 'html2canvas'
import { Check, ChevronLeft, CloudUpload, Copy, Download, Link, RotateCcw, Swords, Users, Smartphone, Monitor } from '@lucide/vue'
import { builtinPackages, loadOfficialPackages, validPackage } from './data'
import ResultList from './components/ResultList.vue'
import ArenaBoard from './components/ArenaBoard.vue'
import { RoomTransport, type RoomPayload } from './room-transport'
import { bestOfLabel, createMatch, endMatch, expireTimedPhase, nextRoundProblem, normalizeName, playerName, recordWinner, resetMatch, seriesFinished, startMatch, startNextRound, swapPlayerNames, poolProblem } from './bp'
import { applyRoomAction, type RoomAction } from './room-actions'
import { copyText } from './clipboard'
import type { BestOf, DataPackage, MatchState, Seat, StoredPackage } from './types'
import { isQuotaFailure, nextQuotaReset, quotaExhausted, validQuota, type QuotaSnapshot } from './quota'

const CUSTOM_KEY = 'budou-bp-custom-packages'
const TOKEN_PREFIX = 'budou-bp-room-token:'
const screen = ref<'home' | 'match'>('home')
const quota = ref<QuotaSnapshot | null>(null)
const quotaClock = ref(Date.now())
const quotaLoading = ref(false)
const quotaUnavailable = ref(false)
const quotaBlockedUntil = ref(Number(localStorage.getItem('wudou-quota-blocked-until')) || 0)
const onlineBlocked = computed(() => quotaBlockedUntil.value > quotaClock.value || quotaExhausted(quota.value, quotaClock.value))
const quotaStale = computed(() => !quota.value || quotaClock.value - quota.value.updatedAt > 10 * 60 * 1000 || quota.value.resetAt <= quotaClock.value)
const quotaUpdated = computed(() => quota.value ? new Date(quota.value.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '')
let quotaTimer: number | undefined
let quotaRequest: Promise<void> | null = null
let quotaCheckedAt = 0
function markQuotaExhausted() {
  quotaBlockedUntil.value = nextQuotaReset()
  localStorage.setItem('wudou-quota-blocked-until', String(quotaBlockedUntil.value))
}
async function refreshQuota() {
  if (quotaRequest) return quotaRequest
  quotaLoading.value = true
  quotaRequest = (async () => {
    try {
      const response = await fetch('/quota', { signal: AbortSignal.timeout(8000) })
      const raw = await response.text()
      if (isQuotaFailure(response.status, raw)) { markQuotaExhausted(); return }
      if (!response.ok) throw new Error('Quota unavailable')
      const snapshot: unknown = JSON.parse(raw)
      if (!validQuota(snapshot)) throw new Error('Quota unavailable')
      quota.value = snapshot
      localStorage.setItem('wudou-quota-snapshot', JSON.stringify(snapshot))
      quotaUnavailable.value = false
      if (quotaExhausted(snapshot)) markQuotaExhausted()
    } catch { quotaUnavailable.value = true }
    finally { quotaLoading.value = false; quotaCheckedAt = Date.now(); quotaRequest = null }
  })()
  return quotaRequest
}
function loadPackages(): StoredPackage[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]')
    return [...builtinPackages, ...(Array.isArray(saved) ? saved.filter(validPackage).map(pack => ({ ...pack, isCustom: true })) : [])]
  } catch { return [...builtinPackages] }
}
const packages = ref(loadPackages())
const selectedPackageId = ref(packages.value[0]?.id ?? '')
const selectedPackage = computed<DataPackage>(() => packages.value.find(pack => pack.id === selectedPackageId.value) ?? builtinPackages[0])
const title = ref('武斗对局')
const bestOf = ref<BestOf>(3)
const roundBan = ref(true)
const repeatScrolls = ref(false)
const repeatSummons = ref(false)
const nickname = ref(localStorage.getItem('wudou-player-name') ?? '')
const secondName = ref('')
const joinCode = ref('')
const roomCode = ref('')
const online = ref(false)
const onlineSeat = ref<Seat>('blue')
const players = ref({ blue: true, red: false })
const connectionLabel = ref('')
const catalogLoading = ref(true)
const catalogError = ref('')
const orientation = ref<'landscape' | 'portrait'>('landscape')
const mobile = ref(false)
const secondsLeft = ref(60)
const showInvite = ref(false)
const copyResult = ref('')
const inviteInput = ref<HTMLInputElement | null>(null)
const exportTarget = ref<HTMLElement | null>(null)
const savedImage = ref('')
const match = ref(createMatch(selectedPackage.value, title.value, roundBan.value))
let transport: RoomTransport | null = null
let connectionAttempt = 0
let timer: number | undefined
let media: MediaQueryList | undefined
let serverOffset = 0
const detectMobile = () => { mobile.value = media?.matches ?? false }
const current = computed(() => match.value.current)
const isHost = computed(() => !online.value || onlineSeat.value === 'blue')
const roleLabel = computed(() => online.value ? '你是 ' + (onlineSeat.value === 'blue' ? '1P（房主）' : '2P') : '本机双人演练')
const rounds = computed(() => [...match.value.history, ...(match.value.history.some(r => r.number === current.value.number) ? [] : [current.value])])
const wins = computed(() => ({ blue: rounds.value.filter(r => r.winner === 'blue').length, red: rounds.value.filter(r => r.winner === 'red').length }))
const exhausted = computed(() => nextRoundProblem(match.value))
const inviteUrl = computed(() => location.origin + location.pathname + '?room=' + roomCode.value)
const artworkLibrary = computed(() => packages.value.flatMap(pack => pack.ninjas).filter(item => item.artwork))
const createSettings = () => ({ bestOf: bestOf.value, repeatScrolls: repeatScrolls.value, repeatSummons: repeatSummons.value, playerNames: { blue: normalizeName(nickname.value, '玩家一'), red: normalizeName(secondName.value, '玩家二') } })

onMounted(() => {
  try { const stored: unknown = JSON.parse(localStorage.getItem('wudou-quota-snapshot') ?? 'null'); if (validQuota(stored)) quota.value = stored } catch { /* Missing cache is normal. */ }
  if (!onlineBlocked.value) void refreshQuota()
  quotaTimer = window.setInterval(() => { if (screen.value === 'home' && !document.hidden && !onlineBlocked.value) void refreshQuota() }, 300000)
  void loadCatalog()
  media = matchMedia('(pointer: coarse), (max-width: 767px)')
  detectMobile()
  media.addEventListener('change', detectMobile)
  timer = window.setInterval(() => {
    quotaClock.value = Date.now()
    const deadline = current.value.phase.expiresAt
    secondsLeft.value = deadline ? Math.min(60, Math.max(0, Math.ceil((deadline - Date.now() - (online.value ? serverOffset : 0)) / 1000))) : 60
    if (!online.value && screen.value === 'match' && deadline && Date.now() >= deadline) match.value = expireTimedPhase(match.value)
  }, 200)
  const code = new URLSearchParams(location.search).get('room')
  if (code) {
    joinCode.value = code.toUpperCase()
    if (/^[A-Z0-9]{5,8}$/.test(joinCode.value) && localStorage.getItem(TOKEN_PREFIX + joinCode.value)) openRoom('join', joinCode.value)
  }
})
onBeforeUnmount(() => { if (timer) clearInterval(timer); if (quotaTimer) clearInterval(quotaTimer); transport?.close(); media?.removeEventListener('change', detectMobile) })

async function loadCatalog() {
  catalogLoading.value = true
  catalogError.value = ''
  try {
    const official = await loadOfficialPackages()
    const ids = new Set(official.map(pack => pack.id))
    packages.value = [...official, ...packages.value.filter(pack => !ids.has(pack.id))]
    if (screen.value === 'home' && official[0]) selectedPackageId.value = official[0].id
  } catch { catalogError.value = '官网资料包加载失败，可重试或使用演示包。' }
  finally { catalogLoading.value = false }
}
function requireName() {
  if (!nickname.value.trim()) { connectionLabel.value = '请先填写你的圈名'; return false }
  nickname.value = normalizeName(nickname.value, '玩家')
  localStorage.setItem('wudou-player-name', nickname.value)
  return true
}
function createLocalMatch() {
  if (!requireName()) return
  connectionAttempt++
  transport?.close(); transport = null
  online.value = false; roomCode.value = ''; orientation.value = 'landscape'
  match.value = createMatch(selectedPackage.value, title.value, roundBan.value, createSettings())
  screen.value = 'match'; connectionLabel.value = ''
}
function createOnlineRoom() {
  if (!requireName()) return
  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()
  openRoom('create', code, createMatch(selectedPackage.value, title.value, roundBan.value, createSettings()))
}
function joinOnlineRoom() {
  if (!requireName()) return
  const code = joinCode.value.trim().toUpperCase()
  if (!/^[A-Z0-9]{5,8}$/.test(code)) { connectionLabel.value = '请输入 5–8 位房间码'; return }
  openRoom('join', code)
}
async function openRoom(mode: 'create' | 'join', code: string, newMatch?: MatchState) {
  const attempt = ++connectionAttempt
  if (!onlineBlocked.value && Date.now() - quotaCheckedAt > 60000) await refreshQuota()
  if (attempt !== connectionAttempt) return
  if (onlineBlocked.value) { connectionLabel.value = '今日共享服务额度已用尽，请使用本机演练'; return }
  transport?.close()
  online.value = false
  connectionLabel.value = '正在连接共享房间…'
  let token = localStorage.getItem(TOKEN_PREFIX + code)
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    token = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(TOKEN_PREFIX + code, token)
  }
  const wsUrl = import.meta.env.VITE_WS_URL || (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.hostname + (location.port === '5173' ? ':8787' : location.port ? ':' + location.port : '') + '/ws'
  const endpoint = new URL(wsUrl)
  endpoint.searchParams.set('room', code); endpoint.searchParams.set('mode', mode); endpoint.searchParams.set('client', token)
  endpoint.searchParams.set('name', normalizeName(nickname.value, '玩家二'))
  transport = new RoomTransport({
    endpoint: endpoint.toString(), mode, match: newMatch,
    onQuotaExhausted: markQuotaExhausted,
    onStatus: message => { connectionLabel.value = message },
    onMessage: (payload: RoomPayload) => {
      if (payload.type === 'room:state' && payload.match) {
        if (typeof payload.serverTime === 'number') serverOffset = payload.serverTime - Date.now()
        const data = payload.data ?? payload.match.data ?? (payload.match.dataPackageId === match.value.data.id ? match.value.data : undefined)
        if (!data) { connectionLabel.value = '房间资料加载失败，请重新进入'; return }
        match.value = { ...payload.match, data }; online.value = true; onlineSeat.value = payload.seat ?? 'blue'
        players.value = payload.players ?? players.value; roomCode.value = code; screen.value = 'match'
        history.replaceState({}, '', '?room=' + code)
      } else if (payload.type === 'room:error') connectionLabel.value = payload.message ?? '房间连接失败'
    },
  })
  orientation.value = 'landscape'; transport.start()
}
function action(action: RoomAction, options: { itemId?: string; winner?: Seat; name?: string; seat?: Seat } = {}) {
  if (online.value) transport?.send({ type: 'room:action', action, ...options })
  else match.value = applyRoomAction(match.value, { action, ...options }, options.seat ?? 'blue') ?? match.value
}
function beginMatch() {
  const problem = poolProblem(match.value)
  if (problem) { connectionLabel.value = problem; return }
  if (online.value) action('start'); else match.value = startMatch(match.value)
}
function nextRound() { if (online.value) action('next'); else match.value = startNextRound(match.value) }
function restart() { if (online.value) action('new-match'); else match.value = resetMatch(match.value) }
function finish() { if (online.value) action('end'); else match.value = endMatch(match.value) }
function selectWinner(seat: Seat) { if (online.value) action('winner', { winner: seat }); else match.value = recordWinner(match.value, seat) }
function swapSeats() { if (online.value) action('swap-seats'); else match.value = swapPlayerNames(match.value) }
function rename(event: Event, seat: Seat) { action('rename', { seat, name: (event.target as HTMLInputElement).value }) }
function backHome() { connectionAttempt++; transport?.close(); transport = null; online.value = false; screen.value = 'home'; connectionLabel.value = ''; history.replaceState({}, '', location.pathname); if (!onlineBlocked.value) void refreshQuota() }
function handleImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  void file.text().then(raw => {
    const value: unknown = JSON.parse(raw)
    if (!validPackage(value)) throw new Error('invalid')
    const pack = { ...value, isCustom: true }
    packages.value = [...packages.value.filter(item => item.id !== pack.id), pack]; selectedPackageId.value = pack.id
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(packages.value.filter(item => item.isCustom)))
  }).catch(() => { connectionLabel.value = '数据包无效：至少需要 22 名忍者、9 个秘卷、9 个通灵，且各项 ID 不重复。' }).finally(() => { input.value = '' })
}
async function copyShareLink() {
  const success = await copyText(inviteUrl.value)
  copyResult.value = success ? '邀请链接已复制' : '自动复制未成功，请长按下方链接复制'
  connectionLabel.value = copyResult.value
  showInvite.value = true
}
async function exportImage() {
  if (!exportTarget.value) return
  await Promise.all(Array.from(exportTarget.value.querySelectorAll('img')).map(img => img.decode().catch(() => undefined)))
  const canvas = await html2canvas(exportTarget.value, { backgroundColor: '#f6f8f8', scale: 2, useCORS: true })
  savedImage.value = canvas.toDataURL('image/png')
  const link = document.createElement('a'); link.download = match.value.settings.title + '-第' + current.value.number + '局BP.png'; link.href = savedImage.value; link.click()
}
</script>

<template>
  <main class="app-shell" :class="{ battle: screen === 'match', 'arena-play': screen === 'match' && match.status === 'playing', 'mobile-landscape': mobile && orientation === 'landscape', 'portrait-mode': mobile && orientation === 'portrait' }">
    <section v-if="screen === 'home'" class="home-screen">
      <header class="brand-row"><div class="brand-mark"><Swords :size="22" /></div><h1>武斗 BP 练习室</h1></header>
      <section class="quota-strip" :class="{ 'quota-blocked': onlineBlocked }" aria-label="共享服务额度">
        <div class="quota-heading"><strong>{{ onlineBlocked ? '今日共享额度已用尽' : '今日共享服务额度' }}</strong><span>北京时间 08:00 重置</span></div>
        <template v-if="quota && quota.resetAt > quotaClock">
          <div class="quota-primary"><span>联网请求预计剩余</span><strong>{{ Math.max(0, Math.floor((quota.metrics.find(m => m.id === 'requests')?.limit ?? 100000) - (quota.metrics.find(m => m.id === 'requests')?.used ?? 0))).toLocaleString() }} <small>次</small></strong></div>
          <div class="quota-metrics"><div v-for="metric in quota.metrics" :key="metric.id"><div><span>{{ metric.label }}</span><span>{{ Math.ceil(metric.used).toLocaleString() }} / {{ metric.limit.toLocaleString() }} {{ metric.unit }}</span></div><progress :value="Math.min(metric.used, metric.limit)" :max="metric.limit" :aria-label="metric.label" /></div></div>
          <p>{{ quotaStale || quotaUnavailable ? '统计暂未更新 · ' : '' }}{{ quota.automatic ? '官方统计（有延迟）' : '官方统计快照（自动更新尚未接通）' }} · {{ quotaUpdated }}</p>
        </template>
        <p v-else>{{ quotaLoading ? '正在读取官方统计…' : '当前剩余额度未知' }}</p>
        <p v-if="onlineBlocked" role="status">共享房间暂停，本机演练可用。</p>
      </section>
      <label class="field-label name-field">你的圈名<input v-model="nickname" class="text-input" maxlength="16" placeholder="填写游戏名 / 圈名" autocomplete="nickname" /></label>
      <section class="join-panel prominent-join"><h2><Link :size="20" />通过房间码加入</h2><div class="join-row"><input v-model="joinCode" class="text-input room-input" maxlength="8" placeholder="输入房间码" aria-label="房间码" @keyup.enter="joinOnlineRoom" /><button class="button primary" :disabled="onlineBlocked" @click="joinOnlineRoom"><Users :size="18" />加入房间</button></div></section>
      <p v-if="connectionLabel" class="connection-note" role="status">{{ connectionLabel }}</p>
      <div class="setup-grid">
        <label class="field-label">对局名称<input v-model="title" class="text-input" maxlength="20" /></label>
        <label class="field-label">赛制<select v-model="bestOf" class="select-input" aria-label="赛制"><option :value="3">BO3</option><option :value="5">BO5</option><option :value="7">BO7</option><option :value="0">BO 无限</option></select></label>
        <label class="field-label">本机 2P 圈名<input v-model="secondName" class="text-input" maxlength="16" placeholder="玩家二" /></label>
        <label class="field-label">数据包<select v-model="selectedPackageId" class="select-input" aria-label="数据包"><option v-for="pack in packages" :key="pack.id" :value="pack.id">{{ pack.name }} · {{ pack.updatedAt }}</option></select></label>
        <p class="data-note">{{ selectedPackage.source }} · {{ selectedPackage.ninjas.length }} 忍者 / {{ selectedPackage.scrolls.length }} 秘卷 / {{ selectedPackage.summons.length }} 通灵</p>
        <p v-if="catalogLoading" class="data-note" role="status">资料加载中…</p>
        <p v-if="catalogError" class="data-note">{{ catalogError }} <button class="text-command" @click="loadCatalog">重试</button></p>
        <label class="import-control"><CloudUpload :size="19" />导入数据包<input type="file" accept="application/json,.json" @change="handleImport" /></label>
      </div>
      <div class="rules-settings">
        <label><span>每小局重新 Ban</span><input v-model="roundBan" type="checkbox" role="switch" /></label>
        <label><span>秘卷跨小局可重复</span><input v-model="repeatScrolls" type="checkbox" role="switch" /></label>
        <label><span>通灵跨小局可重复</span><input v-model="repeatSummons" type="checkbox" role="switch" /></label>
      </div>
      <div class="home-actions"><button class="button primary" :disabled="catalogLoading" @click="createLocalMatch"><Swords :size="19" />本机演练</button><button class="button secondary" :disabled="catalogLoading || onlineBlocked" @click="createOnlineRoom"><Users :size="19" />创建共享房间</button></div>
    </section>
    <section v-else class="match-screen">
      <header class="match-header">
        <button class="icon-command" title="返回首页" @click="backHome"><ChevronLeft :size="19" /></button>
        <div class="match-title"><span>{{ bestOfLabel(match) }} · 第 {{ current.number }} 局</span><strong>{{ match.settings.title }}</strong></div>
        <button v-if="mobile" class="icon-command" :title="orientation === 'landscape' ? '切换竖屏' : '切换横屏'" @click="orientation = orientation === 'landscape' ? 'portrait' : 'landscape'"><Smartphone v-if="orientation === 'landscape'" :size="18" /><Monitor v-else :size="18" /></button><span v-else></span>
      </header>
      <div v-if="online" class="share-strip"><span>房间 {{ roomCode }}</span><em>{{ roleLabel }}</em><button @click="copyShareLink"><Copy :size="14" />复制邀请链接</button><small role="status">{{ connectionLabel }}</small></div>
      <section v-if="match.status === 'setup'" class="ready-panel">
        <span class="ready-state" :class="{ joined: !online || players.red }">{{ online ? players.red ? '2P 已加入' : '等待 2P 加入' : '本机双方就绪' }}</span>
        <div class="ready-names"><label v-for="seat in (['blue', 'red'] as const)" :key="seat" class="field-label"><span>{{ seat === 'blue' ? '1P · 房主' : '2P' }}</span><input class="text-input" :value="playerName(match, seat)" maxlength="16" :disabled="online && onlineSeat !== seat" @change="rename($event, seat)" /></label></div>
        <p>{{ bestOfLabel(match) }} · {{ match.settings.roundBan ? '每小局 Ban' : '首局 Ban' }} · 全阶段 60 秒</p>
        <p>秘卷{{ match.settings.repeatScrolls ? '可重复' : '不可重复' }} · 通灵{{ match.settings.repeatSummons ? '可重复' : '不可重复' }}</p>
        <div v-if="isHost" class="ready-actions"><button class="button primary" :disabled="online && !players.red" @click="beginMatch"><Swords :size="18" />开始 BP</button><button class="button secondary" :disabled="online && !players.red" @click="swapSeats"><Users :size="18" />交换 1P / 2P</button></div>
        <p v-else>等待 1P 开始 BP</p><p v-if="!online && connectionLabel" role="status">{{ connectionLabel }}</p>
      </section>
      <ArenaBoard v-if="match.status === 'playing'" :match="match" :seconds="secondsLeft" :online="online" :seat="onlineSeat" :wins="wins" :artworks="artworkLibrary" :portrait="mobile && orientation === 'portrait'" @choose="(itemId, seat, timed) => action(timed ? 'timed' : 'ninja', { itemId, seat })" />
      <section v-if="current.phase.kind === 'complete'" ref="exportTarget" class="result-board">
        <div class="result-heading"><span>{{ bestOfLabel(match) }} · 第 {{ current.number }} 局完整阵容 · {{ wins.blue }} : {{ wins.red }}</span><strong>{{ match.settings.title }}</strong></div>
        <div class="result-columns"><div v-for="seat in (['blue', 'red'] as const)" :key="seat" class="result-side" :class="seat"><h2><small>{{ seat === 'blue' ? '1P' : '2P' }}</small> {{ playerName(match, seat) }}</h2><ResultList title="禁用" :items="current.bans[seat]" :source="match.data.ninjas" /><ResultList title="忍者" :items="current.picks[seat]" :source="match.data.ninjas" /><ResultList title="秘卷" :items="current.scrolls[seat]" :source="match.data.scrolls" /><ResultList title="通灵" :items="current.summons[seat]" :source="match.data.summons" /></div></div>
      </section>
      <section v-if="current.phase.kind === 'complete'" class="round-actions">
        <button class="button secondary" @click="exportImage"><Download :size="18" />保存 BP 图</button>
        <template v-if="match.status === 'round-complete' && isHost"><template v-if="!current.winner"><span>游戏结束后记录本局胜者</span><button v-for="seat in (['blue', 'red'] as const)" :key="seat" class="winner" :class="seat + '-button'" @click="selectWinner(seat)"><Check :size="17" />{{ playerName(match, seat) }} 获胜</button></template><button v-else-if="!exhausted" class="button primary" @click="nextRound">{{ seriesFinished(match) ? '完成 ' + bestOfLabel(match) : '开启第 ' + (current.number + 1) + ' 局' }}</button><button v-if="current.winner && !seriesFinished(match) && !exhausted" class="button secondary" @click="finish">结束本场</button></template>
      </section>
      <section v-if="exhausted" class="exhausted-panel" role="status"><strong>{{ exhausted }}</strong><div v-if="isHost" class="ready-actions"><button class="button primary" @click="restart"><RotateCcw :size="18" />重开本场</button><button class="button secondary" @click="finish">结束本场</button></div><p v-else>等待房主选择重开或结束</p></section>
      <section v-if="match.status === 'match-complete'" class="completed-banner"><strong>{{ bestOfLabel(match) }} 已结束 · {{ wins.blue }} : {{ wins.red }}</strong><button v-if="isHost" class="button primary" @click="restart">下一场准备</button></section>
    </section>
    <div v-if="showInvite" class="dialog-backdrop" @click.self="showInvite = false"><section class="copy-dialog" role="dialog" aria-label="邀请链接"><h2>邀请好友</h2><p>{{ copyResult }}</p><input ref="inviteInput" class="text-input" :value="inviteUrl" readonly aria-label="邀请链接" @click="inviteInput?.select()" /><div class="ready-actions"><button class="button primary" @click="copyShareLink"><Copy :size="18" />重试复制</button><button class="button secondary" @click="showInvite = false">关闭</button></div></section></div>
    <div v-if="savedImage && mobile" class="dialog-backdrop" @click.self="savedImage = ''"><section class="image-dialog" role="dialog" aria-label="BP 图片"><img :src="savedImage" alt="本局 BP 图" /><button class="button secondary" @click="savedImage = ''">关闭</button></section></div>
  </main>
</template>
