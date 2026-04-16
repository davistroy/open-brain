import { useState } from 'react';
import { Shield, AlertCircle, CheckCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { AutonomyLevel } from '@/lib/types';

export interface AutonomyLevelSectionProps {
  level: AutonomyLevel;
  loading: boolean;
  error: string | null;
  onChange: (level: AutonomyLevel) => Promise<void>;
}

const AUTONOMY_LEVELS: { value: AutonomyLevel; label: string; description: string }[] = [
  { value: 'observe', label: 'Observe', description: 'Notifications only \u2014 no autonomous actions' },
  { value: 'assist', label: 'Assist', description: 'Draft + notify \u2014 human relays responses' },
  { value: 'advise', label: 'Advise', description: 'Act + report \u2014 posts with clear bot attribution' },
  { value: 'partner', label: 'Partner', description: 'Autonomous within guardrails' },
];

export function AutonomyLevelSection({ level, loading, error, onChange }: AutonomyLevelSectionProps) {
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  async function handleChange(newLevel: AutonomyLevel) {
    if (newLevel === level) return;
    setSaving(true);
    setSaveResult(null);
    try {
      await onChange(newLevel);
      setSaveResult({ success: true, message: 'Saved' });
      setTimeout(() => setSaveResult(null), 3000);
    } catch (err) {
      setSaveResult({ success: false, message: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Autonomy Level</h2>
        {saveResult && (
          <Badge variant={saveResult.success ? 'default' : 'destructive'} className="text-xs">
            {saveResult.success ? <CheckCircle className="h-3 w-3 mr-1" /> : <AlertCircle className="h-3 w-3 mr-1" />}
            {saveResult.message}
          </Badge>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-12 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {AUTONOMY_LEVELS.map((opt) => (
            <label
              key={opt.value}
              className={`px-4 py-3 flex items-start gap-3 cursor-pointer transition-colors hover:bg-accent/50 ${
                saving ? 'opacity-60 pointer-events-none' : ''
              }`}
            >
              <input
                type="radio"
                name="autonomy_level"
                value={opt.value}
                checked={level === opt.value}
                onChange={() => handleChange(opt.value)}
                disabled={saving}
                className="mt-0.5 accent-primary"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{opt.label}</span>
                  {level === opt.value && (
                    <Badge variant="default" className="text-xs">Active</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
