import { useMemo } from 'react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import type { DataSource } from '../data/source';
import type { StaticWorld } from '../data/staticWorld';
import { AppContext } from './context';
import { PAGE_ROUTES } from './routes';
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
  const router = useMemo(() => createBrowserRouter([{ element: <Layout />, children: PAGE_ROUTES }]), []);
  const ctx = useMemo(() => ({ source, world }), [source, world]);
  return (
    <AppContext.Provider value={ctx}>
      <RouterProvider router={router} />
    </AppContext.Provider>
  );
}
