const { query } = require('../config/database');
const { buildQueryForRule } = require('./queryBuilder');
const { generateExplanation } = require('./explanationService');

/**
 * Runs all active rules for a given policy (or all policies if policyId = null)
 * against the transactions table and stores violations.
 *
 * @param {string|null} policyId - UUID, or null to scan all policies
 * @returns {object} summary { violations, rulesScanned, policiesScanned }
 */
const runScan = async (policyId = null) => {
  const startTime = Date.now();

  // Fetch active rules
  let rulesQuery = `
    SELECT r.*, p.name AS policy_name
    FROM policy_rules r
    JOIN policies p ON p.id = r.policy_id
    WHERE r.is_active = TRUE AND p.status = 'active'
  `;
  const rulesParams = [];
  if (policyId) {
    rulesQuery += ' AND r.policy_id = $1';
    rulesParams.push(policyId);
  }

  const rulesResult = await query(rulesQuery, rulesParams);
  const rules = rulesResult.rows;

  if (rules.length === 0) {
    return { violations: [], rulesScanned: 0, policiesScanned: 0, durationMs: 0 };
  }

  const allViolations = [];
  const scannedPolicies = new Set();

  for (const rule of rules) {
    scannedPolicies.add(rule.policy_id);

    let sql, params;
    try {
      ({ sql, params } = buildQueryForRule(rule));
    } catch (err) {
      console.error(`[SCAN] Failed to build query for rule ${rule.rule_name}:`, err.message);
      continue;
    }

    let matchedRows;
    try {
      const result = await query(sql, params);
      matchedRows = result.rows;
    } catch (err) {
      console.error(`[SCAN] Query failed for rule ${rule.rule_name}:`, err.message);
      continue;
    }

    console.log(`[SCAN] Rule "${rule.rule_name}" matched ${matchedRows.length} transaction(s).`);

    for (const txn of matchedRows) {
      const { explanation, label, is_laundering, detected_value } = generateExplanation(rule, txn);

      // IBM AML has no transaction_id column — use serial id as identifier
      const txnIdentifier = String(txn['Account'] ? `${txn['Account']}-${txn.id}` : txn.id);

      // Upsert-style: avoid duplicate violations for same rule+transaction in same scan
      const existing = await query(
        `SELECT id FROM violations WHERE rule_id = $1 AND transaction_id = $2 LIMIT 1`,
        [rule.id, txnIdentifier]
      );

      let violationId;
      if (existing.rows.length > 0) {
        // Update existing violation (re-scan may update label/explanation)
        await query(
          `UPDATE violations SET explanation = $1, label = $2, is_laundering = $3, detected_at = NOW()
           WHERE id = $4`,
          [explanation, label, is_laundering, existing.rows[0].id]
        );
        violationId = existing.rows[0].id;
      } else {
        const ins = await query(
          `INSERT INTO violations 
             (rule_id, policy_id, transaction_id, detected_value, explanation, severity, label, is_laundering, raw_row)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            rule.id,
            rule.policy_id,
            txnIdentifier,
            detected_value,
            explanation,
            rule.severity,
            label,
            is_laundering,
            JSON.stringify(txn),
          ]
        );
        violationId = ins.rows[0].id;
      }

      allViolations.push({
        violation_id: violationId,
        rule_name: rule.rule_name,
        policy_name: rule.policy_name,
        transaction_id: txnIdentifier,
        label,
        severity: rule.severity,
        explanation,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  return {
    violations: allViolations,
    rulesScanned: rules.length,
    policiesScanned: scannedPolicies.size,
    durationMs,
  };
};

module.exports = { runScan };
