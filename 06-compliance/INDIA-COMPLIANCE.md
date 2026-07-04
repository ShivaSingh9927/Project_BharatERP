# India Compliance — GST, TDS, E-Invoicing, DPDP Act

> **Last Updated:** July 3, 2026
> **Purpose:** Every India-specific compliance requirement our ERP must handle

---

## 1. GST (Goods and Services Tax)

### What is GST?
India's unified indirect tax (replaced VAT, service tax, excise, etc. in 2017). Every business selling goods or services >₹20L (services) / ₹40L (goods) must register and file GST returns.

### GST Structure
```
CGST (Central GST) + SGST (State GST) = Intra-state sale
IGST (Integrated GST)                  = Inter-state sale
```

| Type | When | Rate | Collected By |
|------|------|------|-------------|
| CGST + SGST | Sale within same state | Split of GST rate | Central + State Govt |
| IGST | Sale to different state | Full GST rate | Central Govt |

### GST Rates (Common)
| Rate | Applies To |
|------|-----------|
| 0% | Essential goods (unbranded food, books, education) |
| 5% | Essential items, processed food, transport |
| 12% | Processed food, computers, mobiles |
| 18% | Most goods and services (default rate) |
| 28% | Luxury items, sin goods, automobiles |

### GST Returns We Must Handle

| Return | Frequency | Purpose | Due Date |
|--------|-----------|---------|---------|
| **GSTR-1** | Monthly | Outward supplies (sales) | 11th of next month |
| **GSTR-3B** | Monthly | Summary return + tax payment | 20th of next month |
| **GSTR-2B** | Auto-populated | Input Tax Credit (ITC) data | 12th (auto) |
| **GSTR-9** | Annual | Annual return | 13th Feb next year |
| **GSTR-9C** | Annual | Reconciliation statement (turnover >₹2Cr) | 13th Feb next year |

### Our GST Engine Must Do

1. **Auto-calculate GST** on every invoice based on:
   - Customer location (same state → CGST+SGST, different state → IGST)
   - HSN/SAC code of product/service → GST rate
   - Taxable value → GST amount

2. **Auto-generate GSTR-1** from invoice data:
   - B2B invoices (with customer GSTIN)
   - B2C invoices (without GSTIN)
   - Export invoices (zero-rated)
   - Credit notes / debit notes

3. **Auto-generate GSTR-3B** summary:
   - Total outward supplies
   - Total inward supplies (purchases)
   - Input Tax Credit (ITC) claimed
   - Net tax payable

4. **ITC Reconciliation** (GSTR-2B vs books):
   - Match vendor invoices in our books with GSTR-2B data
   - Flag: matched, mismatched, not in 2B, excess ITC
   - Alert user to NOT claim ITC for mismatched vendors

5. **GSTIN Verification**:
   - Verify vendor GSTIN is active before booking ITC
   - Alert if vendor GSTIN suspended/cancelled

6. **HSN/SAC Code Mapping**:
   - Map each product/service to HSN (goods) or SAC (services) code
   - Auto-determine GST rate from HSN/SAC code
   - HSN required on invoices if turnover >₹1.5Cr (B2B) or >₹5Cr (B2C)

7. **Multi-State GST**:
   - One company can have GST registration in multiple states
   - Each state has separate GSTIN
   - Each GSTIN files separate returns
   - Inter-state transactions between own GSTINs = taxable

### GST Penalties We Help Users Avoid
| Mistake | Penalty |
|---------|---------|
| Late filing | ₹50/day (₹20/day nil return) |
| Wrong ITC claim | 100% of ITC + interest |
| Mismatch GSTR-1 vs GSTR-3B | Notice + penalty |
| Not filing GSTR-9 | ₹200/day (₹100 CGST + ₹100 SGST) |

---

## 2. TDS (Tax Deducted at Source)

### What is TDS?
Tax deducted by payer before paying the payee. Deductor remits to government and issues certificate to deductee.

### Common TDS Sections We Must Handle

| Section | Payment Type | Rate (Individual) | Rate (Company) | Threshold |
|---------|-------------|-------------------|-----------------|-----------|
| **194C** | Contract work | 1% | 2% | ₹30,000 single / ₹1,00,000 annual |
| **194J** | Professional/technical fees | 10% (prof) / 2% (tech) | 10% / 2% | ₹30,000 single / ₹50,000 annual |
| **194I** | Rent (land/building) | 10% | 10% | ₹2,40,000 annual (building) / ₹50,000 (land) |
| **194Q** | Purchase of goods | 0.1% | 0.1% | ₹50,00,000 annual |
| **194H** | Commission/brokerage | 5% | 5% | ₹15,000 annual |
| **194O** | E-commerce sales | 1% | 1% | N/A (at payment) |
| **192** | Salary | Slab rate | — | Monthly (as per slab) |
| **194A** | Interest (other than securities) | 10% | 10% | ₹40,000 annual (₹50,000 senior) |
| **194I(b)** | Rent (plant/machinery) | 2% | 2% | ₹2,40,000 annual |
| **194K** | Mutual fund dividends | 10% | 10% | ₹5,000 |
| **194N** | Cash withdrawal | 2% | 2% | ₹1 Cr annual (₹20L if no ITR 3 yr) |

### Our TDS Engine Must Do

1. **Auto-deduct TDS** when vendor payment is approved:
   - Check vendor type (individual/company) → apply correct rate
   - Check cumulative payments to vendor → check threshold
   - Calculate TDS amount → deduct from payout
   - Net payment = Gross - TDS

2. **Generate TDS returns**:
   - **24Q** (salary TDS) — quarterly
   - **26Q** (non-salary TDS) — quarterly
   - **27Q** (non-resident TDS) — quarterly (rare)

3. **Generate TDS certificates**:
   - **Form 16** (salary) — annually
   - **Form 16A** (non-salary) — quarterly
   - Auto-generate + email to deductee

4. **TRACES integration**:
   - Download Form 26AS data (TDS credit data)
   - Reconcile: TDS deducted vs TDS deposited vs TDS in 26AS
   - Flag mismatches

5. **Lower TDS certificates** (Form 13A):
   - Some vendors have "lower deduction" certificate from IT dept
   - System stores certificate → applies reduced rate
   - Alert when certificate expires

### TDS Return Due Dates

| Quarter | Return Period | Due Date |
|---------|--------------|---------|
| Q1 | Apr-Jun | 31st July |
| Q2 | Jul-Sep | 31st October |
| Q3 | Oct-Dec | 31st January |
| Q4 | Jan-Mar | 31st May |

---

## 3. E-INVOICING (IRN)

### What is E-Invoicing?
Government mandate: B2B invoices must be reported to Invoice Registration Portal (IRP) and get an Invoice Reference Number (IRN) + QR code before sending to customer.

### Who Needs E-Invoicing?
| Turnover | Mandatory Since |
|----------|-----------------|
| >₹500 Cr | Oct 2020 |
| >₹100 Cr | Jan 2022 |
| >₹50 Cr | Aug 2022 |
>₹20 Cr | Apr 2025 |
| >₹5 Cr | Aug 2023 |
 | >₹5 Cr (expanded) | 2025-2026 (gradually lowering) |
| All businesses | Expected by 2026-27 |

### E-Invoicing Flow
```
1. Create invoice in ERP (GST-compliant)
     ↓
2. ERP generates invoice JSON (schema mandated by gov)
     ↓
3. Send JSON to IRP API
     ↓
4. IRP validates:
     - GSTIN valid?
     - HSN codes correct?
     - Tax amounts calculated correctly?
     ↓
5. IRP returns:
     - IRN (64-char unique invoice ID)
     - QR code (contains invoice summary)
     - Digital signature
     ↓
6. ERP stores IRN + QR code + signed invoice
     ↓
7. ERP generates PDF invoice with QR code printed
     ↓
8. Customer can scan QR code → verify invoice on gov portal
     ↓
9. IRN must be generated BEFORE invoice sent to customer
     ↓
10. If invoice cancelled → must cancel IRN within 24 hours
```

### IRP API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1.0/Invoice/1.0/einvoice` | Generate IRN |
| `POST /api/v1.0/Invoice/1.0/CancelIrn` | Cancel IRN |
| `GET /api/v1.0/Invoice/1.0/Invoice/irn` | Get IRN details |
| `GET /api/v1.0/Invoice/1.0/Master/address` | Get GSTIN address |
| `GET /api/v1.0/Invoice/1.0/Master/gstin` | Get GSTIN details |

### Invoice JSON Schema (Simplified)
```json
{
  "BuyerDtls": {
    "Gstin": "29ABCDE1234F1Z5",
    "LglNm": "Customer Company Pvt Ltd",
    "Addr1": "123 MG Road",
    "State": "29",
    "Pin": 560001
  },
  "SellerDtls": {
    "Gstin": "29XYZAB5678K1Z2",
    "LglNm": "Our Company Pvt Ltd",
    "Addr1": "456 Brigade Road",
    "State": "29",
    "Pin": 560001
  },
  "ItemList": [
    {
      "SlNo": "1",
      "PrdDesc": "Software Development Services",
      "HsnCd": "998314",
      "Qty": 1,
      "Unit": "NOS",
      "UnitPrice": 100000,
      "TotAmt": 100000,
      "GSTRt": 18,
      "GstAmt": 18000,
      "TotItemAmt": 118000
    }
  ],
  "DocDtls": {
    "Typ": "INV",
    "No": "INV-2026-001",
    "Dt": "03/07/2026"
  },
  "ValDtls": {
    "AssVal": 100000,
    "CgstVal": 9000,
    "SgstVal": 9000,
    "TotInvVal": 118000
  }
}
```

---

## 4. E-WAY BILL

### What is E-Way Bill?
Electronic document required for movement of goods >₹50,000 in value. Generated on GST portal, shared with transporter.

### When Required
| Condition | Required? |
|-----------|----------|
| Goods movement >₹50,000 | ✅ Yes |
| Goods movement <₹50,000 | ❌ No |
| Services (no goods movement) | ❌ No |
| Transport within 10km (own vehicle) | ❌ No |
| Goods exempt from GST | ❌ No |
| Transport via rail/air/godown to port | ❌ No (for export) |

### E-Way Bill Flow
```
1. Sales invoice created in ERP
     ↓
2. If goods movement + value >₹50K → system prompts to generate e-way bill
     ↓
3. ERP sends data to EWB API:
     - Invoice number, date, value
     - GSTIN of supplier, recipient
     - HSN code, goods description
     - Vehicle number, transporter ID
     - Origin, destination
     ↓
4. EWB API returns: EWB Number (12-digit) + valid till date
     ↓
5. EWB number shared with transporter / driver
     ↓
6. EWB valid for:
     - <100km: 1 day
     - 100-300km: 3 days
     - >300km: 3-5 days
     ↓
7. If goods not moved within validity → auto-cancel → regenerate
     ↓
8. If vehicle changes → Part B update (new vehicle number)
     ↓
9. If trip cancelled → cancel EWB
```

### EWB API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1.0/ewaybill` | Generate e-way bill |
| `POST /api/v1.0/ewaybills/cancel` | Cancel e-way bill |
| `POST /api/v1.0/ewaybills/update` | Update vehicle number (Part B) |
| `GET /api/v1.0/ewaybills/{id}` | Get e-way bill details |

---

## 5. DPDP ACT (Digital Personal Data Protection Act, 2023)

### What is DPDP Act?
India's data privacy law (like GDPR for EU). Governs how personal data of Indian residents is collected, stored, processed, shared.

### Key Requirements

| Requirement | What We Must Do |
|------------|-----------------|
| **Consent** | Get explicit consent before collecting personal data (name, PAN, Aadhaar, bank details) |
| **Purpose limitation** | Use data only for stated purpose (accounting, tax filing) |
| **Data minimization** | Collect only what's necessary |
| **Data residency** | Store personal data of Indian residents in India (AWS Mumbai) |
| **Data breach notification** | Notify users within 72 hours of breach |
| **Right to access** | Let users see what data we have about them |
| **Right to correction** | Let users correct their personal data |
| **Right to erasure** | Delete user data when they ask (unless legally required to keep) |
| **Data Protection Officer** | Appoint a DPO if we're a "Significant Data Fiduciary" |
| **Privacy policy** | Clear, accessible privacy policy |
| **Age verification** | If we serve minors (unlikely for B2B) |

### Personal Data We Collect
| Data | Source | Purpose | Retention |
|------|--------|---------|-----------|
| Name, email, phone | User signup | Account management | Until account deleted |
| PAN, Aadhaar | Tax compliance | TDS filing, verification | As per IT Act (up to 7 years) |
| Bank account details | Bank feeds | Reconciliation | As per Companies Act (8 years) |
| GSTIN | Tax compliance | GST filing | As per GST Act (6 years) |
| Transaction data | Bank/CRM | Accounting | As per Companies Act (8 years) |
| Employee data | HR integration | Payroll, reimbursement | As per IT Act (7 years) |

### DPDP Compliance Checklist
- [ ] Privacy policy page
- [ ] Consent popup at signup (explicit consent for data collection)
- [ ] Data processing agreement for vendors (Setu, ClearTax, etc.)
- [ ] Data export tool (user can download their data)
- [ ] Data deletion tool (user can request deletion)
- [ ] Data breach response plan
- [ ] Data flow mapping (where data goes, who sees it)
- [ ] DPO appointment (if classified as Significant Data Fiduciary)
- [ ] Annual DPDP audit
- [ ] Encryption of personal data at rest and in transit

---

## 6. COMPANIES ACT (Accounting Standards)

### What is Companies Act?
Indian law governing company formation, operations, and financial reporting.

### Accounting Standards We Must Support

| Standard | Indian Name | International Equivalent |
|----------|--------------|--------------------------|
| Ind AS 1 | Presentation of Financial Statements | IAS 1 |
| Ind AS 7 | Statement of Cash Flows | IAS 7 |
| Ind AS 18 | Revenue | IFRS 15 |
| Ind AS 115 | Revenue from Contracts with Customers | IFRS 15 |
| Ind AS 12 | Income Taxes | IAS 12 |
| Ind AS 116 | Leases | IFRS 16 |
| Ind AS 2 | Inventories | IAS 2 |
| Ind AS 36 | Impairment of Assets | IAS 36 |
| Ind AS 38 | Intangible Assets | IAS 38 |

### Record Retention Requirements
| Document | Retention Period | Legal Basis |
|----------|-----------------|-------------|
| Accounting records (books of accounts) | 8 years from FY end | Companies Act, Sec 128 |
| GST records | 6 years from due date | CGST Act |
| TDS records | 7 years | Income Tax Act |
| Audit reports | 8 financial years | Companies Act |
| Board resolutions | Permanent | Companies Act |
| Tax audit reports | 7 years | Income Tax Act |
| E-invoices / IRN records | 8 years | CGST Act |

### Our System Must Do
1. **Auto-delete / archive** data after legal retention period
2. **Audit trail** of all changes (who changed what, when)
3. **Data export** for auditors (give auditor read-only access)
4. **Financial statements** as per Ind AS format:
   - Balance Sheet (vertical format, Schedule III)
   - Profit & Loss (vertical format, Schedule III)
   - Cash Flow Statement
   - Notes to Accounts
5. **MCA Filing** support (AOC-4, MGT-7) — Phase 3

---

## 7. RBI DATA LOCALIZATION

### What is RBI Data Localization?
RBI mandate: all payment data of Indian residents must be stored only in India.

### What This Means for Us
- All bank transaction data → stored in AWS Mumbai
- All payment gateway data → stored in AWS Mumbai
- All customer PII → stored in AWS Mumbai
- Can process data outside India temporarily, but must delete after processing
- Must not store payment data outside India permanently

### Compliance
- [ ] Primary database in AWS Mumbai (ap-south-1)
- [ ] S3 backup in AWS Mumbai
- [ ] No cross-region replication for PII data
- [ ] Log any data that leaves India (even for API processing)
- [ ] ClearTax, Setu, Razorpay — all store data in India (verified)

---

## 8. OTHER COMPLIANCE

### PF (Provident Fund)
| Aspect | Detail |
|--------|--------|
| Applicability | All companies with 20+ employees |
| Rate | 12% employer + 12% employee (basic + DA) |
| Filing | Monthly ECR (Electronic Challan-cum-Return) |
| Due date | 15th of next month |
| API | EPFO API (for filing) — Phase 2 |

### ESIC (Employee State Insurance)
| Aspect | Detail |
|--------|--------|
| Applicability | Companies with 10+ employees, salary <₹21,000 |
| Rate | 3.25% employer + 0.75% employee |
| Filing | Monthly |
| Due date | 15th of next month |
| API | ESIC portal API — Phase 2 |

### Professional Tax
| Aspect | Detail |
|--------|--------|
| Applicability | State-specific (not all states have PT) |
| Rate | ₹200-2,000/year (varies by state) |
| Filing | Monthly/annually (varies by state) |
| API | State-specific portals — Phase 2 |

### Income Tax (Corporate)
| Aspect | Detail |
|--------|--------|
| Advance Tax | Quarterly payment (15% Jun, 45% Sep, 75% Dec, 100% Mar) |
| TDS on payments | As described in Section 2 above |
| Return filing | ITR-6 annually (before 31st Oct) |
| Tax audit | If turnover >₹1Cr (business) or >₹50L (profession) |
| API | ITD API (for advance tax, TDS) — Phase 2 |

### ROC Filing (MCA)
| Aspect | Detail |
|--------|--------|
| AOC-4 | Annual financial statements filing (within 30 days of AGM) |
| MGT-7 | Annual return filing (within 60 days of AGM) |
| ADSR-2.5 | Active Company Tagging (one-time) |
| API | MCA21 portal — Phase 3 |

---

## Compliance Summary Matrix

| Compliance | Priority | Phase | Via | Automated? |
|------------|----------|-------|-----|------------|
| GST calculation | 🔴 Critical | P1 | Built-in | ✅ Fully auto |
| GSTR-1 filing | 🔴 Critical | P1 | ClearTax API | ✅ Auto |
| GSTR-3B filing | 🔴 Critical | P1 | ClearTax API | ✅ Auto |
| ITC reconciliation | 🔴 Critical | P1 | Built-in + ClearTax | ✅ Auto |
| E-Invoicing (IRN) | 🔴 Critical | P1 | GSTN IRP API | ✅ Auto |
| E-Way Bill | 🔴 Critical | P1 | GSTN EWB API | ✅ Auto |
| TDS deduction | 🔴 Critical | P1 | Built-in | ✅ Auto |
| TDS return filing | 🟡 High | P2 | ClearTax API | ✅ Auto |
| TDS certificates | 🟡 High | P2 | Built-in | ✅ Auto |
| DPDP Act compliance | 🔴 Critical | P1 | Built-in + legal | ✅ Semi-auto |
| RBI data localization | 🔴 Critical | P1 | AWS Mumbai | ✅ Infrastructure |
| Ind AS financials | 🔴 Critical | P1 | Built-in reporting | ✅ Auto |
| PF (EPFO) | 🟡 High | P2 | EPFO API | ✅ Auto |
| ESIC | 🟡 High | P2 | ESIC API | ✅ Semi-auto |
| Professional Tax | 🟡 High | P2 | State portals | Partly auto |
| MCA filing (AOC-4/MGT-7) | 🟢 Medium | P3 | MCA21 portal | Semi-auto |

---

## Contact List — Compliance Partners

| Provider | What We Need From Them | Contact |
|----------|----------------------|---------|
| **ClearTax** | GSP access + API pricing for GST/TDS filing | https://cleartax.co/developers |
| **GSTN** | GSP status OR GSP partner relationship | https://www.gst.gov.in/gsp-callback |
| **IRP (E-Invoicing)** | Client ID + Secret for IRP API | https://einvoice1.gst.gov.in/IRPMaster/Home |
| **EWB (E-Way Bill)** | Username + Password for EWB API | https://ewaybill1.nic.in/ |
| **Setu** | Account Aggregator framework access | https://setu.co/contact |
| **EPFO** | ECR filing API access | https://www.epfindia.gov.in/ |
| **ESIC** | ESIC portal API access | https://www.esic.in/ |
| **AWS** | Mumbai region + data residency documentation | https://aws.amazon.com/contact-us/ |