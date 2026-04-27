// M9 — Search.

const MSearch = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  return (
    <MShell dark={dark} hideTabBar hideTopBar padded={false}>
      {/* Search bar */}
      <div style={{
        padding: '56px 16px 14px',
        borderBottom: `0.5px solid ${hairline}`,
        display: 'flex', gap: 10, alignItems: 'center',
      }}>
        <div style={{
          flex: 1, height: 40,
          background: dark ? '#262624' : 'var(--color-ivory-dark)',
          border: `1px solid ${hairline}`,
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
        }}>
          <i data-lucide="search" style={{ width: 16, height: 16, color: secondary, strokeWidth: 1.6 }}></i>
          <input
            defaultValue="sarah hiring"
            style={{
              flex: 1, border: 'none', background: 'transparent', outline: 'none',
              color: ink, fontSize: 15,
            }}
          />
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.08em',
          }}>8 HITS</div>
        </div>
        <button style={{ border:'none', background:'transparent', padding:0, color: 'var(--color-book-cloth)', fontSize: 14, fontWeight: 500, cursor:'pointer' }}>Cancel</button>
      </div>

      <div style={{ padding: '18px 20px 120px' }}>
        {/* Scopes */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {['All · 8', 'Captures · 5', 'Briefs · 2', 'Entities · 1'].map((s, i) => (
            <div key={s} style={{
              padding: '6px 11px',
              background: i === 0 ? 'var(--color-book-cloth)' : (dark ? '#262624' : 'var(--color-ivory-dark)'),
              color: i === 0 ? '#FFF' : body,
              fontFamily: 'var(--font-family-monospace)', fontSize: 11,
              letterSpacing: '0.04em',
              border: `1px solid ${i === 0 ? 'var(--color-book-cloth)' : hairline}`,
            }}>{s.toUpperCase()}</div>
          ))}
        </div>

        {/* Top entity hit */}
        <div style={{
          background: cardBg, border: `1px solid ${hairline}`, padding: 14, marginBottom: 16,
          display: 'flex', gap: 12, alignItems: 'center',
        }}>
          <div style={{
            width: 40, height: 40, background: 'var(--color-book-cloth-50)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-family-display)', fontSize: 15,
            color: 'var(--color-book-cloth-darker)', fontWeight: 500,
          }}>SC</div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10,
              color: secondary, letterSpacing: '0.12em', marginBottom: 3,
            }}>ENTITY · PERSON</div>
            <div style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}><mark style={{ background: 'var(--color-book-cloth-50)', color: 'var(--color-book-cloth-darker)', padding: '0 3px' }}>Sarah</mark> Chen</div>
          </div>
          <i data-lucide="chevron-right" style={{ width: 16, height: 16, color: secondary, strokeWidth: 1.6 }}></i>
        </div>

        {/* Results */}
        <div style={{
          fontFamily: 'var(--font-family-monospace)', fontSize: 10,
          color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: 10,
        }}>Captures · 5 matches</div>
        <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>
          {[
            { t: 'Morning walk — Q4 planning thoughts', s: 'Need to circle back with ', hi: 'Sarah', r: ' on headcount for the new team…', d: '07:12', k: 'VOICE' },
            { t: "Sarah's Q4 headcount proposal v2", s: '12-page doc outlining rolling ', hi: 'hiring', r: ' cadence with 4 roles…', d: '3d', k: 'UPLOAD' },
            { t: 'Weekly 1:1 — hiring cadence', s: 'Discussed ', hi: 'hiring', r: ' sequencing; Sarah prefers rolling.', d: '3d', k: 'MEETING' },
            { t: 'Q4 planning kickoff notes', s: 'Sarah outlined proposed headcount across…', hi: null, r: '', d: '6d', k: 'NOTE' },
          ].map((r, i, a) => (
            <div key={i} style={{
              padding: '12px 16px',
              borderBottom: i === a.length - 1 ? 'none' : `0.5px solid ${hairline}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <div style={{
                  fontFamily: 'var(--font-family-monospace)', fontSize: 10,
                  color: secondary, letterSpacing: '0.12em',
                }}>{r.k}</div>
                <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{r.d}</div>
              </div>
              <div style={{ fontSize: 14, color: ink, fontWeight: 500, marginBottom: 3 }}>{r.t}</div>
              <div style={{ fontSize: 13, color: body, lineHeight: 1.4 }}>
                {r.s}{r.hi && <mark style={{ background: 'var(--color-book-cloth-50)', color: 'var(--color-book-cloth-darker)', padding: '0 3px' }}>{r.hi}</mark>}{r.r}
              </div>
            </div>
          ))}
        </div>
      </div>
    </MShell>
  );
};

window.MSearch = MSearch;
