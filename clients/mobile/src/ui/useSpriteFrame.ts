import { useEffect, useState } from 'react';
import type { CharacterStatus } from '../core/types';
import { useReducedMotion } from '../state/hooks';
import { frameAt, moodFor, tickMs } from './sprite-math';

/** The current frame for a character's status, animated on a timer unless the user asked for reduced motion. */
export function useSpriteFrame(status: CharacterStatus): number {
  const reduced = useReducedMotion();
  const mood = moodFor(status);
  const ms = tickMs(mood, reduced);
  const [tick, setTick] = useState(() => Math.floor(Math.random() * 16));
  useEffect(() => {
    if (!ms) return;
    const t = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return frameAt(mood, tick, reduced);
}
