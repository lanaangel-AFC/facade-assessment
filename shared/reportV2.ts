// Report v2 (Stage 1) — standard content shared by client and server.
// Projects with reportVersion >= 2 use these; older projects keep the legacy layout.

export const REPORT_VERSION_CURRENT = 2;

export const isV2 = (p: { reportVersion?: number | null } | null | undefined) => (p?.reportVersion ?? 1) >= 2;

// ---------- Assessment type & title ----------

export const ASSESSMENT_TYPES = [
  { key: "condition", label: "Façade condition assessment" },
  { key: "due_diligence", label: "Façade due diligence assessment" },
] as const;

export const REPORT_TITLES: Record<string, string[]> = {
  condition: ["FAÇADE CONDITION ASSESSMENT REPORT"],
  due_diligence: ["FACADE DUE DILIGENCE REPORT", "TECHNICAL DUE DILIGENCE REPORT - FACADE"],
};

export function defaultTitleFor(type: string | null | undefined): string {
  return (REPORT_TITLES[type || "condition"] || REPORT_TITLES.condition)[0];
}

export function reportTitleOf(p: { reportTitle?: string | null; assessmentType?: string | null }): string {
  return (p.reportTitle || "").trim() || defaultTitleFor(p.assessmentType);
}

/** Phrase used by AI prompts and fallback text, e.g. "a condition assessment". */
export function assessmentPhrase(type: string | null | undefined): string {
  return type === "due_diligence" ? "a façade due diligence assessment" : "a condition assessment";
}

// ---------- 2.3 Background information ----------

export const REFERENCES_INTRO_PRESETS = [
  "No structural, architectural and/or facade drawings were furnished prior to the time of our inspection. The following information was provided subsequently and referred to during the preparation of this report:",
  "Elevation drawings were furnished to us prior to our inspection:",
  "Several reports were furnished to us prior to the time of our inspection. The following information was referred to during the preparation of this report:",
  "No structural, architectural and/or facade drawings were furnished for AFC review.",
];

// ---------- 2.4 Limitations ----------

export interface Limitation {
  text: string;
  subs: string[];
}

export const STANDARD_LIMITATIONS: Limitation[] = [
  { text: "The extent of our assessment is limited to the external surfaces and internal areas of the building unless otherwise noted within this report.", subs: [] },
  {
    text: "Visual inspection of the facade was undertaken at safely accessible areas only:",
    subs: [
      "We focused on those areas we understood to be leaking: refer elevation mark ups",
      "We covered approximately [30%] of all major construction materials and configurations at close quarters.",
    ],
  },
  { text: "No materials sampling or testing, destructive investigations, water testing or structural analysis of the existing facade systems has been carried out by AFC.", subs: [] },
  { text: "By virtue of the scope and scale of this work, AFC can’t make comment on any possible structural inadequacies of the facade design, fabrication or installation.", subs: [] },
  { text: "Our inspection will not allow assessment of other aspects of façade performance such as acoustics, building sealing, damp and weatherproofing or solar/thermal performance.", subs: [] },
  { text: "This report has been prepared for the exclusive use of the nominated Client and shall therefore not be relied upon by any third party without their express written consent.", subs: [] },
  {
    text: "Cost estimates and budgets:",
    subs: [
      "Angel Facade Consulting is not a qualified quantity surveyor.",
      "Any budgetary figures presented in this report are provided as indicative guidance only and should not be relied upon as accurate or firm estimates. These figures may be materially incorrect and are intended solely to support conceptual discussion.",
      "Should firm budgetary certainty be required for decision-making or procurement, the Client is advised to engage a qualified quantity surveyor or obtain quotes directly from contractors with full scope definition.",
    ],
  },
];

/** Accepts legacy string[] or v2 Limitation[] JSON. */
export function parseLimitations(raw: string | null | undefined): Limitation[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => (typeof x === "string" ? { text: x, subs: [] } : { text: x?.text || "", subs: Array.isArray(x?.subs) ? x.subs : [] }));
  } catch {
    return [];
  }
}

/** Square brackets mark editable values in the app; they are removed on export. */
export const stripBrackets = (s: string) => s.replace(/\[([^\]]*)\]/g, "$1");

// ---------- Works BUDGET timeframes ----------

export const TIMEFRAMES = ["Immediate", "Within 1 year", "Within 5 years", "Longer term", "Ongoing"] as const;

/** Ranking used for sorting / "now to 1 year" selection. Legacy values are mapped. */
export function timeframeRank(t: string | null | undefined): number {
  const s = (t || "").toLowerCase().trim();
  if (!s) return 9;
  if (/immediate|^now$|urgent|3 months|prior to leasing/.test(s)) return 0;
  if (/within 1 year|^1 year|12 months|now to 1/.test(s)) return 1;
  if (/2 years|within 5 years|^5 years|now to 5/.test(s)) return 2;
  if (/longer|10 years/.test(s)) return 3;
  if (/ongoing/.test(s)) return 4;
  return 5;
}

export const isWithinOneYear = (t: string | null | undefined) => timeframeRank(t) <= 1;

export const TIMEFRAME_GROUP_LABELS = ["Immediate", "Within 1 year", "Within 5 years", "Longer term", "Ongoing", "Other"];

/** Upper value of a free-text budget ("$5,000-$10,000" → 10000; "Allow $10,000pa" → 10000; "NA" → null). */
export function parseBudget(b: string | null | undefined): number | null {
  const s = (b || "").replace(/,/g, "");
  const nums = Array.from(s.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/gi)).map(m => {
    let v = parseFloat(m[1]);
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k") v *= 1000;
    if (unit === "m") v *= 1000000;
    return v;
  }).filter(v => v >= 100); // ignore stray small numbers (e.g. "Level 3")
  return nums.length ? Math.max(...nums) : null;
}

/** Lower and upper value of a free-text budget ("$5,000-$10,000" → [5000,10000]; "$5,000" → [5000,5000]). */
export function parseBudgetRange(b: string | null | undefined): [number, number] | null {
  const s = (b || "").replace(/,/g, "");
  const nums = Array.from(s.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/gi)).map(m => {
    let v = parseFloat(m[1]);
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k") v *= 1000;
    if (unit === "m") v *= 1000000;
    return v;
  }).filter(v => v >= 100);
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}

export const formatMoney = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
