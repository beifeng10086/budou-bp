import test from 'node:test'
import assert from 'node:assert/strict'
import { canSelectNinja, canSelectTimedItem, chooseNinja, chooseTimedBatch, chooseTimedItem, createMatch, endMatch, expireTimedPhase, nextRoundProblem, recordWinner, resetMatch, startMatch, startNextRound } from '../src/bp.ts'
import { applyRoomAction } from '../src/room-actions.ts'
import type { BestOf, DataPackage, MatchState, Seat } from '../src/types.ts'

const items = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: prefix + i, name: prefix + i, tags: [] }))
const data: DataPackage = { id: 'test', name: 'test', updatedAt: '2026-10-13', ninjas: items('n', 100), scrolls: items('m', 30), summons: items('t', 30) }
function finishRound(match: MatchState, winner: Seat): MatchState {
  while (match.status === 'playing') {
    const expired = { ...match, current: { ...match.current, phase: { ...match.current.phase, expiresAt: Date.now() - 1 } } }
    match = expireTimedPhase(expired, () => .4)
    assert.notEqual(match, expired)
  }
  return recordWinner(match, winner)
}
test('every ban/pick is 60 seconds and timeout chooses only legal ninjas', () => {
  let match = startMatch(createMatch(data, 'test', true))
  for (let i = 0; i < 10; i++) {
    assert.ok(match.current.phase.expiresAt! - Date.now() > 59000)
    assert.equal(expireTimedPhase(match), match)
    const expired = { ...match, current: { ...match.current, phase: { ...match.current.phase, expiresAt: Date.now() - 1 } } }
    match = expireTimedPhase(expired, () => .99)
    const selected = [...match.current.bans.blue, ...match.current.bans.red, ...match.current.picks.blue, ...match.current.picks.red]
    assert.equal(selected.length, i + 1)
    assert.equal(new Set(selected).size, selected.length)
  }
  assert.equal(match.current.phase.kind, 'scroll')
  match = chooseTimedItem(match, data.scrolls[0].id, 'blue')
  match = expireTimedPhase({ ...match, current: { ...match.current, phase: { ...match.current.phase, expiresAt: Date.now() - 1 } } }, () => .9)
  assert.equal(match.current.scrolls.blue[0], data.scrolls[0].id)
  assert.equal(match.current.scrolls.blue.length, 3)
  assert.equal(match.current.scrolls.red.length, 3)
  assert.equal(new Set(match.current.scrolls.blue).size, 3)
  assert.equal(match.current.phase.kind, 'summon')
  match = expireTimedPhase({ ...match, current: { ...match.current, phase: { ...match.current.phase, expiresAt: Date.now() - 1 } } })
  assert.equal(match.status, 'round-complete')
  assert.equal(match.current.summons.blue.length, 3)
  assert.equal(match.current.summons.red.length, 3)
})
for (const bestOf of [3, 5, 7] as BestOf[]) test('BO' + bestOf + ' finishes at required wins', () => {
  let match = startMatch(createMatch(data, 'test', true, { bestOf }))
  const required = (bestOf + 1) / 2
  for (let i = 0; i < required; i++) {
    match = startNextRound(finishRound(match, 'blue'))
    assert.equal(match.status, i === required - 1 ? 'match-complete' : 'playing')
  }
  assert.equal(match.history.length, required)
})
test('infinite series preserves used ninjas, carries bans and allows independent repeat settings', () => {
  let match = finishRound(startMatch(createMatch(data, 'test', false, { bestOf: 0, repeatScrolls: true, repeatSummons: false })), 'blue')
  const first = match.current
  match = startNextRound(match)
  assert.equal(match.current.phase.kind, 'pick')
  assert.deepEqual(match.current.bans, first.bans)
  assert.equal(canSelectNinja(match, first.picks.red[0]), false)
  assert.equal(canSelectTimedItem(match, first.scrolls.blue[0], 'blue', 'scroll'), true)
  assert.equal(canSelectTimedItem(match, first.summons.blue[0], 'blue', 'summon'), false)
  for (let i = 0; i < 4; i++) match = startNextRound(finishRound(match, 'blue'))
  assert.equal(match.status, 'playing')
  assert.equal(match.current.number, 6)
})
test('a repeated secret scroll cannot appear twice within the same round', () => {
  let match = startMatch(createMatch(data, 'test', true, { repeatScrolls: true }))
  for (let i = 0; i < 10; i++) match = chooseNinja(match, data.ninjas[i].id)
  match = chooseTimedItem(match, data.scrolls[0].id, 'blue')
  assert.equal(chooseTimedItem(match, data.scrolls[0].id, 'blue'), match)
  assert.notEqual(chooseTimedItem(match, data.scrolls[0].id, 'red'), match)
})
test('pool exhaustion requires host reset or end, never automatically clears history', () => {
  const small = { ...data, scrolls: data.scrolls.slice(0, 3) }
  const match = finishRound(startMatch(createMatch(small, 'test', true, { bestOf: 0 })), 'blue')
  assert.match(nextRoundProblem(match), /秘卷/)
  assert.equal(startNextRound(match), match)
  assert.equal(applyRoomAction(match, { action: 'new-match' }, 'red'), undefined)
  assert.equal(applyRoomAction(match, { action: 'end' }, 'red'), undefined)
  assert.equal(endMatch(match).history.length, 1)
  assert.equal(resetMatch(match).status, 'setup')
  assert.equal(resetMatch(match).settings.bestOf, 0)
})
test('names and seat swaps obey host and preparation permissions', () => {
  let match = createMatch(data, 'test', true, { playerNames: { blue: '北风', red: '白面具' } })
  match = applyRoomAction(match, { action: 'rename', name: '白面具二' }, 'red')!
  assert.equal(match.settings.playerNames?.blue, '北风')
  assert.equal(applyRoomAction(match, { action: 'swap-seats' }, 'red'), undefined)
  match = applyRoomAction(match, { action: 'swap-seats' }, 'blue')!
  assert.equal(match.settings.playerNames?.blue, '白面具二')
  assert.equal(applyRoomAction(startMatch(match), { action: 'swap-seats' }, 'blue'), undefined)
})

test('late commands cannot override a timed-out turn', () => {
  const match = startMatch(createMatch(data, 'test', true))
  match.current.phase.expiresAt = Date.now() - 1
  assert.equal(applyRoomAction(match, { action: 'ninja', itemId: data.ninjas[0].id }, 'blue'), undefined)
  assert.equal(expireTimedPhase(match).current.bans.blue.length, 1)
})

test('ordered batches are atomic, independent by seat, reject stale phases and enforce history', () => {
  const shared = { ...data, scrolls: items('same', 30), summons: items('same', 30) }
  let match = startMatch(createMatch(shared, 'batch', true))
  for (let i = 0; i < 10; i++) match = chooseNinja(match, data.ninjas[i].id)
  for (const ids of [[], ['same0', 'same1'], ['same0', 'same0', 'same2'], ['same0', 'same1', 'unknown'], 'same0']) {
    assert.equal(chooseTimedBatch(match, ids, 'blue'), match)
    assert.deepEqual(match.current.scrolls.blue, [])
  }
  const message = { action: 'timed-batch' as const, phase: 'scroll' as const, round: 1, itemIds: ['same2', 'same0', 'same1'] }
  assert.equal(applyRoomAction(match, { ...message, round: 2 }, 'blue'), undefined)
  match = applyRoomAction(match, message, 'blue')!
  assert.deepEqual(match.current.scrolls.blue, message.itemIds)
  assert.deepEqual(match.current.scrolls.red, [])
  assert.equal(applyRoomAction(match, message, 'blue'), undefined)
  match = applyRoomAction(match, message, 'red')!
  assert.equal(match.current.phase.kind, 'summon')
  assert.equal(applyRoomAction(match, message, 'blue'), undefined)
  assert.deepEqual(match.current.summons.blue, [])
  match = chooseTimedBatch(match, ['same0', 'same2', 'same1'], 'blue')
  match = chooseTimedBatch(match, ['same1', 'same2', 'same0'], 'red')
  match = startNextRound(recordWinner(match, 'red'))
  for (let i = 10; i < 20; i++) match = chooseNinja(match, data.ninjas[i].id)
  assert.equal(chooseTimedBatch(match, message.itemIds, 'blue'), match)
  assert.notEqual(chooseTimedBatch(match, ['same3', 'same4', 'same5'], 'blue'), match)
})

test('no timer is opt-in and stays off across every transition, round and reset', () => {
  assert.equal(createMatch(data, 'default', true).settings.noTimer, false)
  let match = startMatch(createMatch(data, 'untimed', true, { noTimer: true, bestOf: 0, repeatScrolls: true, repeatSummons: true }))
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 10; i++) {
      assert.equal(match.current.phase.expiresAt, null)
      assert.equal(expireTimedPhase(match), match)
      match = chooseNinja(match, data.ninjas[round * 10 + i].id)
    }
    for (const kind of ['scroll', 'summon'] as const) {
      assert.equal(match.current.phase.expiresAt, null)
      for (const seat of ['blue', 'red'] as const) match = chooseTimedBatch(match, (kind === 'scroll' ? data.scrolls : data.summons).slice(0, 3).map(item => item.id), seat)
    }
    match = startNextRound(recordWinner(match, 'blue'))
    assert.equal(match.current.phase.expiresAt, null)
  }
  assert.equal(resetMatch(match).settings.noTimer, true)
})
