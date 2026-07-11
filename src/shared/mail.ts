export interface EmailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export type EmailUrgency = 'urgent' | 'needs-reply' | 'fyi' | 'junk';

export interface ClassifiedEmail extends EmailSummary {
  urgency: EmailUrgency;
}

export interface InboxRunResult {
  totalUnread: number;
  urgentCount: number;
  summaries: ClassifiedEmail[];
}

export interface MailAccountInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface ImapConnectionTestResult {
  ok: boolean;
  error?: string;
}
