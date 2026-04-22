'use client';

/**
 * GroupByBar — toggle between 4 grouping modes for the Board Kanban.
 * Status is the default view (Cloudscape screen 09).
 * Client component — manages active grouping via local state.
 *
 * M3 Note: Only "Status" grouping renders real columns. The other groupings
 * (Project, Person, Due date) are UI-only stubs that accept the selection but
 * fall back to the same status-grouped view — they will be wired once
 * project/person extraction lands in a later phase.
 */

import { useState } from 'react';

export type GroupBy = 'status' | 'project' | 'person' | 'due_date';

const OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'status',   label: 'Status' },
  { value: 'project',  label: 'Project' },
  { value: 'person',   label: 'Person' },
  { value: 'due_date', label: 'Due date' },
];

interface GroupByBarProps {
  value?: GroupBy;
  onChange?: (groupBy: GroupBy) => void;
}

export function GroupByBar({ value: controlledValue, onChange }: GroupByBarProps) {
  const [internalValue, setInternalValue] = useState<GroupBy>('status');
  const active = controlledValue ?? internalValue;

  function handleSelect(g: GroupBy) {
    if (!controlledValue) setInternalValue(g);
    onChange?.(g);
  }

  return (
    <div className="flex items-center gap-0 border border-cloud-light rounded-none overflow-hidden">
      {OPTIONS.map(({ value, label }) => {
        const isActive = active === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => handleSelect(value)}
            className={[
              'inline-flex items-center px-[12px] py-[5px]',
              'text-[11.5px] font-mono tracking-[0.04em] uppercase whitespace-nowrap',
              'border-r border-cloud-light last:border-r-0',
              'transition-colors duration-fast',
              'cursor-pointer',
              isActive
                ? 'bg-book-cloth text-ivory-light'
                : 'bg-bg-container text-text-body-secondary hover:bg-ivory-dark hover:text-text-heading',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
