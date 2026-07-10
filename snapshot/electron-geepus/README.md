# Geepus Desktop (Electron)

Geepus is a local desktop assistant app with chat + autonomous task execution.

## Easiest launch (no command memorization)

1. Open Finder.
2. Go to `/Users/geoffbaron/Desktop/geepus/electron-geepus`.
3. Double-click `Open Geepus.command`.

That script installs dependencies (if needed) and launches Geepus.

## Launch as a normal app

- Built app path: `/Users/geoffbaron/Desktop/geepus/electron-geepus/dist/Geepus-darwin-arm64/Geepus.app`
- Launcher wrapper app (always rebuilds + opens latest): `/Users/geoffbaron/Desktop/geepus/electron-geepus/Launch Geepus.app`
- Desktop launcher shortcut (points to wrapper app): `/Users/geoffbaron/Desktop/Launch Geepus.app`

## First-time setup in app

1. Use **Quick Setup** in the left sidebar.
2. **Step 1:** choose service, paste key, click **Connect Geepus**.
3. **Step 2:** click **Find Models I Can Use** and pick a model.
4. **Step 3 (optional):** set a project folder or leave blank for auto-find.
5. Set **Agent mode** in **Advanced Settings** if needed:
   - `Teams` = Product + Design + Dev + QA orchestration.
   - `Solo` = single-agent planning.
6. Enter your objective and click **Start Task**.

## Planning vs Action

- **Planning Mode** (default): collaborate with Geepus to refine the plan. No actions are executed.
- **Action Mode**: click **Start Task** in the chat composer to execute the task loop.
- You can switch modes right above the main text box.

If you leave Workspace Folder as default, Geepus will auto-discover likely project folders/files from objective text and prior memory.

## Teams + skills + memory

- Team mode uses four roles: Product Lead, Design Lead, Engineering Lead, QA Lead.
- Skills are auto-discovered from:
  - `.claude/skills/**/SKILL.md`
  - `.geepus/skills/**/SKILL.md`
  - `skills/**/SKILL.md`
- Project memory is persisted per workspace in Electron user data (`agent-memory/`).
- Global memory is persisted across workspaces so Geepus can remember where past projects/artifacts live.
- QA guard: when code changes are planned and no verification step exists, Geepus injects a test/lint action when a supported stack is detected.

## Agent capabilities (safe subset)

- Reads files and lists folders inside your workspace folder.
- Writes/appends files inside your workspace folder.
- Runs allowlisted commands (`npm/pnpm/yarn` test/build/lint/install, `swift build/test`, safe `git` commands, basic read-only shell commands).
- Supports project scaffolding commands with approval (`npm create`, `npx ...`, `mkdir`, `touch`, `cp`, `mv`).
- Supports browser automation with approval via Playwright (`run_playwright` tool).
- Blocks dangerous commands (`sudo`, `rm`, `launchctl`, `ssh`, `git push`, and others).
- Writes hash-chained execution audit events to `agent-audit.log` in Electron user data.
- Executes multi-iteration objective loops with budget limits (`maxIterations`, `maxRuntimeMinutes`, `maxActions`).
- Shows a workflow board with Planner / Builder / Reviewer lanes and resumable checkpoints.

## Resume runs

- Use **Resume Latest Run** in Workflow Runner.
- Use **Watch Task** to open a live monitoring window that shows which agent is currently working and a timeline of actions.
- Run states are persisted under `agent-runs/` in Electron user data.

## Playwright setup

- Install package (already added): `npm install playwright`
- Install Chromium once if needed: `npx playwright install chromium`

## Notes

- Settings are stored in Electron user data (`settings.json`).
- **Restart App** restarts Geepus from inside the UI.
- If your selected model is inaccessible, Geepus auto-falls back to another model returned by your account.
