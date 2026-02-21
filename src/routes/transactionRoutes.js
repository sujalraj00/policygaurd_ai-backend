// const express = require('express');
// const router = express.Router();
// const { query } = require('../config/database');

// // GET /transactions — list transactions with optional filters
// router.get('/', async (req, res) => {
//   try {
//     const { is_laundering, limit = 50, offset = 0 } = req.query;
//     let conditions = [];
//     let params = [];
//     let idx = 1;

//     if (is_laundering !== undefined) {
//       conditions.push(`is_laundering = $${idx++}`);
//       params.push(is_laundering === 'true');
//     }

//     const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

//     const result = await query(
//       `SELECT * FROM transactions ${whereSQL} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++}`,
//       [...params, parseInt(limit), parseInt(offset)]
//     );

//     const countResult = await query(
//       `SELECT COUNT(*) FROM transactions ${whereSQL}`,
//       params
//     );

//     return res.json({
//       success: true,
//       total: parseInt(countResult.rows[0].count),
//       transactions: result.rows,
//     });
//   } catch (err) {
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });

// // GET /transactions/:id
// router.get('/:id', async (req, res) => {
//   try {
//     const result = await query(
//       'SELECT * FROM transactions WHERE transaction_id = $1 OR id::text = $1 LIMIT 1',
//       [req.params.id]
//     );
//     if (result.rows.length === 0) {
//       return res.status(404).json({ success: false, error: 'Transaction not found' });
//     }
//     return res.json({ success: true, transaction: result.rows[0] });
//   } catch (err) {
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });

// module.exports = router;


const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');

// ── CSV upload setup ─────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for large IBM dataset
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /transactions/upload
// Accept IBM AML CSV and bulk-insert into transactions table.
// Supports both the IBM AML format and a simple generic format.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', csvUpload.single('dataset'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded. Use field name: dataset' });
  }

  const filePath = req.file.path;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

    console.log('[TRANSACTIONS] CSV headers detected:', headers);

    // Clear old data to ensure fresh dashboard stats
    console.log('[DEBUG-VERIFY] clearing tables now...');
    await query('TRUNCATE transactions, violations RESTART IDENTITY CASCADE');

    // Detect if this is IBM AML format or generic
    const isIBMFormat = headers.includes('From Bank') || headers.includes('Payment Format') || headers.includes('Is Laundering');

    let inserted = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Parse CSV line (handle quoted commas)
      const values = parseCSVLine(line);

      try {
        if (isIBMFormat) {
          // Map IBM AML CSV columns by position or name
          const row = {};
          headers.forEach((h, idx) => { row[h] = values[idx]?.trim().replace(/"/g, '') || null; });

          await query(
            `INSERT INTO transactions 
               ("Timestamp","From Bank","Account","To Bank","Account.1",
                "Amount Received","Receiving Currency","Amount Paid",
                "Payment Currency","Payment Format","Is Laundering")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              row['Timestamp'] || null,
              row['From Bank'] || null,
              row['Account'] || null,
              row['To Bank'] || null,
              row['Account.1'] || row['Account1'] || null,
              parseFloat(row['Amount Received']) || 0,
              row['Receiving Currency'] || null,
              parseFloat(row['Amount Paid']) || 0,
              row['Payment Currency'] || null,
              row['Payment Format'] || null,
              parseInt(row['Is Laundering']) || 0,
            ]
          );
        } else {
          // Generic fallback — try to map common column names
          const row = {};
          headers.forEach((h, idx) => { row[h.toLowerCase().replace(/\s+/g, '_')] = values[idx]?.trim().replace(/"/g, '') || null; });

          await query(
            `INSERT INTO transactions 
               ("Timestamp","From Bank","Account","To Bank","Account.1",
                "Amount Received","Receiving Currency","Amount Paid",
                "Payment Currency","Payment Format","Is Laundering")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              row['timestamp'] || row['date'] || null,
              row['from_bank'] || row['sender_bank'] || null,
              row['account'] || row['from_account'] || row['sender'] || null,
              row['to_bank'] || row['receiver_bank'] || null,
              row['account.1'] || row['to_account'] || row['receiver'] || null,
              parseFloat(row['amount_received'] || row['amount'] || 0),
              row['receiving_currency'] || row['currency'] || 'USD',
              parseFloat(row['amount_paid'] || row['amount'] || 0),
              row['payment_currency'] || row['currency'] || 'USD',
              row['payment_format'] || row['type'] || 'Wire',
              parseInt(row['is_laundering'] || row['fraud'] || row['isfraud'] || 0),
            ]
          );
        }
        inserted++;
      } catch (rowErr) {
        skipped++;
        if (errors.length < 5) errors.push(`Row ${i}: ${rowErr.message}`);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    return res.status(201).json({
      success: true,
      message: `Dataset imported successfully.`,
      format_detected: isIBMFormat ? 'IBM AML' : 'Generic CSV',
      inserted,
      skipped,
      total_rows: lines.length - 1,
      sample_errors: errors,
    });
  } catch (err) {
    console.error('[TRANSACTIONS] Upload error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Simple CSV line parser that handles quoted fields with commas inside
const parseCSVLine = (line) => {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /transactions — list transactions with optional filters
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { is_laundering, limit = 50, offset = 0 } = req.query;
    let conditions = [];
    let params = [];
    let idx = 1;

    if (is_laundering !== undefined) {
      conditions.push(`"Is Laundering" = $${idx++}`);
      params.push(parseInt(is_laundering));
    }

    const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM transactions ${whereSQL} ORDER BY "Timestamp" DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM transactions ${whereSQL}`, params
    );

    return res.json({
      success: true,
      total: parseInt(countResult.rows[0].count),
      transactions: result.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /transactions/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM transactions WHERE "Account" = $1 OR id::text = $1 LIMIT 1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    return res.json({ success: true, transaction: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
