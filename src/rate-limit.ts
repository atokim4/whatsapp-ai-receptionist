export type RateDecision = "allow" | "warn" | "drop";

interface Bucket {
  hits: number[];
  warnedAt: number | null;
}

/**
 * Sliding-window limit per WhatsApp user, kept in memory (one process). The first rejected message in a
 * window gets "warn" so the user is told once; further ones are dropped quietly.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now: number): RateDecision {
    if (this.buckets.size > 10_000) this.sweep(now);
    const bucket = this.buckets.get(key) ?? { hits: [], warnedAt: null };
    this.buckets.set(key, bucket);
    bucket.hits = bucket.hits.filter((t) => t > now - this.windowMs);

    if (bucket.hits.length < this.limit) {
      bucket.hits.push(now);
      return "allow";
    }
    if (bucket.warnedAt === null || bucket.warnedAt <= now - this.windowMs) {
      bucket.warnedAt = now;
      return "warn";
    }
    return "drop";
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every((t) => t <= now - this.windowMs)) this.buckets.delete(key);
    }
  }
}
