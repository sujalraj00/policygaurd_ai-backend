const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// GET /violations — list all violations (with optional filters)
// Query params: policy_id, severity, label, limit, offset
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { policy_id, severity, label, limit = 50, offset = 0 } = req.query;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (policy_id) {
      conditions.push(`v.policy_id = $${idx++}`);
      params.push(policy_id);
    }
    if (severity) {
      conditions.push(`v.severity = $${idx++}`);
      params.push(severity);
    }
    if (label) {
      conditions.push(`v.label = $${idx++}`);
      params.push(label);
    }

    const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT
         v.*,
         r.rule_name,
         r.rule_type,
         p.name AS policy_name
       FROM violations v
       JOIN policy_rules r ON r.id = v.rule_id
       JOIN policies p ON p.id = v.policy_id
       ${whereSQL}
       ORDER BY v.detected_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM violations v ${whereSQL}`,
      params
    );

    // The Flutter app strictly expects a raw array: [{ "id": "...", "rule_name": "...", "status": "pending" }]
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /violations/summary — aggregate stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE label = 'true_positive')  AS true_positives,
        COUNT(*) FILTER (WHERE label = 'false_positive') AS false_positives,
        COUNT(*) FILTER (WHERE severity = 'high')        AS high_severity,
        COUNT(*) FILTER (WHERE severity = 'medium')      AS medium_severity,
        COUNT(*) FILTER (WHERE severity = 'low')         AS low_severity,
        COUNT(*)                                          AS total
      FROM violations
    `);
    return res.json({ success: true, summary: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /violations/:id — single violation with full explanation
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT v.*, r.rule_name, r.rule_type, r.description AS rule_description, p.name AS policy_name
       FROM violations v
       JOIN policy_rules r ON r.id = v.rule_id
       JOIN policies p ON p.id = v.policy_id
       WHERE v.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Violation not found' });
    }
    return res.json({ success: true, violation: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /violations/:id — human review (update label/status)
// Body: { label?: string, status?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { label, status } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (label) {
      updates.push(`label = $${idx++}`);
      params.push(label);
    }
    if (status) {
      updates.push(`status = $${idx++}`);
      params.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE violations SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Violation not found' });
    }

    return res.json({ success: true, violation: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
