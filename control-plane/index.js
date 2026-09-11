// Wiring. Reads the environment, builds the pieces, listens.
//
// Everything above this file is a pure function of its arguments, which is what
// makes the whole surface testable without a socket or a database. This is the
// only module that knows what an environment variable is.

const { makeService } = require("./service");
const { makeMemoryStore } = require("./store-memory");
const { makeAuth, makeJwks, sha256 } = require("./auth");
const { makeApp } = require("./http");
const { makeMarketplace, makeTokenSource } = require("./marketplace");
const { emitPending } = require("./emitter");

const env = process.env;
const bool = (v, dflt = false) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

// API keys arrive as "tenant:key,tenant:key" and are stored as digests, so the
// running process never holds a usable credential in a readable form and a heap
// dump is not a key dump.
function parseApiKeys(raw) {
  const out = {};
  for (const pair of String(raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    out[sha256(pair.slice(i + 1))] = pair.slice(0, i);
  }
  return out;
}

function parsePlans(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function buildStore() {
  const url = env.DATABASE_URL;
  if (!url) return makeMemoryStore();
  const { makePostgresStore } = require("./store-postgres");
  const store = makePostgresStore({
    connectionString: url,
    // Verified TLS everywhere except an explicit local opt-out. Azure's
    // Postgres requires TLS and an unverified connection to a managed database
    // is a connection to whatever answered.
    ssl: bool(env.DATABASE_INSECURE) ? false : { rejectUnauthorized: true },
  });
  if (bool(env.MIGRATE_ON_BOOT, true)) await store.migrate();
  return store;
}

function buildMarketplace() {
  const { MARKETPLACE_TENANT_ID, MARKETPLACE_CLIENT_ID, MARKETPLACE_CLIENT_SECRET } = env;
  if (!MARKETPLACE_TENANT_ID || !MARKETPLACE_CLIENT_ID || !MARKETPLACE_CLIENT_SECRET) return null;
  return makeMarketplace({
    tokenSource: makeTokenSource({
      tenantId: MARKETPLACE_TENANT_ID,
      clientId: MARKETPLACE_CLIENT_ID,
      clientSecret: MARKETPLACE_CLIENT_SECRET,
    }),
  });
}

async function build() {
  const store = await buildStore();
  const service = makeService({ store });

  const issuer = env.ENTRA_ISSUER || "";
  const auth = makeAuth({
    store,
    apiKeys: parseApiKeys(env.API_KEYS),
    issuer,
    audience: env.ENTRA_AUDIENCE || "",
    jwks: env.ENTRA_JWKS_URI ? makeJwks({ url: env.ENTRA_JWKS_URI }) : null,
    // Anonymous access is a local convenience and refusing it in the cloud is
    // not a preference. A public plane that trusts a missing header bills a
    // tenant called "local" for everyone.
    allowAnonymous: bool(env.ALLOW_ANONYMOUS) && store.kind === "memory",
  });

  const marketplace = buildMarketplace();
  const log = bool(env.QUIET) ? () => {} : (evt, data) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), evt, ...data }));

  const app = makeApp({
    service, auth, marketplace,
    webhookSecret: env.WEBHOOK_SECRET || "",
    plans: parsePlans(env.PLANS),
    log,
  });

  return { store, service, auth, marketplace, app, log };
}

async function main() {
  // The scheduled job and the service are the same image with different
  // arguments, so the code that decides what a row costs cannot drift from the
  // code that wrote it.
  if (process.argv.includes("--emit")) {
    const { store, marketplace, log } = await build();
    if (!marketplace) { console.error("no marketplace credentials configured"); process.exit(2); }
    const result = await emitPending({ store, marketplace, dimension: env.METER_DIMENSION || "usd_cents", log });
    await store.close();
    process.exit(result.failed.length ? 1 : 0);
  }

  const { store, app, log } = await build();
  const port = Number(env.PORT) || 8080;
  const server = app.createServer();
  server.listen(port, () => log("listen", { port, store: store.kind }));

  // Container Apps sends SIGTERM and then waits. Closing the listener first
  // lets in-flight requests finish; a usage POST cut off mid-write is a row the
  // client will resend, but finishing it is free and resending is not.
  const shutdown = async (signal) => {
    log("shutdown", { signal });
    server.close(async () => { await store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { build, buildStore, parseApiKeys, parsePlans };
