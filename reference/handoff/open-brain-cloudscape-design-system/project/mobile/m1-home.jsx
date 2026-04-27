// M1 — Home (hero tap-to-record). Light + dark.
// The cornerstone mobile screen. Voice is hero; daily brief summary sits below.

const MHome = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  return (
    <MShell
      dark={dark}
      active="home"
      eyebrow="TUE · APR 22 · 07:14"
      title="Good morning, Troy."
      rightAction={
        <button style={{
          width: 38, height: 38, border: 'none',
          background: dark ? '#262624' : 'var(--color-ivory-dark)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}>
          <i data-lucide="bell" style={{ width: 16, height: 16, color: ink, strokeWidth: 1.6 }}></i>
        </button>
      }
    >
      <div style={{ color: secondary, fontSize: 14, lineHeight: 1.5, marginBottom: 28, marginTop: -4 }}>
        Last capture 11 hrs ago · 4 items awaiting review
      </div>

      {/* HERO — Tap to record */}
      <div style={{
        background: dark ? '#1C1C1A' : '#FFFFFF',
        border: `1px solid ${hairline}`,
        padding: '28px 24px 24px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        marginBottom: 24,
        position: 'relative',
      }}>
        <div style={{
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 10, letterSpacing: '0.14em',
          color: 'var(--color-book-cloth)',
          textTransform: 'uppercase', marginBottom: 18,
        }}>Tap to capture · hold to speak</div>

        {/* Big record button with concentric rings */}
        <div style={{ position: 'relative', width: 180, height: 180, marginBottom: 14 }}>
          {/* outer faint ring */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            border: `1px solid ${dark ? 'rgba(204,120,92,0.14)' : 'rgba(204,120,92,0.16)'}`,
          }} />
          <div style={{
            position: 'absolute', inset: 18, borderRadius: '50%',
            border: `1px solid ${dark ? 'rgba(204,120,92,0.22)' : 'rgba(204,120,92,0.24)'}`,
          }} />
          {/* core button */}
          <button style={{
            position: 'absolute', inset: 36, borderRadius: '50%',
            background: 'linear-gradient(145deg, #D88967 0%, #CC785C 50%, #B25A3D 100%)',
            border: 'none', cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(204,120,92,0.35), inset 0 1px 1px rgba(255,255,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <i data-lucide="mic" style={{ width: 44, height: 44, color: '#FFF', strokeWidth: 1.4 }}></i>
          </button>
        </div>

        <div style={{
          fontFamily: 'var(--font-family-display)',
          fontSize: 18, color: ink, marginTop: 4,
        }}>Record a thought</div>
        <div style={{
          fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
          color: secondary, letterSpacing: '0.04em', marginTop: 4,
        }}>AUTO-TRANSCRIBED · LINKED TO ENTITIES</div>
      </div>

      {/* Quick capture row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 28 }}>
        {[
          { icon: 'type', label: 'Note' },
          { icon: 'camera', label: 'Photo' },
          { icon: 'link', label: 'Link' },
        ].map(x => (
          <button key={x.label} style={{
            background: cardBg, border: `1px solid ${hairline}`, padding: '14px 0',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            cursor: 'pointer',
          }}>
            <i data-lucide={x.icon} style={{ width: 18, height: 18, color: ink, strokeWidth: 1.5 }}></i>
            <span style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10,
              color: secondary, letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>{x.label}</span>
          </button>
        ))}
      </div>

      {/* Today's brief */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 10,
        }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          }}>Today's brief</div>
          <a style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 11,
            color: 'var(--color-book-cloth)', letterSpacing: '0.04em',
          }}>OPEN →</a>
        </div>
        <div style={{
          background: cardBg, border: `1px solid ${hairline}`, padding: 18,
        }}>
          <div style={{
            fontFamily: 'var(--font-family-display)', fontSize: 18,
            color: ink, lineHeight: 1.25, marginBottom: 10, letterSpacing: '-0.01em',
          }}>Q4 planning momentum — 3 threads converging this week.</div>
          <div style={{
            fontSize: 13.5, lineHeight: 1.55, color: body,
            marginBottom: 14,
          }}>Sarah's headcount proposal, the Lelit decision, and Maya's 1:1 all feed into Thursday's decision memo. Espresso purchase still open.</div>
          <div style={{
            display: 'flex', gap: 6, flexWrap: 'wrap',
            paddingTop: 12, borderTop: `0.5px solid ${hairline}`,
          }}>
            <MPill tone="accent" dark={dark}>Q4 Planning</MPill>
            <MPill tone="neutral" dark={dark}>Sarah Chen</MPill>
            <MPill tone="neutral" dark={dark}>+4</MPill>
          </div>
        </div>
      </div>

      {/* Recent captures */}
      <div style={{ marginBottom: 20 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 10,
        }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          }}>Recent</div>
          <a style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 11,
            color: 'var(--color-book-cloth)', letterSpacing: '0.04em',
          }}>ALL →</a>
        </div>
        <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>
          {[
            { icon: 'mic', title: 'Morning walk — Q4 planning', time: '11h', meta: 'Sarah Chen · Hiring' },
            { icon: 'mail', title: 'Re: Advisory board deck v3', time: '14h', meta: 'Avi Sharma · Ventures.co' },
            { icon: 'file-up', title: 'espresso-machine-research.pdf', time: '1d', meta: 'Purchase Decision' },
          ].map((r, i, a) => (
            <div key={i} style={{
              padding: '14px 16px', display: 'flex', gap: 12,
              borderBottom: i === a.length - 1 ? 'none' : `0.5px solid ${hairline}`,
            }}>
              <div style={{
                width: 34, height: 34, flexShrink: 0,
                background: dark ? '#262624' : 'var(--color-ivory-medium)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <i data-lucide={r.icon} style={{ width: 15, height: 15, color: body, strokeWidth: 1.5 }}></i>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14, color: ink, fontWeight: 500,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginBottom: 2,
                }}>{r.title}</div>
                <div style={{
                  fontFamily: 'var(--font-family-monospace)', fontSize: 11,
                  color: secondary, letterSpacing: '0.02em',
                }}>{r.meta}</div>
              </div>
              <div style={{
                fontFamily: 'var(--font-family-monospace)', fontSize: 11,
                color: secondary,
              }}>{r.time}</div>
            </div>
          ))}
        </div>
      </div>
    </MShell>
  );
};

window.MHome = MHome;
