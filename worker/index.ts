import {
  chooseNinja,
  chooseTimedItem,
  createMatch,
  expireTimedPhase,
  recordWinner,
  resetMatch,
  startMatch,
  startNextRound,
} from '../src/bp'
import type { DataPackage, MatchState, Seat } from '../src/types'

const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
const MAX_CREATE_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_ACTION_MESSAGE_BYTES = 16 * 1024

interface Env {
  ASSETS: Fetcher
  ROOMS: DurableObjectNamespace
}

type MatchCore = Omit<MatchState, 'data'> & { dataPackageId: string }

interface RoomMeta {
  match: MatchCore
  seats: Partial<Record<Seat, string>>
  createdAt: number
  lastActiveAt: number
}

interface SocketAttachment {
  token: string
}

interface RoomActionMessage {
  type: 'room:action'
  action?: 'start' | 'ninja' | 'timed' | 'winner' | 'next' | 'new-match' | 'swap-seats'
  itemId?: string
  winner?: Seat
}

interface RoomCreateMessage {
  type: 'room:create'
  match?: MatchState
}

interface LegacyJoinMessage {
  type: 'room:join'
}

interface PingMessage {
  type: 'room:ping'
}

type ClientMessage = RoomActionMessage | RoomCreateMessage | LegacyJoinMessage | PingMessage

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'budou-bp-cloudflare' })
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 })
      }

      const roomCode = url.searchParams.get('room')?.toUpperCase() ?? ''
      const token = url.searchParams.get('client') ?? ''
      const mode = url.searchParams.get('mode')
      if (!/^[A-Z0-9]{5,8}$/.test(roomCode)) return new Response('Invalid room code', { status: 400 })
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return new Response('Invalid client token', { status: 400 })
      if (mode !== 'create' && mode !== 'join') return new Response('Invalid room mode', { status: 400 })

      const id = env.ROOMS.idFromName(roomCode)
      return env.ROOMS.get(id).fetch(request)
    }

    return env.ASSETS.fetch(request)
  },
}

export class Room {
  private meta: RoomMeta | null = null
  private data: DataPackage | null = null

  constructor(private readonly state: DurableObjectState, _env: Env) {
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get(['meta', 'data'])
      this.meta = (stored.get('meta') as RoomMeta | undefined) ?? null
      this.data = (stored.get('data') as DataPackage | undefined) ?? null
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }

    const url = new URL(request.url)
    const token = url.searchParams.get('client') ?? ''
    const mode = url.searchParams.get('mode')
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    if (this.meta) {
      const existingSeat = seatForToken(this.meta, token)
      if (!existingSeat) {
        if (mode === 'create') return new Response('Room already exists', { status: 409 })
        if (this.meta.seats.red) return new Response('Room is full', { status: 409 })
        this.meta.seats.red = token
        this.meta.lastActiveAt = Date.now()
        await this.persistMeta()
      } else {
        this.meta.lastActiveAt = Date.now()
        await this.persistMeta()
      }
    } else if (mode === 'join') {
      return new Response('Room not found', { status: 404 })
    }

    server.serializeAttachment({ token } satisfies SocketAttachment)
    this.state.acceptWebSocket(server)
    this.state.waitUntil(this.afterConnect(server))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
    if (byteLength(raw) > MAX_CREATE_MESSAGE_BYTES) return this.sendError(socket, '消息过大')

    const parsed = parseMessage(raw)
    if (!parsed) return this.sendError(socket, '消息格式不正确')

    const token = attachmentToken(socket)
    if (!token) return this.closeSocket(socket, 1008, 'Missing client identity')

    if (parsed.type === 'room:create') {
      await this.createRoom(socket, token, parsed.match)
      return
    }
    if (parsed.type === 'room:join') return
    if (parsed.type === 'room:ping') {
      this.send(socket, { type: 'room:pong' })
      return
    }

    if (byteLength(raw) > MAX_ACTION_MESSAGE_BYTES) return this.sendError(socket, '操作消息过大')
    await this.applyAction(socket, token, parsed)
  }

  webSocketClose(): void {
    // Seats remain reserved so a phone can reconnect after locking the screen or changing apps.
  }

  webSocketError(): void {
    // Hibernatable sockets are cleaned up by the runtime; room state remains in storage.
  }

  async alarm(): Promise<void> {
    if (!this.meta || !this.data) return
    const now = Date.now()
    if (now >= this.meta.lastActiveAt + ROOM_LIFETIME_MS) {
      for (const socket of this.state.getWebSockets()) this.closeSocket(socket, 1001, 'Room expired')
      await this.state.storage.deleteAll()
      this.meta = null
      this.data = null
      return
    }

    const match = inflateMatch(this.meta.match, this.data)
    if (match.current.phase.expiresAt && now >= match.current.phase.expiresAt) {
      const next = expireTimedPhase(match)
      if (next !== match) {
        this.meta.match = compactMatch(next)
        await this.persistMeta()
        this.broadcastState()
      }
    }
    await this.scheduleAlarm()
  }

  private async afterConnect(socket: WebSocket): Promise<void> {
    if (!this.meta) {
      this.send(socket, { type: 'room:ready' })
      return
    }
    this.sendState(socket, true)
    this.broadcastPresence(socket)
    await this.scheduleAlarm()
  }

  private async createRoom(socket: WebSocket, token: string, candidate?: MatchState): Promise<void> {
    if (this.meta) {
      if (this.meta.seats.blue === token) this.sendState(socket, true)
      else this.sendError(socket, '房间码已存在，请重试')
      return
    }
    if (!candidate || !validDataPackage(candidate.data)) {
      this.sendError(socket, '数据包格式无效')
      return
    }

    const title = typeof candidate.settings?.title === 'string' ? candidate.settings.title.slice(0, 40) : 'BO3 对局'
    const roundBan = candidate.settings?.roundBan !== false
    const cleanMatch = createMatch(candidate.data, title, roundBan)
    const now = Date.now()
    this.data = candidate.data
    this.meta = {
      match: compactMatch(cleanMatch),
      seats: { blue: token },
      createdAt: now,
      lastActiveAt: now,
    }
    await this.state.storage.put({ meta: this.meta, data: this.data })
    await this.scheduleAlarm()
    this.sendState(socket, true)
  }

  private async applyAction(socket: WebSocket, token: string, message: RoomActionMessage): Promise<void> {
    if (!this.meta || !this.data) return this.sendError(socket, '房间尚未创建')
    const seat = seatForToken(this.meta, token)
    if (!seat) return this.sendError(socket, '你不是该房间的玩家')
    if ((message.action === 'start' || message.action === 'swap-seats') && !hasTwoPlayers(this.meta)) {
      return this.sendError(socket, '需要 1P 和 2P 均加入后才能进行此操作')
    }

    const current = inflateMatch(this.meta.match, this.data)
    const next = applyRoomAction(current, message, seat)
    if (!next) return this.sendError(socket, '当前操作不符合房间规则')

    this.meta.match = compactMatch(next)
    this.meta.lastActiveAt = Date.now()
    if (message.action === 'swap-seats') {
      const blue = this.meta.seats.blue
      this.meta.seats.blue = this.meta.seats.red
      this.meta.seats.red = blue
    }
    await this.persistMeta()
    await this.scheduleAlarm()
    this.broadcastState()
  }

  private sendState(socket: WebSocket, includeData = false): void {
    if (!this.meta) return
    const token = attachmentToken(socket)
    const seat = token ? seatForToken(this.meta, token) : undefined
    if (!seat) return
    this.send(socket, {
      type: 'room:state',
      match: this.meta.match,
      ...(includeData && this.data ? { data: this.data } : {}),
      seat,
      players: playerPresence(this.meta),
    })
  }

  private broadcastState(): void {
    for (const socket of this.state.getWebSockets()) this.sendState(socket)
  }

  private broadcastPresence(except?: WebSocket): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket !== except) this.sendState(socket)
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      this.closeSocket(socket, 1011, 'Send failed')
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, { type: 'room:error', message })
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    try { socket.close(code, reason) } catch { /* Already closed. */ }
  }

  private async persistMeta(): Promise<void> {
    if (this.meta) await this.state.storage.put('meta', this.meta)
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.meta) return
    const phaseDeadline = this.meta.match.current.phase.expiresAt
    const roomDeadline = this.meta.lastActiveAt + ROOM_LIFETIME_MS
    await this.state.storage.setAlarm(phaseDeadline ? Math.min(phaseDeadline, roomDeadline) : roomDeadline)
  }
}

function applyRoomAction(match: MatchState, message: RoomActionMessage, seat: Seat): MatchState | undefined {
  const isHost = seat === 'blue'
  switch (message.action) {
    case 'start':
      return isHost && match.status === 'setup' ? startMatch(match) : undefined
    case 'ninja':
      if (match.status !== 'playing' || match.current.phase.turn !== seat || !message.itemId) return undefined
      if (!match.data.ninjas.some((item) => item.id === message.itemId)) return undefined
      return changed(match, chooseNinja(match, message.itemId))
    case 'timed': {
      if (match.status !== 'playing' || !message.itemId) return undefined
      const pool = match.current.phase.kind === 'scroll' ? match.data.scrolls
        : match.current.phase.kind === 'summon' ? match.data.summons : undefined
      if (!pool?.some((item) => item.id === message.itemId)) return undefined
      return changed(match, chooseTimedItem(match, message.itemId, seat))
    }
    case 'winner':
      return isHost && (message.winner === 'blue' || message.winner === 'red')
        ? changed(match, recordWinner(match, message.winner)) : undefined
    case 'next':
      return isHost ? changed(match, startNextRound(match)) : undefined
    case 'new-match':
      return isHost && match.status === 'match-complete' ? resetMatch(match) : undefined
    case 'swap-seats':
      return isHost && match.status === 'setup' ? match : undefined
    default:
      return undefined
  }
}

function compactMatch(match: MatchState): MatchCore {
  const { data, ...state } = match
  return { ...state, dataPackageId: data.id }
}

function inflateMatch(match: MatchCore, data: DataPackage): MatchState {
  const { dataPackageId: _dataPackageId, ...state } = match
  return { ...state, data }
}

function changed(match: MatchState, next: MatchState): MatchState | undefined {
  return next === match ? undefined : next
}

function seatForToken(meta: RoomMeta, token: string): Seat | undefined {
  if (meta.seats.blue === token) return 'blue'
  if (meta.seats.red === token) return 'red'
  return undefined
}

function hasTwoPlayers(meta: RoomMeta): boolean {
  return Boolean(meta.seats.blue && meta.seats.red)
}

function playerPresence(meta: RoomMeta): Record<Seat, boolean> {
  return { blue: Boolean(meta.seats.blue), red: Boolean(meta.seats.red) }
}

function attachmentToken(socket: WebSocket): string | undefined {
  const attachment = socket.deserializeAttachment() as SocketAttachment | null
  return attachment?.token
}

function parseMessage(raw: string): ClientMessage | undefined {
  try {
    const value = JSON.parse(raw) as { type?: unknown }
    if (value?.type !== 'room:create' && value?.type !== 'room:join' && value?.type !== 'room:action' && value?.type !== 'room:ping') return undefined
    return value as ClientMessage
  } catch {
    return undefined
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function validDataPackage(value: unknown): value is DataPackage {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<DataPackage>
  if (typeof data.id !== 'string' || !data.id || data.id.length > 100) return false
  if (typeof data.name !== 'string' || !data.name || data.name.length > 100) return false
  if (typeof data.updatedAt !== 'string' || data.updatedAt.length > 40) return false
  if (!Array.isArray(data.ninjas) || data.ninjas.length < 22 || data.ninjas.length > 1000) return false
  if (!Array.isArray(data.scrolls) || data.scrolls.length < 9 || data.scrolls.length > 200) return false
  if (!Array.isArray(data.summons) || data.summons.length < 9 || data.summons.length > 200) return false
  return [data.ninjas, data.scrolls, data.summons].every((items) => {
    const ids = new Set<string>()
    return items.every((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 100) return false
      if (typeof item.name !== 'string' || !item.name || item.name.length > 100 || ids.has(item.id)) return false
      ids.add(item.id)
      return Array.isArray(item.tags) && item.tags.length <= 30 && item.tags.every((tag) => typeof tag === 'string' && tag.length <= 50)
    })
  })
}
