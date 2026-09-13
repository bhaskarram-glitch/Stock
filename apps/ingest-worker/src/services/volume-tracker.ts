/**
 * Converts Upstox's cumulative "volume traded today" (vtt) into per-tick deltas.
 *
 * Rules:
 * - First observation for an instrument: delta 0 (we don't know how much of the
 *   cumulative total belongs to the current bucket).
 * - Normal case: delta = current - previous.
 * - Decrease (new trading day / feed reset): treat the new cumulative value as the
 *   delta, since everything in it traded since the reset.
 * - Missing/non-finite input (e.g. indexes have no volume): delta 0, state untouched.
 */
export class CumulativeVolumeTracker {
  private last = new Map<string, number>();

  delta(instrumentKey: string, cumulative: number | undefined): number {
    if (
      cumulative === undefined ||
      !Number.isFinite(cumulative) ||
      cumulative < 0
    ) {
      return 0;
    }
    const prev = this.last.get(instrumentKey);
    this.last.set(instrumentKey, cumulative);
    if (prev === undefined) return 0;
    if (cumulative < prev) return cumulative; // rollover / reset
    return cumulative - prev;
  }

  reset(instrumentKey?: string): void {
    if (instrumentKey === undefined) this.last.clear();
    else this.last.delete(instrumentKey);
  }

  size(): number {
    return this.last.size;
  }
}
