// French labels for the enums of prompts/qualify.schema.json — shared by the Notion
// page and the Telegram message. The build inlines this file into both Code nodes.

const TYPE_LABELS = {
  showcase: "Site vitrine", ecommerce: "E-commerce", webapp: "Application web", api: "API",
  ai_automation: "IA & automatisation", architecture: "Architecture", excel_to_app: "Excel → application", other: "Autre",
};
const BUDGET_LABELS = { realistic: "Réaliste", tight: "Serré", unrealistic: "Irréaliste", unknown: "Non précisé" };
const URGENCY_LABELS = { low: "Faible", normal: "Normale", high: "Haute" };

module.exports = { TYPE_LABELS, BUDGET_LABELS, URGENCY_LABELS };
