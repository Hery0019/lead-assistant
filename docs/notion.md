# The Notion database

One database, one row per lead. Create it once, share it with the integration, put its
id in `NOTION_DATABASE_ID`.

## Properties

Names and types must match exactly — `src/notion.js` writes to them by name.

| Property | Type | Filled with |
|---|---|---|
| `Name` | Title | Visitor's name |
| `Email` | Email | |
| `Company` | Text | |
| `Phone` | Phone | |
| `Score` | Number | 0–100, from Gemini |
| `Status` | Select | `Nouveau` or `Spam` — then yours: `Répondu`, `Devis envoyé`, `Gagné`, `Perdu` |
| `Type` | Select | Site vitrine, E-commerce, Application web, API, IA & automatisation, Architecture, Excel → application, Autre |
| `Budget given` | Text | The range they picked, as they saw it |
| `Budget fit` | Select | Réaliste, Serré, Irréaliste, Non précisé |
| `Urgency` | Select | Faible, Normale, Haute |
| `Language` | Select | fr, en, mg, other |
| `Source` | Select | How they found the site |
| `Summary` | Text | One sentence, in French |
| `Received` | Date | When the form was sent |
| `Deadline` | Date | Their date, when they gave one |

Select options do not need to exist beforehand: Notion creates a missing one on the
first write.

## Page body

Message, extra details, ticked features, why the score, what to ask, and the reply
draft — ready to copy into a mail.

## Setup

1. <https://www.notion.so/my-integrations> → **New integration** → internal, *Insert
   content* capability. Copy the token: it goes into the n8n credential, not `.env`.
2. Create the database with the properties above.
3. On the database: **⋯ → Connections → Add** the integration.
4. The id is the 32 characters after the workspace name and before `?v=` in the
   database URL.

Suggested views: a board by `Status`, a table sorted by `Score` descending and
filtered on `Status = Nouveau`.
