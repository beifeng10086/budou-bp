import type { DataPackage, MatchState, Seat } from './types'

type MatchWire = Omit<MatchState, 'data'> & { dataPackageId?: string; data?: DataPackage }
export interface RoomPayload {
  type: string
  roomCode?: string
  match?: MatchWire
  data?: DataPackage
  seat?: Seat
  players?: { blue: boolean; red: boolean }
  message?: string
  revision?: number
  serverTime?: number
}

interface RoomOptions {
  endpoint: string
  mode: 'create' | 'join'
  match?: MatchState
  onMessage: (payload: RoomPayload) => void
  onStatus: (message: string) => void
}

class RoomHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class RoomTransport {
  private socket: WebSocket | null = null
  private closed = false
  private httpMode = false
  private ready = false
  private revision = -1
  private mode: 'create' | 'join'
  private pollDelay = 5000
  private failures = 0
  private pollTimer?: ReturnType<typeof setTimeout>
  private connectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private controllers = new Set<AbortController>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: RoomOptions) { this.mode = options.mode }

  start() {
    try {
      const socket = new WebSocket(this.options.endpoint)
      this.socket = socket
      // A phone may load HTTPS pages while WebSocket upgrades fail or stall.
      this.connectTimer = setTimeout(() => this.startHttp(), 8000)
      socket.onopen = () => {
        if (!this.closed && !this.httpMode) socket.send(JSON.stringify(this.initialMessage()))
      }
      socket.onmessage = (event) => {
        if (this.closed || this.httpMode) return
        try { this.receive(JSON.parse(event.data) as RoomPayload) } catch { /* Ignore malformed messages. */ }
      }
      socket.onerror = () => this.startHttp()
      socket.onclose = () => this.startHttp()
      this.heartbeatTimer = setInterval(() => {
        if (this.ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'room:ping' }))
      }, 25000)
    } catch { this.startHttp() }
  }

  send(message: unknown) {
    if (this.closed || !this.ready) return
    if (!this.httpMode && this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify(message)) } catch { this.startHttp() }
      return
    }
    void this.enqueueHttp(message).then(payload => this.receive(payload)).catch(error => {
      if (this.closed) return
      // An uncertain POST is never replayed: the next poll retrieves authoritative state.
      if (error instanceof RoomHttpError && error.status < 500) this.options.onStatus(error.message)
      else this.options.onStatus('操作未确认，正在重新同步房间')
    })
  }

  close() {
    this.closed = true
    this.clearTimers()
    this.socket?.close()
    for (const controller of this.controllers) controller.abort()
  }

  private initialMessage() {
    return this.mode === 'create' ? { type: 'room:create', match: this.options.match } : { type: 'room:join' }
  }

  private receive(payload: RoomPayload) {
    if (this.closed) return
    if (payload.type === 'room:state' && payload.match) {
      if (payload.revision !== undefined && payload.revision < this.revision) return
      this.revision = payload.revision ?? this.revision
      this.ready = true
      this.mode = 'join'
      this.failures = 0
      this.pollDelay = payload.match.status === 'playing' && payload.match.current.phase.kind !== 'complete' ? 2500 : 5000
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.options.onStatus('共享房间已连接')
    }
    this.options.onMessage(payload)
  }

  private startHttp() {
    if (this.closed || this.httpMode) return
    this.httpMode = true
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.options.onStatus('正在重新连接共享房间...')
    void this.poll(true)
  }

  private clearTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  private async poll(includeData = false) {
    if (this.closed) return
    try {
      const payload = await this.enqueueHttp(!this.ready && this.mode === 'create' ? this.initialMessage() : undefined, includeData || !this.ready)
      this.receive(payload)
    } catch (error) {
      if (this.closed) return
      if (error instanceof RoomHttpError && error.status < 500 && error.status !== 429) {
        this.options.onStatus(error.message)
        this.close()
        return
      }
      this.failures++
      this.options.onStatus(this.failures < 3 ? '连接暂时中断，正在重试...' : '网络连接失败，正在重试；也可切换网络后重新进入')
    }
    if (!this.closed) {
      const delay = this.failures ? Math.min(15000, 1000 * 2 ** this.failures)
        : document.hidden ? 15000 : this.pollDelay
      this.pollTimer = setTimeout(() => { void this.poll() }, delay)
    }
  }

  private enqueueHttp(message?: unknown, includeData = false): Promise<RoomPayload> {
    const task = this.queue.then(() => this.requestHttp(message, includeData))
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async requestHttp(message?: unknown, includeData = false): Promise<RoomPayload> {
    if (this.closed) throw new Error('Connection closed')
    const url = new URL(this.options.endpoint)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/room'
    url.searchParams.set('mode', this.mode)
    if (includeData) url.searchParams.set('data', '1')
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(url, {
        method: message ? 'POST' : 'GET',
        body: message ? JSON.stringify(message) : undefined,
        headers: message ? { 'Content-Type': 'application/json' } : undefined,
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = await response.json() as RoomPayload
      if (!response.ok) throw new RoomHttpError(payload.message ?? '房间连接暂时失败', response.status)
      if (payload.type !== 'room:state') throw new Error('Invalid room response')
      return payload
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }
}
