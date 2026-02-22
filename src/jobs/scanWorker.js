/**
 * Scan Worker — processes individual rule scan jobs from the ScanQueue.
 *
 * For each job:
 *  1. Build SQL via queryBuilder (upgraded with new operators)
 *  2. Run the query (incremental — only new records since last_scanned_at)
 *  3. Generate explanation + confidence score for each violation
 *  4. Write violations to DB
 *  5. Update rule.last_scanned_at and write scan_history row
 */

const { query } = require('../config/database');
const { buildQueryForRule } = require('../services/queryBuilder');
const { generateExplanation } = require('../services/explanationService');
const { scoreViolation } = require('../services/confidenceService');
const { scanQueue } = require('./scanQueue');

/**
 * Process a single rule job.
 */
const processRuleJob = async (job) => {
    const { ruleId, logId } = job;

    // Fetch the full rule object
    const ruleRes = await query(
        `SELECT r.*, p.name AS policy_name FROM policy_rules r
     JOIN policies p ON p.id = r.policy_id
     WHERE r.id = $1`,
        [ruleId]
    );
    if (ruleRes.rows.length === 0) {
        throw new Error(`Rule ${ruleId} not found`);
    }
    const rule = ruleRes.rows[0];
    const scanStart = new Date();

    console.log(`[WORKER] Processing rule: "${rule.rule_name}"`);

    let sql, params;
    try {
        ({ sql, params } = buildQueryForRule(rule));
    } catch (err) {
        console.error(`[WORKER] Failed to build query for rule ${rule.rule_name}:`, err.message);
        throw err;
    }

    let matchedRows;
    try {
        const result = await query(sql, params);
        matchedRows = result.rows;
    } catch (err) {
        console.error(`[WORKER] Query failed for rule ${rule.rule_name}:`, err.message);
        throw err;
    }

    console.log(`[WORKER] Rule "${rule.rule_name}" matched ${matchedRows.length} record(s).`);

    let violationsFound = 0;
    for (const txn of matchedRows) {
        try {
            const { explanation, label, is_laundering, detected_value } = generateExplanation(rule, txn);

            // Score confidence via Gemini
            const { confidence, reasoning } = await scoreViolation(rule, txn);

            const txnIdentifier = String(txn['Account'] ? `${txn['Account']}-${txn.id}` : txn.id);

            // Upsert violation
            const existing = await query(
                `SELECT id FROM violations WHERE rule_id = $1 AND transaction_id = $2 LIMIT 1`,
                [rule.id, txnIdentifier]
            );

            if (existing.rows.length > 0) {
                await query(
                    `UPDATE violations
           SET explanation = $1, label = $2, is_laundering = $3,
               confidence = $4, confidence_reasoning = $5, detected_at = NOW()
           WHERE id = $6`,
                    [explanation, label, is_laundering, confidence, reasoning, existing.rows[0].id]
                );
            } else {
                await query(
                    `INSERT INTO violations
             (rule_id, policy_id, transaction_id, detected_value, explanation, severity,
              label, is_laundering, raw_row, confidence, confidence_reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
                        confidence,
                        reasoning,
                    ]
                );
                violationsFound++;
            }
        } catch (err) {
            console.error(`[WORKER] Error saving violation for txn in rule ${rule.rule_name}:`, err.message);
        }
    }

    // Update last_scanned_at for incremental scanning
    await query(
        `UPDATE policy_rules SET last_scanned_at = NOW() WHERE id = $1`,
        [rule.id]
    );

    // Write scan_history row
    await query(
        `INSERT INTO scan_history (rule_id, scan_start, scan_end, records_scanned, violations_found)
     VALUES ($1, $2, NOW(), $3, $4)`,
        [rule.id, scanStart, matchedRows.length, violationsFound]
    );

    console.log(`[WORKER] Rule "${rule.rule_name}" done. ${violationsFound} new violation(s) saved.`);
};

/**
 * Register the processRuleJob function as the queue's worker handler.
 * Called once at server startup from server.js.
 */
const startWorkers = () => {
    scanQueue.process(processRuleJob);
    console.log('[WORKER] Scan worker registered on queue (concurrency: 3).');
};

/**
 * Enqueue all active rules for a given policy (or all active policies).
 * @param {string|null} policyId
 * @param {string|null} logId   - associated scan_logs row id
 * @returns {number} number of jobs enqueued
 */
const enqueueAllRules = async (policyId = null, logId = null) => {
    let rulesQuery = `
    SELECT r.id, r.rule_name, r.policy_id
    FROM policy_rules r
    JOIN policies p ON p.id = r.policy_id
    WHERE r.is_active = TRUE AND p.status = 'active'
  `;
    const params = [];
    if (policyId) {
        rulesQuery += ' AND r.policy_id = $1';
        params.push(policyId);
    }

    const rulesRes = await query(rulesQuery, params);
    const rules = rulesRes.rows;

    for (const rule of rules) {
        scanQueue.add({
            id: `${rule.id}-${Date.now()}`,
            ruleId: rule.id,
            ruleName: rule.rule_name,
            policyId: rule.policy_id,
            logId,
        });
    }

    console.log(`[WORKER] Enqueued ${rules.length} rule job(s).`);
    return rules.length;
};

module.exports = { startWorkers, enqueueAllRules };
