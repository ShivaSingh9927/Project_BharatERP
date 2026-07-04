# Technology Stack — India ERP

> **Last Updated:** July 3, 2026
> **Purpose:** Every technology choice, framework, library, and service for building the India ERP

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   CLIENT LAYER                       │
├──────────┬──────────┬──────────┬────────────────────┤
│  Web App │ Mobile   │ WhatsApp │   Slack/Telegram   │
│ (Next.js)│  (RN)    │   Bot    │      Bot           │
├──────────┴──────────┴──────────┴────────────────────┤
│                  API GATEWAY                         │
│              (Fastify / FastAPI)                     │
├─────────────────────────────────────────────────────┤
│                  BUSINESS LOGIC                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │  GL     │ │  GST    │ │  TDS    │ │   AI     │  │
│  │ Engine  │ │ Engine  │ │ Engine  │ │  Engine  │  │
│  └─────────┘ └─────────┘ └─────────┘ └──────────┘  │
├─────────────────────────────────────────────────────┤
│                  DATA LAYER                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │PostgreSQL│ │ Redis  │ │S3/Hetzner│ │ Vector  │  │
│  │(Ledger) │ │(Queue) │ │(Files)   │ │ (pgvec) │  │
│  └─────────┘ └─────────┘ └─────────┘ └──────────┘  │
├─────────────────────────────────────────────────────┤
│                 INTEGRATION LAYER                    │
│  Setu │ Razorpay │ GSTN │ ClearTax │ WhatsApp │ OCR  │
├─────────────────────────────────────────────────────┤
│              AI INFRASTRUCTURE                        │
│  DeepSeek/GPT-4o │ Fine-tuned Llama │ OCR (Textract)│
└─────────────────────────────────────────────────────┘
```

---

## 1. Frontend (Web App)

| Component | Technology | Why |
|-----------|-----------|-----|
| Framework | **Next.js 15** (App Router) | Same as Campfire, proven pattern, SSR for SEO |
| Language | **TypeScript** | Type safety, enterprise-grade code |
| Styling | **Tailwind CSS 4** | Rapid development, consistent design |
| UI Components | **shadcn/ui** + **Radix UI** | Beautiful, accessible, customizable |
| State Management | **Zustand** | Lightweight, works great with Next.js |
| Data Fetching | **TanStack Query (React Query)** | Caching, optimistic updates, background refetch |
| Forms | **React Hook Form + Zod** | Type-safe validation, great DX |
| Charts | **Recharts** or **Tradingview Lightweight Charts** | Financial dashboards, P&L visualizations |
| Tables | **TanStack Table (v8)** | Sortable, filterable, virtualized for large datasets |
| Animation | **Framer Motion** | Smooth transitions,                     |
| PDF Generation | **react-pdf** or **@react-pdf/renderer** | Generate invoices, GST reports, financial statements |
| Rich Text | **TipTap** or **Lexical** | Email templates, notes, AI chat interface |
| Icons | **Lucide React** | Clean, consistent, tree-shakeable |

---

## 2. Frontend (Mobile App)

| Component | Technology | Why |
|-----------|-----------|-----|
| Framework | **React Native (Expo)** | Code sharing with web, faster development |
| Navigation | **Expo Router** | File-based routing, same pattern as Next.js |
| State | **Zustand** | Shared with web codebase |
| Camera/OCR | **expo-camera + expo-image-picker** | Receipt photo capture |
| Offline Support | **WatermelonDB** or **Power Sync** | Offline-first for expense entry |
| Push Notifications | **Expo Notifications** | Approval alerts, anomaly alerts |
| Biometric Auth | **expo-local-authentication** | FaceID/Fingerprint for approvals |
| Distribution | **EAS (Expo Application Services)** | OTA updates, build, deploy |

---

## 3. Backend

| Component | Technology | Why |
|-----------|-----------|-----|
| Primary API | **Node.js + Fastify** | Fast, same language as frontend, good ecosystem |
| Or Alternative | **Python + FastAPI** | Better for AI/ML, data processing. Consider if AI-heavy |
| Recommendation | **Use both** | Node.js for API + webhooks, Python for AI/data processing |
| Auth | **Clerk** or ** Lucia/Auth.js** | Auth, session, 2FA, social login |
| API Style | **REST + tRPC** (for web) | REST for integrations, tRPC for web for type-safety |
| File Upload | **Multer + S3** | Receipt uploads, invoice PDFs, bank statements |
| Validation | **Zod** (shared with frontend) | End-to-end type safety |
| Queue | **BullMQ** (Redis) | Background jobs: GST filing, e-invoicing, AI categorization |
| Cron Scheduler | **BullMQ Scheduler** or **node-cron** | Scheduled reports, recurring billing, reminders |
| WebSocket | **Socket.IO** | Real-time updates: transaction alerts, approval notifications |
| Email | **Resend** or **Amazon SES** | Transactional emails, reports, invoices |
| PDF Generation (server) | **Puppeteer** or **pdf-lib** | Server-side PDF for invoices, reports |

---

## 4. AI / ML Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| General LLM (P1) | **DeepSeek API** | Cheapest good model, ~$0.14/M tokens |
| General LLM (Premium) | **GPT-4o API** or **Claude Sonnet** | Complex reasoning, anomaly explanation |
| Fine-tuned Model (P2) | **Llama 3.1 8B** fine-tuned | Custom model on Indian accounting data |
| Hosting Fine-tuned | **Together.ai** or **self-hosted on GPU** | Cost-effective fine-tuned inference |
| OCR (P1) | **Google Document AI** | Best for Indian invoices (English + Hindi) |
| OCR (Alt) | **AWS Textract** | Good for bank statements, structured docs |
| OCR (Indian) | Fine-tuned **Qwen-VL** or **Llama-Vision** | For Indian invoice formats, regional languages |
| Embeddings | **OpenAI text-embedding-3-small** or **Nomic Embed** | For RAG / "Ask AI" vector search |
| Vector DB | **pgvector** (PostgreSQL extension) | No separate DB needed, keeps everything in Postgres |
| RAG Framework | **LangChain** or **LlamaIndex** | Or build custom — simpler for our use case |
| Workflow AI | **Claude/GPT for complex reasoning** + **DeepSeek for bulk categorization** | Route by complexity |
| AI Cost Optimization | Cache common queries, batch categorization | Minimize API costs |

### AI Cost Estimate (Per Customer)
| Operation | Model | Volume | Cost/mo |
|-----------|-------|--------|---------|
| Transaction categorization | DeepSeek | ~3000 txns | ~$2 |
| Ask AI queries | GPT-4o-mini | ~200 queries | ~$1 |
| Anomaly detection | DeepSeek | ~100 flags | ~$0.50 |
| Receipt OCR | Google Document AI | ~100 receipts | ~$7.50 |
| GST anomaly check | DeepSeek | ~50 checks | ~$0.30 |
| **Total per customer** | | | **~$11/mo** |

---

## 5. Database

| Component | Technology | Why |
|-----------|-----------|-----|
| Primary DB | **PostgreSQL 16** | ACID compliant, best for accounting, JSON support, row-level security |
| Vector Extension | **pgvector** | Vector search for "Ask AI" without separate DB |
| Migration | **Drizzle ORM** or **Prisma** | Type-safe, migrations, good DX |
| Read Replicas | **PostgreSQL streaming replication** | Scale reads for reporting |
| Backup | **pg_dump + S3** | Automated daily backups |
| Caching | **Redis 7** | Session, queue, caching, rate-limiting |

### Database Schema Strategy

```
Core tables:
- companies (id, name, gstin, pan, type, fy_start)
- entities (id, company_id, name, gstin, state)
- accounts (id, company_id, code, name, type [asset/liability/equity/revenue/expense])
- journal_entries (id, company_id, entity_id, date, description, status [draft/posted])
- journal_lines (id, je_id, account_id, debit, credit, description)
- vendors (id, company_id, name, gstin, pan, payment_terms)
- customers (id, company_id, name, gstin, billing_address)
- invoices (id, company_id, customer_id, number, date, total, gst, status)
- bills (id, company_id, vendor_id, number, date, total, gst, status)
- expenses (id, company_id, employee_id, amount, category, status)
- bank_accounts (id, company_id, entity_id, bank, account_number, balance)
- bank_transactions (id, bank_account_id, date, amount, description, matched)
- gst_returns (id, company_id, period, type [gstr1/gstr3b], status, data)
- tds_returns (id, company_id, period, type [24q/26q], status, data)
- ai_actions (id, company_id, type, input, output, confidence, user_id, timestamp)

Indexing:
- Heavy indexing on journal_lines (account_id, je_id)
- Partitioning by date for journal_entries, bank_transactions
- Materialized views for P&L, BS, CF reports
```

---

## 6. Infrastructure & Hosting

| Component | Technology | Why |
|-----------|-----------|-----|
| Cloud Provider | **AWS Mumbai (ap-south-1)** | Data residency for Indian compliance |
| Compute | **ECS Fargate** or **EC2** | Container orchestration |
| Or Alternative | **Hetzner** (Finland) + VPN to India | Cheaper, but data residency concern |
| Containers | **Docker** + **Docker Compose** (dev) | Standard containerization |
| Orchestrator | **AWS ECS** or **Kubernetes (EKS)** | Production orchestration |
| CDN | **Cloudflare** | Fast delivery, DDoS protection, R2 storage |
| Object Storage | **AWS S3 (Mumbai)** | Receipts, invoices, bank statements |
| DNS | **Cloudflare** or **Route53** | DNS management |
| SSL | **Cloudflare** or **Let's Encrypt** | HTTPS |
| CI/CD | **GitHub Actions** | Build, test, deploy |
| Monitoring | **Sentry** (errors) + **Grafana/Cloudwatch** (metrics) | Error tracking + observability |
| Logging | **Cloudwatch** or **Loki** | Centralized logs |
| Secret Management | **AWS Secrets Manager** or **Doppler** | API keys, DB credentials |

---

## 7. Integration Layer

| Component | Technology | Why |
|-----------|-----------|-----|
| API Gateway | Built into Fastify / FastAPI | Route external API calls |
| Webhook Handler | Fastify endpoint + queue | Receive Razorpay, WhatsApp, GSTN webhooks |
| Cron Jobs | **BullMQ Scheduler** | Scheduled bank feeds, GST filing, reminders |
| Rate Limiting | **Redis-based** rate limiter | Protect GSTN, ClearTax APIs from over-calling |
| API Key Management | Encrypted storage (AWS Secrets Manager) | Per-customer API keys for Razorpay, GSTN, etc. |
| Error Handling | Dead letter queue (BullMQ) | Failed GST filings, failed payments retry |

---

## 8. Security

| Component | Technology | Why |
|-----------|-----------|-----|
| Authentication | **Clerk** or **Auth.js** | Multi-tenant auth, 2FA, social login |
| Authorization | **CASL** or custom RBAC | Fine-grained permissions |
| Encryption at Rest | **AWS KMS** + PostgreSQL TDE | Data encryption |
| Encryption in Transit | TLS 1.3 everywhere | Data in motion |
| PII Handling | Tokenization for PAN, Aadhaar | DPDP Act compliance |
| Audit Logging | PostgreSQL triggers → audit table | Every data change tracked |
| IP Whitelisting | API gateway middleware | Enterprise feature |
| Penetration Testing | Quarterly | Security compliance |

---

## 9. Development Tools

| Component | Technology | Why |
|###########|###########|#####|
| Package Manager | **pnpm** | Monorepo support, fast |
| Monorepo | **Turborepo** | Cache, parallel builds, shared packages |
| Code Quality | **ESLint + Prettier + TypeScript strict** | Consistent code |
| Testing | **Vitest** (unit) + **Playwright** (e2e) | Fast tests, browser automation |
| Pre-commit Hooks | **Husky + lint-staged** | Prevent bad commits |
| API Testing | **Bruno** or **Postman** | API development |
| Database GUI | **Drizzle Studio** or **TablePlus** | Visual DB management |
| Error Tracking | **Sentry** | Frontend + backend error monitoring |
| Feature Flags | **Posthog** or **Unleash** | A/B testing, gradual rollout |
| Analytics | **Posthog** | Product analytics |

---

## 10. Third-Party Services Summary

| Service | Purpose | Est. Cost/mo |
|---------|---------|--------------|
| AWS Mumbai (compute + storage) | Hosting | $200-500 (small) / $1K-2K (medium) |
| Cloudflare | CDN, DNS, DDoS | $20 (Pro) / $200 (Business) |
| Sentry | Error tracking | $26 (Team) |
| Resend / SES | Email delivery | $20-50 |
| WhatsApp Business API | Messaging | ~₹1/msg after free tier |
| Google Document AI | OCR | $1.50 per 100 pages |
| DeepSeek API | AI categorization | ~$30-50 (bulk usage) |
| OpenAI API | AI reasoning | ~$50-100 (premium usage) |
| Setu API | Bank feeds | TBD (contact) |
| ClearTax API | GST/TDS filing | TBD (contact) |
| Razorpay API | Payment gateway | 2% per transaction |
| **Total (at launch)** | | **~$400-800/mo infrastructure** |

---

## Build vs Buy Decisions

| Feature | Build | Buy | Decision |
|---------|-------|-----|----------|
| GL Engine | ✅ Build | — | Core IP, must build |
| GST Engine | — | ✅ ClearTax API | Too complex to build from scratch, ClearTax is licensed GSP |
| E-Invoicing | — | ✅ GSTN API (free) | Government API, use directly |
| E-Way Bill | — | ✅ GSTN API (free) | Government API, use directly |
| Bank Feeds | — | ✅ Setu API | Regulatory framework, can't replicate |
| OCR | — | ✅ Google Document AI | Don't build OCR, use best available |
| AI Categorization | ✅ Build | — | Core IP, our differentiator |
| AI Chat ("Ask Jarvis") | ✅ Build | — | Core IP |
| Payment Gateway | — | ✅ Razorpay | Commodity, don't build |
| Email Service | — | ✅ Resend | Commodity |
| Auth | — | ✅ Clerk | Don't build auth, use best |
| WhatsApp Bot | ✅ Build | — | Core experience, build custom |

---

## Tech Stack TlL;DR

```
Frontend:  Next.js 15 + TypeScript + Tailwind + shadcn/ui
Mobile:    React Native (Expo)
Backend:   Node.js (Fastify) + Python (FastAPI for AI)
Database:  PostgreSQL 16 + pgvector + Redis
AI:        DeepSeek (bulk) + GPT-4o (complex) + Google Document AI (OCR)
Infra:     AWS Mumbai + Cloudflare + Docker + GitHub Actions
Queue:     BullMQ (Redis)
Auth:      Clerk
Migration: Tally XML parser built custom
```