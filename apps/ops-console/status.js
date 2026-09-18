/**
 * Fetches GET /status and renders it. The URL below is a placeholder — see
 * infra/ops-console.tf's `replace()` step, the same trick sim-alexa's
 * index.html uses for its default MCP server URL: local dev (open this
 * file directly) sees the placeholder and fails loudly rather than
 * silently; the deployed copy gets the real API URL baked in at upload
 * time.
 *
 * Every dynamic value below comes through document.createElement +
 * .textContent rather than innerHTML — the status API's own content is not
 * attacker-controlled, but building the DOM this way removes the entire
 * class of risk rather than relying on getting escaping right by hand.
 */
const STATUS_API_URL = 'STATUS_API_BASE_URL_PLACEHOLDER/status';
const REFRESH_MS = 15000;

const summaryEl = document.getElementById('summary');
const checksEl = document.getElementById('checks');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshBtn = document.getElementById('refresh-btn');

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(status, text) {
  return el('span', `badge ${status}`, text);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderSummary(summary, generatedAt) {
  clear(summaryEl);

  const headline = el('div', 'headline', summary.healthy ? '✓ Production is healthy' : '✕ Attention needed');
  const counts = el('div', 'summary-counts');
  if (summary.ok) counts.appendChild(badge('ok', `${summary.ok} ok`));
  if (summary.warn) counts.appendChild(badge('warn', `${summary.warn} warn`));
  if (summary.fail) counts.appendChild(badge('fail', `${summary.fail} fail`));

  summaryEl.appendChild(headline);
  summaryEl.appendChild(counts);
  summaryEl.style.borderColor = summary.healthy ? 'var(--ok)' : 'var(--fail)';
  lastUpdatedEl.textContent = `updated ${fmtTime(generatedAt)}`;
}

function renderChecks(checks) {
  clear(checksEl);
  for (const c of checks) {
    const card = el('div', `card status-${c.status}`);
    const header = el('div', 'card-header');
    header.appendChild(el('span', 'card-label', c.label));
    header.appendChild(badge(c.status, c.status));
    card.appendChild(header);
    card.appendChild(el('span', 'card-detail', c.detail));
    checksEl.appendChild(card);
  }
}

function renderError(message) {
  clear(summaryEl);
  summaryEl.appendChild(el('div', 'headline', '✕ Could not reach the status API'));
  summaryEl.style.borderColor = 'var(--fail)';

  clear(checksEl);
  const card = el('div', 'card status-fail');
  card.appendChild(el('span', 'card-detail', message));
  checksEl.appendChild(card);
}

async function load() {
  refreshBtn.disabled = true;
  try {
    const res = await fetch(STATUS_API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSummary(data.summary, data.generatedAt);
    renderChecks(data.checks);
  } catch (err) {
    renderError(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', load);
load();
setInterval(load, REFRESH_MS);
