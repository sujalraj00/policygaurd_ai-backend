const express = require('express');
const router = express.Router();
const { runScan } = require('../services/scanService');
const { query } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// POST /scan — trigger a manual scan (all policies or one)
// Body: { policy_id?: UUID }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { policy_id } = req.body;

  try {
    const logEntry = await query(
      `INSERT INTO scan_logs (triggered_by, status, started_at)
       VALUES ('manual', 'running', NOW())
       RETURNING id`
    );
    const logId = logEntry.rows[0].id;

    console.log(`[SCAN] Async manual scan triggered${policy_id ? ` for policy ${policy_id}` : ' for ALL policies'}. Log ID: ${logId}`);

    // Return 202 Accepted immediately
    res.status(202).json({
      success: true,
      message: 'Scan started processing in the background.',
      scan_log_id: logId,
      status: 'running'
    });

    // Run the actual scan in the background
    // We do not await this, so the response is sent immediately.
    runScanBackground(policy_id || null, logId);

  } catch (err) {
    console.error('[SCAN] Error initializing scan:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Helper function to run the scan in the background and update the DB
const runScanBackground = async (policy_id, logId) => {
  try {
    const result = await runScan(policy_id);

    await query(
      `UPDATE scan_logs
       SET total_violations = $1, policies_scanned = $2, duration_ms = $3,
           status = 'success', completed_at = NOW()
       WHERE id = $4`,
      [result.violations.length, result.policiesScanned, result.durationMs, logId]
    );
    console.log(`[SCAN] Background scan ${logId} completed successfully.`);
  } catch (err) {
    await query(
      `UPDATE scan_logs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [err.message, logId]
    );
    console.error(`[SCAN] Background scan ${logId} failed:`, err.message);
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /scan/logs — recent scan history
// ─────────────────────────────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await query(
      'SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT $1',
      [limit]
    );
    return res.json({ success: true, logs: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /scan/logs/:id — check specific scan status (polling endpoint)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/logs/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM scan_logs WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Scan log not found' });
    }

    return res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
