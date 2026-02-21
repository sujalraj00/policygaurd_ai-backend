require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const policyRoutes = require('./routes/policyRoutes');
const scanRoutes = require('./routes/scanRoutes');
const violationRoutes = require('./routes/violationRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const { startMonitoring } = require('./jobs/monitorJob');
const { pool } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({
      status: 'ok',
      service: 'PolicyGuard AI',
      version: '1.0.0',
      db: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/policy', policyRoutes);
app.use('/scan', scanRoutes);
app.use('/violations', violationRoutes);
app.use('/transactions', transactionRoutes);

// ── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
    available_routes: [
      'GET  /health',
      'POST /policy/upload',
      'GET  /policy',
      'GET  /policy/:id',
      'DELETE /policy/:id',
      'POST /scan',
      'GET  /scan/logs',
      'GET  /violations',
      'GET  /violations/summary',
      'GET  /violations/:id',
      'GET  /transactions',
      'GET  /transactions/:id',
    ],
  });
});

// ── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large.' });
  }
  res.status(500).json({ success: false, error: err.message });
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║          PolicyGuard AI — Backend             ║
║  AML Policy Compliance Detection Engine       ║
╠═══════════════════════════════════════════════╣
║  Server  : http://localhost:${PORT}              ║
║  Health  : http://localhost:${PORT}/health       ║
╚═══════════════════════════════════════════════╝
  `);

  // Verify DB connection
  try {
    await pool.query('SELECT 1');
    console.log('[DB] PostgreSQL connection: ✅ OK');
  } catch (err) {
    console.error('[DB] PostgreSQL connection: ❌ FAILED —', err.message);
    console.error('[DB] Make sure your .env is configured and `npm run migrate` was run.');
  }

  // Start cron-based monitoring
  startMonitoring();
});

module.exports = app;
