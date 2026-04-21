// QuickCapture.jsx — primary capture bar (form field + input + buttons)
const QuickCapture = ({ onCapture }) => {
  const [value, setValue] = React.useState('');
  const [captureType, setCaptureType] = React.useState('note');
  const types = [
    { id: 'note',    icon: 'file-text', label: 'Note' },
    { id: 'voice',   icon: 'mic',       label: 'Voice' },
    { id: 'upload',  icon: 'upload',    label: 'Upload' },
    { id: 'link',    icon: 'link-2',    label: 'Link' },
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {types.map(t => (
          <button key={t.id} onClick={() => setCaptureType(t.id)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 12px',
            background: captureType === t.id ? 'var(--color-bg-item-selected)' : 'transparent',
            border: captureType === t.id ? '1px solid var(--color-border-item-selected)' : '1px solid var(--color-border-divider)',
            borderRadius: 16,
            color: captureType === t.id ? 'var(--color-text-accent)' : 'var(--color-text-interactive)',
            fontWeight: captureType === t.id ? 700 : 400,
            fontFamily: 'inherit', fontSize: 13,
            cursor: 'pointer',
          }}>
            <i data-lucide={t.icon} style={{ width: 14, height: 14 }}></i>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="What's on your mind? Drop a thought, paste a link, or upload a file…"
            rows={2}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 12px',
              fontFamily: 'inherit', fontSize: 14, lineHeight: '20px',
              color: 'var(--color-text-body)',
              background: 'var(--color-bg-input)',
              border: '1px solid var(--color-border-input)',
              borderRadius: 8,
              resize: 'vertical',
              outline: 'none',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--color-border-input-focused)'; e.target.style.boxShadow = '0 0 0 1px var(--color-border-input-focused)'; }}
            onBlur={e => { e.target.style.borderColor = 'var(--color-border-input)'; e.target.style.boxShadow = 'none'; }}
          />
          <div style={{ fontSize: 12, color: 'var(--color-text-form-secondary)', marginTop: 4 }}>
            Will be auto-enriched with entities and tags. ⌘↵ to capture.
          </div>
        </div>
        <Button variant="primary" icon={<i data-lucide="plus" style={{ width: 14, height: 14 }}></i>} onClick={() => { if (value.trim()) { onCapture && onCapture({ type: captureType, text: value }); setValue(''); } }}>
          Capture
        </Button>
      </div>
    </div>
  );
};

window.QuickCapture = QuickCapture;
