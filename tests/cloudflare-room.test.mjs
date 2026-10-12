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

test('HTTPS fallback shares rooms, permissions and state with WebSocket players', async (context) => {
  const data = JSON.parse(await readFile(catalogPath, 'utf8'))
  const code = randomCode()
  const hostToken = randomToken()
  const guestToken = randomToken()
  async function request(token, mode, message, includeData = false) {
    const url = new URL(baseUrl.replace(/^ws/, 'http'))
    url.pathname = '/room'
    url.searchParams.set('room', code)
    url.searchParams.set('client', token)
    url.searchParams.set('mode', mode)
    if (includeData) url.searchParams.set('data', '1')
    const response = await fetch(url, {
      method: message ? 'POST' : 'GET',
      headers: message ? { 'Content-Type': 'application/json' } : undefined,
      body: message ? JSON.stringify(message) : undefined,
      signal: AbortSignal.timeout(20000),
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, payload: await response.json() }
  }
  assert.equal((await request(hostToken, 'join')).status, 404)
  const created = await request(hostToken, 'create', { type: 'room:create', match: initialMatch(data) })
  assert.equal(created.status, 200)
  assert.equal(created.payload.seat, 'blue')
  assert.equal(created.payload.data.id, data.id)

  const guest = await connect(code, 'join', guestToken)
  context.after(() => guest.close())
  assert.equal((await guest.next('room:state')).seat, 'red')
  assert.equal((await request(randomToken(), 'join')).status, 409)
  assert.equal((await request(guestToken, 'join', { type: 'room:action', action: 'start' })).status, 403)

  const started = await request(hostToken, 'join', { type: 'room:action', action: 'start' })
  assert.equal(started.payload.data, undefined)
  assert.ok(started.payload.revision > created.payload.revision)
  assert.equal((await guest.next('room:state')).match.status, 'playing')
  assert.equal((await request(guestToken, 'join', { type: 'room:action', action: 'ninja', itemId: data.ninjas[0].id })).status, 403)
  await request(hostToken, 'join', { type: 'room:action', action: 'ninja', itemId: data.ninjas[0].id })
  assert.equal((await guest.next('room:state')).match.current.phase.turn, 'red')
  guest.send(JSON.stringify({ type: 'room:action', action: 'ninja', itemId: data.ninjas[1].id }))
  await guest.next('room:state')

  const snapshot = await request(hostToken, 'join')
  assert.deepEqual(snapshot.payload.match.current.bans, { blue: [data.ninjas[0].id], red: [data.ninjas[1].id] })
  assert.equal(snapshot.payload.data, undefined)
  const restored = await request(hostToken, 'join', undefined, true)
  assert.equal(restored.payload.seat, 'blue')
  assert.equal(restored.payload.data.id, data.id)
})

test('new settings, own names and host seat swap persist across transports', async (context) => {
  const data = JSON.parse(await readFile(catalogPath, 'utf8'))
  const code = randomCode()
  const hostToken = randomToken()
  const guestToken = randomToken()
  const host = await connect(code, 'create', hostToken)
  context.after(() => host.close())
  const candidate = initialMatch(data)
  candidate.settings = { ...candidate.settings, bestOf: 7, repeatScrolls: true, repeatSummons: false, turnSeconds: 1, playerNames: { blue: '北风', red: '玩家二' } }
  host.send(JSON.stringify({ type: 'room:create', match: candidate }))
  const created = await host.next('room:state')
  assert.equal(created.match.settings.bestOf, 7)
  assert.equal(created.match.settings.repeatScrolls, true)
  assert.equal(created.match.settings.repeatSummons, false)
  assert.equal(created.match.settings.turnSeconds, 60)
  const guest = await connect(code, 'join', guestToken, '白面具')
  context.after(() => guest.close())
  const joined = await guest.next('room:state')
  await host.next('room:state')
  assert.deepEqual(joined.match.settings.playerNames, { blue: '北风', red: '白面具' })
  guest.send(JSON.stringify({ type: 'room:action', action: 'rename', name: '白面具二', seat: 'blue' }))
  assert.equal((await guest.next('room:state')).match.settings.playerNames.blue, '北风')
  await host.next('room:state')
  guest.send(JSON.stringify({ type: 'room:action', action: 'swap-seats' }))
  await guest.next('room:error')
  host.send(JSON.stringify({ type: 'room:action', action: 'swap-seats' }))
  const swappedHost = await host.next('room:state')
  const swappedGuest = await guest.next('room:state')
  assert.equal(swappedHost.seat, 'red')
  assert.equal(swappedGuest.seat, 'blue')
  assert.deepEqual(swappedHost.match.settings.playerNames, { blue: '白面具二', red: '北风' })
  guest.send(JSON.stringify({ type: 'room:action', action: 'start' }))
  const started = await guest.next('room:state')
  await host.next('room:state')
  assert.ok(started.match.current.phase.expiresAt - started.serverTime > 59000)
  assert.ok(started.match.current.phase.expiresAt - started.serverTime <= 60000)
  guest.send(JSON.stringify({ type: 'room:action', action: 'swap-seats' }))
  await guest.next('room:error')
})

test('no-timer ordered batches are atomic across WebSocket and HTTPS', async (context) => {
  const data = JSON.parse(await readFile(catalogPath, 'utf8'))
  data.summons = data.scrolls.map(item => ({ ...item }))
  const code = randomCode()
  const guestToken = randomToken()
  const host = await connect(code, 'create', randomToken())
  context.after(() => host.close())
  const candidate = initialMatch(data)
  candidate.settings.noTimer = true
  host.send(JSON.stringify({ type: 'room:create', match: candidate }))
  assert.equal((await host.next('room:state')).match.settings.noTimer, true)
  async function request(message) {
    const url = new URL(baseUrl.replace(/^ws/, 'http'))
    url.pathname = '/room'
    url.searchParams.set('room', code); url.searchParams.set('client', guestToken); url.searchParams.set('mode', 'join')
    const response = await fetch(url, { method: message ? 'POST' : 'GET', headers: message ? { 'Content-Type': 'application/json' } : undefined, body: message ? JSON.stringify({ type: 'room:action', ...message }) : undefined, signal: AbortSignal.timeout(20000) })
    return { status: response.status, payload: await response.json() }
  }
  assert.equal((await request()).payload.seat, 'red')
  await host.next('room:state')
  host.send(JSON.stringify({ type: 'room:action', action: 'start' }))
  let state = await host.next('room:state')
  assert.equal(state.match.current.phase.expiresAt, null)
  for (let i = 0; i < 10; i++) {
    const command = { action: 'ninja', itemId: data.ninjas[i].id }
    if (state.match.current.phase.turn === 'blue') host.send(JSON.stringify({ type: 'room:action', ...command }))
    else assert.equal((await request(command)).status, 200)
    state = await host.next('room:state')
    assert.equal(state.match.current.phase.expiresAt, null)
  }
  const ids = data.scrolls.slice(0, 3).map(item => item.id)
  for (const phase of ['scroll', 'summon']) {
    const command = { action: 'timed-batch', round: 1, phase, itemIds: ids }
    assert.equal((await request({ ...command, itemIds: [ids[0], ids[0], ids[2]] })).status, 403)
    assert.deepEqual((await request()).payload.match.current[phase === 'scroll' ? 'scrolls' : 'summons'].red, [])
    host.send(JSON.stringify({ type: 'room:action', ...command, itemIds: [...ids].reverse() }))
    state = await host.next('room:state')
    assert.deepEqual(state.match.current[phase === 'scroll' ? 'scrolls' : 'summons'].blue, [...ids].reverse())
    assert.equal((await request(command)).status, 200)
    state = await host.next('room:state')
    assert.deepEqual(state.match.current[phase === 'scroll' ? 'scrolls' : 'summons'].red, ids)
    if (phase === 'scroll') {
      assert.equal((await request(command)).status, 403)
      assert.deepEqual((await request()).payload.match.current.summons.red, [])
      assert.equal(state.match.current.phase.expiresAt, null)
    }
  }
  assert.equal(state.match.status, 'round-complete')
})

test('the server alarm randomly completes a ban after the real 60-second deadline', { timeout: 150000 }, async (context) => {
  const data = JSON.parse(await readFile(catalogPath, 'utf8'))
  const code = randomCode()
  const host = await connect(code, 'create', randomToken())
  context.after(() => host.close())
  host.send(JSON.stringify({ type: 'room:create', match: initialMatch(data) }))
  await host.next('room:state')
  const guest = await connect(code, 'join', randomToken())
  context.after(() => guest.close())
  await guest.next('room:state'); await host.next('room:state')
  host.send(JSON.stringify({ type: 'room:action', action: 'start' }))
  const started = await host.next('room:state')
  await guest.next('room:state')
  const deadline = started.match.current.phase.expiresAt
  assert.ok(deadline - started.serverTime > 59000)
  assert.ok(deadline - started.serverTime <= 60000)
  const automatic = await guest.next('room:state', 90000)
  assert.ok(automatic.serverTime >= deadline)
  assert.equal(automatic.match.current.bans.blue.length, 1)
  assert.equal(automatic.match.current.phase.turn, 'red')
  assert.ok(data.ninjas.some(item => item.id === automatic.match.current.bans.blue[0]))
  assert.ok(automatic.match.current.phase.expiresAt > deadline)
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

async function connect(code, mode, token, name = '') {
  const url = `${baseUrl}?room=${code}&mode=${mode}&client=${token}&name=${encodeURIComponent(name)}`
  const socket = new WebSocket(url, { handshakeTimeout: 40000 })
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
    next(type, timeoutMs = 40000) {
      const index = messages.findIndex((message) => message.type === type)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs)
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
