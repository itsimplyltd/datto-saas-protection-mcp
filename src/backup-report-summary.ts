/**
 * Backup report summariser for `datto_saas_get_backup_report`.
 *
 * Datto's `GET /v1/saas/{saasCustomerId}/applications` report is the only
 * backup data the API exposes — there is no per-user or per-mailbox
 * endpoint. Its useful content is buried in
 * `items[].suites[].appTypes[].backupHistory[]`. This module is a pure,
 * side-effect-free normaliser (same shape of contract as seat-card.ts) that
 * turns that nested report into a flat, human-readable summary: per app,
 * what happened in the last day and over the last 10 days, and a
 * customer-level "attention" list of the apps that need a look.
 *
 * A "service" in Datto's vocabulary is one mailbox, OneDrive, SharePoint
 * site or Team — this module words the attention text with the matching
 * noun per app.
 */

import type {
  BackupAppType,
  BackupHistoryEntry,
  BackupReportItem,
  SaasBackupReport,
} from "./datto-api.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface LastFullyProtectedAt {
  /** ISO 8601, UTC. */
  at: string;
  /** e.g. "25 Sep 2026, 10:05 am", Pacific/Auckland. */
  nz: string;
}

export interface LastFullyProtectedBucket {
  /** Datto's raw bucket, e.g. "OVER_10_DAYS_AGO". */
  bucket: string;
  /** e.g. "over 10 days ago". */
  label: string;
}

export type LastFullyProtected = LastFullyProtectedAt | LastFullyProtectedBucket;

export interface LatestDaySummary {
  active: number;
  backedUp: number;
  perfect: number;
  missed: number;
  status: string;
}

/** `backupHistory` was missing or empty — there is nothing to summarise. */
export interface NoHistory {
  status: "No history";
}

export type LatestDay = LatestDaySummary | NoHistory;

export interface TrendEntry {
  window: string;
  backedUp: number;
  active: number;
  status: string;
}

export interface AppSummary {
  /** Datto's raw appType, e.g. "Office365Exchange". */
  appType: string;
  /** Friendly name, e.g. "Exchange". Unknown appTypes pass through unchanged. */
  name: string;
  /** e.g. "mailboxes", "OneDrives", "sites", "teams". */
  serviceNoun: string;
  lastFullyProtected?: LastFullyProtected;
  latestDay: LatestDay;
  /** Oldest to newest (backupHistory itself arrives newest-first). */
  trend: TrendEntry[];
  uningested: number;
  usedBytes?: number;
}

export interface AttentionEntry {
  /** Friendly app name, e.g. "Exchange". */
  app: string;
  /** One line, e.g. "7 of 81 mailboxes not backed up in the last day; not all mailboxes backed up in over 10 days". */
  reason: string;
}

export interface CustomerBackupSummary {
  customerId?: number;
  customerName?: string;
  usedBytes?: number;
  usedBytesHuman?: string;
  apps: AppSummary[];
  /** Apps that missed a backup, aren't recently protected, or have uningested services. */
  attention: AttentionEntry[];
}

// ---------------------------------------------------------------------------
// Friendly app names
// ---------------------------------------------------------------------------

const APP_LABELS: Record<string, { name: string; noun: string }> = {
  Office365Exchange: { name: "Exchange", noun: "mailboxes" },
  Office365OneDrive: { name: "OneDrive", noun: "OneDrives" },
  Office365SharePoint: { name: "SharePoint", noun: "sites" },
  Office365Teams: { name: "Teams", noun: "teams" },
};

/** Unknown appTypes pass through unchanged, with a generic service noun. */
function friendlyApp(appType: string | undefined): { name: string; noun: string } {
  if (appType && APP_LABELS[appType]) return APP_LABELS[appType];
  return { name: appType || "Unknown", noun: "items" };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human-readable byte size, e.g. "12.3 GB". */
export function formatBytesHuman(bytes: number | undefined): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes === 0) return "0 B";
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1
  );
  const value = bytes / Math.pow(1024, exponent);
  const precision = exponent === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${BYTE_UNITS[exponent]}`;
}

/**
 * Format an epoch-ms timestamp as NZ local time, e.g. "25 Sep 2026, 10:05 am".
 * Built from `formatToParts` (rather than relying on a locale's default
 * separators) so the shape is stable regardless of the host's ICU data.
 */
export function formatNzTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Auckland",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dayPeriod = get("dayPeriod").toLowerCase();
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${dayPeriod}`;
}

/** "OVER_10_DAYS_AGO" -> "over 10 days ago". Generic — works for any SHOUT_CASE bucket. */
export function bucketLabel(bucket: string): string {
  return bucket.toLowerCase().replace(/_/g, " ");
}

/** e.g. "3 days" / "1 day" / "5 hours" / "1 hour" — used in attention text only. */
function relativeAgePhrase(ms: number, now: number): string {
  const diffMs = Math.max(0, now - ms);
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.max(1, Math.floor(diffMs / (60 * 60 * 1000)));
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function summariseLastFullyProtected(
  value: number | string | undefined
): LastFullyProtected | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { at: new Date(value).toISOString(), nz: formatNzTime(value) };
  }
  if (typeof value === "string" && value !== "") {
    return { bucket: value, label: bucketLabel(value) };
  }
  return undefined;
}

function isBucket(value: LastFullyProtected): value is LastFullyProtectedBucket {
  return "bucket" in value;
}

function isNoHistory(value: LatestDay): value is NoHistory {
  return !("active" in value);
}

// ---------------------------------------------------------------------------
// Per-app summarisation
// ---------------------------------------------------------------------------

/** The Between0dAnd1d entry, or the first entry if none matches, or undefined. */
function pickLatestDayEntry(
  history: BackupHistoryEntry[] | undefined
): BackupHistoryEntry | undefined {
  if (!history || history.length === 0) return undefined;
  return history.find((entry) => entry.timeWindow === "Between0dAnd1d") ?? history[0];
}

function summariseLatestDay(history: BackupHistoryEntry[] | undefined): LatestDay {
  const entry = pickLatestDayEntry(history);
  if (!entry) return { status: "No history" };
  const active = entry.activeServiceCount ?? 0;
  const backedUp = entry.activeServiceWithBackupCount ?? 0;
  const perfect = entry.activeServiceWithPerfectBackupCount ?? 0;
  return {
    active,
    backedUp,
    perfect,
    missed: active - backedUp,
    status: entry.status ?? "Unknown",
  };
}

/** backupHistory arrives newest-first; the trend reads oldest-to-newest. */
function summariseTrend(history: BackupHistoryEntry[] | undefined): TrendEntry[] {
  if (!history || history.length === 0) return [];
  return [...history].reverse().map((entry) => ({
    window: entry.timeWindow ?? "Unknown",
    backedUp: entry.activeServiceWithBackupCount ?? 0,
    active: entry.activeServiceCount ?? 0,
    status: entry.status ?? "Unknown",
  }));
}

export function summariseAppType(app: BackupAppType): AppSummary {
  const friendly = friendlyApp(app.appType);
  const summary: AppSummary = {
    appType: app.appType || "Unknown",
    name: friendly.name,
    serviceNoun: friendly.noun,
    latestDay: summariseLatestDay(app.backupHistory),
    trend: summariseTrend(app.backupHistory),
    uningested: app.uningestedServiceCount ?? 0,
    usedBytes: app.usedBytes,
  };
  const lastFullyProtected = summariseLastFullyProtected(app.lastFullyProtectedTime);
  if (lastFullyProtected) summary.lastFullyProtected = lastFullyProtected;
  return summary;
}

/**
 * One attention line for an app, or null if nothing needs a look.
 * Fires when: a backup was missed today, the app isn't confirmed protected
 * within the last 24 hours, or it has uningested services.
 */
function buildAttention(app: AppSummary, now: number): AttentionEntry | null {
  const { latestDay, lastFullyProtected, uningested, serviceNoun, name } = app;
  const clauses: string[] = [];

  if (!isNoHistory(latestDay) && latestDay.missed > 0) {
    clauses.push(
      `${latestDay.missed} of ${latestDay.active} ${serviceNoun} not backed up in the last day`
    );
  }

  if (lastFullyProtected) {
    if (isBucket(lastFullyProtected)) {
      // Datto only buckets when it has no exact timestamp to give — that is
      // itself always worth a look, so every bucket is flagged.
      const phrase = lastFullyProtected.label.replace(/ ago$/, "");
      clauses.push(`not all ${serviceNoun} backed up in ${phrase}`);
    } else {
      const ms = Date.parse(lastFullyProtected.at);
      if (now - ms >= 24 * 60 * 60 * 1000) {
        clauses.push(`not all ${serviceNoun} backed up in ${relativeAgePhrase(ms, now)}`);
      }
    }
  }

  if (uningested > 0) {
    clauses.push(`${uningested} ${serviceNoun} not yet ingested`);
  }

  if (clauses.length === 0) return null;
  return { app: name, reason: clauses.join("; ") };
}

// ---------------------------------------------------------------------------
// Per-customer / top-level summarisation
// ---------------------------------------------------------------------------

function summariseItem(item: BackupReportItem, now: number): CustomerBackupSummary {
  const appTypes = (item.suites ?? []).flatMap((suite) => suite.appTypes ?? []);
  const apps = appTypes.map((app) => summariseAppType(app));
  const attention = apps
    .map((app) => buildAttention(app, now))
    .filter((entry): entry is AttentionEntry => entry !== null);

  return {
    customerId: item.customerId,
    customerName: item.customerName,
    usedBytes: item.usedBytes,
    usedBytesHuman: formatBytesHuman(item.usedBytes),
    apps,
    attention,
  };
}

/**
 * Normalise a backup report — a single envelope (the documented shape) or the
 * array `DattoSaasApi.getBackupReport` actually returns — into one summary
 * per customer. `now` defaults to the current time; pass a fixed value for
 * deterministic tests.
 */
export function summariseBackupReport(
  report: SaasBackupReport | SaasBackupReport[] | null | undefined,
  now: number = Date.now()
): CustomerBackupSummary[] {
  const envelopes = Array.isArray(report) ? report : report ? [report] : [];
  return envelopes.flatMap((envelope) =>
    (envelope.items ?? []).map((item) => summariseItem(item, now))
  );
}
