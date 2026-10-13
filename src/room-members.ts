import type { RoomRole, Seat } from './types'

export type RoomSeats = Partial<Record<RoomRole, string>>

export function roleForToken(seats: RoomSeats, token: string): RoomRole | undefined {
  return (['host', 'blue', 'red'] as const).find(role => seats[role] === token)
}

export function availableSeat(seats: RoomSeats, requested: string | null): Seat | undefined {
  if (requested === 'blue' || requested === 'red') return seats[requested] ? undefined : requested
  return !seats.blue ? 'blue' : !seats.red ? 'red' : undefined
}

export function creatorSeats(thirdPartyHost: boolean | undefined, token: string): RoomSeats {
  return thirdPartyHost ? { host: token } : { blue: token }
}
