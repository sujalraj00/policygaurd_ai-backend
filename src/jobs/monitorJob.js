const cron = require('node-cron');
const { runScan } = require('../services/scanService');
const { query } = require('../config/database');

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

    const logEntry = await query(
      `INSERT INTO scan_logs (triggered_by, status, started_at)
       VALUES ('cron', 'running', NOW())
       RETURNING id`
    );
    const logId = logEntry.rows[0].id;

    try {
      const result = await runScan();

      const { violations, rulesScanned, policiesScanned, durationMs } = result;

      const truePositives = violations.filter((v) => v.label === 'true_positive').length;
      const falsePositives = violations.filter((v) => v.label === 'false_positive').length;

      console.log(`[CRON] ✅ Scan complete:`);
      console.log(`       Policies scanned : ${policiesScanned}`);
      console.log(`       Rules evaluated  : ${rulesScanned}`);
      console.log(`       Total violations : ${violations.length}`);
      console.log(`       True positives   : ${truePositives}`);
      console.log(`       False positives  : ${falsePositives}`);
      console.log(`       Duration         : ${durationMs}ms`);

      await query(
        `UPDATE scan_logs
         SET total_violations = $1, policies_scanned = $2, duration_ms = $3,
             status = 'success', completed_at = NOW()
         WHERE id = $4`,
        [violations.length, policiesScanned, durationMs, logId]
      );
    } catch (err) {
      console.error('[CRON] ❌ Scan failed:', err.message);
      await query(
        `UPDATE scan_logs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, logId]
      );
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
