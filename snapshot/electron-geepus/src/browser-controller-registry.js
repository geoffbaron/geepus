'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CONTROLLER_SPEC_VERSION = 1;
const CONTROLLER_SPEC_DIR = path.join('.geepus', 'browser-controllers');
const CONTROLLER_PROPOSED_SUBDIR = path.join(CONTROLLER_SPEC_DIR, 'proposed');
const CONTROLLER_ACTIVE_SUBDIR = path.join(CONTROLLER_SPEC_DIR, 'active');

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStringArray(value) {
  return ensureArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizePlaybookSteps(value) {
  return ensureArray(value)
    .map((item) => {
      const step = item && typeof item === 'object' ? item : {};
      return {
        kind: String(step.kind || '').trim(),
        action: String(step.action || '').trim(),
        targetText: String(step.targetText || '').trim(),
        targetLabel: String(step.targetLabel || '').trim(),
        url: String(step.url || '').trim(),
        requiresTexts: normalizeStringArray(step.requiresTexts),
      };
    })
    .filter((step) => step.kind && step.action);
}

function validateBrowserControllerSpec(spec) {
  const errors = [];
  const value = spec && typeof spec === 'object' ? spec : null;
  if (!value) {
    return { ok: false, errors: ['Spec must be an object.'] };
  }
  if (Number(value.version) !== CONTROLLER_SPEC_VERSION) {
    errors.push(`version must be ${CONTROLLER_SPEC_VERSION}.`);
  }
  if (!String(value.id || '').trim()) {
    errors.push('id is required.');
  }
  if (!String(value.name || '').trim()) {
    errors.push('name is required.');
  }

  const match = value.match && typeof value.match === 'object' ? value.match : {};
  const domains = normalizeStringArray(match.domains);
  if (domains.length === 0) {
    errors.push('match.domains must include at least one domain.');
  }

  const route = value.route && typeof value.route === 'object' ? value.route : {};
  const preferredEntryUrls = normalizeStringArray(route.preferredEntryUrls);
  const fallbackEntryUrls = normalizeStringArray(route.fallbackEntryUrls);
  const linkTextPriority = normalizeStringArray(route.linkTextPriority);
  const emailVerification = route.emailVerification && typeof route.emailVerification === 'object'
    ? route.emailVerification
    : {};
  const inboxSubjectKeywords = normalizeStringArray(emailVerification.inboxSubjectKeywords);
  const verifyLinkTexts = normalizeStringArray(emailVerification.verifyLinkTexts);
  const playbook = value.playbook && typeof value.playbook === 'object' ? value.playbook : {};
  const steps = normalizePlaybookSteps(playbook.steps);

  return {
    ok: errors.length === 0,
    errors,
    spec: {
      version: CONTROLLER_SPEC_VERSION,
      id: String(value.id || '').trim(),
      name: String(value.name || '').trim(),
      match: {
        domains,
        intents: normalizeStringArray(match.intents).map((item) => item.toLowerCase()),
      },
      route: {
        preferredEntryUrls,
        fallbackEntryUrls,
        linkTextPriority,
        emailVerification: {
          inboxSubjectKeywords,
          verifyLinkTexts,
        },
      },
      playbook: {
        steps,
      },
    },
  };
}

function loadBrowserControllerSpecsSync(workspaceRoot) {
  const root = String(workspaceRoot || '').trim();
  if (!root) return [];
  const candidateDirs = [
    path.join(root, CONTROLLER_SPEC_DIR),
    path.join(root, CONTROLLER_ACTIVE_SUBDIR),
  ].filter((dir, index, array) => array.indexOf(dir) === index);
  const specs = [];
  for (const specDir of candidateDirs) {
    if (!fs.existsSync(specDir)) continue;
    const entries = fs.readdirSync(specDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(specDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const validation = validateBrowserControllerSpec(parsed);
        if (!validation.ok) continue;
        specs.push({
          ...validation.spec,
          sourcePath: fullPath,
        });
      } catch {
        // Ignore malformed specs. They are user-extensible artifacts and should not crash the run loop.
      }
    }
  }
  return specs;
}

function pickMatchingBrowserControllerSpec(specs, { objective = '', domain = '' } = {}) {
  const lowerObjective = String(objective || '').toLowerCase();
  const normalizedDomain = String(domain || '').toLowerCase().replace(/^www\./, '');
  const intentTags = [];
  if (/\b(sign.?up|signup|register)\b/.test(lowerObjective) || (/\bcreate\b/.test(lowerObjective) && /\baccount\b/.test(lowerObjective))) {
    intentTags.push('signup');
  }
  if (/\b(log.?in|login|sign.?in|signin)\b/.test(lowerObjective)) {
    intentTags.push('login');
  }
  if (/\b(verify|verification|confirm email|check inbox)\b/.test(lowerObjective)) {
    intentTags.push('verification');
  }
  if (/\b(checkout|place order|submit order|pay now|purchase|buy)\b/.test(lowerObjective)) {
    intentTags.push('checkout');
  }
  if (/\b(book|booking|reserve|reservation|schedule|appointment|demo)\b/.test(lowerObjective)) {
    intentTags.push('booking');
  }
  if (/\b(onboarding|onboard|finish setup|complete setup|get started|welcome flow)\b/.test(lowerObjective)) {
    intentTags.push('onboarding');
  }
  if (/\b(export|download|csv|pdf|report|statement)\b/.test(lowerObjective)) {
    intentTags.push('export');
  }

  const candidates = ensureArray(specs).filter((spec) => {
    const domains = normalizeStringArray(spec.match?.domains).map((item) => item.toLowerCase().replace(/^www\./, ''));
    if (normalizedDomain && domains.length > 0 && !domains.includes(normalizedDomain)) return false;
    const intents = normalizeStringArray(spec.match?.intents).map((item) => item.toLowerCase());
    if (intents.length === 0) return true;
    return intentTags.some((tag) => intents.includes(tag));
  });

  return candidates[0] || null;
}

async function listProposedBrowserControllerSpecs(workspaceRoot) {
  const root = String(workspaceRoot || '').trim();
  if (!root) return [];
  const dir = path.join(root, CONTROLLER_PROPOSED_SUBDIR);
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const output = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const parsed = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
        const validation = validateBrowserControllerSpec(parsed);
        output.push({
          ok: validation.ok,
          errors: validation.errors,
          id: validation.spec?.id || '',
          name: validation.spec?.name || '',
          match: validation.spec?.match || {},
          route: validation.spec?.route || {},
          playbook: validation.spec?.playbook || { steps: [] },
          sourcePath: fullPath,
        });
      } catch (error) {
        output.push({
          ok: false,
          errors: [String(error.message || error)],
          id: '',
          name: '',
          match: {},
          route: {},
          playbook: { steps: [] },
          sourcePath: fullPath,
        });
      }
    }
    return output;
  } catch {
    return [];
  }
}

function safeSpecFileName(id = '') {
  return String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'controller-spec';
}

async function saveProposedBrowserControllerSpec(workspaceRoot, spec) {
  const validation = validateBrowserControllerSpec(spec);
  if (!validation.ok) {
    throw new Error(`Invalid browser controller spec: ${validation.errors.join(' ')}`);
  }
  const root = String(workspaceRoot || '').trim();
  if (!root) throw new Error('workspaceRoot is required');
  const dir = path.join(root, CONTROLLER_PROPOSED_SUBDIR);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeSpecFileName(validation.spec.id)}.json`);
  await fsp.writeFile(file, JSON.stringify(validation.spec, null, 2), 'utf8');
  return file;
}

async function promoteProposedBrowserControllerSpec(workspaceRoot, specId) {
  const root = String(workspaceRoot || '').trim();
  const id = String(specId || '').trim();
  if (!root) throw new Error('workspaceRoot is required');
  if (!id) throw new Error('specId is required');

  const proposedPath = path.join(root, CONTROLLER_PROPOSED_SUBDIR, `${safeSpecFileName(id)}.json`);
  const raw = await fsp.readFile(proposedPath, 'utf8');
  const parsed = JSON.parse(raw);
  const validation = validateBrowserControllerSpec(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid proposed browser controller spec: ${validation.errors.join(' ')}`);
  }

  const activeDir = path.join(root, CONTROLLER_ACTIVE_SUBDIR);
  await fsp.mkdir(activeDir, { recursive: true });
  const activePath = path.join(activeDir, `${safeSpecFileName(validation.spec.id)}.json`);
  await fsp.writeFile(activePath, JSON.stringify(validation.spec, null, 2), 'utf8');
  await fsp.unlink(proposedPath).catch(() => {});
  return activePath;
}

module.exports = {
  CONTROLLER_SPEC_VERSION,
  CONTROLLER_SPEC_DIR,
  CONTROLLER_ACTIVE_SUBDIR,
  CONTROLLER_PROPOSED_SUBDIR,
  validateBrowserControllerSpec,
  loadBrowserControllerSpecsSync,
  listProposedBrowserControllerSpecs,
  pickMatchingBrowserControllerSpec,
  saveProposedBrowserControllerSpec,
  promoteProposedBrowserControllerSpec,
};
