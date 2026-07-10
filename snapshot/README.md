# Geepus Assistant (Secure macOS Chief-of-Staff)

A native macOS assistant architecture with strict capability security, policy gating, deterministic workflows, and auditable execution.

## What Is Implemented

- Two-process design:
  - `AssistantUI` (SwiftUI app process)
  - `AssistantDaemon` (separate XPC execution process)
- XPC boundary with typed request/reply objects (`NSSecureCoding`)
- Mandatory execution contract schema for every action
- Capability token issuance + HMAC signature verification + TTL
- Safe-by-default policy engine with:
  - hard deny rules
  - explicit approval routing
  - auto-allow subset
  - risk scoring
- Copy-on-write workspace mirror for all writes
- Post-execution validation gate (tests + lint) before write-back
- Rollback by discarding mirror snapshot
- Hash-chained append-only audit log
- Session budgets and hard-stop behavior
- Per-project/per-profile memory store with secret redaction
- Prompt injection guard for web-retrieved content
- Model router + switcher scaffolding:
  - Ollama
  - llama.cpp
  - MLX
  - API backend
  - offline mode enforcement
- OpenAI-compatible connector test UI:
  - base URL + model configuration
  - Keychain-backed API key save/clear
  - one-click live connector test
- Safe deterministic recipes:
  - code change
  - research
  - refactor
  - documentation

## Security Defaults

- No implicit global access
- Network denied in offline mode
- Shell gated by allowlist
- Git push blocked by default
- Hard-deny matching for keychain abuse, sudo/escalation, persistence locations, secret exfil patterns, and system-folder destructive operations

## Project Layout

- `/Users/geoffbaron/Desktop/geepus/Package.swift`
- `/Users/geoffbaron/Desktop/geepus/Sources/AssistantShared/`
- `/Users/geoffbaron/Desktop/geepus/Sources/AssistantDaemon/`
- `/Users/geoffbaron/Desktop/geepus/Sources/AssistantUI/`
- `/Users/geoffbaron/Desktop/geepus/Tests/AssistantSharedTests/`

## Build and Test

```bash
swift build
swift test
```

## Run as XPC Service (Development)

1. Build binaries:
   ```bash
   swift build
   ```
2. Install launch agent:
   ```bash
   cp /Users/geoffbaron/Desktop/geepus/Deployment/com.geepus.AssistantDaemon.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.geepus.AssistantDaemon.plist
   launchctl enable gui/$(id -u)/com.geepus.AssistantDaemon
   launchctl kickstart -k gui/$(id -u)/com.geepus.AssistantDaemon
   ```
3. Run UI:
   ```bash
   swift run AssistantUI
   ```

## Quick API Test

1. In the app, open `API Connector` in the left panel.
2. Set:
   - `Base URL`: `https://api.openai.com`
   - `API Model`: `gpt-4.1-mini` (or your preferred model)
3. Paste key in `API Key`, click `Save Key`.
4. Click `Test Connector` to run a live prompt.

## Important Notes

- This is a secure architecture scaffold, not a production-signed launchd deployment yet.
- For real deployment, add:
  - launchd plist and proper Mach service registration
  - app sandbox entitlements per target
  - hardened runtime and code signing
  - App Group strategy for shared secure state
  - stricter diff simulation and file patch model
  - richer approval UX with signed approval artifacts
