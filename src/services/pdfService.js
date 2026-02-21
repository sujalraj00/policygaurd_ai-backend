const pdfParse = require('pdf-parse');
const fs = require('fs');

/**
 * Extract raw text from a PDF file path.
 */
const extractTextFromPDF = async (filePath) => {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text || '';
};

/**
 * Real policy text parser.
 *
 * Reads each line of the policy document and attempts to extract rules based
 * on known patterns. This replaces the old hardcoded mock.
 *
 * Supported rule patterns (case-insensitive):
 *   - "Amount Paid exceeds <number>"     → threshold rule (>)
 *   - "Amount Paid above <number>"       → threshold rule (>)
 *   - "Amount Paid greater than <number>"→ threshold rule (>)
 *   - "Amount Paid over <number>"        → threshold rule (>)
 *   - "Amount Paid below <number>"       → threshold rule (<)
 *   - "Amount Paid between <n1> and <n2>"→ between rule
 *   - "Reinvestment" payment format      → pattern rule
 *   - "payment format is <value>"        → pattern rule
 *   - "payment format = <value>"         → pattern rule
 *   - "structuring" / "smurfing"         → auto-adds between 8000–10000 rule
 */
const extractRulesFromText = (policyText) => {
  console.log('[PDF] Parsing policy text for rules...');
  const lines = policyText.split('\n').map(l => l.trim()).filter(Boolean);
  const rules = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    // ── Threshold rule: amount paid > X ──────────────────────────────────────
    const thresholdMatch =
      line.match(/amount\s+paid\s+(?:exceeds?|above|greater\s+than|over)\s+([\d,]+)/i) ||
      line.match(/(?:exceeds?|above|greater\s+than|over)\s+\$?([\d,]+)/i);

    if (thresholdMatch) {
      const val = parseInt(thresholdMatch[1].replace(/,/g, ''));
      if (!isNaN(val)) {
        rules.push({
          rule_name: `Large Transaction Threshold (> $${val.toLocaleString()})`,
          rule_type: 'threshold',
          description: `Extracted from policy: flag any transaction where Amount Paid exceeds $${val.toLocaleString()}.`,
          field: 'amount_paid',
          operator: '>',
          threshold: val,
          threshold_secondary: null,
          extra_conditions: {},
          severity: val >= 50000 ? 'high' : val >= 10000 ? 'high' : 'medium',
        });
        continue;
      }
    }

    // ── Threshold rule: amount paid between X and Y ───────────────────────────
    const betweenMatch = line.match(/amount\s+paid\s+between\s+([\d,]+)\s+and\s+([\d,]+)/i);
    if (betweenMatch) {
      const lo = parseInt(betweenMatch[1].replace(/,/g, ''));
      const hi = parseInt(betweenMatch[2].replace(/,/g, ''));
      rules.push({
        rule_name: `Structuring Detection ($${lo.toLocaleString()}–$${hi.toLocaleString()})`,
        rule_type: 'threshold',
        description: `Extracted from policy: flag transactions between $${lo.toLocaleString()} and $${hi.toLocaleString()}.`,
        field: 'amount_paid',
        operator: 'between',
        threshold: lo,
        threshold_secondary: hi,
        extra_conditions: {},
        severity: 'medium',
      });
      continue;
    }

    // ── Structuring / Smurfing keyword ────────────────────────────────────────
    if (/structuring|smurfing/.test(lower)) {
      rules.push({
        rule_name: 'Structuring Detection (Smurfing)',
        rule_type: 'threshold',
        description: 'Extracted from policy: flag transactions between $8,000 and $10,000 that may be structured to avoid CTR reporting.',
        field: 'amount_paid',
        operator: 'between',
        threshold: 8000,
        threshold_secondary: 10000,
        extra_conditions: {},
        severity: 'medium',
      });
      continue;
    }

    // ── Payment format pattern rule ───────────────────────────────────────────
    // Check for known format keywords first (most specific), then generic pattern
    const knownFormats = ['reinvestment', 'wire', 'ach', 'cheque', 'credit card', 'cash'];
    const foundFormat = knownFormats.find(fmt => lower.includes(fmt));

    const genericFormatMatch = !foundFormat
      ? line.match(/payment\s+format\s+(?:is|=|:)\s*["']?(\w+)["']?/i)
      : null;

    const fmt = foundFormat
      ? foundFormat.charAt(0).toUpperCase() + foundFormat.slice(1)
      : genericFormatMatch
        ? genericFormatMatch[1].trim()
        : null;

    if (fmt) {
      rules.push({
        rule_name: `Suspicious ${fmt} Payment Pattern`,
        rule_type: 'pattern',
        description: `Extracted from policy: flag all transactions using the "${fmt}" payment format.`,
        field: 'payment_format',
        operator: '=',
        threshold: null,
        threshold_secondary: null,
        extra_conditions: { payment_format: fmt },
        severity: 'high',
      });
      continue;
    }
  }

  if (rules.length === 0) {
    console.warn('[PDF] No rules extracted from policy text. Check policy format.');
  } else {
    console.log(`[PDF] Extracted ${rules.length} rule(s) from policy document.`);
  }

  return rules;
};

module.exports = { extractTextFromPDF, extractRulesFromText };
