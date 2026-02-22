/**
 * LLM-Powered PDF Rule Extraction Service
 * Uses Google Gemini API to extract structured compliance rules from policy text.
 *
 * PARSER_MODE toggle (in .env):
 *   PARSER_MODE=keyword  → uses pdfService.js (existing keyword parser)
 *   PARSER_MODE=llm      → uses this file (Gemini pipeline)
 */

const { extractTextFromPDF } = require('./pdfService');
const { generateText } = require('./geminiClient');

const RULE_EXTRACTION_SYSTEM_PROMPT = `You are a compliance rule extractor. Given a policy document, extract every distinct compliance rule as a structured JSON object. Each rule must have:
{
  "rule_id": "unique string (e.g. RULE_001)",
  "description": "human readable rule description",
  "field": "database column this applies to (use: amount_paid, amount_received, payment_format, receiving_currency, payment_currency, is_laundering, from_bank, to_bank, from_account, to_account, timestamp)",
  "operator": "gt | lt | eq | ne | contains | not_contains | regex | between",
  "threshold": "value or pattern as a string",
  "threshold_secondary": "only for between operator, the upper bound as a string",
  "context": "any conditional context e.g. only for international transfers, or null",
  "severity": "high | medium | low"
}
Return ONLY a valid JSON array. No explanation, no markdown, no code blocks. Just the raw JSON array.`;

/**
 * Extract rules from policy text using Google Gemini.
 * Returns rule objects shaped to match the policy_rules DB schema.
 *
 * @param {string} policyText - Raw text content of the policy document
 * @param {string} policyId   - UUID of the policy in the DB (for context referencing)
 * @returns {Array} array of rule objects
 */
const extractRulesWithLLM = async (policyText, policyId = null) => {
    console.log('[LLM-PDF] Starting Gemini-powered rule extraction...');

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        console.error('[LLM-PDF] GEMINI_API_KEY not set. Falling back to keyword parser.');
        const { extractRulesFromText } = require('./pdfService');
        return extractRulesFromText(policyText);
    }

    try {
        const prompt = `${RULE_EXTRACTION_SYSTEM_PROMPT}\n\nPolicy Document:\n${policyText.substring(0, 15000)}`;

        const responseText = (await generateText(prompt)).trim();

        // Strip markdown code blocks if Gemini wraps the output
        const jsonText = responseText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        let extractedRules;
        try {
            extractedRules = JSON.parse(jsonText);
            if (!Array.isArray(extractedRules)) {
                throw new Error('LLM returned non-array response');
            }
        } catch (parseErr) {
            console.error('[LLM-PDF] Failed to parse LLM JSON response:', parseErr.message);
            console.error('[LLM-PDF] Raw response:', responseText.substring(0, 500));
            // Fallback to keyword parser
            const { extractRulesFromText } = require('./pdfService');
            return extractRulesFromText(policyText);
        }

        // Normalize LLM output to match policy_rules schema
        const normalizedRules = extractedRules.map((r, idx) => ({
            rule_id: r.rule_id || `RULE_${String(idx + 1).padStart(3, '0')}`,
            rule_name: r.description ? r.description.substring(0, 200) : `Rule ${idx + 1}`,
            rule_type: inferRuleType(r.operator),
            description: r.description || '',
            field: r.field || 'amount_paid',
            operator: normalizeOperator(r.operator || 'gt'),
            threshold: r.threshold !== undefined ? (isNaN(parseFloat(r.threshold)) ? null : parseFloat(r.threshold)) : null,
            threshold_secondary: r.threshold_secondary !== undefined ? (isNaN(parseFloat(r.threshold_secondary)) ? null : parseFloat(r.threshold_secondary)) : null,
            extra_conditions: buildExtraConditions(r),
            severity: ['high', 'medium', 'low'].includes(r.severity) ? r.severity : 'medium',
            context: r.context || null,
        }));

        console.log(`[LLM-PDF] Gemini extracted ${normalizedRules.length} rule(s) from policy.`);
        return normalizedRules;

    } catch (err) {
        console.error('[LLM-PDF] Gemini API error:', err.message);
        console.log('[LLM-PDF] Falling back to keyword parser...');
        const { extractRulesFromText } = require('./pdfService');
        return extractRulesFromText(policyText);
    }
};

/** Map LLM operator strings to internal operator format */
const normalizeOperator = (op) => {
    const map = {
        gt: '>', lt: '<', eq: '=', ne: '!=',
        '>': '>', '<': '<', '=': '=', '!=': '!=',
        '>=': '>=', '<=': '<=',
        contains: 'contains',
        not_contains: 'not_contains',
        regex: 'regex',
        between: 'between',
    };
    return map[op] || op;
};

/** Infer rule_type from operator */
const inferRuleType = (op) => {
    if (['contains', 'not_contains', 'regex', 'eq', '='].includes(op)) return 'pattern';
    if (op === 'between') return 'threshold';
    return 'threshold';
};

/** Build extra_conditions JSON for pattern-type rules */
const buildExtraConditions = (rule) => {
    if (['contains', 'eq', '='].includes(rule.operator) && rule.field && rule.threshold) {
        return { [rule.field]: rule.threshold };
    }
    return {};
};

module.exports = { extractRulesWithLLM, extractTextFromPDF };
