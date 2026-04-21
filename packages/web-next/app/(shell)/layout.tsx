import { type ReactNode } from 'react';
import { TopNav } from '@/components/nav/top-nav';
import { SideNav } from '@/components/nav/side-nav';

/**
 * Shell layout — wraps all main application routes.
 * Structure: sticky TopNav (56px) + flex row of SideNav (280px) + scrollable main.
 * Background: parchment (ivory-medium) via data-wash="parchment" on <html>.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col min-h-screen bg-bg-layout-main">
      <TopNav />
      <div className="flex flex-1 min-h-0">
        <SideNav />
        <main className="flex-1 min-w-0 overflow-y-auto p-[22px_32px_48px]">
          <div className="max-w-[1280px] mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
