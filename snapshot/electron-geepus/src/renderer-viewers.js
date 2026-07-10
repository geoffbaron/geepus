/**
 * renderer-viewers.js — Knowledge Viewer ("What I Know") & Security Viewer ("What I Can Do")
 *
 * Non-technical, friendly panels that show the user exactly what Geepus
 * remembers and what it's allowed to do.
 *
 * Depends on: renderer-state.js (el), renderer-utils.js (setStatus, escapeHtml)
 */

// --- DOM refs ---
el.knowledgeViewerCard = document.getElementById('knowledgeViewerCard');
el.knowledgeRefreshButton = document.getElementById('knowledgeRefreshButton');
el.knowledgeViewerContent = document.getElementById('knowledgeViewerContent');

el.securityViewerCard = document.getElementById('securityViewerCard');
el.securityRefreshButton = document.getElementById('securityRefreshButton');
el.securityViewerContent = document.getElementById('securityViewerContent');

// ---------------------------------------------------------------------------
// Knowledge Viewer
// ---------------------------------------------------------------------------

function renderKnowledgeViewer(data) {
  const container = el.knowledgeViewerContent;
  container.innerHTML = '';
  const activeControllers = Array.isArray(data.browserControllers?.active) ? data.browserControllers.active : [];
  const proposedControllers = (Array.isArray(data.browserControllers?.proposed) ? data.browserControllers.proposed : [])
    .slice()
    .sort((left, right) => {
      const a = Number(right?.maturity?.successfulRuns || 0) - Number(left?.maturity?.successfulRuns || 0);
      if (a !== 0) return a;
      return Number(right?.maturity?.relatedRuns || 0) - Number(left?.maturity?.relatedRuns || 0);
    });

  // ── Summary Banner ──
  const summary = document.createElement('div');
  summary.className = 'viewer-summary';
  const noteCount = (data.userNotes || []).length;
  const projectCount = (data.projects || []).length;
  const vectorCount = data.vectorMemory?.totalVectors || 0;
  const currentFiles = data.currentProject?.knownFiles?.length || 0;
  summary.innerHTML = `
    <div class="viewer-stat"><span class="viewer-stat-num">${noteCount}</span><span class="viewer-stat-label">Notes</span></div>
    <div class="viewer-stat"><span class="viewer-stat-num">${projectCount}</span><span class="viewer-stat-label">Projects</span></div>
    <div class="viewer-stat"><span class="viewer-stat-num">${vectorCount}</span><span class="viewer-stat-label">Memories</span></div>
    <div class="viewer-stat"><span class="viewer-stat-num">${currentFiles}</span><span class="viewer-stat-label">Known files</span></div>
    <div class="viewer-stat"><span class="viewer-stat-num">${activeControllers.length}</span><span class="viewer-stat-label">Live web skills</span></div>
    <div class="viewer-stat"><span class="viewer-stat-num">${proposedControllers.length}</span><span class="viewer-stat-label">Proposed web skills</span></div>
  `;
  container.appendChild(summary);

  // ── Current Project ──
  if (data.currentProject) {
    const section = createViewerSection('Current Project', '📂');
    const proj = data.currentProject;

    if (data.activeWorkspace) {
      const wsLabel = document.createElement('p');
      wsLabel.className = 'viewer-detail';
      const shortPath = data.activeWorkspace.replace(/^\/Users\/[^/]+/, '~');
      wsLabel.textContent = shortPath;
      section.appendChild(wsLabel);
    }

    if (proj.recentObjectives && proj.recentObjectives.length > 0) {
      const objHeading = document.createElement('h4');
      objHeading.className = 'viewer-sub-heading';
      objHeading.textContent = 'Recent tasks';
      section.appendChild(objHeading);
      const list = document.createElement('ul');
      list.className = 'viewer-list';
      for (const obj of proj.recentObjectives.slice(-5)) {
        const li = document.createElement('li');
        li.textContent = obj.length > 80 ? obj.slice(0, 77) + '…' : obj;
        list.appendChild(li);
      }
      section.appendChild(list);
    }

    if (proj.notes && proj.notes.length > 0) {
      const notesHeading = document.createElement('h4');
      notesHeading.className = 'viewer-sub-heading';
      notesHeading.textContent = 'Things I remember';
      section.appendChild(notesHeading);
      const list = document.createElement('ul');
      list.className = 'viewer-list';
      for (const note of proj.notes.slice(-8)) {
        const li = document.createElement('li');
        li.textContent = note.length > 100 ? note.slice(0, 97) + '…' : note;
        list.appendChild(li);
      }
      section.appendChild(list);
    }

    if (proj.knownFiles && proj.knownFiles.length > 0) {
      const filesHeading = document.createElement('h4');
      filesHeading.className = 'viewer-sub-heading';
      filesHeading.textContent = `Files I've worked with (${proj.knownFiles.length})`;
      section.appendChild(filesHeading);
      const list = document.createElement('ul');
      list.className = 'viewer-list viewer-file-list';
      for (const f of proj.knownFiles.slice(-15)) {
        const li = document.createElement('li');
        const shortFile = f.replace(/^\/Users\/[^/]+/, '~');
        li.textContent = shortFile;
        list.appendChild(li);
      }
      if (proj.knownFiles.length > 15) {
        const more = document.createElement('li');
        more.className = 'viewer-more';
        more.textContent = `… and ${proj.knownFiles.length - 15} more`;
        list.appendChild(more);
      }
      section.appendChild(list);
    }

    if (proj.updatedAt) {
      const ts = document.createElement('p');
      ts.className = 'viewer-timestamp';
      ts.textContent = `Last updated: ${friendlyDate(proj.updatedAt)}`;
      section.appendChild(ts);
    }

    container.appendChild(section);
  }

  if (activeControllers.length > 0 || proposedControllers.length > 0 || data.activeWorkspace) {
    const section = createViewerSection('Browser Skills', '🌐');
    if (data.activeWorkspace) {
      const workspace = document.createElement('p');
      workspace.className = 'viewer-detail';
      workspace.textContent = `Workspace: ${data.activeWorkspace.replace(/^\/Users\/[^/]+/, '~')}`;
      section.appendChild(workspace);
    }

    if (activeControllers.length > 0) {
      const activeHeading = document.createElement('h4');
      activeHeading.className = 'viewer-sub-heading';
      activeHeading.textContent = 'Active controllers';
      section.appendChild(activeHeading);
      for (const spec of activeControllers) {
        section.appendChild(createBrowserControllerCard(spec, { proposed: false }));
      }
    }

    if (proposedControllers.length > 0) {
      const proposedHeading = document.createElement('h4');
      proposedHeading.className = 'viewer-sub-heading';
      proposedHeading.textContent = 'Proposed controllers';
      section.appendChild(proposedHeading);
      for (const spec of proposedControllers) {
        section.appendChild(createBrowserControllerCard(spec, {
          proposed: true,
          workspaceRoot: data.activeWorkspace || '',
        }));
      }
    }

    if (activeControllers.length === 0 && proposedControllers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'viewer-detail';
      empty.textContent = 'No browser controller specs yet. Geepus will add proposals here as it learns new sites.';
      section.appendChild(empty);
    }

    container.appendChild(section);
  }

  // ── User Notes (global) ──
  if (data.userNotes && data.userNotes.length > 0) {
    const section = createViewerSection('My Notes', '📝');
    const list = document.createElement('ul');
    list.className = 'viewer-list';
    for (const note of data.userNotes.slice(-12)) {
      const li = document.createElement('li');
      li.textContent = note.length > 120 ? note.slice(0, 117) + '…' : note;
      list.appendChild(li);
    }
    section.appendChild(list);
    container.appendChild(section);
  }

  // ── Other Projects ──
  if (data.projects && data.projects.length > 0) {
    const section = createViewerSection('All Projects', '🗂️');
    for (const proj of data.projects) {
      const card = document.createElement('div');
      card.className = 'viewer-project-card';
      const name = document.createElement('div');
      name.className = 'viewer-project-name';
      name.textContent = proj.label || 'Untitled';
      card.appendChild(name);
      if (proj.lastObjective) {
        const obj = document.createElement('div');
        obj.className = 'viewer-project-detail';
        obj.textContent = proj.lastObjective.length > 60
          ? proj.lastObjective.slice(0, 57) + '…'
          : proj.lastObjective;
        card.appendChild(obj);
      }
      const meta = document.createElement('div');
      meta.className = 'viewer-project-meta';
      const parts = [];
      if (proj.lastStatus) parts.push(friendlyStatus(proj.lastStatus));
      if (proj.fileCount > 0) parts.push(`${proj.fileCount} files`);
      if (proj.updatedAt) parts.push(friendlyDate(proj.updatedAt));
      meta.textContent = parts.join(' · ');
      card.appendChild(meta);
      section.appendChild(card);
    }
    container.appendChild(section);
  }

  // ── Vector Memory ──
  if (data.vectorMemory && data.vectorMemory.totalVectors > 0) {
    const section = createViewerSection('Deep Memory', '🧠');
    const desc = document.createElement('p');
    desc.className = 'viewer-detail';
    desc.textContent = `${data.vectorMemory.totalVectors} memories stored across ${(data.vectorMemory.namespaces || []).length} categories. These are automatically created when Geepus works on tasks.`;
    section.appendChild(desc);
    if (data.vectorMemory.namespaces && data.vectorMemory.namespaces.length > 0) {
      const list = document.createElement('ul');
      list.className = 'viewer-list';
      for (const ns of data.vectorMemory.namespaces) {
        const li = document.createElement('li');
        li.textContent = `${ns.namespace}: ${ns.count} memories`;
        list.appendChild(li);
      }
      section.appendChild(list);
    }
    container.appendChild(section);
  }

  // ── Empty state ──
  if (container.children.length <= 1) {
    const empty = document.createElement('p');
    empty.className = 'viewer-empty';
    empty.textContent = 'Geepus hasn\'t learned anything yet. Start a task to build up knowledge!';
    container.appendChild(empty);
  }
}

// ---------------------------------------------------------------------------
// Security Viewer
// ---------------------------------------------------------------------------

function renderSecurityViewer(data) {
  const container = el.securityViewerContent;
  container.innerHTML = '';
  updateSecurityControlStatuses(data.securityControls || {}, data.now || Date.now());

  // ── Current Setup ──
  const setup = document.createElement('div');
  setup.className = 'viewer-summary';
  const providerLabel = { openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama (Local)' }[data.provider] || data.provider;
  const modelShort = data.model ? data.model.split('/').pop().split(':')[0] : 'Default';
  setup.innerHTML = `
    <div class="viewer-stat"><span class="viewer-stat-label">AI Service</span><span class="viewer-stat-val">${escapeHtml(providerLabel)}</span></div>
    <div class="viewer-stat"><span class="viewer-stat-label">Model</span><span class="viewer-stat-val">${escapeHtml(modelShort)}</span></div>
  `;
  container.appendChild(setup);

  // ── Abilities ──
  const abilitiesSection = createViewerSection('Abilities', '✅');
  for (const tool of data.tools || []) {
    const row = document.createElement('div');
    row.className = 'viewer-ability-row';
    const name = document.createElement('span');
    name.className = 'viewer-ability-name';
    name.textContent = tool.name;
    const desc = document.createElement('span');
    desc.className = 'viewer-ability-desc';
    desc.textContent = tool.description;
    const badge = document.createElement('span');
    badge.className = `viewer-risk-badge risk-${tool.risk}`;
    badge.textContent = tool.risk;
    row.appendChild(name);
    row.appendChild(desc);
    row.appendChild(badge);
    abilitiesSection.appendChild(row);
  }
  container.appendChild(abilitiesSection);

  // ── Things I'll Never Do ──
  const blockedSection = createViewerSection('Things I\'ll Never Do', '🚫');
  for (const item of data.blocked || []) {
    const row = document.createElement('div');
    row.className = 'viewer-blocked-row';
    const cmd = document.createElement('span');
    cmd.className = 'viewer-blocked-cmd';
    cmd.textContent = item.command;
    const reason = document.createElement('span');
    reason.className = 'viewer-blocked-reason';
    reason.textContent = item.reason;
    row.appendChild(cmd);
    row.appendChild(reason);
    blockedSection.appendChild(row);
  }
  container.appendChild(blockedSection);

  // ── Things I'll Ask About First ──
  if (data.needsApproval && data.needsApproval.length > 0) {
    const gatedSection = createViewerSection('I\'ll Ask First', '🔐');
    const desc = document.createElement('p');
    desc.className = 'viewer-detail';
    desc.textContent = 'These actions require your explicit approval before Geepus will run them.';
    gatedSection.appendChild(desc);
    for (const item of data.needsApproval) {
      const row = document.createElement('div');
      row.className = 'viewer-blocked-row';
      const cmd = document.createElement('span');
      cmd.className = 'viewer-gated-cmd';
      cmd.textContent = item.command;
      const reason = document.createElement('span');
      reason.className = 'viewer-blocked-reason';
      reason.textContent = item.reason;
      row.appendChild(cmd);
      row.appendChild(reason);
      gatedSection.appendChild(row);
    }
    container.appendChild(gatedSection);
  }

  // ── Command Categories ──
  const categoriesSection = createViewerSection('Allowed Commands', '⚙️');
  const catDesc = document.createElement('p');
  catDesc.className = 'viewer-detail';
  catDesc.textContent = 'Geepus can run these kinds of terminal commands when working on tasks.';
  categoriesSection.appendChild(catDesc);
  for (const cat of data.allowedCategories || []) {
    const row = document.createElement('div');
    row.className = 'viewer-category-row';
    const name = document.createElement('div');
    name.className = 'viewer-category-name';
    name.textContent = cat.category;
    const badge = document.createElement('span');
    badge.className = `viewer-risk-badge risk-${cat.risk.replace('–', '-')}`;
    badge.textContent = cat.risk;
    name.appendChild(badge);
    const examples = document.createElement('div');
    examples.className = 'viewer-category-examples';
    examples.textContent = cat.examples;
    row.appendChild(name);
    row.appendChild(examples);
    categoriesSection.appendChild(row);
  }
  container.appendChild(categoriesSection);

  // ── Safety Limits ──
  const limitsSection = createViewerSection('Safety Limits', '🛡️');
  const limitsDesc = document.createElement('p');
  limitsDesc.className = 'viewer-detail';
  if (data.isLocalModel) {
    limitsDesc.textContent = 'Running on a local model — constraints are relaxed (free inference). Geepus will only stop for genuine loops or idle timeouts.';
  } else {
    limitsDesc.textContent = 'Geepus automatically stops when any of these limits are reached.';
  }
  limitsSection.appendChild(limitsDesc);
  const limitsGrid = document.createElement('div');
  limitsGrid.className = 'viewer-limits-grid';
  const fmtLimit = (val, unit) => val >= 999 ? `Unlimited` : `${val} ${unit}`;
  const limitItems = [
    { label: 'Max runtime', value: fmtLimit(data.runLimits.maxRuntimeMinutes, 'minutes') },
    { label: 'Max iterations', value: fmtLimit(data.runLimits.maxIterations, 'rounds') },
    { label: 'Max actions', value: fmtLimit(data.runLimits.maxActions, 'total') },
    { label: 'AI calls / minute', value: fmtLimit(data.runLimits.modelCallsPerMinute, '') },
    { label: 'Tool calls / minute', value: fmtLimit(data.runLimits.toolCallsPerMinute, '') },
    { label: 'Idle timeout', value: `${data.runLimits.idleTimeoutSeconds} seconds` },
  ];
  for (const item of limitItems) {
    const cell = document.createElement('div');
    cell.className = 'viewer-limit-cell';
    cell.innerHTML = `<span class="viewer-limit-label">${escapeHtml(item.label)}</span><span class="viewer-limit-value">${escapeHtml(item.value)}</span>`;
    limitsGrid.appendChild(cell);
  }
  limitsSection.appendChild(limitsGrid);
  container.appendChild(limitsSection);
}

function durationToMs(value) {
  const map = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  return map[String(value || '').trim()] || (60 * 60 * 1000);
}

function formatGrantStatus(until, now) {
  const ts = Number(until || 0);
  if (!Number.isFinite(ts) || ts <= now) return 'Off';
  if (ts > now + (365 * 24 * 60 * 60 * 1000)) return 'On until you turn it off';
  const remainingMs = ts - now;
  const remainingMinutes = Math.round(remainingMs / 60000);
  if (remainingMinutes < 60) return `On for ~${remainingMinutes} minute(s)`;
  const remainingHours = Math.round(remainingMinutes / 60);
  if (remainingHours < 48) return `On for ~${remainingHours} hour(s)`;
  const remainingDays = Math.round(remainingHours / 24);
  return `On for ~${remainingDays} day(s)`;
}

function updateSecurityControlStatuses(controls, now = Date.now()) {
  const safe = controls || {};
  if (el.securityHighRiskStatus) {
    el.securityHighRiskStatus.textContent = formatGrantStatus(safe.highRiskAutoApproveUntil, now);
  }
  if (el.securityBrowserStatus) {
    el.securityBrowserStatus.textContent = formatGrantStatus(safe.browserControlUntil, now);
  }
  if (el.securityInternetStatus) {
    el.securityInternetStatus.textContent = formatGrantStatus(safe.internetAccessUntil, now);
  }
  if (el.securityRemoteStatus) {
    el.securityRemoteStatus.textContent = formatGrantStatus(safe.remoteAccessUntil, now);
  }
}

async function setSecurityGrant(controlKey, durationMs) {
  const expiresAt = durationMs > 0 ? (Date.now() + durationMs) : 0;
  await saveSettingsPatch({
    securityControls: {
      [controlKey]: expiresAt,
    },
  });
  await refreshSecurityViewer();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createViewerSection(title, icon) {
  const section = document.createElement('div');
  section.className = 'viewer-section';
  const heading = document.createElement('h3');
  heading.className = 'viewer-section-heading';
  heading.textContent = `${icon}  ${title}`;
  section.appendChild(heading);
  return section;
}

function renderBrowserControllerRuleList(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (values.length === 0) return '';
  return values.slice(0, 5).map((item) => escapeHtml(String(item))).join(' · ');
}

function createBrowserControllerCard(spec, { proposed = false, workspaceRoot = '' } = {}) {
  const card = document.createElement('div');
  card.className = 'viewer-controller-card';
  const domains = Array.isArray(spec.match?.domains) ? spec.match.domains : [];
  const intents = Array.isArray(spec.match?.intents) ? spec.match.intents : [];
  const preferredEntryUrls = Array.isArray(spec.route?.preferredEntryUrls) ? spec.route.preferredEntryUrls : [];
  const linkTextPriority = Array.isArray(spec.route?.linkTextPriority) ? spec.route.linkTextPriority : [];
  const subjectKeywords = Array.isArray(spec.route?.emailVerification?.inboxSubjectKeywords)
    ? spec.route.emailVerification.inboxSubjectKeywords
    : [];
  const playbookSteps = Array.isArray(spec.playbook?.steps) ? spec.playbook.steps : [];

  const head = document.createElement('div');
  head.className = 'viewer-controller-head';
  head.innerHTML = `
    <div>
      <div class="viewer-controller-name">${escapeHtml(String(spec.name || spec.id || 'Unnamed controller'))}</div>
      <div class="viewer-controller-meta">${escapeHtml(String(spec.id || ''))}</div>
    </div>
    <span class="viewer-risk-badge ${proposed ? 'risk-medium' : 'risk-low'}">${proposed ? 'proposed' : 'active'}</span>
  `;
  card.appendChild(head);

  const details = document.createElement('div');
  details.className = 'viewer-controller-grid';
  details.innerHTML = `
    <div><span class="viewer-controller-label">Domains</span><span class="viewer-controller-value">${escapeHtml(domains.join(', ') || '—')}</span></div>
    <div><span class="viewer-controller-label">Intents</span><span class="viewer-controller-value">${escapeHtml(intents.join(', ') || '—')}</span></div>
    <div><span class="viewer-controller-label">Entry URLs</span><span class="viewer-controller-value">${renderBrowserControllerRuleList(preferredEntryUrls) || '—'}</span></div>
    <div><span class="viewer-controller-label">Link priority</span><span class="viewer-controller-value">${renderBrowserControllerRuleList(linkTextPriority) || '—'}</span></div>
    <div><span class="viewer-controller-label">Inbox hints</span><span class="viewer-controller-value">${renderBrowserControllerRuleList(subjectKeywords) || '—'}</span></div>
    <div><span class="viewer-controller-label">Learned steps</span><span class="viewer-controller-value">${playbookSteps.length ? escapeHtml(playbookSteps.map((step) => {
      const target = step.targetLabel || step.targetText || step.url || '';
      return target ? `${step.action}:${target}` : step.action;
    }).slice(0, 4).join(' · ')) : '—'}</span></div>
  `;
  card.appendChild(details);

  if (spec.sourcePath) {
    const pathRow = document.createElement('div');
    pathRow.className = 'viewer-controller-path';
    pathRow.textContent = spec.sourcePath.replace(/^\/Users\/[^/]+/, '~');
    card.appendChild(pathRow);
  }

  if (proposed && spec.maturity) {
    const maturity = document.createElement('div');
    maturity.className = 'viewer-controller-maturity';
    const recommendation = String(spec.maturity.recommendation || '').trim() || 'No recommendation yet.';
    const lastSuccess = spec.maturity.lastSuccessAt ? ` Last success: ${friendlyDate(spec.maturity.lastSuccessAt)}.` : '';
    maturity.textContent = `${recommendation}${lastSuccess}`;
    card.appendChild(maturity);
  }

  if (proposed && spec.ok === false) {
    const errorRow = document.createElement('div');
    errorRow.className = 'viewer-controller-errors';
    errorRow.textContent = `Invalid proposal: ${(Array.isArray(spec.errors) ? spec.errors : []).join(' ') || 'Unknown error.'}`;
    card.appendChild(errorRow);
  }

  if (proposed && spec.ok !== false && workspaceRoot && typeof window.geepus?.promoteBrowserController === 'function') {
    const actions = document.createElement('div');
    actions.className = 'viewer-controller-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small';
    button.textContent = spec.maturity?.shouldPromote ? 'Promote Recommended' : 'Promote';
    button.addEventListener('click', async () => {
      try {
        button.disabled = true;
        await window.geepus.promoteBrowserController(workspaceRoot, spec.id);
        setStatus(`Promoted browser skill: ${spec.name || spec.id}`);
        await refreshKnowledgeViewer();
      } catch (error) {
        setStatus(error.message || String(error));
        button.disabled = false;
      }
    });
    actions.appendChild(button);
    card.appendChild(actions);
  }

  return card;
}

function friendlyDate(isoString) {
  try {
    const d = new Date(isoString);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function friendlyStatus(status) {
  const map = {
    completed: '✅ Done',
    success: '✅ Done',
    failed: '❌ Failed',
    error: '❌ Error',
    running: '⏳ Running',
    stopped: '⏹️ Stopped',
  };
  return map[status] || status;
}

// ---------------------------------------------------------------------------
// Fetch & render
// ---------------------------------------------------------------------------

async function refreshKnowledgeViewer() {
  try {
    el.knowledgeViewerContent.innerHTML = '<p class="hint">Loading…</p>';
    const data = await window.geepus.getKnowledgeData();
    renderKnowledgeViewer(data);
  } catch (err) {
    el.knowledgeViewerContent.innerHTML = `<p class="hint">Could not load knowledge data: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

async function refreshSecurityViewer() {
  try {
    el.securityViewerContent.innerHTML = '<p class="hint">Loading…</p>';
    const data = await window.geepus.getSecurityData();
    state.securityControls = {
      ...(state.securityControls || {}),
      ...(data.securityControls || {}),
    };
    renderSecurityViewer(data);
  } catch (err) {
    el.securityViewerContent.innerHTML = `<p class="hint">Could not load security data: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function installViewerEvents() {
  el.knowledgeRefreshButton.addEventListener('click', () => {
    refreshKnowledgeViewer();
  });

  el.securityRefreshButton.addEventListener('click', () => {
    refreshSecurityViewer();
  });

  const bindTimedGrant = (allowButton, revokeButton, durationSelect, controlKey, label) => {
    if (allowButton) {
      allowButton.addEventListener('click', async () => {
        try {
          const durationMs = durationToMs(durationSelect?.value);
          await setSecurityGrant(controlKey, durationMs);
          setStatus(`${label} is now enabled.`);
        } catch (err) {
          setStatus(err.message || String(err));
        }
      });
    }
    if (revokeButton) {
      revokeButton.addEventListener('click', async () => {
        try {
          await setSecurityGrant(controlKey, 0);
          setStatus(`${label} is now turned off.`);
        } catch (err) {
          setStatus(err.message || String(err));
        }
      });
    }
  };

  bindTimedGrant(
    el.securityHighRiskAllowButton,
    el.securityHighRiskRevokeButton,
    el.securityHighRiskDuration,
    'highRiskAutoApproveUntil',
    'Sensitive actions auto-approval',
  );
  bindTimedGrant(
    el.securityBrowserAllowButton,
    el.securityBrowserRevokeButton,
    el.securityBrowserDuration,
    'browserControlUntil',
    'Browser control',
  );
  bindTimedGrant(
    el.securityInternetAllowButton,
    el.securityInternetRevokeButton,
    el.securityInternetDuration,
    'internetAccessUntil',
    'Internet access',
  );
  bindTimedGrant(
    el.securityRemoteAllowButton,
    el.securityRemoteRevokeButton,
    el.securityRemoteDuration,
    'remoteAccessUntil',
    'Remote publish/server access',
  );
}
