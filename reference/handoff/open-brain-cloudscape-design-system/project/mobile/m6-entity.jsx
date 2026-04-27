// M6 — Entity detail (dossier view).

const MEntity = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  return (
    <MShell dark={dark} hideTabBar
      leftAction={<button style={{ border:'none', background:'transparent', padding:0, cursor:'pointer' }}>
        <i data-lucide="chevron-left" style={{ width:22, height:22, color:ink, strokeWidth:1.8 }}></i>
      </button>}
      rightAction={
        <button style={{ border:'none', background:'transparent', padding:6, cursor:'pointer' }}>
          <i data-lucide="more-horizontal" style={{ width:20, height:20, color:ink, strokeWidth:1.6 }}></i>
        </button>
      }
    >
      {/* Hero */}
      <div style={{
        display: 'flex', gap: 14, alignItems: 'center', marginBottom: 20,
        paddingBottom: 20, borderBottom: `1px solid ${hairline}`,
      }}>
        <div style={{
          width: 64, height: 64, background: 'var(--color-book-cloth-50)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-family-display)', fontSize: 24,
          color: 'var(--color-book-cloth-darker)', fontWeight: 500,
        }}>SC</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em', marginBottom: 4,
          }}>PERSON · COLLEAGUE</div>
          <div style={{
            fontFamily: 'var(--font-family-display)', fontSize: 22,
            color: ink, letterSpacing: '-0.015em', fontWeight: 400,
          }}>Sarah Chen</div>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 11,
            color: secondary, marginTop: 2,
          }}>VP People · 47 captures</div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 22 }}>
        {[
          { k: '47', l: 'Captures' },
          { k: '8', l: 'Briefs' },
          { k: '3', l: 'Open Qs' },
        ].map(s => (
          <div key={s.l} style={{
            background: cardBg, border: `1px solid ${hairline}`, padding: '12px 10px',
            textAlign: 'center',
          }}>
            <div style={{
              fontFamily: 'var(--font-family-display)', fontSize: 22,
              color: ink, letterSpacing: '-0.02em',
            }}>{s.k}</div>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10,
              color: secondary, letterSpacing: '0.08em', textTransform: 'uppercase',
              marginTop: 2,
            }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* AI summary */}
      <div style={{
        background: cardBg, border: `1px solid ${hairline}`, padding: 16, marginBottom: 22,
      }}>
        <div style={{
          fontFamily: 'var(--font-family-monospace)', fontSize: 10,
          color: 'var(--color-book-cloth)', letterSpacing: '0.12em',
          marginBottom: 8, textTransform: 'uppercase',
        }}>Synthesis</div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: body }}>
          Your most frequent Q4 collaborator. Three recent disagreements centered on hiring cadence; Sarah prefers rolling, you're trending toward front-loading. Worth a direct conversation before Thursday.
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 24, borderBottom: `1px solid ${hairline}`,
        marginBottom: 14,
      }}>
        {['Timeline', 'Captures', 'Mentions'].map((t, i) => (
          <div key={t} style={{
            padding: '10px 0',
            fontFamily: 'var(--font-family-monospace)', fontSize: 11,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: i === 0 ? ink : secondary,
            borderBottom: i === 0 ? `2px solid var(--color-book-cloth)` : 'none',
            marginBottom: -1, fontWeight: i === 0 ? 500 : 400,
          }}>{t} {i === 1 && <span style={{ color: secondary }}>47</span>}</div>
        ))}
      </div>

      {/* Timeline */}
      <div>
        {[
          { d: 'APR 22 · 07:12', t: 'Morning walk — headcount question', kind: 'Voice capture' },
          { d: 'APR 19 · 15:00', t: 'Weekly 1:1 — hiring cadence', kind: 'Meeting' },
          { d: 'APR 18 · 09:30', t: 'Q4 headcount proposal v2', kind: 'Document · received' },
          { d: 'APR 14 · 14:00', t: 'Q4 planning kickoff', kind: 'Meeting' },
        ].map((r, i, a) => (
          <div key={i} style={{
            display: 'flex', gap: 14, paddingLeft: 0, paddingBottom: i === a.length - 1 ? 0 : 18,
            position: 'relative',
          }}>
            <div style={{
              width: 10, paddingTop: 4, display: 'flex', flexDirection: 'column', alignItems: 'center',
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: 'var(--color-book-cloth)', flexShrink: 0,
              }} />
              {i !== a.length - 1 && (
                <div style={{ width: 1, flex: 1, background: hairline, marginTop: 4 }} />
              )}
            </div>
            <div style={{ flex: 1, paddingTop: 0, paddingBottom: 6 }}>
              <div style={{
                fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
                color: secondary, letterSpacing: '0.08em', marginBottom: 3,
              }}>{r.d}</div>
              <div style={{ fontSize: 14.5, color: ink, fontWeight: 500, marginBottom: 2 }}>{r.t}</div>
              <div style={{
                fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary,
              }}>{r.kind}</div>
            </div>
          </div>
        ))}
      </div>
    </MShell>
  );
};

window.MEntity = MEntity;
