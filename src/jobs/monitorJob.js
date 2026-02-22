/**
 * Monitor Job — Cron-Based Scheduler
 *
 * UPGRADED: The cron is now a pure SCHEDULER.
 * It enqueues all rule jobs into the ScanQueue instead of running scans directly.
 * Workers pick up and process individual rule jobs with concurrency.
 *
 * Legacy direct runScan() is still available and called from scanRoutes for manual scans.
 */

const cron = require('node-cron');
const { query } = require('../config/database');
const { enqueueAllRules } = require('./scanWorker');

const DEFAULT_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *'; // every hour

let cronTask = null;

const startMonitoring = () => {
  if (cronTask) {
    console.log('[CRON] Monitoring already running.');
    return;
  }

  console.log(`[CRON] Starting PolicyGuard monitoring with schedule: "${DEFAULT_SCHEDULE}"`);

  cronTask = cron.schedule(DEFAULT_SCHEDULE, async () => {
    console.log(`\n[CRON] ⏰ Scheduled scan triggered at ${new Date().toISOString()}`);

    let logId;
    try {
      const logEntry = await query(
        `INSERT INTO scan_logs (triggered_by, status, started_at)
         VALUES ('cron', 'running', NOW())
         RETURNING id`
      );
      logId = logEntry.rows[0].id;
    } catch (dbErr) {
      console.error('[CRON] Failed to create scan log:', dbErr.message);
      return;
    }

    try {
      // ── NEW: enqueue all rule jobs into the distributed worker queue ──────
      // The cron is now a pure SCHEDULER — workers do the actual scanning.
      const jobCount = await enqueueAllRules(null, logId);

      console.log(`[CRON] ✅ Enqueued ${jobCount} rule job(s) into scan queue. Log ID: ${logId}`);

      // Mark log as 'queued' — jobs complete asynchronously
      await query(
        `UPDATE scan_logs SET status = 'queued', completed_at = NOW() WHERE id = $1`,
        [logId]
      );
    } catch (err) {
      console.error('[CRON] ❌ Failed to enqueue scan jobs:', err.message);
      try {
        await query(
          `UPDATE scan_logs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
          [err.message, logId]
        );
      } catch (_) { }
    }
  });

  console.log('[CRON] Monitoring started.');
};

const stopMonitoring = () => {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log('[CRON] Monitoring stopped.');
  }
};

module.exports = { startMonitoring, stopMonitoring };
