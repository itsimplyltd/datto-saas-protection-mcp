/**
 * `summariseBackupReport` turns Datto's nested backup report into a flat,
 * human-readable summary — the only backup data the API has, since there is
 * no per-user or per-mailbox endpoint. Fixtures are synthetic: shape only,
 * matching the envelope measured live on 2026-09-25, never real customer
 * data.
 */

import { describe, it, expect } from 'vitest';
import {
  summariseBackupReport,
  summariseAppType,
  formatNzTime,
  formatBytesHuman,
  bucketLabel,
  type LastFullyProtectedAt,
  type LastFullyProtectedBucket,
  type LatestDaySummary,
  type NoHistory,
} from '../src/backup-report-summary.js';
import type { BackupAppType, BackupHistoryEntry, SaasBackupReport } from '../src/datto-api.js';

/** 10 entries, newest first, per the documented shape — startTime is LATER than endTime. */
function history(overrides: Partial<BackupHistoryEntry>[] = []): BackupHistoryEntry[] {
  const base: BackupHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
    timeWindow: `Between${i}dAnd${i + 1}d`,
    startTime: Date.UTC(2026, 8, 25 - i, 12, 0, 0), // later
    endTime: Date.UTC(2026, 8, 24 - i, 12, 0, 0), // earlier than startTime
    totalServiceCount: 81,
    activeServiceCount: 81,
    activeServiceWithBackupCount: 81,
    activeServiceWithPerfectBackupCount: 81,
    status: 'Perfect',
  }));
  overrides.forEach((o, i) => Object.assign(base[i], o));
  return base;
}

const NOW = Date.UTC(2026, 8, 25, 22, 0, 0);

function exchange(overrides: Partial<BackupAppType> = {}): BackupAppType {
  return {
    appType: 'Office365Exchange',
    lastFullyProtectedTime: NOW - 60 * 60 * 1000, // 1 hour ago
    uningestedServiceCount: 0,
    usedBytes: 1_000_000,
    backupHistory: history(),
    ...overrides,
  };
}

function report(appTypes: BackupAppType[]): SaasBackupReport[] {
  return [
    {
      pagination: { page: 1, perPage: 25, totalPages: 1, count: 1 },
      items: [
        {
          customerId: 53124,
          customerName: 'Fixture Customer',
          usedBytes: 123456789,
          suites: [{ suiteType: 'Office365', appTypes }],
        },
      ],
    },
  ];
}

describe('lastFullyProtectedTime: numeric', () => {
  it('formats a numeric timestamp as ISO UTC + NZ local', () => {
    const app = summariseAppType(exchange({ lastFullyProtectedTime: Date.UTC(2026, 8, 24, 22, 5, 0) }));
    const lfp = app.lastFullyProtected as LastFullyProtectedAt;
    expect(lfp.at).toBe('2026-09-24T22:05:00.000Z');
    expect(lfp.nz).toBe('25 Sep 2026, 10:05 am');
  });
});

describe('lastFullyProtectedTime: bucket', () => {
  it('formats a bucket string into a human label, not a timestamp', () => {
    const app = summariseAppType(exchange({ lastFullyProtectedTime: 'OVER_10_DAYS_AGO' }));
    const lfp = app.lastFullyProtected as LastFullyProtectedBucket;
    expect(lfp.bucket).toBe('OVER_10_DAYS_AGO');
    expect(lfp.label).toBe('over 10 days ago');
  });

  it('bucketLabel is generic across SHOUT_CASE buckets', () => {
    expect(bucketLabel('BETWEEN_1_AND_2_DAYS_AGO')).toBe('between 1 and 2 days ago');
  });
});

describe('missed count', () => {
  it('is active minus backedUp on the latest day', () => {
    const app = summariseAppType(
      exchange({
        backupHistory: history([
          { timeWindow: 'Between0dAnd1d', activeServiceCount: 81, activeServiceWithBackupCount: 74 },
        ]),
      })
    );
    const day = app.latestDay as LatestDaySummary;
    expect(day.active).toBe(81);
    expect(day.backedUp).toBe(74);
    expect(day.missed).toBe(7);
  });

  it('picks the first entry when none is tagged Between0dAnd1d', () => {
    const app = summariseAppType(
      exchange({
        backupHistory: history([
          { timeWindow: 'SomeOtherWindow', activeServiceCount: 10, activeServiceWithBackupCount: 9 },
        ]),
      })
    );
    const day = app.latestDay as LatestDaySummary;
    expect(day.missed).toBe(1);
  });
});

describe('attention rules', () => {
  it('flags a missed backup today', () => {
    const [customer] = summariseBackupReport(
      report([
        exchange({
          backupHistory: history([
            { timeWindow: 'Between0dAnd1d', activeServiceCount: 81, activeServiceWithBackupCount: 74 },
          ]),
        }),
      ]),
      NOW
    );
    expect(customer.attention).toHaveLength(1);
    expect(customer.attention[0].app).toBe('Exchange');
    expect(customer.attention[0].reason).toContain('7 of 81 mailboxes not backed up in the last day');
  });

  it('flags a stale bucketed lastFullyProtectedTime and joins clauses with "; "', () => {
    const [customer] = summariseBackupReport(
      report([
        exchange({
          lastFullyProtectedTime: 'OVER_10_DAYS_AGO',
          backupHistory: history([
            { timeWindow: 'Between0dAnd1d', activeServiceCount: 81, activeServiceWithBackupCount: 74 },
          ]),
        }),
      ]),
      NOW
    );
    expect(customer.attention[0].reason).toBe(
      '7 of 81 mailboxes not backed up in the last day; not all mailboxes backed up in over 10 days'
    );
  });

  it('flags uningested services', () => {
    const [customer] = summariseBackupReport(report([exchange({ uningestedServiceCount: 3 })]), NOW);
    expect(customer.attention).toHaveLength(1);
    expect(customer.attention[0].reason).toBe('3 mailboxes not yet ingested');
  });

  it('flags a numeric lastFullyProtectedTime older than 24 hours', () => {
    const [customer] = summariseBackupReport(
      report([exchange({ lastFullyProtectedTime: NOW - 2 * 24 * 60 * 60 * 1000 })]),
      NOW
    );
    expect(customer.attention).toHaveLength(1);
    expect(customer.attention[0].reason).toContain('not all mailboxes backed up in 2 days');
  });

  it('is silent when nothing was missed, protection is recent, and nothing is uningested', () => {
    const [customer] = summariseBackupReport(report([exchange()]), NOW);
    expect(customer.attention).toHaveLength(0);
  });
});

describe('unknown appType', () => {
  it('passes an unrecognised appType through unchanged', () => {
    const app = summariseAppType(exchange({ appType: 'Office365Viva' }));
    expect(app.appType).toBe('Office365Viva');
    expect(app.name).toBe('Office365Viva');
    expect(app.serviceNoun).toBe('items');
  });
});

describe('missing or empty backupHistory', () => {
  it('reports "No history" for a missing backupHistory without crashing', () => {
    const app = summariseAppType(exchange({ backupHistory: undefined }));
    expect((app.latestDay as NoHistory).status).toBe('No history');
    expect(app.trend).toEqual([]);
  });

  it('reports "No history" for an empty backupHistory array without crashing', () => {
    const app = summariseAppType(exchange({ backupHistory: [] }));
    expect((app.latestDay as NoHistory).status).toBe('No history');
    expect(app.trend).toEqual([]);
  });

  it('does not flag a missed-backup attention line when there is no history (nothing else stale)', () => {
    const [customer] = summariseBackupReport(report([exchange({ backupHistory: [] })]), NOW);
    expect(customer.attention).toHaveLength(0);
  });
});

describe('startTime later than endTime', () => {
  it('does not affect the trend, which orders by array position (newest-first input reversed)', () => {
    const h = history();
    expect(h[0].startTime!).toBeGreaterThan(h[0].endTime!);
    const app = summariseAppType(exchange({ backupHistory: h }));
    expect(app.trend).toHaveLength(10);
    // Reversed: oldest window (Between9dAnd10d) first, newest (Between0dAnd1d) last.
    expect(app.trend[0].window).toBe('Between9dAnd10d');
    expect(app.trend[9].window).toBe('Between0dAnd1d');
  });
});

describe('NZ time formatting', () => {
  it('formats a UTC epoch as NZST local time (measured before 2026 daylight saving starts)', () => {
    expect(formatNzTime(Date.UTC(2026, 8, 24, 22, 5, 0))).toBe('25 Sep 2026, 10:05 am');
  });
});

describe('formatBytesHuman', () => {
  it('formats a byte count as a human size', () => {
    expect(formatBytesHuman(0)).toBe('0 B');
    expect(formatBytesHuman(123456789)).toBe('117.7 MB');
  });

  it('returns undefined for a missing byte count', () => {
    expect(formatBytesHuman(undefined)).toBeUndefined();
  });
});

describe('summariseBackupReport: whole-report shape', () => {
  it('summarises customer id, name, and human byte size', () => {
    const [customer] = summariseBackupReport(report([exchange()]), NOW);
    expect(customer.customerId).toBe(53124);
    expect(customer.customerName).toBe('Fixture Customer');
    expect(customer.usedBytesHuman).toBe('117.7 MB');
  });

  it('accepts a bare envelope as well as an array of them', () => {
    const [envelope] = report([exchange()]);
    const [customer] = summariseBackupReport(envelope, NOW);
    expect(customer.customerId).toBe(53124);
  });

  it('returns an empty list for a null/undefined report without crashing', () => {
    expect(summariseBackupReport(undefined)).toEqual([]);
    expect(summariseBackupReport(null)).toEqual([]);
  });

  it('handles a customer with no suites at all', () => {
    const [customer] = summariseBackupReport(
      [
        {
          pagination: { count: 1 },
          items: [{ customerId: 1, customerName: 'No Suites', usedBytes: 0 }],
        },
      ],
      NOW
    );
    expect(customer.apps).toEqual([]);
    expect(customer.attention).toEqual([]);
  });
});
