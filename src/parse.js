// Read qualification — the Code node after the Gemini call.
//
// Pulls the JSON out of the response, checks every field against what the schema
// promised and falls back to safe values instead of letting one odd answer stop the
// run: a lead with a wrong enum is still a lead, and it still has to reach Hery.

const ENUMS = {
  language: ["fr", "en", "mg", "other"],
  projectType: ["showcase", "ecommerce", "webapp", "api", "ai_automation", "architecture", "excel_to_app", "other"],
  budgetFit: ["realistic", "tight", "unrealistic", "unknown"],
  urgency: ["low", "normal", "high"],
};

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function strings(value, max) {
  return Array.isArray(value) ? value.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, max) : [];
}

function readQualification(response) {
  // The HTTP node continues on error: after its retries, a failed call arrives here as
  // { error: ... } instead of stopping the run.
  if (response?.error) return { ...fallback(), error: "gemini_request_failed" };
  const text = response?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // Blocked by a safety filter, truncated, or not JSON: say so, keep going.
    const reason = response?.candidates?.[0]?.finishReason || response?.promptFeedback?.blockReason || "unreadable";
    return { ...fallback(), error: `gemini_${String(reason).toLowerCase()}` };
  }
  const score = Math.round(Number(raw.score));
  return {
    language: pick(raw.language, ENUMS.language, "other"),
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    projectType: pick(raw.projectType, ENUMS.projectType, "other"),
    budgetFit: pick(raw.budgetFit, ENUMS.budgetFit, "unknown"),
    urgency: pick(raw.urgency, ENUMS.urgency, "normal"),
    score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
    scoreReasons: strings(raw.scoreReasons, 3),
    missingInfo: strings(raw.missingInfo, 6),
    isSpam: raw.isSpam === true,
    replySubject: typeof raw.replySubject === "string" ? raw.replySubject.trim() : "",
    replyDraft: typeof raw.replyDraft === "string" ? raw.replyDraft.trim() : "",
    // Which model of the GEMINI_MODELS chain answered — Gemini names it in every reply.
    model: typeof response.modelVersion === "string" ? response.modelVersion : null,
    error: null,
  };
}

function fallback() {
  return {
    language: "other", summary: "", projectType: "other", budgetFit: "unknown", urgency: "normal",
    score: 0, scoreReasons: [], missingInfo: [], isSpam: false, replySubject: "", replyDraft: "", model: null,
  };
}

/* @n8n — uncommented by scripts/build.mjs; runs once per lead, where $json and $() exist
// $json is Gemini's answer — or, when the call failed after its retries, the error
// n8n passes on (the node continues on error). Either way the lead goes on.
const { id, lead } = $("Validate").item.json;
return { json: { id, lead, qualification: readQualification($json) } };
@end */

module.exports = { readQualification };
