// Flashbar.jsx — stacked notification bar
const Flashbar = ({ items, onDismiss }) => {
  if (!items || !items.length) return null;
  const typeMap = {
    success: { bg: 'var(--color-green-600)', icon: 'check-circle-2' },
    info:    { bg: 'var(--color-blue-600)',  icon: 'info' },
    warning: { bg: 'var(--color-yellow-900)', icon: 'alert-triangle' },
    error:   { bg: 'var(--color-red-600)',   icon: 'alert-octagon' },
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
      {items.map(item => {
        const entry = typeMap[item.type] || typeMap.info;
        return (
          <div key={item.id} style={{
            background: entry.bg,
            color: '#fff',
            borderRadius: 12,
            padding: '10px 14px 10px 16px',
            display: 'flex', alignItems: 'flex-start', gap: 12,
            fontSize: 14, lineHeight: '20px',
          }}>
            <i data-lucide={entry.icon} style={{ width: 18, height: 18, flexShrink: 0, marginTop: 1 }}></i>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{item.header}</div>
              {item.content && <div style={{ marginTop: 2, opacity: 0.95 }}>{item.content}</div>}
              {item.actions && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {item.actions.map((a, i) => (
                    <button key={i} onClick={a.onClick} style={{
                      background: 'transparent', border: '1px solid rgba(255,255,255,0.7)',
                      color: '#fff', borderRadius: 8, padding: '4px 12px',
                      fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}>{a.label}</button>
                  ))}
                </div>
              )}
            </div>
            {onDismiss && (
              <button onClick={() => onDismiss(item.id)} style={{
                background: 'transparent', border: 'none', color: '#fff',
                cursor: 'pointer', padding: 2, display: 'flex',
              }}>
                <i data-lucide="x" style={{ width: 16, height: 16 }}></i>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

window.Flashbar = Flashbar;
