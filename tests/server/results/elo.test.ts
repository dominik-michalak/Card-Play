import { describe, expect, it } from 'vitest';
import { ELO_K, eloGain } from '../../../server/src/modules/results/elo';

describe('eloGain', () => {
  it('uses a constant K of 32', () => {
    expect(ELO_K).toBe(32);
  });

  it('gives half of K to the winner between equal players', () => {
    expect(eloGain(1000, 1000)).toBe(16);
  });

  it('rewards an upset more than an expected win', () => {
    expect(eloGain(1000, 1200)).toBe(24);
    expect(eloGain(1200, 1000)).toBe(8);
  });

  it('stays below K however lopsided the pairing', () => {
    expect(eloGain(3000, 800)).toBe(0);
    expect(eloGain(800, 3000)).toBe(32);
  });
});
