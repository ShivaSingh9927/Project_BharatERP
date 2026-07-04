# System Architecture — India ERP

> **Last Updated:** July 3, 2026
> **Purpose:** How data flows through the system, service boundaries, deployment topology

---

## High-Level Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │              USER TOUCHPOINTS                 │
                    ├──────────┬──────────┬──────────┬──────────────┤
                    │  Web App │ Mobile   │ WhatsApp │ Email/Slack  │
                    │ Next.js  │ Expo RN  │   Bot    │ Ingestion   │
                    └─────┬────┴────┬─────┴────┬─────┴──────┬───────┘
                          │         │          │             │
                    ┌─────▼─────────▼──────────▼─────────────▼───────┐
                    │              API GATEWAY                        │
                    │         (Fastify + tRPC)                         │
                    │     Rate limiting · Auth · CORS · Webhooks     │
                    └─────┬────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────────────────┐
          │               │                            │
    ┌─────▼─────┐  ┌──────▼──────┐          ┌──────────▼──────────┐
    │  CORE API  │  │  AI SERVICE  │          │  INTEGRATION WORKER  │
    │ (Node.js)  │  │  (Python)    │          │   (Node.js + BullMQ) │
    │             │  │              │          │                     │
    │ • GL Engine │  │ • Categorize │          │ • Bank Feeds (Setu) │
    │ • GST Engine│  │ • Reconcile  │          │ • Razorpay Webhooks │
    │ • TDS Engine│  │ • Anomaly    │          │ • GSTN IRP API      │
    │ • AR/AP    │  │ • Ask AI     │          │ • ClearTax Filing   │
    │ • Reporting│  │ • OCR Parse  │          │ • WhatsApp Bot      │
    │ • Auth/RBAC│  │ • Flux Analysis│        │ • Email Ingestion   │
    └─────┬──────┘  └──────┬──────┘          │ • E-Way Bill API    │
          │                │                  │ • Scheduled Reports │
          │                │                  └──────────┬──────────┘
          │                │                            │
    ┌─────▼────────────────▼────────────────────────────▼──────┐
    │                     DATA LAYER                            │
    │  ┌────────────┐  ┌────────┐  ┌───────────┐  ┌─────────┐ │
    │  │ PostgreSQL  │  │ Redis  │  │  S3 (Mumbai)│  │pgvector│ │
    │  │ (Primary)   │  │(Queue/ │  │  (Files)     │  │(Vector)│ │
    │  │              │  │ Cache) │  │              │  │        │ │
    │  └────────────┘  └────────┘  └───────────┘  └─────────┘ │
    └───────────────────────────────────────────────────────────┘
```

---

## Service Breakdown

### 1. Core API (Node.js + Fastify)
**Responsibilities:**
- General Ledger engine (journal entries, chart of accounts)
- GST engine (calculations, return data preparation)
- TDS engine (deduction calculation, return data)
- AR/AP (invoices, bills, vendor/customer management)
- Bank reconciliation logic
- Reporting (P&L, BS, CF, trial balance)
- Authentication, authorization, RBAC
- Multi-entity, multi-currency

**Port:** 3001
**Scale:** Horizontal — stateless, behind load balancer

### 2. AI Service (Python + FastAPI)
**Responsibilities:**
- Transaction categorization (DeepSeek/GPT-4o)
- Bank reconciliation matching (ML + rules)
- Anomaly detection (amount, vendor, category)
- "Ask AI" conversational interface (RAG with pgvector)
- OCR parsing (Google Document AI → structured data)
- Flux analysis (period-over-period variance with AI explanation)
- GST anomaly detection (rate mismatch, ITC mismatch)
- Hindi/English natural language processing
- Receipt OCR extraction
- Invoice OCR extraction

**Port:** 3002
**Scale:** Horizontal — stateless, GPU only for OCR (if self-hosted)

### 3. Integration Worker (Node.js + BullMQ)
**Responsibilities:**
- Bank feed polling (Setu — daily/scheduled)
- Razorpay webhook processing (real-time payments)
- GSTN IRP API calls (e-invoice generation)
- E-Way Bill API calls
- ClearTax API (GST filing, TDS filing, ITC reconciliation)
- WhatsApp Bot (send/receive messages)
- Email ingestion (IMAP polling — receipts@company.com)
- Scheduled reports (email/WhatsApp)
- Invoice reminders (WhatsApp/Email)
- Razorpay Corporate Card feed
- Dunning / payment chasing
- Cron jobs (scheduled tasks)

**Port:** 3003 (no public API — internal worker)
**Scale:** Vertical scale (Redis queue handles concurrency)

---

## Data Flow: Key Workflows

### Workflow 1: Bank Transaction → Categorized GL Entry

```
1. Setu API fetches bank transactions (daily at 6 AM)
     ↓
2. Integration Worker receives transactions → enqueues in BullMQ
     ↓
3. Core API stores raw transactions in bank_transactions table
     ↓
4. AI Service receives transaction → categorizes:
     - "₹2,450 to Swiggy" → "Employee Meals" (account_code: 5015)
     - "₹15,000 to Airtel" → "Internet" (account_code: 5012)
     ↓
5. AI Service returns: { account_code, confidence_score, reasoning }
     ↓
6. If confidence > threshold → auto-post to GL
   If confidence < threshold → queue for human review
     ↓
7. Journal entry created: Debit expense, Credit bank
     ↓
8. Notification sent to user (WhatsApp/web): "₹2,450 to Swiggy categorized as Employee Meals ✓"
     ↓
9. User reviews: Approve → posts permanently | Reject → re-categorize
     ↓
10. AI action logged in ai_actions table (full audit trail)
```

### Workflow 2: Expense Receipt via WhatsApp

```
1. Employee takes photo of receipt (taxi, food, supplies)
     ↓
2. Sends photo to company WhatsApp number
     ↓
3. WhatsApp webhook → Integration Worker → enqueues in BullMQ
     ↓
4. AI Service: Google Document AI extracts:
     - Amount, vendor, date, GST (if present), items
     ↓
5. AI Service: Categorizes expense (taxi → Travel, food → Meals)
     ↓
6. Core API: Creates draft expense entry
     - Status: pending_approval
     - Employee: detected from WhatsApp number mapping
     ↓
7. WhatsApp response to employee:
     "Receipt received ✓
      Amount: ₹450
      Vendor: Ola
      Category: Travel - Local
      Type 'approve' to submit or 'reject'"
     ↓
8. Employee types "approve" → expense submitted to manager
     ↓
9. Manager gets WhatsApp notification:
     "New expense approval:
      Employee: Rahul
      Amount: ₹450
      Vendor: Ola
      Category: Travel
      Reply 'approve' or 'reject'"
     ↓
10. Manager approves → expense posts to GL → reimbursement queued for payroll
```

### Workflow 3: GST-Compliant Invoice + E-Invoicing

```
1. User creates invoice in web app or API
     ↓
2. Core API: GST engine calculates:
     - If intra-state: CGST + SGST
     - If inter-state: IGST
     - Based on customer GSTIN state vs company state
     ↓
3. Core API: Creates invoice record with:
     - Invoice number (auto-numbered)
     - Line items with HSN/SAC codes
     - GST amounts per line
     - Total invoice value
     - Customer GSTIN
     ↓
4. If B2B invoice → Integration Worker:
     - Sends invoice JSON to IRP API
     - IRP returns: IRN + QR code + signed invoice
     ↓
5. Core API: Stores IRN + QR code
     - QR code embedded in invoice PDF
     ↓
6. Integration Worker: Sends invoice via:
     - WhatsApp (PDF)
     - Email (PDF)
     - Download link in web app
     ↓
7. Invoice appears in GSTR-1 data (auto-queued for next filing)
     ↓
8. If goods being transported >₹50K:
     - Auto-generate e-way bill
     - E-way bill number sent to user
```

### Workflow 4: Monthly GST Filing

```
1. 1st of every month: Integration Worker runs cron job
     ↓
2. Core API: Prepares GSTR-1 data from all B2B invoices of previous month
     ↓
3. Core API: Prepares GSTR-3B summary (total supplies, ITC, tax payable)
     ↓
4. Integration Worker: Sends data to ClearTax API
     ↓
5. ClearTax:
     - Files GSTR-1 on GSTN portal
     - Files GSTR-3B on GSTN portal
     - Returns filing confirmation + reference numbers
     ↓
6. Core API: Stores filing confirmation
     ↓
7. User gets WhatsApp notification:
     "✅ GSTR-1 filed for July 2026
      Reference: AJKHS1234F
      Total taxable: ₹12,45,000
      Total tax: ₹2,24,100"
     ↓
8. Dashboard updates: GST filing status = Filed
```

### Workflow 5: "Ask AI" — Conversational Query

```
1. User types in web app or WhatsApp:
   "Is month ka total kharcha kitna hua?"
   (What's the total expense this month?)
     ↓
2. Core API: Receives query → routes to AI Service
     ↓
3. AI Service:
     a. Translates Hindi → English (if needed)
     b. Converts to SQL query using schema knowledge:
        SELECT SUM(debit) FROM journal_lines jl
        JOIN journal_entries je ON jl.je_id = je.id
        JOIN accounts a ON jl.account_id = a.id
        WHERE a.type = 'expense'
        AND je.date >= '2026-07-01'
        AND je.company_id = {company_id}
     c. Executes query on PostgreSQL
     d. Gets result: ₹4,50,000
     e. Generates natural language response in Hindi:
        "Is month ka total kharcha ₹4,50,000 hai.
         Top categories:
         1. Salaries: ₹2,80,000
         2. Rent: ₹50,000
         3. Software: ₹45,000
         4. Travel: ₹30,000
         5. Others: ₹45,000"
     ↓
4. Response returned to user (web/WhatsApp) with source data links
     ↓
5. Full Paper Trail stored:
     - User question
     - SQL generated
     - Data returned
     - AI response
     - Timestamp
```

---

## Multi-Tenancy Strategy

```
Tenancy Model: Shared Database, Shared Schema (with Row-Level Security)

┌──────────────────────────────────────────┐
│            PostgreSQL Instance            │
│  ┌─────────────────────────────────────┐ │
│  │  companies table (tenant registry)  │ │
│  │  Every table has company_id column   │ │
│  │  Row-Level Security (RLS) policies   │ │
│  │  ensure tenant isolation            │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  RLS Policy Example:                      │
│  CREATE POLICY tenant_isolation          │
│  ON journal_entries                       │
│  USING (company_id = current_setting       │
│  ('app.company_id')::uuid);              │
└──────────────────────────────────────────┘
```

**Benefits:**
- Single database instance, lower cost
- Row-Level Security ensures data isolation
- Easy to query across tenants for platform analytics
- Can migrate to separate databases later if needed

---

## Deployment Topology

```
┌────────────────────────── AWS Mumbai (ap-south-1) ──────────────────────────┐
│                                                                              │
│  ┌────────────────┐     ┌────────────────┐     ┌────────────────┐          │
│  │  ECS Service 1  │     │  ECS Service 2  │     │  ECS Service 3  │          │
│  │  Core API       │     │  AI Service     │     │  Worker         │          │
│  │  (2 tasks min)  │     │  (1 task min)   │     │  (1 task min)   │          │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘          │
│           │                       │                        │                   │
│  ┌────────▼─────────────────────────────────────────────────▼──────┐          │
│  │                     Application Load Balancer                     │          │
│  │                     (public + internal)                          │          │
│  └──────────────────────────────────────────────────────────────────┘          │
│                                                                                  │
│  ┌────────────────┐     ┌────────────────┐     ┌────────────────┐          │
│  │  RDS PostgreSQL │     │  ElastiCache    │     │  S3 Bucket     │          │
│  │  16 (Multi-AZ) │     │  Redis 7        │     │  (Mumbai)       │          │
│  │  + pgvector     │     │  (cache + queue)│     │  (files, PDFs)  │          │
│  └────────────────┘     └────────────────┘     └────────────────┘          │
│                                                                                  │
│  ┌────────────────┐                    ┌────────────────┐                    │
│  │  Cloudwatch     │                    │  Secrets         │                    │
│  │  (logs + metrics)│                   │  Manager         │                    │
│  └────────────────┘                    └────────────────┘                    │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────┐
                    │   Cloudflare     │
                    │   CDN + DNS +    │
                    │   WAF + SSL      │
                    └─────────────────┘
```

---

## Queue Architecture (BullMQ)

```
Redis
├── Queue: bank-feeds          → Setu API polling (daily)
├── Queue: pay-webhooks        → Razorpay payment events (real-time)
├── Queue: irn-generation      → E-invoicing IRN generation (on invoice create)
├── Queue: eway-bills          → E-way bill generation
├── Queue: gst-filing          → ClearTax GST filing (monthly)
├── Queue: tds-filing          → ClearTax TDS filing (quarterly)
├── Queue: ai-categorization   → Transaction categorization (on bank feed)
├── Queue: ai-anomaly          → Anomaly detection (on transaction)
├── Queue: ocr-receipts        → Receipt OCR (on WhatsApp/email)
├── Queue: ocr-invoices        → Vendor invoice OCR
├── Queue: whatsapp-send       → Send WhatsApp messages
├── Queue: whatsapp-receive    → Process incoming WhatsApp messages
├── Queue: email-send          → Send emails (invoices, reports)
├── Queue: email-receive       → IMAP poll (receipts@company.com)
├── Queue: reminders           → Invoice payment reminders (scheduled)
├── Queue: reports             → Scheduled financial reports
├── Queue: ai-query            → "Ask AI" queries
└── Queue: dead-letter         → Failed jobs for retry
```

---

## Security Architecture

```
┌──────────────────────────────────────────────┐
│                  INTERNET                     │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│           Cloudflare WAF + DDoS               │
│  • Rate limiting                              │
│  • SQL injection detection                    │
│  • XSS protection                             │
│  • Bot detection                              │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│           Application Load Balancer            │
│  • TLS 1.3 termination                        │
│  • Internal routing                           │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│              API Gateway (Fastify)             │
│  • Auth (JWT + Clerk)                         │
│  • Rate limiting (Redis)                      │
│  • Input validation (Zod)                    │
│  • CORS                                       │
│  • Audit logging                             │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│              Core API → PostgreSQL             │
│  • Row-Level Security (tenant isolation)      │
│  • Parameterized queries only (no raw SQL)    │
│  • Encrypted PII columns (PAN, Aadhaar)      │
│  • Audit triggers on all tables              │
└──────────────────────────────────────────────┘

Secrets Management:
- All API keys stored in AWS Secrets Manager
- Never in code, never in frontend
- Rotated quarterly
- Per-customer keys encrypted at rest

Data Encryption:
- At Rest: PostgreSQL TDE + S3 SSE-KMS
- In Transit: TLS 1.3 everywhere
- PII Tokenization: PAN, Aadhaar stored as tokens (real values in vault)
```

---

## Scaling Strategy

| Component | When to Scale | How |
|-----------|--------------|-----|
| Core API | API response time > 200ms | Add ECS tasks (horizontal) |
| AI Service | Categorization queue > 100 pending | Add AI Service instances |
| Worker | Job backlog > 500 | Add worker instances |
| PostgreSQL | CPU > 70% or connections maxed | Read replica → vertical scale → partition |
| Redis | Memory > 70% | Vertical scale (ElastiCache) |
| S3 | Automatic | S3 scales infinitely |
| WhatsApp Bot | Message volume > 10K/day | Multiple WhatsApp numbers (rate limit per number) |

---

## Disaster Recovery

| Component | Strategy | RTO | RPO |
|-----------|----------|-----|-----|
| PostgreSQL | Automated daily backup + PITR (Point-in-Time Recovery) | 1 hour | 5 min |
| Redis | No persistence needed (queue data is transient) | 5 min | N/A |
| S3 | Versioning + cross-region replication | 0 | 0 |
| Application | Multi-AZ ECS deployment | 5 min | N/A |
| DNS | Cloudflare failover | instant | N/A |

---

## Estimated Infrastructure Cost (At Launch)

| Component | Spec | Cost/mo (USD) |
|-----------|------|---------------|
| ECS Core API (2 tasks) | 1 vCPU, 2GB each | $80 |
| ECS AI Service (1 task) | 2 vCPU, 4GB | $60 |
| ECS Worker (1 task) | 1 vCPU, 2GB | $40 |
| RDS PostgreSQL (Multi-AZ) | db.t4g.medium | $70 |
| ElastiCache Redis | cache.t4g.micro | $25 |
| S3 Storage | 50GB | $5 |
| CloudFront/Cloudflare | Pro | $20 |
| Secrets Manager | 10 secrets | $4 |
| Cloudwatch | Logs + metrics | $15 |
| Load Balancer | ALB | $18 |
| Data Transfer | ~100GB | $10 |
| **Total Infrastructure** | | **~$347/mo** |
| **With AI API calls** | ~50 customers | **~$800-1,200/mo** |