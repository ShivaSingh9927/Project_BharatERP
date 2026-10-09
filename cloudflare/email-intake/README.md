# Cloudflare email intake bridge

`inbox@nueralogic.com` currently forwards to a verified Gmail address. Keep
that routing rule in place while testing this bridge. The Wrangler
configuration currently routes `inbox+bridgecheck@nueralogic.com` and the
`Nueralogic Pilot` client's exact plus-address to the Worker for live tests.

## Flow

1. Cloudflare Email Routing calls the Worker for the exact test plus-addresses.
   The main `inbox@nueralogic.com` address will use this flow after cutover.
2. The Worker stores the original MIME message in a **private Standard R2**
   bucket, then forwards a copy to the verified Gmail destination.
3. When the local ERP app is on, it polls R2 every two minutes. The importer
   checks the object hash and envelope recipient, parses MIME, and puts each
   attachment in the existing Documents inbox. A 20-character client token
   resolves the firm and client. Plain `inbox@` mail uses the explicitly
   configured pilot firm and stays Unassigned. Unknown plus references remain
   in R2 for platform review; they cannot enter another firm's queue.
4. Only after the original message and attachment entries are safely stored
   in Postgres/local workspace does the importer delete the R2 copy. The
   imported message remains idempotent by R2 object key.

The sender's email address alone never automatically assigns a live message.
No attachment posts accounting entries; CA review still controls that action.

## Prepare Cloudflare

1. Create a **private**, Standard storage R2 bucket named
   `bharaterp-email-intake`. Do not enable a public bucket URL.
2. Create an R2 API token with **Object Read & Write** permission scoped to
   this bucket. Store the Access Key ID and Secret Access Key in `app/.env`.
3. Set the Worker's `FORWARD_TO_EMAIL` secret to the already verified
   destination email address. Do not put that address in source code.
4. From this directory run `npx wrangler deploy`. The `wrangler.toml` lists
   only the two exact test addresses and leaves the main rule unchanged.
5. The test routes are managed by Wrangler. Cloudflare gives exact
   plus-address rules priority over the
   base `inbox@` forwarding rule. Send a message with a small attachment from
   a different account than the forwarding destination, then confirm the R2
   object and forwarded Gmail copy. `bridgecheck` is intentionally not a client
   token, so the local importer holds this message for review. The pilot client
   rule has a known 20-character token; send a dummy attachment there and run
   `npm run email:import` for the complete path. Once end-to-end import works,
   remove the temporary test addresses from
   `wrangler.toml`, redeploy, and edit the existing `inbox@` rule to **Send to
   a Worker**, selecting `bharaterp-email-intake`. Do not create a second
   `inbox@` rule.

## Configure the local app

Set these in `app/.env` (see `app/.env.example`):

```text
CLOUDFLARE_R2_ACCOUNT_ID=<Cloudflare account ID>
CLOUDFLARE_R2_ACCESS_KEY_ID=<bucket-scoped R2 access key>
CLOUDFLARE_R2_SECRET_ACCESS_KEY=<bucket-scoped R2 secret>
CLOUDFLARE_R2_EMAIL_BUCKET=bharaterp-email-intake
EMAIL_INTAKE_DEFAULT_FIRM_ID=<firm UUID only when plain inbox@ should enter that firm>
```

Run `npm run email:import` in `app/` to import once. With all R2 variables
present, `npm run web` also polls automatically while the app is running.
The app remains bound to localhost; R2 is the bridge while the PC is off.
Leave `EMAIL_INTAKE_DEFAULT_FIRM_ID` blank during the exact-address pilot test;
the 20-character recipient token selects its firm without a default.

## Limits and recovery

The importer accepts raw messages up to 8 MB, at most five attachments, and
at most 5 MB of attachments total. Larger or malformed messages stay in R2;
the Gmail copy remains available for manual handling. Failed imports are
reported by key, and rerunning is safe. Monitor failures and bucket usage.
An account-wide multi-firm unassigned queue is still needed before routing
unidentified mail for multiple CA firms.

Cloudflare references: [Email Workers](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/), [R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 S3 access](https://developers.cloudflare.com/r2/get-started/s3/).
