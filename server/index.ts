import express from 'express'
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createMatch, expireTimedPhase, renamePlayer,
} from '../src/bp.ts'
import { applyRoomAction, type RoomAction } from '../src/room-actions.ts'
import type { DataPackage, MatchState, RoomRole, Seat } from '../src/types.ts'
import { availableSeat, creatorSeats, roleForToken, type RoomSeats } from '../src/room-members.ts'

const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
const MAX_CREATE_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_ACTION_MESSAGE_BYTES = 16 * 1024

type ClientInfo = { seat: RoomRole; token: string }
type Room = {
  match: MatchState
  clients: Map<WebSocket, ClientInfo>
  seats: RoomSeats
  lastActiveAt: number
  revision?: number
  timer?: ReturnType<typeof setTimeout>
}

type RoomMessage = {
  type: 'room:create' | 'room:join' | 'room:action' | 'room:ping'
  roomCode?: string
  match?: MatchState
  action?: RoomAction
  name?: string
  itemId?: string
  itemIds?: string[]
  round?: number
  phase?: 'scroll' | 'summon'
  winner?: Seat
}

type ConnectionInfo = { roomCode: string; mode: 'create' | 'join'; token: string; name: string | null; requestedSeat: string | null }

const port = Number(process.env.PORT ?? 8787)
const rooms = new Map<string, Room>()
const currentDir = dirname(fileURLToPath(import.meta.url))
const app = express()

app.get('/health', (_request, response) => response.json({ ok: true, service: 'wudou-bp-node', rooms: rooms.size }))
app.use('/room', express.text({ type: 'application/json', limit: MAX_CREATE_MESSAGE_BYTES }))
app.all('/room', (request, response) => {
  response.set('Cache-Control', 'no-store')
  const error = (message: string, status: number) => response.status(status).json({ type: 'room:error', message })
  const info = connectionInfo(request, '/room')
  if (!info) return error('房间连接参数无效', 400)
  if (request.method !== 'GET' && request.method !== 'POST') return error('不支持的请求方式', 405)
  const message = request.method === 'POST' && typeof request.body === 'string' ? parseMessage(request.body) : undefined
  if (request.method === 'POST' && !message) return error('消息格式不正确', 400)
  if (message && message.type !== 'room:create' && Buffer.byteLength(request.body) > MAX_ACTION_MESSAGE_BYTES) return error('操作消息过大', 413)
  let room = rooms.get(info.roomCode)
  let includeData = request.query.data === '1'
  if (!room) {
    if (info.mode !== 'create' || message?.type !== 'room:create') return error('未找到该房间，可能已经过期', 404)
    if (!message.match || !validMatch(message.match)) return error('数据包格式无效', 400)
    room = {
      match: sanitizeNewMatch(message.match), clients: new Map(), seats: creatorSeats(message.match.settings.thirdPartyHost === true, info.token), lastActiveAt: Date.now(), revision: 1,
    }
    rooms.set(info.roomCode, room)
    includeData = true
  } else if (!seatForToken(room, info.token)) {
    if (info.mode === 'create') return error('房间码已存在，请重新创建', 409)
    const seat = availableSeat(room.seats, info.requestedSeat)
    if (!seat) return error('所选席位已有人或房间已满', 409)
    room.seats[seat] = info.token
    room.match = renamePlayer(room.match, seat, info.name)
    room.lastActiveAt = Date.now()
    room.revision = (room.revision ?? 0) + 1
    broadcastState(info.roomCode, room)
    includeData = true
  }
  const seat = seatForToken(room, info.token)!
  if (message?.type === 'room:action') {
    if ((message.action === 'start' || message.action === 'swap-seats') && !hasTwoPlayers(room)) return error('需要 1P 和 2P 均加入后才能进行此操作', 403)
    const next = applyRoomAction(room.match, message, seat)
    if (!next) return error('当前操作不符合房间规则', 403)
    room.match = next
    room.lastActiveAt = Date.now()
    room.revision = (room.revision ?? 0) + 1
    if (message.action === 'swap-seats') swapSeats(room)
    scheduleTimer(info.roomCode, room)
    broadcastState(info.roomCode, room)
  }
  return response.json(statePayload(info.roomCode, room, seatForToken(room, info.token)!, includeData))
})
app.use(express.static(join(currentDir, '..', 'dist')))
app.get('/{*path}', (_request, response) => response.sendFile(join(currentDir, '..', 'dist', 'index.html')))

const server = createServer(app)
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CREATE_MESSAGE_BYTES })

server.on('upgrade', (request, networkSocket, head) => {
  const info = connectionInfo(request)
  if (!info) return rejectUpgrade(networkSocket, 400, 'Invalid room connection')
  const room = rooms.get(info.roomCode)
  if (info.mode === 'join' && !room) return rejectUpgrade(networkSocket, 404, 'Room not found')
  if (room && !seatForToken(room, info.token) && info.mode === 'create') return rejectUpgrade(networkSocket, 409, 'Room already exists')
  if (room && !seatForToken(room, info.token) && !availableSeat(room.seats, info.requestedSeat)) return rejectUpgrade(networkSocket, 409, 'Requested seat is occupied or room is full')
  wss.handleUpgrade(request, networkSocket, head, (socket) => wss.emit('connection', socket, request))
})

wss.on('connection', (socket, request) => {
  const info = connectionInfo(request)
  if (!info) return socket.close(1008, 'Invalid room connection')
  let room = rooms.get(info.roomCode)

  if (room) {
    let seat = seatForToken(room, info.token)
    if (!seat) {
      seat = availableSeat(room.seats, info.requestedSeat)
      if (!seat) return socket.close(1008, 'Room is full')
      room.seats[seat] = info.token
      room.match = renamePlayer(room.match, seat, info.name)
      room.revision = (room.revision ?? 0) + 1
    }
    replaceTokenSocket(room, info.token, socket)
    room.clients.set(socket, { seat, token: info.token })
    room.lastActiveAt = Date.now()
    sendState(socket, info.roomCode, room, true)
    broadcastState(info.roomCode, room, socket)
  } else {
    send(socket, { type: 'room:ready' })
  }

  socket.on('message', (raw) => {
    const size = Buffer.byteLength(raw.toString())
    if (size > MAX_CREATE_MESSAGE_BYTES) return sendError(socket, '消息过大')
    const message = parseMessage(raw.toString())
    if (!message) return sendError(socket, '消息格式不正确')

    if (message.type === 'room:ping') {
      room = rooms.get(info.roomCode)
      if (room && seatForToken(room, info.token)) room.lastActiveAt = Date.now()
      return send(socket, { type: 'room:pong' })
    }

    if (message.type === 'room:create') {
      if (room) return sendState(socket, info.roomCode, room, true)
      if (!message.match || !validMatch(message.match)) return sendError(socket, '数据包格式无效')
      room = {
        match: sanitizeNewMatch(message.match),
        clients: new Map([[socket, { seat: message.match.settings.thirdPartyHost === true ? 'host' : 'blue', token: info.token }]]),
        seats: creatorSeats(message.match.settings.thirdPartyHost === true, info.token),
        lastActiveAt: Date.now(),
        revision: 1,
      }
      rooms.set(info.roomCode, room)
      return sendState(socket, info.roomCode, room, true)
    }

    room = rooms.get(info.roomCode)
    if (!room) return sendError(socket, '未找到该房间，可能已经过期')
    if (message.type === 'room:join') return
    if (size > MAX_ACTION_MESSAGE_BYTES) return sendError(socket, '操作消息过大')

    const client = room.clients.get(socket)
    if (!client) return sendError(socket, '你不是该房间的玩家')
    if ((message.action === 'start' || message.action === 'swap-seats') && !hasTwoPlayers(room)) {
      return sendError(socket, '需要 1P 和 2P 均加入后才能进行此操作')
    }
    const nextMatch = applyRoomAction(room.match, message, client.seat)
    if (!nextMatch) return sendError(socket, '当前操作不符合房间规则')
    room.match = nextMatch
    room.lastActiveAt = Date.now()
    room.revision = (room.revision ?? 0) + 1
    if (message.action === 'swap-seats') swapSeats(room)
    scheduleTimer(info.roomCode, room)
    broadcastState(info.roomCode, room)
  })

  socket.on('close', () => {
    const activeRoom = rooms.get(info.roomCode)
    activeRoom?.clients.delete(socket)
  })
})

function connectionInfo(request: IncomingMessage, path = '/ws'): ConnectionInfo | undefined {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname !== path) return undefined
  const roomCode = url.searchParams.get('room')?.toUpperCase() ?? ''
  const token = url.searchParams.get('client') ?? ''
  const mode = url.searchParams.get('mode')
  if (!/^[A-Z0-9]{5,8}$/.test(roomCode)) return undefined
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return undefined
  if (mode !== 'create' && mode !== 'join') return undefined
  return { roomCode, token, mode, name: url.searchParams.get('name'), requestedSeat: url.searchParams.get('seat') }
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  const body = `${message}\n`
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  socket.destroy()
}

function seatForToken(room: Room, token: string): RoomRole | undefined {
  return roleForToken(room.seats, token)
}

function replaceTokenSocket(room: Room, token: string, replacement: WebSocket) {
  for (const [client, info] of room.clients) {
    if (info.token === token && client !== replacement) {
      room.clients.delete(client)
      client.close(1000, 'Reconnected')
    }
  }
}

function swapSeats(room: Room) {
  const blueToken = room.seats.blue
  room.seats.blue = room.seats.red
  room.seats.red = blueToken
  for (const info of room.clients.values()) if (info.seat !== 'host') info.seat = info.seat === 'blue' ? 'red' : 'blue'
}

function hasTwoPlayers(room: Room) {
  return Boolean(room.seats.blue && room.seats.red)
}

function scheduleTimer(roomCode: string, room: Room) {
  if (room.timer) clearTimeout(room.timer)
  const deadline = room.match.current.phase.expiresAt
  if (!deadline || room.match.status !== 'playing') return
  room.timer = setTimeout(() => {
    const activeRoom = rooms.get(roomCode)
    if (!activeRoom) return
    const nextMatch = expireTimedPhase(activeRoom.match)
    if (nextMatch === activeRoom.match) return scheduleTimer(roomCode, activeRoom)
    activeRoom.match = nextMatch
    activeRoom.revision = (activeRoom.revision ?? 0) + 1
    scheduleTimer(roomCode, activeRoom)
    broadcastState(roomCode, activeRoom)
  }, Math.max(0, deadline - Date.now()) + 20)
}

function parseMessage(raw: string): RoomMessage | undefined {
  try {
    const value = JSON.parse(raw) as RoomMessage
    return value && ['room:create', 'room:join', 'room:action', 'room:ping'].includes(value.type) ? value : undefined
  } catch {
    return undefined
  }
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function sendError(socket: WebSocket, message: string) {
  send(socket, { type: 'room:error', message })
}

function compactMatch(match: MatchState) {
  const { data, ...state } = match
  return { ...state, dataPackageId: data.id }
}

function sendState(socket: WebSocket, roomCode: string, room: Room, includeData = false) {
  const info = room.clients.get(socket)
  if (!info) return
  send(socket, statePayload(roomCode, room, info.seat, includeData))
}

function statePayload(roomCode: string, room: Room, seat: RoomRole, includeData: boolean) {
  return {
    type: 'room:state', roomCode, match: compactMatch(room.match),
    serverTime: Date.now(),
    revision: room.revision ?? 0,
    ...(includeData ? { data: room.match.data } : {}),
    seat,
    players: { blue: Boolean(room.seats.blue), red: Boolean(room.seats.red) },
  }
}

function broadcastState(roomCode: string, room: Room, except?: WebSocket) {
  for (const client of room.clients.keys()) if (client !== except) sendState(client, roomCode, room)
}

function sanitizeNewMatch(candidate: MatchState): MatchState {
  const title = typeof candidate.settings?.title === 'string' ? candidate.settings.title.slice(0, 40) : 'BO3 对局'
  return createMatch(candidate.data, title, candidate.settings?.roundBan !== false, candidate.settings)
}

function validMatch(value: MatchState): boolean {
  return Boolean(value && value.settings && validDataPackage(value.data))
}

function validDataPackage(value: unknown): value is DataPackage {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<DataPackage>
  if (typeof data.id !== 'string' || !data.id || data.id.length > 100) return false
  if (!Array.isArray(data.ninjas) || data.ninjas.length < 22 || data.ninjas.length > 1000) return false
  if (!Array.isArray(data.scrolls) || data.scrolls.length < 9 || data.scrolls.length > 200) return false
  if (!Array.isArray(data.summons) || data.summons.length < 9 || data.summons.length > 200) return false
  return [data.ninjas, data.scrolls, data.summons].every((items) => {
    const ids = new Set<string>()
    return items.every((item) => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)) return false
      if (typeof item.name !== 'string' || !item.name || item.name.length > 100 || !Array.isArray(item.tags)) return false
      ids.add(item.id)
      return true
    })
  })
}

setInterval(() => {
  const cutoff = Date.now() - ROOM_LIFETIME_MS
  for (const [code, room] of rooms) {
    if (room.lastActiveAt < cutoff) {
      if (room.timer) clearTimeout(room.timer)
      for (const client of room.clients.keys()) client.close(1001, 'Room expired')
      rooms.delete(code)
    }
  }
}, 60_000).unref()

server.listen(port, '0.0.0.0', () => console.log(`BP room server listening on http://0.0.0.0:${port}`))
