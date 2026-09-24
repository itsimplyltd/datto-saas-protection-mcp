/**
 * Datto SaaS Protection REST API client.
 *
 * Datto's SaaS Protection surface is a small, flat, read-only set of routes on
 * a single host. Every path below comes from Datto's published REST API
 * contract and was confirmed live against `api.datto.com` (an unauthenticated
 * probe returns 401 for a route that exists and 404 for one that does not):
 *
 *   GET /v1/saas/domains                        -> SaasDomain[]
 *   GET /v1/saas/{saasCustomerId}/seats         -> SaasSeat[]
 *   GET /v1/saas/{saasCustomerId}/applications  -> SaasBackupReport[]
 *
 * This module deliberately does NOT use the resource layer of
 * `@wyre-technology/node-datto-saas-protection`. That SDK's base URL and Basic
 * auth are right, but its per-resource paths (`/clients`,
 * `/clients/{id}/domains`, `/seats/{id}`, `/seats/{id}/backups`,
 * `/restores/{id}`, `/clients/{id}/activity`, `/clients/{id}/usage`) were
 * written against a speculative spec — its own CHANGELOG says so — and all of
 * them 404. Its error taxonomy was sound, so it is reproduced below under the
 * same names - the error contract for callers is unchanged - and the SDK itself
 * is no longer a dependency.
 *
 * Read-only by construction: there is no method on this client that can issue
 * anything but a GET, so the one write route the API does have
 * (`PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange`)
 * cannot be reached through it even by accident.
 */

// ---------------------------------------------------------------------------
// Errors — the same names and constructor signatures as the WYRE SDK this
// client used to import them from, so every message and `instanceof` check a
// caller relies on is unchanged. Defined here because they were the only thing
// still taken from that SDK, and keeping it meant a private-registry token in
// every install, CI run and image build. datto-bcdr-mcp made the same move.
// ---------------------------------------------------------------------------

export class DattoSaasProtectionError extends Error {
  readonly statusCode: number;
  readonly response: unknown;
  constructor(message: string, statusCode = 0, response?: unknown) {
    super(message);
    this.name = "DattoSaasProtectionError";
    this.statusCode = statusCode;
    this.response = response;
    Object.setPrototypeOf(this, DattoSaasProtectionError.prototype);
  }
}

export class DattoSaasProtectionAuthenticationError extends DattoSaasProtectionError {
  constructor(message: string, statusCode = 401, response?: unknown) {
    super(message, statusCode, response);
    this.name = "DattoSaasProtectionAuthenticationError";
    Object.setPrototypeOf(this, DattoSaasProtectionAuthenticationError.prototype);
  }
}

export class DattoSaasProtectionForbiddenError extends DattoSaasProtectionError {
  constructor(message: string, response?: unknown) {
    super(message, 403, response);
    this.name = "DattoSaasProtectionForbiddenError";
    Object.setPrototypeOf(this, DattoSaasProtectionForbiddenError.prototype);
  }
}

export class DattoSaasProtectionNotFoundError extends DattoSaasProtectionError {
  constructor(message: string, response?: unknown) {
    super(message, 404, response);
    this.name = "DattoSaasProtectionNotFoundError";
    Object.setPrototypeOf(this, DattoSaasProtectionNotFoundError.prototype);
  }
}

export class DattoSaasProtectionRateLimitError extends DattoSaasProtectionError {
  /** Suggested retry delay in milliseconds (parsed from Retry-After). */
  readonly retryAfter: number;
  constructor(message: string, retryAfter = 5000, response?: unknown) {
    super(message, 429, response);
    this.name = "DattoSaasProtectionRateLimitError";
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, DattoSaasProtectionRateLimitError.prototype);
  }
}

export class DattoSaasProtectionServerError extends DattoSaasProtectionError {
  constructor(message: string, statusCode = 500, response?: unknown) {
    super(message, statusCode, response);
    this.name = "DattoSaasProtectionServerError";
    Object.setPrototypeOf(this, DattoSaasProtectionServerError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Contract constants — the single source of truth for host and paths
// ---------------------------------------------------------------------------

/**
 * The one and only Datto REST API origin.
 *
 * There is no regional split. `api.eu.datto.com` — which the SDK offers as its
 * `eu` region — does not resolve (NXDOMAIN), and Datto's OpenAPI contract
 * declares a single server. Multi-region partners are scoped by API key, not by
 * hostname.
 */
export const DATTO_API_BASE_URL = "https://api.datto.com";

/** All protected domains visible to the key, across every SaaS customer. */
export const DOMAINS_PATH = "/v1/saas/domains";

/** Seats for one SaaS Protection customer. */
export function seatsPath(saasCustomerId: string | number): string {
  return `/v1/saas/${encodeURIComponent(String(saasCustomerId))}/seats`;
}

/** Backup report for one SaaS Protection customer. */
export function backupReportPath(saasCustomerId: string | number): string {
  return `/v1/saas/${encodeURIComponent(String(saasCustomerId))}/applications`;
}

/**
 * Default per-request timeout. DELIBERATELY LARGE - do not "tidy" it.
 *
 * Measured against a real partner tenant on 2026-09-21:
 *   GET /v1/saas/domains               ~34s
 *   GET /v1/saas/{id}/applications     ~19s
 *   GET /v1/saas/{id}/seats            38-60s, then a 504 from Datto's edge
 *
 * The 30s this used to be cut off /saas/domains - the call every other tool
 * depends on - before it could answer, and a 25-30s timeout once made a
 * working key pair look like bad credentials. 90s sits above Datto's own 504
 * edge, so a real Datto 504 arrives as a 504 (which the seats tool knows how
 * to degrade from) instead of being disguised as our own abort.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Response types — field names and types taken from Datto's schema
// ---------------------------------------------------------------------------

/** Seat types Datto accepts as a `seatType` filter and returns on a seat. */
export const SEAT_TYPES = [
  "User",
  "Site",
  "TeamSite",
  "SharedMailbox",
  "Team",
  "SharedDrive",
] as const;

export type SeatType = (typeof SEAT_TYPES)[number];

export interface BackupStats {
  activeServicesCount?: number;
  activeServicesWithRecentBackupCount?: number;
  backupPercentage?: number;
}

export interface SaasDomain {
  domain?: string;
  /** Integer in the live API — never quote it or compare it with `===` to a string. */
  saasCustomerId?: number;
  saasCustomerName?: string;
  organizationId?: number | null;
  organizationName?: string | null;
  seatsUsed?: number;
  productType?: string;
  externalSubscriptionId?: string;
  retentionType?: string;
  backupStats?: BackupStats;
}

export interface SaasSeat {
  /** The protected entity, e.g. an email address. Datto's per-seat identifier. */
  mainId?: string;
  name?: string;
  seatType?: string;
  seatState?: string;
  /** A string, not a boolean: `"1"` when billable, `""` when not (live, 2026-09-24 - Datto's docs say `"0"`, which never appeared). */
  billable?: string;
  dateAdded?: string;
  /** Microsoft/Google object id. */
  remoteId?: string;
}

export interface Pagination {
  page?: number;
  perPage?: number;
  totalPages?: number;
  count?: number;
}

export interface BackupReportItem {
  customerId?: number;
  customerName?: string;
  usedBytes?: number;
  suites?: unknown[];
}

export interface SaasBackupReport {
  pagination?: Pagination;
  items?: BackupReportItem[];
}

export interface DattoSaasApiOptions {
  publicKey: string;
  secretKey: string;
  /** Override the API origin. Defaults to {@link DATTO_API_BASE_URL}. */
  baseUrl?: string;
  timeoutMs?: number;
}

type QueryValue = string | number | boolean | undefined;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DattoSaasApi {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DattoSaasApiOptions) {
    if (!options.publicKey) throw new Error("publicKey must be provided");
    if (!options.secretKey) throw new Error("secretKey must be provided");

    // Basic auth: public key as username, secret key as password.
    const encoded = Buffer.from(
      `${options.publicKey}:${options.secretKey}`,
      "utf8"
    ).toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.baseUrl = (options.baseUrl || DATTO_API_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `GET /v1/saas/domains` — every protected domain the key can see. */
  async listDomains(): Promise<SaasDomain[]> {
    return this.getArray<SaasDomain>(DOMAINS_PATH);
  }

  /** `GET /v1/saas/{saasCustomerId}/seats` */
  async listSeats(
    saasCustomerId: string | number,
    params: { seatType?: string[] } = {}
  ): Promise<SaasSeat[]> {
    // Datto serialises seatType as one comma-separated value (form/no-explode).
    const seatType = params.seatType?.length ? params.seatType.join(",") : undefined;
    return this.getArray<SaasSeat>(seatsPath(saasCustomerId), { seatType });
  }

  /**
   * `GET /v1/saas/{saasCustomerId}/applications` — backup/usage report.
   *
   * Datto's contract declares this as an *array of* `{pagination, items}`
   * envelopes, which is almost certainly a spec-authoring artifact — a single
   * envelope is what a report endpoint would naturally return. It is the one
   * part of this contract that could not be confirmed against a live response,
   * so both shapes are accepted: a bare envelope is wrapped into a one-element
   * array rather than silently discarded.
   */
  async getBackupReport(
    saasCustomerId: string | number,
    params: { daysUntil?: number } = {}
  ): Promise<SaasBackupReport[]> {
    const body = await this.get<SaasBackupReport | SaasBackupReport[]>(
      backupReportPath(saasCustomerId),
      { daysUntil: params.daysUntil }
    );
    if (Array.isArray(body)) return body;
    return body && typeof body === "object" ? [body] : [];
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Datto returns bare JSON arrays for the SaaS collection routes (no envelope,
   * no pagination). Anything else is a contract mismatch - a proxy/WAF error
   * page, a maintenance page, a shape change - and throws rather than being
   * silently normalised to `[]`, which used to make a real shape mismatch
   * indistinguishable from "this customer has no records".
   */
  private async getArray<T>(path: string, query?: Record<string, QueryValue>): Promise<T[]> {
    const body = await this.get<T[]>(path, query);
    if (!Array.isArray(body)) {
      throw new DattoSaasProtectionError(
        `Datto returned an unexpected response shape for GET ${path} (expected a JSON array)`,
        200,
        body
      );
    }
    return body;
  }

  private async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: this.authHeader },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) throw await toApiError(response, path);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new DattoSaasProtectionError(
        `Datto returned a non-JSON response for GET ${path}`,
        response.status
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      // An AbortSignal.timeout firing mid-body-read surfaces here as
      // response.json() rejecting - it must stay a timeout
      // (isSeatListingUnavailable relies on the DOMException surviving
      // unchanged), not get relabelled as a malformed JSON body.
      if (error instanceof DOMException && error.name === "TimeoutError") throw error;
      throw new DattoSaasProtectionError(
        `Datto returned a malformed JSON body for GET ${path}`,
        response.status
      );
    }
  }
}

/**
 * Map an HTTP failure onto the SDK's error taxonomy.
 *
 * A 404 from this API means the route or record genuinely does not exist — it
 * is never an auth problem, which is what made the old client's wrong paths so
 * hard to diagnose. The message says so.
 */
async function toApiError(response: Response, path: string): Promise<DattoSaasProtectionError> {
  const body = await readBody(response);

  switch (response.status) {
    case 401:
      return new DattoSaasProtectionAuthenticationError(
        "Authentication failed (401). Check DATTO_SAAS_PUBLIC_KEY / DATTO_SAAS_SECRET_KEY — " +
          "they are the public/secret API key pair from Partner Portal > Admin > Integrations > API Keys.",
        401,
        body
      );
    case 403:
      return new DattoSaasProtectionForbiddenError(
        "Access forbidden (403) — the API key is valid but out of scope for this customer.",
        body
      );
    case 404:
      return new DattoSaasProtectionNotFoundError(
        `Not found (404) for ${path} — the route or customer id does not exist ` +
          "or is not visible to this key. A 404 here is never a credential problem; bad credentials return 401.",
        body
      );
    case 429: {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      return new DattoSaasProtectionRateLimitError(
        "Rate limit exceeded (429). Datto meters a weighted hourly budget per organization — " +
          "read X-API-Limit-Remaining / X-API-Limit-Resets / X-API-Limit-Cost from a live response " +
          "rather than assuming a flat call count.",
        (Number.isNaN(retryAfter) ? 5 : retryAfter) * 1000,
        body
      );
    }
    default:
      if (response.status >= 500) {
        return new DattoSaasProtectionServerError(
          `Datto server error: ${response.status} ${response.statusText}`,
          response.status,
          body
        );
      }
      return new DattoSaasProtectionError(
        `Request failed: ${response.status} ${response.statusText}`,
        response.status,
        body
      );
  }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      return await response.text();
    } catch {
      return undefined;
    }
  }
}

/**
 * True when a seat listing failed because Datto could not produce it in time,
 * which is what happens above roughly 25-40 seats: the backend query behind
 * /saas/{id}/seats outlasts Datto's own 60s edge and comes back as a 504.
 * Paging does not help (_perPage=25 still 504s), so this is a limit of the
 * endpoint, not of our client.
 *
 * Exactly two things count: a 504 from Datto, and our own AbortSignal.timeout
 * firing. Everything else - 401, 403, 404, other 5xx - means something is
 * actually wrong and must reach the caller as itself rather than being
 * papered over with a count.
 */
export function isSeatListingUnavailable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof DattoSaasProtectionServerError) return error.statusCode === 504;
  return false;
}
