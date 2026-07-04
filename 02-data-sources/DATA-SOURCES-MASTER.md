# Data Sources Master List

> **Last Updated:** July 3, 2026
> **Purpose:** Every data source our India ERP needs to connect to, organized by category and build phase

---

## Phase Legend
- 🔴 **Phase 1** — MVP (Months 1-4) — Must have for launch
- 🟡 **Phase 2** — Growth (Months 5-8) — Add after validation
- 🟢 **Phase 3** — Scale (Months 9-12) — Nice to have, enterprise

---

## 1. BANKING (Core Foundation)

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Setu (setu.co)** | Bank account aggregator — connects to HDFC, ICICI, SBI, Axis, Kotak, etc. Fetches transactions, balances | REST API | 🔴 P1 | Research needed |
| 2 | **Razorpay X** | Business banking — transactions, vendor payouts, NEFT/RTGS/IMPS | REST API | 🔴 P1 | Research needed |
| 3 | **Cashfree** | Payouts, vendor payments, bank settlement data | REST API | 🟡 P2 | |
| 4 | **Plaid (India)** | International bank feeds for global Indian companies | REST API | 🟢 P3 | |
| 5 | **ICICI Bank Corporate API** | Direct corporate banking — B2B transactions | REST API | 🟡 P2 | |
| 6 | **HDFC Bank Corporate API** | Direct corporate banking | REST API | 🟡 P2 | |
| 7 | **Saral API** | Indian bank statement parser (PDF → structured data) | REST API | 🟡 P2 | |
| 8 | **Manual Upload** | Bank statement PDF/CSV upload as fallback | File upload + parser | 🔴 P1 | |

### Setu API Details (Priority #1)
- **What:** Account Aggregator (AA) framework approved by RBI
- **Coverage:** 100+ Indian banks and financial institutions
- **Data:** Transactions, balances, account holder info
- **Consent-based:** Customer grants consent for data access
- **Cost:** TBD — need to contact Setu for pricing
- **Docs:** https://docs.setu.co/
- **Key endpoint needed:** `GET /accounts/{account_id}/transactions`

### Bank Statement Parser (Fallback)
- If API fails, user uploads PDF/CSV bank statement
- Use OCR + regex to extract: date, amount, description, balance
- Support major Indian bank formats: HDFC, ICICI, SBI, Axis, Kotak, Yes, IDFC First
- Library: Python `pdfplumber` + custom regex patterns per bank

---

## 2. PAYMENTS & COLLECTIONS (Money IN)

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Razorpay** | Payment gateway — every online sale, UPI, cards, netbanking, subscriptions | REST API + Webhooks | 🔴 P1 | |
| 2 | **Cashfree** | Payment gateway — settlements, payouts | REST API | 🟡 P2 | |
| 3 | **PayU** | Payment gateway — e-commerce payments | REST API | 🟡 P2 | |
| 4 | **Pine Labs** | POS/Point of sale terminal data (retail) | REST API | 🟡 P2 | |
| 5 | **PhonePe Business** | UPI collections, settlements | REST API | 🟡 P2 | |
| 6 | **Paytm Business** | UPI/wallet collections, settlements | REST API | 🟢 P3 | |
| 7 | **Stripe** | International payments (for Indian companies with global customers) | REST API | 🟡 P2 | |
| 8 | **Airwallex** | International wire transfers, multi-currency | REST API | 🟢 P3 | |
| 9 | **Skydo** | International B2B payments to India | REST API | 🟢 P3 | |
| 10 | **UPI Direct (via bank feeds)** | UPI transaction data via bank feeds | Bank feed (Setu) | 🔴 P1 | |
| 11 | **POS Systems** | Ginesys (retail), Petpooja (restaurants), Sim Wellness | REST API / CSV | 🟢 P3 | |

### Razorpay API Details (Priority #1)
- **What:** Payment gateway + subscriptions + payouts
- **Data:** Every payment, settlement, refund, failed payment
- **Webhooks:** Real-time payment events → auto-record in ERP
- **Key endpoints:**
  - `GET /payments` — all payments
  - `GET /settlements` — bank settlements
  - `POST /subscriptions` — recurring billing
- **Auth:** Key + Secret (API keys)
- **Docs:** https://razorpay.com/docs/api/
- **Cost:** ~2% per transaction (payment gateway fee)

---

## 3. EXPENSE MANAGEMENT (Money OUT)

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Razorpay Corporate Cards** | Employee card transactions, real-time feeds, spend limits | REST API | 🔴 P1 | |
| 2 | **Karbon Cards** | Startup corporate cards, spend management | REST API | 🟡 P2 | |
| 3 | **Pelf/FStarz** | Employee expense cards | REST API | 🟢 P3 | |
| 4 | **WhatsApp Business API** | Receipt photo → OCR → expense entry | WhatsApp Cloud API | 🔴 P1 | |
| 5 | **Email Ingestion** | Employee forwards receipts to receipts@company.com | IMAP polling | 🔴 P1 | |
| 6 | **Mobile App (Camera)** | Photo → OCR → expense entry | In-app OCR | 🔴 P1 | |
| 7 | **Razorpay Payroll** | Reimbursement data from payroll | REST API | 🟡 P2 | |
| 8 | **Greytip HR** | Reimbursement/expense claims | REST API | 🟡 P2 | |
| 9 | **Keka HR** | Reimbursement/expense claims | REST API | 🟡 P2 | |
| 10 | **Manual Entry** | Cash expenses, petty cash | UI form | 🔴 P1 | |

### WhatsApp Business API Details (Priority #1)
- **What:** Send/receive WhatsApp messages programmatically
- **Use cases:**
  1. Employee sends receipt photo → OCR extracts data → creates expense
  2. Send invoice to customer via WhatsApp
  3. Send payment reminders
  4. Send financial summaries (P&L, cash position)
  5. Employee asks "Kitna kharcha hua?" → AI answers from data
- **Provider:** WhatsApp Cloud API (Meta) — free for first 1000 convos/mo
- **Docs:** https://developers.facebook.com/docs/whatsapp/cloud-api
- **Cost:** ~₹0.80-1.50 per message after free tier

### Email Ingestion Details
- **What:** System polls receipts@company.com via IMAP
- **Flow:**
  1. Fetch unread emails with attachments
  2. Download attachment (PDF/image)
  3. Run OCR to extract amount, vendor, date, GST
  4. Create draft expense in system
  5. Notify employee: "Receipt received, please review"
- **Library:** Python `imaplib` + `email` parsing
- **IMAP providers:** Gmail, Outlook, custom domains

---

## 4. GST & TAX COMPLIANCE (India Moat)

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **GSTN Portal API** | GSTR-1, GSTR-3B filing, return status, ITC data | Screen scraping + API | 🔴 P1 | |
| 2 | **E-Invoicing IRP API** | Generate IRN (Invoice Reference Number) for invoices >₹5Cr | REST API (GSTN) | 🔴 P1 | |
| 3 | **E-Way Bill API** | Generate/cancel e-way bills for goods movement | REST API (GSTN) | 🔴 P1 | |
| 4 | **ClearTax API** | GST filing, TDS filing, ITC reconciliation, full tax compliance | REST API | 🔴 P1 | |
| 5 | **TaxGeno** | GST reconciliation, auto-filing | REST API | 🟡 P2 | |
| 6 | **MaxITC** | ITC matching/reconciliation | REST API | 🟡 P2 | |
| 7 | **GST Return Filing API** | Direct filing to GSTN (requires GSP license) | REST API (GSP) | 🟡 P2 | |
| 8 | **TDS Return Filing (TRACES)** | TDS return filing (24Q/26Q/27Q), TDS certificates | NSDL TRACES API | 🟡 P2 | |
| 9 | **Income Tax Dept API** | TAN/PAN verification, advance tax | REST API | 🟡 P2 | |
| 10 | **GST Suvidha Provider** | Become licensed GSP for direct GSTN integration | REST API | 🟢 P3 | |

### E-Invoicing IRP API Details (Priority #1)
- **What:** Generate Invoice Reference Number (IRN) for B2B invoices
- **Mandatory for:** Businesses with turnover >₹5 Cr (expanding to all)
- **Flow:**
  1. Generate invoice in ERP
  2. Send invoice JSON to IRP API
  3. IRP returns IRN + QR code + signed invoice
  4. QR code printed on invoice
  5. Invoice is now legally valid
- **API Endpoint:** `https://einvoice1.gst.gov.in/api/v1.0/ (for production)`
- **Auth:** Client ID + Client Secret (register on GST portal)
- **Docs:** https://einvoice1.gst.gov.in/IRPMaster/Home
- **Cost:** Free (government API)

### E-Way Bill API Details (Priority #1)
- **What:** Generate e-way bill for goods transport >₹50,000 value
- **Mandatory for:** All registered GST taxpayers moving goods
- **Flow:**
  1. Create sales invoice in ERP
  2. If goods being transported >₹50K, auto-generate e-way bill
  3. E-way bill number (EBN) → share with transporter
  4. Auto-cancel if goods not moved within validity
- **API:** `https://ewaybill1.nic.in/api/v1.0/`
- **Auth:** Username + password (GST portal)
- **Docs:** https://ewaybill1.nic.in/apnpages/about-api.aspx
- **Cost:** Free

### ClearTax API Details (Priority #1)
- **What:** Full tax compliance — GST returns, TDS returns, ITC reconciliation
- **Why use ClearTax instead of direct GSTN:** ClearTax is a licensed GSP (GST Suvidha Provider) — handles auth, filing, errors, reconciliation. Building this ourselves would take 6+ months.
- **Key endpoints:**
  - `POST /gst/returns/gstr1` — file GSTR-1
  - `POST /gst/returns/gstr3b` — file GSTR-3B
  - `GET /gst/itc/reconciliation` — match input tax credit
  - `POST /tds/returns/24q` — file TDS returns
- **Docs:** https://cleartax.co/developers
- **Cost:** TBD — contact ClearTax for API pricing (likely ₹10-50/return)

---

## 5. VENDOR & PROCUREMENT DATA

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Vendor Email Ingestion** | Vendor sends invoice to bills@ → OCR → bills payable | IMAP + OCR | 🔴 P1 | |
| 2 | **Vendor Portal** | Vendors upload invoices directly | Web portal | 🟡 P2 | |
| 3 | **IndiaMART API** | B2B vendor/supplier catalog + purchase data | REST API | 🟢 P3 | |
| 4 | **Udyam Registration API** | MSME vendor verification | REST API | 🟡 P2 | |
| 5 | **GSTIN Verification API** | Verify vendor GST numbers, track status | REST API | 🔴 P1 | |
| 6 | **PAN Verification API** | Verify vendor PAN numbers | REST API | 🟡 P2 | |
| 7 | **Tally Vendor Master Export** | Import existing vendor list from Tally | XML/CSV | 🔴 P1 | |

### GSTIN Verification API Details
- **What:** Verify any vendor's GST number — active/suspended/cancelled
- **Use case:** Before paying a vendor, verify their GSTIN is active
- **API:** `https://api.gstin.gov.in/api/v1.0/searchpayer` (via GSP)
- **Alternative:** ClearTax GSTIN verification API
- **Cost:** Free via GSTN portal, or ₹1-5 per lookup via GSP

---

## 6. SALES & REVENUE

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Stripe Billing** | Recurring subscription revenue, usage-based billing | REST API | 🟡 P2 | |
| 2 | **Razorpay Subscriptions** | Recurring billing data | REST API | 🟡 P2 | |
| 3 | **Amazon Seller API (SP-API)** | Marketplace sales, settlement reports, per-SKU | REST API | 🟢 P3 | |
| 4 | **Flipkart Seller API** | Marketplace sales, settlement reports | REST API | 🟢 P3 | |
| 5 | **Zoho Inventory API** | Inventory + sales order data for existing Zoho users | REST API | 🟢 P3 | |
| 6 | **Shopify API** | E-commerce sales data | REST API | 🟡 P2 | |
| 7 | **WooCommerce API** | E-commerce sales data | REST API | 🟢 P3 | |
| 8 | **Custom Billing System** | API hook for companies with custom billing | REST API | 🟡 P2 | |
| 9 | **CSV/Excel Upload** | Manual sales data upload as fallback | File upload | 🔴 P1 | |

---

## 7. HR & PAYROLL

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Razorpay Payroll** | Salary data, reimbursements, TDS on salary | REST API | 🟡 P2 | |
| 2 | **Greytip HR** | Payroll, PF/ESIC, TDS on salary | REST API | 🟡 P2 | |
| 3 | **Keka HR** | Payroll, expense claims, employee data | REST API | 🟡 P2 | |
| 4 | **Zoho Payroll** | Payroll data for Zoho ecosystem users | REST API | 🟢 P3 | |
| 5 | **BambooHR** | Employee headcount, international | REST API | 🟢 P3 | |
| 6 | **EPFO API** | PF (Provident Fund) compliance filing | REST API | 🟡 P2 | |
| 7 | **ESIC API** | ESI compliance filing | REST API | 🟡 P2 | |

---

## 8. INVENTORY & GOODS (Trading/Manufacturing)

| # | Source | What It Gives | API/Method | Phase | Status |
|---|--------|---------------|------------|-------|--------|
| 1 | **Zoho Inventory API** | Stock levels, purchase orders, sales orders | REST API | 🟡 P2 | |
| 2 | **Unicommerce** | Warehouse + order management, multi-channel | REST API | 🟢 P3 | |
| 3 | **Easycom** | E-commerce inventory sync | REST API | 🟢 P3 | |
|  feeds, IRS tax (US)
- **EPFO:** Employee Provident Fund Organization — retirement savings
- **ESIC:** Employee State Insurance Corporation — health insurance
- **TDS:** Tax Deducted at Source — tax withheld on payments
- **GSP:** GST Suvidha Provider — licensed GSTN API intermediary

---

## API Priority Contact List

For Phase 1, we need to contact these providers for API access:

| # | Provider | What We Need | Contact URL |
|---|----------|--------------|-------------|
| 1 | Setu | Account Aggregator API access + pricing | https://setu.co/contact |
| 2 | ClearTax | Developer API access + pricing | https://cleartax.co/developers |
| 3 | GSTN | GSP status or GSP partner relationship | https://www.gst.gov.in/ |
| 4 | Razorpay | API keys + corporate card access | https://razorpay.com/docs/api/ |
| 5 | WhatsApp (Meta) | WhatsApp Business Cloud API access | https://developers.facebook.com/docs/whatsapp/cloud-api |
| 6 | AWS | Mumbai region (ap-south-1) account | https://aws.amazon.com/ |
| 7 | Google Cloud | Document AI API access | https://cloud.google.com/document-ai |
| 8 | OpenAI / DeepSeek | API keys for AI categorization | https://platform.openai.com / https://platform.deepseek.com |