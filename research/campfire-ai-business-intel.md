# Campfire.ai — Business Intelligence Report

> **Research Date:** July 3, 2026
> **Sources:** Crunchbase News, PRNewswire, FinTech Global, GetLatka, HackerNews, GitHub, DuckDuckGo, ERP comparison sites (wetheflywheel.com, numeric.io, erpclaw.ai, robocfo.ai), Yahoo Finance, campfire.ai website, YouTube channel
> **Method:** curl + web scraping (no browser needed)

---

## 1. Company Background

### Legal Entity
- **Legal Name:** Campfire Software, Inc.
- **Founded:** 2023
- **Headquarters:** San Francisco, California, USA
- **Offices:** SF, NYC, London (opened June 2026)
- **Accelerator:** Y Combinator Summer 2023 batch (S23)

### Founder
- **John Glasgow** — CEO & Founder
  - Previously VP of Business Development and Partnerships at **Invoice2go** (acquired by Bill.com in July 2021 for $625M)
  - Left Bill.com after the acquisition to start Campfire
  - 15+ years finance experience
  - First met Accel partner John Locke at Invoice2go (Locke was an investor there too)

### Team Size
| Date | Employees | Source |
|------|-----------|--------|
| June 2024 | ~4-13 | GetLatka |
| June 2025 (post-Series A) | ~10 | Crunchbase interview |
| Oct 2025 (post-Series B) | ~40 | Crunchbase interview |
| 2026 (current est.) | 40-60 | Estimated from growth trajectory |

**Key insight:** Team quadrupled from 10 to 40 after Series A in just a few months.

### Mission
Build an AI-native ERP — "a system of action, not just a system of record" — for modern finance and accounting teams at mid-sized and enterprise companies.

---

## 2. Funding & Financials

### Funding History

| Round | Date | Amount | Lead Investors | Total Raised |
|-------|------|--------|----------------|--------------|
| Seed/Pre-seed | 2023 (YC S23) | ~$3.5M | Y Combinator + early | $3.5M |
| Series A | June 2025 | $35M | Accel (led) | $38.5M |
| Series B | October 2025 | $65M | Accel + Ribbit Capital (co-led) | **$103.5M** |

**Total raised: $103.5M in ~12 weeks between Series A and Series B (not 12 weeks total — 12 weeks between A and B)**

### Investors
- **Accel** (led both Series A and B — John Locke, partner)
- **Ribbit Capital** (co-led Series B)
- **Foundation Capital** (Series A participant)
- **Y Combinator** (accelerator)
- **Angel investors / industry executives:**
  - Karim Atiyeh — co-founder & CTO at **Ramp**
  - Brad Floering — VP Finance & FP&A at **Snowflake**
  - Steve Sidhu — Controller at **Clay**
  - Scott Buxton — CFO at **Supabase**
  - Naeem Ishaq — former EVP, CFO & CSO at **Checkr**

### Revenue & Valuation

| Metric | Value | Source | Date |
|--------|-------|--------|------|
| Revenue (2024 est.) | ~$2M ARR | GetLatka | June 2024 |
| Revenue growth | 10x YTD | Company statement | Oct 2025 |
| Estimated 2025 ARR | ~$20M (10x from $2M) | Calculated | Oct 2025 |
| Valuation (early) | $5.9M | GetLatka | 2024 (pre-Series A) |
| Series B valuation | Not publicly disclosed | — | Oct 2025 |

### Profitability Assessment

**Campfire is almost certainly NOT profitable.**

Evidence:
1. **Series B startup in growth mode** — raised $103.5M, focusing on expansion
2. **Team growing rapidly** — 10 → 40 employees in months, now likely 40-60
3. **"Intense market pull" quote from CEO** — investing in growth, not margins
4. **$5M CFO Buyout Fund** — spending cash to acquire customers (paying companies to switch from legacy ERPs)
5. **New London office** (June 2026) — expanding internationally
6. **Pattern:** AI startups at this stage typically burn cash for growth

**Estimated burn rate:** With 40-60 employees at SF/NYC salaries (~$150K-200K avg), plus infrastructure, AI compute, and office costs → **~$12-18M annual burn**. With ~$20M ARR, they might be approaching break-even but are likely still net negative due to growth investment.

**Key signal:** The CFO Buyout Fund ($5M set aside to buy out competitors' contracts) is a customer acquisition cost play — not something a profit-focused company does.

---

## 3. Competitive Landscape

### The AI-Native ERP Market

> "Over $500 million in venture capital has flowed into AI-native ERP startups in the last 18 months." — RoboCFO.ai

The market is experiencing its most significant architectural shift since on-premise to cloud. AI-native ERPs are attacking NetSuite's $4 billion mid-market franchise by compressing switching costs through AI-assisted migration.

### Direct Competitors (AI-Native ERPs)

| Company | Total Funding | Key Investors | Valuation | Focus | Founded |
|---------|--------------|---------------|-----------|-------|---------|
| **Campfire** | $103.5M | Accel, Ribbit, Foundation Cap, YC | Undisclosed | Close-cycle automation depth for SaaS | 2023 |
| **Rillet** | $108.5M | Sequoia, a16z, ICONIQ | ~$500M | Native SaaS metrics from GL | 2022 |
| **DualEntry** | $100M+ | Lightspeed, Khosla, GV, Contrary | $415M | Deployment speed, broad mid-market | 2024 |
| **Doss** | Undisclosed | — | — | Agent-orchestrated workflow | 2024-25 |
| **ERPClaw** | Bootstrapped | — | — | Open-source, $0 forever, 14 verticals | 2025-26 |

### How They Differentiate

#### Campfire
- **LAM (Large Accounting Model)** — proprietary model trained exclusively on accounting data
- **95%+ accuracy** on reconciliations and variance analysis
- **5x faster close cycles** — 144 days reclaimed annually per customer
- **SaaS-dominant ICP** — PostHog, Replit, Decagon, Klarity, CloudZero
- **Best fit:** $10-100M SaaS companies with complex billing stacks
- **MCP Store** — first ERP with Model Context Protocol store
- **Ember AI agents** — continuous + on-demand agents for AP/AR, matching, anomalies

#### Rillet
- **Aura AI** — conversational access to financial data + automated workflows
- **Native SaaS metrics** (ARR/MRR/NRR) calculated directly from the GL — no BI layer needed
- **200+ native integrations** to SaaS finance stack (Stripe, Ramp, Brex, Rippling, Salesforce, HubSpot)
- **~$500M valuation** — highest valued in the category
- **200+ customers** — largest customer base
- **Pricing:** $2,000-$10,000/month (founder-reported)
- **Best fit:** SaaS companies wanting GL-native SaaS metrics

#### DualEntry
- **13,000+ integrations** — broadest integration ecosystem
- **24-hour go-live claim** (greenfield, clean data) — fastest implementation
- **Multi-entity consolidation** is a stated differentiator
- **NYSE-listed customers** — claims enterprise traction
- **$415M valuation** at Series A
- **Best fit:** Broad mid-market, companies needing fast implementation and many integrations
- **Honest gap:** AI automation depth trails Campfire and Rillet on SaaS-specific workflows

### Legacy Incumbents (Being Disrupted)

| Incumbent | AI Feature | Weakness |
|-----------|-----------|----------|
| **NetSuite (Oracle)** | SuiteAI — transaction matching, anomaly detection, predictive forecasting | Core architecture predates smartphones; AI bolted on |
| **SAP S/4HANA** | Joule AI copilot — JE creation, variance analysis, NL queries | Slow innovation; massive implementation complexity |
| **Microsoft Dynamics** | Copilot — NL queries, automated workflows | AI-decorated, not AI-native |
| **Workday** | Illuminate AI — anomaly detection, intelligent document processing | Unified HR+Finance data model is strength; but AI is incremental |
| **Sage Intacct** | Sage Copilot | AI-decorated; forms-and-workflows product from 1990s |
| **QuickBooks (Intuit)** | Intuit Assist | Entry-level; companies outgrow it |
| **Xero** | Just Ask | AI-decorated; SMB-focused |

### The "AI-Native Test"
> Per ERPClaw: "Can your AI post a journal entry on its own, with no human in the loop, on a workflow you didn't pre-build for it? If no or 'we have approval gates', they are AI-decorated. If yes plus governance, they are AI-native."

**Fails the test:** NetSuite Joule, Oracle AI Agents, Microsoft Dynamics Copilot, Sage Copilot, QuickBooks Intuit Assist, Xero Just Ask, Odoo plug-in stack, ERPNext.

**Passes the test:** Campfire, Rillet, DualEntry, Doss, ERPClaw.

---

## 4. Business Model

### Revenue Model
- **SaaS subscription** — no publicly listed pricing
- **Enterprise sales motion** — no self-serve signup
- **Demo-based sales** — /book-demo page on website
- **Savings calculator** — /savings-calculator for ROI estimation
- **No implementation consulting fee** for standard use cases

### Pricing (Estimated)
- Not publicly disclosed
- Rillet (closest comparable) charges $2,000-$10,000/month
- Campfire targets $10-100M ARR SaaS companies → likely $5,000-$15,000/month range
- **$5M CFO Buyout Fund** — will buy out your existing ERP contract to switch you

### Target Customer Profile (ICP)
- **Primary:** $10-100M ARR SaaS / high-growth tech companies
- **Customer examples:** PostHog, Replit, Decagon, Klarity, CloudZero, TwelveLabs, Coder, Assembly AI
- **Geographic:** US-centric, expanding to UK (London office June 2026)
- **Customer count:** 20+ publicly named customers
- **Public company customer:** LimaOne (publicly traded)

### Sales Motion
1. No self-serve signup — all sales are consultative
2. Demo → scoping → implementation → go-live
3. Implementation time: "days to weeks" (vs months for NetSuite)
4. CFO Buyout Fund removes switching cost barrier
5. Word-of-mouth in SaaS/VC community (Accel portfolio companies demoing it)

---

## 5. GitHub & Open Source Presence

### GitHub Organization: github.com/campfireai

| Repo | Stars | Language | Description | Last Updated |
|------|-------|----------|-------------|--------------|
| job2vec | 6 | Jupyter Notebook | Semantic embedding model for job descriptions | Oct 2023 |
| lavastone | 9 | C++ | C++ standard library containers backed by disk | Jul 2022 |

**Assessment:** Minimal open source presence. The repos appear to be from a previous iteration of the company (pre-ERP pivot). No open-source ERP code, no SDKs, no public API documentation. The core product is entirely closed-source.

---

## 6. Online Presence & Traction

### YouTube Channel (@campfireerp)
- **25 videos** on official channel
- **23 transcripts** retrieved
- **Most viewed:** "How Replit scaled revenue 20X" — 1.24M views
- **Key viral videos:**
  - Klarity ERP market survey — 422K views
  - CFO Buyout Fund announcement — 250K views
  - $65M Series B announcement — 55K views
  - PostHog case study — 71K views
  - May Product Updates — 49K views
  - "Do the best work of your career" (recruitment) — 20K views
- **SupERPower Hour sessions:** 4 deep technical sessions (1 hour each) — low views (150-323) but extremely rich technical content
- **Finance Forward 2025 Summit:** 5 panel discussion videos from their own conference

### HackerNews
- **Minimal HN presence** — no major HN discussions about Campfire specifically
- One relevant HN comment: "campfire, rillet, light, are not real erp systems yet" — suggests market skepticism exists
- GitHub lavastone repo got 7 points on Show HN (2021)

### Press Coverage
| Outlet | Article | Date |
|--------|---------|------|
| PRNewswire | Official press release on Series B | Oct 2025 |
| Crunchbase News | "Why Accel Led A Round For Fintech Startup Campfire" | Oct 2025 |
| FinTech Global | "Campfire secures $65m Series B to transform finance AI" | Oct 2025 |
| Yahoo Finance | Series B announcement syndicated | Oct 2025 |
| TheSaaSNews | "Campfire Raises $65 Million in Series B" | Oct 2025 |
| EdgeN | "Campfire Secures $65 Million Series B" | Oct 2025 |
| The Great Entrepreneurs | "Campfire Raises $65 Million to Redefine ERP" | Oct 2025 |
| StockTitan | MFA Stock News coverage | Oct 2025 |

### G2 / Review Platforms
- G2 has a Campfire profile (g2.com/products/campfire-2026-02-16) but requires JavaScript — likely few reviews given enterprise-only sales model
- No visible reviews on Capterra or TrustRadius

### LinkedIn
- Company page exists: linkedin.com/company/campfire (exact follower count requires browser)
- LinkedIn posts by VersoriaAI mention Campfire in "5 ERPs to watch in 2026"
- Job postings likely active given team growth

### X/Twitter
- Y Combinator posted about Campfire: x.com/ycombinator/status/2058949824616231203
- Company handle: @meet_campfire

---

## 7. Technology Signals

### Tech Stack (From Website Analysis)
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js (React Server Components) |
| CMS | Sanity.io (project ID: zu7n19wi) |
| CDN/Security | Cloudflare |
| Analytics | Google Analytics, reb2b |
| Interactive Demos | Navattic |
| Attribution | Cello |
| Marketing | HubSpot |
| Banking | Plaid (agent of Plaid Financial Ltd, FCA regulated) |
| Tax | Anrok |
| Banking (alt) | Atlar |
| AI | Proprietary LAM (Large Accounting Model) |
| AI Agents | Ember AI (continuous + on-demand) |
| Protocol | MCP Store (Model Context Protocol) |
| Compliance | SOC 1 Type 1 |

### AI Architecture — The LAM (Large Accounting Model)
- **Domain-specific foundation model** trained exclusively on accounting data
- **First domain-specific model** in the ERP category
- **95%+ accuracy** on reconciliations and variance analysis (vs 80% for GPT models)
- **Architecture-native AI** — model is in the data layer, not query layer
- AI acts on records as they flow in (categorize, reconcile, flag anomalies)
- Every AI action carries **audit-ready attribution**
- Transforms ERP from "system of record" to "system of action"

### MCP Store — Industry First
- Model Context Protocol store — first ERP to implement
- Allows external AI agents/tools to connect to Campfire's data
- Enables "Ask Ember in Slack" — AI agents accessible from Slack
- Published May 14, 2026

---

## 8. Customer Case Studies

| Customer | Use Case | Results | Source |
|----------|----------|---------|--------|
| **Replit** | Scaled revenue 20x | No added finance headcount | YouTube (1.24M views) + blog |
| **PostHog** | 4 entities, 14 products, usage-based billing | Closed books faster, brought RevRec in-house | YouTube (71K views) + blog |
| **TwelveLabs** | Global consolidation | Saved $300K in operational costs | Blog post |
| **Coder** | Revenue reporting + invoicing | Saves 10 hours monthly | Blog post |
| **Klarity** | ERP market survey → Campfire | Went all-in on Campfire as next stage | YouTube (422K views) |
| **FERMÀT** | AI-native finance stack | 5-day close (with Ramp) | YouTube webinar |
| **LimaOne** | Public company partnership | Expanding influence across industries | FinTech Global article |

### Full Customer List (from website + press)
PostHog, Decagon, Replit, Speak, TwelveLabs, Klarity, Flex, Midi, Lima, Advisor360, Nourish, HockeyStack, Jane, Coder, FORA, April, CareRev, Fooji, Assembly AI, Forward, Volley, CloudZero, Tilt, Windsurf, Bitwarden

---

## 9. Strategic Assessment for Shiva's India/Global Competitor

### Is the Business Model Viable?

**✅ YES — The market is real and growing fast:**
- $500M+ in VC money flowing into AI-native ERP in 18 months
- NetSuite's $4B mid-market franchise is under attack
- AI-assisted migration has compressed switching costs
- 10x revenue growth at Campfire proves demand
- Customers like Replit, PostHog validate the ICP

**⚠️ Key risks:**
1. **Not profitable yet** — burning VC cash for growth
2. **Crowded space** — 5+ well-funded competitors ($300M+ combined funding between top 3)
3. **Enterprise sales cycles** — no self-serve means slow scaling
4. **Audit firm relationships** — incumbents have decades of auditor trust
5. **Vendor longevity risk** — some startups may not survive 3 years

### Opportunities for India + Global Competitor

| Strategy | Opportunity |
|----------|-------------|
| **India cost advantage** | Build AI/accounting talent in India at 1/3 SF costs → lower pricing |
| **Self-serve option** | None of the top 5 offer self-serve → capture SMB/mid-market they miss |
| **India market first** | Most US ERP tools don't serve India (GST, TDS, Indian compliance) |
| **Pricing disruption** | Undercut $5K-15K/month with $1K-5K/month tier for India/Asia |
| **Vertical specialization** | Focus on Indian SaaS/e-commerce vs generic |
| **Open-source play** | ERPClaw proves open-source AI-native ERP is possible — $0 forever model |
| **GST/TDS native** | No AI-native ERP handles Indian tax compliance natively |
| **Faster implementation** | 24-hour go-live is possible (DualEntry proves it) |
| **Regional integrations** | Integrate with Indian banking, payment, tax systems |
| **English-speaking market** | India + UK + Australia + Singapore = massive English-speaking TAM |

### Key Lessons from Campfire's Playbook

1. **Domain-specific AI model matters** — LAM (95% accuracy) is the moat, not generic GPT
2. **YC + top VC backing** creates credibility and customer pipeline (Accel portfolio companies demoing Campfire)
3. **CFO Buyout Fund** — removing switching cost is the #1 growth lever
4. **Customer case studies with metrics** — "20x revenue, no new headcount" is powerful marketing
5. **YouTube content strategy** — 1.2M views on Replit case study = free marketing
6. **SupERPower Hour sessions** — deep technical content builds developer trust
7. **MCP Store** — first-mover advantage in protocol-based AI ERP integrations
8. **Finance Forward Summit** — own the conference, own the narrative
9. **London expansion** — UK is the bridge to global markets
10. **Team velocity** — 10 to 40 people in months when market pull is strong

### Recommended Approach for Shiva

1. **Start with India** — GST/TDS compliance is a moat no US competitor has
2. **Self-serve + low price** — capture the segment Campfire/Rillet ignore
3. **Build domain-specific AI model** — don't use generic GPT; train on Indian accounting data
4. **Target Indian SaaS companies** — PostHog equivalents in India (Zoho, Freshworks ecosystem)
5. **Open-source option** — consider ERPClaw's model for rapid adoption
6. **Integrate with Indian stack** — Razorpay, Cashfree, ClearTax, Tally, Zoho Books
7. **Keep team in India** — 40 people in SF = $8M+/year. 40 in India = $1.5M/year
8. **Move fast** — the window is NOW. In 2 years, the market will be locked up

---

## 10. Market Size

- **Global ERP market:** ~$50-60B (2025)
- **Cloud ERP segment:** ~$30B, growing 10-15% CAGR
- **AI-enabled cloud ERP:** 60% of cloud ERP spending by 2027 (up from 14% in 2024) — Gartner via RoboCFO
- **Mid-market ERP:** NetSuite's $4B revenue = the prize these startups are attacking
- **AI-native ERP startup funding:** $500M+ in 18 months across 7 startups
- **India ERP market:** ~$2-3B, growing 20%+ CAGR, dominated by Tally + Zoho + SAP

---

## Sources

| Source | URL | Type |
|--------|-----|------|
| Crunchbase News | news.crunchbase.com/venture/ai-fintech-campfire-raise-seriesa-accel-ribbit | Interview + funding data |
| FinTech Global | fintech.global/2025/10/16/campfire-secures-65m-series-b-to-transform-finance-ai/ | Press coverage |
| GetLatka | getlatka.com/companies/meetcampfire.com | Revenue/employee estimates |
| PRNewswire | prnewswire.com (404 — syndicated via Yahoo Finance) | Press release |
| Yahoo Finance | finance.yahoo.com/news/campfire-raises-65-million-series | Press syndication |
| WeTheFlywheel | wetheflywheel.com/en/comparisons/dualentry-vs-campfire-vs-rillet | Competitive comparison |
| Numeric.io | numeric.io/blog/rillet-vs-campfire | Competitive comparison |
| ERPClaw | erpclaw.ai/blog/5-ai-native-erps-that-earn-the-label | AI-native ERP ranking |
| RoboCFO | robocfo.ai/frameworks/ai-native-erp-landscape | Market landscape |
| HackerNews | news.ycombinator.com (various) | Community discussion |
| GitHub | github.com/campfireai | Open source repos |
| Campfire website | campfire.ai (20+ pages) | Product/company info |
| Campfire YouTube | youtube.com/@campfireerp (25 videos, 23 transcripts) | Video content |
| DuckDuckGo | duckduckgo.com (multiple searches) | Search results |
