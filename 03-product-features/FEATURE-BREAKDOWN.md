# Product Features — Complete Breakdown

> **Last Updated:** July 3, 2026
> **Purpose:** Every feature we're building, organized by module, with priority and build phase

---

## Core Principles

1. **AI-native, not AI-decorated** — AI is in the data layer, not bolted on top
2. **India-first** — GST, TDS, e-invoicing built into the core, not as add-ons
3. **Self-serve** — Users can sign up and try without talking to sales
4. **Mobile-first** — WhatsApp + mobile app, not just web dashboard
5. **Human-in-the-loop** — AI suggests, humans approve. Full audit trail.

---

## Module 1: General Ledger (Core Accounting)

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 1.1 | Chart of Accounts | Indian-standard chart of accounts structure, customizable per company | 🔴 P1 | Critical |
| 1.2 | Journal Entries | Create, edit, post journal entries with double-entry bookkeeping | 🔴 P1 | Critical |
| 1.3 | Multi-Entity Support | Multiple legal entities in one account, consolidated reporting | 🟡 P2 | High |
| 1.4 | Multi-Book Accounting | Maintain books under Ind AS + GAAP + management accounts simultaneously | 🟡 P2 | High |
| 1.5 | Continuous Close | Real-time financial statements instead of month-end batch processing | 🔴 P1 | Critical |
| 1.6 | Multi-Currency | 180+ currencies, auto-convert using RBI reference rates | 🟡 P2 | High |
| 1.7 | Intercompany Reconciliation | Auto-match intercompany transactions, flag unmatched | 🟢 P3 | Medium |
| 1.8 | CTA/FCTR Reports | Cumulative Translation Adjustment / Foreign Currency Translation Reserve | 🟢 P3 | Medium |
| 1.9 | Account Reconciliation | GL account reconciliation workflows | 🔴 P1 | Critical |

---

## Module 2: GST Engine (India Moat)

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 2.1 | Auto GST Calculation | Auto-calculate CGST/SGST/IGST based on supply type (intra/inter-state) | 🔴 P1 | Critical |
| 2.2 | GST Returns — GSTR-1 | Auto-generate GSTR-1 (outward supplies) from transaction data | 🔴 P1 | Critical |
| 2.3 | GST Returns — GSTR-3B | Auto-generate GSTR-3B (summary return) from transaction data | 🔴 P1 | Critical |
| 2.4 | ITC Reconciliation | Match input tax credit with GSTR-2B, flag mismatches | 🔴 P1 | Critical |
| 2.5 | GSTIN Verification | Verify vendor/customer GSTIN status (active/suspended/cancelled) | 🔴 P1 | Critical |
| 2.6 | HSN/SAC Code Mapping | Map products/services to HSN/SAC codes, auto-determine GST rate | 🔴 P1 | Critical |
| 2.7 | GSTR-2B Import | Import GSTR-2B data from GSTN portal for ITC matching | 🔴 P1 | Critical |
| 2.8 | GST Audit Reports | Generate annual GST audit reports (GSTR-9, GSTR-9C) | 🟡 P2 | High |
| 2.9 | E-Invoicing (IRN) | Generate IRN + QR code via IRP API for B2B invoices | 🔴 P1 | Critical |
| 2.10 | E-Way Bill | Auto-generate e-way bills for goods movement >₹50K | 🔴 P1 | Critical |
| 2.11 | GST Reconciliation Dashboard | Visual dashboard showing match/mismatch between GSTR-1, GSTR-2B, books | 🟡 P2 | High |
| 2.12 | Multi-State GST | Handle registrations in multiple states, separate GSTINs | 🟡 P2 | High |

---

## Module 3: TDS Management

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 3.1 | Auto TDS Deduction | Auto-deduct TDS per section (194C, 194J, 194I, 194Q, etc.) based on vendor/payment type | 🔴 P1 | Critical |
| 3.2 | TDS Returns — 24Q | Salary TDS return (quarterly) | 🟡 P2 | High |
| 3.3 | TDS Returns — 26Q | Non-salary TDS return (quarterly) | 🟡 P2 | High |
| 3.4 | TDS Certificates | Auto-generate Form 16A / Form 16 for deductees | 🟡 P2 | High |
| 3.5 | TDS on Payments | Auto-deduct when vendor payment approved, before bank payout | 🔴 P1 | Critical |
| 3.6 | TDS Rate Lookup | Maintain TDS rate table by section, auto-update when rates change | 🔴 P1 | Critical |
| 3.7 | Lower TDS Certificate | Handle Form 13A (lower/no deduction) cases | 🟢 P3 | Medium |
| 3.8 | TRACES Integration | Download TDS return filing data from TRACES portal | 🟡 P2 | High |

---

## Module 4: Bank Reconciliation

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 4.1 | Bank Feed Integration | Auto-import bank transactions daily via Setu API | 🔴 P1 | Critical |
| 4.2 | Auto-Matching | AI matches bank transactions to invoices, bills, expenses | 🔴 P1 | Critical |
| 4.3 | Bank Statement Upload | Upload PDF/CSV statement as fallback when API unavailable | 🔴 P1 | Critical |
| 4.4 | Reconciliation Dashboard | Visual: matched, unmatched, suggested matches | 🔴 P1 | Critical |
| 4.5 | Auto-Categorization | AI categorizes unmatched transactions to correct GL accounts | 🔴 P1 | Critical |
| 4.6 | Duplicate Detection | Flag duplicate transactions, prevent double-posting | 🔴 P1 | Critical |
| 4.7 | Multi-Bank Support | Connect multiple bank accounts per entity | 🔴 P1 | Critical |
| 4.8 | Real-time Bank Feeds | Instant transaction notification (where supported) | 🟡 P2 | High |

---

## Module 5: Expense Management

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 5.1 | WhatsApp Receipt Bot | Employee sends receipt photo → OCR → draft expense created | 🔴 P1 | Critical |
| 5.2 | Email Receipt Forwarding | Forward receipt to receipts@company.com → OCR → draft expense | 🔴 P1 | Critical |
| 5.3 | Mobile App — Photo Capture | Take photo in app → OCR → submit expense | 🔴 P1 | Critical |
| 5.4 | Corporate Card Integration | Real-time card transaction feed (Razorpay Corporate Cards) | 🔴 P1 | Critical |
| 5.5 | Approval Workflow | Manager approves/rejects expenses (WhatsApp/mobile/web) | 🔴 P1 | Critical |
| 5.6 | Auto-Categorization | AI categorizes expense based on merchant, amount, description | 🔴 P1 | Critical |
| 5.7 | Policy Enforcement | Set rules: max amount per category, blocked merchants, daily/monthly limits | 🔴 P1 | Critical |
| 5.8 | Reimbursement Tracking | Track reimbursements owed to employees, sync with payroll | 🟡 P2 | High |
| 5.9 | Mileage Tracking | GPS-based or manual mileage entry for travel expenses | 🟡 P2 | Medium |
| 5.10 | Per Diem | Daily allowance tracking for travel, auto-calculated | 🟢 P3 | Low |
| 5.11 | Anomaly Detection | AI flags suspicious expenses (personal merchant, unusual amount) | 🔴 P1 | Critical |
| 5.12 | Receipt Matching | Match expense to bank/card transaction automatically | 🔴 P1 | Critical |

---

## Module 6: Accounts Payable (Vendor Bills)

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 6.1 | Vendor Master | Vendor database with GSTIN, PAN, payment terms, bank details | 🔴 P1 | Critical |
| 6.2 | Invoice OCR | Vendor invoice → OCR → extract amount, GST, line items, vendor | 🔴 P1 | Critical |
| 6.3 | Bill Approval Workflow | Bill → manager approval → payment scheduling | 🔴 P1 | Critical |
| 6.4 | Auto TDS on Vendor Payment | Calculate and deduct TDS before vendor payout | 🔴 P1 | Critical |
| 6.5 | Payment Scheduling | Schedule NEFT/RTGS/IMPS/UPI payments, batch processing | 🟡 P2 | High |
| 6.6 | Vendor Aging Report | Outstanding bills by vendor, by age bucket | 🔴 P1 | Critical |
| 6.7 | Recurring Bills | Auto-generate monthly bills (rent, internet, SaaS subscriptions) | 🟡 P2 | High |
| 6.8 | Purchase Order Matching | Match bill to PO, flag mismatches (3-way match: PO + bill + receipt) | 🟢 P3 | Medium |

---

## Module 7: Accounts Receivable (Customer Invoicing)

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 7.1 | Customer Master | Customer database with GSTIN, billing address, payment terms | 🔴 P1 | Critical |
| 7.2 | Invoice Generation | Create GST-compliant invoices (tax invoice, bill of supply) | 🔴 P1 | Critical |
| 7.3 | E-Invoicing (IRN) | Auto-generate IRN + QR code for B2B invoices | 🔴 P1 | Critical |
| 7.4 | Invoice Delivery | Send invoice via WhatsApp + Email + PDF download | 🔴 P1 | Critical |
| 7.5 | Payment Tracking | Track invoice payment status (unpaid, partial, paid, overdue) | 🔴 P1 | Critical |
| 7.6 | Auto-Reconciliation | Match incoming payments to invoices via bank feed | 🔴 P1 | Critical |
| 7.7 | Invoice Reminders | Auto-send payment reminders via WhatsApp/Email on schedule | 🔴 P1 | Critical |
| 7.8 | Credit Note Management | Issue credit notes for returns, adjustments | 🟡 P2 | High |
| 7.9 | Customer Aging Report | Outstanding receivables by customer, by age bucket | 🔴 P1 | Critical |
| 7.10 | Dunning (Escalation) | Escalating reminder frequency: 7 days → 15 days → 30 days → legal notice | 🟡 P2 | High |
| 7.11 | Recurring Invoicing | Auto-generate monthly invoices for subscription customers | 🟡 P2 | High |
| 7.12 | Invoice Batch | Batch invoice generation for multiple customers | 🟡 P2 | Medium |

---

## Module 8: Revenue Recognition

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 8.1 | ASC 606 / Ind AS 115 | Revenue recognition compliant with accounting standards | 🟡 P2 | High |
| 8.2 | Subscription Revenue | Auto-recognize subscription revenue over service period | 🟡 P2 | High |
| 8.3 | Usage-Based Revenue | Recognize revenue based on usage data (API calls, etc.) | 🟡 P2 | High |
| 8.4 | Contract Modifications | Handle mid-contract changes, updated revenue schedules | 🟢 P3 | Medium |
| 8.5 | Multi-Element Arrangements | Bundled pricing (hardware + service + software) | 🟢 P3 | Medium |
| 8.6 | Deferred Revenue | Track deferred revenue, auto-release over time | 🟡 P2 | High |
| 8.7 | Revenue Waterfall | Revenue recognition waterfall report | 🟡 P2 | High |

---

## Module 9: Close Management

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 9.1 | Close Checklist | Monthly close checklist with tasks, assignees, due dates | 🔴 P1 | Critical |
| 9.2 | AI-Powered Close Prep | AI auto-completes close checklist items (reconciliation, posting accruals) | 🟡 P2 | High |
| 9.3 | Flux Analysis | Period-over-period variance analysis with AI explanations | 🟡 P2 | High |
| 9.4 | Close Automation | AI agents run close tasks: post JE, reconcile, generate reports | 🟡 P2 | High |
| 9.5 | Close Calendar | Visual calendar showing close timeline, dependencies | 🟡 P2 | Medium |
| 9.6 | Pre-Close Checklist | Tasks done BEFORE month-end (accruals, estimates, cut-off) | 🟡 P2 | Medium |

---

## Module 10: AI Engine ("Jarvis" — Our Ember Equivalent)

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 10.1 | Transaction Categorization | AI auto-categorizes every transaction to correct GL account | 🔴 P1 | Critical |
| 10.2 | Bank Reconciliation AI | AI matches bank transactions to invoices/bills automatically | 🔴 P1 | Critical |
| 10.3 | Anomaly Detection | AI flags unusual transactions, duplicates, suspicious expenses | 🔴 P1 | Critical |
| 10.4 | Vendor Pattern Learning | AI learns vendor patterns: "Amazon" → Office Supplies, "Jio" → Internet | 🔴 P1 | Critical |
| 10.5 | GST Anomaly Detection | AI flags GST rate mismatches, ITC mismatches, wrong HSN codes | 🔴 P1 | Critical |
| 10.6 | Ask AI (Conversational) | "How much cash do we have?" / "Is month ka kharcha kitna hua?" — answers in 30 sec | 🔴 P1 | Critical |
| 10.7 | AI Agents — Continuous | 24/7 background agents: reconcile, categorize, flag anomalies, chase invoices | 🟡 P2 | High |
| 10.8 | AI Agents — On-Demand | Scheduled agents: flux analysis, close prep, board reports | 🟡 P2 | High |
| 10.9 | Hindi + English Support | AI understands and responds in Hindi and English | 🔴 P1 | Critical |
| 10.10 | Paper Trail | Every AI action has full audit trail — source data, reasoning, timestamp | 🔴 P1 | Critical |
| 10.11 | Confidence Thresholds | User sets confidence level: high = auto-apply, low = needs review | 🔴 P1 | Critical |
| 10.12 | Slip Integration | "Ask Jarvis in Slack" or "Ask Jarvis in WhatsApp" — query from chat | 🟡 P2 | High |
| 10.13 | Custom AI Skills | Save reusable AI instructions for repeated workflows | 🟢 P3 | Medium |
| 10.14 | Image Paste Support | Drop screenshot/image into chat → AI processes it | 🟡 P2 | Medium |
| 10.15 | Regional Language Expansion | Add Tamil, Telugu, Marathi, Bengali support | 🟢 P3 | Low |

---

## Module 11: Reporting & Dashboards

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 11.1 | Real-Time P&L | Profit & Loss statement, real-time, drill-down to transaction | 🔴 P1 | Critical |
| 11.2 | Real-Time Balance Sheet | Balance sheet, real-time, drill-down | 🔴 P1 | Compliance |
| 11.3 | Cash Flow Statement | Cash flow (direct/indirect), real-time | 🔴 P1 | Critical |
| 11.4 | Trial Balance | Trial balance with drill-down | 🔴 P1 | Critical |
| 11.5 | Executive Dashboard | Cash position, burn rate, runway, top expenses, revenue | 🔴 P1 | Critical |
| 11.6 | Custom Reports | Build custom reports with drag-and-drop | 🟡 P2 | High |
| 11.7 | Budget vs Actuals | Track budget vs actuals, variance analysis | 🟡 P2 | High |
| 11.8 | Board Reporting | Auto-generate board-ready reports (via AI agent) | 🟡 P2 | High |
| 11.9 | Consolidated Reports | Multi-entity consolidated financials | 🟡 P2 | High |
| 11.10 | GST Reports | GSTR-1, GSTR-3B, GSTR-9, ITC reports, HSN summary | 🔴 P1 | Compliance |
| 11.11 | TDS Reports | TDS deduction summary, 24Q/26Q data, Form 16A | 🟡 P2 | Compliance |
| 11.12 | Export — Excel/PDF/CSV | Export any report to Excel/PDF/CSV | 🔴 P1 | Critical |
| 11.13 | Scheduled Reports | Auto-email reports on schedule (weekly/monthually) | 🟡 P2 | High |

---

## Module 12: Multi-Entity & Consolidation

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 12.1 | Multiple Entities | Multiple legal entities in one account | 🟡 P2 | High |
| 12.2 | Consolidated Financials | Real-time consolidated P&L, BS, CF across entities | 🟡 P2 | High |
| 12.3 | Intercompany Transactions | Auto-match intercompany transactions; auto-eliminate on consolidation | 🟢 P3 | Medium |
| 12.4 | Multi-State GST | Handle separate GSTINs per state, per entity | 🟡 P2 | High |
| 12.5 | Multi-Currency Consolidation | Consolidate entities in different currencies | 🟢 P3 | Medium |

---

## Module 13: Security & Compliance

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 13.1 | Role-Based Access Control | Granular permissions: view, edit, approve, admin per module | 🔴 P1 | Critical |
| 13.2 | Approval Workflows | Multi-level approval for payments, JEs, expenses | 🔴 P1 | Critical |
| 12.3 | Full Audit Trail | Every action logged: who, what, when, why | 🔴 P1 | Compliance |
| 13.4 | DPDP Act Compliance | Digital Personal Data Protection Act — India's data privacy law | 🔴 P1 | Compliance |
| 13.5 | Data Residency | All financial data stored in India (AWS Mumbai) | 🔴 P1 | Compliance |
| 13.6 | Two-Factor Authentication | 2FA for all users | 🔴 P1 | Critical |
| 13.7 | SOC 2 / ISO 27001 | Security certification for enterprise customers | 🟡 P2 | High |
| 13.8 | IP Whitelisting | Restrict access by IP for enterprise customers | 🟢 P3 | Medium |
| 13.9 | Data Encryption | At-rest + in-transit encryption | 🔴 P1 | Critical |

---

## Module 14: Migration Tools

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 14.1 | Tally ERP 9 Import | Import COA, vendors, customers, inventory, historical transactions from Tally | 🔴 P1 | Critical |
| 14.2 | Tally Prime Import | Same as above for Tally Prime | 🔴 P1 | Critical |
| 14.3 | QuickBooks India Import | Import from QuickBooks (Intuit exited India — users need migration) | 🟡 P2 | High |
| 4.4 | Zoho Books Import | Import from Zoho Books | 🟡 P2 | High |
| 14.5 | Excel/CSV Import | Universal import from any system via Excel/CSV | 🔴 P1 | Critical |
| 14.6 | SAP B1 Import | Import from SAP B1 | 🟢 P3 | Medium |
| 14.7 | Migration Wizard | Step-by-step guided migration flow | 🔴 P1 | Critical |

---

## Module 15: Self-Serve & Onboarding

| # | Feature | Description | Phase | Priority |
|---|---------|-------------|-------|----------|
| 15.1 | Self-Serve Signup | User signs up online without talking to sales | 🔴 P1 | Critical |
| 15.2 | Free Tier | Free plan with limited features (up to 100 transactions/mo) | 🔴 P1 | Critical |
| 15.3 | Onboarding Wizard | Step-by-step setup: company info, COA, bank connect, GST setup | 🔴 P1 | Critical |
| 15.4 | Demo Data | Pre-populated demo company for users to explore | 🟡 P2 | High |
| 15.5 | Interactive Tour | In-app tour highlighting key features | 🟡 P2 | Medium |

---

## Feature Count Summary

| Module | Total Features | Phase 1 (MVP) | Phase 2 | Phase 3 |
|--------|---------------|---------------|---------|---------|
| General Ledger | 9 | 4 | 3 | 2 |
| GST Engine | 12 | 10 | 2 | 0 |
| TDS Management | 8 | 3 | 4 | 1 |
| Bank Reconciliation | 8 | 7 | 1 | 0 |
| Expense Management | 12 | 9 | 2 | 1 |
| Accounts Payable | 8 | 5 | 2 | 1 |
| Accounts Receivable | 12 | 8 | 3 | 1 |
| Revenue Recognition | 7 | 0 | 5 | 2 |
| Close Management | 6 | 1 | 4 | 1 |
| AI Engine | 15 | 9 | 4 | 2 |
| Reporting & Dashboards | 13 | 7 | 5 | 1 |
| Multi-Entity | 5 | 0 | 3 | 2 |
| Security & Compliance | 9 | 6 | 1 | 2 |
| Migration Tools | 7 | 4 | 2 | 1 |
| Self-Serve & Onboarding | 5 | 3 | 2 | 0 |
| **TOTAL** | **~140** | **76** | **43** | **17** |

**76 features for Phase 1 MVP.** That's a lot but many are sub-features of the same core workflow.