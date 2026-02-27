/**
 * Miranda Core — Health Tracker
 * Records success/failure events and exposes health status per model.
 */
export class HealthTracker {
    records = new Map();
    /**
     * Record a successful call to a model.
     */
    recordSuccess(modelId) {
        const record = this.getOrCreate(modelId);
        record.totalCalls++;
        record.successes++;
        record.lastCallTimestamp = Date.now();
    }
    /**
     * Record a failed call to a model.
     */
    recordFailure(modelId, error) {
        const record = this.getOrCreate(modelId);
        record.totalCalls++;
        record.failures++;
        record.lastCallTimestamp = Date.now();
        record.lastError = error;
    }
    /**
     * Get health status for a specific model.
     */
    getStatus(modelId) {
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
            successRate: record.totalCalls > 0
                ? record.successes / record.totalCalls
                : 1,
            lastCallTimestamp: record.lastCallTimestamp,
            lastError: record.lastError,
        };
    }
    /**
     * Get health status for all tracked models.
     */
    getAllStatuses() {
        return Array.from(this.records.keys()).map((id) => this.getStatus(id));
    }
    /**
     * Reset all health records.
     */
    reset() {
        this.records.clear();
    }
    getOrCreate(modelId) {
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
//# sourceMappingURL=health.js.map