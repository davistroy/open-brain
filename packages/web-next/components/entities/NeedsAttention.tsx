import { Card } from '@/components/design-system';
import type { NeedsAttentionItem } from '@/lib/types';

interface NeedsAttentionProps {
  items: NeedsAttentionItem[];
}

/**
 * "Needs attention" sidebar card — low-confidence extraction list.
 * Each row shows a label (possible duplicate / ambiguous ref) with hover bg.
 * Server component.
 */
export function NeedsAttention({ items }: NeedsAttentionProps) {
  return (
    <Card
      header="Needs attention"
      description="Low-confidence extractions"
      padded={false}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className={[
            'px-[16px] py-[10px] cursor-pointer',
            'hover:bg-ivory-dark transition-colors duration-[120ms]',
            i < items.length - 1 ? 'border-b border-cloud-light' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className="text-[12.5px] font-normal text-text-heading">
            {item.label}
          </div>
          <div className="text-[11.5px] font-light text-text-body-secondary mt-[2px]">
            {item.desc}
          </div>
        </div>
      ))}
    </Card>
  );
}
