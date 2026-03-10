// Token Bucket Rate Limiter Implementation

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimiterOptions {
  burstCapacity: number; // Maximum number of tokens (burst capacity)
  refillRate: number; // Tokens added per refill interval (e.g., per second)
  refillIntervalMs?: number; // Interval to refill tokens (default: 1000 ms)
  staleAfterMs?: number; // Time after which client entries are cleaned up (default: 5 minutes)
}

class TokenBucketRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly burstCapacity: number;
  private readonly refillRate: number;
  private readonly refillIntervalMs: number;
  private readonly staleAfterMs: number;

  constructor(options: RateLimiterOptions) {
    this.burstCapacity = options.burstCapacity;
    this.refillRate = options.refillRate;
    this.refillIntervalMs = options.refillIntervalMs ?? 1000;
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Check if a request from a client is allowed and consume a token if so
   * @param clientId - Unique identifier for the client
   * @returns true if request is allowed, false if rate limited
   */
  isAllowed(clientId: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    // Create new bucket if it doesn't exist
    if (!bucket) {
      bucket = {
        tokens: this.burstCapacity,
        lastRefill: now,
      };
      this.buckets.set(clientId, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = (elapsedMs / this.refillIntervalMs) * this.refillRate;
    bucket.tokens = Math.min(this.burstCapacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Check if we have tokens available
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get current token count for a client
   * @param clientId - Unique identifier for the client
   * @returns Number of tokens available
   */
  getTokens(clientId: string): number {
    const bucket = this.buckets.get(clientId);
    if (!bucket) return this.burstCapacity;

    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = (elapsedMs / this.refillIntervalMs) * this.refillRate;
    return Math.min(this.burstCapacity, bucket.tokens + tokensToAdd);
  }

  /**
   * Clean up stale entries that haven't been used recently
   */
  cleanup(): void {
    const now = Date.now();
    for (const [clientId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > this.staleAfterMs) {
        this.buckets.delete(clientId);
      }
    }
  }

  /**
   * Get the number of tracked clients
   */
  getClientCount(): number {
    return this.buckets.size;
  }

  /**
   * Reset the rate limiter for a specific client or all clients
   * @param clientId - Optional client ID to reset. If omitted, resets all clients
   */
  reset(clientId?: string): void {
    if (clientId) {
      this.buckets.delete(clientId);
    } else {
      this.buckets.clear();
    }
  }
}

// Factory function to create a rate limiter instance
export function createRateLimiter(options: RateLimiterOptions) {
  return new TokenBucketRateLimiter(options);
}

// Export types for external use
export type { TokenBucket, RateLimiterOptions };
