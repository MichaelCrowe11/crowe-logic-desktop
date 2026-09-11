// Who is calling.
//
// Two credential kinds, because the product has two eras and pretending
// otherwise would mean either shipping without auth or blocking on an identity
// provider before a single customer exists.
//
//   api key  - a token this plane issued. Compared in constant time against a
//              stored SHA-256 digest, so a database leak is not a key leak.
//   bearer   - an Entra-issued JWT. Signature checked against the tenant's
//              published JWKS, then issuer, audience and expiry.
//
// Both resolve to the same thing: a tenant id, or a refusal. Nothing downstream
// knows or cares which one was presented.

const crypto = require("crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Length is not secret, and comparing buffers of different lengths throws, so
// the digests are compared instead of the raw values. Both are fixed width.
function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64url(parts[0]).toString("utf8"));
    const payload = JSON.parse(b64url(parts[1]).toString("utf8"));
    return { header, payload, signature: b64url(parts[2]), signed: `${parts[0]}.${parts[1]}` };
  } catch { return null; }
}

// JWKS with a TTL. Entra rotates signing keys, so a cache that never expires
// eventually rejects every valid token; a cache that never caches makes an
// outbound HTTPS call part of every authorize. Ten minutes is the usual
// compromise and it is short enough that a rotation resolves itself.
function makeJwks({ url, ttlMs = 600000, fetchImpl = globalThis.fetch }) {
  let keys = null;
  let until = 0;
  return async function get(kid) {
    if (!keys || Date.now() > until) {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
      const body = await res.json();
      keys = body.keys || [];
      until = Date.now() + ttlMs;
    }
    return keys.find((k) => k.kid === kid) || null;
  };
}

function makeAuth({
  store,
  apiKeys = {},                 // sha256(key) -> tenant_id
  issuer = "",
  audience = "",
  jwks = null,
  allowAnonymous = false,       // local development only, never in the cloud
  clock = () => Date.now(),
} = {}) {
  async function fromApiKey(token) {
    const tenantId = apiKeys[sha256(token)];
    if (!tenantId) return null;
    // The lookup already matched a digest, but the comparison is repeated in
    // constant time so a wrong key and a right key take the same path.
    const expected = Object.keys(apiKeys).find((d) => constantTimeEqual(d, sha256(token)));
    return expected ? { tenantId, via: "api_key" } : null;
  }

  async function fromJwt(token) {
    if (!jwks) return null;
    const decoded = decodeJwt(token);
    if (!decoded) return null;
    const { header, payload, signature, signed } = decoded;
    if (header.alg !== "RS256") return null;   // no alg confusion, no "none"

    const jwk = await jwks(header.kid);
    if (!jwk) return null;
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const ok = crypto.verify("RSA-SHA256", Buffer.from(signed), key, signature);
    if (!ok) return null;

    // Signature first, claims second. A validly signed token for the wrong
    // audience is still someone else's token.
    const now = Math.floor(clock() / 1000);
    if (payload.exp && now >= payload.exp) return null;
    if (payload.nbf && now < payload.nbf) return null;
    if (issuer && payload.iss !== issuer) return null;
    if (audience && ![].concat(payload.aud || []).includes(audience)) return null;

    const tenantId = payload.tid || payload.tenant_id || payload.oid;
    return tenantId ? { tenantId: String(tenantId), via: "jwt", claims: payload } : null;
  }

  /* Returns an identity or null. Never throws for a bad credential, because a
     malformed token is a 401 and not a 500, and the difference matters to
     whoever is reading the logs at 3am. */
  async function identify(req) {
    const header = req.headers?.authorization || req.headers?.Authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!m) return allowAnonymous ? { tenantId: "local", via: "anonymous" } : null;
    const token = m[1].trim();
    try {
      return (await fromApiKey(token)) || (await fromJwt(token));
    } catch { return null; }
  }

  return { identify, sha256, constantTimeEqual };
}

module.exports = { makeAuth, makeJwks, sha256, constantTimeEqual, decodeJwt };
