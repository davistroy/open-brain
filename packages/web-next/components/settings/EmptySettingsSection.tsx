import { Construction, type LucideIcon } from 'lucide-react';

interface EmptySettingsSectionProps {
  /** Section heading text (e.g. "Profile"). */
  title: string;
  /**
   * Descriptive copy in Cloudscape editorial voice.
   * Include what the section will do + "This section is under construction — check back soon."
   */
  description: string;
  /** Optional override icon — defaults to Construction. */
  icon?: LucideIcon;
}

/**
 * EmptySettingsSection — reusable placeholder for settings sections not yet
 * implemented. Renders inside the settings content area with a bordered card
 * matching the Cloudscape design language.
 *
 * Server component (no interactivity needed).
 */
export function EmptySettingsSection({
  title,
  description,
  icon: Icon = Construction,
}: EmptySettingsSectionProps) {
  return (
    <div className="bg-bg-container border border-cloud-light px-8 py-10">
      {/* Section heading row */}
      <div className="flex items-center gap-3 mb-6 pb-6 border-b border-cloud-light">
        <div className="w-8 h-8 flex items-center justify-center border border-cloud-light shrink-0">
          <Icon
            size={15}
            strokeWidth={1.3}
            className="text-cloud-dark"
          />
        </div>
        <h2 className="font-display text-[17px] font-normal tracking-[-0.01em] text-text-heading">
          {title}
        </h2>
      </div>

      {/* Empty state body */}
      <div className="flex flex-col items-center text-center py-8">
        <div className="text-[13px] text-text-body-secondary font-light max-w-[440px] leading-[1.6]">
          {description}
        </div>
      </div>
    </div>
  );
}
