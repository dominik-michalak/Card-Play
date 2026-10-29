export const ELO_K = 32;

// rating points the winner gains; the loser loses the same amount
export function eloGain(winnerElo: number, loserElo: number): number {
  const expectedWin = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  return Math.round(ELO_K * (1 - expectedWin));
}
