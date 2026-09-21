import test from 'node:test'
import assert from 'node:assert/strict'
import { sortNinjas } from '../src/catalog.ts'

test('rank order is S A B C, preserves same-rank package order and does not mutate data', () => {
  const items = ['C', 'A', 'S', 'B', 'S', '?'].map((rank, index) => ({ id: String(index), name: String(index), rank, tags: [] }))
  const original = JSON.stringify(items)
  assert.deepEqual(sortNinjas(items).map(item => item.id), ['2', '4', '1', '3', '0', '5'])
  assert.equal(JSON.stringify(items), original)
})
