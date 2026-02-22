/**
 * Audit Report Service
 * Generates a structured PDF audit report using pdfkit.
 * Covers all violations in a date range, grouped by rule, severity, confidence.
 */

const PDFDocument = require('pdfkit');
const { query } = require('../config/database');

const COLORS = {
    high: '#dc2626', // red-600
    medium: '#d97706', // amber-600
    low: '#16a34a', // green-600
    header: '#1e3a5f',
    accent: '#3b82f6',
    text: '#1f2937',
    light: '#f3f4f6',
};

/**
 * Generate a PDF audit report for violations in the given date range.
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {Buffer} PDF file as a Buffer
 */
const generateAuditReport = async (startDate, endDate) => {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // ── Query data ──────────────────────────────────────────────────────────────
    const violationsRes = await query(
        `SELECT
       v.*,
       r.rule_name, r.rule_type, r.description AS rule_description,
       p.name AS policy_name,
       vr.action AS review_action
     FROM violations v
     JOIN policy_rules r ON r.id = v.rule_id
     JOIN policies p ON p.id = v.policy_id
     LEFT JOIN violation_reviews vr ON vr.violation_id = v.id
     WHERE v.detected_at BETWEEN $1 AND $2
     ORDER BY v.detected_at DESC`,
        [start, end]
    );
    const violations = violationsRes.rows;

    // ── Aggregate stats ─────────────────────────────────────────────────────────
    const total = violations.length;
    const confirmed = violations.filter(v => v.review_action === 'confirm').length;
    const falsePositives = violations.filter(v => v.review_action === 'false_positive' || v.label === 'false_positive').length;
    const escalated = violations.filter(v => v.review_action === 'escalate').length;
    const fpRate = total > 0 ? ((falsePositives / total) * 100).toFixed(1) : '0.0';

    const bySeverity = { high: 0, medium: 0, low: 0 };
    const byConfidence = { high: 0, medium: 0, low: 0 };
    const byPolicy = {};
    const byRule = {};
    const byDate = {};

    for (const v of violations) {
        bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;

        const conf = v.confidence !== null && v.confidence !== undefined ? parseFloat(v.confidence) : 0.5;
        if (conf >= 0.7) byConfidence.high++;
        else if (conf >= 0.4) byConfidence.medium++;
        else byConfidence.low++;

        byPolicy[v.policy_name] = (byPolicy[v.policy_name] || 0) + 1;
        byRule[v.rule_name] = (byRule[v.rule_name] || 0) + 1;

        const day = new Date(v.detected_at).toISOString().split('T')[0];
        byDate[day] = (byDate[day] || 0) + 1;
    }

    // ── Build PDF ───────────────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // ── Cover / Header ────────────────────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 120).fill(COLORS.header);
        doc.fill('white').fontSize(26).font('Helvetica-Bold')
            .text('PolicyGuard AI', 50, 30);
        doc.fontSize(14).font('Helvetica')
            .text('Compliance Audit Report', 50, 62);
        doc.fontSize(10)
            .text(`Period: ${start.toDateString()} — ${end.toDateString()}`, 50, 86)
            .text(`Generated: ${new Date().toUTCString()}`, 50, 100);

        doc.moveDown(5);

        // ── Section 1: Executive Summary ──────────────────────────────────────────
        sectionHeader(doc, '1. Executive Summary');

        const summaryRows = [
            ['Total Violations Detected', String(total)],
            ['Confirmed Violations', String(confirmed)],
            ['False Positives', `${falsePositives} (${fpRate}%)`],
            ['Escalated', String(escalated)],
            ['High Severity', String(bySeverity.high)],
            ['Medium Severity', String(bySeverity.medium)],
            ['Low Severity', String(bySeverity.low)],
        ];
        drawTable(doc, summaryRows);

        // ── Section 2: Violations by Severity ─────────────────────────────────────
        sectionHeader(doc, '2. Violations by Severity');
        ['high', 'medium', 'low'].forEach(sev => {
            const sevViolations = violations.filter(v => v.severity === sev).slice(0, 10);
            if (sevViolations.length === 0) return;

            doc.fill(COLORS[sev]).fontSize(11).font('Helvetica-Bold')
                .text(`${sev.toUpperCase()} (${bySeverity[sev]} total)`, { indent: 10 });
            doc.fill(COLORS.text).font('Helvetica').fontSize(9);

            sevViolations.forEach(v => {
                const conf = v.confidence !== null ? `(${(parseFloat(v.confidence) * 100).toFixed(0)}% confidence)` : '';
                doc.text(`• [${v.policy_name}] ${v.rule_name} — Tx: ${v.transaction_id} ${conf}`, { indent: 20 });
            });
            if (bySeverity[sev] > 10) {
                doc.text(`   ... and ${bySeverity[sev] - 10} more`, { indent: 20 });
            }
            doc.moveDown(0.5);
        });

        // ── Section 3: Violations by Policy ───────────────────────────────────────
        sectionHeader(doc, '3. Violations by Policy');
        const policyRows = Object.entries(byPolicy).map(([name, count]) => [name, String(count)]);
        if (policyRows.length > 0) drawTable(doc, policyRows, ['Policy', 'Count']);
        else doc.text('No policy data available.', { indent: 10 }).moveDown();

        // ── Section 4: False Positive Rate ────────────────────────────────────────
        sectionHeader(doc, '4. False Positive Rate');
        doc.fill(COLORS.text).fontSize(10).font('Helvetica')
            .text(`Overall False Positive Rate: ${fpRate}%`, { indent: 10 });
        doc.text(`High-confidence violations (≥70%): ${byConfidence.high}`, { indent: 10 });
        doc.text(`Medium-confidence violations (40-70%): ${byConfidence.medium}`, { indent: 10 });
        doc.text(`Low-confidence violations (<40%): ${byConfidence.low}`, { indent: 10 });
        doc.moveDown();

        // ── Section 5: Trend ──────────────────────────────────────────────────────
        sectionHeader(doc, '5. Violation Trend (violations per day)');
        const sortedDates = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b));
        if (sortedDates.length > 0) {
            drawTable(doc, sortedDates.map(([d, n]) => [d, String(n)]), ['Date', 'Violations']);
        } else {
            doc.text('No daily trend data in this period.', { indent: 10 });
        }

        // ── Section 6: Top Rules by Violations ───────────────────────────────────
        sectionHeader(doc, '6. Top Rules by Violations');
        const topRules = Object.entries(byRule).sort(([, a], [, b]) => b - a).slice(0, 10);
        if (topRules.length > 0) drawTable(doc, topRules.map(([r, n]) => [r, String(n)]), ['Rule', 'Violations']);

        // ── Footer ────────────────────────────────────────────────────────────────
        doc.moveDown(2);
        doc.fill('#9ca3af').fontSize(8).font('Helvetica')
            .text('Generated by PolicyGuard AI — Confidential', { align: 'center' });

        doc.end();
    });
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const sectionHeader = (doc, title) => {
    if (doc.y > doc.page.height - 150) doc.addPage();
    doc.moveDown(0.5);
    doc.rect(50, doc.y, doc.page.width - 100, 22).fill(COLORS.light);
    doc.fill(COLORS.header).fontSize(12).font('Helvetica-Bold')
        .text(title, 55, doc.y - 17);
    doc.fill(COLORS.text).font('Helvetica').fontSize(10).moveDown(0.8);
};

const drawTable = (doc, rows, headers = null) => {
    const col1W = 280, col2W = 100;

    if (headers) {
        doc.fill('#374151').font('Helvetica-Bold').fontSize(9);
        doc.text(headers[0], 55, doc.y, { width: col1W });
        doc.text(headers[1], 55 + col1W, doc.y - doc.currentLineHeight(), { width: col2W });
        doc.moveDown(0.3);
    }

    for (const [label, value] of rows) {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const y = doc.y;
        doc.fill(COLORS.text).font('Helvetica').fontSize(9)
            .text(label, 55, y, { width: col1W, lineBreak: false });
        doc.fill(COLORS.accent).font('Helvetica-Bold')
            .text(value, 55 + col1W, y, { width: col2W });
        doc.moveDown(0.4);
    }
    doc.moveDown(0.5);
};

module.exports = { generateAuditReport };
