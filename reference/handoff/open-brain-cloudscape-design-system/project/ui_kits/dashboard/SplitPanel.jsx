// SplitPanel.jsx — bottom-docked capture detail preview
const SplitPanel = ({ item, onClose, onExpand }) => {
  if (!item) return null;
  return (
    <aside style={{
      position: 'fixed',
      left: 280, right: 0, bottom: 0,
      height: 320,
      background: 'var(--color-bg-container)',
      borderTop: '1px solid var(--color-border-divider)',
      boxShadow: '0 -4px 20px rgba(0,7,22,0.08)',
      display: 'flex', flexDirection: 'column',
      zIndex: 15,
    }}>
      {/* Drag handle */}
      <div style={{
        height: 20, display: 'flex', justifyContent: 'center', alignItems: 'center',
        borderBottom: '1px solid var(--color-border-divider-secondary)',
        cursor: 'row-resize',
      }}>
        <div style={{ width: 48, height: 4, background: 'var(--color-grey-350)', borderRadius: 2 }} />
      </div>
      {/* Header */}
      <div style={{
        padding: '12px 20px',
        borderBottom: '1px solid var(--color-border-divider-secondary)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i data-lucide="file-text" style={{ width: 16, height: 16, color: 'var(--color-text-accent)' }}></i>
            <h4 style={{ margin: 0 }}>{item.title}</h4>
            <Badge color="blue">{item.type}</Badge>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-body-secondary)', marginTop: 4 }}>
            Captured {item.captured} · {item.entities.length} entities · 3 links
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button variant="normal" size="small" icon={<i data-lucide="maximize-2" style={{ width: 12, height: 12 }}></i>} onClick={onExpand}>Open</Button>
          <Button variant="icon" onClick={onClose} icon={<i data-lucide="x" style={{ width: 16, height: 16 }}></i>} />
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 0, overflow: 'hidden' }}>
        <div style={{ padding: 20, overflowY: 'auto' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-small)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
            Transcript / content
          </div>
          <p style={{ fontSize: 14, lineHeight: '22px', color: 'var(--color-text-body)' }}>
            {item.fullPreview}
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
            {item.entities.map((e, i) => (
              <span key={i} style={{
                fontSize: 12, padding: '2px 10px',
                background: 'var(--color-book-cloth-50)', color: 'var(--color-book-cloth-dark)',
                borderRadius: 10, fontWeight: 600,
              }}>{e}</span>
            ))}
          </div>
        </div>
        <div style={{
          padding: 20, borderLeft: '1px solid var(--color-border-divider-secondary)',
          background: 'var(--color-bg-cell-shaded)',
          overflowY: 'auto',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-small)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 12 }}>
            AI-suggested next steps
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {item.suggestions.map((s, i) => (
              <div key={i} style={{
                padding: 10, borderRadius: 8,
                background: 'var(--color-bg-container)',
                border: '1px solid var(--color-border-divider-secondary)',
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}>
                <i data-lucide="sparkles" style={{ width: 14, height: 14, color: 'var(--color-text-label-genai)', marginTop: 2, flexShrink: 0 }}></i>
                <div style={{ flex: 1, fontSize: 13, lineHeight: '18px' }}>{s}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};

window.SplitPanel = SplitPanel;
