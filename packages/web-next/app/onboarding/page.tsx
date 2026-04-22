import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';

/**
 * /onboarding — First-run onboarding page.
 *
 * This route is OUTSIDE the (shell) layout group, so it renders without
 * SideNav or TopNav. The OnboardingWizard is a client component that manages
 * step state via useState + localStorage (resumes on refresh).
 */
export default function OnboardingPage() {
  return <OnboardingWizard />;
}
