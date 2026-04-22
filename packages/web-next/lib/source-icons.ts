/**
 * source-icons.ts — Map all 9 CaptureSource values to lucide-react icon components.
 *
 * Each source gets a distinct icon that visually communicates the data origin.
 * Import the map and use `SOURCE_ICON_MAP[source]` to get the icon component.
 * Import `SOURCE_LABEL_MAP` for human-readable labels in tooltips/filters.
 */

import {
  MessageSquare,    // slack — chat channel
  Mic,              // voice — audio recording
  Zap,              // api — programmatic
  FileText,         // document — doc file
  Cpu,              // mcp — machine/agent
  Mail,             // email
  Folder,           // file — file system
  GitMerge,         // consolidation — merge operation
  Settings2,        // system — internal event
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CaptureSource } from './types';

/**
 * Maps each CaptureSource value to a lucide-react icon component.
 * All 9 canonical values from `captures.source` CHECK constraint are covered.
 */
export const SOURCE_ICON_MAP: Record<CaptureSource, LucideIcon> = {
  slack:         MessageSquare,
  voice:         Mic,
  api:           Zap,
  document:      FileText,
  mcp:           Cpu,
  email:         Mail,
  file:          Folder,
  consolidation: GitMerge,
  system:        Settings2,
};

/**
 * Human-readable label for each source — used in filter chips and tooltips.
 */
export const SOURCE_LABEL_MAP: Record<CaptureSource, string> = {
  slack:         'Slack',
  voice:         'Voice',
  api:           'API',
  document:      'Document',
  mcp:           'MCP',
  email:         'Email',
  file:          'File',
  consolidation: 'Consolidation',
  system:        'System',
};

/** Ordered list of all 9 source values — for filter dropdowns. */
export const ALL_SOURCES: CaptureSource[] = [
  'slack',
  'voice',
  'api',
  'document',
  'mcp',
  'email',
  'file',
  'consolidation',
  'system',
];
