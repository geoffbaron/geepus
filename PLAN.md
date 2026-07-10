# Geepus v1 — Implementation Plan

**Repo:** https://github.com/geoffbaron/geepus.git (currently empty — this plan is the starting point)
**Implementer:** Claude Sonnet 5, working phase by phase. Each milestone has acceptance criteria; do not start a milestone until the previous one's criteria pass.
**Prior art:** a working-but-sprawling Electron prototype (`geepus-desktop` v0.2.77) whose source snapshot lives in `snapshot/` next to this file. Reuse what's listed in the Porting Map; do not copy the monoliths.

---

## 1. Product definition

Geepus is a **local-first desktop digital assistant** ("Jarvis"): an Electron app for macOS that chats, watches your inbox, writes a daily brief, suggests work, and runs tasks in the browser — powered **only by LLMs running on the user's own machine**. No cloud LLM keys, no accounts, no telemetry.

Two hard requirements shape everything:

1. **Friend-proof setup.** A non-technical person double-clicks a DMG and is talking to Geepus within minutes. The app figures out what the machine is, finds any local LLM runtimes/models already installed, recommends/downloads what fits, and walks the user through permissions conversationally.
2. **It gets better over time.** Geepus records what worked, learns strategies, synthesizes reusable skills, and consolidates memory — all locally.

Non-goals for v1: Windows/Linux, cloud providers, voice, multi-agent "teams" UI, plugin marketplace.

## 2. What exists today (context for the implementer)

The prototype (`snapshot/electron-geepus/`) proves the concept but has structural problems:

- `agent-loop.js` is a 12,400-line single-file monolith mixing planning, policy, browser choreography, and learning. `ipc-handlers.js` is 3,300 lines / 78 flat IPC channels. **Do not port these.**
- All secrets are stored in **plaintext JSON**. v1 must use Electron `safeStorage` from day one.
- Three known logic bugs (documented in `snapshot/AGENT_LOOP_INVESTIGATION.md`) made simple lookups fail: build-centric plan validation, a completion gate that only counted file-writes as output, and a classifier defaulting everything to "build". The new design makes all gates task-class-aware from the start.
- The peripheral modules are genuinely good and are ported (see §10).
- There is also a Swift XPC scaffold (`snapshot/Sources/`) — an abandoned security-architecture experiment. Do not port code from it, but its policy ideas (hard-deny rules, risk scoring, hash-chained audit) are reflected in §9.

## 3. Core decisions (already made — don't re-litigate)

| Decision | Choice |
|---|---|
| Platform | Electron + TypeScript, macOS arm64 first (Intel mac later, Windows post-v1) |
| Language | TypeScript throughout, strict mode; the prototype's JS is reference only |
| Local LLM strategy | **Ollama as primary runtime** (detect → adopt → or install); **bundled `node-llama-cpp` + tiny GGUF as fallback/starter brain** so the app always works |
| Cloud LLMs | Not part of the product. **OpenRouter is added as a provider strictly for development/testing** (Geoff's machine can't run the larger local models), implementing the same `provider.ts` interface. It ships in the code but ships **off**: gated behind a "Developer options" toggle in Settings that is hidden by default, labeled clearly as cloud/non-private, and never touched by the onboarding wizard. The friend-facing default path is always local-only. |
| Tool calling | Native function-calling when the model supports it (Ollama `tools` API); strict-JSON fallback prompt for models that don't; both behind one interface |
| Embeddings | Local via Ollama embedding models (e.g. `nomic-embed-text`) or bundled model; never OpenAI |
| Email | IMAP read-only via `imapflow` + `mailparser` (works with Gmail/iCloud/Fastmail app passwords); browser-agent webmail as fallback. **v1 never sends email without per-message approval.** |
| Settings | `zod` schema + one settings service; secrets in `safeStorage`, never in settings.json |
| UI | Single BrowserWindow, no framework lock-in required — use React + Vite via electron-vite (fast for Sonnet to build); dark/light aware |
| Packaging | electron-builder → DMG; signed + notarized (Geoff supplies Developer ID; unsigned dev builds until then) |

## 4. Architecture

```
┌─────────────────────────────── Electron main process ───────────────────────────────┐
│                                                                                      │
│  SetupService        ModelService           AgentRuntime          PolicyEngine       │
│  (hw probe, runtime  (Ollama mgr, bundled   (plan→act→observe     (risk tiers,       │
│  discovery, model    llama.cpp, model       loop, task classes,   approvals,         │
│  recommendation)     catalog, downloads)    tool dispatch)        hard-deny, audit)  │
│                                                                                      │
│  MemoryService       Scheduler              Agents/               ToolRegistry       │
│  (project+global     (cron-lite, triggers,  inbox, brief,         (fs, shell-safe,   │
│  memory, vectors,    loop journal)          suggest, browser,     web, browser,      │
│  RAG, learning)                             chat                  email, memory)     │
│                                                                                      │
│  BrowserService (Playwright + extension bridge + controller registry)                │
│  SettingsService (zod + safeStorage)        IPC: typed, namespaced (tRPC-style)      │
└──────────────────────────────────────────────────────────────────────────────────────┘
                       │ typed preload bridge (contextIsolation on)
┌──────────────────────┴──────────── Renderer (React) ─────────────────────────────────┐
│  Onboarding wizard · Chat · Daily Brief panel · Agents/Schedules · Approvals inbox   │
│  Memory browser · Settings                                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### AgentRuntime (the rewrite of agent-loop.js)

Small and boring on purpose — target **< 800 lines** for the core loop:

1. **Classify** the objective into a task class: `chat`, `lookup`, `research`, `build`, `operate`, `browse`. One classifier, used everywhere (planner, completion gate, readiness checks). This kills the prototype's triplicated-classifier bug family.
2. **Plan/act loop**: system prompt (persona + memories + skills + tools) → model call → tool calls → results appended → repeat. Use Ollama native tool-calling; fall back to fenced-JSON protocol with a repair pass for models without it.
3. **Completion gate is task-class-aware**: a `lookup` completes when the question is answered; only `build` requires artifacts/verification; `browse` completes on goal-state predicates.
4. **Budgets**: max iterations / runtime / tool calls per run (defaults ported from prototype, but far lower for scheduled runs than interactive ones).
5. **Reflection step** (one extra model call at end of run): what worked, what failed, one candidate strategy → handed to MemoryService (§8).

Every tool execution flows through PolicyEngine first (§9) and is appended to the hash-chained audit log.

## 5. Repo layout

```
geepus/
├── PLAN.md                      # this file
├── package.json                 # electron-vite + electron-builder + typescript
├── electron.vite.config.ts
├── src/
│   ├── main/
│   │   ├── index.ts             # hardened bootstrap (port pattern from prototype main.js)
│   │   ├── ipc/                 # namespaced typed channels: setup.*, chat.*, agents.*, ...
│   │   ├── setup/               # SetupService: hardware.ts, discovery.ts, recommend.ts, installer.ts
│   │   ├── models/              # ModelService: ollama.ts, bundled.ts (node-llama-cpp), catalog.ts, provider.ts (one interface)
│   │   ├── runtime/             # AgentRuntime: loop.ts, classify.ts, complete.ts, prompts/
│   │   ├── tools/               # ToolRegistry: fs.ts, shell.ts, web.ts, email.ts, browser.ts, memory.ts
│   │   ├── policy/              # PolicyEngine: rules.ts, approvals.ts, audit.ts
│   │   ├── memory/              # ported: memory.ts, vector-store.ts, rag.ts, embeddings.ts (local)
│   │   ├── agents/              # inbox.ts, brief.ts, suggest.ts (thin objectives over the runtime)
│   │   ├── schedule/            # ported: scheduler.ts, triggers.ts
│   │   ├── browser/             # ported: session.ts, extension-bridge.ts, controller-registry.ts
│   │   └── settings/            # schema.ts (zod), store.ts (safeStorage for secrets)
│   ├── preload/index.ts
│   ├── renderer/                # React app: onboarding/, chat/, brief/, agents/, approvals/, settings/
│   └── shared/                  # types shared across processes (task classes, tool schemas, IPC types)
├── extension/                   # ported Chrome extension (bridge to user's real browser)
├── resources/                   # icons; optionally the baked-in tiny GGUF for the "full" DMG variant
├── e2e/                         # Playwright-driven app tests
└── snapshot/                    # read-only copy of the prototype for reference (git-ignored or kept — Geoff's call)
```

## 6. First-run setup — "the tricky bit"

**Key insight: detection is deterministic code, not AI.** The tiny LLM is not for figuring out the machine — it's the *voice* of the wizard and the starter brain so chat works instantly. Do not build an LLM-driven prober.

### 6.1 Hardware probe (`setup/hardware.ts`, pure code, < 1s)
- Chip + arch: `os.arch()`, `sysctl -n machdep.cpu.brand_string`
- RAM: `os.totalmem()`; on Apple Silicon unified memory ≈ VRAM, which is all we need
- Free disk: `statfs` on the app-data volume
- macOS version: `os.release()` mapping
- Output: a `MachineProfile { chip, arch, ramGb, freeDiskGb, tier }` where tier ∈ `minimal (<8GB) | basic (8) | good (16) | great (32) | monster (64+)`

### 6.2 Runtime & model discovery (`setup/discovery.ts`, pure code)
Probe in order, all non-fatal:
1. **Ollama**: binary (`which ollama`, `/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Ollama.app`), server (`GET 127.0.0.1:11434/api/tags`), installed models list. (Port + extend prototype `ollama-manager.js`.)
2. **LM Studio**: server on `127.0.0.1:1234/v1/models`; model dir `~/.cache/lm-studio/models` (it speaks OpenAI-compatible API — adopt it as a runtime if found).
3. **Loose GGUF files**: quick scan of `~/models`, `~/Downloads` (top level only, no deep crawl).
4. Output: `DiscoveryReport { runtimes: [...], models: [{name, sizeGb, family, quant, fitsRam}] }`

### 6.3 Recommendation (`setup/recommend.ts`)
Static tier→model table (verify names against ollama.com/library at implementation time; the prototype's catalog contains stale/speculative entries — every entry must be pull-tested in CI):
- 8 GB → 3–4B q4 class (fast, fine for chat/summaries)
- 16 GB → 7–9B q4 class (good default assistant)
- 32 GB → 12–14B class
- 64 GB+ → 27–32B class
Also always recommend one embedding model (`nomic-embed-text` class, ~300MB).

### 6.4 The paths (wizard logic in `setup/installer.ts` + onboarding UI)
- **Path A — has Ollama + a suitable model:** adopt it, done in 30 seconds.
- **Path B — has Ollama, no suitable model:** `ollama pull` the recommended model with streamed progress bar.
- **Path C — has nothing:** two buttons: *"Install Ollama for me"* (download official Ollama.app zip over HTTPS with checksum, move to /Applications **with explicit user confirmation**, launch it, then Path B) or *"Just use the built-in brain"* (bundled engine, below). Either way the user can chat immediately via the bundled model while big downloads run in the background.
- **Path D — potato (<8GB RAM):** bundled tiny model only; set expectations honestly in the wizard copy.

### 6.5 Bundled tiny LLM (`models/bundled.ts`)
- Engine: `node-llama-cpp` (ships prebuilt Metal binaries; no compile on user machines).
- Model: a ~1–2B instruct GGUF q4 (~0.7–1.0 GB) — pick the best small instruct model available at implementation time and pin its exact checksum.
- Two build flavors: **lite DMG** (~250MB, fetches the tiny model on first run with progress + checksum verify) and **full DMG** (model baked into `resources/`, fully offline install). `npm run dist:lite` / `dist:full`.
- Roles of the tiny model: wizard conversation, instant chat before big model lands, classification/utility calls (cheap), and permanent fallback if Ollama breaks.
- The provider interface (`models/provider.ts`) makes bundled vs Ollama vs LM Studio interchangeable: `chat(messages, tools?) → stream`.

### 6.6 Permissions walkthrough (wizard, conversational)
The wizard requests nothing up front. It explains, in the assistant's voice, that Geepus will ask for each permission *the first time it's needed*:
- macOS notifications (daily brief) — requested during onboarding since it's benign
- IMAP credentials (only when user enables the Inbox agent; app-password walkthrough per provider, stored in safeStorage)
- Browser automation (only when the user first asks for a browser task; explains bundled-Chromium vs Chrome-extension options)
- Folder access (only when a task needs a workspace)
Every deferred permission also appears in Settings → Permissions with plain-language explanations.

## 7. The agents (v1 set)

Agents are **thin, versioned objective templates** run by the one AgentRuntime on the Scheduler — not separate loops.

1. **Chat** — always-on conversational assistant with memory + tools. The default surface.
2. **Inbox agent** — on schedule (default: every 30 min) or on demand: fetch unread headers + bodies via IMAP (read-only), classify (urgent / needs-reply / FYI / junk-ish), store summaries into memory, notify only above an urgency threshold. Never moves/marks/sends mail in v1 without explicit approval.
3. **Daily Brief** — scheduled (default 8:00): composes a single note from inbox summaries, yesterday's completed/failed runs, upcoming scheduled tasks, weather (one allowlisted HTTP source), and the Suggestion agent's top picks. Rendered in the Brief panel + notification.
4. **Suggestion agent** — mines memory (recent objectives, stalled runs, learned project state) to propose 3–5 next actions, each with a one-tap "do it" that seeds a run. This is where "suggest work" lives.
5. **Browser agent** — objective-driven web tasks through BrowserService: bundled Playwright Chromium by default, user's real Chrome via the ported extension bridge when they've installed it. Reuses the controller-registry so successful site flows become replayable playbooks. All form-submits/purchases/sends gate through PolicyEngine approvals.

## 8. Learning & self-improvement (all local)

Port the prototype's memory stack nearly as-is (it's the best code in the repo), then wire the flywheel:

1. **Run reflection** (§4) → candidate strategy strings with evidence.
2. **Learned strategies** live in memory with `attempts/successes` counters (port `skillStats` idea); injected into planner prompts top-k by relevance (RAG), not all-at-once. Strategies that keep failing get demoted to `bannedApproaches`.
3. **Skill synthesis**: when the same multi-step pattern succeeds ≥2 times, write a `SKILL.md` (name, when-to-use, steps, pitfalls) under app-data `skills/`; skills are RAG-retrieved into prompts. (Prototype already does a version of this — port the concept, clean the format.)
4. **Browser controller promotion**: proposed → active site playbooks after a verified successful replay (port registry as-is).
5. **Nightly consolidation** (scheduled, tiny model): dedupe memories, merge strategies, prune stale vectors, cap store sizes. The prototype never consolidated; stores grew unbounded.
6. Fix the ported embedding weakness: one embedding model per store, dimension recorded in store metadata; on model change, re-embed lazily instead of silently skipping mismatches.

## 9. Security & permissions model

- **Risk tiers**: `read` (workspace reads, web GET on allowlist) auto-allowed → `write` (workspace writes, allowlisted commands) auto-allowed inside workspace, ask outside → `sensitive` (email send, form submit, purchase-shaped browser actions, installs, anything outside workspace) always ask via the Approvals inbox → `deny` (sudo, rm -rf outside workspace, keychain access, launchctl persistence, credential exfil patterns) hard-blocked, no override in UI.
- **Approvals inbox** in the renderer: pending actions with plain-language descriptions; approve/deny; scheduled runs pause on `sensitive` and notify.
- **Secrets**: Electron `safeStorage` (Keychain-backed) for IMAP passwords etc. Nothing secret in `settings.json`. Redaction pass before anything is written to memory/audit/logs.
- **Audit**: hash-chained append-only JSONL of every tool execution (port pattern from prototype `audit.js`).
- **Renderer hardening**: port prototype `main.js` patterns (contextIsolation, navigation lockdown, deny window.open, no nodeIntegration).
- **Network posture**: the app itself only talks to `127.0.0.1` runtimes, the model-download hosts (checksummed), and the small HTTP allowlist for tools. Document it in README — that's the local-only promise, verifiable.

## 10. Porting map (from `snapshot/electron-geepus/src/`)

| Prototype module | Verdict | Notes |
|---|---|---|
| `memory.js`, `vector-store.js`, `rag.js`, `embeddings.js` | **Port** (→ TS) | Swap OpenAI embeddings for local; fix dimension-mismatch handling |
| `scheduler.js`, `triggers.js` | **Port** (→ TS) | Keep loop-journal idea; lower default budgets for scheduled runs |
| `browser-controller-registry.js`, `extension-bridge.js`, `extension/` | **Port** (→ TS) | Near as-is |
| `browser-session.js` | **Port & split** | Separate Playwright backend from extension backend behind one interface |
| `integrations.js` | **Port partially** | Keep webhook + safe-HTTP patterns; GitHub optional post-v1; add IMAP (new) |
| `audit.js`, `main.js` (hardening), `objective-policy.js` | **Port patterns** | Into PolicyEngine + bootstrap |
| `ollama-manager.js` | **Rewrite informed by it** | Keep detection/pull mechanics; new catalog (CI-verified), add install flow |
| `readiness.js` | **Replace** | Single task-class-aware completion gate in runtime; don't port the heuristic web |
| `agent-loop.js` (12.4k lines) | **Do not port** | Rewrite as §4 runtime; mine it only for prompt wording and browser-flow ideas |
| `ipc-handlers.js` | **Do not port** | Namespaced typed IPC instead |
| `settings.js` | **Replace** | zod schema + safeStorage |
| `team.js`, `nanobot-*`, voice, pipelines, `*.bak` | **Drop** | Out of scope for v1 |

## 11. Milestones (implement in order)

**M0 — Repo bootstrap (small)**
Scaffold electron-vite + TS strict + React; hardened main-process bootstrap; typed IPC skeleton; CI (lint, typecheck, unit tests); electron-builder config producing an unsigned DMG.
✅ *Accept:* `npm run dev` opens a window; `npm run dist` produces a DMG that launches on a clean account.

**M1 — Model layer**
`provider.ts` interface; Ollama runtime (detect/start/list/pull with progress); bundled node-llama-cpp engine with pinned tiny model (lite: first-run download w/ checksum; full: baked); streaming chat E2E from renderer. Also implement the **OpenRouter dev provider** behind the same interface, off by default, surfaced only via a "Developer options" settings toggle (env var `GEEPUS_DEV_PROVIDER=openrouter` + API key also works for headless dev use) — this is what Geoff uses through M2–M6 to exercise agent behavior with larger models than his own RAM allows, since real local-model testing happens on his friend's machine.
✅ *Accept:* on a machine with no Ollama, fresh install reaches a working chat using the bundled model; on a machine with Ollama, it adopts an existing model; with `GEEPUS_DEV_PROVIDER=openrouter` set, the same chat/tool-calling paths work against an OpenRouter model. Unit tests for catalog fit-logic.

**M2 — Setup wizard**
hardware.ts + discovery.ts + recommend.ts + installer.ts; onboarding UI voiced by the tiny model following Paths A–D; permissions explainer screens; Settings → Permissions page.
✅ *Accept:* scripted E2E covering all four paths (mock probes); real-machine test: Geoff's Mac (adopts Ollama) and a clean VM/account (bundled path). Time-to-first-chat < 3 min on Path C.

**M3 — Agent runtime + core tools + policy**
classify.ts, loop.ts with native tool-calling + JSON fallback, task-class-aware completion; tools: fs (workspace-scoped), safe shell (allowlist), web GET (allowlist), memory; PolicyEngine with risk tiers, Approvals inbox UI, audit log.
✅ *Accept:* "what's the weather in Blaine" completes as a `lookup` in ≤3 iterations (the prototype's canonical failure); a small `build` task writes files only after passing policy; regression tests for the three investigation bugs; deny-list attempts are blocked and audited.

**M4 — Memory & learning**
Port memory stack; local embeddings; reflection step; learned strategies with counters + demotion; skill synthesis; nightly consolidation job; Memory browser UI (view/edit/delete — user must be able to see and prune what it knows).
✅ *Accept:* after two similar successful runs, a skill file exists and is injected into the third run's prompt (asserted in test); consolidation reduces a seeded duplicate store; no secret strings ever appear in memory files (redaction test).

**M5 — Scheduler + Inbox + Daily Brief + Suggestions**
Port scheduler/triggers; IMAP client (imapflow, read-only) with app-password onboarding UI; Inbox agent; Daily Brief agent + panel + notification; Suggestion agent with one-tap run seeding.
✅ *Accept:* against a test IMAP account, unread mail is summarized and an urgent message notifies; a scheduled brief renders with inbox + runs + suggestions sections; nothing is ever sent/marked/moved (assert read-only in tests).

**M6 — Browser agent**
Port BrowserService (both backends) + controller registry + extension; wire `browse` task class; sensitive-action gating on submits.
✅ *Accept:* "find the cheapest X on <allowlisted demo site> and put it in the cart" runs in bundled Chromium, pauses for approval at checkout-shaped actions; a succeeded flow produces a proposed controller spec that replays.

**M7 — Package & friend test**
Sign + notarize (needs Geoff's Developer ID); lite/full DMG variants; in-app updater or manual "check for updates" (post-v1 ok); README quickstart; the actual friend install.
✅ *Accept:* Geoff's friend installs from the DMG with zero verbal support and completes setup + first chat + first daily brief. Every hiccup observed becomes an issue.

## 12. Open questions for Geoff (answer before the relevant milestone, defaults otherwise)

1. **App identity**: keep the name Geepus + existing icon from prototype assets? *(default: yes)*
2. **Code signing**: do you have an Apple Developer ID for notarization (M7)? Unsigned DMGs require right-click-open gymnastics that fail the friend-proof bar.
3. **Friend's hardware**: what Mac does he have? Determines whether Path C/D polish matters most.
4. **Email provider** the friend uses (Gmail? iCloud?) — decides which app-password walkthrough to build first in M5.
5. **snapshot/ in repo**: keep the prototype snapshot committed for reference, or git-ignore it? *(default: commit it — it's small once node_modules/dist are excluded, and Sonnet needs it)*

## 13. Housekeeping (one-time, Geoff's machine)

- The old LaunchAgent `~/Library/LaunchAgents/com.geepus.AssistantDaemon.plist` points at a binary that no longer exists — remove it (`launchctl bootout gui/$(id -u)/com.geepus.AssistantDaemon; rm` the plist).
- The old app stored an **Anthropic API key in plaintext** at `~/Library/Application Support/geepus-desktop/settings.json` — rotate that key at console.anthropic.com.
- `~/Geepus3/geepus/` contains a partial Finder copy of build artifacts from the iCloud archive — safe to trash.
- The canonical old source remains archived in iCloud at `~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/geepus/`.
