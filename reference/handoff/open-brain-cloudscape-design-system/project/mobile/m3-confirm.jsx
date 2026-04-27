// M3 — Capture confirm. Transcript + extracted entities, confirm before save.

const MConfirm = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  return (
    <MShell dark={dark} hideTabBar
      eyebrow="VOICE · 01:27 · AUTO-TRANSCRIBED"
      title="Review capture"
      leftAction={<button style={{ border:'none', background:'transparent', padding:0, cursor:'pointer' }}>
        <i data-lucide="chevron-left" style={{ width:22, height:22, color:ink, strokeWidth:1.8 }}></i>
      </button>}
    >
      {/* Transcript */}
      <div style={{ background: cardBg, border: `1px solid ${hairline}`, padding: 18, marginBottom: 18 }}>
        <div style={{
          fontFamily: 'var(--font-family-monospace)', fontSize: 10,
          color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: 10,
        }}>Transcript <span style={{ color: 'var(--color-book-cloth)', marginLeft: 6 }}>EDIT</span></div>
        <div style={{ fontSize: 14.5, lineHeight: 1.6, color: body }}>
          Need to circle back with <u style={{ textDecorationColor: 'var(--color-book-cloth)', textUnderlineOffset: 3, color: ink, fontWeight: 500 }}>Sarah</u> on headcount for the new team — we said rolling hires through Q4 but the October momentum means we should probably front-load the first two roles before the all-hands.
        </div>
      </div>

      {/* Extracted entities */}
      <div style={{ marginBottom: 18 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10,
        }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          }}>Extracted · 4 entities</div>
          <a style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: 'var(--color-book-cloth)' }}>+ ADD</a>
        </div>
        <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>
          {[
            { icon: 'user', name: 'Sarah Chen', sub: 'Person · linked', conf: 0.98 },
            { icon: 'folder', name: 'Q4 Planning', sub: 'Project · linked', conf: 0.94 },
            { icon: 'tag', name: 'Hiring', sub: 'Topic · linked', conf: 0.91 },
            { icon: 'calendar', name: 'Q4 all-hands', sub: 'Event · new', conf: 0.72, isNew: true },
          ].map((e, i, a) => (
            <div key={i} style={{
              padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'center',
              borderBottom: i === a.length - 1 ? 'none' : `0.5px solid ${hairline}`,
            }}>
              <div style={{
                width: 32, height: 32, flexShrink: 0,
                background: e.isNew ? 'var(--color-book-cloth-50)' : (dark ? '#262624' : 'var(--color-ivory-medium)'),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <i data-lucide={e.icon} style={{
                  width: 14, height: 14,
                  color: e.isNew ? 'var(--color-book-cloth-dark)' : body, strokeWidth: 1.5,
                }}></i>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: ink, fontWeight: 500 }}>{e.name}</div>
                <div style={{ fontFamily:'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{e.sub}</div>
              </div>
              <div style={{
                fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
                color: e.conf > 0.9 ? (dark ? '#9CB890' : '#4A6B3A') : secondary,
                letterSpacing: '0.04em',
              }}>{Math.round(e.conf * 100)}%</div>
            </div>
          ))}
        </div>
      </div>

      {/* Suggested links */}
      <div style={{ marginBottom: 18 }}>
        <div style={{
          fontFamily: 'var(--font-family-monospace)', fontSize: 10,
          color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: 10,
        }}>Related · 3 captures</div>
        <div style={{ background: cardBg, border: `1px solid ${hairline}`, padding: '4px 0' }}>
          {[
            { t: "Sarah's Q4 headcount proposal", d: '3d ago' },
            { t: 'Weekly 1:1 — hiring cadence', d: '6d ago' },
            { t: 'Advisory board pre-read draft', d: '2w ago' },
          ].map((x, i, a) => (
            <div key={i} style={{
              padding: '10px 16px', display:'flex', justifyContent:'space-between', gap: 12,
              borderBottom: i === a.length - 1 ? 'none' : `0.5px solid ${hairline}`,
            }}>
              <span style={{ fontSize: 13.5, color: body, flex: 1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{x.t}</span>
              <span style={{ fontFamily:'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{x.d}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginTop: 24 }}>
        <button style={{
          padding: '14px', background: 'transparent',
          border: `1px solid ${dark ? 'rgba(240,238,230,0.14)' : 'var(--color-cloud-medium)'}`,
          color: ink, fontSize: 14, fontWeight: 500, cursor: 'pointer',
        }}>Discard</button>
        <button style={{
          padding: '14px', background: 'var(--color-book-cloth)', border: 'none',
          color: '#FFF', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <i data-lucide="check" style={{ width: 15, height: 15, strokeWidth: 2.2 }}></i>
          Save capture
        </button>
      </div>
    </MShell>
  );
};

window.MConfirm = MConfirm;
