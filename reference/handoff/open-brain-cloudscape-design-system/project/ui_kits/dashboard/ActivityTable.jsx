// ActivityTable.jsx — dense Cloudscape data table for the capture feed
const ActivityTable = ({ rows, selectedId, onSelect }) => {
  const typeIcon = {
    voice: 'mic',
    email: 'mail',
    upload: 'upload',
    note: 'file-text',
    meeting: 'users',
    link: 'link-2',
  };
  const typeColor = {
    voice: 'var(--color-purple-700)',
    email: 'var(--color-blue-600)',
    upload: 'var(--color-green-600)',
    note: 'var(--color-grey-650)',
    meeting: 'var(--color-yellow-900)',
    link: 'var(--color-chart-teal)',
  };
  return (
    <div style={{ margin: '0 -20px -20px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ background: 'var(--color-bg-cell-shaded)', borderTop: '1px solid var(--color-border-divider-secondary)' }}>
            <th style={th(36)}></th>
            <th style={th()}>Source</th>
            <th style={th()}>Title</th>
            <th style={th()}>Entities</th>
            <th style={th(120)}>Status</th>
            <th style={th(100)}>Captured</th>
            <th style={th(40)}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const sel = r.id === selectedId;
            return (
              <tr key={r.id}
                  onClick={() => onSelect && onSelect(r.id)}
                  style={{
                    background: sel ? 'var(--color-bg-item-selected)' : 'transparent',
                    borderBottom: '1px solid var(--color-border-divider-secondary)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'var(--color-grey-100)'; }}
                  onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
                <td style={td()}>
                  <input type="checkbox" style={{ margin: 0, accentColor: 'var(--color-blue-600)' }} onClick={e => e.stopPropagation()} />
                </td>
                <td style={td()}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: typeColor[r.type] }}>
                    <i data-lucide={typeIcon[r.type] || 'file'} style={{ width: 14, height: 14 }}></i>
                    <span style={{ textTransform: 'capitalize', fontWeight: 400, color: 'var(--color-text-body)' }}>{r.type}</span>
                  </span>
                </td>
                <td style={{ ...td(), maxWidth: 320 }}>
                  <div style={{ fontWeight: sel ? 700 : 400, color: 'var(--color-text-link)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </div>
                  {r.preview && <div style={{ fontSize: 12, color: 'var(--color-text-body-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.preview}</div>}
                </td>
                <td style={td()}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {r.entities.slice(0, 3).map((e, i) => (
                      <span key={i} style={{
                        fontSize: 11, padding: '1px 8px',
                        background: 'var(--color-grey-200)', borderRadius: 10,
                        color: 'var(--color-text-body)',
                      }}>{e}</span>
                    ))}
                    {r.entities.length > 3 && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-small)', padding: '1px 4px' }}>+{r.entities.length - 3}</span>
                    )}
                  </div>
                </td>
                <td style={td()}>
                  <StatusIndicator type={r.status}>{r.statusLabel}</StatusIndicator>
                </td>
                <td style={{ ...td(), color: 'var(--color-text-body-secondary)', whiteSpace: 'nowrap' }}>{r.captured}</td>
                <td style={td()}>
                  <button onClick={e => e.stopPropagation()} style={{
                    background: 'transparent', border: 'none', padding: 4, cursor: 'pointer',
                    color: 'var(--color-text-interactive)', borderRadius: 4,
                  }}>
                    <i data-lucide="more-horizontal" style={{ width: 16, height: 16 }}></i>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const th = (w) => ({
  textAlign: 'left',
  padding: '8px 12px',
  fontWeight: 600,
  fontSize: 12,
  color: 'var(--color-text-body-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  width: w,
  whiteSpace: 'nowrap',
});
const td = () => ({
  padding: '10px 12px',
  verticalAlign: 'middle',
});

window.ActivityTable = ActivityTable;
