/**
 * Miranda Core — Health Tracker
 * Records success/failure events and exposes health status per model.
 */

export interface HealthStatus {
  modelId: string;
  totalCalls: number;
  successes: number;
  failures: number;
  successRate: number;
  lastCallTimestamp: number | null;
  lastError: string | null;
}

interface HealthRecord {
  totalCalls: number;
  successes: number;
  failures: number;
  lastCallTimestamp: number | null;
  lastError: string | null;
}

export class HealthTracker {
  private readonly records: Map<string, HealthRecord> = new Map();

  /**
   * Record a successful call to a model.
   */
  recordSuccess(modelId: string): void {
    const record = this.getOrCreate(modelId);
    record.totalCalls++;
    record.successes++;
    record.lastCallTimestamp = Date.now();
  }

  /**
   * Record a failed call to a model.
   */
  recordFailure(modelId: string, error: string): void {
    const record = this.getOrCreate(modelId);
    record.totalCalls++;
    record.failures++;
    record.lastCallTimestamp = Date.now();
    record.lastError = error;
  }

  /**
   * Get health status for a specific model.
   */
  getStatus(modelId: string): HealthStatus {
    const record = this.records.get(modelId) ?? {
      totalCalls: 0,
      successes: 0,
      failures: 0,
      lastCallTimestamp: null,
      lastError: null,
    };

    return {
      modelId,
      totalCalls: record.totalCalls,
      successes: record.successes,
      failures: record.failures,
      successRate:
        record.totalCalls > 0
          ? record.successes / record.totalCalls
          : 1,
      lastCallTimestamp: record.lastCallTimestamp,
      lastError: record.lastError,
    };
  }

  /**
   * Get health status for all tracked models.
   */
  getAllStatuses(): HealthStatus[] {
    return Array.from(this.records.keys()).map((id) => this.getStatus(id));
  }

  /**
   * Reset all health records.
   */
  reset(): void {
    this.records.clear();
  }

  private getOrCreate(modelId: string): HealthRecord {
    let record = this.records.get(modelId);
    if (!record) {
      record = {
        totalCalls: 0,
        successes: 0,
        failures: 0,
        lastCallTimestamp: null,
        lastError: null,
      };
      this.records.set(modelId, record);
    }
    return record;
  }
}
