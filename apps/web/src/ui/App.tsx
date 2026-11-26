import { useMemo } from 'react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import type { DataSource } from '../data/source';
import type { StaticWorld } from '../data/staticWorld';
import { AgentPage } from './AgentPage';
import { AppContext } from './context';
import { LivePage } from './LivePage';
import { NotFound } from './NotFound';
import { TopBar } from './TopBar';

function Layout() {
  return (
    <div className="app">
      <TopBar />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

export function App({ source, world }: { source: DataSource; world: StaticWorld }) {
  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          element: <Layout />,
          children: [
            { path: '/', element: <LivePage /> },
            { path: '/a/:name', element: <AgentPage /> },
            { path: '*', element: <NotFound /> },
          ],
        },
      ]),
    [],
  );
  const ctx = useMemo(() => ({ source, world }), [source, world]);
  return (
    <AppContext.Provider value={ctx}>
      <RouterProvider router={router} />
    </AppContext.Provider>
  );
}
