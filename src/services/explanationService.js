/**
 * Helper: read a transaction field using either IBM column name or friendly name.
 * IBM dataset columns have spaces: "Amount Paid", "Payment Format", "Is Laundering"
 */
const getField = (txn, field) => {
  // Try IBM column name first (e.g. "Amount Paid"), then snake_case fallback
  const IBM_MAP = {
    amount_paid:      'Amount Paid',
    amount_received:  'Amount Received',
    payment_format:   'Payment Format',
    is_laundering:    'Is Laundering',
    from_bank:        'From Bank',
    to_bank:          'To Bank',
    from_account:     'Account',
    to_account:       'Account.1',
    timestamp:        'Timestamp',
  };
  const ibmKey = IBM_MAP[field];
  if (ibmKey && txn[ibmKey] !== undefined) return txn[ibmKey];
  return txn[field];
};

/**
 * Generates a human-readable explanation string for a detected violation.
 * Also classifies the violation as true_positive or false_positive
 * based on the Is Laundering field from the IBM AML dataset.
 */
const generateExplanation = (rule, transaction) => {
  // IBM uses id (SERIAL), no transaction_id column — use account + timestamp as identifier
  const txnId = transaction['Account'] || transaction.id;
  const { rule_name, rule_type, field, operator, threshold, threshold_secondary, extra_conditions } = rule;

  let explanationParts = [];
  let actualValue;

  // ── Core explanation ──────────────────────────────────────────────
  if (rule_type === 'pattern' && extra_conditions && Object.keys(extra_conditions).length > 0) {
    const conditions = Object.entries(extra_conditions)
      .map(([col, val]) => `${col} = '${val}'`)
      .join(', ');
    const firstKey = Object.keys(extra_conditions)[0];
    actualValue = getField(transaction, firstKey);
    explanationParts.push(
      `Transaction from account ${txnId} matched suspicious pattern rule "${rule_name}".`,
      `Rule condition: ${conditions}.`,
      `Actual value found: '${actualValue}'.`
    );
  } else if (operator === 'between') {
    actualValue = parseFloat(getField(transaction, field));
    explanationParts.push(
      `Transaction from account ${txnId} matched structuring rule "${rule_name}".`,
      `Required: ${field} BETWEEN ${threshold} AND ${threshold_secondary}.`,
      `Actual ${field}: ${actualValue}.`,
      `This amount falls within the structuring range and may indicate deliberate CTR avoidance.`
    );
  } else {
    actualValue = parseFloat(getField(transaction, field));
    const humanOperator = {
      '>':  'greater than',
      '<':  'less than',
      '>=': 'greater than or equal to',
      '<=': 'less than or equal to',
      '=':  'equal to',
      '!=': 'not equal to',
    }[operator] || operator;

    explanationParts.push(
      `Transaction from account ${txnId} exceeded the allowed threshold.`,
      `Required: ${field} ${humanOperator} ${threshold}.`,
      `Actual ${field}: ${actualValue}.`
    );
  }

  // ── AML label classification (IBM uses integer 0/1) ──────────────
  const rawLabel = getField(transaction, 'is_laundering');
  const isLaundering = rawLabel === 1 || rawLabel === '1' || rawLabel === true || rawLabel === 't';
  let label;

  if (isLaundering) {
    label = 'true_positive';
    explanationParts.push(`AML label: CONFIRMED LAUNDERING (Is Laundering = 1) → classified as TRUE POSITIVE.`);
  } else {
    label = 'false_positive';
    explanationParts.push(`AML label: NOT laundering (Is Laundering = 0) → classified as FALSE POSITIVE.`);
  }

  const explanation = explanationParts.join(' ');

  return {
    explanation,
    label,
    is_laundering: isLaundering,
    detected_value: typeof actualValue === 'number' && !isNaN(actualValue) ? actualValue : null,
  };
};

module.exports = { generateExplanation };
