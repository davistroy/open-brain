'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Download, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { downloadMarkdown, triggerPrint } from '@/lib/export';

interface BriefExportMenuProps {
  /** The brief title — used to generate the filename slug. */
  title: string;
  /** Pre-rendered HTML body of the brief. May be empty for briefs without body. */
  bodyHtml: string;
  /** The trigger element (e.g. a Button) that opens the dropdown. */
  children: React.ReactNode;
}

/**
 * Brief export dropdown — two options:
 *   1. Download as Markdown — converts body_html → .md and triggers a download.
 *   2. Print to PDF — calls window.print() which targets @media print styles.
 *
 * Built on Radix DropdownMenu for accessible keyboard navigation and
 * focus management with no external CSS dependency.
 */
export function BriefExportMenu({ title, bodyHtml, children }: BriefExportMenuProps) {
  function handleDownloadMarkdown() {
    try {
      downloadMarkdown(bodyHtml, title);
    } catch {
      toast.error('Could not export brief — please try again.');
    }
  }

  function handlePrint() {
    try {
      triggerPrint();
    } catch {
      toast.error('Could not open print dialog — please try again.');
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {children}
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className={[
            // Container — matches design system dropdown token
            'min-w-[180px] rounded-none border border-cloud-light bg-bg-dropdown',
            'shadow-dropdown z-50 py-[4px]',
            // Entrance animation
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
          ].join(' ')}
        >
          <DropdownMenu.Item
            onSelect={handleDownloadMarkdown}
            className={[
              'flex items-center gap-[8px] px-[12px] py-[7px] cursor-pointer select-none outline-none',
              'text-[12.5px] font-light text-text-body',
              'hover:bg-book-cloth-50 hover:text-text-heading',
              'focus:bg-book-cloth-50 focus:text-text-heading',
              'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
            ].join(' ')}
          >
            <Download size={13} strokeWidth={1.5} className="shrink-0 text-text-body-secondary" />
            <span>Download as Markdown</span>
          </DropdownMenu.Item>

          <DropdownMenu.Item
            onSelect={handlePrint}
            className={[
              'flex items-center gap-[8px] px-[12px] py-[7px] cursor-pointer select-none outline-none',
              'text-[12.5px] font-light text-text-body',
              'hover:bg-book-cloth-50 hover:text-text-heading',
              'focus:bg-book-cloth-50 focus:text-text-heading',
              'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
            ].join(' ')}
          >
            <Printer size={13} strokeWidth={1.5} className="shrink-0 text-text-body-secondary" />
            <span>Print to PDF</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
