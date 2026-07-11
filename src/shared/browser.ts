export const CONTROLLER_SPEC_VERSION = 1;

export interface PlaybookStep {
  kind: string;
  action: string;
  targetText: string;
  targetLabel: string;
  url: string;
  requiresTexts: string[];
}

export interface BrowserControllerSpec {
  version: number;
  id: string;
  name: string;
  match: {
    domains: string[];
    intents: string[];
  };
  route: {
    preferredEntryUrls: string[];
    fallbackEntryUrls: string[];
    linkTextPriority: string[];
  };
  playbook: {
    steps: PlaybookStep[];
  };
  sourcePath?: string;
}

export interface ProposedControllerSpec {
  ok: boolean;
  errors: string[];
  id: string;
  name: string;
  match: BrowserControllerSpec['match'] | Record<string, never>;
  route: BrowserControllerSpec['route'] | Record<string, never>;
  playbook: BrowserControllerSpec['playbook'];
  sourcePath: string;
}

export interface BrowserTarget {
  role?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  name?: string;
  css?: string;
  exact?: boolean;
}
