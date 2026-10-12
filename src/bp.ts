import type { BestOf, DataPackage, MatchState, Phase, RoomSettings, RoundState, Seat } from './types'

const pickOrder: Seat[] = ['blue', 'red', 'red', 'blue', 'blue', 'red']
const banOrder: Seat[] = ['blue', 'red', 'red', 'blue']

function clonePhase(phase: Phase): Phase {
  return { ...phase }
}

function newRound(number: number, shouldBan: boolean, inheritedBans: Record<Seat, string[]>): RoundState {
  return {
    number,
    bans: { blue: [...inheritedBans.blue], red: [...inheritedBans.red] },
    picks: { blue: [], red: [] },
    scrolls: { blue: [], red: [] },
    summons: { blue: [], red: [] },
    winner: null,
    phase: shouldBan
      ? { kind: 'ban', turn: banOrder[0], index: 0, expiresAt: null }
      : { kind: 'pick', turn: pickOrder[0], index: 0, expiresAt: null },
  }
}

export function normalizeName(value: unknown, fallback: string): string {
  return typeof value === 'string' ? Array.from(value.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 16).join('') || fallback : fallback
}

export function bestOfValue(value: unknown): BestOf {
  return value === 0 || value === 5 || value === 7 ? value : 3
}

export function bestOfLabel(match: MatchState): string {
  return match.settings.bestOf === 0 ? 'BO 无限' : `BO${bestOfValue(match.settings.bestOf)}`
}

export function playerName(match: MatchState, seat: Seat): string {
  return normalizeName(match.settings.playerNames?.[seat], seat === 'blue' ? '玩家一' : '玩家二')
}

export function createMatch(data: DataPackage, title: string, roundBan: boolean, options: Partial<RoomSettings> = {}): MatchState {
  return {
    settings: {
      title: title.trim() || '武斗对局', roundBan, bestOf: bestOfValue(options.bestOf), turnSeconds: 60,
      repeatScrolls: options.repeatScrolls === true, repeatSummons: options.repeatSummons === true,
      playerNames: { blue: normalizeName(options.playerNames?.blue, '玩家一'), red: normalizeName(options.playerNames?.red, '玩家二') },
    },
    data,
    status: 'setup',
    current: newRound(1, true, { blue: [], red: [] }),
    history: [],
  }
}

export function startMatch(match: MatchState): MatchState {
  if (match.status !== 'setup' || poolProblem(match)) return match
  return { ...match, status: 'playing', current: { ...match.current, phase: { ...match.current.phase, expiresAt: Date.now() + 60_000 } } }
}

export function canSelectNinja(match: MatchState, id: string): boolean {
  const { current } = match
  const previouslyPicked = match.history.flatMap((round) => [...round.picks.blue, ...round.picks.red])
  return !previouslyPicked.includes(id)
    && !current.bans.blue.includes(id) && !current.bans.red.includes(id)
    && !current.picks.blue.includes(id) && !current.picks.red.includes(id)
}

export function canSelectTimedItem(match: MatchState, itemId: string, seat: Seat, kind?: 'scroll' | 'summon'): boolean {
  const selectionKind = kind ?? match.current.phase.kind
  if (selectionKind !== 'scroll' && selectionKind !== 'summon') return false
  const currentList = selectionKind === 'scroll' ? match.current.scrolls[seat] : match.current.summons[seat]
  const previousItems = match.history.flatMap((round) => selectionKind === 'scroll' ? round.scrolls[seat] : round.summons[seat])
  const repeat = selectionKind === 'scroll' ? match.settings.repeatScrolls : match.settings.repeatSummons
  return !currentList.includes(itemId) && (repeat === true || !previousItems.includes(itemId))
}

export function chooseNinja(match: MatchState, ninjaId: string): MatchState {
  const { current } = match
  if (match.status !== 'playing' || !match.data.ninjas.some(item => item.id === ninjaId)
    || !canSelectNinja(match, ninjaId) || !current.phase.turn) return match

  const next = cloneRound(current)
  if (current.phase.kind === 'ban') {
    next.bans[current.phase.turn].push(ninjaId)
    const nextIndex = current.phase.index + 1
    next.phase = nextIndex < banOrder.length
      ? { kind: 'ban', turn: banOrder[nextIndex], index: nextIndex, expiresAt: Date.now() + 60_000 }
      : { kind: 'pick', turn: pickOrder[0], index: 0, expiresAt: Date.now() + 60_000 }
  } else if (current.phase.kind === 'pick') {
    next.picks[current.phase.turn].push(ninjaId)
    const nextIndex = current.phase.index + 1
    next.phase = nextIndex < pickOrder.length
      ? { kind: 'pick', turn: pickOrder[nextIndex], index: nextIndex, expiresAt: Date.now() + 60_000 }
      : { kind: 'scroll', turn: null, index: 0, expiresAt: Date.now() + 60_000 }
  }
  return { ...match, current: next }
}

export function chooseTimedItem(match: MatchState, itemId: string, seat: Seat): MatchState {
  const { current } = match
  if (match.status !== 'playing') return match
  const pool = current.phase.kind === 'scroll' ? match.data.scrolls : match.data.summons
  if (!pool.some(item => item.id === itemId)) return match
  if (current.phase.kind === 'scroll') {
    if (current.scrolls[seat].length >= 3 || !canSelectTimedItem(match, itemId, seat)) return match
    const next = cloneRound(current)
    next.scrolls[seat].push(itemId)
    if (next.scrolls.blue.length === 3 && next.scrolls.red.length === 3) {
      next.phase = { kind: 'summon', turn: null, index: 0, expiresAt: Date.now() + 60_000 }
    }
    return { ...match, current: next }
  }
  if (current.phase.kind === 'summon') {
    if (current.summons[seat].length >= 3 || !canSelectTimedItem(match, itemId, seat)) return match
    const next = cloneRound(current)
    next.summons[seat].push(itemId)
    if (next.summons.blue.length === 3 && next.summons.red.length === 3) {
      next.phase = { kind: 'complete', turn: null, index: 0, expiresAt: null }
      return { ...match, status: 'round-complete', current: next }
    }
    return { ...match, current: next }
  }
  return match
}

export function expireTimedPhase(match: MatchState, random: () => number = Math.random): MatchState {
  const { phase } = match.current
  if (match.status !== 'playing' || !phase.expiresAt || Date.now() < phase.expiresAt) return match
  if (phase.kind === 'ban' || phase.kind === 'pick') {
    const available = match.data.ninjas.filter(item => canSelectNinja(match, item.id))
    const item = available[Math.min(available.length - 1, Math.floor(random() * available.length))]
    return item ? chooseNinja(match, item.id) : match
  }
  if (phase.kind !== 'scroll' && phase.kind !== 'summon') return match
  const pool = phase.kind === 'scroll' ? match.data.scrolls : match.data.summons
  let next = match
  for (const seat of ['blue', 'red'] as Seat[]) {
    for (let count = (phase.kind === 'scroll' ? next.current.scrolls[seat] : next.current.summons[seat]).length; count < 3; count++) {
      const available = pool.filter(item => canSelectTimedItem(next, item.id, seat, phase.kind as 'scroll' | 'summon'))
      const item = available[Math.min(available.length - 1, Math.floor(random() * available.length))]
      if (!item) return next
      next = chooseTimedItem(next, item.id, seat)
    }
  }
  return next
}

export function recordWinner(match: MatchState, winner: Seat): MatchState {
  if (match.status !== 'round-complete' || match.current.winner) return match
  const current = cloneRound(match.current)
  current.winner = winner
  return { ...match, current }
}

export function startNextRound(match: MatchState): MatchState {
  if (match.status !== 'round-complete' || !match.current.winner) return match
  const history = [...match.history, cloneRound(match.current)]
  const blueWins = history.filter((round) => round.winner === 'blue').length
  const redWins = history.filter((round) => round.winner === 'red').length
  const bestOf = bestOfValue(match.settings.bestOf)
  const winsNeeded = bestOf === 0 ? Infinity : (bestOf + 1) / 2
  if (blueWins >= winsNeeded || redWins >= winsNeeded || bestOf !== 0 && history.length >= bestOf) {
    return { ...match, history, status: 'match-complete' }
  }
  const initialBans = match.settings.roundBan
    ? { blue: [], red: [] }
    : { blue: [...history[0].bans.blue], red: [...history[0].bans.red] }
  const next: MatchState = {
    ...match,
    history,
    status: 'playing',
    current: newRound(history.length + 1, match.settings.roundBan, initialBans),
  }
  if (poolProblem(next)) return match
  next.current.phase.expiresAt = Date.now() + 60_000
  return next
}

export function resetMatch(match: MatchState): MatchState {
  return createMatch(match.data, match.settings.title, match.settings.roundBan, match.settings)
}

export function poolProblem(match: MatchState): string {
  const usedNinjas = new Set(match.history.flatMap(round => [...round.picks.blue, ...round.picks.red]))
  const banned = new Set([...match.current.bans.blue, ...match.current.bans.red])
  const ninjaCount = match.data.ninjas.filter(item => !usedNinjas.has(item.id) && !banned.has(item.id)).length
  const required = match.settings.roundBan || match.current.number === 1 ? 10 : 6
  if (ninjaCount < required) return '忍者池不足以完成下一局'
  for (const seat of ['blue', 'red'] as Seat[]) {
    for (const kind of ['scroll', 'summon'] as const) {
      const repeat = kind === 'scroll' ? match.settings.repeatScrolls : match.settings.repeatSummons
      const pool = kind === 'scroll' ? match.data.scrolls : match.data.summons
      const used = new Set(match.history.flatMap(round => kind === 'scroll' ? round.scrolls[seat] : round.summons[seat]))
      if (pool.filter(item => repeat || !used.has(item.id)).length < 3) return `${seat === 'blue' ? '1P' : '2P'} ${kind === 'scroll' ? '秘卷' : '通灵'}池已用尽`
    }
  }
  return ''
}

export function nextRoundProblem(match: MatchState): string {
  if (match.status !== 'round-complete' || !match.current.winner || seriesFinished(match)) return ''
  const history = [...match.history, cloneRound(match.current)]
  const inherited = match.settings.roundBan ? { blue: [], red: [] } : history[0].bans
  return poolProblem({ ...match, history, current: newRound(history.length + 1, match.settings.roundBan, inherited) })
}

export function seriesFinished(match: MatchState): boolean {
  const bestOf = bestOfValue(match.settings.bestOf)
  if (bestOf === 0) return false
  const rounds = [...match.history, ...(match.history.some(round => round.number === match.current.number) ? [] : [match.current])]
  const wins = (bestOf + 1) / 2
  return rounds.filter(round => round.winner === 'blue').length >= wins
    || rounds.filter(round => round.winner === 'red').length >= wins || rounds.length >= bestOf && Boolean(match.current.winner)
}

export function endMatch(match: MatchState): MatchState {
  if (match.status !== 'round-complete' || !match.current.winner) return match
  const history = match.history.some(round => round.number === match.current.number) ? match.history : [...match.history, cloneRound(match.current)]
  return { ...match, history, status: 'match-complete' }
}

export function renamePlayer(match: MatchState, seat: Seat, name: unknown): MatchState {
  if (match.status !== 'setup') return match
  const playerNames = { blue: playerName(match, 'blue'), red: playerName(match, 'red') }
  const clean = normalizeName(name, playerNames[seat])
  if (clean === playerNames[seat]) return match
  playerNames[seat] = clean
  return { ...match, settings: { ...match.settings, playerNames } }
}

export function swapPlayerNames(match: MatchState): MatchState {
  return { ...match, settings: { ...match.settings, playerNames: { blue: playerName(match, 'red'), red: playerName(match, 'blue') } } }
}

function cloneRound(round: RoundState): RoundState {
  return {
    ...round,
    bans: { blue: [...round.bans.blue], red: [...round.bans.red] },
    picks: { blue: [...round.picks.blue], red: [...round.picks.red] },
    scrolls: { blue: [...round.scrolls.blue], red: [...round.scrolls.red] },
    summons: { blue: [...round.summons.blue], red: [...round.summons.red] },
    phase: clonePhase(round.phase),
  }
}
