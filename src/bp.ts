import type { DataPackage, MatchState, Phase, RoundState, Seat } from './types'

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

export function createMatch(data: DataPackage, title: string, roundBan: boolean): MatchState {
  return {
    settings: { title: title.trim() || 'BO3 对局', roundBan },
    data,
    status: 'setup',
    current: newRound(1, true, { blue: [], red: [] }),
    history: [],
  }
}

export function startMatch(match: MatchState): MatchState {
  if (match.status !== 'setup') return match
  return { ...match, status: 'playing' }
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
  return !currentList.includes(itemId) && !previousItems.includes(itemId)
}

export function chooseNinja(match: MatchState, ninjaId: string): MatchState {
  const { current } = match
  if (!canSelectNinja(match, ninjaId) || !current.phase.turn) return match

  const next = cloneRound(current)
  if (current.phase.kind === 'ban') {
    next.bans[current.phase.turn].push(ninjaId)
    const nextIndex = current.phase.index + 1
    next.phase = nextIndex < banOrder.length
      ? { kind: 'ban', turn: banOrder[nextIndex], index: nextIndex, expiresAt: null }
      : { kind: 'pick', turn: pickOrder[0], index: 0, expiresAt: null }
  } else if (current.phase.kind === 'pick') {
    next.picks[current.phase.turn].push(ninjaId)
    const nextIndex = current.phase.index + 1
    next.phase = nextIndex < pickOrder.length
      ? { kind: 'pick', turn: pickOrder[nextIndex], index: nextIndex, expiresAt: null }
      : { kind: 'scroll', turn: null, index: 0, expiresAt: Date.now() + 60_000 }
  }
  return { ...match, current: next }
}

export function chooseTimedItem(match: MatchState, itemId: string, seat: Seat): MatchState {
  const { current } = match
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

export function expireTimedPhase(match: MatchState): MatchState {
  const { phase } = match.current
  if (!phase.expiresAt || Date.now() < phase.expiresAt) return match
  const next = cloneRound(match.current)
  if (phase.kind === 'scroll') {
    next.phase = { kind: 'summon', turn: null, index: 0, expiresAt: Date.now() + 60_000 }
  } else if (phase.kind === 'summon') {
    next.phase = { kind: 'complete', turn: null, index: 0, expiresAt: null }
    return { ...match, status: 'round-complete', current: next }
  }
  return { ...match, current: next }
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
  if (blueWins === 2 || redWins === 2 || history.length === 3) {
    return { ...match, history, status: 'match-complete' }
  }
  const initialBans = match.settings.roundBan
    ? { blue: [], red: [] }
    : { blue: [...history[0].bans.blue], red: [...history[0].bans.red] }
  return {
    ...match,
    history,
    status: 'playing',
    current: newRound(history.length + 1, match.settings.roundBan, initialBans),
  }
}

export function resetMatch(match: MatchState): MatchState {
  return createMatch(match.data, match.settings.title, match.settings.roundBan)
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
