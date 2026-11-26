import { checkAgentName, type Rng } from '@ajwf/shared';

const START = ['Al', 'Bran', 'Cael', 'Dor', 'El', 'Fen', 'Gar', 'Hal', 'Ise', 'Jor', 'Kae', 'Lir', 'Mor', 'Nym', 'Or', 'Per', 'Quin', 'Ros', 'Syl', 'Tor', 'Ul', 'Vey', 'Wren', 'Yse', 'Zan', 'Bel', 'Thal', 'Ari', 'Mae', 'Ced'];
const MIDDLE = ['a', 'e', 'i', 'o', 'ae', 'ia', 'or', 'an', 'el', 'is', 'un', 'ar'];
const END = ['dric', 'wyn', 'ra', 'mir', 'thas', 'lin', 'dor', 'wen', 'ric', 'nor', 'ys', 'iel', 'ane', 'th', 'mund', 'ka', 'ven', 'dra', 'gorn', 'sa'];
const EPITHET = ['Ash', 'Brook', 'Stone', 'Thorn', 'Vale', 'Frost', 'Moss', 'Ember', 'Reed', 'Hollow', 'Fern', 'Wick'];

/** A plausible fantasy name ("Caelwyn", "Mordric_Thorn") that passes the server's name rules. */
export function fantasyName(rng: Rng): string {
  for (;;) {
    const middle = rng.next() < 0.45 ? rng.pick(MIDDLE) : '';
    let name = rng.pick(START) + middle + rng.pick(END);
    if (rng.next() < 0.3) name += `_${rng.pick(EPITHET)}`;
    if (checkAgentName(name).ok) return name;
  }
}

/** Distinct names in a seeded order; `taken` is shared so retries after NAME_TAKEN never repeat a name. */
export function nameGenerator(rng: Rng, taken = new Set<string>()): () => string {
  return () => {
    for (;;) {
      const name = fantasyName(rng);
      const key = name.toLowerCase();
      if (taken.has(key)) continue;
      taken.add(key);
      return name;
    }
  };
}
