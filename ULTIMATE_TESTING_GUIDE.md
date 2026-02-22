# 🧪 Ultimate Testing Guide — PolicyGuard AI v2

This guide walks you through verifying the complete system in both **Classic (Keyword)** and **AI-Powered (LLM)** modes.

---

## 🛠 Pre-requisites
1. **Server Running**: `npm start` (Running on port 3000)
2. **Database Ready**: `npm run migrate` (Ensure new tables exist)
3. **Open 2nd Terminal**: Run all commands below from a fresh terminal tab.

---

## 🟢 Scenario A: Testing WITHOUT LLM (Classic Mode)
Use this to test the core engine without using any Gemini API quota.

### 1. Configure `.env`
Ensure these are set (or just leave them as they are):
```bash
PARSER_MODE=keyword
GEMINI_API_KEY=your_gemini_api_key_here
```

### 2. Upload Policy & Data
```bash
# Upload policy (uses keyword parser)
curl -X POST http://localhost:3000/policy/upload -F "policy_pdf=@policy.txt"

# Upload demo data (contains 10 rows)
curl -X POST http://localhost:3000/transactions/upload -F "dataset=@HI-Demo.csv"
```

### 3. Run Scan
```bash
curl -X POST http://localhost:3000/scan -H "Content-Type: application/json" -d '{}'
```

### 4. Verify Results
- **Violations**: `curl http://localhost:3000/violations`
  - *Expect*: 7 violations found.
  - *Confidence*: All should be `0.5` (Fallback value).
  - *Reasoning*: Should say "No API key provided".
- **Report**: `curl "http://localhost:3000/scan/report" --output report.pdf && open report.pdf`
  - *Expect*: A PDF with 7 detections.

---

## 🤖 Scenario B: Testing WITH LLM (Gemini Mode)
Use this to unlock "Smart" extraction and scoring.

### 1. Configure `.env`
Update with your **real** API key:
```bash
PARSER_MODE=llm
GEMINI_API_KEY=AIzaSy...your_real_key_here
```
*(Restart server after changing .env: `Ctrl+C` → `npm start`)*

### 2. Upload Policy (LLM Extraction)
```bash
curl -X POST http://localhost:3000/policy/upload -F "policy_pdf=@policy.txt"
```
- **Check Server Logs**: You should see `[POLICY] Using parser mode: llm` and `[RAG] Chunking policy...`.

### 3. Run Scan (LLM Scoring)
```bash
curl -X POST http://localhost:3000/scan -H "Content-Type: application/json" -d '{}'
```

### 4. Verify Results
- **Violations**: `curl http://localhost:3000/violations`
  - *Confidence*: Should be varying scores (e.g., `0.85`, `0.72`).
  - *Reasoning*: Real LLM-generated sentences explaining the score.
- **Queue**: `curl http://localhost:3000/scan/queue`
  - Should show `completed` jobs count increasing.

---

## 👥 Scenario C: Human-in-the-Loop (HITL)
Test the feedback loop between humans and AI.

### 1. Review a violation
Get an ID from `/violations` and run:
```bash
# Mark as False Positive
curl -X POST http://localhost:3000/violations/<PASTE_ID>/review \
  -H "Content-Type: application/json" \
  -d '{"action":"false_positive","note":"Valid corporate payment"}'
```

### 2. Check the Feedback Loop
- **Without LLM**: Status updates to `false_positive`.
- **With LLM**: Status updates AND a new SQL condition is added to `policy_rules.exclusion_conditions` to prevent this violation in the next scan!

---

## 📈 Scenario D: Performance & Reports
```bash
# Summary Dashboard stats
curl http://localhost:3000/violations/summary

# Check for specific confidence levels
curl "http://localhost:3000/violations?confidence=high"
```

---

## 🆘 Troubleshooting
- **429 Error**: Your Gemini Free Tier quota is hit. Switch back to `PARSER_MODE=keyword`.
- **404 Error**: Model name was fixed in the code, but ensure your internet is connected.
- **Port 3000 in use**: Run `lsof -ti :3000 | xargs kill -9` to clear it.
- **Scan returns 0**: Make sure you uploaded **rules** (Step A2) AND **data** (Step A2) before scanning.
