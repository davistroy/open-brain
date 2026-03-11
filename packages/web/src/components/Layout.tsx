import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Search,
  Clock,
  Users,
  FileText,
  Gavel,
  Lightbulb,
  Mic,
  Settings,
  Brain,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/timeline', label: 'Timeline', icon: Clock },
  { to: '/entities', label: 'Entities', icon: Users },
  { to: '/briefs', label: 'Briefs', icon: FileText },
  { to: '/board', label: 'Board', icon: Gavel },
  { to: '/intelligence', label: 'Intelligence', icon: Lightbulb },
  { to: '/voice', label: 'Voice', icon: Mic },
];

const bottomNavItems: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings },
];

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      {item.label}
    </NavLink>
  );
}

export default function Layout() {
  const location = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r bg-card">
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Brain className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">Open Brain</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}
        </nav>

        <Separator />

        <div className="p-3 space-y-1">
          {bottomNavItems.map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex h-14 border-t bg-card">
        {[...navItems.slice(0, 5), ...bottomNavItems].map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors',
                isActive ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-14 md:pb-0">
        <div className="container mx-auto max-w-5xl p-4 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
