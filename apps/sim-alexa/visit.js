/**
 * The visitor's page: draws what visit-state.js decides, and makes the two
 * requests it needs — how the pass stands, on load; and a press. Nothing
 * else leaves the page, and nothing is kept in the browser: the token lives
 * in the address's `#` and goes, in a request's body, to the edge API only.
 */
import { icon } from './vendor/icons.generated.js';
import { edgeFrom, firstModel, nextModel, presentVisit, tokenFromHash, visitRequest } from './visit-state.js';

const $ = (id) => document.getElementById(id);
const token = tokenFromHash(location.hash);
const edge = edgeFrom(document.querySelector('meta[name="wick-edge-api"]')?.getAttribute('content'));

const card = $('visit-card');
const buttons = [...document.querySelectorAll('.visit-button')];
for (const button of buttons) {
  button.querySelector('.visit-button-icon').replaceChildren(icon(button.dataset.icon));
  button.querySelector('.visit-button-mark').replaceChildren(icon('circle-check', { label: 'Said last' }));
}

let model = firstModel(token);

function draw() {
  const shown = presentVisit(model);
  $('visit-heading').textContent = shown.heading;
  $('visit-lead').textContent = shown.lead;
  card.setAttribute('aria-busy', String(shown.busy));
  card.dataset.phase = model.phase;

  $('visit-buttons').hidden = shown.buttons.length === 0;
  for (const view of shown.buttons) {
    const button = buttons.find((b) => b.dataset.says === view.says);
    button.querySelector('.visit-button-label').textContent = view.label;
    button.querySelector('.visit-button-hint').textContent = view.hint;
    button.disabled = view.disabled;
    button.dataset.last = String(view.last);
    if (view.working) button.dataset.working = 'true';
    else delete button.dataset.working;
  }

  const result = $('visit-result');
  result.hidden = shown.result === null;
  if (shown.result) {
    result.dataset.tone = shown.result.tone;
    $('visit-result-icon').replaceChildren(icon(shown.result.tone === 'problem' ? 'circle-alert' : 'circle-check'));
    $('visit-result-head').textContent = shown.result.thanks ?? shown.result.problem ?? '';
    $('visit-result-last').textContent = shown.result.last ?? '';
  }

  const retry = $('visit-retry');
  retry.hidden = shown.retry === null;
  if (shown.retry) retry.textContent = shown.retry.label;
}

/** One request to the edge, and its answer folded into the page's state. */
async function ask(says) {
  if (!edge) {
    model = nextModel(model, { type: 'failed' });
    return draw();
  }
  const { url, init } = visitRequest(edge, token, says);
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    model = nextModel(model, { type: 'answer', status: res.status, body });
  } catch {
    model = nextModel(model, { type: 'failed' });
  }
  draw();
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    const before = model;
    model = nextModel(model, { type: 'press', says: button.dataset.says });
    if (model === before) return;
    draw();
    void ask(button.dataset.says);
  });
}

$('visit-retry').addEventListener('click', () => {
  model = nextModel(model, { type: 'retry' });
  draw();
  void ask();
});

// The link may be opened in one tab and its address changed to another
// visit's in the same tab: start again from the new one.
window.addEventListener('hashchange', () => location.reload());

draw();
if (model.phase === 'loading') void ask();
