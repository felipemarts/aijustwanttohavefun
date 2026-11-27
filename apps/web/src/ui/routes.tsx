/**
 * The spectator's pages. `/` (the live map) is in the main bundle; every other page is a lazy chunk so the first
 * load of the map does not grow.
 */
import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import type { RouteObject } from 'react-router-dom';
import { useT } from '../i18n/store';
import { LivePage } from './LivePage';
import { NotFound } from './NotFound';

const VillagePage = lazy(() => import('../pages/VillagePage'));
const GazettePage = lazy(() => import('../pages/GazettePage'));
const SecretsPage = lazy(() => import('../pages/SecretsPage'));
const HighlightsPage = lazy(() => import('../pages/HighlightsPage'));
const LeaderboardPage = lazy(() => import('../pages/LeaderboardPage'));
const BoardPage = lazy(() => import('../pages/BoardPage'));
const AgentProfilePage = lazy(() => import('../pages/AgentProfilePage'));
const GuildPage = lazy(() => import('../pages/GuildPage'));
const TimelapsePage = lazy(() => import('../pages/TimelapsePage'));
const OwnerPage = lazy(() => import('../pages/OwnerPage'));
const ClaimPage = lazy(() => import('../pages/ClaimPage'));

/** Shown while a page's chunk loads (its own stylesheet is not there yet: only main-bundle classes here). */
function PageFallback() {
  const tr = useT();
  return (
    <div className="page page-scroll">
      <div className="page-inner">
        <div className="state-box is-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{tr.t('ui.common.loading')}</span>
          <div className="skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}

function lazyPage(C: ComponentType): ReactNode {
  return (
    <Suspense fallback={<PageFallback />}>
      <C />
    </Suspense>
  );
}

/** Every route of the spectator app, in the order the router matches them. */
export const PAGE_ROUTES: RouteObject[] = [
  { path: '/', element: <LivePage /> },
  { path: '/village', element: lazyPage(VillagePage) },
  { path: '/gazette', element: lazyPage(GazettePage) },
  { path: '/gazette/:date', element: lazyPage(GazettePage) },
  { path: '/secrets', element: lazyPage(SecretsPage) },
  { path: '/highlights', element: lazyPage(HighlightsPage) },
  { path: '/h/:id', element: lazyPage(HighlightsPage) },
  { path: '/leaderboard', element: lazyPage(LeaderboardPage) },
  { path: '/board', element: lazyPage(BoardPage) },
  { path: '/a/:name', element: lazyPage(AgentProfilePage) },
  { path: '/g/:name', element: lazyPage(GuildPage) },
  { path: '/timelapse', element: lazyPage(TimelapsePage) },
  { path: '/owner', element: lazyPage(OwnerPage) },
  { path: '/claim/:token', element: lazyPage(ClaimPage) },
  { path: '*', element: <NotFound /> },
];

/** The main navigation: path and the `ui.nav.*` key of its label. */
export const NAV: readonly { to: string; key: string }[] = [
  { to: '/', key: 'live' },
  { to: '/village', key: 'village' },
  { to: '/gazette', key: 'gazette' },
  { to: '/highlights', key: 'highlights' },
  { to: '/secrets', key: 'secrets' },
  { to: '/leaderboard', key: 'leaderboard' },
  { to: '/board', key: 'board' },
  { to: '/timelapse', key: 'timelapse' },
];
