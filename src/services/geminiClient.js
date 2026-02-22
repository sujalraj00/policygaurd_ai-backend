/**
 * Shared Gemini AI client helper.
 *
 * Uses direct REST calls to v1 API — confirmed working for new API keys.
 * Drops the SDK (@google/generative-ai) which routes via v1beta and is
 * blocked for "new user" keys on older model names.
 *
 * Model priority (cheapest → most capable):
 *   1. gemini-2.5-flash  (confirmed working, great quality)
 *   2. gemini-2.0-flash-lite (cheapest)
 *   3. gemini-2.0-flash  (fallback)
 */

const API_KEY = process.env.GEMINI_API_KEY || '';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1/models';

const GENERATIVE_MODELS = [
    'gemini-2.5-flash',       // Primary: confirmed working on this key type
    'gemini-2.0-flash-lite',  // Cheapest
    'gemini-2.0-flash',       // Fallback
];

const EMBEDDING_MODELS = [
    'text-embedding-004',
    'embedding-001',
];

/**
 * Generate text using Gemini v1 REST with model fallback.
 * @param {string} prompt
 * @returns {string}
 */
const generateText = async (prompt) => {
    if (!API_KEY || API_KEY === 'your_gemini_api_key_here') {
        throw new Error('GEMINI_API_KEY not configured');
    }

    for (const modelName of GENERATIVE_MODELS) {
        try {
            const response = await fetch(
                `${BASE_URL}/${modelName}:generateContent?key=${API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                    }),
                }
            );

            if (!response.ok) {
                const errBody = await response.text();
                if (response.status === 404 || errBody.includes('not found') || errBody.includes('no longer available')) {
                    console.warn(`[GEMINI] Model ${modelName} unavailable, trying next...`);
                    continue;
                }
                throw new Error(`Gemini API error ${response.status}: ${errBody.substring(0, 200)}`);
            }

            const data = await response.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty response from Gemini');
            console.log(`[GEMINI] ✅ ${modelName}`);
            return text;
        } catch (err) {
            if (err.message.includes('not found') || err.message.includes('no longer available') || err.message.includes('404')) {
                continue;
            }
            throw err;
        }
    }

    throw new Error('All Gemini models failed. Check key/billing at https://ai.google.dev/');
};

/**
 * Get embedding vector using Gemini v1 REST with model fallback.
 * @param {string} text
 * @returns {number[]|null}
 */
const getEmbedding = async (text) => {
    if (!API_KEY || API_KEY === 'your_gemini_api_key_here') {
        throw new Error('GEMINI_API_KEY not configured');
    }

    for (const modelName of EMBEDDING_MODELS) {
        try {
            const response = await fetch(
                `${BASE_URL}/${modelName}:embedContent?key=${API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: `models/${modelName}`,
                        content: { parts: [{ text }] },
                    }),
                }
            );
            if (!response.ok) continue;
            const data = await response.json();
            const values = data?.embedding?.values;
            if (values) {
                console.log(`[GEMINI] ✅ Embedding: ${modelName}`);
                return values;
            }
        } catch (_) { continue; }
    }

    return null;
};

module.exports = { generateText, getEmbedding };
