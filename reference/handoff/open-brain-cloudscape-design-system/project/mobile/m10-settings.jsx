// M10 — Settings.

const MSettings = ({ dark = false }) => {
  const ink = dark ? '#F0EEE6' : 'var(--color-text-heading)';
  const body = dark ? '#C2C0B6' : 'var(--color-text-body)';
  const secondary = dark ? '#8F8E85' : 'var(--color-text-body-secondary)';
  const hairline = dark ? 'rgba(240,238,230,0.08)' : 'var(--color-cloud-light)';
  const cardBg = dark ? '#1C1C1A' : '#FFFFFF';

  const Section = ({ label, children }) => (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontFamily: 'var(--font-family-monospace)', fontSize: 10,
        color: secondary, letterSpacing: '0.12em', textTransform: 'uppercase',
        marginBottom: 8, padding: '0 4px',
      }}>{label}</div>
      <div style={{ background: cardBg, border: `1px solid ${hairline}` }}>{children}</div>
    </div>
  );

  const Row = ({ icon, title, sub, right, last }) => (
    <div style={{
      padding: '14px 16px', display: 'flex', gap: 14, alignItems: 'center',
      borderBottom: last ? 'none' : `0.5px solid ${hairline}`,
    }}>
      {icon && (
        <div style={{
          width: 30, height: 30, flexShrink: 0,
          background: dark ? '#262624' : 'var(--color-ivory-medium)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <i data-lucide={icon} style={{ width: 14, height: 14, color: body, strokeWidth: 1.5 }}></i>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, color: ink, fontWeight: 500 }}>{title}</div>
        {sub && <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary, marginTop: 2 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );

  const Toggle = ({ on }) => (
    <div style={{
      width: 44, height: 26, borderRadius: 13,
      background: on ? 'var(--color-book-cloth)' : (dark ? '#3A3A36' : 'var(--color-cloud-medium)'),
      position: 'relative', transition: '0.15s',
    }}>
      <div style={{
        position: 'absolute', top: 2, left: on ? 20 : 2, width: 22, height: 22, borderRadius: '50%',
        background: '#FFF', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </div>
  );

  const Chev = () => <i data-lucide="chevron-right" style={{ width: 16, height: 16, color: secondary, strokeWidth: 1.6 }}></i>;

  return (
    <MShell dark={dark} active="library"
      eyebrow="ACCOUNT · TROY @ OPEN BRAIN"
      title="Settings"
    >
      {/* Profile card */}
      <div style={{
        background: cardBg, border: `1px solid ${hairline}`, padding: 16, marginBottom: 22,
        display: 'flex', gap: 14, alignItems: 'center',
      }}>
        <div style={{
          width: 52, height: 52, background: 'var(--color-book-cloth)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#FFF', fontFamily: 'var(--font-family-display)', fontSize: 20, fontWeight: 500,
        }}>T</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-family-display)', fontSize: 17, color: ink, letterSpacing: '-0.01em' }}>Troy Jenkins</div>
          <div style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 11, color: secondary, marginTop: 2 }}>troy@openbrain.co · iCloud synced</div>
        </div>
        <Chev />
      </div>

      <Section label="Capture">
        <Row icon="mic" title="Voice transcription" sub="Whisper large-v3 · on-device" right={<Toggle on />} />
        <Row icon="brain" title="Auto-extract entities" sub="Claude haiku 4.5" right={<Toggle on />} />
        <Row icon="sparkles" title="Daily brief" sub="Generate at 7:00 AM" right={<Toggle on />} last />
      </Section>

      <Section label="Sources">
        <Row icon="mail" title="Gmail" sub="troy@openbrain.co · 2,341 captures" right={<Chev />} />
        <Row icon="calendar" title="Google Calendar" sub="2 calendars · 186 events" right={<Chev />} />
        <Row icon="slack" title="Slack" sub="3 workspaces · paused" right={<Chev />} last />
      </Section>

      <Section label="Appearance">
        <Row icon="sun" title="Theme" sub="System" right={<Chev />} />
        <Row icon="type" title="Reading size" sub="Medium" right={<Chev />} last />
      </Section>

      <Section label="Privacy">
        <Row icon="lock" title="Everything stays yours" sub="Data lives on-device and in your iCloud" right={<Chev />} />
        <Row icon="download" title="Export all data" sub="JSON · 127 MB" right={<Chev />} last />
      </Section>

      <div style={{ textAlign: 'center', padding: '16px 0 0', color: secondary, fontFamily: 'var(--font-family-monospace)', fontSize: 10.5, letterSpacing: '0.08em' }}>
        OPEN BRAIN · v1.2.0 · BUILD 2026.04
      </div>
    </MShell>
  );
};

window.MSettings = MSettings;
