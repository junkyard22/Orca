import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { createRateLimiter } from './rateLimiter';

// Mock Date.now for deterministic tests
vi.useFakeTimers();

describe('TokenBucket Rate Limiter', () => {
  let rateLimiter: ReturnType<typeof createRateLimiter>;

  beforeEach(() => {
    vi.clearAllTimers();
    // Reset to a known time
    vi.setSystemTime(0);
  });

  describe('Basic Rate Limiting', () => {
    it('should allow requests up to burst capacity', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      // Should allow first 5 requests
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.isAllowed('client1')).toBe(true);
      }

      // 6th request should be denied
      expect(rateLimiter.isAllowed('client1')).toBe(false);
    });

    it('should deny requests when bucket is empty', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 3,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      // Use up all tokens
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);

      // Should be denied
      expect(rateLimiter.isAllowed('client1')).toBe(false);
    });
  });

  describe('Token Refill', () => {
    it('should refill tokens over time', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 2,
        refillIntervalMs: 1000,
      });

      // Use all tokens
      for (let i = 0; i < 5; i++) {
        rateLimiter.isAllowed('client1');
      }

      // Advance time by 1000ms (should add 2 tokens)
      vi.setSystemTime(1000);

      // Should allow 2 more requests
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(false);
    });

    it('should partially refill tokens', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 10,
        refillRate: 4,
        refillIntervalMs: 1000,
      });

      // Use all tokens
      for (let i = 0; i < 10; i++) {
        rateLimiter.isAllowed('client1');
      }

      // Advance time by 500ms (should add 2 tokens)
      vi.setSystemTime(500);

      // Should allow 2 more requests
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(false);
    });
  });

  describe('Per-Client Isolation', () => {
    it('should track usage separately per client', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 3,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      // Client 1 uses all tokens
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(false);

      // Client 2 should still have full capacity
      expect(rateLimiter.isAllowed('client2')).toBe(true);
      expect(rateLimiter.isAllowed('client2')).toBe(true);
      expect(rateLimiter.isAllowed('client2')).toBe(true);
    });
  });

  describe('getTokens Method', () => {
    it('should return correct token count', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 10,
        refillRate: 2,
        refillIntervalMs: 1000,
      });

      // Initial state
      expect(rateLimiter.getTokens('client1')).toBe(10);

      // Use 3 tokens
      rateLimiter.isAllowed('client1');
      rateLimiter.isAllowed('client1');
      rateLimiter.isAllowed('client1');

      expect(rateLimiter.getTokens('client1')).toBe(7);

      // Advance time by 500ms (should add 1 token)
      vi.setSystemTime(500);
      expect(rateLimiter.getTokens('client1')).toBe(8);
    });

    it('should return burstCapacity for unknown client', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      expect(rateLimiter.getTokens('unknown')).toBe(5);
    });
  });

  describe('Cleanup Method', () => {
    it('should remove stale entries', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 1,
        refillIntervalMs: 1000,
        staleAfterMs: 10000, // 10 seconds
      });

      // Add some clients
      rateLimiter.isAllowed('client1');
      rateLimiter.isAllowed('client2');
      rateLimiter.isAllowed('client3');

      expect(rateLimiter.getClientCount()).toBe(3);

      // Advance time beyond stale threshold
      vi.setSystemTime(11000);

      // Cleanup should remove all entries
      rateLimiter.cleanup();
      expect(rateLimiter.getClientCount()).toBe(0);
    });

    it('should not remove active entries', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 1,
        refillIntervalMs: 1000,
        staleAfterMs: 10000,
      });

      rateLimiter.isAllowed('client1');

      // Advance time but not beyond threshold
      vi.setSystemTime(5000);

      rateLimiter.cleanup();
      expect(rateLimiter.getClientCount()).toBe(1);
    });
  });

  describe('Reset Method', () => {
    it('should reset specific client', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 3,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      rateLimiter.isAllowed('client1');
      rateLimiter.isAllowed('client1');
      rateLimiter.isAllowed('client1');

      // Reset client1
      rateLimiter.reset('client1');

      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
      expect(rateLimiter.isAllowed('client1')).toBe(true);
    });

    it('should reset all clients', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 3,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      rateLimiter.isAllowed('client1');
      rateLimiter.isAllowed('client2');

      rateLimiter.reset();

      expect(rateLimiter.getClientCount()).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero refill rate', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 0,
        refillIntervalMs: 1000,
      });

      // Use all tokens
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.isAllowed('client1')).toBe(true);
      }

      // Should remain denied
      expect(rateLimiter.isAllowed('client1')).toBe(false);

      // Advance time
      vi.setSystemTime(10000);
      expect(rateLimiter.isAllowed('client1')).toBe(false);
    });

    it('should handle zero burst capacity', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 0,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      expect(rateLimiter.isAllowed('client1')).toBe(false);
    });

    it('should handle multiple clients with different usage patterns', () => {
      rateLimiter = createRateLimiter({
        burstCapacity: 5,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      // Client 1: burst usage
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.isAllowed(`client${i}`)).toBe(true);
      }

      // Client 2: should have full capacity
      expect(rateLimiter.isAllowed('client2')).toBe(true);
    });
  });
});
