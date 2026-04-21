// StatsCards.jsx — KeyValue-pair stat tiles at the top of the dashboard
const StatsCards = () => {
  const stats = [
    { label: 'Captures today',     value: '47',  delta: '+12 vs avg', trend: 'up',   trendType: 'success' },
    { label: 'Pending review',     value: '8',   delta: '2 urgent',    trend: 'flag', trendType: 'warning' },
    { label: 'Active briefs',      value: '3',   delta: '1 due today', trend: 'up',   trendType: 'info' },
    { label: 'Knowledge graph',    value: '1.2k', delta: '+84 this week', trend: 'up', trendType: 'success', sub: 'entities' },
  ];
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 20,
    }}>
      {stats.map((s, i) => (
        <div key={i} style={{
          background: 'var(--color-bg-container)',
          borderRadius: 16,
          boxShadow: 'var(--shadow-container)',
          padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-body-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {s.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{ fontSize: 32, lineHeight: '40px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-text-heading)' }}>
              {s.value}
            </div>
            {s.sub && <div style={{ fontSize: 13, color: 'var(--color-text-body-secondary)' }}>{s.sub}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <i data-lucide={s.trend === 'up' ? 'trending-up' : s.trend === 'flag' ? 'flag' : 'minus'}
               style={{
                 width: 14, height: 14,
                 color: s.trendType === 'success' ? 'var(--color-text-status-success)'
                      : s.trendType === 'warning' ? 'var(--color-text-status-warning)'
                      : 'var(--color-text-status-info)'
               }}></i>
            <span style={{ color: 'var(--color-text-body-secondary)' }}>{s.delta}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

window.StatsCards = StatsCards;
