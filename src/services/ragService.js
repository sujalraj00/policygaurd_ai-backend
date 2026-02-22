/**
 * RAG Service — Retrieval-Augmented Generation
 * Chunks policy text into ~500-token segments, embeds each using Gemini,
 * and enables semantic similarity search to add context to LLM rule extraction.
 *
 * Embeddings are stored as JSONB vectors in the policy_chunks table.
 * Cosine similarity is computed in-process — no pgvector needed.
 */

const { getEmbedding } = require('./geminiClient');
const { query } = require('../config/database');

const CHUNK_SIZE_CHARS = 2000; // approx ~500 tokens

/**
 * Split text into overlapping chunks of approximately CHUNK_SIZE_CHARS characters.
 */
const chunkText = (text, chunkSize = CHUNK_SIZE_CHARS) => {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push(text.slice(start, end).trim());
        start += Math.floor(chunkSize * 0.8); // 20% overlap
    }
    return chunks.filter(c => c.length > 50);
};


/**
 * Chunk a policy document, embed all chunks, and store in policy_chunks table.
 * @param {string} text - Full policy text
 * @param {string} policyId - UUID of the policy
 */
const chunkAndEmbed = async (text, policyId) => {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        console.warn('[RAG] No Gemini API key — skipping RAG indexing.');
        return;
    }

    console.log(`[RAG] Chunking policy ${policyId} for RAG...`);
    const chunks = chunkText(text);
    console.log(`[RAG] Created ${chunks.length} chunks. Embedding...`);

    // Delete old chunks for this policy
    await query('DELETE FROM policy_chunks WHERE policy_id = $1', [policyId]);

    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await getEmbedding(chunk);
        if (embedding) {
            await query(
                `INSERT INTO policy_chunks (policy_id, chunk_index, chunk_text, embedding, page_number)
         VALUES ($1, $2, $3, $4, $5)`,
                [policyId, i, chunk, JSON.stringify(embedding), Math.floor(i * CHUNK_SIZE_CHARS / 3000) + 1]
            );
            embedded++;
        }
        // Small delay to avoid rate limiting
        if (i % 5 === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    console.log(`[RAG] Embedded and stored ${embedded}/${chunks.length} chunks for policy ${policyId}.`);
};

/**
 * Cosine similarity between two float arrays.
 */
const cosineSimilarity = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
};

/**
 * Retrieve the top-K most relevant policy chunks for a query string.
 * @param {string} queryText - The query to find relevant chunks for
 * @param {number} topK - Number of chunks to return (default 3)
 * @param {string|null} policyId - Optional: restrict to a specific policy
 * @returns {string} Concatenated chunk texts
 */
const retrieveRelevantChunks = async (queryText, topK = 3, policyId = null) => {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return '';
    }

    try {
        const queryEmbedding = await getEmbedding(queryText);
        if (!queryEmbedding) return '';

        let dbQuery = 'SELECT chunk_text, embedding FROM policy_chunks';
        const params = [];
        if (policyId) {
            dbQuery += ' WHERE policy_id = $1';
            params.push(policyId);
        }

        const result = await query(dbQuery, params);
        if (result.rows.length === 0) return '';

        // Score all chunks by cosine similarity
        const scored = result.rows.map(row => ({
            text: row.chunk_text,
            score: cosineSimilarity(queryEmbedding, row.embedding),
        }));

        // Return top-K formatted
        const topChunks = scored
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(c => c.text);

        return topChunks.join('\n\n---\n\n');
    } catch (err) {
        console.error('[RAG] Retrieval error:', err.message);
        return '';
    }
};

module.exports = { chunkAndEmbed, retrieveRelevantChunks };
