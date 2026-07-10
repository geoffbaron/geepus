# Geepus Agent Loop — Deep Investigation Report

**Scope**: Every function and code path in `electron-geepus/src/` — 6,773 lines of `agent-loop.js`, 2,197 lines of `tools.js`, and all supporting modules.

**Central question**: Why can't Geepus accomplish basic tasks like "check the weather"?

---

## Executive Summary

There are **three cascading bugs** that make non-build objectives virtually impossible:

| # | Bug | Location | Severity |
|---|-----|----------|----------|
| 1 | **Nanobot plan validator rejects research-only action plans** in action mode — even when the objective is inherently a lookup/research task | `nanobot-adapter.js:212-228` | **CRITICAL** |
| 2 | **Completion gate requires `write_file`/`run_command`/`run_playwright`** to call a run "done" — `web_search`, `http_request` don't count as "real output" | `agent-loop.js:6323-6334` | **CRITICAL** |
| 3 | **Readiness checklist defaults to "build" task class** for anything that doesn't match research/operations keywords, requiring test/browser verification evidence | `readiness.js:125-140` | **HIGH** |

A task like "check the weather" hits **all three** in sequence: the plan is rejected before execution (bug #1), and even if you forced it through, the run could never complete (bugs #2 and #3).

---

## A. Complete Flow: Message → Loop → LLM → Action → Result → Next Iteration

### Entry Point
`runObjectiveCore()` at `agent-loop.js:4351` is the single entry point. Called from IPC handlers via `main.js`.

### Flow (simplified)

```
1.  runObjectiveCore(objective, settings, ...)
2.    → Resolve workspace (auto-discover or use provided)
3.    → Resolve model (pickBestModel or user-specified)
4.    → Load project skills + global skills (~/.geepus/skills/)
5.    → Load nanobot vendor assets (templates, built-in skills)
6.    → If no skill matched: developSkillForObjective() [LLM + web search]
7.    → Try nanobot native Python runtime (vendor/nanobot/pyproject.toml)
8.       → If unavailable (almost always), fall through to Geepus planner loop
9.    → FOR iteration = 1..maxIterations:
10.      a. Check stop/budget/idle limits
11.      b. createAgentPlan()  ← builds system prompt, calls LLM, parses JSON
12.         → buildAgentPlannerPrompt() with tools, workspace files, memory, skills
13.         → callResponsesWithFallback() to LLM (OpenAI/Anthropic/Ollama)
14.         → extractFirstJSONObject() to parse response
15.         → normalizePlan() + normalizeAction() for each action
16.         → validateNanobotPlan() ← *** BUG #1 fires here ***
17.         → If validation fails, retry up to 3 times total → THROW
18.      c. executePlannedActions()
19.         → For each action: evaluateActionPolicy() → applySecurityControlsToPolicy()
20.         → executeAction() dispatches to tool-specific handlers
21.         → On failure: attemptInlineRetry() [up to 2 adaptive retries per action]
22.      d. If plan.plannerDone == false && not near iteration limit: CONTINUE (skip eval)
23.      e. evaluateObjectiveProgress()  ← separate LLM call judging completion
24.      f. If progress.done:
25.         → Check for blocking recent failures
26.         → hasAnyRealOutput gate ← *** BUG #2 fires here ***
27.         → computeRunReadiness() ← *** BUG #3 fires here ***
28.         → evaluateUserAcceptance() [score >= 7 required]
29.         → If all pass: done = true, break
30.   → Post-run: captureAndSaveSkill(), memory consolidation, RAG indexing
```

### Key Architecture Decisions
- **No native function-calling**: Tools are described as text in the system prompt. The LLM returns raw JSON that gets parsed by `extractFirstJSONObject()`.
- **Two execution cores**: "geepus" (classic) and "nanobot" (default). Nanobot tries a Python runtime first (always fails — see section F), then falls back to the same Geepus loop with an **extra validation layer** that is the root cause of bug #1.
- **Single-agent, not multi-agent**: The old "team briefing" system was removed. Specialists are available on-demand via the `delegate` tool, which spawns a mini ReAct sub-loop with restricted tools.

---

## B. Silent Failure Points

### B1. Nanobot Plan Validation — The #1 Silent Killer (BUG #1)

**File**: `nanobot-adapter.js:212-228`

```javascript
function validateNanobotPlan({ actions, executionMode, objectivePolicy, objective }) {
  // If research mode or policy says researchOnly/noBuild: skip validation
  if (executionMode === 'research' || policy.researchOnly || policy.noBuild) {
    return { ok: true, reason: '' };
  }
  // ...
  const researchOnly = actions.every((entry) => isResearchOnlyAction(entry));
  if (researchOnly) {
    if (isPrepInspectionIteration(actions)) return { ok: true, reason: '' };
    return { ok: false, reason: 'Planner returned research-only actions in Action/Auto mode.' };
  }
}
```

**RESEARCH_TOOLS set** (actions that get blocked):
`think`, `list_files`, `read_file`, `search_files`, `web_search`, `web_scrape`, `http_request`, `analyze_image`

**What happens for "check the weather"**:
1. `detectObjectivePolicy("check the weather")` → No research signals, no build signals → `{ researchOnly: false, noBuild: false }`. Falls through to action mode.
2. LLM correctly plans `web_search` (or `http_request`) to fetch weather data.
3. Both `web_search` and `http_request` are in `RESEARCH_TOOLS`.
4. `validateNanobotPlan()` → `researchOnly = true` → `isPrepInspectionIteration()` → false (web_search isn't in PREP_INSPECTION_TOOLS) → **REJECTED**.
5. This repeats for all 3 retry attempts.
6. `createAgentPlan()` throws: "Planner failed to generate executable actions."
7. The main loop catches this, escalates recovery, and eventually hits the iteration limit.

**The fundamental flaw**: The validator assumes that in "action mode," a plan *must* include a build tool (write_file, run_command, etc.). But many legitimate objectives — weather lookups, price checks, research summaries, link collection — are correctly solved with research-only tools.

### B2. "Real Output" Completion Gate (BUG #2)

**File**: `agent-loop.js:6323-6334`

```javascript
const hasAnyRealOutput = runState.results.some((r) =>
  r.ok && (
    r.tool === 'write_file' ||
    r.tool === 'patch_file' ||
    r.tool === 'run_command' ||
    r.tool === 'run_playwright'
  )
);
if (!hasAnyRealOutput) {
  runState.nextFocus = 'No real output was produced this run...';
  continue; // ← forces another iteration, can never complete
}
```

Even if weather data is successfully fetched via `web_search` or `http_request`, neither tool is in the "real output" list. The harness forces the agent to continue iterating — likely pushing it to write a report file or run a command, which is not what the user asked for.

### B3. Readiness Task-Class Misclassification (BUG #3)

**File**: `readiness.js:108-127`

```javascript
function inferRunTaskClass({ objective, executionMode, objectivePolicy }) {
  // ...
  const hasResearch = hasAny(objectiveText, RESEARCH_KEYWORDS); // research, analyze, reddit, etc.
  const hasBuild = hasAny(objectiveText, BUILD_KEYWORDS);       // build, create, app, website, etc.
  if (hasResearch && !hasBuild) return 'research';
  if (hasAny(objectiveText, OPERATIONS_KEYWORDS)) return 'operations';
  return 'build';  // ← DEFAULT
}
```

"Check the weather" matches **no** keyword set. It defaults to `'build'`. The build checklist then requires:
- `verification` check → Has run_playwright or test-runner evidence → **FAIL**
- For web builds: `browser_console_clean` → Playwright with consoleErrorCount=0 → **FAIL**

### B4. Objective Policy Classification Miss

`detectObjectivePolicy()` in `objective-policy.js` uses keyword matching for research signals (`research`, `analyze`, `reddit`, `news`, `compare`, etc.) and build signals. "Check the weather" has **none** of these, so it gets the default non-research, non-build policy — which means no special treatment and full build-mode validation applies.

### B5. Nanobot Native Runtime Silent Fallback

`nanobot-runtime.js` tries a Python native runtime that requires:
- Python 3.11+
- `vendor/nanobot/` with `pyproject.toml`
- nanobot Python dependencies installed

When unavailable (the common case), it silently falls back to the Geepus planner loop. No error, no log, no user notification. The user sees "nanobot" as the execution core but it's really the Geepus loop with extra validation.

---

## C. `http_request` Tool — Fully Implemented, But Gated

**File**: `tools.js:2050-2100`

```javascript
if (tool === 'http_request') {
  const url = resolveArg(args, ['url']);
  const method = String(resolveArg(args, ['method']) || 'GET').toUpperCase();
  const headers = ensureObject(resolveArg(args, ['headers']));
  const body = resolveArg(args, ['body']);
  const timeout = Number(resolveArg(args, ['timeout', 'timeout_ms']) || 30000);
  // ...
  const resp = await fetch(url, fetchOptions);
  // ...
  return { ok: true, summary: `HTTP ${resp.status}`, output: JSON.stringify(result) };
}
```

**The implementation is complete and correct.** Uses native `fetch()`, supports all HTTP methods, configurable headers/body/timeout. Returns status, headers, body text.

**Security gate**: `applySecurityControlsToPolicy()` at `agent-loop.js:1090-1130` gates `http_request` behind `internetAccessUntil`. The default value is `Number.MAX_SAFE_INTEGER` (always enabled), so this should work out of the box. However, if a user manually set a timed permission that expired, all internet tools silently become "gated" (denied with an opaque message).

**The real problem**: `http_request` is a RESEARCH_TOOL in `nanobot-adapter.js`, so any plan using it (without also using a build tool) gets **rejected by the nanobot validator** before execution.

---

## D. `web_search` / `web_scrape` — Fully Implemented

**File**: `web-research.js`

### web_search
1. Reads `braveSearchApiKey` from settings
2. If key exists: queries `api.search.brave.com/res/v1/web/search` with the query
3. If no key: **DuckDuckGo HTML fallback** — fetches `https://html.duckduckgo.com/html/?q=...`, parses anchor tags
4. Returns formatted search results (title + URL + snippet)

### web_scrape
1. Uses native `fetch()` with 15-second timeout
2. Strips HTML tags → plain text
3. Detects JSON responses and formats them
4. Returns first ~6000 characters

Both are fully functional. The DuckDuckGo fallback means web_search works with **zero configuration**. Same gating issue as http_request: blocked by nanobot plan validator.

---

## E. Skill / Self-Learning System

### Loading
- **Sources** (in priority order):
  1. `.claude/skills/` → project-level (Claude Code compatibility)
  2. `.geepus/skills/` → project-level
  3. `skills/` → project-level
  4. `~/.geepus/skills/` → **global** (cross-project)
  5. `vendor/nanobot/nanobot/skills/` → built-in vendor skills

### Matching
`findBestSkillForObjective()` uses **fuzzy word-overlap scoring**: tokenizes the objective and each skill's name + tags, computes overlap ratio. Minimum threshold required.

If no keyword match: `developSkillForObjective()` does a two-step process:
1. **Semantic LLM match**: Asks the LLM if any existing skill semantically covers the task
2. **Synthesis**: If no match, optionally web-searches for best practices, then asks the LLM to write a new SKILL.md at the broadest useful category level

### Saving
On successful run completion, `captureAndSaveSkill()` asks the LLM to synthesize a SKILL.md from the run history. Saved to `~/.geepus/skills/<slug>/SKILL.md`. Fire-and-forget.

### Current Skills on Disk
17 global skills exist at `~/.geepus/skills/`, including: web-development, research-analysis, data-analysis, general-automation, ios-development, python-scripting, and several project-specific ones.

### Assessment
The skill system is well-designed but has an important gap: skills influence the **system prompt** and **completion criteria**, but they don't override the hardcoded validators (nanobot plan validation, hasAnyRealOutput gate, readiness checklist). A skill that says "this task is done when weather data is returned" would still be overridden by the harness code.

---

## F. Nanobot Adapter — Architecture and Failure Modes

### Design
The nanobot execution core is the default (`normalizeExecutionCore()` returns 'nanobot' when no value set). It has three layers:

1. **Native Python runtime** (`nanobot-runtime.js`): Tries to spawn a Python subprocess using the vendor bundle. Requires Python 3.11+ and nanobot Python deps. **Almost certainly unavailable** for most users.

2. **Nanobot planner notes** (`buildNanobotPlannerNotes()`): Adds vendor template content (AGENTS.md, TOOLS.md, USER.md, SOUL.md) to the system prompt. This is supplementary context, not a different execution model.

3. **Nanobot plan validation** (`validateNanobotPlan()`): The **only behavioral difference** between 'geepus' and 'nanobot' cores when the Python runtime is unavailable. This is where BUG #1 lives.

### What Happens in Practice
1. `runObjectiveCore()` checks `executionCore === 'nanobot'` → yes (default)
2. Calls `getRuntimeAvailability()` → `{ available: false, reason: '...' }`
3. Silent fallback to Geepus planner loop
4. Every `createAgentPlan()` call passes plans through `validateNanobotPlan()` which rejects research-only plans in action mode
5. User has no idea why the agent keeps failing

### The Irony
Setting execution core to 'geepus' instead of 'nanobot' would **fix BUG #1** — the `validateNanobotPlan()` check is only applied when `core === 'nanobot'`. But 'nanobot' is the default and there's no UI indication that this extra validation is active.

---

## G. Bugs, Design Flaws, and Logic Errors

### G1. CRITICAL: validateNanobotPlan blocks legitimate lookup tasks
**Already covered as BUG #1.** Fix: skip nanobot validation when objective has no build signals, or add `web_search`/`http_request` to a new "lightweight action" category that's allowed in action mode.

### G2. CRITICAL: hasAnyRealOutput gate is too restrictive
**Already covered as BUG #2.** Fix: add `web_search`, `web_scrape`, `http_request` to the "real output" set, or make this check conditional on taskClass.

### G3. HIGH: inferRunTaskClass defaults to 'build'
**Already covered as BUG #3.** "Check the weather", "what time is it in Tokyo", "find the cheapest flights" all get classified as build tasks. Fix: add a `'lookup'` or `'general'` task class as the default, with minimal readiness requirements.

### G4. MEDIUM: Research loop detector penalizes non-build objectives
`countConsecutiveResearchIterations()` in agent-loop.js counts consecutive iterations with only research tools. After 2-3 consecutive research iterations (for build objectives), it forces a pivot:
```
RESEARCH LOOP DETECTED: You've spent N consecutive iterations on research without writing any code or tests.
```
For a weather check, **every** iteration is "research" — the detector would trigger on iteration 3.

### G5. MEDIUM: Drift detection for non-build objectives
`isIterationDrifted()` checks if actions relate to the objective. For simple lookups that complete in one step, subsequent iterations (forced by BUG #2) would all be "drifted" — the agent already has the answer but can't declare done.

### G6. LOW: extractOutputText provider-response mismatch
In `providers.js`, `extractOutputText()` handles three response shapes. For Ollama streaming responses, it aggregates `delta.content`. But if the Ollama call uses a non-streaming path by mistake, the response shape differs and the function returns empty string with no error.

### G7. LOW: Skill matching is pure keyword overlap
`findBestSkillForObjective()` uses word-frequency overlap which misses semantic relationships. "Check the weather" would not match a "research-analysis" skill despite being a research task. The LLM-based semantic match in `developSkillForObjective()` compensates but costs an extra API call.

### G8. INFO: Security controls default to always-enabled
`DEFAULT_SECURITY_CONTROLS` has `internetAccessUntil: Number.MAX_SAFE_INTEGER` and `browserControlUntil: Number.MAX_SAFE_INTEGER`. This means internet and browser access are enabled by default. The timed permission UI could confuse users into setting a timed window that then expires, silently disabling tools.

---

## H. Run Limits, Iteration Caps, and Budget Guards

### Default Limits (`settings.js`)
| Limit | Cloud Default | Ollama (Local) |
|-------|--------------|----------------|
| maxIterations | 20 | 500 |
| maxRuntimeMinutes | 90 | 1440 (24h) |
| maxActions | 250 | 10,000 |
| maxModelCallsPerMinute | 30 | 999,999 |
| maxToolCallsPerMinute | 60 | 999,999 |
| idleTimeoutSeconds | 75 | 1,800 (30m) |
| consecutiveDriftLimit | 3 | 10 |

### Minor-Task Guard
At `runObjectiveCore()` (~line 4732), objectives with ≤20 words and no build intent get capped:
- maxIterations: 16
- maxActions: 160
- maxRuntimeMinutes: 60
- idleTimeoutSeconds: 60
- consecutiveDriftLimit: 3

"Check the weather" (4 words, no build intent) would hit this, though the caps are still generous for a simple lookup.

### Budget Extension Functions
- `tryExtendIterationBudget()`: Adds up to 3 extensions of 6 iterations each (max +18)
- `tryExtendActionBudget()`: Adds 80 actions per extension
- `tryExtendRuntimeBudget()`: Adds 20 minutes per extension
These fire automatically when the agent is making progress but hits a limit. Good for long tasks, irrelevant for short lookups stuck in validation loops.

### Execution Wall-Clock Cap
`EXECUTION_WALL_CLOCK_MS = 10 * 60 * 1000` (10 minutes) per iteration's action execution phase. Prevents stuck actions from blocking indefinitely.

### Per-Tool Limits
- `run_command`: 5-minute hard timeout, stdout/stderr capped at 120KB with smart truncation
- `web_scrape`: 15-second fetch timeout
- `http_request`: 30-second default timeout (configurable per-call)
- `run_playwright`: Handled by Playwright's own timeout + 10-minute iteration cap
- Ollama: 5-minute chunk timeout, 10-minute wall-clock cap, 8192 context window, 4096 max output tokens

---

## I. LLM Response Parsing Robustness

### JSON Extraction: `extractFirstJSONObject()`
Scans the LLM output for the first `{...}` block with balanced braces. Handles:
- JSON embedded in markdown code fences
- Text before/after the JSON
- Nested objects
- Does NOT handle: JSON arrays as the root element, malformed JSON

### Plan Normalization: `normalizePlan()`
Accepts many LLM output shapes:
- `{ actions: [...] }`
- `{ steps: [...] }`  
- `{ tasks: [...] }`
- `{ plan: [...] }`
- `{ plan: { steps: [...] } }`
This makes the parser resilient to different model response styles.

### Action Normalization: `normalizeAction()`
Extremely robust — handles ~50 edge cases:
- Tool name aliases: `bash`→`run_command`, `cat`→`read_file`, `grep`→`search_files`, `curl`→`http_request`, `google`→`web_search`, etc.
- CamelCase conversion: `readFile`→`read_file`
- Missing tool field: infers from args (has `command` → `run_command`, has `url` → `web_scrape`)
- Argument field aliases: `file`→`path`, `query`→`pattern`, `cmd`→`command`
- Directory pseudo-tools: `cd`, `mkdir`, `ls` → converted to `run_command`
- Strip `./` prefix from paths
- Backfill missing `intent` from args

### Retry Logic
`createAgentPlan()` retries up to **3 times** with the same model. Retries on:
- JSON parse failure
- Empty/missing actions array
- Nanobot plan validation failure (BUG #1)
- LLM refusal

If all 3 fail, it throws and the main loop catches it. Recovery escalation `escalateRecoveryMode()` may switch to a different model on subsequent iterations.

### Assessment
The parsing layer is **impressively robust**. It's not the bottleneck — the LLM does return valid JSON with correct tool calls. The failure happens in the validation layer *after* successful parsing.

---

## J. Error Recovery and Self-Healing

### Inline Adaptive Retry
`attemptInlineRetry()` in `executePlannedActions()`:
- On action failure, asks the LLM for an immediate alternative action (without waiting for the next full planning cycle)
- Up to 2 retries per action
- Special deterministic recovery for Playwright connectivity errors: automatically starts an HTTP server and replays
- Special recovery for `patch_file` "search string not found": injects `read_file` to get actual content

### Recovery Escalation
`escalateRecoveryMode()` progresses through:
1. Normal → guided (adds focus hints)
2. Guided → recovery (increases context, changes approach)
3. Recovery → model switch (tries a different LLM)

### Banned Approaches
`computeBannedApproaches()` tracks which tool+args combinations have failed repeatedly. `isActionBanned()` checks new plans against the ban list. `buildBannedApproachesWarning()` injects ban warnings into the system prompt so the LLM avoids repeating failures.

### Drift Detection
`isIterationDrifted()` checks for:
- Actions that don't relate to the objective
- Fabrication patterns (writing "verification results" files)
- Script-versioning loops (creating file-v2.js, file-v3.js, etc.)
- Infrastructure drift (modifying project config when objective is about code)

After `consecutiveDriftLimit` (default 3) drifted iterations, the run stops.

### Research Loop Detection
`countConsecutiveResearchIterations()` counts iterations with only research tools (no writes/commands). After 2-3 consecutive research iterations, forces a pivot warning. This is appropriate for build tasks but actively harmful for lookup tasks (BUG-adjacent — G4).

### Research Pivot
`buildResearchPivotFocus()` triggers when the same failure occurs repeatedly. Generates detailed instructions to try alternative approaches including web search.

### Assessment
The recovery systems are sophisticated and well-thought-out for **build/development tasks**. The problem is they all assume a build-centric workflow. For simple queries, they create false positives: the "answer" is treated as "lack of progress" because no files were written.

---

## Root Cause Analysis: "Check the Weather"

Here is the exact execution trace for `objective = "check the weather"`:

```
1. runObjectiveCore("check the weather")
2. executionCore = 'nanobot' (default)
3. detectObjectivePolicy("check the weather")
   → no research keywords, no build keywords
   → { researchOnly: false, noBuild: false }
4. inferRunTaskClass → 'build' (default fallback)
5. Minor-task guard: ≤20 words, no build intent → caps to 16 iterations
6. Nanobot native runtime → unavailable → silent fallback to Geepus loop
7. Iteration 1:
   a. createAgentPlan() → LLM returns: { actions: [{ tool: "web_search", args: { query: "current weather" } }] }
   b. validateNanobotPlan() → all actions are RESEARCH_TOOLS → REJECTED
   c. Retry 2: LLM returns similar plan → REJECTED
   d. Retry 3: LLM returns similar plan → REJECTED
   e. createAgentPlan() THROWS: "Planner failed to generate executable actions"
8. Main loop catches error → escalateRecoveryMode()
9. Iteration 2-3: Same pattern. LLM keeps (correctly) planning web_search.
   Validator keeps rejecting.
10. Eventually: consecutiveDriftLimit or maxIterations reached.
11. Run stops with: "Max iteration budget reached."
    Report says: "Status: Needs attention"
```

**The agent CORRECTLY plans the right tool calls. The harness code INCORRECTLY rejects them.**

---

## Recommended Fixes

### Fix 1: Make nanobot validation task-aware (CRITICAL)
```javascript
// nanobot-adapter.js — validateNanobotPlan()
function validateNanobotPlan({ actions, executionMode, objectivePolicy, objective }) {
  if (executionMode === 'research' || policy.researchOnly || policy.noBuild) {
    return { ok: true, reason: '' };
  }
  // NEW: Skip build-action requirement if objective has no build signals
  if (!isBuildLikeObjective(objective)) {
    return { ok: true, reason: '' };
  }
  // ... rest of existing validation
}
```

### Fix 2: Make hasAnyRealOutput task-class-aware (CRITICAL)
```javascript
// agent-loop.js — completion gate
const taskClass = inferRunTaskClass({ objective, executionMode, objectivePolicy });
if (taskClass !== 'build') {
  // For research/lookup/general tasks, any successful action counts
  const hasAnyOutput = runState.results.some((r) => r.ok && r.tool !== 'think');
  if (!hasAnyOutput) { /* force continue */ }
} else {
  // Existing build-focused check
  const hasAnyRealOutput = /* existing code */;
}
```

### Fix 3: Add 'general'/'lookup' task class to readiness (HIGH)
```javascript
// readiness.js — inferRunTaskClass()
const LOOKUP_KEYWORDS = ['check', 'what', 'find', 'look up', 'get', 'show', 'tell', 'weather', 'price', 'time'];
if (hasAny(objectiveText, LOOKUP_KEYWORDS) && !hasBuild) return 'lookup';
// ...
return 'general'; // instead of 'build'
```

### Fix 4: Surface nanobot runtime status to user (LOW)
Instead of silently falling back, show a one-time notice: *"Nanobot native runtime not available — using Geepus planner loop."*

---

## Appendix: File Inventory

| File | Lines | Status | Role |
|------|-------|--------|------|
| agent-loop.js | 6,773 | Completely read | Core autonomous loop: planning, execution, evaluation, recovery |
| tools.js | 2,197 | Completely read | Action normalization, policy, execution for all 14+ tools |
| web-research.js | ~200 | Completely read | web_search (Brave + DuckDuckGo) and web_scrape |
| workspace.js | 589 | Completely read | Skill loading, workspace discovery, project memory |
| providers.js | 949 | Completely read | LLM integration: OpenAI, Anthropic, Ollama |
| settings.js | ~300 | Completely read | Default limits, security controls, model defaults |
| objective-policy.js | ~120 | Completely read | Objective classification: research vs build vs web-research |
| nanobot-adapter.js | 242 | Completely read | Plan validation, vendor asset loading, skill merging |
| nanobot-runtime.js | ~250 | Completely read | Python native runtime (usually unavailable) |
| readiness.js | 437 | Completely read | Completion readiness checklist |

### Global Skills Directory
`~/.geepus/skills/` contains 17 skill playbooks including: web-development, research-analysis, data-analysis, general-automation, ios-development, python-scripting, and project-specific skills from prior runs.
