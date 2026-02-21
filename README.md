# PolicyGuard AI — Backend MVP

AML Policy Compliance Detection Engine for the hackathon.

---

## Architecture

```
policyguard-ai/
├── src/
│   ├── server.js                   # Express entry point
│   ├── config/
│   │   ├── database.js             # PostgreSQL pool
│   │   └── migrate.js              # Table creation + seed data
│   ├── middleware/
│   │   └── upload.js               # Multer PDF upload handler
│   ├── services/
│   │   ├── pdfService.js           # PDF text extraction + simulated LLM rule extraction
│   │   ├── queryBuilder.js         # Rule → SQL dynamic converter
│   │   ├── scanService.js          # Violation detection engine
│   │   └── explanationService.js   # Human-readable reasoning generator
│   ├── jobs/
│   │   └── monitorJob.js           # node-cron periodic monitoring
│   └── routes/
│       ├── policyRoutes.js         # /policy endpoints
│       ├── scanRoutes.js           # /scan endpoints
│       ├── violationRoutes.js      # /violations endpoints
│       └── transactionRoutes.js    # /transactions endpoints
├── uploads/                        # Uploaded PDF files
├── .env.example
└── package.json
```

---

## Prerequisites

- Node.js v18+
- PostgreSQL 14+ (with `gen_random_uuid()` support)
- A running PostgreSQL instance with an AML database

---

## 1. Install dependencies

```bash
cd policyguard-ai
npm install
```

---

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=aml_database
DB_USER=postgres
DB_PASSWORD=yourpassword

PORT=3000
NODE_ENV=development

# Cron schedule (default: every hour — change to */1 * * * * for every minute in dev)
CRON_SCHEDULE=0 * * * *

MAX_FILE_SIZE_MB=10
```

---

## 3. Create tables & seed data

```bash
npm run migrate
```

This will create:
- `policies` — uploaded policy documents
- `policy_rules` — extracted rules from policies
- `violations` — detected violations
- `scan_logs` — cron/manual scan history
- `transactions` — IBM AML dataset table (seeded with 10 sample rows)

> **IBM AML Dataset**: If you have the full IBM AML CSV, import it into the `transactions` table.
> The schema maps: `amount_paid`, `payment_format`, `is_laundering`, etc.

---

## 4. Run the server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

Server starts at: http://localhost:3000

---

## 5. API Reference & curl Examples

### Health Check

```bash
curl http://localhost:3000/health
```

---

### Upload a Policy PDF

```bash
curl -X POST http://localhost:3000/policy/upload \
  -F "policy_pdf=@/path/to/your/aml_policy.pdf" \
  -F "policy_name=AML Compliance Policy v2" \
  -F "description=Anti-Money Laundering rules for Q1 2024"
```

**Response:**
```json
{
  "success": true,
  "message": "Policy uploaded and rules extracted successfully.",
  "policy": {
    "id": "uuid-here",
    "name": "AML Compliance Policy v2",
    "filename": "aml_policy.pdf"
  },
  "rules_extracted": 3,
  "rules": [
    {
      "rule_name": "Large Transaction Threshold",
      "rule_type": "threshold",
      "field": "amount_paid",
      "operator": ">",
      "threshold": "10000",
      "severity": "high"
    },
    ...
  ]
}
```

> Note: If you don't have a PDF handy, create a dummy one:
> ```bash
> echo "%PDF-1.4 dummy" > test.pdf
> curl -X POST http://localhost:3000/policy/upload -F "policy_pdf=@test.pdf" -F "policy_name=Test Policy"
> ```

---

### List All Policies

```bash
curl http://localhost:3000/policy
```

---

### Get Policy Details + Rules

```bash
curl http://localhost:3000/policy/<policy-uuid>
```

---

### Trigger Manual Scan (All Policies)

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Trigger Manual Scan (Specific Policy)

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -d '{"policy_id": "<policy-uuid>"}'
```

**Response:**
```json
{
  "success": true,
  "summary": {
    "policies_scanned": 1,
    "rules_evaluated": 3,
    "total_violations": 6,
    "true_positives": 4,
    "false_positives": 2,
    "duration_ms": 45
  },
  "violations": [
    {
      "violation_id": "uuid",
      "rule_name": "Large Transaction Threshold",
      "transaction_id": "TXN001",
      "label": "true_positive",
      "severity": "high",
      "explanation": "Transaction TXN001 exceeded the allowed threshold. Required: amount_paid greater than 10000. Actual amount_paid: 15000. AML label: CONFIRMED LAUNDERING (is_laundering = true) → classified as TRUE POSITIVE."
    }
  ]
}
```

---

### View Scan Logs

```bash
curl http://localhost:3000/scan/logs
```

---

### List Violations

```bash
# All violations
curl http://localhost:3000/violations

# Filter by severity
curl "http://localhost:3000/violations?severity=high"

# Filter by label
curl "http://localhost:3000/violations?label=true_positive"

# Filter by policy
curl "http://localhost:3000/violations?policy_id=<uuid>"

# Paginate
curl "http://localhost:3000/violations?limit=10&offset=0"
```

---

### Violation Summary Stats

```bash
curl http://localhost:3000/violations/summary
```

**Response:**
```json
{
  "success": true,
  "summary": {
    "true_positives": "4",
    "false_positives": "2",
    "high_severity": "4",
    "medium_severity": "2",
    "low_severity": "0",
    "total": "6"
  }
}
```

---

### View Single Violation (with full explanation)

```bash
curl http://localhost:3000/violations/<violation-uuid>
```

---

### Browse Transactions

```bash
# All transactions
curl http://localhost:3000/transactions

# Only laundering transactions
curl "http://localhost:3000/transactions?is_laundering=true"

# Single transaction
curl http://localhost:3000/transactions/TXN001
```

---

## 6. Monitoring (Cron)

The cron job starts automatically when the server boots.

- Default schedule: **every hour** (`0 * * * *`)
- Change via `CRON_SCHEDULE` in `.env`

For development/testing, use `*/1 * * * *` to run every minute.

Logs are printed to console and saved in the `scan_logs` table.

---

## 7. How Rules Map to SQL

| Rule | Generated SQL |
|------|---------------|
| `amount_paid > 10000` | `SELECT * FROM transactions WHERE amount_paid > 10000` |
| `amount_paid BETWEEN 8000 AND 10000` | `SELECT * FROM transactions WHERE amount_paid BETWEEN 8000 AND 10000` |
| `payment_format = 'Reinvestment'` | `SELECT * FROM transactions WHERE payment_format = 'Reinvestment'` |

---

## 8. Explanation Format

```
Transaction TXN001 exceeded the allowed threshold.
Required: amount_paid greater than 10000.
Actual amount_paid: 15000.
AML label: CONFIRMED LAUNDERING (is_laundering = true) → classified as TRUE POSITIVE.
```

---

## IBM AML Dataset Import (optional)

If you have the IBM AML CSV:

```sql
COPY transactions (
  transaction_id, from_bank, from_account, to_bank, to_account,
  amount_received, receiving_currency, amount_paid, payment_currency,
  payment_format, is_laundering, timestamp
)
FROM '/path/to/HI-Small_Trans.csv'
DELIMITER ','
CSV HEADER;
```
