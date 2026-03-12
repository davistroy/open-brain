import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from '@/components/Layout';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Search = lazy(() => import('@/pages/Search'));
const Timeline = lazy(() => import('@/pages/Timeline'));
const Entities = lazy(() => import('@/pages/Entities'));
const EntityDetail = lazy(() => import('@/pages/EntityDetail'));
const Briefs = lazy(() => import('@/pages/Briefs'));
const Board = lazy(() => import('@/pages/Board'));
const Voice = lazy(() => import('@/pages/Voice'));
const Intelligence = lazy(() => import('@/pages/Intelligence'));
const Help = lazy(() => import('@/pages/Help'));
const Settings = lazy(() => import('@/pages/Settings'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="search" element={<Search />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="entities" element={<Entities />} />
          <Route path="entities/:id" element={<EntityDetail />} />
          <Route path="briefs" element={<Briefs />} />
          <Route path="board" element={<Board />} />
          <Route path="voice" element={<Voice />} />
          <Route path="intelligence" element={<Intelligence />} />
          <Route path="help" element={<Help />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
