'use client';

export type StepId = 1 | 2 | 3 | 4;

interface Step {
  id: StepId;
  label: string;
}

const STEPS: Step[] = [
  { id: 1, label: 'Introduce yourself' },
  { id: 2, label: 'Connect your first source' },
  { id: 3, label: 'Choose a capture habit' },
  { id: 4, label: 'Shape your first brief' },
];

interface StepIndicatorProps {
  currentStep: StepId;
  completedSteps: Set<StepId>;
}

/**
 * StepIndicator — 4-station progress rail for the onboarding wizard.
 *
 * States:
 *  - done:    step id is in completedSteps (filled circle + check, muted label)
 *  - active:  id === currentStep (book-cloth filled circle, bold label)
 *  - pending: not reached yet (hollow circle, muted label)
 *
 * Connector lines between stations: full-width divider, colored terracotta when
 * the step to the left is done, gray otherwise.
 */
export function StepIndicator({ currentStep, completedSteps }: StepIndicatorProps) {
  return (
    <nav aria-label="Onboarding progress" className="w-full">
      <ol className="flex items-start gap-0">
        {STEPS.map((step, index) => {
          const isDone = completedSteps.has(step.id);
          const isActive = step.id === currentStep;
          const isPending = !isDone && !isActive;
          const isLast = index === STEPS.length - 1;

          return (
            <li key={step.id} className="flex-1 flex flex-col items-center min-w-0">
              {/* Station row: connector-left + circle + connector-right */}
              <div className="flex items-center w-full">
                {/* Left connector */}
                <div
                  className="h-px flex-1 transition-colors duration-300"
                  style={{
                    backgroundColor: index === 0
                      ? 'transparent'
                      : completedSteps.has(STEPS[index - 1].id)
                        ? 'var(--color-book-cloth)'
                        : 'var(--color-cloud-light)',
                  }}
                />

                {/* Circle */}
                <div
                  aria-current={isActive ? 'step' : undefined}
                  className="relative flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-300"
                  style={{
                    backgroundColor: isDone || isActive
                      ? 'var(--color-book-cloth)'
                      : 'var(--color-bg-container)',
                    border: isPending
                      ? '2px solid var(--color-cloud-medium)'
                      : '2px solid var(--color-book-cloth)',
                  }}
                >
                  {isDone ? (
                    // Checkmark SVG
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2 6l3 3 5-5"
                        stroke="white"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <span
                      className="text-[10px] font-semibold leading-none"
                      style={{
                        color: isActive ? 'white' : 'var(--color-cloud-dark)',
                        fontFamily: 'var(--font-family-monospace)',
                      }}
                    >
                      {step.id}
                    </span>
                  )}
                </div>

                {/* Right connector */}
                <div
                  className="h-px flex-1 transition-colors duration-300"
                  style={{
                    backgroundColor: isLast
                      ? 'transparent'
                      : isDone
                        ? 'var(--color-book-cloth)'
                        : 'var(--color-cloud-light)',
                  }}
                />
              </div>

              {/* Label below station */}
              <span
                className="mt-2 text-center text-[11px] leading-tight px-1 transition-colors duration-300"
                style={{
                  color: isActive
                    ? 'var(--color-text-heading)'
                    : isDone
                      ? 'var(--color-book-cloth)'
                      : 'var(--color-text-small)',
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: 'var(--font-family-base)',
                }}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
