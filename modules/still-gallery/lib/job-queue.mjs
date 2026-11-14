/**
 * A generation queue with configurable parallelism.
 *
 * Why a queue at all: every call to the image endpoint costs money and occupies
 * a slot upstream, so firing twenty of them from twenty browser tabs is a good
 * way to collect 429s and pay for timeouts. The queue caps how many requests
 * are in flight at once and keeps the rest waiting in a visible, cancellable
 * list.
 *
 * Concurrency is a knob, not a constant. It used to be pinned at 1; with a
 * console that enqueues on every click, one-at-a-time turns a batch of six into
 * a six-minute wait for no reason. The ceiling lives in settings and is clamped
 * by `setConcurrency`, because the safe value depends on the upstream account's
 * quota, which this process cannot see.
 *
 * Deliberate limits:
 *
 *   - Cancelling is only allowed while a job is still `queued`. Once a job is
 *     `running` the upstream request has already been sent and will be billed,
 *     so aborting it would throw away the spend without refunding it. The API
 *     refuses instead of pretending otherwise. Lowering the concurrency does
 *     **not** stop jobs already running, for the same reason.
 *   - Jobs live in memory only. A restart loses the queue; it does **not** lose
 *     money, because nothing has been sent for jobs that never started.
 *   - `job.input` may hold base64 reference images (up to 10 MB each). It is
 *     needed while the job runs and is released the moment it settles, and
 *     `snapshot()` never exposes it — only a small `label` does.
 *
 * The module knows nothing about Ark or HTTP: `run` is injected, which is also
 * what lets the test suite drive it with a stub and spend nothing.
 */

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'canceled'];
/** Statuses that will never change again. */
export const SETTLED_STATUSES = new Set(['done', 'failed', 'canceled']);
/** Hard ceiling on `concurrency`. Above this the upstream quota is the real limit. */
export const MAX_CONCURRENCY = 32;

export class QueueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'QueueError';
    this.status = status;
  }
}

const MAX_HISTORY = 60;
const MAX_PENDING = 50;
const MAX_ERROR_CHARS = 400;

function clampText(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 1..MAX_CONCURRENCY 的整数；非法值一律回落到 1，绝不留下 0 并发这种死锁。 */
export function normalizeConcurrency(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(number, MAX_CONCURRENCY);
}

/**
 * @param {object} options
 * @param {(job: object) => Promise<object>} options.run  performs one job
 * @param {number} [options.concurrency]  how many jobs may run at once
 * @param {number} [options.maxPending]  queued+running ceiling
 * @param {number} [options.maxHistory]  settled jobs kept in the list
 * @param {() => void} [options.onChange]  called after any state transition
 */
export function createJobQueue(options = {}) {
  const run = options.run;
  if (typeof run !== 'function') throw new TypeError('createJobQueue requires a run() function');
  const maxPending = Number.isFinite(options.maxPending) && options.maxPending > 0
    ? Math.floor(options.maxPending)
    : MAX_PENDING;
  const maxHistory = Number.isFinite(options.maxHistory) && options.maxHistory > 0
    ? Math.floor(options.maxHistory)
    : MAX_HISTORY;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let concurrency = normalizeConcurrency(options.concurrency ?? 1);

  /** Oldest first — the list doubles as the FIFO order. @type {Array<object>} */
  const jobs = [];
  /** How many jobs are in flight right now. */
  let running = 0;
  let paused = false;
  let sequence = 0;
  let idleWaiters = [];

  function notify() {
    try {
      onChange();
    } catch {
      /* a listener must never break the queue */
    }
  }

  function pendingCount() {
    return jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  }

  /** Drop the oldest settled jobs once the history ceiling is exceeded. */
  function prune() {
    let overflow = jobs.length - maxHistory;
    for (let index = 0; index < jobs.length && overflow > 0; ) {
      if (SETTLED_STATUSES.has(jobs[index].status)) {
        jobs.splice(index, 1);
        overflow -= 1;
      } else {
        index += 1;
      }
    }
  }

  function resolveIdleIfDone() {
    if (running > 0 || jobs.some((job) => job.status === 'queued')) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function releasePayload(job) {
    // Reference images can be megabytes of base64 each; nothing reads them once
    // the job has settled, so do not keep them alive for the history window.
    if (job.input && job.input.referenceImages) {
      job.input = { ...job.input, referenceImages: [] };
    }
  }

  function snapshotJob(job) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      error: job.error,
      label: { ...job.label },
      // Never the input: it can carry base64 reference images.
      result: job.result
        ? {
            model: job.result.model,
            generatedAt: job.result.generatedAt,
            request: job.result.request,
            images: job.result.images.map((image) => ({ ...image })),
          }
        : null,
    };
  }

  /**
   * Start queued jobs until the in-flight count reaches `concurrency`.
   *
   * `start()` bumps `running` before its first `await`, so this loop sees the
   * updated count on the next iteration and never overshoots the limit.
   */
  function pump() {
    if (!paused) {
      while (running < concurrency) {
        const next = jobs.find((job) => job.status === 'queued');
        if (!next) break;
        void start(next);
      }
    }
    resolveIdleIfDone();
  }

  async function start(job) {
    running += 1;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    notify();

    const startedAt = Date.now();
    try {
      const result = await run(job);
      job.status = 'done';
      job.result = result || null;
      job.error = '';
    } catch (error) {
      job.status = 'failed';
      job.result = null;
      job.error = clampText(error && error.message ? error.message : String(error), MAX_ERROR_CHARS);
    } finally {
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAt;
      releasePayload(job);
      running -= 1;
      prune();
      notify();
      // Recurse rather than loop: a long chain of jobs would otherwise hold the
      // stack, and each transition must be observable.
      void pump();
    }
  }

  return {
    /**
     * Append a job. Validation happens in the caller, *before* this point, so a
     * malformed request never enters the queue and never costs anything.
     */
    enqueue(input, label = {}) {
      if (pendingCount() >= maxPending) {
        throw new QueueError(`队列已满（最多 ${maxPending} 个待处理任务），请等前面的任务完成`, 429);
      }
      sequence += 1;
      const job = {
        id: `job-${Date.now().toString(36)}-${sequence.toString(36)}`,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: '',
        finishedAt: '',
        durationMs: null,
        error: '',
        input,
        label: {
          model: clampText(label.model, 120),
          mode: clampText(label.mode, 40),
          size: clampText(label.size, 40),
          group: Boolean(label.group),
          maxImages: Number(label.maxImages) || 1,
          referenceCount: Number(label.referenceCount) || 0,
          promptPreview: clampText(label.promptPreview, 160),
          // The full prompt, because importing a finished job has to store the
          // prompt that actually produced it. Truncating it here would silently
          // corrupt the association the whole gallery exists to keep.
          prompt: String(label.prompt ?? '').slice(0, 8000),
        },
        result: null,
      };
      jobs.push(job);
      prune();
      notify();
      void pump();
      return snapshotJob(job);
    },

    /** Cancel a job that has not started. A running job is already billed. */
    cancel(id) {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new QueueError('任务不存在', 404);
      if (job.status === 'running') {
        throw new QueueError('任务已开始执行，上游已经受理并计费，无法取消', 409);
      }
      if (SETTLED_STATUSES.has(job.status)) {
        throw new QueueError('任务已经结束，无法取消', 409);
      }
      job.status = 'canceled';
      job.finishedAt = new Date().toISOString();
      job.durationMs = 0;
      releasePayload(job);
      notify();
      resolveIdleIfDone();
      return snapshotJob(job);
    },

    /** Remove one settled job from the list. */
    remove(id) {
      const index = jobs.findIndex((item) => item.id === id);
      if (index === -1) throw new QueueError('任务不存在', 404);
      if (!SETTLED_STATUSES.has(jobs[index].status)) {
        throw new QueueError('只能移除已经结束的任务，请先取消', 409);
      }
      const [removed] = jobs.splice(index, 1);
      notify();
      return snapshotJob(removed);
    },

    /** Drop every settled job. Returns how many were removed. */
    clearFinished() {
      let removed = 0;
      for (let index = jobs.length - 1; index >= 0; index -= 1) {
        if (SETTLED_STATUSES.has(jobs[index].status)) {
          jobs.splice(index, 1);
          removed += 1;
        }
      }
      notify();
      return removed;
    },

    /** Pausing stops new jobs from starting; the running ones always finish. */
    setPaused(value) {
      paused = Boolean(value);
      notify();
      if (!paused) void pump();
      return paused;
    },

    get paused() {
      return paused;
    },

    /**
     * Change the parallelism. Raising it starts more jobs immediately; lowering
     * it only affects jobs that have not started yet — the ones already in
     * flight are billed and must be allowed to finish.
     */
    setConcurrency(value) {
      concurrency = normalizeConcurrency(value);
      notify();
      void pump();
      return concurrency;
    },

    get concurrency() {
      return concurrency;
    },

    /** A serialisable view — this is exactly what the API returns. */
    snapshot() {
      return {
        paused,
        concurrency,
        running: jobs.filter((job) => job.status === 'running').length,
        pending: jobs.filter((job) => job.status === 'queued').length,
        settled: jobs.filter((job) => SETTLED_STATUSES.has(job.status)).length,
        maxPending,
        jobs: jobs.map(snapshotJob).reverse(),
      };
    },

    /** Resolves once nothing is running and nothing is waiting. Used by tests. */
    whenIdle() {
      if (running === 0 && !jobs.some((job) => job.status === 'queued')) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
