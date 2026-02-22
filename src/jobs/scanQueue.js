/**
 * Scan Queue — Lightweight In-Memory Job Queue
 * No Redis required. Each policy rule becomes an independent job.
 * Workers pick up jobs and process them concurrently (up to CONCURRENCY).
 *
 * Job lifecycle: pending → running → complete | failed
 */

const EventEmitter = require('events');

const CONCURRENCY = 3; // max parallel rule workers

class ScanQueue extends EventEmitter {
    constructor() {
        super();
        this._pending = [];  // jobs waiting to start
        this._running = [];  // currently executing jobs
        this._completed = [];  // finished jobs (capped at 200 for memory)
        this._failed = [];  // failed jobs (capped at 100)
        this._worker = null;
        this._active = 0;
    }

    /**
     * Register the worker function that processes a single job.
     * @param {Function} fn  async fn(job) → resolves when job is done
     */
    process(fn) {
        this._worker = fn;
        this._tick();
    }

    /**
     * Add a rule job to the queue.
     * @param {object} job - { id, ruleId, ruleName, policyId, logId }
     */
    add(job) {
        const jobEntry = {
            ...job,
            status: 'pending',
            addedAt: new Date().toISOString(),
            startedAt: null,
            endedAt: null,
            error: null,
        };
        this._pending.push(jobEntry);
        this.emit('job:added', jobEntry);
        this._tick();
        return jobEntry;
    }

    /**
     * Drain: process all pending jobs and return a promise that resolves when done.
     */
    drain() {
        return new Promise(resolve => {
            if (this._pending.length === 0 && this._active === 0) {
                resolve();
                return;
            }
            const onDone = () => {
                if (this._pending.length === 0 && this._active === 0) {
                    this.off('job:complete', onDone);
                    this.off('job:failed', onDone);
                    resolve();
                }
            };
            this.on('job:complete', onDone);
            this.on('job:failed', onDone);
        });
    }

    /** Status snapshot for dashboard polling. */
    getStatus() {
        return {
            pending: this._pending.length,
            running: this._running.length,
            completed: this._completed.length,
            failed: this._failed.length,
            jobs: [
                ...this._running.map(j => ({ ...j })),
                ...this._pending.slice(0, 20).map(j => ({ ...j })),
                ...this._completed.slice(-10).map(j => ({ ...j })),
                ...this._failed.slice(-5).map(j => ({ ...j })),
            ],
        };
    }

    _tick() {
        if (!this._worker) return;
        while (this._active < CONCURRENCY && this._pending.length > 0) {
            const job = this._pending.shift();
            job.status = 'running';
            job.startedAt = new Date().toISOString();
            this._running.push(job);
            this._active++;

            this._worker(job)
                .then(() => {
                    job.status = 'complete';
                    job.endedAt = new Date().toISOString();
                    this._running = this._running.filter(j => j.id !== job.id);
                    this._completed.push(job);
                    if (this._completed.length > 200) this._completed.shift();
                    this._active--;
                    this.emit('job:complete', job);
                    this._tick();
                })
                .catch((err) => {
                    job.status = 'failed';
                    job.endedAt = new Date().toISOString();
                    job.error = err.message;
                    this._running = this._running.filter(j => j.id !== job.id);
                    this._failed.push(job);
                    if (this._failed.length > 100) this._failed.shift();
                    this._active--;
                    this.emit('job:failed', job, err);
                    this._tick();
                });
        }
    }
}

// Singleton queue instance used across the app
const scanQueue = new ScanQueue();

module.exports = { scanQueue };
