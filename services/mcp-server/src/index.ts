/** Local dev entrypoint. `alexa-ai deploy` targets a real host later (§7.3); this is `cloudflared`'s local target until then. */
import { createApp } from './server.js';

const PORT = Number(process.env.PORT ?? 3300);
const ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${PORT}`);

createApp(ISSUER_URL).listen(PORT, () => {
  console.log(`Wick MCP server listening on ${ISSUER_URL.toString()}`);
  console.log('MCP endpoint: POST /mcp');
  console.log('Tunnel for Alexa+/MCP Inspector: cloudflared tunnel --url http://127.0.0.1:' + PORT);
});
