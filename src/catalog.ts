import type { GameItem } from './types'

const rankOrder: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 }

export function sortNinjas(items: GameItem[]): GameItem[] {
  // Stable sorting preserves the package's order within each rank.
  return [...items].sort((left, right) => (rankOrder[left.rank ?? ''] ?? 4) - (rankOrder[right.rank ?? ''] ?? 4))
}
