import Link from 'next/link';
import { Ghost } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

/**
 * 404 — not found page. Editorial voice.
 * Rendered outside the shell layout (no TopNav/SideNav) — standalone centered page.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg-layout-main flex items-center justify-center">
      <EmptyState
        icon={Ghost}
        title="Nothing here"
        description="The page you're looking for doesn't exist. Maybe it never did."
        action={
          <Link href="/dashboard">
            <Button variant="secondary">Back to Dashboard</Button>
          </Link>
        }
      />
    </div>
  );
}
