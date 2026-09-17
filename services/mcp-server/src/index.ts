/** Local dev entrypoint. `alexa-ai deploy` targets a real host later (§7.3); this is `cloudflared`'s local target until then. */
import { createApp } from './server.js';

// Every read-tool file (get_resident_shared_view.ts, get_today.ts,
// did_visitor_come.ts, get_week_narrative.ts) defaults an unset TABLE_NAME to
// 'wick'. services/agent/src/egress.ts — a different, already-shipped module
// outside this server that send_note_to_tv.ts calls into via sendToDevice()
// — defaults it to '' instead (out of scope to change: it's shared with S1
// device wiring). Left unset, the two would silently disagree about which
// table to hit. Rather than change either module's own fallback, this
// entrypoint fails fast so the inconsistency can never happen at runtime.
if (!process.env.TABLE_NAME) {
  console.error('TABLE_NAME must be set. See .env / scripts/env.ts for local dev.');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3300);
const ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${PORT}`);

createApp(ISSUER_URL).listen(PORT, () => {
  console.log(`Wick MCP server listening on ${ISSUER_URL.toString()}`);
  console.log('MCP endpoint: POST /mcp');
  console.log('Tunnel for Alexa+/MCP Inspector: cloudflared tunnel --url http://127.0.0.1:' + PORT);
});
