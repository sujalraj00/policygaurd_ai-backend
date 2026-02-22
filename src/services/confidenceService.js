const { generateText } = require('./geminiClient');

/**
 * Confidence Scoring Service
 * Uses Google Gemini to score violation severity on a 0.0 - 1.0 scale.
 * Falls back gracefully to 0.5 if Gemini is unavailable.
 */

/**
 * Score a detected violation using LLM.
 * @param {object} rule - The policy rule that was violated
 * @param {object} record - The transaction record that triggered the violation
 * @returns {{ confidence: number, reasoning: string }}
 */
const scoreViolation = async (rule, record) => {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return { confidence: 0.5, reasoning: 'Confidence scoring unavailable (no API key).' };
    }

    try {
        const IBM_MAP = {
            amount_paid: 'Amount Paid', amount_received: 'Amount Received',
            payment_format: 'Payment Format', is_laundering: 'Is Laundering',
            from_bank: 'From Bank', to_bank: 'To Bank',
            from_account: 'Account', to_account: 'Account.1', timestamp: 'Timestamp',
        };
        const ibmKey = IBM_MAP[rule.field] || rule.field;
        const actualValue = record[ibmKey] !== undefined ? record[ibmKey] : record[rule.field];

        const prompt = `A compliance rule states: ${rule.description || rule.rule_name}
A database record has value: ${actualValue}
The threshold is: ${rule.threshold}
Score the severity of this violation from 0.0 to 1.0 where:
- 0.0–0.4 = low confidence (borderline, may be false positive)
- 0.4–0.7 = medium confidence (likely violation)
- 0.7–1.0 = high confidence (clear violation)
Return ONLY a JSON object: {"confidence": 0.85, "reasoning": "one sentence"}`;

        const responseText = (await generateText(prompt))
            .trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

        const parsed = JSON.parse(responseText);
        const confidence = Math.min(1.0, Math.max(0.0, parseFloat(parsed.confidence) || 0.5));
        return { confidence, reasoning: parsed.reasoning || 'LLM scoring complete.' };
    } catch (err) {
        console.error('[CONFIDENCE] Gemini scoring error:', err.message);
        return { confidence: 0.5, reasoning: `Scoring error: ${err.message}` };
    }
};

/**
 * Map numeric confidence to a human-readable band label.
 */
const confidenceBand = (score) => {
    if (score >= 0.7) return 'high';
    if (score >= 0.4) return 'medium';
    return 'low';
};

module.exports = { scoreViolation, confidenceBand };
