// Button.jsx — Anthropic-styled buttons (softened rect, 1px border)
const Button = ({ variant = 'normal', icon, iconRight, children, onClick, disabled, size = 'normal', fullWidth, loading }) => {
  const styles = {
    base: {
      fontFamily: 'var(--font-family-base)',
      fontWeight: 500,
      letterSpacing: 'var(--letter-spacing-button)',
      fontSize: size === 'small' ? 12 : 14,
      padding: size === 'small' ? '4px 12px' : '6px 16px',
      minHeight: size === 'small' ? 26 : 34,
      borderRadius: 'var(--border-radius-button)',
      border: '1px solid',
      cursor: disabled || loading ? 'not-allowed' : 'pointer',
      transition: 'all 135ms cubic-bezier(0.2,0,0,1)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      whiteSpace: 'nowrap',
      width: fullWidth ? '100%' : undefined,
      justifyContent: fullWidth ? 'center' : undefined,
    },
    primary: {
      background: 'var(--color-button-primary-bg)',
      borderColor: 'var(--color-button-primary-bg)',
      color: 'var(--color-button-primary-text)',
    },
    normal: {
      background: 'var(--color-button-normal-bg)',
      borderColor: 'var(--color-button-normal-border)',
      color: 'var(--color-button-normal-text)',
    },
    link: {
      background: 'transparent',
      borderColor: 'transparent',
      color: 'var(--color-text-link)',
      padding: size === 'small' ? '2px 8px' : '4px 12px',
    },
    icon: {
      background: 'transparent',
      borderColor: 'transparent',
      color: 'var(--color-text-interactive)',
      padding: 4,
      minHeight: 28,
      borderRadius: 8,
    },
    inline: {
      background: 'transparent',
      borderColor: 'transparent',
      color: 'var(--color-text-interactive)',
      padding: '2px 8px',
      fontSize: 14,
      fontWeight: 400,
    },
    disabled: {
      background: 'var(--color-grey-250)',
      borderColor: 'var(--color-grey-250)',
      color: 'var(--color-text-disabled)',
    },
  };
  const variantStyle = disabled ? styles.disabled : styles[variant];
  return (
    <button
      style={{ ...styles.base, ...variantStyle }}
      onClick={onClick}
      disabled={disabled || loading}
      onMouseEnter={(e) => {
        if (disabled || loading) return;
        if (variant === 'primary') e.currentTarget.style.background = 'var(--color-button-primary-bg-hover)', e.currentTarget.style.borderColor = 'var(--color-button-primary-bg-hover)';
        if (variant === 'normal') e.currentTarget.style.background = 'var(--color-button-normal-bg-hover)';
        if (variant === 'link') e.currentTarget.style.background = 'var(--color-bg-item-selected)';
        if (variant === 'icon') e.currentTarget.style.background = 'var(--color-grey-200)', e.currentTarget.style.color = 'var(--color-text-interactive-hover)';
        if (variant === 'inline') e.currentTarget.style.background = 'var(--color-grey-200)';
      }}
      onMouseLeave={(e) => {
        if (disabled || loading) return;
        Object.assign(e.currentTarget.style, variantStyle);
      }}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </button>
  );
};

const Spinner = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'obspin 1s linear infinite' }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="40" strokeDashoffset="30" opacity="0.8"/>
  </svg>
);

window.Button = Button;
window.Spinner = Spinner;
