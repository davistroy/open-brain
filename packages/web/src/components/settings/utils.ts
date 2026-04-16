/**
 * Convert a cron expression to a simple human-readable description.
 * Covers common patterns without pulling in a full library like cronstrue.
 */
export function describeCron(expr: string): string | null {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dom, month, dow] = fields;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Every hour: "0 * * * *"
  if (minute.match(/^\d+$/) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every hour at minute ${minute}`;
  }

  // Daily at specific time: "M H * * *"
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dom === '*' && month === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily at ${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  // Weekly: "M H * * D"
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dom === '*' && month === '*' && dow.match(/^\d$/)) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const d = parseInt(dow, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const dayName = dayNames[d] ?? `day ${d}`;
    return `Every ${dayName} at ${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  // Every N minutes: "*/N * * * *"
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${minute.slice(2)} minutes`;
  }

  // Every N hours: "0 */N * * *"
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return `Every ${hour.slice(2)} hours`;
  }

  return null;
}

export function formatUptime(seconds?: number): string {
  if (!seconds) return '\u2014';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
