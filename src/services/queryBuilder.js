/**
 * QueryBuilder — Upgraded with LLM Operator Support + Incremental Scanning
 *
 * Supports all original operators PLUS:
 *   gt → >    lt → <    eq → =    ne → !=
 *   contains → ILIKE '%val%'
 *   not_contains → NOT ILIKE '%val%'
 *   regex → ~
 *   between → BETWEEN x AND y
 *
 * Incremental scan: appends AND "id" > last_known_id when rule.last_scanned_at is set.
 * Exclusion conditions: appends HITL feedback SQL conditions when present.
 * Audit log: every built query is logged to query_audit_log table.
 */

const { query: dbQuery } = require('../config/database');
const { generateText } = require('./geminiClient');

// ── Field mapping: friendly names → IBM AML column names ─────────────────────
const FIELD_MAP = {
  amount_paid: '"Amount Paid"',
  amount_received: '"Amount Received"',
  payment_format: '"Payment Format"',
  receiving_currency: '"Receiving Currency"',
  payment_currency: '"Payment Currency"',
  is_laundering: '"Is Laundering"',
  from_bank: '"From Bank"',
  to_bank: '"To Bank"',
  from_account: '"Account"',
  to_account: '"Account.1"',
  timestamp: '"Timestamp"',
};

const resolveField = (field) => FIELD_MAP[field] || `"${field}"`;

// ── LLM operator aliases → SQL ────────────────────────────────────────────────
const OPERATOR_MAP = {
  // New LLM-style aliases
  gt: '>', lt: '<', eq: '=', ne: '!=',
  gte: '>=', lte: '<=',
  // Passthrough SQL operators (existing keyword parser output)
  '>': '>', '<': '<', '=': '=', '!=': '!=',
  '>=': '>=', '<=': '<=',
};

/**
 * Ask Gemini to generate a WHERE clause condition for a context string.
 * e.g. context = "only for international transfers"
 * → returns: "Receiving Currency" != "Payment Currency"
 */
const getLLMContextClause = async (context) => {
  if (!context) return null;
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    return null;
  }

  try {
    const prompt = `You are a SQL WHERE clause generator for an IBM AML transactions table.
Available columns: "Amount Paid", "Amount Received", "Payment Format", "Receiving Currency", "Payment Currency", "Is Laundering", "From Bank", "To Bank", "Account", "Account.1", "Timestamp".

Context to translate into SQL: "${context}"

Return ONLY the SQL WHERE condition (no WHERE keyword, no semicolon). Example: "Receiving Currency" != "Payment Currency"`;

    const clause = (await generateText(prompt)).trim().replace(/^WHERE\s+/i, '').replace(/;$/, '').trim();
    console.log(`[QUERY] LLM context clause for "${context}": ${clause}`);
    return clause;
  } catch (err) {
    console.error('[QUERY] LLM context clause error:', err.message);
    return null;
  }
};

/**
 * Build a SQL query from a policy_rule record.
 * Handles all rule types, new LLM operators, incremental scanning, and HITL exclusions.
 *
 * @param {object} rule - policy_rules DB row
 * @returns {{ sql: string, params: Array }}
 */
const buildQueryForRule = async (rule) => {
  const {
    id: ruleId,
    rule_type,
    field,
    operator,
    threshold,
    threshold_secondary,
    extra_conditions,
    last_scanned_at,
    exclusion_conditions,
    context,
  } = rule;

  let whereClause = '';
  let params = [];
  let paramIndex = 1;

  // ── Core condition ──────────────────────────────────────────────────────────
  if (rule_type === 'pattern' && extra_conditions && Object.keys(extra_conditions).length > 0) {
    const conditions = Object.entries(extra_conditions)
      .map(([col, val]) => {
        params.push(val);
        return `${resolveField(col)} = $${paramIndex++}`;
      })
      .join(' AND ');
    whereClause = conditions;

  } else if (operator === 'between') {
    params.push(threshold, threshold_secondary);
    whereClause = `${resolveField(field)} BETWEEN $${paramIndex++} AND $${paramIndex++}`;

  } else if (operator === 'contains') {
    params.push(`%${threshold}%`);
    whereClause = `${resolveField(field)} ILIKE $${paramIndex++}`;

  } else if (operator === 'not_contains') {
    params.push(`%${threshold}%`);
    whereClause = `${resolveField(field)} NOT ILIKE $${paramIndex++}`;

  } else if (operator === 'regex') {
    params.push(threshold);
    whereClause = `${resolveField(field)} ~ $${paramIndex++}`;

  } else {
    // Standard numeric/equality operators (original + LLM aliases)
    const sqlOp = OPERATOR_MAP[operator] || operator;
    if (!['>', '<', '>=', '<=', '=', '!='].includes(sqlOp)) {
      throw new Error(`Unsupported operator: ${operator}`);
    }
    params.push(threshold);
    whereClause = `${resolveField(field)} ${sqlOp} $${paramIndex++}`;
  }

  // ── LLM Context clause (e.g. "only for international transfers") ─────────────
  const contextClause = await getLLMContextClause(context);
  if (contextClause) {
    whereClause += ` AND (${contextClause})`;
  }

  // ── Incremental scanning: only scan records newer than last_scanned_at ───────
  if (last_scanned_at) {
    params.push(last_scanned_at);
    whereClause += ` AND "Timestamp" > $${paramIndex++}`;
  }

  // ── HITL exclusion conditions (feedback loop) ────────────────────────────────
  if (exclusion_conditions && exclusion_conditions.trim()) {
    whereClause += ` AND NOT (${exclusion_conditions})`;
  }

  const sql = `
    SELECT *
    FROM transactions
    WHERE ${whereClause}
    ORDER BY "Timestamp" DESC
  `;

  // ── Audit log: write every query to query_audit_log ─────────────────────────
  try {
    await dbQuery(
      `INSERT INTO query_audit_log (rule_id, generated_sql, params) VALUES ($1, $2, $3)`,
      [ruleId || null, sql.trim(), JSON.stringify(params)]
    ).catch(() => { }); // non-blocking, best-effort
  } catch (_) { }

  return { sql, params };
};

module.exports = { buildQueryForRule };
