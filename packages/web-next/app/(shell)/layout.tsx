import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { TopNav } from '@/components/nav/top-nav';
import { SideNav } from '@/components/nav/side-nav';
import { AudioPlayerMount } from '@/components/audio/AudioPlayer';

// ---------------------------------------------------------------------------
// First-run detection — server-side settings read
// ---------------------------------------------------------------------------

/**
 * Checks whether the user has completed onboarding by reading the
 * `onboarding_completed` setting directly from the core-api.
 *
 * Returns `true` if onboarding is complete, `false` if the user should be
 * redirected to /onboarding. Fails open — if the API is unreachable, returns
 * `true` (no redirect) to prevent an infinite redirect loop on a down API.
 */
async function isOnboardingComplete(): Promise<boolean> {
  // Determine the API base URL. In the Docker container, NEXT_PUBLIC_API_URL
  // is set to the internal core-api address. In dev it falls back to localhost.
  const apiBase =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ??
    'http://localhost:3002/api/v1';

  try {
    const res = await fetch(`${apiBase}/settings/onboarding_completed`, {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'web-ui',
        'Content-Type': 'application/json',
      },
      // Do not cache — this must reflect current state on every shell navigation.
      cache: 'no-store',
    });

    if (res.status === 404) {
      // Key not set yet — first-time user.
      return false;
    }

    if (!res.ok) {
      // Non-404 error (500, 503, etc.) — fail open, do not redirect.
      return true;
    }

    const data = (await res.json()) as { key: string; value: unknown };
    return data.value === true;
  } catch {
    // Network error / API unreachable — fail open, never redirect into a loop.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Shell layout RSC
// ---------------------------------------------------------------------------

/**
 * Shell layout — wraps all main application routes.
 * Structure: sticky TopNav (56px) + flex row of SideNav (280px) + scrollable main.
 * Background: parchment (ivory-medium) via data-wash="parchment" on <html>.
 *
 * First-run gate: if `onboarding_completed` setting is absent or false, the
 * user is redirected to /onboarding before the shell renders. The check is
 * server-side (RSC) so there is no client-side flash. The check fails open —
 * if the settings API is unreachable, the shell renders normally.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const complete = await isOnboardingComplete();
  if (!complete) {
    redirect('/onboarding');
  }

  return (
    <div className="flex flex-col min-h-screen bg-bg-layout-main">
      <TopNav />
      <div className="flex flex-1 min-h-0">
        <SideNav />
        <main className="flex-1 min-w-0 overflow-y-auto p-[22px_32px_48px]">
          <div className="max-w-[1280px] mx-auto">{children}</div>
        </main>
      </div>
      {/* Floating audio mini-player — persists across navigation. Client component. */}
      <AudioPlayerMount />
    </div>
  );
}
