# lead-assistant

An n8n automation that reads every message sent through the contact form of
[imhery.dev](https://imhery.dev), qualifies it with an LLM, drafts a reply in the
visitor's language, files the lead in a Notion CRM and asks me on Telegram what to do
with it.

Runs on **n8n Community Edition, self-hosted** — free, no n8n Cloud subscription — and
on free tiers only (Gemini API, Telegram Bot API, Notion API).

> Work in progress. The sections below fill in as each step lands.

## How it works

1. The portfolio's Cloudflare Worker sends the mail as it always has, then forwards the
   same form to this n8n webhook. If n8n is down, nothing is lost: the mail already left.
2. n8n checks the shared token and the payload.
3. Gemini qualifies the lead — project type, budget fit, urgency, language, a score —
   and drafts a reply, as structured JSON.
4. The lead lands in a Notion database.
5. A Telegram message gives me the summary and the draft.

## License

MIT — see [LICENSE](LICENSE).
