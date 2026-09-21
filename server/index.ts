import express from 'express'
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import {
  chooseNinja, chooseTimedItem, expireTimedPhase, recordWinner, resetMatch, startMatch, startNextRound,
} from '../src/bp.ts'
import type { DataPackage, MatchState, Seat } from '../src/types.ts'

const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
const MAX_CREATE_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_ACTION_MESSAGE_BYTES = 16 * 1024

type ClientInfo = { seat: Seat; token: string }
type Room = {
  match: MatchState
  clients: Map<WebSocket, ClientInfo>
  seats: Partial<Record<Seat, string>>
  lastActiveAt: number
  timer?: ReturnType<typeof setTimeout>
}

type RoomMessage = {
  type: 'room:create' | 'room:join' | 'room:action' | 'room:ping'
  roomCode?: string
  match?: MatchState
  action?: 'start' | 'ninja' | 'timed' | 'winner' | 'next' | 'new-match' | 'swap-seats'
  itemId?: string
  winner?: Seat
}

type ConnectionInfo = { roomCode: string; mode: 'create' | 'join'; token: string }

const port = Number(process.env.PORT ?? 8787)
const rooms = new Map<string, Room>()
const currentDir = dirname(fileURLToPath(import.meta.url))
const app = express()

app.get('/health', (_request, response) => response.json({ ok: true, service: 'budou-bp-node', rooms: rooms.size }))
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
  if (room && !seatForToken(room, info.token) && room.seats.red) return rejectUpgrade(networkSocket, 409, 'Room is full')
  wss.handleUpgrade(request, networkSocket, head, (socket) => wss.emit('connection', socket, request))
})

wss.on('connection', (socket, request) => {
  const info = connectionInfo(request)
  if (!info) return socket.close(1008, 'Invalid room connection')
  let room = rooms.get(info.roomCode)

  if (room) {
    let seat = seatForToken(room, info.token)
    if (!seat) {
      seat = 'red'
      room.seats.red = info.token
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
        clients: new Map([[socket, { seat: 'blue', token: info.token }]]),
        seats: { blue: info.token },
        lastActiveAt: Date.now(),
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
    const nextMatch = applyAction(room.match, message, client.seat)
    if (!nextMatch) return sendError(socket, '当前操作不符合房间规则')
    room.match = nextMatch
    room.lastActiveAt = Date.now()
    if (message.action === 'swap-seats') swapSeats(room)
    scheduleTimer(info.roomCode, room)
    broadcastState(info.roomCode, room)
  })

  socket.on('close', () => {
    const activeRoom = rooms.get(info.roomCode)
    activeRoom?.clients.delete(socket)
  })
})

function applyAction(match: MatchState, message: RoomMessage, seat: Seat): MatchState | undefined {
  const isHost = seat === 'blue'
  switch (message.action) {
    case 'start':
      return isHost && match.status === 'setup' ? changed(match, startMatch(match)) : undefined
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

function connectionInfo(request: IncomingMessage): ConnectionInfo | undefined {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname !== '/ws') return undefined
  const roomCode = url.searchParams.get('room')?.toUpperCase() ?? ''
  const token = url.searchParams.get('client') ?? ''
  const mode = url.searchParams.get('mode')
  if (!/^[A-Z0-9]{5,8}$/.test(roomCode)) return undefined
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return undefined
  if (mode !== 'create' && mode !== 'join') return undefined
  return { roomCode, token, mode }
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  const body = `${message}\n`
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  socket.destroy()
}

function seatForToken(room: Room, token: string): Seat | undefined {
  if (room.seats.blue === token) return 'blue'
  if (room.seats.red === token) return 'red'
  return undefined
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
  for (const info of room.clients.values()) info.seat = info.seat === 'blue' ? 'red' : 'blue'
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
  send(socket, {
    type: 'room:state', roomCode, match: compactMatch(room.match),
    ...(includeData ? { data: room.match.data } : {}),
    seat: info.seat,
    players: { blue: Boolean(room.seats.blue), red: Boolean(room.seats.red) },
  })
}

function broadcastState(roomCode: string, room: Room, except?: WebSocket) {
  for (const client of room.clients.keys()) if (client !== except) sendState(client, roomCode, room)
}

function sanitizeNewMatch(candidate: MatchState): MatchState {
  const title = typeof candidate.settings?.title === 'string' ? candidate.settings.title.slice(0, 40) : 'BO3 对局'
  return {
    settings: { title: title.trim() || 'BO3 对局', roundBan: candidate.settings?.roundBan !== false },
    data: candidate.data, status: 'setup',
    current: {
      number: 1,
      bans: { blue: [], red: [] }, picks: { blue: [], red: [] },
      scrolls: { blue: [], red: [] }, summons: { blue: [], red: [] },
      phase: { kind: 'ban', turn: 'blue', index: 0, expiresAt: null }, winner: null,
    },
    history: [],
  }
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

function changed(match: MatchState, next: MatchState): MatchState | undefined {
  return next === match ? undefined : next
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
