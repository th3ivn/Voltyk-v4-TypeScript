import type { BroadcastJob } from '../types/domain.js';

interface QueueOptions {
  delayMs?: number;
  maxAttempts?: number;
  onJobError?: (error: unknown, job: BroadcastJob) => void;
}

export class BroadcastQueue {
  private readonly jobs: BroadcastJob[] = [];
  private readonly seenKeys = new Set<string>();
  private processing = false;
  private readonly delayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly onJob: (job: BroadcastJob) => Promise<void>,
    options: QueueOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 65;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.onJobError = options.onJobError;
  }

  private readonly onJobError?: (error: unknown, job: BroadcastJob) => void;

  enqueue(job: Omit<BroadcastJob, 'attempts'>): void {
    if (this.seenKeys.has(job.dedupKey)) {
      return;
    }

    this.seenKeys.add(job.dedupKey);
    this.jobs.push({ ...job, attempts: 0 });

    if (!this.processing) {
      this.processing = true;
      void this.process();
    }
  }

  private async process(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) {
        continue;
      }

      try {
        await this.onJob(job);
      } catch (error) {
        this.onJobError?.(error, job);
        if (job.attempts + 1 < this.maxAttempts) {
          this.jobs.push({ ...job, attempts: job.attempts + 1 });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    this.processing = false;
  }
}
