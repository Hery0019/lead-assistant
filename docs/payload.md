# The webhook contract

What the portfolio's Worker sends to n8n, once the contact form has passed its own
checks (honeypot, time trap, rate limit, Turnstile) and the mail has gone out.

## Request

```
POST {N8N_URL}/webhook/lead
Content-Type: application/json
X-Lead-Token: <shared secret>
```

`X-Lead-Token` is the only thing standing between the public internet and the
workflow once n8n is reachable through a tunnel. The Worker holds it as a secret; n8n
holds it as a *Header Auth* credential on the Webhook node. A request without it, or
with the wrong one, gets `403` and never reaches the LLM.

## Body

The form fields as the visitor sent them — option labels are in the visitor's language,
which is exactly why the LLM, not a lookup table, reads them.

| Field | Type | Required | Notes |
|---|---|---|---|
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

Captcha tokens, `renderedAt`, `botcheck` and the mail subject are **not** forwarded:
they mean something to the Worker only.

## Response

| Status | Body | When |
|---|---|---|
| `202` | `{ "ok": true, "lead": "<id>" }` | Accepted; the rest runs asynchronously |
| `400` | `{ "ok": false, "error": "missing_fields", "fields": [...] }` | A required field is empty |
| `403` | — | Missing or wrong `X-Lead-Token` (answered by n8n itself) |

The Worker does not wait on anything past the `202` and ignores any failure: the
visitor's answer never depends on n8n being up.

## Samples

[`samples/`](../samples) holds requests to replay against a running instance:

- `lead-fr.json` — a clear, well-scoped project in French
- `lead-en.json` — an AI integration request in English
- `lead-vague.json` — a one-line message with no budget, to see how the score drops
