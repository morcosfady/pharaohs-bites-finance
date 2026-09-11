# WhatsApp: what is automatic today, and how to go further

## What the first version does (and does not) do

**Automatic today:** every website order is written to the finance database
*before* WhatsApp opens. The dashboard shows it immediately as
**Pending WhatsApp Confirmation** with its `PB-YYYY-NNNNN` number, and the
number appears in the message the customer sends you.

**Not automatic:** the dashboard cannot see whether the customer actually
pressed *Send* in WhatsApp, and it cannot read your replies. You move the
order from *Pending* to *Contacted / Confirmed / …* yourself.

### Why an ordinary WhatsApp Business app cannot notify the website

The WhatsApp / WhatsApp Business phone apps have no outbound "webhook".
Nothing on the phone can call a URL when a message arrives, and Meta does
not expose an API for the consumer/Business *apps*. The `wa.me` link the
website uses only pre-fills a message on the customer's phone; it never
tells the website anything back.

Incoming-message automation requires the **WhatsApp Cloud API** (Meta's
hosted Business Platform API): a Meta Business account, a verified
business, a phone number registered to the Cloud API (that number can no
longer be used in the normal WhatsApp Business app), and a public HTTPS
webhook endpoint.

## What would be needed for the Cloud API phase

1. Meta Business Manager account + business verification.
2. A WhatsApp Business Account (WABA) in Meta and a phone number
   registered to the Cloud API. `+1 787-968-4078` would have to be migrated
   (the app-based chat history does not carry over automatically).
3. A **permanent system-user access token** with `whatsapp_business_messaging`
   and `whatsapp_business_management` permissions.
4. A **webhook verify token** (any secret string you choose).
5. Optionally the **app secret**, to validate `X-Hub-Signature-256` on every
   webhook call.

### Where the code goes

```
supabase/functions/whatsapp-webhook/index.ts    <- new Edge Function (public URL)
```

Set it up with `verify_jwt = false` in `supabase/config.toml` (Meta cannot send
a Supabase JWT) and validate the Meta signature instead.

### How verification works

Meta first calls the URL with `GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`.
The function compares `hub.verify_token` with the secret you configured and,
if it matches, responds with the plain `hub.challenge` value and HTTP 200.
Only then will Meta deliver messages.

### How an incoming message would update an order

Meta POSTs JSON containing `entry[].changes[].value.messages[]` with the
sender's phone (`from`, E.164 digits) and the text body. The function would:

1. Verify `X-Hub-Signature-256` using the app secret.
2. Look for an order number in the text (`/PB-\d{4}-\d{5}/`). If found, load
   that order; otherwise match the newest `pending_whatsapp_confirmation`
   order whose `customer_phone` digits equal `from`.
3. If the order is still *pending*, set `status = 'contacted'` (the
   `orders_before_update` trigger records the status history). A reply that
   contains an agreed keyword (e.g. "CONFIRM") could set `confirmed`.
4. Insert a row in `audit_logs` with the raw message id for traceability.
5. Return 200 quickly (Meta retries on non-2xx).

Outbound confirmations (your delivery-fee message) would use
`POST https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>/messages` with the
access token, replacing the manual "WhatsApp customer" button.

### Secrets and where they live

| Secret | Where |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | `supabase secrets set ...` (Edge Function env) |
| `WHATSAPP_VERIFY_TOKEN` | `supabase secrets set ...` |
| `WHATSAPP_APP_SECRET` | `supabase secrets set ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | injected by Supabase into Edge Functions automatically |

None of these may appear in this repository, in the customer website, or in
the dashboard bundle. Anything shipped to GitHub Pages is downloadable by
anyone; a leaked access token lets a stranger send messages as your
business, and a leaked service-role key bypasses every database security
rule.

Until this phase is built **and tested end to end**, the dashboard must not
claim that incoming WhatsApp messages are synchronised, and it does not.
