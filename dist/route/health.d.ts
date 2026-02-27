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
export declare class HealthTracker {
    private readonly records;
    /**
     * Record a successful call to a model.
     */
    recordSuccess(modelId: string): void;
    /**
     * Record a failed call to a model.
     */
    recordFailure(modelId: string, error: string): void;
    /**
     * Get health status for a specific model.
     */
    getStatus(modelId: string): HealthStatus;
    /**
     * Get health status for all tracked models.
     */
    getAllStatuses(): HealthStatus[];
    /**
     * Reset all health records.
     */
    reset(): void;
    private getOrCreate;
}
//# sourceMappingURL=health.d.ts.map