// all durations in milliseconds; tests shrink them, production uses the defaults
export type Timings = {
  // from "everyone ready" to the start of the game
  countdownMs: number;
  // decision window of a game (rules: 30 s)
  turnMs: number;
  // how long a disconnected player may be away before forfeiting (rules: 60 s)
  disconnectMs: number;
  // how long a player who dropped out of a waiting room keeps the seat
  lobbyGraceMs: number;
};

export const DEFAULT_TIMINGS: Timings = {
  countdownMs: 3000,
  turnMs: 30_000,
  disconnectMs: 60_000,
  lobbyGraceMs: 30_000,
};
