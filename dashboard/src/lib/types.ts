import type { Widget } from '../widgets';

export interface Snapshot {
  version: number;
  generatedAt: string;
  host: string;
  counts: { pendingCards: number; waitingSessions: number; attention: number; activeProjects: number; inbox: number };
  layout: { id: string; size?: string }[];
  widgets: Record<string, Widget>;
}

export interface CardPress {
  card_file: string;
  card_key: string;
  status: 'approved' | 'snoozed' | 'rejected' | 'undone';
  always?: boolean;
  never?: boolean;
  reason?: string;
}
