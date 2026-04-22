// SideNav.jsx — Cloudscape side navigation panel
const SideNav = ({ active = 'dashboard', onSelect }) => {
  const sections = [
    {
      items: [
        { id: 'dashboard', icon: 'layout-dashboard', label: 'Dashboard' },
        { id: 'search', icon: 'search', label: 'Search' },
        { id: 'timeline', icon: 'clock', label: 'Timeline', count: 842 },
      ]
    },
    {
      title: 'Capture',
      items: [
        { id: 'ingest', icon: 'upload', label: 'Ingest' },
        { id: 'voice', icon: 'mic', label: 'Voice capture' },
        { id: 'email', icon: 'mail', label: 'Email bridge', count: 12 },
      ]
    },
    {
      title: 'Knowledge',
      items: [
        { id: 'entities', icon: 'users', label: 'Entities' },
        { id: 'wiki', icon: 'book-open-text', label: 'Wiki' },
        { id: 'briefs', icon: 'file-text', label: 'Briefs', count: 3 },
        { id: 'intelligence', icon: 'lightbulb', label: 'Intelligence' },
      ]
    },
    {
      title: 'Governance',
      items: [
        { id: 'board', icon: 'gavel', label: 'Board' },
        { id: 'financial', icon: 'dollar-sign', label: 'Financial' },
        { id: 'investments', icon: 'line-chart', label: 'Investments' },
      ]
    },
    {
      title: 'System',
      items: [
        { id: 'status', icon: 'monitor', label: 'System status', dot: 'success' },
        { id: 'settings', icon: 'settings', label: 'Settings' },
      ]
    },
  ];

  return (
    <nav style={{
      width: 280,
      flexShrink: 0,
      background: 'var(--color-bg-container)',
      borderRight: '1px solid var(--color-border-divider)',
      padding: '20px 0',
      overflowY: 'auto',
      height: 'calc(100vh - 48px)',
      position: 'sticky',
      top: 48,
    }}>
      <div style={{ padding: '0 20px 16px', borderBottom: '1px solid var(--color-border-divider-secondary)', marginBottom: 12 }}>
        <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 10, fontWeight: 400, letterSpacing: '0.10em', color: 'var(--color-text-small)', textTransform: 'uppercase' }}>Workspace</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontWeight: 400, fontSize: 14 }}>
          <div style={{ width: 20, height: 20, borderRadius: 0, background: 'var(--color-slate-medium)', color: 'var(--color-ivory-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>P</div>
          Personal — Troy
          <i data-lucide="chevrons-up-down" style={{ width: 14, height: 14, marginLeft: 'auto', color: 'var(--color-text-small)' }}></i>
        </div>
      </div>

      {sections.map((section, si) => (
        <div key={si} style={{ marginBottom: 8 }}>
          {section.title && (
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10, fontWeight: 400, letterSpacing: '0.10em', color: 'var(--color-text-small)',
              textTransform: 'uppercase', padding: '10px 20px 4px',
            }}>{section.title}</div>
          )}
          {section.items.map(item => {
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelect && onSelect(item.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: 'calc(100% - 12px)',
                  margin: '0 6px',
                  padding: '7px 14px',
                  border: 'none',
                  background: isActive ? 'var(--color-bg-item-selected)' : 'transparent',
                  color: isActive ? 'var(--color-text-heading)' : 'var(--color-text-body-secondary)',
                  borderRadius: 0,
                  fontFamily: 'inherit', fontSize: 13.5,
                  fontWeight: isActive ? 500 : 300,
                  letterSpacing: isActive ? '0' : '0.005em',
                  textAlign: 'left',
                  cursor: 'pointer',
                  position: 'relative',
                }}
                onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--color-ivory-dark)'; e.currentTarget.style.color = 'var(--color-text-heading)'; } }}
                onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-body-secondary)'; } }}
              >
                {isActive && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: 'var(--color-book-cloth)' }} />}
                <i data-lucide={item.icon} style={{ width: 15, height: 15, flexShrink: 0, strokeWidth: 1.5 }}></i>
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.count != null && (
                  <span style={{
                    fontFamily: 'var(--font-family-monospace)', fontSize: 10.5, fontWeight: 400, color: 'var(--color-text-small)',
                    letterSpacing: '0.02em',
                  }}>{item.count}</span>
                )}
                {item.dot && (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.dot === 'success' ? '#5E8F4A' : 'var(--color-book-cloth)' }} />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
};

window.SideNav = SideNav;
