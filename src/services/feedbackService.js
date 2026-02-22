const { generateText } = require('./geminiClient');

/**
 * Feedback Service — HITL Loop
 * When a user marks a violation as a False Positive, this service asks Gemini
 * to generate a SQL WHERE condition that will exclude similar records in future scans.
 */


/**
 * Generate a SQL exclusion condition for a false-positive record.
 * @param {object} rule   - The policy_rule row from DB
 * @param {object} record - The raw transaction record (JSON)
 * @returns {string|null} SQL condition string or null on failure
 */
const generateExclusion = async (rule, record) => {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        console.warn('[FEEDBACK] No Gemini API key — skipping LLM exclusion generation.');
        return null;
    }

    try {
        const recordSummary = JSON.stringify(record, null, 2).substring(0, 2000);
        const prompt = `You are a SQL expert. A database record was incorrectly flagged by a compliance rule.
Rule: "${rule.description || rule.rule_name}"
Rule field: "${rule.field}", operator: "${rule.operator}", threshold: "${rule.threshold}"

The flagged record (false positive):
${recordSummary}

What additional SQL WHERE clause condition (using AND) should be added to exclude similar records?
Use only: "Amount Paid", "Amount Received", "Payment Format", "Receiving Currency", "Payment Currency", "Is Laundering", "From Bank", "To Bank", "Account", "Account.1", "Timestamp".

Return ONLY the SQL condition string. No explanation.`;

        const condition = (await generateText(prompt))
            .trim()
            .replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

        console.log(`[FEEDBACK] Generated exclusion condition: ${condition}`);
        return condition;
    } catch (err) {
        console.error('[FEEDBACK] Gemini error generating exclusion:', err.message);
        return null;
    }
};

module.exports = { generateExclusion };
