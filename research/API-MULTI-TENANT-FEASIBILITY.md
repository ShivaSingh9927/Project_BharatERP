# API Multi-Tenant Feasibility Report

> **Research Date:** July 4, 2026
> **Purpose:** Verify that all critical data source APIs can serve multiple users/companies through a single BharatERP integration
> **Method:** Direct documentation review of Setu, ClearTax, IRP, and WhatsApp Cloud API

---

## Executive Summary

**YES — every critical API supports multi-tenant SaaS.** One developer account per provider serves all your users. The pattern is:

1. **You register once** with each API provider (Setu, ClearTax, Meta, etc.)
2. **Each tenant goes through their own consent/credential flow** (bank linking, GSTIN registration, WhatsApp number)
3. **You store per-tenant credentials encrypted in your DB**
4. **Your shared codebase makes API calls on behalf of each tenant**

---

## 1. Setu (Bank Feeds via Account Aggregator) — ✅ FULLY MULTI-TENANT

### Verdict
One Setu developer account → one product instance → serves ALL users. Perfect for SaaS.

### How It Works
- You create ONE "Account Aggregator Data" product on Setu's Bridge console
- You get one set of credentials: `x-product-instance-id`, `x-client-id`, `x-client-secret`
- For each end-user, you call `POST /consents` with their mobile number as VUA (Virtual User Address)
- Each user individually:
  1. Redirects to Setu's consent approval URL
  2. Verifies mobile via OTP
  3. Selects their own bank(s) from supported FIPs
  4. Links their accounts
  5. Approves/rejects consent
- You NEVER touch bank credentials — Setu handles all of that

### Multi-Tenant Segmentation
- Setu supports **tags** via `additionalParams.tags` in consent requests
- Tag each consent with tenant ID: `["tenant_123", "SME_acme"]`
- Track and segment data per tenant within single product instance
- Webhook notifications routed to correct tenant based on consent ID

### Supported Banks (FIPs)
100+ Indian banks via Account Aggregator framework. Multi-AA gateway auto-routes to best AA (Setu, OneMoney, Anumati, Finvu, Saafe).

### Consent Flow
```
BharatERP → POST /consents (with user's mobile) → Setu returns consent ID + URL
User → Redirected to Setu consent screen → OTP → select bank → approve
Setu → Webhook to BharatERP (CONSENT_STATUS_UPDATE: APPROVED/REJECTED)
BharatERP → POST /consents/:id/data-sessions → Setu prepares data
Setu → Webhook (data ready)
BharatERP → GET /data-sessions/:sessionId → Financial data (JSON/XML)
```

### Go-Live Requirements
1. Register on Setu's Bridge console
2. Test on sandbox (mock FIPs with mock data)
3. For production: KYC + sign agreements with AAs + Sahamati onboarding
4. Contact: `aa@setu.co` or `support@setu.co`

### Cost
TBD — contact Setu for pricing

---

## 2. ClearTax (GST Filing) — ✅ MULTI-TENANT WITH PER-COMPANY CREDENTIALS

### Verdict
One ClearTax workspace → one API client → file GST for ALL tenant companies. Each company onboarded as separate "Business" with own GSTIN.

### Architecture
```
ClearTax Account (one email)
  └─ Workspace (one per SaaS instance)
       └─ Business/Client (one per tenant company)
            └─ GSTIN (one per state, gets Taxable Entity ID)
```

- One `x-cleartax-auth-token` (from one client secret) manages all GSTINs in workspace
- Pass specific GSTIN/Taxable Entity ID per API call to target the right company
- Each company needs its own GST portal credentials (username/password)
- For e-invoicing: each GSTIN needs NIC credentials (stored per-GSTIN via API)

### API Tiers
| API | Purpose | Multi-GSTIN |
|-----|---------|-------------|
| GST GSP API (`api.clear.in`) | Direct GST portal operations (file returns, fetch returns) | Per-GSTIN portal creds required. One token manages all. |
| GST 2.0 / CFC API | Higher-level: upload invoices → ClearTax prepares returns → file | Documents tagged per-GSTIN. One token per workspace. |

### Tenant Onboarding Flow
1. Tenant provides GSTIN + GST portal username/password
2. BharatERP calls ClearTax "Add Business" API with these credentials
3. ClearTax creates Taxable Entity under your workspace
4. All subsequent filing for that tenant uses their Taxable Entity ID

### Contact
`integrations-support@cleartax.in` for sandbox/provisioning

### Cost
TBD — likely ₹10-50 per return

---

## 3. E-Invoicing IRP (Government) — ✅ MULTI-TENANT WITH PER-GSTIN REGISTRATION

### Verdict
Shared codebase, per-GSTIN credentials. Each company must register individually on IRP portal.

### How It Works
- Each GSTIN must register on e-Invoice portal as "API User"
- This generates a unique **Client ID + Client Secret** per GSTIN
- Auth flow per GSTIN:
  1. `POST /api/v1.03/auth` with client_id, client_secret, GSTIN username/password
  2. Returns Bearer token (valid 30 minutes)
  3. Use token for IRN generation calls
- Token is scoped to that specific GSTIN
- IRP validates that authenticated user matches seller GSTIN in payload

### Multi-Tenant Architecture
```
BharatERP DB (encrypted):
  tenant_1: { gstin: "29AAFCD...", client_id, client_secret, username, password }
  tenant_2: { gstin: "27AAABC...", client_id, client_secret, username, password }

Shared service layer:
  - Token management (refresh every 30 min per GSTIN)
  - Request signing/encryption
  - IRN generation, cancellation
  - One codebase, per-tenant credentials
```

### Mandatory Compliance
- E-invoicing mandatory for turnover > ₹5 Cr (expanding to all)
- 2FA mandatory from April 2025
- No master account concept — each GSTIN is independent

### Cost
Free (government API)

---

## 4. E-Way Bill (Government) — ✅ SAME AS E-INVOICING

### Verdict
Same architecture as e-invoicing. Per-GSTIN registration, shared code.

### How It Works
- Each GSTIN registers on e-Way Bill portal (`ewaybill1.nic.in`)
- Creates API credentials (username/password or .p12 certificate)
- Auth: same `POST /api/v1.03/auth` → Bearer token → use for e-way bill operations
- Synergy: IRP returns IRN → can extend into e-Way Bill (Part-B) without regeneration

### Cost
Free (government API)

---

## 5. WhatsApp Business Cloud API — ✅ MULTI-TENANT VIA EMBEDDED SIGNUP

### Verdict
One Meta App as tech provider → each tenant gets own WABA + phone number via Embedded Signup.

### Architecture
```
Meta Business Portfolio (BharatERP's)
  └─ Meta App (one app ID, Solution Partner registered)
       ├─ Tenant A's WABA → Phone Number A
       ├─ Tenant B's WABA → Phone Number B
       └─ Tenant C's WABA → Phone Number C
```

### Best Approach: Solution Partner / Embedded Signup
1. BharatERP registers as **Solution Partner** with Meta
2. Each tenant goes through **Embedded Signup** in BharatERP's UI:
   - Creates or selects their own Meta Business Portfolio
   - Creates their own WABA (WhatsApp Business Account)
   - Registers a phone number
   - Grants BharatERP's app access to manage their WABA
3. BharatERP stores per-tenant: `{ waba_id, phone_number_id, access_token }`
4. One Meta App ID handles all tenants

### Key Details
- **One WABA = one business.** No sharing WABAs between tenants.
- Each WABA has independent rate limits (80 msg/sec per phone number)
- Each WABA has independent quality rating
- New Business Portfolios: capped at 2 phone numbers initially, increases to 20 after verification
- Cost: ~₹0.80-1.50 per message after free tier (first 1000 convos/mo free)

---

## Summary Matrix

| API | One Integration? | Per-Tenant Setup | Auth Model | Cost |
|-----|:-:|-----|-----|-----|
| **Setu** (bank feeds) | ✅ | User consent flow (OTP + bank selection) | One product instance, per-user consent | TBD |
| **ClearTax** (GST filing) | ✅ | Per-company GSTIN + portal creds | One workspace, per-GSTIN filing | ₹10-50/return |
| **E-Invoicing IRP** | ✅ | Per-GSTIN registration on IRP portal | Per-GSTIN Client ID/Secret, 30-min token | Free |
| **E-Way Bill** | ✅ | Per-GSTIN registration on e-Way Bill portal | Per-GSTIN credentials, 30-min token | Free |
| **WhatsApp** | ✅ | Per-tenant WABA + phone number (Embedded Signup) | Per-WABA access token | ~₹0.80-1.50/msg |
| **Razorpay** (payments) | ✅ | Per-company Razorpay account + API keys | Per-company API key + secret | ~2% per txn |

---

## Recommended Multi-Tenant Architecture for BharatERP

```
┌──────────────────────────────────────────────────────┐
│  BharatERP Platform (One SaaS Instance)              │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Tenant A │  │ Tenant B │  │ Tenant C │  ...       │
│  │ (SME 1)  │  │ (SME 2)  │  │ (SME 3)  │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │                 │
│  ┌────▼──────────────▼──────────────▼─────┐          │
│  │  PostgreSQL (Multi-Tenant)              │          │
│  │  company_id on EVERY table             │          │
│  │  Row-Level Security enabled             │          │
│  │  Encrypted tenant credentials store     │          │
│  └────────────────────────────────────────┘          │
└──────────┬────────────┬────────────┬────────────────┘
           │            │            │
    ┌──────▼──┐  ┌──────▼──┐  ┌─────▼───────┐
    │  Setu   │  │ClearTax │  │ Meta (WA)   │
    │ 1 product│  │1 worksp │  │ 1 App ID    │
    │ = all   │  │= all    │  │ = all WABAs │
    │ users   │  │GSTINs   │  │             │
    └─────────┘  └─────────┘  └─────────────┘
    ┌──────────────────────────────────────────┐
    │  IRP + E-Way Bill (shared code, per-GSTIN│
    │  credentials, 30-min token refresh)       │
    └──────────────────────────────────────────┘
```

### Per-Tenant Credential Store (Encrypted)
```json
{
  "tenant_123": {
    "setu": { "consent_id": "abc...", "consent_status": "ACTIVE" },
    "cleartax": { "taxable_entity_id": "456", "gstin": "29AAFCD..." },
    "irp": { "client_id": "...", "client_secret": "...", "gstin": "...", "username": "...", "password": "..." },
    "ewaybill": { "client_id": "...", "client_secret": "...", "gstin": "..." },
    "whatsapp": { "waba_id": "...", "phone_number_id": "...", "access_token": "..." },
    "razorpay": { "api_key": "...", "api_secret": "..." }
  }
}
```

### Key Design Decisions
1. **One API integration per provider** at platform level
2. **Per-tenant credentials** stored encrypted in DB (AES-256)
3. **Per-tenant consent flows** (user approves data sharing)
4. **Token management service** (refresh IRP/e-way bill tokens every 30 min)
5. **Webhook router** (incoming events from Setu/Razorpay → route to correct tenant)
6. **Row-level security** in PostgreSQL (company_id isolation)

---

## Conclusion

**Shiva's concern is fully addressed:** All critical APIs support multi-tenant SaaS. One registration per provider serves all users. Each user/company goes through their own consent or credential flow. No API requires a separate developer account per user.

**Action items:**
1. Register on Setu Bridge console → get sandbox access
2. Contact ClearTax (`integrations-support@cleartax.in`) → get sandbox access
3. Register Meta Developer account → apply for Solution Partner
4. Each tenant's onboarding wizard will include: connect bank (Setu consent), enter GST credentials, (optional) set up WhatsApp number