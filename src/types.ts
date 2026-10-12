export type Seat = 'blue' | 'red'
export type PhaseKind = 'ban' | 'pick' | 'scroll' | 'summon' | 'complete'
export type BestOf = 3 | 5 | 7 | 0

export interface GameItem {
  id: string
  name: string
  rank?: string
  tags: string[]
  image?: string
  imageSource?: string
  artwork?: string
  artworkSource?: string
  officialId?: string
  aliases?: string[]
  releaseDate?: string
  description?: string
  sourceUrls?: string[]
}

export interface DataPackage {
  id: string
  name: string
  updatedAt: string
  source?: string
  ninjas: GameItem[]
  scrolls: GameItem[]
  summons: GameItem[]
}

export interface RoomSettings {
  title: string
  roundBan: boolean
  bestOf?: BestOf
  playerNames?: Record<Seat, string>
  turnSeconds?: number
  noTimer?: boolean
  repeatScrolls?: boolean
  repeatSummons?: boolean
}

export interface Phase {
  kind: PhaseKind
  turn: Seat | null
  index: number
  expiresAt: number | null
}

export interface RoundState {
  number: number
  bans: Record<Seat, string[]>
  picks: Record<Seat, string[]>
  scrolls: Record<Seat, string[]>
  summons: Record<Seat, string[]>
  phase: Phase
  winner: Seat | null
}

export interface MatchState {
  settings: RoomSettings
  data: DataPackage
  status: 'setup' | 'playing' | 'round-complete' | 'match-complete'
  current: RoundState
  history: RoundState[]
}

export interface StoredPackage extends DataPackage {
  isCustom?: boolean
}
