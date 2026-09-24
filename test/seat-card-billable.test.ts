import { describe, it, expect } from 'vitest';
import { buildSeatCard } from '../src/seat-card.js';

const seat = { mainId: 'dana@acme.co.nz', name: 'Dana', seatType: 'User', seatState: 'Active' };

// Observed live on 2026-09-24: billable is "1" or "" - never the "0" Datto
// documents. Mapping only "1"/"0" left every non-billable seat with no
// billing line at all.
describe('seat card billing', () => {
  it.each([
    ['1', 'Billable'],
    ['', 'Not billable'],
    ['0', 'Not billable'],
  ])('billable %j renders as %s', (billable, billing) => {
    expect(buildSeatCard({ ...seat, billable })?.billing).toBe(billing);
  });

  it('shows nothing when the flag is absent or unrecognised', () => {
    expect(buildSeatCard(seat)?.billing).toBeUndefined();
    expect(buildSeatCard({ ...seat, billable: 'maybe' })?.billing).toBeUndefined();
  });
});
