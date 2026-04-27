// M2 — Record active (light + dark). Full-screen recording state with live waveform + transcript preview.

const MRecord = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const bg = dark ? '#0E0E0D' : 'var(--color-ivory-medium)';

  // Procedural waveform bars
  const bars = Array.from({ length: 48 }, (_, i) => {
    const t = i / 48;
    const h = 8 + Math.abs(Math.sin(t * 18) * Math.cos(t * 7) * 52) + (i > 38 ? (48 - i) * 4 : 0);
    return Math.max(4, h);
  });

  return (
    <MShell dark={dark} hideTopBar hideTabBar padded={false}>
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        background: bg,
      }}>
        {/* Top meta */}
        <div style={{ padding: '60px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10,
              color: 'var(--color-book-cloth)', letterSpacing: '0.14em', marginBottom: 4,
            }}>● RECORDING</div>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 11,
              color: secondary, letterSpacing: '0.04em',
            }}>TUE · 07:14 · EN-US</div>
          </div>
          <button style={{
            border: 'none', background: 'transparent', padding: 8, cursor: 'pointer',
          }}>
            <i data-lucide="x" style={{ width: 22, height: 22, color: ink, strokeWidth: 1.6 }}></i>
          </button>
        </div>

        {/* Elapsed */}
        <div style={{
          padding: '40px 24px 8px', textAlign: 'center',
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 56, fontWeight: 300, color: ink,
          letterSpacing: '-0.02em',
        }}>01:27</div>
        <div style={{
          textAlign: 'center',
          fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
          color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: 32,
        }}>ELAPSED · TAP TO PAUSE</div>

        {/* Waveform */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 3, height: 120, padding: '0 24px',
        }}>
          {bars.map((h, i) => (
            <div key={i} style={{
              width: 3, height: h, borderRadius: 2,
              background: i > 38 ? 'var(--color-book-cloth)' : (dark ? '#3A3A36' : 'var(--color-cloud-medium)'),
              opacity: i > 38 ? 1 : 0.9,
            }} />
          ))}
        </div>

        {/* Live transcript preview */}
        <div style={{ flex: 1, padding: '32px 24px 24px', overflow: 'auto' }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
            marginBottom: 10,
          }}>Live transcript</div>
          <div style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 18, lineHeight: 1.5, color: ink, letterSpacing: '-0.005em',
          }}>
            <span>Need to circle back with <u style={{ textDecorationColor: 'var(--color-book-cloth)', textUnderlineOffset: 3 }}>Sarah</u> on headcount for the new team — we said rolling hires through Q4 but the October momentum means we should probably front-load </span>
            <span style={{ color: secondary }}>the first two roles before the all-hands</span>
            <span style={{
              display: 'inline-block', width: 8, height: 18,
              background: 'var(--color-book-cloth)', marginLeft: 2,
              verticalAlign: 'text-bottom',
            }} />
          </div>
        </div>

        {/* Controls */}
        <div style={{
          padding: '20px 24px 44px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderTop: `0.5px solid ${dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)'}`,
          background: dark ? '#141413' : '#FFFFFF',
        }}>
          <button style={{
            width: 48, height: 48, border: `1px solid ${dark ? 'rgba(240,238,230,0.12)' : 'var(--color-cloud-medium)'}`,
            background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <i data-lucide="rotate-ccw" style={{ width: 18, height: 18, color: ink, strokeWidth: 1.6 }}></i>
          </button>
          {/* Stop = terracotta square */}
          <button style={{
            width: 68, height: 68, borderRadius: '50%',
            background: 'var(--color-book-cloth)',
            border: '4px solid ' + (dark ? '#0E0E0D' : 'var(--color-ivory-medium)'),
            boxShadow: '0 0 0 2px var(--color-book-cloth), 0 6px 18px rgba(204,120,92,0.4)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ width: 22, height: 22, background: '#FFF' }} />
          </button>
          <button style={{
            width: 48, height: 48, border: `1px solid ${dark ? 'rgba(240,238,230,0.12)' : 'var(--color-cloud-medium)'}`,
            background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <i data-lucide="check" style={{ width: 18, height: 18, color: ink, strokeWidth: 1.8 }}></i>
          </button>
        </div>
      </div>
    </MShell>
  );
};

window.MRecord = MRecord;
