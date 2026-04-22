// OpenQuestions.jsx — right-rail cards: open questions, upcoming briefs, pipeline health
const OpenQuestions = () => {
  const questions = [
    { text: 'Follow up with Sarah on Q4 planning doc?', captured: '2h ago', source: 'Voice memo' },
    { text: 'Which vendor for the office espresso machine?', captured: 'yesterday', source: 'Note' },
    { text: 'Book dentist appointment before policy renewal', captured: '3d ago', source: 'Email' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {questions.map((q, i) => (
        <div key={i} style={{
          padding: 12,
          border: '1px solid var(--color-border-divider-secondary)',
          borderRadius: 12,
          background: 'var(--color-bg-container)',
          cursor: 'pointer',
          transition: 'border-color 135ms',
        }}
             onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--color-border-item-selected)'}
             onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--color-border-divider-secondary)'}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <i data-lucide="help-circle" style={{ width: 16, height: 16, color: 'var(--color-text-accent)', marginTop: 2, flexShrink: 0 }}></i>
            <div style={{ flex: 1, fontSize: 14, lineHeight: '20px', color: 'var(--color-text-body)' }}>{q.text}</div>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-body-secondary)', marginLeft: 24 }}>
            {q.source} · {q.captured}
          </div>
        </div>
      ))}
      <button style={{
        background: 'transparent', border: 'none',
        color: 'var(--color-text-link)', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
        padding: '6px 0', textAlign: 'left', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>
        View all 14 open questions <i data-lucide="arrow-right" style={{ width: 14, height: 14 }}></i>
      </button>
    </div>
  );
};

const UpcomingBriefs = () => {
  const briefs = [
    { title: 'Weekly exec summary', due: 'Today, 5pm', progress: 72, autoprogress: true },
    { title: 'Q4 investment review', due: 'Thu, Apr 23', progress: 38, autoprogress: false },
    { title: 'Personal board pack', due: 'Mon, Apr 27', progress: 12, autoprogress: false },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {briefs.map((b, i) => (
        <div key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-link)', cursor: 'pointer' }}>{b.title}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-body-secondary)', whiteSpace: 'nowrap' }}>{b.due}</div>
          </div>
          <div style={{ height: 4, background: 'var(--color-grey-200)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
            <div style={{
              width: `${b.progress}%`, height: '100%',
              background: b.autoprogress ? 'var(--color-blue-600)' : 'var(--color-grey-500)',
              borderRadius: 2, transition: 'width 180ms',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 12, color: 'var(--color-text-body-secondary)' }}>
            <span>{b.progress}% complete</span>
            {b.autoprogress && <span style={{ color: 'var(--color-text-label-genai)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i data-lucide="sparkles" style={{ width: 12, height: 12 }}></i> Auto-drafting
            </span>}
          </div>
        </div>
      ))}
    </div>
  );
};

const PipelineHealth = () => {
  const stages = [
    { label: 'Ingest',    count: 47, status: 'success' },
    { label: 'Transcribe', count: 3, status: 'in-progress' },
    { label: 'Embed',     count: 0, status: 'success' },
    { label: 'Link',      count: 2, status: 'in-progress' },
    { label: 'Index',     count: 0, status: 'success' },
  ];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        {stages.map((s, i) => (
          <React.Fragment key={i}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: s.status === 'success' ? 'var(--color-green-50)' : 'var(--color-blue-50)',
                color: s.status === 'success' ? 'var(--color-green-600)' : 'var(--color-blue-600)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `2px solid ${s.status === 'success' ? 'var(--color-green-600)' : 'var(--color-blue-600)'}`,
              }}>
                {s.status === 'success'
                  ? <i data-lucide="check" style={{ width: 14, height: 14 }}></i>
                  : <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-book-cloth)', animation: 'obpulse 1.2s infinite' }} />}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-body)' }}>{s.label}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-body-secondary)' }}>{s.count} items</div>
            </div>
            {i < stages.length - 1 && (
              <div style={{ flex: 0.3, height: 2, background: 'var(--color-green-600)', marginTop: -34, opacity: 0.4 }} />
            )}
          </React.Fragment>
        ))}
      </div>
      <div style={{
        marginTop: 16,
        fontSize: 12, color: 'var(--color-text-body-secondary)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Median latency: <b style={{ color: 'var(--color-text-body)' }}>11s</b></span>
        <span>Queue: <b style={{ color: 'var(--color-text-body)' }}>5</b></span>
        <span>Last sync: <b style={{ color: 'var(--color-text-body)' }}>just now</b></span>
      </div>
    </div>
  );
};

window.OpenQuestions = OpenQuestions;
window.UpcomingBriefs = UpcomingBriefs;
window.PipelineHealth = PipelineHealth;
