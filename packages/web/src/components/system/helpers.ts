/**
 * Shared helper functions for System page tab components.
 */

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Convert a cron expression to a simple human-readable description.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;

  const [minute, hour, dom, month, dow] = fields;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Every N minutes: "*/N * * * *"
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${minute.slice(2)} min`;
  }

  // Every hour: "M * * * *"
  if (minute.match(/^\d+$/) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Hourly at :${minute.padStart(2, '0')}`;
  }

  // Every N hours: "0 */N * * *"
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return `Every ${hour.slice(2)}h`;
  }

  // Daily: "M H * * *"
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dom === '*' && month === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily ${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  // Weekly: "M H * * D"
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dom === '*' && month === '*' && dow.match(/^\d$/)) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const d = parseInt(dow, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const dayName = dayNames[d] ?? `day ${d}`;
    return `${dayName} ${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  return expr;
}

/**
 * Basic client-side cron expression validation.
 * Accepts standard 5-field cron: minute hour day-of-month month day-of-week
 */
export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern = /^(\*|[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*)(\/([0-9]+))?$/;
  return fields.every((f) => fieldPattern.test(f));
}

export function statusColor(status: string): string {
  if (status === 'healthy') return 'text-green-500';
  if (status === 'degraded') return 'text-yellow-500';
  return 'text-red-500';
}

export function statusBgColor(status: string): string {
  if (status === 'healthy') return 'bg-green-500/10 border-green-500/30';
  if (status === 'degraded') return 'bg-yellow-500/10 border-yellow-500/30';
  return 'bg-red-500/10 border-red-500/30';
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes === 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
