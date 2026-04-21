'use client';

import { type ReactNode, type ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  children?: ReactNode;
  className?: string;
}

const variantClasses: Record<ButtonVariant, string> = {
  // primary → solid book-cloth (terracotta) fill — matches SBtn "primary"
  primary:
    'bg-book-cloth border-book-cloth text-ivory-light hover:bg-book-cloth-dark hover:border-book-cloth-dark',
  // secondary → outlined with cloud-medium border — matches SBtn "normal"
  secondary:
    'bg-bg-container border-cloud-medium text-text-heading hover:bg-ivory-dark',
  // ghost → no background, no border — matches SBtn "ghost"
  ghost:
    'bg-transparent border-transparent text-text-body-secondary hover:bg-ivory-dark hover:text-text-heading',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'text-[12px] px-[10px] py-[4px] gap-[5px]',
  md: 'text-[13px] px-[14px] py-[6px] gap-[6px]',
  lg: 'text-[14px] px-[18px] py-[8px] gap-[7px]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={[
        // base
        'inline-flex items-center whitespace-nowrap rounded-none border',
        'font-body font-normal tracking-[0.005em]',
        'transition-[background,border-color,color] duration-[120ms]',
        'cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        // variant
        variantClasses[variant],
        // size
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon && <span className="inline-flex shrink-0">{icon}</span>}
      {children}
      {iconRight && <span className="inline-flex shrink-0">{iconRight}</span>}
    </button>
  );
}
