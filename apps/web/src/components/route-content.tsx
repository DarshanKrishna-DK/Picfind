import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Loading } from './ui';

export function RouteContent() {
  const { pathname } = useLocation();
  return (
    <Suspense key={pathname} fallback={<Loading />}>
      <Outlet />
    </Suspense>
  );
}
