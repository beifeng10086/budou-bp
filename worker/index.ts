import {
  createMatch,
  expireTimedPhase,
  renamePlayer,
} from '../src/bp'
import { applyRoomAction as applySharedAction, type RoomAction } from '../src/room-actions'
import type { DataPackage, MatchState, Seat } from '../src/types'
import { isQuotaFailure } from '../src/quota'
import { quotaResponse, updateQuota, type QuotaEnv } from './quota'

const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
const MAX_CREATE_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_ACTION_MESSAGE_BYTES = 16 * 1024

interface Env extends QuotaEnv {
  ASSETS: Fetcher
  ROOMS: DurableObjectNamespace
}

type MatchCore = Omit<MatchState, 'data'> & { dataPackageId: string }

interface RoomMeta {
  match: MatchCore
  seats: Partial<Record<Seat, string>>
  createdAt: number
  lastActiveAt: number
  revision?: number
}

interface SocketAttachment {
  token: string
}

interface RoomActionMessage {
  type: 'room:action'
  action?: RoomAction
  name?: string
  itemId?: string
  itemIds?: string[]
  round?: number
  phase?: 'scroll' | 'summon'
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
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(updateQuota(env).catch(() => { console.warn('Quota analytics refresh failed') }))
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/quota') return quotaResponse(request, env, ctx)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'wudou-bp-cloudflare' })
    }

    if (url.pathname === '/ws' || url.pathname === '/room') {
      if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 })
      }

      const roomCode = url.searchParams.get('room')?.toUpperCase() ?? ''
      const token = url.searchParams.get('client') ?? ''
      const mode = url.searchParams.get('mode')
      if (!/^[A-Z0-9]{5,8}$/.test(roomCode)) return new Response('Invalid room code', { status: 400 })
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return new Response('Invalid client token', { status: 400 })
      if (mode !== 'create' && mode !== 'join') return new Response('Invalid room mode', { status: 400 })

      const id = env.ROOMS.idFromName(roomCode)
      try { return await env.ROOMS.get(id).fetch(request) } catch (error) {
        if (isQuotaFailure(503, String(error))) return Response.json({ type: 'room:error', code: 'QUOTA_EXHAUSTED', message: '今日共享服务额度已用尽，请使用本机演练' }, { status: 503 })
        throw error
      }
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
    if (new URL(request.url).pathname === '/room') return this.fetchHttp(request)
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
        this.setJoinName(url.searchParams.get('name'))
        this.meta.revision = (this.meta.revision ?? 0) + 1
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

  private async fetchHttp(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const token = url.searchParams.get('client') ?? ''
    const error = (message: string, status: number) => Response.json(
      { type: 'room:error', message }, { status, headers: { 'Cache-Control': 'no-store' } },
    )
    if (request.method !== 'GET' && request.method !== 'POST') return error('不支持的请求方式', 405)

    let message: ClientMessage | undefined
    if (request.method === 'POST') {
      const raw = await readLimitedBody(request, MAX_CREATE_MESSAGE_BYTES)
      if (raw === undefined) return error('消息过大', 413)
      message = parseMessage(raw)
      if (!message) return error('消息格式不正确', 400)
      if (message.type !== 'room:create' && byteLength(raw) > MAX_ACTION_MESSAGE_BYTES) return error('操作消息过大', 413)
    }

    let includeData = url.searchParams.get('data') === '1'
    if (!this.meta) {
      if (url.searchParams.get('mode') !== 'create' || message?.type !== 'room:create') {
        return error('未找到该房间，可能已经过期', 404)
      }
      const problem = await this.initializeRoom(token, message.match)
      if (problem) return error(problem, 400)
      includeData = true
    } else if (!seatForToken(this.meta, token)) {
      if (url.searchParams.get('mode') === 'create') return error('房间码已存在，请重新创建', 409)
      if (this.meta.seats.red) return error('房间已满，只允许两名玩家', 409)
      this.meta.seats.red = token
      this.setJoinName(url.searchParams.get('name'))
      this.meta.lastActiveAt = Date.now()
      this.meta.revision = (this.meta.revision ?? 0) + 1
      await this.persistMeta()
      await this.scheduleAlarm()
      this.broadcastState()
      includeData = true
    }

    if (message?.type === 'room:action') {
      const problem = await this.updateRoom(token, message)
      if (problem) return error(problem, 403)
    }
    return Response.json(this.statePayload(token, includeData), { headers: { 'Cache-Control': 'no-store' } })
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
        this.meta.revision = (this.meta.revision ?? 0) + 1
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
    const problem = await this.initializeRoom(token, candidate)
    if (problem) return this.sendError(socket, problem)
    this.sendState(socket, true)
  }

  private async initializeRoom(token: string, candidate?: MatchState): Promise<string | undefined> {
    if (!candidate || !validDataPackage(candidate.data)) return '数据包格式无效'
    const title = typeof candidate.settings?.title === 'string' ? candidate.settings.title.slice(0, 40) : 'BO3 对局'
    const roundBan = candidate.settings?.roundBan !== false
    const cleanMatch = createMatch(candidate.data, title, roundBan, candidate.settings)
    const now = Date.now()
    this.data = candidate.data
    this.meta = {
      match: compactMatch(cleanMatch),
      seats: { blue: token },
      createdAt: now,
      lastActiveAt: now,
      revision: 1,
    }
    await this.state.storage.put({ meta: this.meta, data: this.data })
    await this.scheduleAlarm()
  }

  private async applyAction(socket: WebSocket, token: string, message: RoomActionMessage): Promise<void> {
    const problem = await this.updateRoom(token, message)
    if (problem) this.sendError(socket, problem)
  }

  private async updateRoom(token: string, message: RoomActionMessage): Promise<string | undefined> {
    if (!this.meta || !this.data) return '房间尚未创建'
    const seat = seatForToken(this.meta, token)
    if (!seat) return '你不是该房间的玩家'
    if ((message.action === 'start' || message.action === 'swap-seats') && !hasTwoPlayers(this.meta)) {
      return '需要 1P 和 2P 均加入后才能进行此操作'
    }

    const current = inflateMatch(this.meta.match, this.data)
    const next = applyRoomAction(current, message, seat)
    if (!next) return '当前操作不符合房间规则'

    this.meta.match = compactMatch(next)
    this.meta.lastActiveAt = Date.now()
    this.meta.revision = (this.meta.revision ?? 0) + 1
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
    const token = attachmentToken(socket)
    const payload = token ? this.statePayload(token, includeData) : undefined
    if (payload) this.send(socket, payload)
  }

  private statePayload(token: string, includeData: boolean) {
    if (!this.meta) return undefined
    const seat = seatForToken(this.meta, token)
    if (!seat) return undefined
    return {
      type: 'room:state',
      serverTime: Date.now(),
      revision: this.meta.revision ?? 0,
      match: this.meta.match,
      ...(includeData && this.data ? { data: this.data } : {}),
      seat,
      players: playerPresence(this.meta),
    }
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

  private setJoinName(name: string | null): void {
    if (this.meta && this.data) this.meta.match = compactMatch(renamePlayer(inflateMatch(this.meta.match, this.data), 'red', name))
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.meta) return
    const phaseDeadline = this.meta.match.current.phase.expiresAt
    const roomDeadline = this.meta.lastActiveAt + ROOM_LIFETIME_MS
    await this.state.storage.setAlarm(phaseDeadline ? Math.min(phaseDeadline, roomDeadline) : roomDeadline)
  }
}

function applyRoomAction(match: MatchState, message: RoomActionMessage, seat: Seat): MatchState | undefined {
  return applySharedAction(match, message, seat)
}

function compactMatch(match: MatchState): MatchCore {
  const { data, ...state } = match
  return { ...state, dataPackageId: data.id }
}

function inflateMatch(match: MatchCore, data: DataPackage): MatchState {
  const { dataPackageId: _dataPackageId, ...state } = match
  return { ...state, data }
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

async function readLimitedBody(request: Request, limit: number): Promise<string | undefined> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return undefined
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally { reader.releaseLock() }
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
