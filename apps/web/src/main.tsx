import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import staticWorld from 'virtual:ajwf-world';
import { config } from './config';
import type { DataSource } from './data/source';
import { store } from './data/store';
import { WsSource } from './data/wsSource';
import { i18n } from './i18n/store';
import { controller } from './map/controller';
import { App } from './ui/App';
import './ui/styles.css';

/** The demo simulation is its own chunk: real visitors never download it. */
async function makeSource(): Promise<DataSource> {
  if (!config.mock) return new WsSource();
  const { MockSource } = await import('./data/mock');
  return new MockSource(staticWorld, { stress: config.stress, phase: config.phase, builtAll: config.builtAll });
}

i18n.init({ offline: config.mock });
void makeSource().then((source) => {
  store.start(source);
  if (config.debug) Object.assign(window, { ajwf: { store, source, config, controller } });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App source={source} world={staticWorld} />
    </StrictMode>,
  );
});
