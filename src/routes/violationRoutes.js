const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { generateExclusion } = require('../services/feedbackService');

// ─────────────────────────────────────────────────────────────────────────────
// GET /violations — list all violations (with optional filters)
// Query params: policy_id, severity, label, limit, offset
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { policy_id, severity, label, confidence, limit = 50, offset = 0 } = req.query;

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
    // Confidence filter: high(>=0.7) | medium(0.4-0.7) | low(<0.4)
    if (confidence === 'high') {
      conditions.push(`v.confidence >= 0.7`);
    } else if (confidence === 'medium') {
      conditions.push(`v.confidence >= 0.4 AND v.confidence < 0.7`);
    } else if (confidence === 'low') {
      conditions.push(`(v.confidence < 0.4 OR v.confidence IS NULL)`);
    }

    const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT
         v.*,
         r.rule_name,
         r.rule_type,
         p.name AS policy_name,
         vr.action AS review_action,
         vr.note AS review_note,
         vr.reviewed_at,
         CASE
           WHEN v.confidence >= 0.7 THEN 'high'
           WHEN v.confidence >= 0.4 THEN 'medium'
           ELSE 'low'
         END AS confidence_band,
         CASE WHEN r.exclusion_conditions IS NOT NULL THEN true ELSE false END AS feedback_applied
       FROM violations v
       JOIN policy_rules r ON r.id = v.rule_id
       JOIN policies p ON p.id = v.policy_id
       LEFT JOIN violation_reviews vr ON vr.violation_id = v.id
       ${whereSQL}
       ORDER BY v.detected_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    // Flutter app expects a raw array
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /violations/:id/review — HITL human review action
// Body: { action: 'confirm'|'false_positive'|'escalate', note?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/review', async (req, res) => {
  try {
    const { action, note } = req.body;
    const validActions = ['confirm', 'false_positive', 'escalate'];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({
        success: false,
        error: `Invalid action. Must be one of: ${validActions.join(', ')}`,
      });
    }

    // Fetch the violation with rule + raw record
    const vRes = await query(
      `SELECT v.*, r.id AS rule_uuid, r.rule_name, r.description AS rule_desc,
              r.field, r.operator, r.threshold, r.policy_id
       FROM violations v
       JOIN policy_rules r ON r.id = v.rule_id
       WHERE v.id = $1`,
      [req.params.id]
    );
    if (vRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Violation not found' });
    }
    const violation = vRes.rows[0];

    // Insert into violation_reviews
    await query(
      `INSERT INTO violation_reviews (violation_id, action, note) VALUES ($1, $2, $3)`,
      [req.params.id, action, note || null]
    );

    // Update violation status to reflect review
    const statusMap = {
      confirm: 'confirmed',
      false_positive: 'false_positive',
      escalate: 'escalated',
    };
    await query(
      `UPDATE violations SET status = $1 WHERE id = $2`,
      [statusMap[action], req.params.id]
    );

    let exclusionSuggestion = null;

    // If false positive: generate LLM exclusion condition and apply to rule
    if (action === 'false_positive') {
      const rawRecord = violation.raw_row || {};
      const rule = {
        description: violation.rule_desc,
        rule_name: violation.rule_name,
        field: violation.field,
        operator: violation.operator,
        threshold: violation.threshold,
      };

      exclusionSuggestion = await generateExclusion(rule, rawRecord);

      if (exclusionSuggestion) {
        // Append new exclusion to any existing ones with AND
        await query(
          `UPDATE policy_rules
           SET exclusion_conditions = 
             CASE
               WHEN exclusion_conditions IS NULL OR exclusion_conditions = ''
               THEN $1
               ELSE exclusion_conditions || ' AND ' || $1
             END
           WHERE id = $2`,
          [exclusionSuggestion, violation.rule_uuid]
        );
      }
    }

    return res.json({
      success: true,
      message: `Violation reviewed as: ${action}`,
      action,
      exclusion_applied: exclusionSuggestion || null,
      feedback_applied: action === 'false_positive' && !!exclusionSuggestion,
    });
  } catch (err) {
    console.error('[REVIEW] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
