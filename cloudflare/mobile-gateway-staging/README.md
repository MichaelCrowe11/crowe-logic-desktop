# Crowe mobile gateway staging

This Worker adapts the published mobile app's existing API contract without changing the production API route.

## Deployment

- Worker: `crowe-mobile-gateway-staging`
- Staging URL: `https://crowe-mobile-gateway-staging.yellow-block-3adc.workers.dev`
- Upstream: Cloudflare service binding `MODELS_EDGE` -> `crowe-models-edge`
- Production API route: unchanged (`api.crowelogic.com` remains on its current Worker)

## App contract

- `GET /api/gateway/catalog` returns `{ "models": [...] }`.
- `POST /api/gateway/chat` accepts the mobile bridge's OpenAI-style `model/messages/tools/stream` request.
- Non-streaming OpenAI chat completions are mapped to top-level `content`, `tool_calls`, `model`, and `usage`.
- SSE responses are passed through unchanged.
- Crowe ID bearer tokens are forwarded to `crowe-models-edge`, where signature, issuer, expiry, tier and model-plan checks remain authoritative.
- The adapter does not store or log bearer tokens.

## Validation still required

Cloudflare accepted and deployed the Worker, and the version metadata confirms the service binding. The connector's outbound network policy returned HTTP 403 when attempting to call the `workers.dev` URL, so external runtime checks and authenticated inference could not be completed from this environment.

Before production cutover, validate from a network that can reach the staging URL:
1. `GET /health` returns `ok: true`.
2. `GET /health/upstream` reaches the model Worker and returns its health response.
3. `GET /api/gateway/catalog` returns the 16 model entries and expected role/plan metadata.
4. No bearer token on `POST /api/gateway/chat` returns HTTP 401.
5. A valid Crowe ID token can complete a non-streaming chat, streaming chat, tool-call round trip, and image prompt.
6. A token without the required tier receives the upstream plan denial; invalid/expired tokens receive HTTP 401.
7. Confirm usage/credits are accounted for by the existing model Worker.

Voice is not restored by this adapter: the existing model Worker still returns HTTP 503 for `/v1/voice/session`.

Do not move the production `api.crowelogic.com/*` route until these checks pass and rollback is prepared.
