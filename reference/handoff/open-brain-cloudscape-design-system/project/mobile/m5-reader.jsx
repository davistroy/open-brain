// M5 — Brief reader (long-form). Light + dark. The reader experience.

const MReader = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#D6D4CA' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const bg = dark ? '#141413' : 'var(--color-ivory-light)';

  return (
    <MShell dark={dark} hideTopBar hideTabBar padded={false}>
      <div style={{ background: bg, minHeight: '100%' }}>
        {/* Floating top bar */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 5,
          padding: '54px 20px 12px',
          background: bg,
          borderBottom: `0.5px solid ${hairline}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button style={{ border:'none', background:'transparent', padding:6, cursor:'pointer' }}>
            <i data-lucide="chevron-left" style={{ width:22, height:22, color:ink, strokeWidth:1.8 }}></i>
          </button>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em',
          }}>DAILY · APR 22</div>
          <button style={{ border:'none', background:'transparent', padding:6, cursor:'pointer' }}>
            <i data-lucide="bookmark" style={{ width:20, height:20, color:ink, strokeWidth:1.6 }}></i>
          </button>
        </div>

        <div style={{ padding: '28px 24px 120px' }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: 'var(--color-book-cloth)', letterSpacing: '0.14em',
            textTransform: 'uppercase', marginBottom: 10,
          }}>Daily brief · Tuesday</div>

          <h1 style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 32, fontWeight: 400, lineHeight: 1.1,
            color: ink, letterSpacing: '-0.025em', margin: '0 0 16px',
          }}>Q4 planning momentum — three threads converging this week.</h1>

          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 11,
            color: secondary, letterSpacing: '0.04em', marginBottom: 28,
            paddingBottom: 16, borderBottom: `1px solid ${hairline}`,
          }}>5 MIN READ · 12 CAPTURES · DRAFTED 07:00</div>

          {/* Drop cap opener */}
          <p style={{
            fontSize: 16, lineHeight: 1.65, color: body,
            margin: 0, marginBottom: 20,
          }}>
            <span style={{
              fontFamily: 'var(--font-family-display)',
              fontSize: 56, float: 'left', lineHeight: 0.9,
              marginRight: 8, marginTop: 6, marginBottom: -4,
              color: 'var(--color-book-cloth)',
              fontWeight: 400,
            }}>T</span>
            hree separate threads from the last ten days all feed into Thursday's decision memo, and their sequencing matters more than any of the individual calls. Sarah's headcount proposal, Maya's potential ML pivot, and the advisory board pre-read are no longer independent questions.
          </p>

          <h2 style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em',
            color: ink, margin: '28px 0 10px',
          }}>What moved</h2>

          <p style={{ fontSize: 16, lineHeight: 1.65, color: body, margin: '0 0 14px' }}>
            Your 07:12 walk-and-talk shifted Q4 from rolling hires to <b style={{ color: ink }}>front-loading two roles before the all-hands</b>. This contradicts Sarah's Friday proposal — worth a direct conversation before it hardens.
          </p>

          <p style={{ fontSize: 16, lineHeight: 1.65, color: body, margin: '0 0 20px' }}>
            Avi's comments on slides 12–18 of the advisory deck (received 07:04) raise a valid framing question: are we presenting Q4 as a plan or as a set of open decisions? Your instinct from Sunday's note was the latter.
          </p>

          {/* Pull quote */}
          <div style={{
            borderLeft: `2px solid var(--color-book-cloth)`,
            paddingLeft: 16, margin: '24px 0',
          }}>
            <div style={{
              fontFamily: 'var(--font-family-display)',
              fontSize: 19, lineHeight: 1.4, color: ink,
              fontStyle: 'italic', letterSpacing: '-0.005em',
            }}>"The question is whether October's momentum is a signal or an artifact."</div>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
              color: secondary, letterSpacing: '0.08em', marginTop: 8,
            }}>— YOUR CAPTURE · SUN 14:22</div>
          </div>

          <h2 style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em',
            color: ink, margin: '24px 0 10px',
          }}>Open decisions</h2>

          {[
            { q: 'October front-loaded hiring vs. rolling?', due: '3d' },
            { q: 'Reframe advisory deck around open decisions?', due: '5d' },
            { q: 'Maya: pivot to ML eng this quarter?', due: 'flex' },
          ].map((d, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', gap: 12,
              padding: '10px 0', borderTop: i === 0 ? `1px solid ${hairline}` : 'none',
              borderBottom: `1px solid ${hairline}`,
            }}>
              <span style={{ fontSize: 15, color: ink, flex: 1 }}>{d.q}</span>
              <span style={{ fontFamily:'var(--font-family-monospace)', fontSize: 11, color: secondary, whiteSpace: 'nowrap' }}>{d.due}</span>
            </div>
          ))}

          {/* Foot meta */}
          <div style={{
            marginTop: 32, paddingTop: 16,
            borderTop: `1px solid ${hairline}`,
            display: 'flex', justifyContent: 'space-between',
            fontFamily: 'var(--font-family-monospace)', fontSize: 10.5,
            color: secondary, letterSpacing: '0.06em',
          }}>
            <span>END · 842 WORDS</span>
            <span>12 SOURCES →</span>
          </div>
        </div>
      </div>
    </MShell>
  );
};

window.MReader = MReader;
