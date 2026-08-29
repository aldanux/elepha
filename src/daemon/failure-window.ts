import { FAILURE_RATE_THRESHOLD, FAILURE_WINDOW_MIN_SAMPLES, FAILURE_WINDOW_SIZE } from '../config/constants.js';
import type { SummarizerStatus } from '../types/index.js';

// Sustained-failure detection: a run like the 38-minute, 6,592-call
// unconfigured-API-key episode from the dogfooding period must surface as a
// warning, not scroll past as thousands of individually-unremarkable log
// lines. Edge-triggered (warns once on crossing into failure, once again on
// recovery) so it doesn't spam once already in the bad state.
export class FailureWindow {
    private readonly recentOutcomes: boolean[] = []; // true = failed (parse_error/api_error); empty_turn is excluded, it made no call
    private sustainedFailureActive = false;

    constructor(
        private readonly log: (message: string) => void,
        private readonly logError: (message: string) => void = log,
    ) {}

    trackOutcome(status: SummarizerStatus): void {
        if (status === 'empty_turn') {
            return; // no API call was made, not a signal either way
        }

        this.recentOutcomes.push(status !== 'ok');
        if (this.recentOutcomes.length > FAILURE_WINDOW_SIZE) {
            this.recentOutcomes.shift();
        }
        if (this.recentOutcomes.length < FAILURE_WINDOW_MIN_SAMPLES) {
            return;
        }

        const failureRate = this.recentOutcomes.filter(Boolean).length / this.recentOutcomes.length;
        if (failureRate >= FAILURE_RATE_THRESHOLD && !this.sustainedFailureActive) {
            this.sustainedFailureActive = true;
            this.logError(
                `[elepha] WARNING: summarizer failure rate ${(failureRate * 100).toFixed(0)}% over last ${this.recentOutcomes.length} calls - check API key / network / rate limits`,
            );
        } else if (failureRate < FAILURE_RATE_THRESHOLD && this.sustainedFailureActive) {
            this.sustainedFailureActive = false;
            this.log(`[elepha] summarizer failure rate recovered to ${(failureRate * 100).toFixed(0)}%`);
        }
    }
}
