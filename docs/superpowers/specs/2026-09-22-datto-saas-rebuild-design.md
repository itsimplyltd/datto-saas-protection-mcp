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
  domain: "acme.co.nz",
  seatsUsed: 214,
  seatDetail: null,
  note: "Per-seat detail unavailable: Datto's seats endpoint times out above
         ~25-40 seats. Count is from the domain record."
}
```

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

Add a test that asserts **every** registered tool's result comes back wrapped,
enumerated from the server's own tool list rather than a hardcoded array.

## Verify before trusting the schemas

Two findings came from upstream's own fix and are **not yet verified by us**:

- `saasCustomerId` is an **integer, not a string** — a string filters silently
  rather than erroring
- `billable` is the string `"1"` / `"0"`, **not a boolean** — a truthiness test
  passes for both values

Confirm both against one live call before relying on them. The same org invented
the first version of this client.

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

`cred-router/src/index.js:459` lists `datto_saas_queue_restore` in
`MUTATION_TOOL_NAMES`, with a comment calling it a worked example of a
destructive tool the verb pattern cannot see. That tool stops existing, and
because the new client is read-only by construction there is no mutating SaaS
tool to re-point at — so the example must move to a real mutating tool from
another vendor. `cred-router/test/circuitBreaker.test.js:229` asserts on it too.

**The mechanism stays.** A vendor can absolutely name a destructive tool without
using a recognised verb; only the worked example is wrong. Do not delete the
exception mechanism to make the reference go away.

## Out of scope

Deployment. Container and route naming were settled previously
(`mcpgateway-dattosaas-mcp`, `/mcp/dattosaas`), but building and deploying is a
separate step needing its own approval.

## Stale fork metadata (optional, flagged not scheduled)

`package.json` still carries upstream's `repository`, `bugs` and `homepage` URLs,
and `publishConfig.registry` points at WYRE-AI's GitHub Packages. Worth correcting
so a release workflow cannot publish our fork to their registry, but it is not
required for this work and should not be bundled into the merge commit.
