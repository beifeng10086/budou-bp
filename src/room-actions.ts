import { chooseNinja, chooseTimedBatch, chooseTimedItem, endMatch, nextRoundProblem, recordWinner, renamePlayer, resetMatch, startMatch, startNextRound, swapPlayerNames } from './bp'
import type { MatchState, RoomRole, Seat } from './types'

export type RoomAction = 'start' | 'ninja' | 'timed' | 'timed-batch' | 'winner' | 'next' | 'new-match' | 'swap-seats' | 'rename' | 'end'
export interface ActionMessage { action?: RoomAction; itemId?: string; itemIds?: string[]; round?: number; phase?: 'scroll' | 'summon'; winner?: Seat; name?: string }

export function applyRoomAction(match: MatchState, message: ActionMessage, seat: RoomRole): MatchState | undefined {
  if ((message.action === 'ninja' || message.action === 'timed' || message.action === 'timed-batch') && match.current.phase.expiresAt && Date.now() >= match.current.phase.expiresAt) return undefined
  const host = match.settings.thirdPartyHost ? seat === 'host' : seat === 'blue'
  let next: MatchState | undefined
  switch (message.action) {
    case 'start': next = host ? startMatch(match) : undefined; break
    case 'ninja': next = match.current.phase.turn === seat && message.itemId ? chooseNinja(match, message.itemId) : undefined; break
    case 'timed': next = seat !== 'host' && message.itemId ? chooseTimedItem(match, message.itemId, seat) : undefined; break
    case 'timed-batch': next = seat !== 'host' && message.round === match.current.number && message.phase === match.current.phase.kind ? chooseTimedBatch(match, message.itemIds, seat) : undefined; break
    case 'winner': next = host && (message.winner === 'blue' || message.winner === 'red') ? recordWinner(match, message.winner) : undefined; break
    case 'next': next = host ? startNextRound(match) : undefined; break
    case 'new-match': next = host && (match.status === 'match-complete' || Boolean(nextRoundProblem(match))) ? resetMatch(match) : undefined; break
    case 'end': next = host ? endMatch(match) : undefined; break
    case 'rename': next = seat !== 'host' ? renamePlayer(match, seat, message.name) : undefined; break
    case 'swap-seats': next = host && match.status === 'setup' ? swapPlayerNames(match) : undefined; break
  }
  return next === match ? undefined : next
}
