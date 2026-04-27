// M7 — Board (decisions / commitments).

const MBoard = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  const columns = [
    { name: 'Open', count: 4, items: [
      { t: 'October front-loaded hiring vs. rolling?', meta: '3 captures · due 3d', pri: 'high' },
      { t: 'Lelit Bianca vs ECM Synchronika', meta: '2 captures · 1 brief', pri: 'med' },
    ]},
    { name: 'Pondering', count: 3, items: [
      { t: 'Should Maya pivot to ML eng this quarter?', meta: '4 captures · flexible', pri: 'med' },
      { t: 'Reframe advisory deck: plan vs decisions', meta: '2 captures · 5d', pri: 'med' },
    ]},
    { name: 'Decided', count: 8, items: [
      { t: 'Q4 kickoff Friday → moved to Monday', meta: 'Apr 18 · Sarah Chen', pri: 'done' },
    ]},
  ];

  return (
    <MShell dark={dark} active="board"
      eyebrow="15 TOTAL · 2 OVERDUE"
      title="Board"
      rightAction={
        <button style={{ border:'none', background:'transparent', padding:6, cursor:'pointer' }}>
          <i data-lucide="filter" style={{ width:18, height:18, color:ink, strokeWidth:1.6 }}></i>
        </button>
      }
    >
      {/* Column tabs */}
      <div style={{
        display: 'flex', gap: 0, marginBottom: 20,
        borderBottom: `1px solid ${hairline}`,
      }}>
        {columns.map((c, i) => (
          <div key={c.name} style={{
            padding: '10px 14px 10px 0', marginRight: 20,
            borderBottom: i === 0 ? `2px solid var(--color-book-cloth)` : 'none',
            marginBottom: -1,
          }}>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 11,
              color: i === 0 ? ink : secondary, letterSpacing: '0.08em',
              textTransform: 'uppercase', fontWeight: i === 0 ? 500 : 400,
            }}>
              {c.name} <span style={{ color: secondary, marginLeft: 4 }}>{c.count}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Cards for first column */}
      {columns[0].items.map((it, i) => (
        <div key={i} style={{
          background: cardBg, border: `1px solid ${hairline}`, padding: 16, marginBottom: 10,
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
            background: it.pri === 'high' ? 'var(--color-book-cloth)' : (dark ? '#3A3A36' : 'var(--color-cloud-medium)'),
          }} />
          <div style={{ marginLeft: 6 }}>
            <div style={{
              fontFamily: 'var(--font-family-monospace)', fontSize: 10,
              color: it.pri === 'high' ? 'var(--color-book-cloth)' : secondary,
              letterSpacing: '0.12em', marginBottom: 6,
            }}>{it.pri === 'high' ? 'HIGH PRIORITY' : 'MEDIUM'}</div>
            <div style={{
              fontFamily: 'var(--font-family-display)', fontSize: 16,
              color: ink, lineHeight: 1.3, letterSpacing: '-0.005em', marginBottom: 10,
            }}>{it.t}</div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              paddingTop: 10, borderTop: `0.5px solid ${hairline}`,
            }}>
              <span style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{it.meta}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button style={{ border:'none', background:'transparent', padding:4, cursor:'pointer' }}>
                  <i data-lucide="check" style={{ width:14, height:14, color: secondary, strokeWidth:1.8 }}></i>
                </button>
                <button style={{ border:'none', background:'transparent', padding:4, cursor:'pointer' }}>
                  <i data-lucide="arrow-right" style={{ width:14, height:14, color: secondary, strokeWidth:1.8 }}></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      <div style={{
        padding: '14px 16px', border: `1px dashed ${dark ? 'rgba(240,238,230,0.14)' : 'var(--color-cloud-medium)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        color: secondary, fontSize: 13, marginTop: 4, marginBottom: 24,
      }}>
        <i data-lucide="plus" style={{ width: 14, height: 14, strokeWidth: 1.6 }}></i>
        Add question
      </div>

      {/* Pondering section */}
      <div style={{
        fontFamily: 'var(--font-family-monospace)', fontSize: 10,
        color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10,
      }}>Pondering · waiting on signal</div>
      <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>
        {columns[1].items.map((it, i, a) => (
          <div key={i} style={{
            padding: '14px 16px',
            borderBottom: i === a.length - 1 ? 'none' : `0.5px solid ${hairline}`,
          }}>
            <div style={{ fontSize: 14, color: ink, fontWeight: 500, marginBottom: 4 }}>{it.t}</div>
            <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{it.meta}</div>
          </div>
        ))}
      </div>
    </MShell>
  );
};

window.MBoard = MBoard;
