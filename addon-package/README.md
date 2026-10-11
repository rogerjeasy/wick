# The Alexa+ add-on package

`addon.json` is the manifest Amazon's MCP Toolkit takes (`alexa-ai deploy`). It
holds only manifest fields — a deploy sends the whole file — so the notes live
here.

**It has not been deployed and cannot be.** The toolkit, its CLI and the web
simulator are open to select partners only (`FRICTION.md` FL-001), and Amazon
staff confirmed in the week of 2026-10-05 that hackathon participants will not be given
access. What can be checked without Amazon is checked:

```
npm run addon:check                    # the manifest: every field, every limit
npm run addon:check -- --live --demo   # and the files and server it names
```

The first runs in CI as part of `npm test`. The second asks the deployed stack:
each image is the size it claims, the legal pages are live, the server refuses
a stranger with a bare 401, offers PKCE S256, says hello at spec 2025-11-25 and
the way Amazon's docs show the Alexa+ client doing it, lists described tools,
and answers inside 500 ms.

**Who reads it.** The family app (`apps/sim-alexa`) is published with this file
beside it. It draws Wick's listing from it and links an account against the MCP
server it names, so the address is written once. A test holds that address to
`var.mcp_issuer_url` in `infra/variables.tf`.

**The files it points at** are served by GitHub Pages from `docs/`:
`docs/icons/` (six sizes, light and dark theme), `docs/carousel/wick-1.png`
(600×900), `docs/privacy.html` and `docs/terms.html`. The images are drawn by
`python3 scripts/make-brand-assets.py`; sizes and names must not change.
