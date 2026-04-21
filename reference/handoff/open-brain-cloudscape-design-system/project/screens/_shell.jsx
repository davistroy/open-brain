// _shell.jsx — shared page scaffolding for every Open Brain screen.
// Wraps TopNav + SideNav + the main content column with consistent breadcrumb + title.
// Depends on: TopNav, SideNav (from ui_kits/dashboard/), Button, Container.

const Shell = ({ active, breadcrumb = [], title, subtitle, actions, children, padded = true, maxWidth = 1280, theme = 'light' }) => {
  const [wash, setWash] = React.useState(() => {
    try { return localStorage.getItem('ob-wash') || 'parchment'; } catch { return 'parchment'; }
  });
  const [tweaksOpen, setTweaksOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  React.useEffect(() => {
    if (wash === 'peach') document.documentElement.removeAttribute('data-wash');
    else document.documentElement.setAttribute('data-wash', wash);
    try { localStorage.setItem('ob-wash', wash); } catch {}
  }, [wash]);
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });

  // Host Tweaks integration — register listener BEFORE announcing availability.
  React.useEffect(() => {
    const handler = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === '__activate_edit_mode') setTweaksOpen(true);
      if (e.data.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', handler);
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div>
      <TopNav />
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <SideNav active={active} />
        <main style={{
          flex: 1, minWidth: 0,
          padding: padded ? '22px 32px 48px' : 0,
        }}>
          <div style={{ maxWidth, margin: '0 auto' }}>
            {(breadcrumb.length > 0 || title) && (
              <div style={{ marginBottom: 18 }}>
                {breadcrumb.length > 0 && (
                  <div style={{
                    fontFamily: 'var(--font-family-monospace)',
                    fontSize: 10.5, color: 'var(--color-text-body-secondary)',
                    display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10,
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                  }}>
                    {breadcrumb.map((b, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span style={{ opacity: 0.4 }}>/</span>}
                        <span style={i === breadcrumb.length - 1 ? { color: 'var(--color-text-heading)' } : {}}>{b}</span>
                      </React.Fragment>
                    ))}
                  </div>
                )}
                {title && (
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <h1 style={{
                        margin: 0,
                        fontFamily: 'var(--font-family-display)',
                        fontSize: 30, fontWeight: 400,
                        letterSpacing: '-0.02em',
                        color: 'var(--color-text-heading)',
                        lineHeight: 1.1,
                      }}>{title}</h1>
                      {subtitle && (
                        <div style={{
                          fontSize: 13.5, color: 'var(--color-text-body-secondary)',
                          marginTop: 6, fontWeight: 300, letterSpacing: '0.005em',
                          maxWidth: 640,
                        }}>{subtitle}</div>
                      )}
                    </div>
                    {actions && (
                      <div style={{ display: 'flex', gap: 8 }}>{actions}</div>
                    )}
                  </div>
                )}
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
      {tweaksOpen && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
          background: 'var(--color-bg-container)',
          border: '1px solid var(--color-cloud-medium)',
          boxShadow: '0 8px 32px rgba(20,20,19,0.18)',
          padding: '14px 16px', width: 280,
          fontFamily: 'var(--font-family-base)',
        }}>
          <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 10.5, color: 'var(--color-text-body-secondary)', letterSpacing: '0.08em', marginBottom: 10 }}>TWEAKS</div>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-heading)', fontWeight: 400, marginBottom: 8 }}>Soft-accent wash</div>
          <div style={{ fontSize: 11.5, color: 'var(--color-text-body-secondary)', fontWeight: 300, marginBottom: 12, lineHeight: 1.4 }}>The wash used behind active rows, brief hero, and selection states.</div>
          {[
            { id: 'peach',     label: 'Peach (default)',  swatch: '#FBEFE9' },
            { id: 'kraft',     label: 'Kraft — manila',   swatch: '#FAF1E9' },
            { id: 'parchment', label: 'Parchment — cool', swatch: '#EFE6D8' },
            { id: 'moss',      label: 'Moss — sage',      swatch: '#EEF1EC' },
          ].map(opt => (
            <label key={opt.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', cursor: 'pointer',
              background: wash === opt.id ? 'var(--color-ivory-dark)' : 'transparent',
              border: wash === opt.id ? '1px solid var(--color-cloud-medium)' : '1px solid transparent',
              marginBottom: 2,
            }}>
              <input type="radio" name="wash" checked={wash === opt.id} onChange={() => setWash(opt.id)} style={{ accentColor: 'var(--color-book-cloth)' }} />
              <div style={{ width: 16, height: 16, background: opt.swatch, border: '1px solid var(--color-cloud-medium)' }}></div>
              <span style={{ fontSize: 12, color: 'var(--color-text-heading)' }}>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

// Small reusable display primitives used across screens.

const Pill = ({ children, tone = 'neutral', size = 'sm' }) => {
  const tones = {
    neutral: { bg: 'var(--color-ivory-dark)', fg: 'var(--color-text-body)', border: 'var(--color-cloud-light)' },
    accent:  { bg: 'var(--color-book-cloth-50)', fg: 'var(--color-book-cloth-dark)', border: '#EBCFC0' },
    success: { bg: '#EEF3E8', fg: '#4A7237', border: '#CFE0C8' },
    warning: { bg: '#FBF6EC', fg: '#8B6A3A', border: '#EFD9B8' },
    error:   { bg: '#FBF0ED', fg: '#8C3F28', border: '#EBCAC3' },
    ghost:   { bg: 'transparent', fg: 'var(--color-text-body-secondary)', border: 'var(--color-cloud-light)' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: 'var(--font-family-base)',
      fontSize: size === 'xs' ? 10.5 : 11.5,
      fontWeight: 400,
      padding: size === 'xs' ? '1px 6px' : '2px 8px',
      background: t.bg, color: t.fg,
      border: `1px solid ${t.border}`,
      borderRadius: 0,
      letterSpacing: '0.005em',
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
};

// Monospace metadata label — pairs an all-caps key with a value, separated by colon.
const MetaLine = ({ label, children }) => (
  <span style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 10.5, color: 'var(--color-text-body-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
    {label}: <span style={{ color: 'var(--color-text-heading)', fontWeight: 400 }}>{children}</span>
  </span>
);

// A thin horizontal rule used between stacked sections.
const Rule = ({ margin = '16px 0' }) => (
  <div style={{ height: 1, background: 'var(--color-cloud-light)', margin, border: 0 }} />
);

// Section heading for in-container groupings — eyebrow style.
const Eyebrow = ({ children }) => (
  <div style={{
    fontFamily: 'var(--font-family-monospace)',
    fontSize: 10.5, fontWeight: 400,
    letterSpacing: '0.08em', textTransform: 'uppercase',
    color: 'var(--color-text-body-secondary)',
    marginBottom: 10,
  }}>{children}</div>
);

// Empty-state block — for when a screen has no data yet.
const EmptyState = ({ icon = 'inbox', title, description, action }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '48px 32px', textAlign: 'center',
    color: 'var(--color-text-body-secondary)',
  }}>
    <div style={{
      width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '1px solid var(--color-cloud-light)', marginBottom: 14,
    }}>
      <i data-lucide={icon} style={{ width: 18, height: 18, strokeWidth: 1.3, color: 'var(--color-cloud-dark)' }}></i>
    </div>
    <div style={{
      fontFamily: 'var(--font-family-display)', fontSize: 18, fontWeight: 400,
      color: 'var(--color-text-heading)', letterSpacing: '-0.01em',
    }}>{title}</div>
    {description && (
      <div style={{ fontSize: 13, marginTop: 6, maxWidth: 400, lineHeight: 1.5, fontWeight: 300 }}>{description}</div>
    )}
    {action && <div style={{ marginTop: 16 }}>{action}</div>}
  </div>
);

// Refined card + button primitives (hard corners, thin weights) — use these on new screens.
const SCard = ({ header, description, actions, children, padded = true, style = {} }) => (
  <section style={{
    background: 'var(--color-bg-container)',
    border: '1px solid var(--color-cloud-light)',
    borderRadius: 0,
    ...style,
  }}>
    {(header || actions) && (
      <div style={{
        padding: '12px 18px 12px',
        display: 'flex', alignItems: 'flex-start', gap: 16,
        borderBottom: '1px solid var(--color-cloud-light)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {header && <div style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 15, fontWeight: 400,
            letterSpacing: '-0.005em',
            color: 'var(--color-text-heading)',
          }}>{header}</div>}
          {description && <div style={{
            fontSize: 12.5, color: 'var(--color-text-body-secondary)',
            marginTop: 3, fontWeight: 300, letterSpacing: '0.005em',
          }}>{description}</div>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{actions}</div>}
      </div>
    )}
    <div style={{ padding: padded ? '16px 18px' : 0 }}>{children}</div>
  </section>
);

const SBtn = ({ variant = 'normal', icon, iconRight, children, size = 'normal', onClick, disabled, type }) => {
  const base = {
    fontFamily: 'var(--font-family-base)',
    fontWeight: 400,
    letterSpacing: '0.005em',
    fontSize: size === 'small' ? 12 : 13,
    padding: size === 'small' ? '4px 10px' : '6px 14px',
    borderRadius: 0,
    border: '1px solid',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
    transition: 'background 120ms, border-color 120ms, color 120ms',
    opacity: disabled ? 0.5 : 1,
  };
  const variants = {
    primary: { background: 'var(--color-book-cloth)', borderColor: 'var(--color-book-cloth)', color: 'var(--color-ivory-light)' },
    normal:  { background: 'var(--color-bg-container)', borderColor: 'var(--color-cloud-medium)', color: 'var(--color-text-heading)' },
    ghost:   { background: 'transparent', borderColor: 'transparent', color: 'var(--color-text-body-secondary)' },
    link:    { background: 'transparent', borderColor: 'transparent', color: 'var(--color-book-cloth-dark)', padding: size === 'small' ? '2px 6px' : '4px 8px' },
    dark:    { background: 'var(--color-slate-medium)', borderColor: 'var(--color-slate-medium)', color: 'var(--color-ivory-light)' },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant] }}>
      {icon}{children}{iconRight}
    </button>
  );
};

// Minimal text/number input + select for forms across screens.
const SInput = ({ icon, style = {}, ...rest }) => (
  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
    {icon && <i data-lucide={icon} style={{ width: 13, height: 13, strokeWidth: 1.5, position: 'absolute', left: 10, color: 'var(--color-text-body-secondary)' }}></i>}
    <input {...rest} style={{
      width: '100%', height: 30,
      background: 'var(--color-bg-container)',
      border: '1px solid var(--color-cloud-medium)', borderRadius: 0,
      padding: icon ? '0 12px 0 30px' : '0 12px',
      fontFamily: 'var(--font-family-base)', fontSize: 13, fontWeight: 300,
      color: 'var(--color-text-body)', outline: 'none',
      ...style,
    }} />
  </div>
);

Object.assign(window, { Shell, Pill, MetaLine, Rule, Eyebrow, EmptyState, SCard, SBtn, SInput });
