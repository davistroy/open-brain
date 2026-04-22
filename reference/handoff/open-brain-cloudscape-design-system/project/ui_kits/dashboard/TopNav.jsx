// TopNav.jsx — Anthropic-styled top navigation (warm slate bar)
const TopNav = ({ user = 'troy@openbrain.io', onToggleTheme, theme }) => (
  <header style={{
    height: 56,
    background: 'var(--color-bg-home-header)',
    color: 'var(--color-ivory-medium)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    gap: 24,
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    position: 'sticky', top: 0, zIndex: 20,
  }}>
    {/* Brand */}
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      fontFamily: 'var(--font-family-display)', fontWeight: 400,
      fontSize: 17, letterSpacing: '-0.005em',
      whiteSpace: 'nowrap', flexShrink: 0,
      color: 'var(--color-ivory-light)',
    }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-book-cloth)" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" style={{ vectorEffect: 'non-scaling-stroke' }}>
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
      </svg>
      <span>Open <span style={{ fontWeight: 300 }}>Brain</span></span>
    </div>

    {/* Search */}
    <div style={{
      flex: 1, maxWidth: 560, position: 'relative',
      display: 'flex', alignItems: 'center',
    }}>
      <i data-lucide="search" style={{ width: 15, height: 15, position: 'absolute', left: 14, color: 'var(--color-cloud-medium)' }}></i>
      <input
        placeholder="Search everything — captures, entities, briefs…"
        style={{
          width: '100%',
          height: 32,
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 0,
          padding: '0 60px 0 36px',
          color: 'var(--color-ivory-light)',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 300,
          letterSpacing: '0.005em',
          outline: 'none',
          transition: 'border-color 135ms, background 135ms',
        }}
        onFocus={e => { e.target.style.borderColor = 'var(--color-book-cloth)'; e.target.style.background = 'rgba(255,255,255,0.09)'; }}
        onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.08)'; e.target.style.background = 'rgba(255,255,255,0.06)'; }}
      />
      <span style={{
        position: 'absolute', right: 10,
        fontFamily: 'var(--font-family-monospace)',
        fontSize: 10.5, color: 'var(--color-cloud-medium)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 0, padding: '1px 6px',
        pointerEvents: 'none',
      }}>⌘K</span>
    </div>

    {/* Utility */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, color: 'var(--color-cloud-light)' }}>
      <UtilItem icon="sparkles" label="Ask AI" accent />
      <UtilItem icon="bell" badge={3} />
      <UtilItem icon={theme === 'dark' ? 'sun' : 'moon'} onClick={onToggleTheme} />
      <UtilItem icon="circle-help" />
      <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', margin: '0 10px' }} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '4px 10px 4px 4px',
        cursor: 'pointer', borderRadius: 0,
        transition: 'background 135ms',
      }}
           onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
           onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
        <div style={{
          width: 24, height: 24, borderRadius: 0,
          background: 'var(--color-book-cloth)',
          color: 'var(--color-ivory-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 400, fontSize: 11,
          fontFamily: 'var(--font-family-base)',
          letterSpacing: '0.02em',
        }}>TD</div>
        <span style={{ fontSize: 13, fontWeight: 300, color: 'var(--color-ivory-medium)' }}>{user}</span>
        <i data-lucide="chevron-down" style={{ width: 14, height: 14, color: 'var(--color-cloud-medium)' }}></i>
      </div>
    </div>
  </header>
);

const UtilItem = ({ icon, label, badge, accent, onClick }) => {
  const baseBg = accent ? 'rgba(204, 120, 92, 0.16)' : 'transparent';
  const hoverBg = accent ? 'rgba(204, 120, 92, 0.24)' : 'rgba(255,255,255,0.06)';
  return (
    <button onClick={onClick} style={{
      background: baseBg,
      border: 'none',
      color: accent ? 'var(--color-book-cloth)' : 'var(--color-cloud-light)',
      padding: label ? '5px 12px' : 7,
      borderRadius: 0,
      cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: 'inherit', fontSize: 13, fontWeight: accent ? 400 : 300,
      letterSpacing: '0.005em',
      position: 'relative',
      transition: 'background 135ms',
    }}
      onMouseEnter={e => e.currentTarget.style.background = hoverBg}
      onMouseLeave={e => e.currentTarget.style.background = baseBg}>
      <i data-lucide={icon} style={{ width: 16, height: 16 }}></i>
      {label}
      {badge ? (
        <span style={{
          position: 'absolute', top: 2, right: 2,
          minWidth: 14, height: 14, padding: '0 3px',
          background: 'var(--color-faded-red)', color: '#fff',
          fontSize: 10, fontWeight: 500,
          borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1.5px solid var(--color-bg-home-header)',
          fontFamily: 'var(--font-family-monospace)',
        }}>{badge}</span>
      ) : null}
    </button>
  );
};

window.TopNav = TopNav;
