/**
 * renderer-local-models.js — UI for browsing, downloading, and managing
 * local AI models via Ollama.  Designed for non-technical users.
 *
 * Depends on: renderer-state.js (state, el)
 *             renderer-utils.js  (setStatus)
 *             renderer-settings.js (renderModels, saveSettingsPatch, refreshModels)
 */

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let _ollamaState = {
  installed: false,
  running: false,
  catalog: [],
  pulling: null, // modelId currently downloading
};

/* ------------------------------------------------------------------ */
/*  Render                                                             */
/* ------------------------------------------------------------------ */

function renderLocalModelsPanel() {
  if (!el.localModelsPanel) return;

  const isOllama = state.provider === 'ollama';
  el.localModelsPanel.hidden = !isOllama;
  if (!isOllama) return;

  // Status pill
  if (!_ollamaState.installed) {
    setOllamaPill('Not installed', false);
    el.ollamaHint.textContent = 'Ollama needs to be installed first (it\'s free and takes under a minute).';
    el.ollamaInstallPrompt.hidden = false;
    el.localModelCatalog.innerHTML = '';
    return;
  }

  el.ollamaInstallPrompt.hidden = true;

  if (!_ollamaState.running) {
    setOllamaPill('Starting…', false);
    el.ollamaHint.textContent = 'Starting Ollama on your machine…';
    el.localModelCatalog.innerHTML = '';
    return;
  }

  setOllamaPill('Running', true);
  el.ollamaHint.textContent = 'Pick a model below and Geepus will download it for you.';

  renderModelCards();
}

function setOllamaPill(text, ready) {
  if (!el.ollamaStatusPill) return;
  el.ollamaStatusPill.textContent = text;
  el.ollamaStatusPill.classList.remove('ready', 'pending');
  el.ollamaStatusPill.classList.add(ready ? 'ready' : 'pending');
}

function renderModelCards() {
  const container = el.localModelCatalog;
  if (!container) return;
  container.innerHTML = '';

  const catalog = _ollamaState.catalog || [];
  if (catalog.length === 0) {
    container.innerHTML = '<p class="hint">No models in catalog.</p>';
    return;
  }

  for (const model of catalog) {
    const card = document.createElement('div');
    card.className = 'local-model-card';
    if (model.downloaded) card.classList.add('downloaded');
    if (model.id === state.model) card.classList.add('active-model');

    const isPulling = _ollamaState.pulling === model.id;

    // Tag badges
    let tagHtml = '';
    if (model.tags && model.tags.length > 0) {
      tagHtml = model.tags
        .map((t) => `<span class="model-tag tag-${t}">${t}</span>`)
        .join(' ');
    }

    const incompatibilityNote = model.incompatible
      ? `<p class="hint">${escapeHtml(model.compatibilityNote || 'This model needs more RAM than this Mac currently has.')}</p>`
      : '';

    card.innerHTML = `
      <div class="model-card-header">
        <div class="model-card-title">
          <strong>${escapeHtml(model.name)}</strong>
          <span class="model-card-size">${escapeHtml(model.size)} · ${escapeHtml(model.downloadSize)}</span>
        </div>
        <div class="model-card-tags">${tagHtml}</div>
      </div>
      <p class="model-card-desc">${escapeHtml(model.description)}</p>
      ${incompatibilityNote}
      <div class="model-card-actions">
        ${model.downloaded
          ? `<button class="btn btn-small model-use-btn" data-model="${escapeHtml(model.id)}" ${model.incompatible ? 'disabled' : ''}>${model.id === state.model ? '✓ Active' : 'Use this model'}</button>
             <button class="btn btn-small model-delete-btn" data-model="${escapeHtml(model.id)}">Remove</button>`
          : isPulling
            ? `<div class="model-progress-wrap">
                 <div class="model-progress-bar"><div class="model-progress-fill" id="progress-${cssId(model.id)}"></div></div>
                 <span class="model-progress-text" id="progress-text-${cssId(model.id)}">Starting download…</span>
               </div>`
            : `<button class="btn btn-small model-download-btn" data-model="${escapeHtml(model.id)}" ${model.incompatible ? 'disabled' : ''}>${model.incompatible ? 'Needs more RAM' : 'Download'}</button>`
        }
      </div>
    `;

    container.appendChild(card);
  }

  // Wire button events
  container.querySelectorAll('.model-download-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleDownloadModel(btn.dataset.model));
  });
  container.querySelectorAll('.model-use-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleUseModel(btn.dataset.model));
  });
  container.querySelectorAll('.model-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleDeleteModel(btn.dataset.model));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function cssId(modelId) {
  return (modelId || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

async function handleDownloadModel(modelId) {
  const entry = _ollamaState.catalog.find((m) => m.id === modelId);
  if (entry && entry.incompatible) {
    setStatus(entry.compatibilityNote || 'This model requires more RAM than is currently available.');
    return;
  }

  if (_ollamaState.pulling) {
    setStatus('A model is already downloading. Please wait for it to finish.');
    return;
  }

  _ollamaState.pulling = modelId;
  renderModelCards();
  setStatus(`Downloading ${modelId}… This may take a few minutes.`);

  try {
    await window.geepus.ollamaPull(modelId, (progress) => {
      updatePullProgress(modelId, progress);
    });

    // Mark as downloaded in local state
    const entry = _ollamaState.catalog.find((m) => m.id === modelId);
    if (entry) entry.downloaded = true;

    _ollamaState.pulling = null;
    renderModelCards();
    setStatus(`${modelId} downloaded successfully! Click "Use this model" to start using it.`);

    // Auto-select it
    await handleUseModel(modelId);
  } catch (error) {
    _ollamaState.pulling = null;
    renderModelCards();
    setStatus(`Download failed: ${error.message || error}`);
  }
}

function updatePullProgress(modelId, progress) {
  const fillEl = document.getElementById(`progress-${cssId(modelId)}`);
  const textEl = document.getElementById(`progress-text-${cssId(modelId)}`);
  if (!fillEl || !textEl) return;

  if (progress.percent > 0) {
    fillEl.style.width = `${progress.percent}%`;
    textEl.textContent = `${progress.status || 'Downloading'}… ${progress.percent}%`;
  } else {
    textEl.textContent = progress.status || 'Preparing…';
  }
}

async function handleUseModel(modelId) {
  const entry = _ollamaState.catalog.find((m) => m.id === modelId);
  if (entry && entry.incompatible) {
    setStatus(entry.compatibilityNote || 'This model requires more RAM than is currently available.');
    return;
  }

  try {
    // Save ollama as provider with this model
    await saveSettingsPatch({
      provider: 'ollama',
      model: modelId,
      baseUrl: 'http://localhost:11434/v1',
    });
    state.model = modelId;

    // Set the model selector to this model
    syncModelSelectors(modelId);

    // Re-render cards so the active card is highlighted
    renderModelCards();

    // Flash the status with a clear confirmation
    setStatus(`✅ Now using ${modelId} — running locally, no API costs!`);

    // Focus the prompt so the user can start typing immediately
    hardFocusPrompt();
  } catch (error) {
    setStatus(`Could not switch model: ${error.message || error}`);
  }
}

async function handleDeleteModel(modelId) {
  if (_ollamaState.pulling === modelId) {
    setStatus('Can\'t remove a model that is downloading.');
    return;
  }

  setStatus(`Removing ${modelId}…`);
  try {
    await window.geepus.ollamaDelete(modelId);
    const entry = _ollamaState.catalog.find((m) => m.id === modelId);
    if (entry) entry.downloaded = false;
    renderModelCards();
    setStatus(`${modelId} removed.`);
  } catch (error) {
    setStatus(`Could not remove: ${error.message || error}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Initialization                                                     */
/* ------------------------------------------------------------------ */

/**
 * Called on startup and whenever the provider changes to Ollama.
 * Checks Ollama status, auto-starts it, and populates the catalog.
 */
async function refreshOllamaStatus() {
  if (state.provider !== 'ollama') {
    if (el.localModelsPanel) el.localModelsPanel.hidden = true;
    return;
  }

  try {
    const status = await window.geepus.ollamaStatus();
    _ollamaState.installed = status.installed;
    _ollamaState.running = status.running;
    _ollamaState.catalog = status.catalog || [];

    renderLocalModelsPanel();

    // Auto-start if installed but not running
    if (status.installed && !status.running) {
      setStatus('Starting Ollama on your machine…');
      try {
        await window.geepus.ollamaStart();
        _ollamaState.running = true;

        // Re-fetch to get updated model list
        const updated = await window.geepus.ollamaStatus();
        _ollamaState.catalog = updated.catalog || [];
        renderLocalModelsPanel();
        setStatus('Ollama is running. Pick a model below to get started!');
      } catch (err) {
        setStatus(err.message || 'Could not start Ollama.');
        renderLocalModelsPanel();
      }
    } else if (status.installed && status.running) {
      // Check if any models are already downloaded
      const downloaded = _ollamaState.catalog.filter((m) => m.downloaded);
      if (downloaded.length > 0) {
        // Only auto-pick a model if the user hasn't selected one at all.
        // Never override an explicit user selection — respect their choice.
        if (!state.model) {
          const pick = downloaded[0].id;
          await saveSettingsPatch({
            provider: 'ollama',
            model: pick,
            baseUrl: 'http://localhost:11434/v1',
          });
          state.model = pick;
          syncModelSelectors(pick);
        }

        renderModelCards();
        setStatus(`Ollama is running with ${downloaded.length} model${downloaded.length > 1 ? 's' : ''} ready.`);
      } else {
        setStatus('Ollama is running. Download a model below to get started!');
      }
    }
  } catch (error) {
    _ollamaState.installed = false;
    _ollamaState.running = false;
    renderLocalModelsPanel();
    setStatus('Could not check Ollama status.');
  }
}

function installLocalModelEvents() {
  // Install button — opens Ollama download page
  if (el.ollamaInstallButton) {
    el.ollamaInstallButton.addEventListener('click', () => {
      // Open the download URL in the default browser
      window.open('https://ollama.com/download', '_blank');
      setStatus('Download Ollama from the page that just opened, install it, then come back and click "I\'ve installed it — Recheck".');
    });
  }

  // Recheck button — re-run Ollama detection after user installs it
  const recheckBtn = document.getElementById('ollamaRecheckButton');
  if (recheckBtn) {
    recheckBtn.addEventListener('click', async () => {
      setStatus('Checking for Ollama…');
      await refreshOllamaStatus();
    });
  }
}
