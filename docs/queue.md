# The queue contract

How a lead travels from the portfolio's contact form to n8n.

The Worker does **not** call n8n. It keeps each lead in a queue, and n8n comes to
collect them every 5 minutes. So n8n can run on a PC that is not always on: whatever
arrives while it is off waits in the queue and is handled at the next run. Nothing on
the PC is exposed to the internet — n8n only makes outgoing requests.

```
form ──► Worker ──► mail (as before)
           │
           └──► queue (Cloudflare KV)  ◄── every 5 min ──  n8n
                                         GET  /api/leads/pending
                                         POST /api/leads/ack
```

## 1. The Worker queues the lead

Once the form has passed its own checks (honeypot, time trap, rate limit, Turnstile)
and the mail has gone out, the Worker writes the lead to KV:

- **key** `lead:<receivedAt>:<random>` — KV lists keys in order, so the oldest lead
  comes first
- **value** the lead (fields below), plus `id`, which is the key itself
- **expiration** 30 days — a lead nobody collected in a month is dropped, not kept
  forever

If the KV write fails, the visitor's answer does not change: the mail already left.

## 2. n8n collects

```
GET {LEADS_API_BASE}/api/leads/pending?limit=10
Authorization: Bearer <LEADS_API_TOKEN>
```

```json
{ "leads": [ { "id": "lead:2026-09-30T08:30:00.000Z:k3j9", "receivedAt": "...", "name": "...", ... } ] }
```

Oldest first, at most `limit` (default 10, max 50). An empty queue is `{ "leads": [] }`
and the run ends there.

## 3. n8n acknowledges

After a lead is filed in Notion — or found invalid — n8n removes it:

```
POST {LEADS_API_BASE}/api/leads/ack
Authorization: Bearer <LEADS_API_TOKEN>
Content-Type: application/json

{ "ids": ["lead:2026-09-30T08:30:00.000Z:k3j9"] }
```

→ `{ "ok": true, "deleted": 1 }`

A lead is acknowledged only once Notion has it. If Notion is down, the run fails before
the ack and the lead is picked up again 5 minutes later. If Gemini fails, the lead is
still filed — marked "qualification incomplète" — and acknowledged, so one bad lead can
never block the queue. A failed Telegram message does not stop the ack either: the lead
is safe in Notion.

Both endpoints answer `401` without the right token. The token is a long random string
held as a secret by the Worker and as a *Header Auth* credential by n8n.

## Lead fields

The form fields as the visitor sent them — option labels are in the visitor's language,
which is exactly why the LLM, not a lookup table, reads them.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The KV key, set by the Worker |
| `receivedAt` | ISO 8601 string | yes | Set by the Worker, not the browser |
| `name` | string | yes | |
| `email` | string | yes | Not validated beyond "looks like an address" |
| `message` | string | yes | Free text, up to the Worker's body limit |
| `source` | string | yes | How they found the site: "LinkedIn", "Recommandation"… |
| `service` | string | no | One of the form's project types, in FR or EN |
| `otherService` | string | no | Only when `service` is "Other" / "Autre" |
| `budget` | string | no | A range label: "3 000 – 6 000 €", "Under $1,000"… |
| `deadline` | `YYYY-MM-DD` | no | |
| `company` | string | no | |
| `phone` | string | no | |
| `features` | string | no | Comma-separated slugs: `design, seo, multilingual` |
| `other` | string | no | Anything else they wanted to add |

Captcha tokens, `renderedAt`, `botcheck` and the mail subject are **not** queued: they
mean something to the Worker only.

## Free-tier budget

Cloudflare KV on the free plan allows 1,000 writes, 1,000 deletes, 1,000 lists and
100,000 reads a day. Polling every 5 minutes is 288 lists a day; each lead costs one
write and one delete. A portfolio's contact form stays far below all of them.

## Samples

[`samples/`](../samples) holds leads to replay:

- `lead-fr.json` — a clear, well-scoped project in French
- `lead-en.json` — an AI integration request in English
- `lead-vague.json` — a one-line message with no budget, to see how the score drops
