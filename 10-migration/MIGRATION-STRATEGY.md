# Migration Strategy — Switching from Legacy Systems

> **Last Updated:** July 3, 2026
> **Purpose:** How customers migrate from Tally, QuickBooks, Zoho, Excel to our ERP

---

## Why Migration Matters

The #1 barrier to switching ERPs is **switching cost** — the pain of moving data, re-training staff, and risk of losing history.

Campfire solved this with a **$5M CFO Buyout Fund** (paying cash to buy out contracts). We solve it with **software** — one-click migration tools.

---

## Migration Sources (Priority Order)

| # | Source | Users in India | Priority | Difficulty |
|---|--------|---------------|----------|------------|
| 1 | **Tally ERP 9 / Tally Prime** | 11M+ | 🔴 P1 | Medium (XML export) |
| 2 | **Excel / CSV** | Millions | 🔴 P1 | Easy (universal) |
| 3 | **QuickBooks India** | ~50K stuck users | 🟡 P2 | Medium (CSV export) |
| 4 | **Zoho Books** | Growing | 🟡 P2 | Medium (API export) |
| 5 | **Marg ERP** | 1M+ | 🟢 P3 | Medium (XML/CSV) |
| 6 | **Busy Accounting** | 2M+ | 🟢 P3 | Medium (XML/CSV) |
| 7 | **SAP B1** | Enterprise | 🟢 P3 | Hard (DTW API) |

---

## 1. Tally Migration (Priority #1)

### What Tally Stores
| Data | Where | Export Format |
|------|-------|---------------|
| Chart of Accounts | Tally data file | XML (via Tally HTTP API) |
| Companies | Tally data file | XML |
| Vouchers (transactions) | Tally data file | XML |
| Stock items | Tally data file | XML |
| Ledger masters | Tally data file | XML |
| GST returns | Tally data file | XML |

### Migration Flow
```
Step 1: User exports data from Tally
  → Tally Prime: Gateway of Tally → Export → XML
  → Select: Masters + Vouchers + Stock Items
  → Save to folder

Step 2: User uploads XML file(s) to our ERP
  → Upload via web app
  → Or email to migrate@ourerp.com

Step 3: Our parser extracts:
  → Chart of Accounts → mapped to our COA structure
  → Ledger masters → vendors, customers
  → Vouchers → journal entries
  → Stock items → inventory items
  → GST returns → historical GST data

Step 4: Mapping & Review
  → Show user: "We found 850 ledgers, 12,400 vouchers"
  → Map Tally account codes to our chart of accounts
  → User reviews and confirms

Step 5: Import
  → All historical transactions imported
  → Opening balances calculated
  → GST history imported
  → User can see prior years in our system

Step 6: Parallel Run (Optional)
  → User runs Tally + our ERP side by side for 1 month
  → Compare outputs (P&L, BS should match)
  → Once confident, switch fully
```

### Tally XML Schema (What We Parse)
```xml
<!-- Tally exports vouchers like this -->
<ENVELOPE>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE>
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>20260701</DATE>
            <PARTYLEDGERNAME>Customer Name</PARTYLEDGERNAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Sales Account</LEDGERNAME>
              <AMOUNT>-11800</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>CGST</LEDGERNAME>
              <AMOUNT>900</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
```

### Tally Migration Challenges
| Challenge | Solution |
|-----------|---------|
| Tally account codes differ from standard COA | Auto-map common Tally ledger names to our COA + manual override |
| Historical vouchers have no IRN | Import as historical — no IRN needed for past invoices |
| Stock items may have no HSN codes | Prompt user to assign HSN during import |
| Multi-company Tally files | Each company imported as separate entity |
| Voucher types differ (Payment, Receipt, Contra, Journal) | Map all to our journal entry types |
| GST returns in Tally may not match portal | Import as reference data, re-reconcile with GSTR-2B |

### Tally Migration Tool (What We Build)
- Web-based wizard: Upload → Parse → Map → Review → Import
- Supports: XML (primary), CSV (fallback)
- Handles: Masters, Vouchers, Stock Items, GST Returns
- Time: <30 minutes for a typical business
- Free for all users (our "CFO Buyout Fund" equivalent)

---

## 2. Excel / CSV Migration (Priority #1)

### What We Accept
| Data | Format | Columns |
|------|--------|---------|
| Chart of Accounts | CSV | account_code, account_name, account_type |
| Vendors | CSV | name, gstin, pan, payment_terms, email, phone |
| Customers | CSV | name, gstin, billing_address, payment_terms, email, phone |
| Historical transactions | CSV | date, account_code, debit, credit, description |
| Opening balances | CSV | account_code, opening_balance_debit, opening_balance_credit |
| Stock items | CSV | name, hsn_code, unit, gst_rate, opening_stock, rate |

### CSV Template Downloads
- Provide pre-formatted CSV templates for each data type
- User downloads template, fills in data, uploads
- Parser validates data → shows errors → user fixes → re-upload
- Bulk import in one go

### Validation Rules
- GSTIN format: 15 chars, state code + PAN + entity + Z + checksum
- PAN format: 10 chars (5 letters + 4 digits + 1 letter)
- Account types: asset, liability, equity, revenue, expense
- Debit/credit must balance per entry
- Date format: DD/MM/YYYY (Indian format)

---

## 3. QuickBooks India Migration (Priority #2)

### Why This Matters
Intuit shut down QuickBooks India in 2022. ~50,000 businesses were forced to find alternatives. Many went to Zoho Books or Tally — but are unhappy.

### What We Accept
- QuickBooks Transaction List (CSV export from QB)
- QuickBooks Customer/Vendor List (CSV)
- QuickBooks Chart of Accounts (CSV)
- QuickBooks Trial Balance (for opening balances)

### Migration Flow
```
1. User exports from QuickBooks India:
   → Reports → Transaction List by Date → Excel
   → Reports → Customer Contact List → Excel
   → Reports → Vendor Contact List → Excel
   → Reports → Account List → Excel

2. Upload CSVs to our migration wizard

3. Parser maps:
   QB "Accounts Receivable" → our "Accounts Receivable"
   QB "Accounts Payable" → our "Accounts Payable"
   QB "Uncategorized Expense" → prompt user for correct category

4. Import + review
```

---

## 4. Zoho Books Migration (Priority #2)

### Migration Method
- Zoho Books has REST API — we can pull data directly
- User provides Zoho API key → we fetch all data
- Or user exports CSV from Zoho Books

### What We Import
| Data | Method |
|------|--------|
| Chart of Accounts | Zoho API / CSV |
| Customers | Zoho API / CSV |
| Vendors | Zoho API / CSV |
| Invoices | Zoho API / CSV |
| Bills | Zoho API / CSV |
| Transactions | Zoho API / CSV |
| Items | Zoho API / CSV |

---

## 5. SAP B1 Migration (Priority #3)

### For enterprise customers moving from SAP B1:
- Use SAP B1 DTW (Data Transfer Workbench) to export
- Export: Chart of Accounts, Business Partners, Journal Entries, Items
- Format: CSV templates from SAP
- Complex — likely needs professional services  

---

## Migration Wizard UX

```
Step 1: "Where are you switching from?"
  [Tally] [QuickBooks] [Zoho Books] [Excel] [Other]

Step 2: "Upload your data"
  Drag & drop zone for XML/CSV files
  Or "Connect Zoho Books" (OAuth for API)

Step 3: "We found..."
  → 850 ledgers
  → 12,400 vouchers
  → 156 stock items
  → 3 years of history

Step 4: "Map your accounts"
  Show Tally account → our account (auto-mapped)
  User can override any mapping

Step 5: "Review opening balances"
  Show opening balance per account
  User confirms

Step 6: "Import complete!"
  ✅ 850 accounts mapped
  ✅ 12,400 vouchers imported
  ✅ 3 years of GST history
  ✅ Opening balances set
  
  "Your data is ready. Want to see your dashboard?"
```

---

## Migration Support

| Channel | What |
|---------|------|
| In-app wizard | Self-serve, guided flow |
| Video tutorials | How to export from Tally/Zoho/QB |
| WhatsApp support | Text us if stuck |
| Email support | migrate@ourerp.com |
| White-glove (paid) | We do migration for you — ₹10K-50K based on data size |
| For enterprise | Included in Enterprise tier |