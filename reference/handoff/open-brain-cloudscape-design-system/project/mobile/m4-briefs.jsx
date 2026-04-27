// M4 — Briefs list. Scannable, editorial.

const MBriefs = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  const briefs = [
    { section: 'Today', items: [
      { kind: 'DAILY BRIEF', title: 'Q4 planning momentum — 3 threads converging', meta: '07:00 · 5 min read · 12 sources', accent: true },
    ]},
    { section: 'This week', items: [
      { kind: 'DECISION MEMO', title: 'Q4 Planning — headcount & sequencing', meta: 'Due Thu · 72% drafted · 12 sources', progress: 72 },
      { kind: 'PRE-READ', title: 'Advisory board meeting', meta: 'Due next Tue · 40% drafted · 8 sources', progress: 40 },
      { kind: 'PURCHASE MEMO', title: 'Espresso machine — Lelit vs ECM', meta: 'Due Apr 30 · 88% drafted · 4 sources', progress: 88 },
    ]},
    { section: 'Earlier', items: [
      { kind: 'DAILY BRIEF', title: 'Monday — light day, 8 captures', meta: 'Yesterday · 3 min read' },
      { kind: 'DAILY BRIEF', title: 'Sunday — weekend reflection', meta: '2d ago · 4 min read' },
      { kind: 'WEEKLY DIGEST', title: 'Week of Apr 14 — 84 captures', meta: 'Apr 20 · 9 min read' },
    ]},
  ];

  return (
    <MShell dark={dark} active="briefs"
      eyebrow="APR 22 · 3 OPEN"
      title="Briefs"
      rightAction={
        <button style={{
          padding: '8px 12px', border: 'none', background: 'var(--color-book-cloth)',
          color: '#FFF', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <i data-lucide="plus" style={{ width: 13, height: 13, strokeWidth: 2.2 }}></i>
          New
        </button>
      }
    >
      {briefs.map(section => (
        <div key={section.section} style={{ marginBottom: 24 }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
            marginBottom: 10,
          }}>{section.section}</div>
          <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>
            {section.items.map((b, i) => (
              <div key={i} style={{
                padding: '16px 16px', borderBottom: i === section.items.length - 1 ? 'none' : `0.5px solid ${hairline}`,
                position: 'relative',
              }}>
                {b.accent && (
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0, width: 2,
                    background: 'var(--color-book-cloth)',
                  }} />
                )}
                <div style={{
                  fontFamily: 'var(--font-family-monospace)', fontSize: 10,
                  color: b.accent ? 'var(--color-book-cloth)' : secondary,
                  letterSpacing: '0.12em', marginBottom: 6,
                }}>{b.kind}</div>
                <div style={{
                  fontFamily: 'var(--font-family-display)', fontSize: 16,
                  color: ink, lineHeight: 1.3, marginBottom: 6, letterSpacing: '-0.005em',
                }}>{b.title}</div>
                <div style={{
                  fontFamily: 'var(--font-family-monospace)', fontSize: 11,
                  color: secondary, letterSpacing: '0.02em',
                }}>{b.meta}</div>
                {b.progress !== undefined && (
                  <div style={{
                    height: 2, background: dark ? '#262624' : 'var(--color-ivory-dark)',
                    marginTop: 10,
                  }}>
                    <div style={{ height: '100%', width: `${b.progress}%`, background: 'var(--color-book-cloth)' }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </MShell>
  );
};

window.MBriefs = MBriefs;
