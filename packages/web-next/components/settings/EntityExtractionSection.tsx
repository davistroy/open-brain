'use client';

/**
 * EntityExtractionSection — Settings page entity extraction controls.
 *
 * Toggles for:
 *   - entity_extract_locations    (boolean)
 *   - entity_extract_monetary     (boolean)
 *
 * Slider for:
 *   - entity_confidence_threshold  (number, 0–1, step 0.05)
 *
 * Each reads/writes via settingsApi. Optimistic updates via TanStack Query
 * mutation + setQueryData.
 *
 * Client component (interactivity required).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/design-system';
import { settingsApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Toggle row
// ---------------------------------------------------------------------------

interface ToggleRowProps {
  label: string;
  description: string;
  settingKey: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (key: string, next: boolean) => void;
}

function ToggleRow({ label, description, settingKey, checked, disabled = false, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-center gap-4 py-[12px] border-b border-cloud-light last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-heading leading-[18px]">{label}</div>
        <div className="text-[12px] text-text-body-secondary font-light mt-[1px] leading-[16px]">
          {description}
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(settingKey, !checked)}
        className={[
          'relative shrink-0 w-[36px] h-[20px] rounded-full border',
          'transition-[background,border-color] duration-150 cursor-pointer',
          'focus-visible:outline-2 focus-visible:outline-book-cloth focus-visible:outline-offset-1',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          checked
            ? 'bg-book-cloth border-book-cloth'
            : 'bg-cloud-medium border-cloud-dark',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span
          className={[
            'absolute top-[2px] w-[14px] h-[14px] bg-white',
            'transition-[left] duration-150',
            checked ? 'left-[18px]' : 'left-[2px]',
          ]
            .filter(Boolean)
            .join(' ')}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence slider row
// ---------------------------------------------------------------------------

interface SliderRowProps {
  label: string;
  description: string;
  settingKey: string;
  value: number;
  disabled?: boolean;
  onChange: (key: string, next: number) => void;
}

function SliderRow({ label, description, settingKey, value, disabled = false, onChange }: SliderRowProps) {
  // Display as percentage (0–100)
  const displayPct = Math.round(value * 100);

  return (
    <div className="py-[12px]">
      <div className="flex items-center gap-4 mb-[10px]">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text-heading leading-[18px]">{label}</div>
          <div className="text-[12px] text-text-body-secondary font-light mt-[1px] leading-[16px]">
            {description}
          </div>
        </div>
        {/* Value badge */}
        <span className="shrink-0 font-mono text-[12px] text-text-heading bg-ivory-dark border border-cloud-light px-2 py-[2px] min-w-[40px] text-center">
          {displayPct}%
        </span>
      </div>

      {/* Slider */}
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-text-small font-mono w-[24px] text-right">0%</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(settingKey, parseFloat(e.target.value))}
          onMouseUp={(e) => {
            // Commit on release (avoid chatty PUT on every tick)
            onChange(settingKey, parseFloat((e.target as HTMLInputElement).value));
          }}
          className={[
            'flex-1 h-[3px] appearance-none bg-cloud-dark rounded-none cursor-pointer',
            'accent-book-cloth',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
          style={{ accentColor: 'var(--color-book-cloth)' }}
        />
        <span className="text-[11px] text-text-small font-mono w-[32px]">100%</span>
      </div>

      {/* Guidance labels */}
      <div className="flex justify-between mt-[4px] px-[36px] text-[10.5px] text-text-small font-mono tracking-[0.02em]">
        <span>Recall more</span>
        <span>Precision more</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting definitions
// ---------------------------------------------------------------------------

const TOGGLE_SETTINGS = [
  {
    key: 'entity_extract_locations',
    label: 'Extract location entities',
    description: 'Identify and link places, cities, and geographic references in captures.',
    defaultValue: true,
  },
  {
    key: 'entity_extract_monetary',
    label: 'Extract monetary values',
    description: 'Detect dollar amounts, currencies, and financial figures as entities.',
    defaultValue: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EntityExtractionSection() {
  const queryClient = useQueryClient();

  const locationQuery = useQuery({
    queryKey: ['settings', 'entity_extract_locations'],
    queryFn: () =>
      settingsApi.get('entity_extract_locations').catch(() => ({
        key: 'entity_extract_locations',
        value: TOGGLE_SETTINGS[0].defaultValue,
        updated_at: null,
      })),
    staleTime: 60_000,
  });

  const monetaryQuery = useQuery({
    queryKey: ['settings', 'entity_extract_monetary'],
    queryFn: () =>
      settingsApi.get('entity_extract_monetary').catch(() => ({
        key: 'entity_extract_monetary',
        value: TOGGLE_SETTINGS[1].defaultValue,
        updated_at: null,
      })),
    staleTime: 60_000,
  });

  const confidenceQuery = useQuery({
    queryKey: ['settings', 'entity_confidence_threshold'],
    queryFn: () =>
      settingsApi.get('entity_confidence_threshold').catch(() => ({
        key: 'entity_confidence_threshold',
        value: 0.7,
        updated_at: null,
      })),
    staleTime: 60_000,
  });

  const putMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      settingsApi.put(key, value),
    onSuccess: (result) => {
      queryClient.setQueryData(['settings', result.key], result);
    },
  });

  const handleToggle = (key: string, next: boolean) => {
    putMutation.mutate({ key, value: next });
  };

  const handleSlider = (key: string, next: number) => {
    // Round to 2 decimal places to avoid floating-point noise in the DB
    putMutation.mutate({ key, value: Math.round(next * 100) / 100 });
  };

  const isAnyLoading =
    locationQuery.isLoading || monetaryQuery.isLoading || confidenceQuery.isLoading;
  const isPending = putMutation.isPending;

  const locationChecked =
    typeof locationQuery.data?.value === 'boolean'
      ? locationQuery.data.value
      : TOGGLE_SETTINGS[0].defaultValue;

  const monetaryChecked =
    typeof monetaryQuery.data?.value === 'boolean'
      ? monetaryQuery.data.value
      : TOGGLE_SETTINGS[1].defaultValue;

  const confidenceValue =
    typeof confidenceQuery.data?.value === 'number'
      ? confidenceQuery.data.value
      : 0.7;

  return (
    <Card
      header="Entity extraction"
      description="Configure which types of entities are identified and at what confidence threshold."
      padded={false}
    >
      <div className="px-[18px]">
        {/* Location toggle */}
        <ToggleRow
          settingKey="entity_extract_locations"
          label={TOGGLE_SETTINGS[0].label}
          description={TOGGLE_SETTINGS[0].description}
          checked={locationChecked}
          disabled={isAnyLoading || isPending}
          onChange={handleToggle}
        />

        {/* Monetary toggle */}
        <ToggleRow
          settingKey="entity_extract_monetary"
          label={TOGGLE_SETTINGS[1].label}
          description={TOGGLE_SETTINGS[1].description}
          checked={monetaryChecked}
          disabled={isAnyLoading || isPending}
          onChange={handleToggle}
        />

        {/* Confidence slider */}
        <SliderRow
          settingKey="entity_confidence_threshold"
          label="Confidence threshold"
          description="Minimum extraction confidence required for an entity to be linked to a capture."
          value={confidenceValue}
          disabled={isAnyLoading || isPending}
          onChange={handleSlider}
        />
      </div>
    </Card>
  );
}
