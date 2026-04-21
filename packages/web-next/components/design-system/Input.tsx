'use client';

import {
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from 'react';
import { type LucideIcon } from 'lucide-react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Text label rendered above the input. */
  label?: string;
  /** Error message rendered below the input in error color. */
  error?: string;
  /** Lucide icon rendered inside the input on the left. */
  icon?: LucideIcon;
  /** Optional node rendered inside the input on the right (e.g. clear button). */
  iconRight?: ReactNode;
  className?: string;
}

/**
 * SInput port — text input with optional label, icon, error message.
 * 30px height, hard corners, Inter 13px/300, focus → slate-medium border.
 * 'use client' because onChange/onFocus are interactive.
 */
export function Input({
  label,
  error,
  icon: Icon,
  iconRight,
  className = '',
  id: idProp,
  ...rest
}: InputProps) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <div className={['flex flex-col gap-[5px]', className].filter(Boolean).join(' ')}>
      {label && (
        <label
          htmlFor={id}
          className="font-body text-[12.5px] font-normal text-text-body-secondary tracking-[0.005em]"
        >
          {label}
        </label>
      )}

      <div className="relative flex items-center">
        {Icon && (
          <Icon
            className="absolute left-[10px] text-text-body-secondary pointer-events-none shrink-0"
            size={13}
            strokeWidth={1.5}
          />
        )}

        <input
          id={id}
          className={[
            'w-full h-[30px]',
            'bg-bg-container border border-cloud-medium rounded-none',
            'font-body text-[13px] font-light text-text-body',
            'outline-none',
            // icon offset
            Icon ? 'pl-[30px]' : 'pl-[12px]',
            iconRight ? 'pr-[30px]' : 'pr-[12px]',
            // focus ring using slate-medium border
            'focus:border-slate-medium',
            // error state
            error ? 'border-status-error-border focus:border-status-error-fg' : '',
            'transition-[border-color] duration-[120ms]',
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        />

        {iconRight && (
          <div className="absolute right-[8px] flex items-center">
            {iconRight}
          </div>
        )}
      </div>

      {error && (
        <div className="text-[12px] text-status-error-fg font-light">
          {error}
        </div>
      )}
    </div>
  );
}
