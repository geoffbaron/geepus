/**
 * renderer-learning.js — Learning & Skills settings panel.
 *
 * Depends on: renderer-state.js (state, el)
 *             renderer-utils.js (setStatus, escapeHtml)
 *             renderer-settings.js (saveSettingsPatch)
 */

function normalizeLearningMemoryAutonomy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sourcesRaw = Array.isArray(src?.memorySearch?.experimental?.sources)
    ? src.memorySearch.experimental.sources
    : ['memory'];
  const sources = Array.from(new Set(
    sourcesRaw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => item === 'memory' || item === 'sessions'),
  ));
  if (sources.length === 0) sources.push('memory');
  return {
    compaction: {
      memoryFlush: {
        enabled: Boolean(src?.compaction?.memoryFlush?.enabled),
      },
    },
    memorySearch: {
      experimental: {
        sessionMemory: Boolean(src?.memorySearch?.experimental?.sessionMemory),
        sources,
      },
    },
    learning: {
      autoSkillReview: src?.learning?.autoSkillReview !== false,
    },
  };
}

function normalizeLearningProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    defaultLocation: String(src.defaultLocation || '').trim(),
    knownLocations: Array.isArray(src.knownLocations) ? src.knownLocations : [],
    learnedStrategies: Array.isArray(src.learnedStrategies) ? src.learnedStrategies : [],
    skillStats: Array.isArray(src.skillStats) ? src.skillStats : [],
  };
}

function learningDirectiveText(memoryAutonomy) {
  const cfg = normalizeLearningMemoryAutonomy(memoryAutonomy);
  const flush = cfg.compaction.memoryFlush.enabled ? 'true' : 'false';
  const sessionMemory = cfg.memorySearch.experimental.sessionMemory ? 'true' : 'false';
  const sourceText = cfg.memorySearch.experimental.sources.length > 0
    ? cfg.memorySearch.experimental.sources.join(' and ')
    : 'memory';
  return [
    `Enable memory flush before compaction by setting compaction.memoryFlush.enabled to ${flush}.`,
    `Set memorySearch.experimental.sessionMemory to ${sessionMemory} with sources including ${sourceText}.`,
    'Apply the config changes.',
  ].join(' ');
}

function linesFromTextarea(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function renderLearningSkillStats(skillStats) {
  if (!el.learningSkillStatsList) return;
  const stats = Array.isArray(skillStats) ? skillStats : [];
  if (stats.length === 0) {
    el.learningSkillStatsList.innerHTML = '<p class="sched-empty">No learned skill stats yet.</p>';
    return;
  }
  const cards = stats
    .slice()
    .sort((left, right) => {
      const a = Number(right.attempts || 0) - Number(left.attempts || 0);
      if (a !== 0) return a;
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
    .slice(0, 20)
    .map((skill) => {
      const attempts = Math.max(0, Number(skill.attempts || 0));
      const successes = Math.max(0, Number(skill.successes || 0));
      const failures = Math.max(0, Number(skill.failures || 0));
      const rate = attempts > 0 ? Math.round((successes / attempts) * 100) : 0;
      const notes = Array.isArray(skill.notes) ? skill.notes : [];
      const noteHtml = notes.length > 0
        ? `<p class="learning-skill-notes">${escapeHtml(notes.slice(-2).join(' | '))}</p>`
        : '';
      return `
        <article class="learning-skill-card">
          <div class="learning-skill-head">
            <strong>${escapeHtml(String(skill.name || 'Unnamed skill'))}</strong>
            <span class="learning-skill-domain">${escapeHtml(String(skill.domain || 'general'))}</span>
          </div>
          <div class="learning-skill-metrics">
            <span>${attempts} attempt(s)</span>
            <span>${successes} success</span>
            <span>${failures} fail</span>
            <span>${rate}% confidence</span>
          </div>
          <div class="learning-confidence-track">
            <div class="learning-confidence-fill" style="width:${Math.max(0, Math.min(100, rate))}%"></div>
          </div>
          ${noteHtml}
        </article>
      `;
    })
    .join('');
  el.learningSkillStatsList.innerHTML = cards;
}

function setLearningControlsFromData(data) {
  const memoryAutonomy = normalizeLearningMemoryAutonomy(data?.memoryAutonomy || {});
  const userProfile = normalizeLearningProfile(data?.userProfile || {});
  const globalNotes = Array.isArray(data?.globalNotes) ? data.globalNotes : [];

  state.memoryAutonomy = memoryAutonomy;
  state.userProfile = userProfile;

  if (el.learningMemoryFlushToggle) {
    el.learningMemoryFlushToggle.checked = memoryAutonomy.compaction.memoryFlush.enabled;
  }
  if (el.learningSessionMemoryToggle) {
    el.learningSessionMemoryToggle.checked = memoryAutonomy.memorySearch.experimental.sessionMemory;
  }
  if (el.learningSourceMemoryToggle) {
    el.learningSourceMemoryToggle.checked = memoryAutonomy.memorySearch.experimental.sources.includes('memory');
  }
  if (el.learningSourceSessionsToggle) {
    el.learningSourceSessionsToggle.checked = memoryAutonomy.memorySearch.experimental.sources.includes('sessions');
  }
  if (el.learningAutoSkillReviewToggle) {
    el.learningAutoSkillReviewToggle.checked = Boolean(memoryAutonomy.learning.autoSkillReview);
  }
  if (el.learningDefaultLocationInput) {
    el.learningDefaultLocationInput.value = userProfile.defaultLocation || '';
  }
  if (el.learningStrategiesInput) {
    el.learningStrategiesInput.value = (userProfile.learnedStrategies || []).join('\n');
  }
  if (el.learningGlobalNotesInput) {
    el.learningGlobalNotesInput.value = globalNotes.join('\n');
  }
  if (el.learningDirectivePreview) {
    el.learningDirectivePreview.value = String(data?.memoryDirective || learningDirectiveText(memoryAutonomy));
  }
  renderLearningSkillStats(userProfile.skillStats || []);
}

function collectLearningPayloadFromControls() {
  const sources = [];
  if (el.learningSourceMemoryToggle && el.learningSourceMemoryToggle.checked) {
    sources.push('memory');
  }
  if (el.learningSourceSessionsToggle && el.learningSourceSessionsToggle.checked) {
    sources.push('sessions');
  }
  if (sources.length === 0) {
    sources.push('memory');
  }
  return {
    memoryAutonomy: {
      compaction: {
        memoryFlush: {
          enabled: Boolean(el.learningMemoryFlushToggle?.checked),
        },
      },
      memorySearch: {
        experimental: {
          sessionMemory: Boolean(el.learningSessionMemoryToggle?.checked),
          sources,
        },
      },
      learning: {
        autoSkillReview: Boolean(el.learningAutoSkillReviewToggle?.checked),
      },
    },
    userProfile: {
      defaultLocation: String(el.learningDefaultLocationInput?.value || '').trim(),
      learnedStrategies: linesFromTextarea(el.learningStrategiesInput?.value || ''),
    },
    globalNotes: linesFromTextarea(el.learningGlobalNotesInput?.value || ''),
  };
}

function refreshLearningDirectivePreview() {
  if (!el.learningDirectivePreview) return;
  const payload = collectLearningPayloadFromControls();
  el.learningDirectivePreview.value = learningDirectiveText(payload.memoryAutonomy);
}

async function refreshLearningPanel() {
  if (!window.geepus || typeof window.geepus.getLearningData !== 'function') {
    return;
  }
  try {
    const data = await window.geepus.getLearningData();
    setLearningControlsFromData(data);
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function applyLearningConfig() {
  if (!window.geepus || typeof window.geepus.saveLearningData !== 'function') {
    setStatus('Learning settings are unavailable in this build.');
    return;
  }
  const payload = collectLearningPayloadFromControls();
  const data = await window.geepus.saveLearningData(payload);
  setLearningControlsFromData(data);
  if (typeof saveSettingsPatch === 'function') {
    await saveSettingsPatch({
      memoryAutonomy: payload.memoryAutonomy,
      userProfile: payload.userProfile,
    });
  }
  setStatus('Learning settings applied.');
}

async function resetLearningSkills() {
  if (!window.geepus || typeof window.geepus.resetLearningData !== 'function') return;
  const data = await window.geepus.resetLearningData('skills');
  setLearningControlsFromData(data);
  setStatus('Skill confidence reset.');
}

async function resetLearningStrategies() {
  if (!window.geepus || typeof window.geepus.resetLearningData !== 'function') return;
  const data = await window.geepus.resetLearningData('strategies');
  setLearningControlsFromData(data);
  setStatus('Learned strategies reset.');
}

function installLearningEvents() {
  if (!el.learningApplyButton) return;

  el.learningApplyButton.addEventListener('click', () => {
    applyLearningConfig().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  if (el.learningRefreshButton) {
    el.learningRefreshButton.addEventListener('click', () => {
      refreshLearningPanel().catch((error) => {
        setStatus(error.message || String(error));
      });
    });
  }

  if (el.learningResetSkillsButton) {
    el.learningResetSkillsButton.addEventListener('click', () => {
      resetLearningSkills().catch((error) => {
        setStatus(error.message || String(error));
      });
    });
  }

  if (el.learningResetStrategiesButton) {
    el.learningResetStrategiesButton.addEventListener('click', () => {
      resetLearningStrategies().catch((error) => {
        setStatus(error.message || String(error));
      });
    });
  }

  const previewInputs = [
    el.learningMemoryFlushToggle,
    el.learningSessionMemoryToggle,
    el.learningSourceMemoryToggle,
    el.learningSourceSessionsToggle,
    el.learningAutoSkillReviewToggle,
  ].filter(Boolean);
  previewInputs.forEach((node) => {
    node.addEventListener('change', refreshLearningDirectivePreview);
  });
}

