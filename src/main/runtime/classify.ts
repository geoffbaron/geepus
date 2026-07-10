import type { TaskClass } from '@shared/agent';

/**
 * Deterministic keyword classifier — pure code, not AI (PLAN.md §6). This is the single
 * classifier used by both the planner prompt and the completion gate (complete.ts), so
 * they can never disagree the way the prototype's three separate classifiers did
 * (AGENT_LOOP_INVESTIGATION.md bugs #1–#3, all rooted in "unclassified defaults to build").
 *
 * Priority: build > browse > operate > research > lookup > chat (default).
 * The default is 'chat', never 'build' — that single change is the fix for bug #3.
 */

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

const BUILD_PATTERNS = [
  /\bbuild (a|an|the)\b/,
  /\bcreate (a|an|the) (app|website|site|script|component|project|api|program)\b/,
  /\bimplement\b/,
  /\brefactor\b/,
  /\bscaffold\b/,
  /\bdebug (the|this|my)\b/,
  /\bfix (the |a )?bug\b/,
  /\bwrite (a |the )?(script|program|code|function|component|test)\b/,
  /\badd a feature\b/,
];

const BROWSE_PATTERNS = [
  /\bbrowse\b/,
  /\bclick\b/,
  /\bnavigate to\b/,
  /\blog ?in to\b/,
  /\bsign up\b/,
  /\bpurchase\b/,
  /\bbuy (this|the|a|an)\b/,
  /\badd to cart\b/,
  /\bcheckout\b/,
  /\bfill out\b/,
  /\bsubmit the form\b/,
  /\bbook a\b/,
  /\border (a|the)\b/,
];

const OPERATE_PATTERNS = [
  /\brun (the|this)?\s*(command|script|job|task)\b/,
  /\bexecute\b/,
  /\binstall\b/,
  /\bdeploy\b/,
  /\brestart\b/,
  /\bschedule\b/,
  /\buninstall\b/,
  /\bclean ?up\b/,
  /\bbackup\b/,
  /\borganize\b/,
  /\blaunch (the|this)\b/,
];

const RESEARCH_PATTERNS = [
  /\bresearch\b/,
  /\banalyze\b/,
  /\bcompare\b/,
  /\bsummarize\b/,
  /\binvestigate\b/,
  /\breport on\b/,
  /\bfind information about\b/,
  /\blook into\b/,
  /\bevaluate\b/,
];

const LOOKUP_PATTERNS = [
  /^what\b/,
  /^when\b/,
  /^where\b/,
  /^who\b/,
  /^how (much|many|far|long)\b/,
  /\bcheck the\b/,
  /\blook ?up\b/,
  /\bweather\b/,
  /\bprice of\b/,
  /\bwhat time\b/,
  /\bdefine\b/,
  /\btranslate\b/,
  /\bconvert\b/,
  /\bcalculate\b/,
];

export function classifyObjective(objective: string): TaskClass {
  const text = objective.trim().toLowerCase();
  if (!text) return 'chat';

  if (matchesAny(text, BUILD_PATTERNS)) return 'build';
  if (matchesAny(text, BROWSE_PATTERNS)) return 'browse';
  if (matchesAny(text, OPERATE_PATTERNS)) return 'operate';
  if (matchesAny(text, RESEARCH_PATTERNS)) return 'research';
  if (matchesAny(text, LOOKUP_PATTERNS)) return 'lookup';
  return 'chat';
}
