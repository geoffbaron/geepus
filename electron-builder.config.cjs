/**
 * One config for all four build shapes, driven by two env vars:
 *
 *   GEEPUS_VARIANT=lite|full  — "full" bakes the starter model + headless Chromium into
 *                               Contents/Resources/ (run scripts/bake-full-bundle.mts first).
 *   GEEPUS_SIGN=1             — Developer ID signing + notarization. Requires:
 *                               • a "Developer ID Application" cert in the login keychain
 *                                 (electron-builder auto-discovers it; no identity config needed)
 *                               • APPLE_KEYCHAIN_PROFILE naming a `xcrun notarytool
 *                                 store-credentials` profile (see package.json dist:*:signed)
 *
 * Unsigned builds keep identity:null (ad-hoc) — fine for local dev, but macOS 15+ calls
 * downloaded ad-hoc apps "damaged"; anything shared with another human should be signed.
 */
const variant = process.env.GEEPUS_VARIANT === 'full' ? 'full' : 'lite';
const sign = process.env.GEEPUS_SIGN === '1';

module.exports = {
  appId: 'com.geoffbaron.geepus',
  productName: 'Geepus',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: ['out/**/*', 'package.json'],
  ...(variant === 'full' && {
    extraResources: [
      { from: 'resources/models', to: 'models' },
      { from: 'resources/playwright-browsers', to: 'playwright-browsers' },
    ],
  }),
  // Auto-update feed (electron-updater). Building with this present emits latest-mac.yml +
  // .blockmap alongside the artifacts, which is what enables differential ("only the changed
  // bytes") downloads. GitHub Releases must be PUBLIC for a shipped app to read them — a
  // distributed binary can't carry a private-repo token.
  publish: { provider: 'github', owner: 'geoffbaron', repo: 'geepus' },
  mac: {
    // zip is REQUIRED for macOS auto-update — Squirrel.Mac applies the zip, not the dmg; the
    // dmg is only the first-run installer. The lite variant is the canonical update channel
    // (small bundle, heavy assets live in userData and survive updates untouched); the full
    // variant is a one-time offline installer, so it ships dmg only.
    target: variant === 'full' ? ['dmg'] : ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    ...(sign
      ? {
          entitlements: 'resources/entitlements.mac.plist',
          entitlementsInherit: 'resources/entitlements.mac.plist',
          notarize: true,
        }
      : { identity: null }),
  },
  // Distinct names per variant — both shapes share the same output dir and would
  // silently overwrite each other's DMG otherwise.
  artifactName: variant === 'full' ? '${productName}-${version}-full.${ext}' : '${productName}-${version}.${ext}',
  dmg: {
    title: variant === 'full' ? 'Geepus ${version} (Full)' : 'Geepus ${version}',
  },
};
