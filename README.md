# Geepus

A local-first desktop assistant for macOS — chats, watches your inbox, writes a daily
brief, suggests work, and runs tasks in the browser. Powered **only by LLMs running on
your own machine**. No cloud accounts, no API keys required, no telemetry.

## Installing

Grab the latest DMG and drag Geepus into Applications. There are two variants:

- **Geepus-\<version\>-full.dmg** — bigger download, works fully offline from first
  launch. Best if you don't already use Ollama or don't want to wait on any downloads.
- **Geepus-\<version\>.dmg** (lite) — smaller download; on first launch it fetches a
  small starter model (~1GB) and, the first time you ask it to do something in a
  browser, a headless Chromium (~200MB). Both downloads are checksum-verified and only
  happen once.

Since these builds aren't yet signed with an Apple Developer ID (see [Known
limitations](#known-limitations)), macOS will refuse to open the app and say
**"Geepus is damaged and can't be opened"** — it isn't damaged; that's just how recent
macOS versions phrase "this app isn't signed." The fix takes one command:

1. Drag **Geepus** from the DMG into **Applications** first.
2. Open **Terminal** (press ⌘-Space, type "Terminal", press Return).
3. Copy-paste this line and press Return:

   ```
   xattr -cr /Applications/Geepus.app
   ```

4. Open Geepus normally. You only ever have to do this once.

(On older macOS versions, right-click → Open → Open may work instead, but the command
above works everywhere.)

## First run

1. Geepus checks your machine (RAM, chip) and looks for any local LLM runtimes you
   already have — Ollama or LM Studio — and any models already installed.
2. Based on what it finds, it recommends a setup path: adopt a model you already have,
   pull a right-sized model via Ollama, install Ollama for you, or fall back to the
   bundled starter model so the app works even with nothing installed.
3. You'll be walked through the handful of permissions Geepus actually needs
   (notifications, and later, mail/browser access if you turn those features on) — all
   asked for conversationally, not as a wall of checkboxes.
4. Once setup finishes you land in Chat. Try asking it something simple first — "what
   can you help me with?" — before turning on inbox or scheduled tasks.

## Features

- **Chat** — talk to Geepus directly; it can read/write files in its own workspace, run
  shell commands, browse the web, and search its memory, all gated by a policy engine
  (safe actions run automatically, risky ones ask for your approval first).
- **Daily brief** — a scheduled summary pulling together your inbox, suggested work, and
  optionally the weather.
- **Inbox** — read-only IMAP connection (Gmail/iCloud/Fastmail app passwords all work).
  Geepus never sends, deletes, or moves mail — it only reads and summarizes.
- **Browser tasks** — Geepus can navigate and interact with real webpages for you using a
  bundled, invisible Chromium. Anything checkout-shaped (placing an order, confirming a
  booking, paying) always stops and asks for your approval first.
- **Memory** — Geepus remembers what worked. Successful patterns get promoted into
  reusable "skills," memory gets consolidated nightly, and anything secret-looking
  (API keys, tokens) is redacted before it's ever stored.
- **Schedules** — set up recurring or triggered tasks (cron-style, interval, or "when a
  file changes").

## Privacy

Everything — chat, inbox contents, memory, browser history — stays on your machine.
Geepus's default model runs locally via Ollama or its own bundled engine. The only
built-in exception is a hidden developer option (OpenRouter) used solely for testing
during development; it's off by default and never surfaced during setup.

## Known limitations

- **Unsigned builds.** These DMGs aren't signed/notarized with an Apple Developer ID
  yet, so macOS claims the app is "damaged" on first open (see
  [Installing](#installing) for the one-command fix). Once a Developer ID is available
  and the build is notarized, installs become a plain double-click and this section
  disappears.
- **macOS only, arm64 (Apple Silicon) first.** Intel Mac and Windows support are not yet
  built.
- **Playwright's Chromium download** (lite variant) requires an internet connection the
  first time you ask Geepus to do anything in a browser.

## Building from source

```
npm install
npm run dev          # run in development
npm run typecheck && npm run lint && npm run test
npm run dist:lite     # unsigned DMG, first-run downloads
npm run dist:full     # unsigned DMG, model + browser baked in for offline install
```
