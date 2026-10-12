import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import WebSocket from 'ws'

const baseUrl = process.env.BP_WORKER_URL ?? 'ws://127.0.0.1:8788/ws'
const catalogPath = new URL('../public/data/official-collected-2026-09-19.json', import.meta.url)

test('Cloudflare room enforces seats and restores a reconnecting player', async (context) => {
  const data = JSON.parse(await readFile(catalogPath, 'utf8'))
  const code = randomCode()
  const hostToken = randomToken()
  const guestToken = randomToken()
  const host = await connect(code, 'create', hostToken)
  context.after(() => host.close())

  host.send(JSON.stringify({ type: 'room:create', match: initialMatch(data) }))
  const created = await host.next('room:state')
  assert.equal(created.seat, 'blue')
  assert.equal(created.match.status, 'setup')
  assert.equal(created.data.id, data.id)

  const guest = await connect(code, 'join', guestToken)
  context.after(() => guest.close())
  const joined = await guest.next('room:state')
  assert.equal(joined.seat, 'red')
  assert.deepEqual(joined.players, { blue: true, red: true })
  await host.next('room:state')

  const rejectedStatus = await rejectedConnection(code, 'join', randomToken())
  assert.equal(rejectedStatus, 409)

  guest.send(JSON.stringify({ type: 'room:action', action: 'start' }))
  assert.match((await guest.next('room:error')).message, /房间规则/)

  host.send(JSON.stringify({ type: 'room:action', action: 'start' }))
  const hostStarted = await host.next('room:state')
  const guestStarted = await guest.next('room:state')
  assert.equal(hostStarted.match.status, 'playing')
  assert.equal(guestStarted.match.status, 'playing')
  assert.equal(hostStarted.data, undefined, 'updates should not resend the full catalog')

  guest.send(JSON.stringify({ type: 'room:action', action: 'ninja', itemId: data.ninjas[0].id }))
  assert.match((await guest.next('room:error')).message, /房间规则/)

  host.send(JSON.stringify({ type: 'room:action', action: 'ninja', itemId: data.ninjas[0].id }))
  const afterBan = await host.next('room:state')
  await guest.next('room:state')
  assert.deepEqual(afterBan.match.current.bans.blue, [data.ninjas[0].id])
  assert.equal(afterBan.match.current.phase.turn, 'red')

  host.close()
  const reconnected = await connect(code, 'join', hostToken)
  context.after(() => reconnected.close())
  const restored = await reconnected.next('room:state')
  assert.equal(restored.seat, 'blue')
  assert.equal(restored.data.id, data.id)
  assert.deepEqual(restored.match.current.bans.blue, [data.ninjas[0].id])
})

function initialMatch(data) {
  return {
    settings: { title: 'Worker integration test', roundBan: true },
    data,
    status: 'setup',
    current: {
      number: 1,
      bans: { blue: [], red: [] },
      picks: { blue: [], red: [] },
      scrolls: { blue: [], red: [] },
      summons: { blue: [], red: [] },
      phase: { kind: 'ban', turn: 'blue', index: 0, expiresAt: null },
      winner: null,
    },
    history: [],
  }
}

async function connect(code, mode, token) {
  const url = `${baseUrl}?room=${code}&mode=${mode}&client=${token}`
  const socket = new WebSocket(url, { handshakeTimeout: 20000 })
  const messages = []
  const waiters = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type)
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    } else messages.push(message)
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return {
    send: (message) => socket.send(message),
    close: () => socket.terminate(),
    next(type) {
      const index = messages.findIndex((message) => message.type === type)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 20000)
        waiters.push({ type, resolve, timer })
      })
    },
  }
}

function rejectedConnection(code, mode, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}?room=${code}&mode=${mode}&client=${token}`, { handshakeTimeout: 20000 })
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode)
      response.resume()
      socket.terminate()
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('Expected WebSocket connection to be rejected'))
    })
    socket.once('error', () => undefined)
  })
}

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function randomToken() {
  return crypto.randomUUID().replace(/-/g, '')
}
