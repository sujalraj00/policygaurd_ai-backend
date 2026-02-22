require('dotenv').config();
const { query } = require('./database');

const migrate = async () => {
  console.log('[MIGRATE] Starting database migration...');

  try {
    // ---------------------------------------------------------------
    // PolicyGuard internal tables
    // ---------------------------------------------------------------
    await query(`
      CREATE TABLE IF NOT EXISTS policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        filename VARCHAR(255),
        raw_text TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS policy_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
        rule_name VARCHAR(255) NOT NULL,
        rule_type VARCHAR(100) NOT NULL,
        description TEXT,
        field VARCHAR(100) NOT NULL,
        operator VARCHAR(20) NOT NULL,
        threshold NUMERIC,
        threshold_secondary NUMERIC,
        extra_conditions JSONB DEFAULT '{}',
        severity VARCHAR(20) DEFAULT 'medium',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS violations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
        policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
        transaction_id VARCHAR(255),
        detected_value NUMERIC,
        explanation TEXT,
        severity VARCHAR(20),
        label VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending',
        is_laundering BOOLEAN,
        raw_row JSONB,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Ensure 'status' column exists for existing databases
    await query(`
      ALTER TABLE violations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS scan_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        triggered_by VARCHAR(50) DEFAULT 'manual',
        total_violations INTEGER DEFAULT 0,
        policies_scanned INTEGER DEFAULT 0,
        duration_ms INTEGER,
        status VARCHAR(50) DEFAULT 'success',
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `);

    // ---------------------------------------------------------------
    // IBM AML dataset table
    // Column names match the IBM CSV EXACTLY so COPY works directly.
    //
    // IBM CSV headers:
    //   Timestamp, From Bank, Account, To Bank, Account, Amount Received,
    //   Receiving Currency, Amount Paid, Payment Currency, Payment Format,
    //   Is Laundering
    //
    // Note: IBM CSV has TWO columns called "Account" (from + to).
    // We rename them to from_account / to_account for clarity.
    // ---------------------------------------------------------------
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id               SERIAL PRIMARY KEY,
        "Timestamp"      TIMESTAMPTZ,
        "From Bank"      VARCHAR(100),
        "Account"        VARCHAR(100),   -- sender account
        "To Bank"        VARCHAR(100),
        "Account.1"      VARCHAR(100),   -- receiver account (IBM CSV renames 2nd Account col)
        "Amount Received" NUMERIC,
        "Receiving Currency" VARCHAR(50),
        "Amount Paid"    NUMERIC,
        "Payment Currency" VARCHAR(50),
        "Payment Format" VARCHAR(50),
        "Is Laundering"  INTEGER DEFAULT 0  -- IBM uses 0/1, not boolean
      );
    `);

    // ---------------------------------------------------------------
    // Seed sample AML transactions if table is empty.
    // These rows mirror the IBM AML CSV column names exactly.
    // ---------------------------------------------------------------
    const countRes = await query('SELECT COUNT(*) FROM transactions');
    if (parseInt(countRes.rows[0].count) === 0) {
      console.log('[MIGRATE] Seeding sample AML transactions (IBM column format)...');
      await query(`
        INSERT INTO transactions 
          ("Timestamp", "From Bank", "Account", "To Bank", "Account.1",
           "Amount Received", "Receiving Currency", "Amount Paid",
           "Payment Currency", "Payment Format", "Is Laundering")
        VALUES
          (NOW() - INTERVAL '2 days',  'BankA', '80156721', 'BankB', '98234501', 15000, 'US Dollar', 15000, 'US Dollar', 'Wire',         1),
          (NOW() - INTERVAL '2 days',  'BankB', '71234502', 'BankC', '63452201', 500,   'US Dollar', 500,   'US Dollar', 'ACH',          0),
          (NOW() - INTERVAL '1 day',   'BankC', '55678903', 'BankA', '80156790', 75000, 'Euro',      82000, 'US Dollar', 'Wire',         1),
          (NOW() - INTERVAL '1 day',   'BankA', '80156730', 'BankD', '47891201', 200,   'US Dollar', 200,   'US Dollar', 'Cheque',       0),
          (NOW() - INTERVAL '12 hours','BankD', '47891202', 'BankB', '71234510', 12000, 'US Dollar', 12000, 'US Dollar', 'Wire',         1),
          (NOW() - INTERVAL '6 hours', 'BankB', '71234520', 'BankC', '63452210', 9500,  'US Dollar', 9500,  'US Dollar', 'ACH',          0),
          (NOW() - INTERVAL '3 hours', 'BankA', '80156740', 'BankA', '80156750', 50000, 'US Dollar', 50000, 'US Dollar', 'Wire',         1),
          (NOW() - INTERVAL '1 hour',  'BankC', '63452230', 'BankD', '47891230', 300,   'British Pounds', 375, 'US Dollar', 'Reinvestment', 0),
          (NOW() - INTERVAL '30 mins', 'BankD', '47891240', 'BankA', '80156760', 25000, 'US Dollar', 25000, 'US Dollar', 'Wire',         1),
          (NOW(),                      'BankB', '71234530', 'BankB', '71234540', 8500,  'US Dollar', 8500,  'US Dollar', 'ACH',          0);
      `);
      console.log('[MIGRATE] Seeded 10 sample transactions.');
    }

    // ---------------------------------------------------------------
    // Phase 2 upgrade: Additive columns on existing tables
    // All use IF NOT EXISTS — safe to re-run on existing databases
    // ---------------------------------------------------------------

    // violations: add confidence scoring columns
    await query(`ALTER TABLE violations ADD COLUMN IF NOT EXISTS confidence FLOAT`);
    await query(`ALTER TABLE violations ADD COLUMN IF NOT EXISTS confidence_reasoning TEXT`);

    // policy_rules: add incremental scan tracking + LLM fields + HITL exclusion
    await query(`ALTER TABLE policy_rules ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMPTZ`);
    await query(`ALTER TABLE policy_rules ADD COLUMN IF NOT EXISTS exclusion_conditions TEXT`);
    await query(`ALTER TABLE policy_rules ADD COLUMN IF NOT EXISTS rule_id TEXT`);
    await query(`ALTER TABLE policy_rules ADD COLUMN IF NOT EXISTS context TEXT`);

    // ---------------------------------------------------------------
    // Phase 2 upgrade: New tables (all IF NOT EXISTS)
    // ---------------------------------------------------------------

    // query_audit_log: every generated SQL is logged
    await query(`
      CREATE TABLE IF NOT EXISTS query_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID REFERENCES policy_rules(id) ON DELETE SET NULL,
        generated_sql TEXT,
        params JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // scan_history: per-rule scan stats (incremental scanning)
    await query(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID REFERENCES policy_rules(id) ON DELETE CASCADE,
        scan_start TIMESTAMPTZ,
        scan_end TIMESTAMPTZ,
        records_scanned INT DEFAULT 0,
        violations_found INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // violation_reviews: HITL human review decisions
    await query(`
      CREATE TABLE IF NOT EXISTS violation_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        violation_id UUID NOT NULL REFERENCES violations(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('confirm', 'false_positive', 'escalate')),
        note TEXT,
        reviewed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // policy_chunks: RAG pipeline - stores text chunks with embeddings as JSONB
    await query(`
      CREATE TABLE IF NOT EXISTS policy_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_id UUID REFERENCES policies(id) ON DELETE CASCADE,
        chunk_index INT,
        chunk_text TEXT,
        embedding JSONB,
        page_number INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('[MIGRATE] Migration completed successfully.');
  } catch (err) {
    console.error('[MIGRATE] Migration failed:', err.message);
    process.exit(1);
  }

  process.exit(0);
};

migrate();
