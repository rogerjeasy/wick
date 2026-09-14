/**
 * Auth is mandatory for Alexa+ add-ons (verified):
 *   - return 401 with NO WWW-Authenticate header when unauthenticated
 *   - host Protected Resource Metadata at /.well-known/oauth-authorization-server
 *   - advertise code_challenge_methods_supported: ["S256"]
 *   - OAuth 2.1 authorization code + PKCE
 *   - `resource` parameter set to the MCP server's canonical URI
 *   - Bearer token in Authorization on authenticated requests
 */
export {};
