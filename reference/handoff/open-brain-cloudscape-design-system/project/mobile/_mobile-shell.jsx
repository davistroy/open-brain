// _mobile-shell.jsx — shared scaffolding for every Open Brain mobile screen.
// Wraps IOSDevice with an app-level TabBar + top bar. Uses the same tokens as
// the desktop system (colors_and_type.css). Space Grotesk / Inter / JetBrains
// Mono carry over. Tabs: Home · Briefs · Board · Library.

const MShell = ({
  active = 'home',
  title,
  eyebrow,
  dark = false,
  hideTabBar = false,
  hideTopBar = false,
  rightAction,
  leftAction,
  children,
  scroll = true,
  padded = true,
}) => {
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  const bg = dark ? '#141413' : 'var(--color-ivory-medium)';
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'rgba(20,20,19,0.08)';

  const tabs = [
    { id: 'home',    label: 'Home',    icon: 'mic' },
    { id: 'briefs',  label: 'Briefs',  icon: 'newspaper' },
    { id: 'board',   label: 'Board',   icon: 'square-pen' },
    { id: 'library', label: 'Library', icon: 'library' },
  ];

  return (
    <IOSDevice width={430} height={932} dark={dark}>
      <div style={{
        display: 'flex', flexDirection: 'column',
        height: '100%', background: bg,
        fontFamily: 'var(--font-family-base)',
        color: ink,
      }}>

        {/* Top bar */}
        {!hideTopBar && (
          <div style={{
            padding: '56px 20px 14px',
            background: bg,
            borderBottom: `0.5px solid ${hairline}`,
            display: 'flex', alignItems: 'flex-end', gap: 12,
            minHeight: 96, boxSizing: 'border-box',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {eyebrow && (
                <div style={{
                  fontFamily: 'var(--font-family-monospace)',
                  fontSize: 10, letterSpacing: '0.12em',
                  color: dark ? '#C2C0B6' : 'var(--color-book-cloth)',
                  marginBottom: 4, textTransform: 'uppercase',
                }}>{eyebrow}</div>
              )}
              {title && (
                <div style={{
                  fontFamily: 'var(--font-family-display)',
                  fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em',
                  lineHeight: 1.1, color: ink,
                }}>{title}</div>
              )}
            </div>
            {leftAction && !title && <div>{leftAction}</div>}
            {rightAction && <div style={{ paddingBottom: 4 }}>{rightAction}</div>}
          </div>
        )}

        {/* Content */}
        <div style={{
          flex: 1, minHeight: 0,
          overflow: scroll ? 'auto' : 'hidden',
          padding: padded ? '18px 20px 120px' : 0,
          background: bg,
        }}>
          {children}
        </div>

        {/* Tab bar */}
        {!hideTabBar && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            padding: '10px 12px 28px',
            background: dark ? 'rgba(20,20,19,0.92)' : 'rgba(240,238,230,0.92)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderTop: `0.5px solid ${hairline}`,
            display: 'flex', justifyContent: 'space-around',
          }}>
            {tabs.map(t => {
              const isActive = active === t.id;
              const isCenter = t.id === 'home'; // Hero capture tab — styled differently
              if (isCenter) {
                return (
                  <button key={t.id} style={{
                    border: 'none', background: 'transparent', padding: '6px 12px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    cursor: 'pointer',
                  }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: '50%',
                      background: isActive ? 'var(--color-book-cloth)' : (dark ? '#262624' : 'var(--color-ivory-dark)'),
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: isActive ? '0 4px 12px rgba(204,120,92,0.4)' : 'none',
                    }}>
                      <i data-lucide="mic" style={{
                        width: 22, height: 22,
                        color: isActive ? '#fff' : (dark ? '#F0EEE6' : 'var(--color-text-heading)'),
                        strokeWidth: 1.8,
                      }}></i>
                    </div>
                    <span style={{
                      fontSize: 10, fontWeight: 500,
                      color: isActive ? 'var(--color-book-cloth)' : (dark ? '#8F8E85' : 'var(--color-text-body-secondary)'),
                      fontFamily: 'var(--font-family-monospace)', letterSpacing: '0.04em',
                    }}>{t.label.toUpperCase()}</span>
                  </button>
                );
              }
              return (
                <button key={t.id} style={{
                  border: 'none', background: 'transparent', padding: '8px 12px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  cursor: 'pointer', minWidth: 56,
                }}>
                  <i data-lucide={t.icon} style={{
                    width: 22, height: 22,
                    color: isActive ? (dark ? '#F0EEE6' : 'var(--color-text-heading)') : (dark ? '#626260' : '#8F8E85'),
                    strokeWidth: isActive ? 1.8 : 1.4,
                  }}></i>
                  <span style={{
                    fontSize: 10, fontWeight: isActive ? 500 : 400,
                    color: isActive ? (dark ? '#F0EEE6' : 'var(--color-text-heading)') : (dark ? '#626260' : '#8F8E85'),
                    fontFamily: 'var(--font-family-monospace)', letterSpacing: '0.04em',
                  }}>{t.label.toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </IOSDevice>
  );
};

// ─── Shared primitives ─────────────────────────────────────────────

const MCard = ({ children, dark, interactive, style = {} }) => (
  <div style={{
    background: dark ? '#1C1C1A' : 'var(--color-bg-container)',
    border: `1px solid ${dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)'}`,
    padding: 16,
    ...style,
  }}>{children}</div>
);

const MEyebrow = ({ children, tone, dark }) => (
  <div style={{
    fontFamily: 'var(--font-family-monospace)',
    fontSize: 10, letterSpacing: '0.12em',
    color: tone || (dark ? '#C2C0B6' : 'var(--color-book-cloth)'),
    textTransform: 'uppercase', marginBottom: 6,
  }}>{children}</div>
);

const MMeta = ({ children, dark }) => (
  <div style={{
    fontFamily: 'var(--font-family-monospace)',
    fontSize: 11, color: dark ? '#8F8E85' : 'var(--color-text-body-secondary)',
    letterSpacing: '0.02em',
  }}>{children}</div>
);

const MPill = ({ children, tone = 'neutral', dark }) => {
  const tones = {
    neutral: { bg: dark ? '#262624' : 'var(--color-ivory-dark)', fg: dark ? '#C2C0B6' : 'var(--color-text-body)', bd: dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)' },
    accent:  { bg: dark ? '#3A1F14' : 'var(--color-book-cloth-50)', fg: dark ? '#E6947C' : 'var(--color-book-cloth-darker)', bd: dark ? '#5A2D1F' : 'var(--color-book-cloth-100)' },
    success: { bg: dark ? '#1E2A1A' : '#E8EEE5', fg: dark ? '#9CB890' : '#4A6B3A', bd: dark ? '#2A3D24' : '#C8D5BF' },
    warn:    { bg: dark ? '#2E2416' : '#F5EFE2', fg: dark ? '#C9A66B' : '#8B6F3A', bd: dark ? '#3E3120' : '#D9C89C' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', fontSize: 11, fontWeight: 500,
      fontFamily: 'var(--font-family-base)',
      background: tones.bg, color: tones.fg,
      border: `1px solid ${tones.bd}`,
    }}>{children}</span>
  );
};

Object.assign(window, { MShell, MCard, MEyebrow, MMeta, MPill });
