// Build Gemini request — the Code node that turns a validated lead into the body of a
// generateContent call.
//
// PROMPT and SCHEMA are placeholders: scripts/build.mjs replaces them with
// prompts/qualify.md and prompts/qualify.schema.json when it writes the workflow, so the
// prompt has one source and is reviewed as a text file, not as an escaped JSON string.

const PROMPT = "__PROMPT__";
const SCHEMA = "__SCHEMA__";

function geminiRequest(lead, prompt = PROMPT, schema = SCHEMA) {
  return {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(lead, null, 2) }] }],
    generationConfig: {
      // Low, not zero: the reply draft should not read like a form letter, the fields
      // should not change between two runs of the same lead.
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: typeof schema === "string" ? JSON.parse(schema) : schema,
    },
  };
}

/* @n8n — uncommented by scripts/build.mjs; runs once per lead, where $json exists
return { json: { request: geminiRequest($json.lead) } };
@end */

module.exports = { geminiRequest };
