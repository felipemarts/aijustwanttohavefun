import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import staticWorld from 'virtual:ajwf-world';
import { config } from './config';
import { MockSource } from './data/mock';
import type { DataSource } from './data/source';
import { store } from './data/store';
import { WsSource } from './data/wsSource';
import { i18n } from './i18n/store';
import { controller } from './map/controller';
import { App } from './ui/App';
import './ui/styles.css';

const source: DataSource = config.mock
  ? new MockSource(staticWorld, { stress: config.stress, phase: config.phase })
  : new WsSource();

i18n.init({ offline: config.mock });
store.start(source);

if (config.debug) Object.assign(window, { ajwf: { store, source, config, controller } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App source={source} world={staticWorld} />
  </StrictMode>,
);
