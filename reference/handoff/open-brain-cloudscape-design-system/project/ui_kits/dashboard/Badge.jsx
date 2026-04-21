// Badge.jsx — Cloudscape status indicators + badges
const StatusIndicator = ({ type = 'info', children }) => {
  const map = {
    success: { color: 'var(--color-text-status-success)', icon: 'check-circle' },
    error:   { color: 'var(--color-text-status-error)',   icon: 'x-circle' },
    warning: { color: 'var(--color-text-status-warning)', icon: 'alert-triangle' },
    info:    { color: 'var(--color-text-status-info)',    icon: 'info' },
    pending: { color: 'var(--color-text-body-secondary)', icon: 'clock' },
    loading: { color: 'var(--color-text-body-secondary)', icon: 'loader' },
    'in-progress': { color: 'var(--color-text-status-info)', icon: 'clock' },
    stopped: { color: 'var(--color-text-body-secondary)', icon: 'minus-circle' },
  };
  const entry = map[type] || map.info;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: entry.color, fontSize: 14, whiteSpace: 'nowrap' }}>
      <i data-lucide={entry.icon} style={{ width: 14, height: 14 }}></i>
      <span>{children}</span>
    </span>
  );
};

const Badge = ({ color = 'grey', children }) => {
  const palette = {
    grey:  { bg: 'var(--color-grey-250)', fg: 'var(--color-text-body)' },
    blue:  { bg: 'var(--color-blue-50)', fg: 'var(--color-blue-700)' },
    green: { bg: 'var(--color-green-50)', fg: 'var(--color-green-600)' },
    red:   { bg: 'var(--color-red-50)', fg: 'var(--color-red-600)' },
    severity: { bg: 'var(--color-red-600)', fg: '#fff' },
  };
  const { bg, fg } = palette[color] || palette.grey;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: bg, color: fg,
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 12, fontWeight: 600, lineHeight: '16px',
      letterSpacing: '0.01em',
    }}>{children}</span>
  );
};

window.StatusIndicator = StatusIndicator;
window.Badge = Badge;
