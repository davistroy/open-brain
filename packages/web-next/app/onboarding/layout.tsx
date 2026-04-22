import type { ReactNode } from 'react';

/**
 * Onboarding layout — full-bleed, outside the shell.
 * No SideNav or TopNav — blank canvas for the wizard experience.
 * Body background is overridden to ivory-light for the editorial feel.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[--color-ivory-light]">
      {children}
    </div>
  );
}
