<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import html2canvas from 'html2canvas'
import {
  Check, ChevronLeft, CloudUpload, Copy, Download, Link, Plus, RotateCcw, Swords, Users,
} from '@lucide/vue'
import { builtinPackages, loadOfficialPackages, validPackage } from './data'
import ItemPortrait from './components/ItemPortrait.vue'
import ResultList from './components/ResultList.vue'
import DraftRoster from './components/DraftRoster.vue'
import { sortNinjas } from './catalog'
import {
  canSelectNinja, canSelectTimedItem, chooseNinja, chooseTimedItem, createMatch, expireTimedPhase, recordWinner, resetMatch, startMatch, startNextRound,
} from './bp'
import type { DataPackage, GameItem, MatchState, Seat, StoredPackage } from './types'

const CUSTOM_PACKAGES_KEY = 'budou-bp-custom-packages'
const ROOM_TOKEN_PREFIX = 'budou-bp-room-token:'
type MatchWire = Omit<MatchState, 'data'> & { dataPackageId?: string; data?: DataPackage }
type RoomConnection = { mode: 'create' | 'join'; code: string; token: string; match?: MatchState }
const screen = ref<'home' | 'match'>('home')
const packages = ref<StoredPackage[]>(loadPackages())
const selectedPackageId = ref(packages.value[0]?.id ?? '')
const title = ref('武斗 BO3')
const roundBan = ref(true)
const joinCode = ref('')
const showJoin = ref(false)
const roomCode = ref('')
const online = ref(false)
const onlineSeat = ref<Seat>('blue')
const roomPlayers = ref({ blue: true, red: false })
const connectionLabel = ref('')
const activeTimedSeat = ref<Seat>('blue')
const exportTarget = ref<HTMLElement | null>(null)
const secondsLeft = ref(60)
const catalogLoading = ref(true)
const catalogError = ref('')
const search = ref('')
const rankFilter = ref('')
let socket: WebSocket | null = null
let timer: number | undefined
let heartbeatTimer: number | undefined
let reconnectTimer: number | undefined
let reconnectAttempt = 0
let roomConnection: RoomConnection | null = null

const selectedPackage = computed<DataPackage>(() => packages.value.find((pack) => pack.id === selectedPackageId.value) ?? builtinPackages[0])
const match = ref<MatchState>(createMatch(selectedPackage.value, title.value, roundBan.value))
const current = computed(() => match.value.current)
const phase = computed(() => current.value.phase)
const finishedRounds = computed(() => [...match.value.history, ...(match.value.history.some(round => round.number === current.value.number) ? [] : [current.value])])
const blueWins = computed(() => finishedRounds.value.filter(round => round.winner === 'blue').length)
const redWins = computed(() => finishedRounds.value.filter(round => round.winner === 'red').length)
const phaseTitle = computed(() => {
  const labels = { ban: '禁用忍者', pick: '选择忍者', scroll: '选择秘卷', summon: '选择通灵', complete: '本局 BP 完成' }
  if (phase.value.kind === 'ban' || phase.value.kind === 'pick') return `${phase.value.turn === 'blue' ? '1P' : '2P'} ${labels[phase.value.kind]}`
  return labels[phase.value.kind]
})
const phaseDetail = computed(() => {
  if (phase.value.kind === 'ban') return `第 ${phase.value.index + 1}/4 手禁用`
  if (phase.value.kind === 'pick') return `第 ${phase.value.index + 1}/6 手选择`
  if (phase.value.kind === 'scroll' || phase.value.kind === 'summon') return '双方各选 3 个，倒计时结束将自动进入下一阶段'
  return '保存本局 BP 图，记录胜者后开启下一局'
})
const currentItems = computed(() => {
  if (phase.value.kind === 'scroll') return match.value.data.scrolls
  if (phase.value.kind === 'summon') return match.value.data.summons
  return sortNinjas(match.value.data.ninjas)
})
const isTimedPhase = computed(() => phase.value.kind === 'scroll' || phase.value.kind === 'summon')
const filteredItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return currentItems.value.filter((item) => (!query || [item.name, ...(item.aliases || [])].some((name) => name.toLocaleLowerCase().includes(query)))
    && (isTimedPhase.value || !rankFilter.value || item.rank === rankFilter.value))
})
watch(() => phase.value.kind, () => { search.value = ''; rankFilter.value = '' })
const isHost = computed(() => !online.value || onlineSeat.value === 'blue')
const canActThisTurn = computed(() => !online.value || phase.value.turn === onlineSeat.value)
const timedSeat = computed<Seat>(() => online.value ? onlineSeat.value : activeTimedSeat.value)
const roleLabel = computed(() => online.value ? `你是 ${onlineSeat.value === 'blue' ? '1P（房主）' : '2P'}` : '本机双人演练')
const stages = ['ban', 'pick', 'scroll', 'summon', 'complete'] as const
const stageLabels = ['禁用忍者', '选择忍者', '选择秘卷', '选择通灵', '阵容完成']
function rosterActive(seat: Seat) {
  if (match.value.status !== 'playing') return false
  if (!isTimedPhase.value) return phase.value.turn === seat
  return (phase.value.kind === 'scroll' ? current.value.scrolls[seat] : current.value.summons[seat]).length < 3
}

onMounted(() => {
  void loadCatalog()
  timer = window.setInterval(() => {
    const deadline = phase.value.expiresAt
    if (!deadline) return
    secondsLeft.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    if (Date.now() >= deadline) {
      if (!online.value) updateMatch(expireTimedPhase(match.value))
    }
  }, 250)
  heartbeatTimer = window.setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN && online.value) socket.send(JSON.stringify({ type: 'room:ping' }))
  }, 25_000)
  const sharedCode = new URLSearchParams(window.location.search).get('room')
  if (sharedCode) {
    joinCode.value = sharedCode.toUpperCase()
    joinOnlineRoom()
  }
})

async function loadCatalog() {
  catalogLoading.value = true
  catalogError.value = ''
  try {
    const official = await loadOfficialPackages()
    const ids = new Set(official.map((pack) => pack.id))
    packages.value = [...official, ...packages.value.filter((pack) => !ids.has(pack.id))]
    if (screen.value === 'home' && official[0]) selectedPackageId.value = official[0].id
  } catch {
    catalogError.value = '官网资料包暂时无法加载，可重试或使用演示包。'
  } finally { catalogLoading.value = false }
}

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  if (heartbeatTimer) window.clearInterval(heartbeatTimer)
  if (reconnectTimer) window.clearTimeout(reconnectTimer)
  roomConnection = null
  socket?.close()
})

function loadPackages(): StoredPackage[] {
  try {
    const custom: unknown = JSON.parse(localStorage.getItem(CUSTOM_PACKAGES_KEY) ?? '[]')
    return [...builtinPackages, ...(Array.isArray(custom) ? custom.filter(validPackage).map((pack) => ({ ...pack, isCustom: true })) : [])]
  } catch {
    return [...builtinPackages]
  }
}

function saveCustomPackages() {
  localStorage.setItem(CUSTOM_PACKAGES_KEY, JSON.stringify(packages.value.filter((pack) => pack.isCustom)))
}

function createLocalMatch() {
  roomCode.value = ''
  online.value = false
  connectionLabel.value = '本机演练'
  match.value = createMatch(selectedPackage.value, title.value, roundBan.value)
  screen.value = 'match'
}

function createOnlineRoom() {
  const code = randomCode()
  const newMatch = createMatch(selectedPackage.value, title.value, roundBan.value)
  openSocket('create', code, newMatch)
}

function joinOnlineRoom() {
  const code = joinCode.value.trim().toUpperCase()
  if (!/^[A-Z0-9]{5,8}$/.test(code)) {
    connectionLabel.value = '请输入 5-8 位房间码'
    return
  }
  openSocket('join', code)
}

function openSocket(mode: 'create' | 'join', code: string, newMatch?: MatchState) {
  if (reconnectTimer) window.clearTimeout(reconnectTimer)
  const previous = socket
  socket = null
  previous?.close()
  online.value = false
  reconnectAttempt = 0
  roomConnection = { mode, code, match: newMatch, token: roomToken(code) }
  connectionLabel.value = '正在连接共享房间...'
  connectRoom()
}

function connectRoom() {
  const connection = roomConnection
  if (!connection) return
  const wsUrl = import.meta.env.VITE_WS_URL || defaultWsUrl()
  const endpoint = new URL(wsUrl)
  endpoint.searchParams.set('room', connection.code)
  endpoint.searchParams.set('mode', connection.mode)
  endpoint.searchParams.set('client', connection.token)
  let nextSocket: WebSocket
  try {
    nextSocket = new WebSocket(endpoint)
    socket = nextSocket
  } catch {
    connectionLabel.value = '无法建立连接，请检查部署服务'
    return
  }
  nextSocket.onopen = () => nextSocket.send(JSON.stringify(connection.mode === 'create'
    ? { type: 'room:create', roomCode: connection.code, match: connection.match }
    : { type: 'room:join', roomCode: connection.code }))
  nextSocket.onmessage = (event) => {
    let payload: { type: string; roomCode?: string; match?: MatchWire; data?: DataPackage; seat?: Seat; players?: { blue: boolean; red: boolean }; message?: string }
    try { payload = JSON.parse(event.data) as typeof payload } catch { return }
    if (payload.type === 'room:state' && payload.match) {
      const data = payload.data ?? payload.match.data ?? (payload.match.dataPackageId === match.value.data.id ? match.value.data : undefined)
      if (!data) {
        connectionLabel.value = '房间数据包加载失败，正在重连'
        nextSocket.close()
        return
      }
      roomCode.value = payload.roomCode ?? connection.code
      match.value = { ...payload.match, data }
      online.value = true
      onlineSeat.value = payload.seat ?? 'blue'
      activeTimedSeat.value = onlineSeat.value
      roomPlayers.value = payload.players ?? roomPlayers.value
      connectionLabel.value = '共享房间已连接'
      screen.value = 'match'
      reconnectAttempt = 0
      roomConnection = { ...connection, mode: 'join', match: undefined }
      history.replaceState({}, '', `?room=${roomCode.value}`)
    } else if (payload.type === 'room:error') {
      connectionLabel.value = payload.message ?? '房间连接失败'
    }
  }
  nextSocket.onclose = () => {
    if (socket !== nextSocket) return
    socket = null
    if (online.value && roomConnection) scheduleReconnect()
  }
  nextSocket.onerror = () => {
    if (!online.value) connectionLabel.value = '共享服务不可用，可先使用本机演练'
  }
}

function scheduleReconnect() {
  if (!roomConnection || reconnectTimer) return
  connectionLabel.value = '连接已断开，正在自动重连'
  const delay = Math.min(10_000, 1_000 * 2 ** reconnectAttempt++)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined
    connectRoom()
  }, delay)
}

function roomToken(code: string) {
  const key = `${ROOM_TOKEN_PREFIX}${code}`
  const existing = localStorage.getItem(key)
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing
  const token = crypto.randomUUID().replace(/-/g, '')
  localStorage.setItem(key, token)
  return token
}

function defaultWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const port = location.port === '5173' ? ':8787' : location.port ? `:${location.port}` : ''
  return `${protocol}//${location.hostname}${port}/ws`
}

function updateMatch(next: MatchState) {
  if (next === match.value) return
  match.value = next
}

function sendAction(action: 'start' | 'ninja' | 'timed' | 'winner' | 'next' | 'new-match' | 'swap-seats', options: { itemId?: string; winner?: Seat } = {}) {
  if (socket?.readyState !== WebSocket.OPEN || !roomCode.value) return
  socket.send(JSON.stringify({ type: 'room:action', roomCode: roomCode.value, action, ...options }))
}

function selectItem(item: GameItem) {
  if (phase.value.kind === 'ban' || phase.value.kind === 'pick') {
    if (online.value) sendAction('ninja', { itemId: item.id })
    else updateMatch(chooseNinja(match.value, item.id))
  } else if (isTimedPhase.value) {
    if (online.value) sendAction('timed', { itemId: item.id })
    else updateMatch(chooseTimedItem(match.value, item.id, activeTimedSeat.value))
  }
}

function itemSelected(item: GameItem): 'banned' | 'blue' | 'red' | 'both' | 'past' | '' {
  if (current.value.bans.blue.includes(item.id) || current.value.bans.red.includes(item.id)) return 'banned'
  if (phase.value.kind === 'scroll' || phase.value.kind === 'summon') {
    const selected = phase.value.kind === 'scroll' ? current.value.scrolls : current.value.summons
    const blue = selected.blue.includes(item.id)
    const red = selected.red.includes(item.id)
    if (blue && red) return 'both'
    if (blue) return 'blue'
    if (red) return 'red'
    const prior = match.value.history.flatMap((round) => phase.value.kind === 'scroll' ? round.scrolls[timedSeat.value] : round.summons[timedSeat.value])
    if (prior.includes(item.id)) return 'past'
  }
  if (current.value.picks.blue.includes(item.id)) return 'blue'
  if (current.value.picks.red.includes(item.id)) return 'red'
  if (match.value.history.some((round) => round.picks.blue.includes(item.id) || round.picks.red.includes(item.id))) return 'past'
  return ''
}

function selectable(item: GameItem) {
  if (phase.value.kind === 'ban' || phase.value.kind === 'pick') return canActThisTurn.value && canSelectNinja(match.value, item.id)
  if (phase.value.kind === 'scroll' || phase.value.kind === 'summon') return (phase.value.kind === 'scroll' ? current.value.scrolls[timedSeat.value] : current.value.summons[timedSeat.value]).length < 3 && canSelectTimedItem(match.value, item.id, timedSeat.value)
  return false
}

function handleImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const value = JSON.parse(String(reader.result)) as unknown
      if (!validPackage(value)) throw new Error('invalid')
      const imported: StoredPackage = { ...value, isCustom: true }
      packages.value = [...packages.value.filter((pack) => pack.id !== imported.id), imported]
      selectedPackageId.value = imported.id
      saveCustomPackages()
    } catch {
      window.alert('数据包格式不正确。BO3 数据包至少需要 22 名忍者、9 个秘卷和 9 个通灵；请使用 README 中约定的 JSON 结构。')
    } finally {
      input.value = ''
    }
  }
  reader.readAsText(file, 'utf-8')
}

async function copyShareLink() {
  if (!roomCode.value) return
  await navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${roomCode.value}`)
  connectionLabel.value = '邀请链接已复制'
}

async function exportImage() {
  if (!exportTarget.value) return
  await Promise.all(Array.from(exportTarget.value.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)))
  const canvas = await html2canvas(exportTarget.value, { backgroundColor: '#f6f8f8', scale: 2, useCORS: true })
  const link = document.createElement('a')
  link.download = `${match.value.settings.title}-第${current.value.number}局BP.png`
  link.href = canvas.toDataURL('image/png')
  link.click()
}

function backHome() {
  roomConnection = null
  if (reconnectTimer) window.clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  const previous = socket
  socket = null
  previous?.close()
  online.value = false
  history.replaceState({}, '', location.pathname)
  screen.value = 'home'
}

function restart() {
  if (online.value) sendAction('new-match')
  else updateMatch(resetMatch(match.value))
}

function beginMatch() {
  if (online.value) sendAction('start')
  else updateMatch(startMatch(match.value))
}

function selectWinner(winner: Seat) {
  if (online.value) sendAction('winner', { winner })
  else updateMatch(recordWinner(match.value, winner))
}

function nextRound() {
  if (online.value) sendAction('next')
  else updateMatch(startNextRound(match.value))
}

function swapSeats() {
  if (online.value) sendAction('swap-seats')
  else activeTimedSeat.value = activeTimedSeat.value === 'blue' ? 'red' : 'blue'
}

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

</script>

<template>
  <main class="app-shell" :class="{ battle: screen === 'match' }">
    <section v-if="screen === 'home'" class="home-screen">
      <header class="brand-row">
        <div class="brand-mark"><Swords :size="22" /></div>
        <div>
          <p class="eyebrow">NON-OFFICIAL PRACTICE TOOL</p>
          <h1>武斗 BP 练习室</h1>
        </div>
      </header>

      <div class="setup-grid">
        <label class="field-label">对局名称
          <input v-model="title" class="text-input" maxlength="20" placeholder="例如：周末训练" />
        </label>

        <label class="field-label">数据包
          <select v-model="selectedPackageId" class="select-input">
            <option v-for="pack in packages" :key="pack.id" :value="pack.id">{{ pack.name }} · {{ pack.updatedAt }}</option>
          </select>
        </label>
        <p class="data-note">{{ selectedPackage.source || '玩家导入数据' }} · {{ selectedPackage.ninjas.length }} 忍者 / {{ selectedPackage.scrolls.length }} 秘卷 / {{ selectedPackage.summons.length }} 通灵</p>
        <p v-if="catalogLoading" class="data-note" role="status">资料包加载中…</p>
        <p v-if="catalogError" class="data-note" role="alert">{{ catalogError }} <button class="text-command" @click="loadCatalog">重试</button></p>

        <label class="import-control" title="导入忍者、秘卷、通灵 JSON 数据包">
          <CloudUpload :size="19" />
          <span>导入数据包</span>
          <input type="file" accept="application/json,.json" @change="handleImport" />
        </label>
      </div>

      <section class="mode-panel">
        <div>
          <h2>小局 Ban</h2>
          <p>默认开启。每一小局重新进行 4 手禁用；关闭后仅第一局禁用，后续沿用首局禁用名单。</p>
        </div>
        <button class="switch" :class="{ on: roundBan }" type="button" role="switch" :aria-checked="roundBan" @click="roundBan = !roundBan">
          <span></span>
        </button>
      </section>

      <div class="home-actions">
        <button class="button primary" type="button" :disabled="catalogLoading" @click="createLocalMatch"><Swords :size="19" />本机演练</button>
        <button class="button secondary" type="button" :disabled="catalogLoading" @click="createOnlineRoom"><Users :size="19" />创建共享房间</button>
      </div>

      <section class="join-panel">
        <button class="text-command" type="button" @click="showJoin = !showJoin"><Link :size="17" />{{ showJoin ? '收起加入房间' : '通过房间码加入' }}</button>
        <div v-if="showJoin" class="join-row">
          <input v-model="joinCode" class="text-input room-input" maxlength="8" placeholder="输入房间码" @keyup.enter="joinOnlineRoom" />
          <button class="icon-command" type="button" title="加入共享房间" @click="joinOnlineRoom"><ChevronLeft :size="19" class="turn-right" /></button>
        </div>
        <p v-if="connectionLabel" class="connection-note">{{ connectionLabel }}</p>
      </section>

      <footer>规则流程：1P 禁 1 · 2P 禁 2 · 1P 禁 1 · 1P 选 1 · 2P 选 2 · 1P 选 2 · 2P 选 1</footer>
    </section>

    <section v-else class="match-screen">
      <header class="match-header">
        <button class="icon-command" type="button" title="返回首页" @click="backHome"><ChevronLeft :size="21" /></button>
        <div class="match-title"><span>BO3 · 第 {{ current.number }} 局</span><strong>武斗赛 · {{ match.settings.title }}</strong></div>
        <button v-if="match.status === 'match-complete' && isHost" class="icon-command" type="button" title="进入下一场准备阶段" @click="restart"><RotateCcw :size="19" /></button>
        <span v-else></span>
      </header>

      <div v-if="online" class="share-strip">
        <span>房间 {{ roomCode }}</span>
        <em>{{ roleLabel }}</em>
        <button type="button" @click="copyShareLink"><Copy :size="15" />复制邀请链接</button>
        <small>{{ connectionLabel }}</small>
      </div>

      <section v-if="match.status === 'setup'" class="ready-panel">
        <span class="ready-state" :class="{ joined: !online || roomPlayers.red }">{{ online ? roomPlayers.red ? '2P 已加入' : '等待 2P 加入' : '本机双方就绪' }}</span>
        <strong>{{ roleLabel }}</strong>
        <p>确认数据包与小局 Ban 规则后开始本场 BO3。完成 BO3 后会回到此处，可由 1P 交换双方席位。</p>
        <div v-if="isHost" class="ready-actions">
          <button class="button primary" type="button" :disabled="online && !roomPlayers.red" @click="beginMatch"><Swords :size="18" />开始 BP</button>
          <button class="button secondary" type="button" :disabled="online && !roomPlayers.red" @click="swapSeats"><Users :size="18" />交换 1P / 2P</button>
        </div>
        <p v-else class="waiting-copy">等待 1P 开始本场 BP。</p>
      </section>

      <section v-else class="scoreboard">
        <div class="player blue"><span>1P</span><strong>{{ blueWins }}</strong><div class="win-marks"><i v-for="n in 2" :key="n" :class="{ won: blueWins >= n }"></i></div></div>
        <div class="stage-status">
          <span class="phase-dot" :class="phase.kind"></span>
          <strong>{{ phaseTitle }}</strong>
          <small>{{ phaseDetail }}</small>
        </div>
        <div class="player red"><div class="win-marks"><i v-for="n in 2" :key="n" :class="{ won: redWins >= n }"></i></div><strong>{{ redWins }}</strong><span>2P</span></div>
      </section>

      <nav v-if="match.status !== 'setup'" class="phase-track" aria-label="BP进度">
        <span v-for="(stage, index) in stages" :key="stage" :class="{ current: phase.kind === stage, done: stages.indexOf(phase.kind) > index }" :aria-current="phase.kind === stage ? 'step' : undefined"><i>{{ index + 1 }}</i>{{ stageLabels[index] }}</span>
      </nav>

      <div v-if="match.status === 'playing'" class="draft-layout">
        <DraftRoster seat="blue" :round="current" :data="match.data" :active="rosterActive('blue')" :mine="!online || onlineSeat === 'blue'" />
        <DraftRoster seat="red" :round="current" :data="match.data" :active="rosterActive('red')" :mine="online && onlineSeat === 'red'" />
        <div class="draft-center">
      <section v-if="match.status === 'playing' && isTimedPhase" class="timed-bar">
        <div class="timer"><span>{{ secondsLeft }}</span> 秒</div>
        <div v-if="!online" class="seat-tabs" aria-label="当前操作方">
          <button type="button" :class="{ active: activeTimedSeat === 'blue', done: (phase.kind === 'scroll' ? current.scrolls.blue : current.summons.blue).length === 3 }" @click="activeTimedSeat = 'blue'">1P {{ (phase.kind === 'scroll' ? current.scrolls.blue : current.summons.blue).length }}/3</button>
          <button type="button" :class="{ active: activeTimedSeat === 'red', done: (phase.kind === 'scroll' ? current.scrolls.red : current.summons.red).length === 3 }" @click="activeTimedSeat = 'red'">2P {{ (phase.kind === 'scroll' ? current.scrolls.red : current.summons.red).length }}/3</button>
        </div>
        <div v-else class="timed-progress">
          <span>1P {{ (phase.kind === 'scroll' ? current.scrolls.blue : current.summons.blue).length }}/3</span>
          <span>2P {{ (phase.kind === 'scroll' ? current.scrolls.red : current.summons.red).length }}/3</span>
        </div>
      </section>

      <div v-if="match.status === 'playing'" class="catalog-toolbar">
        <input v-model="search" class="text-input" type="search" placeholder="搜索名称 / 别名" aria-label="搜索名称或别名" />
        <select v-if="!isTimedPhase" v-model="rankFilter" class="select-input" aria-label="忍者评级">
          <option value="">全部评级</option><option v-for="rank in ['S', 'A', 'B', 'C']" :key="rank">{{ rank }}</option>
        </select>
        <span>{{ filteredItems.length }} 项</span>
      </div>
      <section v-if="match.status === 'playing' && phase.kind !== 'complete'" class="item-grid" :class="{ compact: isTimedPhase }">
        <button v-for="item in filteredItems" :key="item.id" class="item-tile" :class="itemSelected(item)" :data-rank="item.rank" :title="item.name" type="button" :disabled="!selectable(item)" @click="selectItem(item)">
          <ItemPortrait :item="item" />
          <span v-if="item.rank" class="rank">{{ item.rank }}</span>
          <strong>{{ item.name }}</strong>
          <span v-if="itemSelected(item) === 'banned'" class="tile-state">已禁</span>
          <span v-else-if="itemSelected(item)" class="tile-state">{{ itemSelected(item) === 'both' ? '双方' : itemSelected(item) === 'past' ? '已用' : itemSelected(item) === 'blue' ? '1P' : '2P' }}</span>
        </button>
      </section>
      <p v-if="match.status === 'playing' && !filteredItems.length" class="data-note">没有匹配的项目</p>
        </div>
      </div>

      <section v-if="match.status !== 'setup' && phase.kind === 'complete'" ref="exportTarget" class="result-board">
        <div class="result-heading"><span>第 {{ current.number }} 局完整阵容</span><strong>{{ match.settings.title }}</strong></div>
        <div class="result-columns">
          <div class="result-side blue"><h2>1P</h2><ResultList title="禁用" :items="current.bans.blue" :source="match.data.ninjas" /><ResultList title="忍者" :items="current.picks.blue" :source="match.data.ninjas" /><ResultList title="秘卷" :items="current.scrolls.blue" :source="match.data.scrolls" /><ResultList title="通灵" :items="current.summons.blue" :source="match.data.summons" /></div>
          <div class="result-side red"><h2>2P</h2><ResultList title="禁用" :items="current.bans.red" :source="match.data.ninjas" /><ResultList title="忍者" :items="current.picks.red" :source="match.data.ninjas" /><ResultList title="秘卷" :items="current.scrolls.red" :source="match.data.scrolls" /><ResultList title="通灵" :items="current.summons.red" :source="match.data.summons" /></div>
        </div>
      </section>

      <section v-if="match.status === 'round-complete'" class="round-actions">
        <button class="button secondary" type="button" @click="exportImage"><Download :size="18" />保存 BP 图</button>
        <template v-if="!current.winner && isHost">
          <span>游戏结束后记录本局胜者</span>
          <button class="winner blue-button" type="button" @click="selectWinner('blue')"><Check :size="17" />1P 获胜</button>
          <button class="winner red-button" type="button" @click="selectWinner('red')"><Check :size="17" />2P 获胜</button>
        </template>
        <button v-if="current.winner && isHost" class="button primary" type="button" @click="nextRound">{{ blueWins === 2 || redWins === 2 || current.number === 3 ? '完成 BO3' : '开启第 ' + (current.number + 1) + ' 局' }}<Plus :size="18" /></button>
      </section>

      <section v-if="match.status === 'match-complete'" class="completed-banner">
        <strong>BO3 完成 · {{ blueWins > redWins ? '1P' : '2P' }} 获胜</strong>
        <button v-if="isHost" class="button primary" type="button" @click="restart">下一场准备</button>
      </section>
    </section>
  </main>
</template>
