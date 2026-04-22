'use client';

/**
 * IngestFiltersSection — Settings page "Sources" section, ingest filter toggles.
 *
 * Renders toggle rows for 4 ingest filter settings:
 *   - ingest_skip_automated_emails
 *   - ingest_skip_low_signal_slack
 *   - ingest_capture_bare_calendar
 *   - ingest_voice_min_duration   (numeric — slider-style input)
 *
 * Each toggle reads/writes via settingsApi.get/put. Uses TanStack Query for
 * read; fires PUT on toggle click (optimistic UI via mutation).
 *
 * Client component (interactivity required).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/design-system';
import { settingsApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Toggle row types
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
      {/* Label + description */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-heading leading-[18px]">
          {label}
        </div>
        <div className="text-[12px] text-text-body-secondary font-light mt-[1px] leading-[16px]">
          {description}
        </div>
      </div>

      {/* Toggle switch */}
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
        {/* Thumb */}
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
// Numeric input row — for ingest_voice_min_duration
// ---------------------------------------------------------------------------

interface NumericRowProps {
  label: string;
  description: string;
  settingKey: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled?: boolean;
  onChange: (key: string, next: number) => void;
}

function NumericRow({ label, description, settingKey, value, min, max, unit, disabled = false, onChange }: NumericRowProps) {
  return (
    <div className="flex items-center gap-4 py-[12px] border-b border-cloud-light last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-heading leading-[18px]">
          {label}
        </div>
        <div className="text-[12px] text-text-body-secondary font-light mt-[1px] leading-[16px]">
          {description}
        </div>
      </div>

      {/* Compact number input */}
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            if (!isNaN(next) && next >= min && next <= max) {
              onChange(settingKey, next);
            }
          }}
          className={[
            'w-[64px] px-2 py-[4px] text-[13px] text-text-heading',
            'border border-cloud-dark bg-bg-container rounded-none',
            'focus:outline-none focus:border-book-cloth',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
        />
        <span className="text-[12px] text-text-body-secondary">{unit}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting keys and their display configuration
// ---------------------------------------------------------------------------

const TOGGLE_SETTINGS = [
  {
    key: 'ingest_skip_automated_emails',
    label: 'Skip automated emails',
    description: 'Exclude newsletters, receipts, and transactional emails from capture.',
    defaultValue: true,
  },
  {
    key: 'ingest_skip_low_signal_slack',
    label: 'Skip low-signal Slack messages',
    description: 'Ignore emoji-only, short reaction messages, and bot notifications from Slack ingestion.',
    defaultValue: true,
  },
  {
    key: 'ingest_capture_bare_calendar',
    label: 'Capture bare calendar events',
    description: 'Store calendar events even when they have no meeting notes or attachments.',
    defaultValue: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function IngestFiltersSection() {
  const queryClient = useQueryClient();

  // Fetch all toggle settings in parallel
  const toggleQueries = TOGGLE_SETTINGS.map((cfg) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable array, safe
    useQuery({
      queryKey: ['settings', cfg.key],
      queryFn: () =>
        settingsApi.get(cfg.key).catch(() => ({
          key: cfg.key,
          value: cfg.defaultValue,
          updated_at: null,
        })),
      staleTime: 60_000,
    }),
  );

  const voiceDurationQuery = useQuery({
    queryKey: ['settings', 'ingest_voice_min_duration'],
    queryFn: () =>
      settingsApi.get('ingest_voice_min_duration').catch(() => ({
        key: 'ingest_voice_min_duration',
        value: 5,
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

  const handleNumeric = (key: string, next: number) => {
    putMutation.mutate({ key, value: next });
  };

  return (
    <Card
      header="Ingest filters"
      description="Control which signals are captured from each source."
      padded={false}
    >
      <div className="px-[18px]">
        {TOGGLE_SETTINGS.map((cfg, idx) => {
          const query = toggleQueries[idx];
          const rawValue = query.data?.value;
          const checked = typeof rawValue === 'boolean' ? rawValue : cfg.defaultValue;
          const isLoading = query.isLoading;

          return (
            <ToggleRow
              key={cfg.key}
              settingKey={cfg.key}
              label={cfg.label}
              description={cfg.description}
              checked={checked}
              disabled={isLoading || putMutation.isPending}
              onChange={handleToggle}
            />
          );
        })}

        {/* Voice min duration — numeric */}
        <NumericRow
          settingKey="ingest_voice_min_duration"
          label="Voice minimum duration"
          description="Discard voice captures shorter than this threshold (seconds)."
          value={
            typeof voiceDurationQuery.data?.value === 'number'
              ? voiceDurationQuery.data.value
              : 5
          }
          min={0}
          max={300}
          unit="seconds"
          disabled={voiceDurationQuery.isLoading || putMutation.isPending}
          onChange={handleNumeric}
        />
      </div>
    </Card>
  );
}
