# Releasing Geepus (and how auto-update works)

Geepus updates itself. Once a user is on a **signed** build installed from a public repo,
every later release downloads **only the changed bytes** (electron-builder blockmap +
electron-updater differential download) and installs on restart — the ~1GB model and
~170MB browser (which live in the user's data folder, not the app bundle) are never
re-downloaded.

## Cutting a release

1. Bump the version in `package.json` (semver — this is what electron-updater compares).
2. Commit and tag: `git commit -am "vX.Y.Z" && git tag vX.Y.Z && git push --tags`
3. Build the **signed** lite variant (the auto-update channel):
   ```
   npm run dist:lite:signed
   ```
   This produces, in `release/`:
   - `Geepus-X.Y.Z.dmg` — the first-run installer (manual download)
   - `Geepus-X.Y.Z.zip` + `Geepus-X.Y.Z.zip.blockmap` — what auto-update applies
   - `latest-mac.yml` — the update manifest electron-updater reads
4. Attach **all four** to the GitHub release (the `.zip`, its `.blockmap`, and
   `latest-mac.yml` are what make auto-update work — not just the dmg):
   ```
   gh release create vX.Y.Z --title "…" --notes "…" \
     release/Geepus-X.Y.Z.dmg release/Geepus-X.Y.Z.zip \
     release/Geepus-X.Y.Z.zip.blockmap release/latest-mac.yml
   ```
   (Optionally also attach `Geepus-X.Y.Z-full.dmg` from `npm run dist:full:signed` as the
   offline installer — but it is **not** part of the auto-update channel.)

`npm run build` already emits these artifacts, so you can inspect them before signing.

## The two things that make auto-update live

Both are one-time and are documented in the app's README and release notes:

1. **Signing.** macOS (Squirrel.Mac) refuses to apply an *unsigned* update, and it can't
   upgrade an unsigned install into a signed one (signature mismatch). So the **first
   signed build must be installed manually from the DMG** — from then on auto-update
   carries every release forward (signed → signed). Requires the Developer ID cert +
   `geepus-notary` keychain profile (see README → "Signed + notarized builds").
2. **Public repo.** A shipped app can't carry a private-repo token, so
   `github.com/geoffbaron/geepus` must be **public** for the update feed to resolve.
   While it's private, update checks 404 and the app stays silent — no errors shown.

## What the user sees

Nothing, until an update is downloaded and ready — then a single banner: *"A new version
of Geepus is ready. Restart to update."* Downloads happen in the background; a faint
progress line is the only other thing that ever appears. Settings → "About & updates" has
a manual "Check for updates" and shows the current version.
