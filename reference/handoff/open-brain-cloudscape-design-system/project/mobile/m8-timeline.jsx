// M8 — Timeline (captures feed).

const MTimeline = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  const sections = [
    { d: 'TODAY · APR 22', items: [
      { icon: 'mic', title: 'Morning walk — Q4 planning', snip: 'Need to circle back with Sarah on headcount for the new team…', time: '07:12', tags: ['Sarah Chen', 'Q4', 'Hiring'] },
      { icon: 'mail', title: 'Re: Advisory board deck v3', snip: "Avi — 'Comments on slides 12–18 inline. Can we discuss…'", time: '07:04', tags: ['Avi Sharma'] },
    ]},
    { d: 'YESTERDAY · APR 21', items: [
      { icon: 'file-up', title: 'espresso-machine-research.pdf', snip: '12-page comparison of Lelit vs ECM vs Profitec in the $2.5–4k range', time: '18:40', tags: ['Home Office'] },
      { icon: 'calendar', title: '1:1 with Maya — notes', snip: 'Career goals, mentorship ask, ML certification discussion', time: '15:00', tags: ['Maya Rodriguez', '1:1'] },
    ]},
    { d: 'APR 20', items: [
      { icon: 'edit-3', title: 'Book idea — "operating system for a life"', snip: 'What if personal knowledge management borrowed from ops playbooks?', time: '22:10', tags: ['Book Ideas'] },
    ]},
  ];

  return (
    <MShell dark={dark} active="library"
      eyebrow="84 THIS WEEK · ▲ 12%"
      title="Timeline"
      rightAction={
        <button style={{ border:'none', background:'transparent', padding:6, cursor:'pointer' }}>
          <i data-lucide="sliders-horizontal" style={{ width:18, height:18, color:ink, strokeWidth:1.6 }}></i>
        </button>
      }
    >
      {/* Pull-to-refresh hint */}
      <div style={{
        textAlign: 'center', marginBottom: 18, marginTop: -6,
        fontFamily: 'var(--font-family-monospace)', fontSize: 10,
        color: secondary, letterSpacing: '0.12em',
      }}>↓ PULL TO REFRESH · UPDATED 07:14</div>

      {sections.map(s => (
        <div key={s.d} style={{ marginBottom: 20 }}>
          <div style={{
            fontFamily: 'var(--font-family-monospace)', fontSize: 10,
            color: secondary, letterSpacing: '0.14em', marginBottom: 10,
          }}>{s.d}</div>
          <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>
            {s.items.map((r, i) => (
              <div key={i} style={{
                padding: '14px 16px',
                borderBottom: i === s.items.length - 1 ? 'none' : `0.5px solid ${hairline}`,
              }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                  <div style={{
                    width: 30, height: 30, flexShrink: 0,
                    background: dark ? '#262624' : 'var(--color-ivory-medium)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <i data-lucide={r.icon} style={{ width: 14, height: 14, color: body, strokeWidth: 1.5 }}></i>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 3,
                    }}>
                      <div style={{ fontSize: 14, color: ink, fontWeight: 500, flex: 1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.title}</div>
                      <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary }}>{r.time}</div>
                    </div>
                    <div style={{ fontSize: 13, color: body, lineHeight: 1.45, marginBottom: 8 }}>{r.snip}</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.tags.map(t => (
                        <MPill key={t} tone="neutral" dark={dark}>{t}</MPill>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </MShell>
  );
};

window.MTimeline = MTimeline;
