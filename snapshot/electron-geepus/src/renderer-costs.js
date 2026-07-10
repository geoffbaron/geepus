/**
 * renderer-costs.js — Cost Dashboard UI for the sidebar.
 *
 * Depends on: renderer-state.js (el)
 *             renderer-utils.js (setStatus)
 */

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCost(usd) {
  if (typeof usd !== 'number' || isNaN(usd)) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function renderCostDashboard() {
  const container = el.costDashboardContent;
  if (!container) return;

  try {
    const [today, summary] = await Promise.all([
      window.geepus.getCostToday(),
      window.geepus.getCostSummary(30),
    ]);

    const todayHtml = `
      <div class="cost-today">
        <h4>Today <span class="cost-date">${today.date}</span></h4>
        <div class="cost-stat-grid">
          <div class="cost-stat">
            <span class="cost-stat-value">${formatCost(today.cost)}</span>
            <span class="cost-stat-label">Cost</span>
          </div>
          <div class="cost-stat">
            <span class="cost-stat-value">${today.calls}</span>
            <span class="cost-stat-label">API Calls</span>
          </div>
          <div class="cost-stat">
            <span class="cost-stat-value">${formatTokens(today.inputTokens)}</span>
            <span class="cost-stat-label">Input Tokens</span>
          </div>
          <div class="cost-stat">
            <span class="cost-stat-value">${formatTokens(today.outputTokens)}</span>
            <span class="cost-stat-label">Output Tokens</span>
          </div>
        </div>
        ${today.liveRuns > 0 ? `<p class="cost-live-badge">${today.liveRuns} active run(s)</p>` : ''}
      </div>
    `;

    const totals = summary.totals;
    const summaryHtml = `
      <div class="cost-summary">
        <h4>Last 30 Days</h4>
        <div class="cost-stat-grid">
          <div class="cost-stat">
            <span class="cost-stat-value">${formatCost(totals.cost)}</span>
            <span class="cost-stat-label">Total Cost</span>
          </div>
          <div class="cost-stat">
            <span class="cost-stat-value">${totals.calls}</span>
            <span class="cost-stat-label">Total Calls</span>
          </div>
          <div class="cost-stat">
            <span class="cost-stat-value">${formatTokens(totals.inputTokens + totals.outputTokens)}</span>
            <span class="cost-stat-label">Total Tokens</span>
          </div>
        </div>
      </div>
    `;

    // Daily breakdown table (only days with data)
    let dailyHtml = '';
    if (summary.days.length > 0) {
      const rows = summary.days
        .slice(0, 14)
        .map((d) => `
          <tr>
            <td>${d.date}</td>
            <td>${formatCost(d.cost)}</td>
            <td>${d.calls}</td>
            <td>${formatTokens(d.inputTokens + d.outputTokens)}</td>
          </tr>
        `)
        .join('');

      dailyHtml = `
        <div class="cost-daily">
          <h4>Daily Breakdown</h4>
          <table class="cost-table">
            <thead>
              <tr><th>Date</th><th>Cost</th><th>Calls</th><th>Tokens</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // Cost bar chart (visual)
    let chartHtml = '';
    if (summary.days.length > 1) {
      const maxCost = Math.max(...summary.days.map((d) => d.cost), 0.001);
      const bars = summary.days
        .slice(0, 14)
        .reverse()
        .map((d) => {
          const pct = Math.max((d.cost / maxCost) * 100, 2);
          const shortDate = d.date.slice(5); // MM-DD
          return `<div class="cost-bar-wrapper" title="${d.date}: ${formatCost(d.cost)}">
            <div class="cost-bar" style="height: ${pct}%"></div>
            <span class="cost-bar-label">${shortDate}</span>
          </div>`;
        })
        .join('');

      chartHtml = `
        <div class="cost-chart">
          <h4>Cost Trend</h4>
          <div class="cost-bar-chart">${bars}</div>
        </div>
      `;
    }

    container.innerHTML = todayHtml + chartHtml + summaryHtml + dailyHtml;
  } catch (error) {
    container.innerHTML = `<p class="hint">Unable to load cost data: ${error.message || error}</p>`;
  }
}

// Called when the cost panel is opened
function initCostDashboard() {
  // Refresh button
  const refreshBtn = el.costRefreshButton;
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderCostDashboard();
    });
  }
}
