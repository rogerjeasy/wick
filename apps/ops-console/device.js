/**
 * Virtual device — the engineers' console around the browser television.
 *
 * The television itself is tv-core.js, loaded before this file: pairing,
 * the card channel, every card and its buttons, the mantelpiece, reading a
 * card aloud, the film, and a family member's own television. This file is
 * only what the console puts around it — the connection badge, the "Pair &
 * connect" and "Disconnect" buttons, the telemetry buttons that send the
 * same `DeviceEvent`s a real Fire TV app would, and the raw messages — and
 * the one key the console's television has: P is Play.
 *
 * Replaces docs/SIMULATOR-TESTING-GUIDE.md §3's curl + wscat sequence with
 * clicks. The television on its own, with nothing of the console around it
 * and the keyboard as its remote, is tv.html.
 */
const pairBtn = document.getElementById('pair-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const connBadge = document.getElementById('conn-badge');
const connDetail = document.getElementById('conn-detail');
const logEl = document.getElementById('log');
const telemetryButtons = ['fg-btn', 'bg-btn', 'play-btn', 'pause-btn', 'reach-btn'].map((id) => document.getElementById(id));
const MAX_LOG_LINES = 200;

useTvPage({
  badge(state) {
    connBadge.className = `badge ${state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : 'fail'}`;
    connBadge.textContent = state;
  },
  detail(text) {
    connDetail.textContent = text;
  },
  pairDisabled(disabled) {
    pairBtn.disabled = disabled;
  },
  disconnectDisabled(disabled) {
    disconnectBtn.disabled = disabled;
  },
  telemetry(enabled) {
    for (const btn of telemetryButtons) btn.disabled = !enabled;
  },
  log(direction, payload) {
    const line = el('div', 'line', `${direction} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
    logEl.appendChild(line);
    while (logEl.children.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  },
});

/** The keyboard as the resident's remote: P is Play. A family member's own television has its own keys (tv-core.js). */
function residentKey(event) {
  if (family) return;
  if (event.key !== 'p' && event.key !== 'P' && event.key !== 'MediaPlayPause') return;
  if (!currentQueuedCard) return;
  event.preventDefault();
  toggleRead();
}
document.addEventListener('keydown', residentKey);

/* --- Telemetry ------------------------------------------------------- */

document.getElementById('fg-btn').addEventListener('click', () => send({ t: 'app_lifecycle', state: 'fg', at: Date.now() }));
document.getElementById('bg-btn').addEventListener('click', () => send({ t: 'app_lifecycle', state: 'bg', at: Date.now() }));
document.getElementById('play-btn').addEventListener('click', () => send({
  t: 'playback', state: 'PLAYING', positionMs: 0, durationMs: 1_500_000, contentId: 'ops-console-demo', at: Date.now(),
}));
document.getElementById('pause-btn').addEventListener('click', () => send({
  t: 'playback', state: 'PAUSED', positionMs: 60_000, durationMs: 1_500_000, contentId: 'ops-console-demo', at: Date.now(),
}));

// The remote. Holding OK for two seconds, anywhere in Wick, is "Hold for Sarah": the television says only that
// it was held, and is answered with the card that offers to ask someone to ring (tv-vega watch/hold.ts).
document.getElementById('reach-btn').addEventListener('click', () => send({ t: 'reach', at: Date.now() }));

pairBtn.addEventListener('click', pairAndConnect);
disconnectBtn.addEventListener('click', disconnect);

// A reload: back to being the television this tab was.
restoreTelevision();
