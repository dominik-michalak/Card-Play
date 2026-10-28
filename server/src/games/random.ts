import { getRandomValues } from 'node:crypto';
import type { RandomSource } from '@cardplay/shared';

// cryptographically secure source in [0, 1), used for shuffling in production
export const secureRandom: RandomSource = () => getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
