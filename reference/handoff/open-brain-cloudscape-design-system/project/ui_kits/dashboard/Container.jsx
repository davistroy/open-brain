// Container.jsx — Cloudscape container + header pattern
const Container = ({ header, actions, description, children, variant = 'default', padding = true }) => (
  <section style={{
    background: 'var(--color-bg-container)',
    borderRadius: 16,
    boxShadow: 'var(--shadow-container)',
    overflow: 'hidden',
  }}>
    {(header || actions) && (
      <div style={{
        padding: '16px 20px',
        display: 'flex', alignItems: 'flex-start', gap: 16,
        borderBottom: variant === 'stacked' ? '1px solid var(--color-border-divider-secondary)' : 'none',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {header && <h3 style={{ margin: 0 }}>{header}</h3>}
          {description && <div style={{ fontSize: 14, color: 'var(--color-text-body-secondary)', marginTop: 4 }}>{description}</div>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div>}
      </div>
    )}
    <div style={{ padding: padding ? '4px 20px 20px' : 0 }}>
      {children}
    </div>
  </section>
);

window.Container = Container;
