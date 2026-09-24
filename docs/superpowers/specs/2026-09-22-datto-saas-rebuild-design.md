# Datto SaaS Protection MCP — correcting the API layer

**Status:** approved 2026-09-22, not yet implemented
**Repo:** `itsimplyltd/datto-saas-protection-mcp` (fork of `WYRE-AI/datto-saas-protection-mcp`, Apache-2.0)

## Why this exists

Every one of the nine tools this server exposes calls a Datto API path that does
not exist. Measured against our live partner account on 2026-09-21: all nine
return 404.

This is not drift from a once-correct spec. The upstream library's own
`CHANGELOG.md` says so:

> "Resource paths (`/clients/{id}/domains`, `/clients/{id}/activity`, etc.) were
> written against the same speculative spec as the auth/base-URL bugs. Only
> `/v1/saas/domains` is confirmed against published docs."

The paths, the auth scheme and the base URL were one act of invention. No Datto
or Kaseya documentation, current or archived, has ever contained a
`/saas/clients` collection.

## The real API

Four routes, one host, no regional split. Confirmed live, and independently
confirmed by an anonymous probe — `api.datto.com` answers **401 for a route that
exists** and **404 for one that does not**, before evaluating auth, so the
surface can be mapped with no credentials at all.

```
GET /v1/saas/domains                        -> SaasDomain[]
GET /v1/saas/{saasCustomerId}/seats         -> SaasSeat[]
GET /v1/saas/{saasCustomerId}/applications  -> SaasBackupReport[]
GET /v1/report/activity-log                 -> ActivityLogPage
```

Plus exactly one write route, which we deliberately do not reach:
`PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange`.

`v1` is current. There is no v2 and no Kaseya-unified data API — KaseyaOne
unification is SSO only and SaaS Protection is not wired into it for the data
plane. This is the one API not to reach past v1 on.

**There is no restore endpoint at all**, so `datto_saas_queue_restore` and
`datto_saas_get_restore_status` cannot work in any form.

## Approach: land the existing branch, then three deltas

`origin/fix/datto-saas-api-contract` (commits `f69c7de`, `f38309e`, Aaron Sachs,
2026-09-11) already rebuilds the API layer correctly. It adds an inline
`fetch`-based client at `src/datto-api.ts` (367 lines) that replaces the SDK's
resource layer while keeping its error taxonomy, adds `src/derived.ts` for the
values the real API does not serve directly, and ships 383 lines of wire-contract
tests that mock `fetch` rather than the SDK.

Checked before adopting it:

- our copy and upstream's copy are the **same commit** (`f38309e`) — byte-identical
- upstream has **not** merged it; `upstream/main` is still at the merge-base
  `cf57270`, eleven days on. Waiting for upstream is not a plan.
- same project, same Apache-2.0 licence, our own fork. This is a branch merge,
  not a cross-repo copy, so the fleet-licensing rule does not apply.
- merge is small: `main` carries only our two untrusted-content commits
  (`ceb87af`, `f8df489`). `src/mcp-server.ts` auto-merges; the single conflict is
  `test/mcp-apps.test.ts`.

**Added 2026-09-24: drop the WYRE SDK entirely.** The branch still imports six
error classes from `@wyre-technology/node-datto-saas-protection` and nothing
else. Keeping it costs a GitHub Packages token for every install, CI run and
image build, and the Dockerfile supplies that token through a BuildKit secret
mount that our `az acr build` deploy path cannot provide. The classes are
redefined in `src/datto-api.ts` under the same names and signatures, as
`datto-bcdr-mcp` did, and the private-registry plumbing goes with them.

Rejected: rebuilding from scratch (750 lines that already exist and already match
our independent findings) and waiting on upstream PR #75 (same author, same
commit, unmerged).

### Tool surface: 9 to 7

| Tool | Source |
|---|---|
| `datto_saas_list_clients` | derived from `/saas/domains` |
| `datto_saas_list_domains` | `/saas/domains` |
| `datto_saas_list_seats` | `/saas/{id}/seats`, degrading — see Delta 2 |
| `datto_saas_get_seat` | derived; there is no single-seat GET route |
| `datto_saas_get_backup_report` | `/saas/{id}/applications` (new) |
| `datto_saas_list_activity` | `/v1/report/activity-log` |
| `datto_saas_get_license_usage` | derived from `/saas/domains` |

Removed: `datto_saas_queue_restore`, `datto_saas_get_restore_status`,
`datto_saas_list_backups`.

**Read-only by construction.** No method on the client can issue anything but a
GET, so `bulkSeatChange` is unreachable even by accident. This keeps the server
at `MCP.Read` with no new app role, matching Datto BCDR.

### Delta 1 — the timeout, which would have bitten us

The branch defaults to a 30-second per-request timeout (`src/datto-api.ts:69`).
Our own measurements against this tenant:

| Endpoint | Observed |
|---|---|
| `/saas/domains` | ~34s |
| `/saas/applications` | ~19s |
| `/saas/{id}/seats` | 38-60s, then 504 |

A 30s default therefore cuts off `/saas/domains` — the most important endpoint —
before it can answer. Upstream had no way to know this; we measured it, and a
25-30s client timeout has already once caused us to conclude the credentials
were bad when they were fine.

**Set it to 90s**, above the observed 504 edge, so a genuine Datto 504 arrives as
a 504 rather than disguised as our own abort. Document the measurements at the
constant, in the style of `PROXY_TIMEOUT_MS` in the gateway's cred-router — that
comment exists because a conventional-looking number destroyed real requests
once already. Do not "tidy" this to a round number.

### Delta 2 — seats degrades instead of failing

`/saas/{id}/seats` 504s above roughly 25-40 seats. That is a backend query limit,
not a timeout we can raise: `_perPage=25` still 504s, so paging does not help.
Only 4 of our 42 domains sit under the threshold, and the 21 domains over 100
seats hold 4,514 of 5,589 protected seats. Shipping the tool unchanged means it
fails for ~90% of clients.

On 504 or timeout, fall back to `seatsUsed` from `/saas/domains` and return:

```
{
  saasCustomerId: 53124,
  seatsUsed: 214,
  seatDetail: null,
  domains: [{ domain: "acme.co.nz", productType: "Office365", seatsUsed: 214 }],
  note: "Per-seat detail unavailable: Datto's seats endpoint times out above
         ~25-40 seats. Count is from the domain record."
}
```

`seatsUsed` is the total across the customer's domain records, and `domains`
lists them, because a seat listing is customer-scoped while `seatsUsed` lives on
the domain — one customer can hold more than one domain record. (Refined
2026-09-24 from the single-domain shape first sketched.)

"504 or timeout" means precisely: a `DattoSaasProtectionServerError` carrying
status 504, or the `DOMException` named `TimeoutError` that `AbortSignal.timeout`
raises. Nothing else degrades — a 401 or 403 must still surface as itself.

A technician gets a number and a reason, never a bare vendor error. The note is
part of the contract, not a log line — the caller is a language model that will
otherwise narrate the failure as though the data does not exist.

### Delta 3 — prove the untrusted-content wrapper survived the merge

`src/mcp-server.ts` auto-merges cleanly while the branch rewrites 410 of its
lines, and our wrapper (`markUntrusted` / `wrapUntrustedContent`, `ceb87af`) is
31 lines inside it. The wrapper could land intact, land in the wrong place, or
wrap a function that no longer exists — **all three typecheck**.

This repo's recurring failure mode is the silent one: `list_assets` once reported
zero assets for a device with two because the library did `response.items ?? []`
against a response shaped `{"0":…,"1":…}`. A green build is not evidence.

**Corrected 2026-09-24 — the wrapper is selective by design, not universal.**
An earlier version of this section said to assert that *every* tool's result
comes back wrapped. That would have undone a deliberate decision:
`UNTRUSTED_CONTENT_TOOLS` in `src/utils/untrusted-content.ts` marks only the
tools that carry client-directory free text, and its comment says why —
"marking every tool trains a reader to stop noticing the marker".

The real risk across a 9-to-7 rename is that **set going stale**: naming tools
that no longer exist, and silently leaving new ones unclassified. So the test
asserts instead that:

1. every registered tool is classified — either in `UNTRUSTED_CONTENT_TOOLS` or
   in an explicit, exported `TRUSTED_CONTENT_TOOLS` set, so a new tool fails the
   test until somebody decides which it is
2. no name in either set is unregistered, so a deleted tool cannot linger
3. end to end through the server, a marked tool's result comes back wrapped and
   an unmarked one's does not — which is what proves the choke point survived

Classification for the new surface: `list_seats`, `get_seat`, `list_activity`
stay marked. `get_backup_report` is **unmarked**, joining `list_clients`,
`list_domains` and `get_license_usage` — its known fields are IT Simply-configured
names and byte counts. REVISIT: its `suites` field is typed `unknown[]` and has
never been seen in a live response; the schema check below looks at it, and if it
carries directory data the tool moves into the marked set.

## Verify before trusting the schemas

Two findings came from upstream's own fix and are **not yet verified by us**:

- `saasCustomerId` is an **integer, not a string** — a string filters silently
  rather than erroring
- `billable` is the string `"1"` / `"0"`, **not a boolean** — a truthiness test
  passes for both values

Confirm both against one live call before relying on them. The same org invented
the first version of this client.

**Verified 2026-09-24 against the live API** (read-only probe; shapes and types
recorded, no client data):

- `saasCustomerId` is a **number** on all 42 domain records. Branch type correct.
- `billable` is a **string**, but the values seen were `"1"` and **`""`** — never
  the `"0"` Datto documents. The seat card mapped only `"1"`/`"0"`, so every
  non-billable seat would have rendered with no billing line at all. Fixed as
  plan Task 3a.
- The backup report's `suites` entries are
  `{ suiteType, appTypes: [{ appType, backupHistory[], lastFullyProtectedTime,
  uningestedServiceCount, usedBytes }] }`, and `backupHistory` holds service
  counts, time windows and a status. No directory text, so
  `datto_saas_get_backup_report` stays **unmarked**.
- `/applications` returned a single `{ pagination, items }` envelope, not the
  array the contract declares. The branch client already accepts both.
- Every customer in this tenant has exactly one domain record, and
  `/saas/domains` answered in 20.7s on this run.

## Testing

The branch's `test/datto-api.test.ts` (383 lines) mocks `fetch` itself and pins
host, paths and schemas. Keep it. Add three:

1. every tool result is untrusted-wrapped (Delta 3)
2. a mocked 504 from `/saas/{id}/seats` produces the degraded shape (Delta 2)
3. the configured timeout is above the observed 504 edge (Delta 1)

Note for whoever picks this up: `test/index.test.ts` on `main` asserts against
locally-declared literal arrays rather than the server, so it stays green even if
every tool is deleted. The branch rewrites it; do not restore the old form.

## Gateway follow-on (separate repo)

`cred-router/src/index.js` lists `datto_saas_queue_restore` in
`MUTATION_TOOL_NAMES`, with a comment saying it "writes a backup back over a
client's live mailbox". That is untrue — Datto has no restore endpoint — and
`cred-router/test/circuitBreaker.test.js` asserts on the name.

**Corrected 2026-09-24.** An earlier version said to re-point the entry at a
real mutating tool from another vendor. Checked: there isn't one. Every mutating
tool across the six live vendors already matches `MUTATION_VERB_PATTERN`
(`create`, `update`, `run`, `resolve`, `dial`, `set`, …). So the resolution is:

- **keep the entry.** Upstream's published server still ships a tool with that
  exact name. Our fork drops it, but anyone importing upstream's image instead
  of building ours would put it back behind the gateway, and its name carries no
  recognised verb. The entry now guards that case, and the comment says so
  honestly rather than claiming the tool works.
- **replace the name-specific test with an invariant**: every name in the set
  must evade the verb pattern (otherwise the entry is redundant) and must be
  classified as a mutation. That tests the mechanism, not one example of it.

**The mechanism stays.** A vendor can absolutely name a destructive tool without
using a recognised verb. Do not delete it to make the reference go away.

## Out of scope

Deployment. Container and route naming were settled previously
(`mcpgateway-dattosaas-mcp`, `/mcp/dattosaas`), but building and deploying is a
separate step needing its own approval.

## Stale fork metadata (optional, flagged not scheduled)

`package.json` still carries upstream's `repository`, `bugs` and `homepage` URLs,
and `publishConfig.registry` points at WYRE-AI's GitHub Packages. Worth correcting
so a release workflow cannot publish our fork to their registry, but it is not
required for this work and should not be bundled into the merge commit.
