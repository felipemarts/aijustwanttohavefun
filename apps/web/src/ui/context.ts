import { createContext, useContext } from 'react';
import type { DataSource } from '../data/source';
import type { StaticWorld } from '../data/staticWorld';

export type AppContextValue = { source: DataSource; world: StaticWorld };

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext missing');
  return v;
}
