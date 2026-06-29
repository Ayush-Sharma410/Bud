/**
 * Bud — Action Queue
 *
 * Serialized queue that ensures only one Agent Task actuates at a time.
 * Multiple Agent Tasks can plan and reason in parallel (VLM calls are concurrent),
 * but physical actions (mouse moves, key presses) go through this queue
 * so they don't interfere with each other.
 *
 * FIFO ordering. Respects AbortSignal — if a task is aborted while
 * waiting in queue, the action is skipped.
 */

interface QueueEntry {
  action: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
}

export class ActionQueue {
  private queue: QueueEntry[] = [];
  private running = false;

  /**
   * Enqueue a physical action. Returns a promise that resolves with the
   * action's return value when executed (or rejects if aborted/errored).
   *
   * @param action The async function to execute (e.g., nut-js mouse.click)
   * @param signal Optional AbortSignal to cancel the action while queued
   */
  enqueue<T = void>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // If already aborted, skip immediately
      if (signal?.aborted) {
        reject(new Error('Action aborted before queuing'));
        return;
      }

      this.queue.push({ action, resolve, reject, signal });
      this.processNext();
    });
  }

  /**
   * Clear all pending actions from the queue.
   * Actions currently executing will finish, but nothing else will run.
   */
  clear() {
    const pending = this.queue.splice(0);
    for (const entry of pending) {
      entry.reject(new Error('Action queue cleared'));
    }
  }

  /**
   * Get the number of actions waiting in the queue.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  // --- Internal ---

  private async processNext() {
    if (this.running) return; // Already processing
    if (this.queue.length === 0) return; // Nothing to do

    this.running = true;

    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;

      // Skip if the task was aborted while waiting
      if (entry.signal?.aborted) {
        entry.reject(new Error('Action aborted while queued'));
        continue;
      }

      try {
        const result = await entry.action();
        entry.resolve(result);
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.running = false;
  }
}
