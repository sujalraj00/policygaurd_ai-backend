/**
 * IBM AML dataset uses quoted column names with spaces:
 *   "Amount Paid", "Payment Format", "Is Laundering", "Timestamp", etc.
 *
 * This map lets rule authors use friendly snake_case field names in the DB
 * and we resolve them to the real IBM column name here.
 */
const FIELD_MAP = {
  // Friendly name          → IBM CSV column name (quoted for PostgreSQL)
  amount_paid:              '"Amount Paid"',
  amount_received:          '"Amount Received"',
  payment_format:           '"Payment Format"',
  receiving_currency:       '"Receiving Currency"',
  payment_currency:         '"Payment Currency"',
  is_laundering:            '"Is Laundering"',
  from_bank:                '"From Bank"',
  to_bank:                  '"To Bank"',
  from_account:             '"Account"',
  to_account:               '"Account.1"',
  timestamp:                '"Timestamp"',
};

const resolveField = (field) => FIELD_MAP[field] || `"${field}"`;

/**
 * Dynamically converts a policy_rule record into a parameterized SQL query
 * that runs against the `transactions` table (IBM AML dataset schema).
 *
 * Supported operators:
 *   >   | <   | >=  | <=  | =  | !=
 *   between  (uses threshold + threshold_secondary)
 *   (pattern rules use extra_conditions JSON)
 */
const buildQueryForRule = (rule) => {
  const { rule_type, field, operator, threshold, threshold_secondary, extra_conditions } = rule;

  let whereClause = '';
  let params = [];
  let paramIndex = 1;

  if (rule_type === 'pattern' && extra_conditions && Object.keys(extra_conditions).length > 0) {
    // Pattern rules: equality on a non-numeric field stored in extra_conditions
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
  } else if (['>', '<', '>=', '<=', '=', '!='].includes(operator)) {
    params.push(threshold);
    whereClause = `${resolveField(field)} ${operator} $${paramIndex++}`;
  } else {
    throw new Error(`Unsupported operator: ${operator}`);
  }

  const sql = `
    SELECT *
    FROM transactions
    WHERE ${whereClause}
    ORDER BY "Timestamp" DESC
  `;

  return { sql, params };
};

module.exports = { buildQueryForRule };
