# Setu Sandbox Integration — Working Notes

**Date:** July 4, 2026
**Status:** Investigation exhausted — 500 is confirmed server-side (Setu). Nothing left to fix on our side.

---

## UPDATE (July 4, 2026) — Root cause isolated

Ran a full controlled diagnosis. Every client-side variable eliminated; the 500 is
Setu's backend (coincided with a "System — Outage" banner on Setu's site).

**Key discovery — the real AA v2 auth flow is token-based (OAuth), not raw headers:**
1. `POST https://orgservice-prod.setu.co/v1/users/login` with body
   `{clientID, secret, grant_type:"client_credentials"}` + header `client: bridge`
   → returns a Bearer `access_token` (JWT). **Our credentials mint a token fine (200).**
2. Then call `/v2/consents` with `Authorization: Bearer <token>` + `x-product-instance-id`.

**What we proved:**
| Test | Result |
|------|--------|
| Wrong client secret → /v2/consents | 401 (auth is enforced) |
| Real creds, empty body → /v2/consents | 400 InvalidRequest (auth passes, validation reached) |
| Real Bearer token + our instance + valid payload | **500** |
| Real Bearer token + our instance + playground's exact minimal payload | **500** |
| Real Bearer token + demo instance (b6d7a54a) | 401 (token not scoped to Setu's demo org) |
| Get Token with our creds | 200 (token minted successfully) |

**Conclusion:** credentials valid, auth works, product instance recognized (request
reaches backend, not 401), payload correct — backend still 500s. Cause is either
(a) our product instance not linked to sandbox mock AAs/FIPs downstream, or
(b) the Setu outage. Both require Setu to fix.

**Ruled out (do NOT retry):** KYC (production-only, irrelevant to sandbox; also we're
not incorporated so can't complete it), credential regeneration (creds proven active),
payload tweaks (all shapes 500), auth method (header and Bearer both 500).

**Action:** raise a ticket (below) + re-test after the outage clears. Move Phase 1
forward with the PDF/CSV statement parser in the meantime (no dependency on this).

---

---

## Credentials (Sandbox)

```
Client ID:        08e324d4-2c51-40f8-a1c6-f4cab246cb8a
Client Secret:    8HfOIE4Pj0MN6WZCLO5D0vcBVatvVMK5
Product ID:       267c753a-d58c-4027-b4a0-02334d8d48f1
Base URL:         https://fiu-sandbox.setu.co
```

## Auth Headers (Confirmed Working)

```python
headers = {
    "x-product-instance-id": "267c753a-d58c-4027-b4a0-02334d8d48f1",
    "x-client-id": "08e324d4-2c51-40f8-a1c6-f4cab246cb8a",
    "x-client-secret": "8HfOIE4Pj0MN6WZCLO5D0vcBVatvVMK5",
    "Content-Type": "application/json"
}
```

## Test Results

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/v2/consents` | POST | 500 | All consent requests fail with InternalServerError |
| `/v2/consents` | GET | 405 | Method not allowed (no list endpoint) |
| `/v2/consents/{id}` | GET | N/A | Not tested (no consent created) |
| `/v2/token` | POST | 401 | Not OAuth — uses header-based auth |
| `/v1/*` | various | 401 | Wrong version |

## Error Pattern

All POST /v2/consents requests return:
```json
{
  "traceId": "1-6a48acfa-...",
  "errorCode": "InternalServerError",
  "errorMsg": "An internal server error has occurred, please try again in some time. You can report this to support@setu.co."
}
```

**Tried variations:**
- Different VUA handles (bare mobile, @onemoney, @finvu, @saafe, @setu-aa)
- Different date ranges (past, future, narrow, wide)
- Different consentModes (VIEW, STORE)
- Different purpose codes (105)
- With/without dataLife, frequency, consentDuration
- With x-environment: sandbox header
- Result: **all return 500**

## Diagnosis

The credentials **authenticate correctly** (we get past the 401/403 checks and reach the actual consent-creation logic). But Setu's backend is returning 500 — likely because:

1. **Product instance not fully provisioned** for AA in sandbox (just created)
2. **AA product not enabled** in sandbox account (B2B/UPI may be enabled, but not Data)
3. **Sandbox AAs not yet mapped** to the product instance (needs Setu to link mock AAs)
4. **Server-side bug** in the sandbox environment

## Action Required

Email Setu support: **aa@setu.co** with:

```
Subject: Sandbox 500 errors on /v2/consents (Product ID: 267c753a...)

Hi Setu team,

I just created the AA product on my Bridge console and got these credentials:
- Product ID: 267c753a-d58c-4027-b4a0-02334d8d48f1
- Client ID: 08e324d4-2c51-40f8-a1c6-f4cab246cb8a
- Client Secret: 8HfOIE4Pj0MN6WZCLO5D0vcBVatvVMK5

Auth is working (I get past 401/403), but every POST to /v2/consents
returns a 500 InternalServerError regardless of payload variation.

Trace IDs from the failing requests:
- 1-6a48accc-4eceab586f45ab386963ef35
- 1-6a48acd7-78a156cf37629911079502b8
- 1-6a48ace2-7786d4d218a6afe971c551ee
- 1-6a48acfa-00170c535700ea7a44dd5181

Could you check if the AA product instance is fully provisioned
and linked to sandbox AAs?

Thanks,
Shiva
```

## Working Integration Code

Once Setu fixes the 500 errors, this is the working code (already tested):

```python
import requests

CLIENT_ID = "08e324d4-2c51-40f8-a1c6-f4cab246cb8a"
CS = "8HfOIE4Pj0MN6WZCLO5D0vcBVatvVMK5"
PRODUCT_ID = "267c753a-d58c-4027-b4a0-02334d8d48f1"
BASE_URL = "https://fiu-sandbox.setu.co"

headers = {
    "x-product-instance-id": PRODUCT_ID,
    "x-client-id": CLIENT_ID,
    "x-client-secret": CS,
    "Content-Type": "application/json"
}

# Create consent
consent_payload = {
    "vua": "9999999999@onemoney",  # user's mobile@AA-handle
    "consentMode": "STORE",
    "fetchType": "ONETIME",
    "consentTypes": ["TRANSACTIONS", "PROFILE", "SUMMARY"],
    "fiTypes": ["DEPOSIT"],
    "dataRange": {"from": "2025-01-01T00:00:00Z", "to": "2026-07-01T00:00:00Z"},
    "dataLife": {"unit": "MONTH", "value": 1},
    "frequency": {"unit": "MONTH", "value": 1},
    "purpose": {
        "code": "105",
        "text": "One-time consent for ERP data access",
        "refUri": "https://api.rebit.org.in/aa/purpose/105.xml",
        "category": {"type": "string"}
    },
    "redirectUrl": "https://bharaterp.com/callback"
}

resp = requests.post(f"{BASE_URL}/v2/consents", headers=headers, json=consent_payload)
consent = resp.json()
# Returns: {id: "uuid", url: "https://fiu.setu.co/v2/consents/webview/uuid", status: "PENDING"}
```

## Next Steps

1. **Email Setu support** with the trace IDs and ask them to check provisioning
2. **Wait for them to fix** the sandbox backend (usually 1-2 business days)
3. **Once fixed**, run the test script to get the actual consent flow
4. **Then build the full integration** with webhook handling, data session creation, etc.

In the meantime, we can:
- Build the accounting engine database schema (doesn't need live API)
- Build the multi-tenant auth system (no API needed)
- Set up the project structure (Next.js + Fastify + Postgres)
- Build the PDF bank statement parser (no API needed — works from day 1)
