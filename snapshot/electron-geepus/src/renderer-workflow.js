/**
 * renderer-workflow.js — Workflow board, lane rendering, checkpoints,
 *   and run result formatters.
 *
 * Depends on: renderer-state.js (el)
 *             renderer-utils.js (escapeHtml — indirectly via formatInlineMarkdown)
 */

function setRunMeta(message) {
  el.runMeta.textContent = message;
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

function clearLane(listEl, emptyLabel) {
  listEl.innerHTML = '';
  const item = document.createElement('li');
  item.className = 'lane-item';
  item.textContent = emptyLabel;
  listEl.appendChild(item);
}

function renderLane(listEl, items, emptyLabel) {
  listEl.innerHTML = '';
  const data = Array.isArray(items) ? items : [];
  if (data.length === 0) {
    clearLane(listEl, emptyLabel);
    return;
  }

  data.slice(-14).forEach((entry) => {
    const item = document.createElement('li');
    item.className = `lane-item ${entry.status || ''}`.trim();
    item.textContent = `#${entry.iteration || '?'} ${entry.text || ''}`.trim();
    listEl.appendChild(item);
  });
}

function renderCheckpoints(checkpoints) {
  el.checkpointList.innerHTML = '';
  const data = Array.isArray(checkpoints) ? checkpoints : [];
  if (data.length === 0) {
    const item = document.createElement('li');
    item.className = 'checkpoint-item';
    item.textContent = 'No checkpoints yet.';
    el.checkpointList.appendChild(item);
    return;
  }

  data.slice(-20).forEach((checkpoint) => {
    const item = document.createElement('li');
    item.className = `checkpoint-item ${checkpoint.status || ''}`.trim();
    item.textContent = `Iteration ${checkpoint.iteration}: ${checkpoint.summary} (${checkpoint.okActions}/${checkpoint.actions} ok)`;
    el.checkpointList.appendChild(item);
  });
}

function renderWorkflow(workflow) {
  const lanes = workflow && workflow.lanes ? workflow.lanes : {};
  renderLane(el.plannerLane, lanes.planner, 'Planner is waiting for a run.');
  renderLane(el.builderLane, lanes.builder, 'Builder actions will appear here.');
  renderLane(el.reviewerLane, lanes.reviewer, 'Reviewer checks will appear here.');
  renderCheckpoints(workflow ? workflow.checkpoints : []);
}

function renderReadiness(readiness) {
  if (!el.readinessBadge || !el.readinessSummary || !el.readinessChecklist) return;

  const badge = el.readinessBadge;
  const summary = el.readinessSummary;
  const list = el.readinessChecklist;
  list.innerHTML = '';

  if (!readiness || typeof readiness !== 'object') {
    badge.textContent = 'Unknown';
    badge.className = 'readiness-badge unknown';
    summary.textContent = 'Start a task to see readiness checks.';
    const item = document.createElement('li');
    item.className = 'readiness-item neutral';
    item.textContent = 'No readiness checks yet.';
    list.appendChild(item);
    return;
  }

  const ready = readiness.ready === true;
  badge.textContent = ready ? 'Ready' : 'Needs work';
  badge.className = `readiness-badge ${ready ? 'ready' : 'blocked'}`;
  summary.textContent = readiness.summary || (ready ? 'Ready for completion.' : 'Still missing key checks.');

  const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
  if (checks.length === 0) {
    const item = document.createElement('li');
    item.className = 'readiness-item neutral';
    item.textContent = 'No checklist details were returned.';
    list.appendChild(item);
    return;
  }

  checks.forEach((check) => {
    const item = document.createElement('li');
    const passed = Boolean(check.passed);
    item.className = `readiness-item ${passed ? 'pass' : 'fail'}`;
    const icon = passed ? '✓' : '•';
    const label = check.label || check.id || 'Check';
    const detail = check.detail ? ` — ${check.detail}` : '';
    item.textContent = `${icon} ${label}${detail}`;
    list.appendChild(item);
  });
}

function renderActiveMemoryPanel(runSummary) {
  if (!el.memoryConstraintBadge || !el.memoryConstraintSummary || !el.memoryConstraintList) return;

  const badge = el.memoryConstraintBadge;
  const summary = el.memoryConstraintSummary;
  const list = el.memoryConstraintList;
  list.innerHTML = '';

  const strategies = Array.isArray(runSummary?.activeLearnedStrategies) ? runSummary.activeLearnedStrategies : [];
  const bans = Array.isArray(runSummary?.activeBannedApproaches) ? runSummary.activeBannedApproaches : [];
  const lastConstraint = runSummary?.lastPlanConstraint && typeof runSummary.lastPlanConstraint === 'object'
    ? runSummary.lastPlanConstraint
    : null;

  if (strategies.length === 0 && bans.length === 0 && !lastConstraint) {
    badge.textContent = 'Idle';
    badge.className = 'readiness-badge unknown';
    summary.textContent = 'No active learned constraints yet.';
    const item = document.createElement('li');
    item.className = 'readiness-item neutral';
    item.textContent = 'Run a task to see active strategies and banned approaches.';
    list.appendChild(item);
    return;
  }

  badge.textContent = lastConstraint ? 'Constraining' : 'Active';
  badge.className = `readiness-badge ${lastConstraint ? 'blocked' : 'ready'}`;
  summary.textContent = lastConstraint?.summary
    || `${strategies.length} learned strategy note(s) and ${bans.length} cross-run ban(s) are shaping this run.`;

  strategies.slice(0, 4).forEach((entry) => {
    const item = document.createElement('li');
    item.className = 'readiness-item pass';
    item.textContent = `✓ Strategy: ${entry}`;
    list.appendChild(item);
  });

  bans.slice(0, 4).forEach((entry) => {
    const item = document.createElement('li');
    item.className = 'readiness-item fail';
    const detail = entry && typeof entry === 'object'
      ? `${entry.tool || 'tool'} (${Number(entry.count || 0)}x): ${entry.error || entry.signature || ''}`
      : String(entry || '');
    item.textContent = `• Ban: ${detail}`;
    list.appendChild(item);
  });

  if (lastConstraint) {
    const item = document.createElement('li');
    item.className = 'readiness-item fail';
    item.textContent = `• Plan adjustment: ${lastConstraint.summary}${lastConstraint.detail ? ` — ${lastConstraint.detail}` : ''}`;
    list.appendChild(item);
  }
}

function formatPlan(plan) {
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const lines = [
    `Plan: ${plan.summary || 'Agent execution plan'}`,
    '',
    'Actions:',
  ];

  if (actions.length === 0) {
    lines.push('- (none)');
  } else {
    actions.forEach((action, index) => {
      lines.push(
        `${index + 1}. [${action.effective_risk || action.risk_level || 'unknown'}] ${action.tool} - ${action.intent}`,
      );
      if (action.policy_reason) {
        lines.push(`   Policy: ${action.policy_reason}`);
      }
      if (action.expected_diff) {
        lines.push(`   Expected: ${action.expected_diff}`);
      }
      if (action.rollback_plan) {
        lines.push(`   Rollback: ${action.rollback_plan}`);
      }
    });
  }

  return lines.join('\n');
}

function formatExecutionResult(result) {
  const lines = [
    `Agent status: ${result.state || 'completed'}`,
    `Workspace: ${result.workspaceRoot || '(unknown)'}`,
    '',
    'Execution log:',
  ];

  const actions = Array.isArray(result.results) ? result.results : [];
  if (actions.length === 0) {
    lines.push('- No actions executed.');
  } else {
    actions.forEach((action) => {
      lines.push(
        `${action.index}. ${action.ok ? 'OK' : 'FAILED'} [${action.risk_level}] ${action.tool} - ${action.intent}`,
      );
      if (action.summary) {
        lines.push(`   ${action.summary}`);
      }
      if (action.output) {
        lines.push(`   Output:\n${action.output}`);
      }
    });
  }

  lines.push('');
  lines.push('Report:');
  lines.push(result.report || 'No report generated.');

  return lines.join('\n');
}

function formatObjectiveRunResult(result) {
  const status = String(result.state || 'unknown');
  const results = Array.isArray(result.results) ? result.results : [];

  const lines = [];

  // Lead with the summary/report — the human-readable part (now markdown-formatted)
  if (result.report) {
    // Add a short conversational opener so it reads like a personal assistant reporting back
    const opener = status === 'completed'
      ? 'Done! Here\'s what I did:'
      : 'Here\'s where things stand:';
    lines.push(opener);
    lines.push('');
    lines.push(result.report);
  } else if (status === 'completed') {
    lines.push(result.reason || 'All done.');
  } else {
    lines.push(result.reason || 'Still working on it.');
  }

  // If there were issues and not completed, mention them
  const failedCount = results.filter((item) => item && !item.ok).length;
  if (failedCount > 0 && status !== 'completed') {
    lines.push(`\n${failedCount} step${failedCount === 1 ? '' : 's'} hit issues — check the activity log for details.`);
  }

  // Stats footer
  const okCount = results.filter((item) => item && item.ok).length;
  const iterCount = (result.iterations || []).length;
  if (iterCount > 0 || okCount > 0) {
    lines.push('');
    lines.push(`---\n*${iterCount} iteration${iterCount === 1 ? '' : 's'}, ${okCount} action${okCount === 1 ? '' : 's'} completed${failedCount > 0 ? `, ${failedCount} failed` : ''}*`);
  }

  return lines.join('\n');
}
