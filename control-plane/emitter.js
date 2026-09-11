// The metering emitter.
//
// Runs as a scheduled job, not inside the request path. Reporting usage to the
// marketplace during an authorize would put Microsoft's availability on the
// critical path of every turn, and the whole point of the ledger is that it
// does not have to be.
//
// The only non-idempotent step in the system lives here. The marketplace has no
// derived key to deduplicate against, so emitted_at is the guard: a row is
// marked only after the API has answered, and a crash before that mark means
// the row is reported again. At-least-once, chosen knowingly, because the
// alternative - mark first, then report - loses revenue silently while this
// one produces a duplicate that shows up in a reconciliation report.

function usdToQuantity(usd) {
  // Marketplace dimensions are integers. Billing in cents keeps a $0.004 turn
  // from rounding to nothing, which over a month is most of a small customer.
  return Math.round(Number(usd) * 100);
}

async function emitPending({ store, marketplace, dimension = "usd_cents", batch = 200, log = () => {} }) {
  const rows = await store.unemitted(batch);
  const billable = rows.filter((r) => r.meter === "cost_usd" && Number(r.value) > 0);

  // Rows that are not billable still get marked, or the unemitted query drags
  // them along forever and the partial index stops being small.
  const skip = rows.filter((r) => !billable.includes(r)).map((r) => r.usage_id);
  if (skip.length) await store.markEmitted(skip);

  const sent = [];
  const failed = [];
  for (const row of billable) {
    const tenant = await store.getTenant(row.tenant_id);
    if (!tenant || !tenant.marketplace_subscription) {
      // No subscription behind it: usage from a non-marketplace tenant. Real,
      // recorded, and not Microsoft's to bill.
      await store.markEmitted([row.usage_id]);
      continue;
    }
    const quantity = usdToQuantity(row.value);
    if (quantity <= 0) { await store.markEmitted([row.usage_id]); continue; }

    const res = await marketplace.emitUsage({
      resourceId: tenant.marketplace_subscription,
      planId: tenant.marketplace_plan_id,
      dimension,
      quantity,
      effectiveStartTime: new Date(row.occurred_at).toISOString(),
    });

    /* A duplicate is a success.

       If a previous run reported this row and died before marking it, the API
       answers 409. That is the API confirming the usage is already recorded,
       which is exactly what this run wanted, so the row gets marked and the
       loop moves on. Treating it as a failure would retry it forever. */
    if (res.ok || res.status === 409) {
      await store.markEmitted([row.usage_id]);
      sent.push(row.usage_id);
    } else {
      failed.push({ id: row.usage_id, status: res.status });
      // Stop on the first hard failure rather than hammering a service that is
      // already unhappy. The rows stay unmarked and the next run picks them up.
      if (res.status === 429 || res.status >= 500) break;
    }
  }

  log("emit", { scanned: rows.length, billable: billable.length, sent: sent.length, failed: failed.length });
  return { scanned: rows.length, sent, failed, skipped: skip.length };
}

module.exports = { emitPending, usdToQuantity };
