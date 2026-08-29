export class WorkQueue {
    private readonly queue: Array<() => Promise<void>> = [];
    private active = 0;

    constructor(
        private readonly maxConcurrent: number,
        log: (message: string) => void,
        private readonly logError: (message: string) => void = log,
    ) {}

    enqueue(job: () => Promise<void>): void {
        this.queue.push(job);
        this.drain();
    }

    private drain(): void {
        while (this.active < this.maxConcurrent && this.queue.length > 0) {
            // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 just checked above
            const job = this.queue.shift()!;
            this.active++;
            job()
                .catch((err: unknown) => this.logError(`[elepha] job failed: ${(err as Error).message}`))
                .finally(() => {
                    this.active--;
                    this.drain();
                });
        }
    }
}
