const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const upload = require('../middleware/upload');
const { extractTextFromPDF, extractRulesFromText } = require('../services/pdfService');
const { extractRulesWithLLM } = require('../services/llmPdfService');
const { chunkAndEmbed } = require('../services/ragService');
const { query } = require('../config/database');

// ── Parser mode: 'keyword' (default) | 'llm'
// Change PARSER_MODE in .env to toggle. No code changes needed.
const PARSER_MODE = process.env.PARSER_MODE || 'keyword';


// ─────────────────────────────────────────────────────────────────────────────
// POST /policy/upload
// Accept a PDF, extract text, simulate rule extraction, store in DB.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', upload.single('policy_pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No PDF file uploaded. Use field name: policy_pdf' });
  }

  const { originalname, path: filePath } = req.file;
  const policyName = req.body.policy_name || path.parse(originalname).name;
  const policyDescription = req.body.description || 'Uploaded via PolicyGuard AI';

  try {
    // 0. Clear old policies and rules to ensure a fresh state
    console.log('[POLICY] Clearing old policies and rules before import...');
    await query('TRUNCATE policies, policy_rules, violations RESTART IDENTITY CASCADE');

    // 1. Extract text from file
    let rawText = '';
    const fileExt = path.extname(originalname).toLowerCase();

    try {
      if (fileExt === '.pdf') {
        rawText = await extractTextFromPDF(filePath);
      } else if (fileExt === '.txt' || fileExt === '.csv') {
        rawText = fs.readFileSync(filePath, 'utf8');
      } else {
        throw new Error(`Unsupported file type: ${fileExt}`);
      }
    } catch (err) {
      console.warn('[POLICY] Parse warning (using empty text):', err.message);
    }

    // 2. Extract rules — keyword parser OR Gemini LLM (controlled by PARSER_MODE env var)
    console.log(`[POLICY] Using parser mode: ${PARSER_MODE}`);
    const extractedRules = PARSER_MODE === 'llm'
      ? await extractRulesWithLLM(rawText)
      : extractRulesFromText(rawText);

    // 3. Store policy in DB
    const policyResult = await query(
      `INSERT INTO policies (name, description, filename, raw_text)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [policyName, policyDescription, originalname, rawText.substring(0, 5000)]
    );
    const policy = policyResult.rows[0];

    // 4. Store each extracted rule
    const savedRules = [];
    for (const rule of extractedRules) {
      const ruleResult = await query(
        `INSERT INTO policy_rules
           (policy_id, rule_name, rule_type, description, field, operator, threshold,
            threshold_secondary, extra_conditions, severity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          policy.id,
          rule.rule_name,
          rule.rule_type,
          rule.description,
          rule.field,
          rule.operator,
          rule.threshold ?? null,
          rule.threshold_secondary ?? null,
          JSON.stringify(rule.extra_conditions || {}),
          rule.severity || 'medium',
        ]
      );
      savedRules.push(ruleResult.rows[0]);
    }

    // 5. RAG: chunk and embed policy text in background (non-blocking)
    chunkAndEmbed(rawText, policy.id).catch(err =>
      console.warn('[POLICY] RAG embedding skipped:', err.message)
    );

    // Clean up uploaded file (optional — keep for audit trail in production)
    // fs.unlinkSync(filePath);

    return res.status(201).json({
      success: true,
      message: 'Policy uploaded and rules extracted successfully.',
      policy: {
        id: policy.id,
        name: policy.name,
        description: policy.description,
        filename: policy.filename,
        created_at: policy.created_at,
      },
      rules_extracted: savedRules.length,
      rules: savedRules,
    });
  } catch (err) {
    console.error('[POLICY] Upload error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /policy — list all policies
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, COUNT(r.id) AS rule_count
       FROM policies p
       LEFT JOIN policy_rules r ON r.policy_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );
    return res.json({ success: true, policies: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /policy/:id — single policy with its rules
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const policyRes = await query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (policyRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Policy not found' });
    }

    const rulesRes = await query(
      'SELECT * FROM policy_rules WHERE policy_id = $1 ORDER BY created_at',
      [req.params.id]
    );

    return res.json({
      success: true,
      policy: policyRes.rows[0],
      rules: rulesRes.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /policy/:id — deactivate a policy
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await query(`UPDATE policies SET status = 'inactive' WHERE id = $1`, [req.params.id]);
    return res.json({ success: true, message: 'Policy deactivated.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
