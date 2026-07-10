/**
 * renderer-memory.js — Memory search & knowledge management UI.
 *
 * Depends on: renderer-state.js (el), renderer-utils.js (setStatus, escapeHtml)
 */

// --- Extend el with memory DOM refs ---
el.memorySearchInput = document.getElementById('memorySearchInput');
el.memorySearchButton = document.getElementById('memorySearchButton');
el.memorySearchResults = document.getElementById('memorySearchResults');
el.memoryAddInput = document.getElementById('memoryAddInput');
el.memoryAddButton = document.getElementById('memoryAddButton');
el.memoryStatsText = document.getElementById('memoryStatsText');
el.memoryRefreshStatsButton = document.getElementById('memoryRefreshStatsButton');

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function performMemorySearch() {
  const query = el.memorySearchInput.value.trim();
  if (!query) {
    setStatus('Enter a search query.');
    return;
  }

  el.memorySearchResults.innerHTML = '<p class="sched-empty">Searching...</p>';

  try {
    const hits = await window.geepus.searchMemory(query, { topK: 10 });

    if (!hits || hits.length === 0) {
      el.memorySearchResults.innerHTML =
        '<p class="sched-empty">No relevant memories found.</p>';
      return;
    }

    el.memorySearchResults.innerHTML = '';
    for (const hit of hits) {
      const card = document.createElement('div');
      card.className = 'memory-hit';

      const meta = document.createElement('div');
      meta.className = 'memory-hit-meta';
      const type = hit.metadata?.type || 'unknown';
      const sim = hit.similarity ? `${Math.round(hit.similarity * 100)}%` : '';
      const ns = hit.namespace || '';
      meta.textContent = [type, sim, ns].filter(Boolean).join(' · ');

      const text = document.createElement('p');
      text.className = 'memory-hit-text';
      text.textContent = hit.text.length > 300
        ? `${hit.text.slice(0, 297)}...`
        : hit.text;

      card.appendChild(meta);
      card.appendChild(text);
      el.memorySearchResults.appendChild(card);
    }
  } catch (error) {
    el.memorySearchResults.innerHTML = '';
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Add knowledge
// ---------------------------------------------------------------------------

async function addKnowledge() {
  const text = el.memoryAddInput.value.trim();
  if (!text) {
    setStatus('Enter some text to index.');
    return;
  }

  try {
    setStatus('Indexing into memory...');
    await window.geepus.indexMemory(text, 'global', {
      type: 'user_knowledge',
      addedAt: new Date().toISOString(),
    });
    el.memoryAddInput.value = '';
    setStatus('Knowledge indexed into memory.');
    await refreshMemoryStats();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function refreshMemoryStats() {
  try {
    const stats = await window.geepus.getMemoryStats();
    const nsLines = (stats.namespaces || [])
      .map((ns) => `${ns.namespace}: ${ns.count} vectors`)
      .join(', ');
    el.memoryStatsText.textContent = stats.totalVectors > 0
      ? `${stats.totalVectors} total vectors — ${nsLines}`
      : 'No vectors indexed yet. Memories are indexed automatically after each run.';
  } catch {
    el.memoryStatsText.textContent = 'Unable to load stats.';
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function installMemoryEvents() {
  el.memorySearchButton.addEventListener('click', () => {
    performMemorySearch().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  el.memorySearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      performMemorySearch().catch((error) => {
        setStatus(error.message || String(error));
      });
    }
  });

  el.memoryAddButton.addEventListener('click', () => {
    addKnowledge().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  el.memoryRefreshStatsButton.addEventListener('click', () => {
    refreshMemoryStats().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
}
