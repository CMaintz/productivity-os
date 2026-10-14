export interface Card {
  file: string;
  key: string;
  title: string;
  action: string;
  risk: 'low' | 'medium' | 'high' | string;
  status: string;
  reason: string;
  context: string;
  created: string;
  expires: string;
  decided_by: string | null;
  finished_at: string | null;
  result: string | null;
}

export interface Session {
  project: string;
  status: 'idle' | 'running' | 'waiting' | 'ended' | string;
  waiting_for: string | null;
  prompts: number;
  started: string;
  updated: string;
}

export interface Project {
  slug: string;
  status: string | null;
  priority: number | null;
  next: string | null;
  repo: string | null;
  ci: 'passing' | 'failing' | 'pending' | 'none' | null;
  open_prs: number | null;
  failing_prs: number | null;
  agent_blocked: number | null;
  updated: string | null;
}

export interface Snapshot {
  version: number;
  generatedAt: string;
  host: string;
  today: { date: string; top3: string[]; openTasks: number };
  counts: { pendingCards: number; waitingSessions: number; attention: number; activeProjects: number; inbox: number };
  cards: Card[];
  sessions: Session[];
  projects: Project[];
}

export interface CardPress {
  card_file: string;
  card_key: string;
  status: 'approved' | 'snoozed' | 'rejected' | 'undone';
  always?: boolean;
  never?: boolean;
  reason?: string;
}
