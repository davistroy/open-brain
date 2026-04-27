// M11 — Empty state (first-run, before any captures).

const MEmpty = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';

  return (
    <MShell dark={dark} active="home" hideTopBar>
      <div style={{
        minHeight: '72vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        padding: '80px 24px 40px',
      }}>
        <div style={{
          fontFamily: 'var(--font-family-monospace)', fontSize: 10,
          color: 'var(--color-book-cloth)', letterSpacing: '0.14em',
          textTransform: 'uppercase', marginBottom: 18,
        }}>A fresh slate · no captures yet</div>

        <h1 style={{
          fontFamily: 'var(--font-family-display)',
          fontSize: 30, fontWeight: 400, lineHeight: 1.15,
          color: ink, letterSpacing: '-0.02em', margin: '0 0 16px',
          textWrap: 'balance',
        }}>Start with a thought.<br />Open Brain does the rest.</h1>

        <p style={{
          fontSize: 15, lineHeight: 1.55, color: body,
          maxWidth: 320, margin: '0 0 36px',
        }}>Speak, type, or drop anything in. We'll transcribe, extract the people and projects inside, and thread it to what you've said before.</p>

        {/* Three-step quiet diagram */}
        <div style={{
          display: 'grid', gap: 10, width: '100%', maxWidth: 320, marginBottom: 36,
        }}>
          {[
            { n: '01', t: 'Capture', d: 'Voice · text · photo · link' },
            { n: '02', t: 'Link', d: 'Entities & past captures, automatic' },
            { n: '03', t: 'Brief', d: 'Daily synthesis at 7:00 AM' },
          ].map(x => (
            <div key={x.n} style={{
              padding: '12px 14px', display: 'flex', gap: 14, alignItems: 'center',
              border: `1px solid ${hairline}`,
              background: dark ? '#1C1C1A' : '#FFFFFF',
            }}>
              <div style={{
                fontFamily: 'var(--font-family-monospace)', fontSize: 10,
                color: 'var(--color-book-cloth)', letterSpacing: '0.1em', minWidth: 22,
              }}>{x.n}</div>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div style={{ fontFamily: 'var(--font-family-display)', fontSize: 15, color: ink, fontWeight: 500 }}>{x.t}</div>
                <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{x.d}</div>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <button style={{
          padding: '16px 36px', background: 'var(--color-book-cloth)', border: 'none',
          color: '#FFF', fontSize: 15, fontWeight: 600, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 10,
          boxShadow: '0 6px 18px rgba(204,120,92,0.32)',
        }}>
          <i data-lucide="mic" style={{ width: 17, height: 17, strokeWidth: 1.8 }}></i>
          Record your first thought
        </button>

        <div style={{
          marginTop: 14, fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
          color: secondary, letterSpacing: '0.08em',
        }}>OR TYPE · IMPORT · CONNECT A SOURCE</div>
      </div>
    </MShell>
  );
};

window.MEmpty = MEmpty;
