const WINDOW_SIZE = 100; // Keep the last 100 samples for the running average

interface OperationWindowStats {
    samples: number[];
}

export class Performance {
    private timings: Map<string, OperationWindowStats> = new Map();
    private startTimes: Map<string, number> = new Map();

    public start(name: string): number {
        const now = performance.now();
        this.startTimes.set(name, now);
        return now;
    }

    public stop(name: string, startTime?: number): void {
        if (startTime === undefined) {
            startTime = this.startTimes.get(name);
            if (startTime === undefined) {
                return;
            }
            this.startTimes.delete(name);
        }
        this.record(name, performance.now() - startTime);
    }

    public record(name: string, duration: number): void {
        let stats = this.timings.get(name);
        if (!stats) {
            stats = { samples: [] };
            this.timings.set(name, stats);
        }

        stats.samples.push(duration);

        // Keep the window size capped by removing the oldest sample.
        if (stats.samples.length > WINDOW_SIZE) {
            stats.samples.shift();
        }
    }

    public time<T>(name: string, fn: () => T): T {
        const startTime = performance.now();
        try {
            return fn();
        } finally {
            this.record(name, performance.now() - startTime);
        }
    }

    public async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const startTime = performance.now();
        try {
            return await fn();
        } finally {
            this.record(name, performance.now() - startTime);
        }
    }

    public getReport(): string {
        let report = '--- LSP Performance Stats (Running Window) ---\n';
        if (this.timings.size === 0) {
            return report + 'No operations have been timed yet.\n';
        }

        const sortedTimings = Array.from(this.timings.entries()).sort(
            (a, b) => a[0].localeCompare(b[0])
        );

        for (const [name, stats] of sortedTimings) {
            const sampleCount = stats.samples.length;
            if (sampleCount === 0) {
                continue;
            }

            const sum = stats.samples.reduce((a, b) => a + b, 0);
            const avg = sum / sampleCount;
            const min = Math.min(...stats.samples);
            const max = Math.max(...stats.samples);
            
            report += `Operation: ${name}\n`;
            report += `  Samples: ${sampleCount} (last ${WINDOW_SIZE})\n`;
            report += `  Min:     ${min.toFixed(2)} ms\n`;
            report += `  Max:     ${max.toFixed(2)} ms\n`;
            report += `  Avg:     ${avg.toFixed(2)} ms\n\n`;
        }
        return report;
    }

    public clear(): void {
        this.timings.clear();
        this.startTimes.clear();
    }
}
