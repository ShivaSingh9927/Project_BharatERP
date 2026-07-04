# Build Roadmap — India ERP

> **Last Updated:** July 3, 2026
> **Purpose:** Phase-by-phase build plan with milestones, features, and timelines

---

## Overview

| Phase | Duration | Goal | Features | Team |
|-------|----------|------|----------|------|
| Phase 1 — MVP | Months 1-4 | Launch with core accounting + GST + bank feeds | 76 features | 4-6 devs |
| Phase 2 — Growth | Months 5-8 | Add AI agents, expense management, multi-entity | 43 features | 6-10 devs |
| Phase 3 — Scale | Months 9-12 | Enterprise features, integrations, fine-tuned AI | 17 features | 10-14 devs |

---

## Phase 1: MVP (Months 1-4)

**Goal:** A working ERP that a small Indian business can sign up for, connect their bank, auto-categorize transactions, file GST, and generate financial statements.

### Sprint 1 (Weeks 1-3): Foundation

| Task | What | Who | Deliverable |
|------|------|-----|-------------|
| 1.1 | Project setup — monorepo (Turborepo), Next.js web, Fastify API, PostgreSQL schema | 1 dev | Working repo with dev environment |
| 1.2 | Database schema — companies, entities, accounts, JEs, journal lines, vendors, customers, invoices, bills, bank_accounts, bank_transactions | 1 dev | Migration files + seed data |
| 1.3 | Auth — Clerk integration, multi-tenant, RBAC roles | 1 dev | Login/signup/2FA working |
| 1.4 | Chart of Accounts — Indian standard COA template, wizard for customization | 1 dev | COA setup wizard |
| 1.5 | Company onboarding — signup → company info → GSTIN → COA → bank connect | 1 dev | Onboarding flow |

### Sprint 2 (Weeks 4-6): Core Accounting

| Task | What | Who | Deliverable |
|------|------|-----|-------------|
| 2.1 | Journal entries — create, edit, post, double-entry validation | 1 dev | GL working |
| 2.2 | Trial balance — auto-generate from JEs | 1 dev | Report |
| 2.3 | P&L statement — real-time from JEs | 1 dev | Report |
| 2.4 | Balance sheet — real-time from JEs | 1 dev | Report |
| 2.5 | Cash flow statement — from JEs | 1 dev | Report |
| 2.6 | Dashboard — cash position, P&L summary, recent transactions | 1 dev | Main dashboard |

### Sprint 3 (Weeks 7-9): GST Engine

| Task | What | Who | Deliverable |
|------|------|-----|-------------|
| 3.1 | GST calculation engine — CGST/SGST/IGST auto-calc | 1 dev | GST engine |
| 3.2 | Invoice generation — GST-compliant invoices with HSN/SAC | 1 dev | Invoice form |
| 3.3 | E-Invoicing (IRN) — GSTN IRP API integration | 1 dev | IRN generation working |
| 3.4 | E-Way Bill — GSTN EWB API integration | 1 dev | E-way bill generation |
| 3.5 | GSTR-1 data prep — aggregate invoice data into GSTR-1 format | 1 dev | GSTR-1 report |
| 3.6 | GSTR-3B data prep — summary return data | 1 dev | GSTR-3B report |
| 3.7 | ClearTax API integration — file GSTR-1 + GSTR-3B via ClearTax | 1 dev | GST filing working end-to-end |
| 3.8 | GSTIN verification — verify vendor GSTIN status | 1 dev | Verification endpoint |

### Sprint 4 (Weeks 10-12): Bank Reconciliation + AI

| Task | What | Who | Deliverable |
|------|------|-----|-------------|
| 4.1 | Bank statement upload — PDF/CSV parser for major Indian banks | 1 dev | Upload + parse |
| 4.2 | Setu API integration — bank feed auto-import | 1 dev | Bank feed working |
| 4.3 | Transaction matching — rule-based matching (amount, date, description) | 1 dev | Reconciliation engine |
| 4.4 | AI categorization — DeepSeek API for auto-categorization | 1 dev | AI categorization working |
| 4.5 | AI anomaly detection — flag unusual transactions | 1 dev | Anomaly engine |
| 4.6 | Reconciliation dashboard — matched, unmatched, suggested | 1 dev | Dashboard |
| 4.7 | Confidence thresholds — auto-apply high confidence, queue low | 1 dev | Threshold system |

### Sprint 5 (Weeks 13-15): Expense Management + WhatsApp

| Task | What | Who | Deliverable |
|------|------|-----|-------------|
| 5.1 | WhatsApp Business API — setup + send/receive messages | 1 dev | WhatsApp bot working |
| 5.2 | Receipt OCR — Google Document AI → extract amount, vendor, date | 1 dev | OCR pipeline |
| 5.3 | WhatsApp receipt flow — photo → OCR → draft expense | 1 dev | End-to-end WhatsApp expense |
| 5.4 | Expense approval workflow — manager approve/reject (WhatsApp + web) | 1 dev | Approval flow |
| 5.5 | Corporate card integration — Razorpay Corporate Cards feed | 1 dev | Card feed |
| 5.6 | Policy enforcement — rules for limits, categories, blocked merchants | 1 dev | Policy engine |

### Sprint 6 (Weeks 16-18): TDS + Polish + Launch

| Task | What | Who | Deliverable |
|------|------|-----|-------------|
| 6.1 | TDS engine — auto-deduct per section (194C, 194J, 194I, etc.) | 1 dev | TDS calculation |
| 6.2 | TDS rate lookup — maintain rate table by section | 1 dev | Rate table |
| 6.3 | Vendor management — vendor master with GSTIN, PAN, payment terms | 1 dev | Vendor module |
| 6.4 | Vendor bill OCR — email ingestion → OCR → bill creation | 1 dev | AP automation |
| 6.5 | Customer aging report — outstanding receivables by age | 1 dev | AR report |
| 6.6 | Vendor aging report — outstanding payables by age | 1 dev | AP report |
| 6.7 | Ask AI (basic) — "How much cash do we have?" type queries | 1 dev | Conversational AI |
| 6.8 | Onboarding wizard polish — guided setup with sample data | 1 dev | Smooth onboarding |
| 6.9 | Landing page + pricing page | 1 dev | Marketing site |
| 6.10 | Bug fixing + testing + security audit | All | Production-ready |

### Phase 1 Exit Criteria

- [ ] User can sign up, set up company, connect bank, import transactions
- [ ] AI auto-categorizes 90%+ of transactions
- [ ] User can create GST-compliant invoices with auto IRN generation
- [ ] GSTR-1 + GSTR-3B can be auto-filed via ClearTax
- [ ] E-way bills can be auto-generated
- [ ] Expenses can be submitted via WhatsApp with OCR
- [ ] TDS auto-deducted on vendor payments
- [ ] Financial statements (P&L, BS, CF, TB) generate correctly
- [ ] Ask AI answers basic financial questions
- [ ] Free + Starter + Growth tiers are purchasable
- [ ] Data is stored in AWS Mumbai (RBI compliance)
- [ ] Full audit trail on every action

---

## Phase 2: Growth (Months 5-8)

**Goal:** Add the features that make growing businesses switch from Tally/QuickBooks/Zoho to our platform.

### Major Additions

| Feature | Sprint | What |
|---------|--------|------|
| TDS filing (24Q, 26Q) + certificates | Sprint 7 | Full TDS compliance |
| Razorpay payment gateway integration | Sprint 7 | Auto-reconcile sales |
| AI agents (continuous) — 24/7 reconciliation | Sprint 8 | Like Campfire's Ember |
| AI agents (on-demand) — close prep, flux analysis | Sprint 8 | Automated close |
| Close management — checklist, calendar | Sprint 8 | Close module |
| Multi-entity consolidation | Sprint 9 | For multi-entity groups |
| Multi-currency | Sprint 9 | 180+ currencies, RBI rates |
| Revenue recognition (ASC 606 / Ind AS 115) | Sprint 9 | For SaaS companies |
| Slack integration for Ask AI | Sprint 10 | Like Campfire's Slack integration |
| Shopify integration | Sprint 10 | E-commerce sales auto-import |
| Razorpay Subscriptions | Sprint 10 | Recurring billing |
| Recurring bills | Sprint 10 | Auto-generate rent, internet bills |
| Scheduled reports | Sprint 10 | Email reports automatically |
| Custom reports builder | Sprint 11 | Drag-and-drop report builder |
| Fine-tuned Llama model on Indian accounting data | Sprint 11 | Custom AI model (reduces GPT cost) |
| Tally migration tool | Sprint 11 | One-click Tally import |
| QuickBooks India migration | Sprint 12 | Import from QuickBooks |
| Zoho Books migration | Sprint 12 | Import from Zoho |
| Mobile app (React Native) | Sprint 12 | iOS + Android expenses on the go |
| Reimbursement tracking (payroll integration) | Sprint 12 | Greytip/Keka/Razorpay Payroll |
| PF/ESIC filing | Sprint 12 | EPFO + ESIC API integration |
| GST reconciliation dashboard | Sprint 12 | Visual ITC matching |

---

## Phase 3: Scale (Months 9-12)

**Goal:** Enterprise-ready with custom AI, advanced integrations, and full compliance.

### Major Additions

| Feature | Sprint | What |
|---------|--------|------|
| Enterprise tier features — custom integrations, API access | Sprint 13 | Enterprise plan |
| White-label option | Sprint 13 | For accounting firms |
| Intercompany reconciliation | Sprint 14 | Auto-match intercompany |
| CTA/FCTR reports | Sprint 14 | FX translation |
| Custom AI fine-tuning per enterprise customer | Sprint 14 | Per-company model |
| Amazon Seller API | Sprint 15 | Marketplace sales |
| Flipkart Seller API | Sprint 15 | Marketplace sales |
| SOC 2 / ISO 27001 certification | Sprint 15 | Security compliance |
| MCA filing (AOC-4, MGT-7) | Sprint 16 | Company law compliance |
| Regional language AI (Tamil, Telugu, Marathi, Bengali) | Sprint 16 | Multi-language AI |
| GSP license (direct GSTN filing) | Sprint 16 | Remove ClearTax dependency |
| Audit firm portal | Sprint 16 | Read-only auditor access |
| On-prem / private cloud option | Sprint 16 | For security-conscious enterprises |
| API marketplace / MCP store (like Campfire) | Sprint 16 | External integrations |

---

## Team Plan

| Phase | Role | Count | Monthly Cost (₹) |
|-------|------|-------|--------------------|
| **Phase 1** | Full-stack devs (Next.js + Node) | 3 | 1,50,000 each |
|           | Backend dev (Python/AI) | 1 | 1,50,000 |
|           | DevOps/infra | 1 (part-time) | 50,000 |
|           | **Phase 1 total** | **5-6** | **~₹5-6L/mo** |
|           | | | |
| **Phase 2** | All Phase 1 + | | |
|           | Frontend dev (mobile) | 1 | 1,50,000 |
|           | QA engineer | 1 | 80,000 |
|           | Product designer | 1 | 1,00,000 |
|           | **Phase 2 total** | **8-9** | **~₹8-9L/mo** |
|           | | | |
| **Phase 3** | All Phase 2 + | | |
|           | Enterprise sales | 1 | 1,50,000 + comm |
|           | Customer success | 1 | 60,000 |
|           | Additional backend dev | 1 | 1,50,000 |
|           | **Phase 3 total** | **11-12** | **~₹12-14L/mo** |

---

## Key Milestones

| Milestone | Target Date | What It Means |
|-----------|-------------|---------------|
| M1: Dev environment ready | End of Week 3 | Repo, schema, auth working |
| M2: Core accounting working | End of Week 6 | GL, P&L, BS, CF, TB generating |
| M3: GST filing working | End of Week 9 | GSTR-1 + GSTR-3B auto-filed via ClearTax |
| M4: Bank feeds + AI working | End of Week 12 | Setu bank feed + AI categorization |
| M5: WhatsApp + expenses | End of Week 15 | Receipt via WhatsApp → OCR → expense |
| M6: **Phase 1 Launch** | End of Week 18 (Month 4) | Product live, free + paid tiers |
| M7: 100 paying customers | Month 6 | ₹3-5L MRR |
| M8: Tally migration tool | Month 7 | Users can switch from Tally |
| M9: Mobile app | Month 8 | iOS + Android live |
| M10: 500 paying customers | Month 9 | ₹15-25L MRR |
| M11: Enterprise tier live | Month 10 | First enterprise deal |
| M12: 1000 paying customers | Month 12 | ₹30-50L MRR |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| GSTN API changes frequently | Use ClearTax as abstraction layer |
| Setu bank feed API not ready | Fallback: bank statement PDF upload |
| AI categorization accuracy <90% | Start conservative: 80% auto, 20% review. Improves over time. |
| Competition (Zoho Books adds AI) | Our moat: WhatsApp + Hindi AI + self-serve + price |
| Building too much too fast | Ship Phase 1 in 4 months — less features, more polish |
| Team can't hire fast enough in India | Use contractors initially, full-time as revenue grows |
| DPDP Act compliance issues | Start compliant from day 1 (AWS Mumbai, encryption, consent) |

---

## Definition of Done (Per Feature)

Every feature shipped must have:
- [ ] Code written and tested
- [ ] Unit tests passing (Vitest)
- [ ] E2E test written (Playwright) for critical paths
- [ ] API endpoints documented
- [ ] Error handling and edge cases covered
- [ ] Audit trail implementation
- [ ] Security review (no SQL injection, no XSS, proper auth)
- [ ] Multi-tenant isolation verified
- [ ] Mobile responsive (web) or functional (mobile app)
- [ ] Feature flag added (can disable if issues)
- [ ] Monitoring + alerting set up
- [ ] User documentation written