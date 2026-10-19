// Inspection matrix — structured record of who inspected, when, how and where.
// Shared by the client (editing + live preview) and the server (Word export
// section 2.2 and AI prompt context). Text generation is deterministic (no AI)
// so the same inputs always produce the same AFC-style wording.

export interface AccessMethodDef {
  key: string;
  label: string;          // shown in the dropdown
  phrase: string;         // used in the "inspection covered" sentence
  accessWord: string;     // used in the "facades were accessed via ..." sentence
  unit: string;           // plural extent unit ("" = no extent)
  unitSingular: string;
  isFacadeAccess: boolean; // true = specialist facade access (abseil, BMU...)
}

export const ACCESS_METHODS: AccessMethodDef[] = [
  { key: "abseil", label: "Abseil", phrase: "via abseil", accessWord: "abseil", unit: "drops", unitSingular: "drop", isFacadeAccess: true },
  { key: "bmu", label: "BMU", phrase: "via the building maintenance unit (BMU)", accessWord: "BMU", unit: "drops", unitSingular: "drop", isFacadeAccess: true },
  { key: "swing_stage", label: "Swing stage", phrase: "via swing stage", accessWord: "swing stage", unit: "drops", unitSingular: "drop", isFacadeAccess: true },
  { key: "ewp", label: "EWP", phrase: "via elevating work platform (EWP)", accessWord: "EWP", unit: "locations", unitSingular: "location", isFacadeAccess: true },
  // On foot: the extent lists the areas, separated by ";" (e.g. "roofs; balconies at Levels 3 and 5")
  { key: "on_foot", label: "On foot", phrase: "on foot", accessWord: "on foot", unit: "areas", unitSingular: "area", isFacadeAccess: false },
  { key: "vantage", label: "Vantage points", phrase: "from vantage points", accessWord: "vantage points", unit: "", unitSingular: "", isFacadeAccess: false },
];

/** Stored value → report wording. Legacy full-text values are accepted as-is. */
export const INSPECTION_TYPES = [
  { key: "visual_tactile", label: "Visual tactile", phrase: "Visual tactile inspection" },
  { key: "visual", label: "Visual only", phrase: "Visual inspection" },
] as const;

export const inspectionTypePhrase = (v: string | null | undefined) =>
  INSPECTION_TYPES.find(t => t.key === v)?.phrase || (v && v.trim()) || "Visual inspection";

export const STANDARD_AREAS = [
  "Façade",
  "Tower façade",
  "Podium façade",
  "Roof",
  "Plant and roof areas",
  "Terraces",
  "Balconies",
  "Awnings",
  "Internal areas",
  "Ground level areas",
  "Basement",
];

export const ASSISTED_BY_PRESETS = [
  "a rope access contractor",
  "a rope access technician",
  "a BMU driver",
  "the Facility Manager",
  "site security",
];

export const DEFAULT_INSPECTOR = "Lana Angel";

export interface InspectionRow {
  id: string;
  day: string;            // "" or "1", "2", ...
  area: string;           // free text, suggested from STANDARD_AREAS
  method: string;         // ACCESS_METHODS key
  extent: string;         // e.g. "6" or "5 full-height"; unit appended automatically
  inspectionType: string; // one of INSPECTION_TYPES
  notes: string;          // one sub-point per line (e.g. "Pin locations 4, 9, 11, 17 and 22")
}

export interface InspectionMatrix {
  startDate: string;      // YYYY-MM-DD
  finishDate: string;     // YYYY-MM-DD or ""
  daysOnSite: string;     // "" = derive from date range
  inspectors: string[];
  assistedBy: string[];
  rows: InspectionRow[];
}

export const emptyMatrix = (): InspectionMatrix => ({
  startDate: "", finishDate: "", daysOnSite: "", inspectors: [], assistedBy: [], rows: [],
});

export function parseMatrix(raw: string | null | undefined): InspectionMatrix | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object") return null;
    return {
      ...emptyMatrix(),
      ...m,
      inspectors: Array.isArray(m.inspectors) ? m.inspectors.filter(Boolean) : [],
      assistedBy: Array.isArray(m.assistedBy) ? m.assistedBy.filter((s: string) => s && s.trim()) : [],
      rows: Array.isArray(m.rows) ? m.rows : [],
    };
  } catch {
    return null;
  }
}

/** True when the matrix holds enough to replace the legacy 2.2 export. */
export function matrixHasContent(m: InspectionMatrix | null): m is InspectionMatrix {
  return !!m && (!!m.startDate || m.inspectors.length > 0 || m.rows.length > 0);
}

export const getMethod = (key: string) => ACCESS_METHODS.find(m => m.key === key);

// ---------- text helpers ----------

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const NUM_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];

function parseISO(d: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

const fmt = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

export function joinList(items: string[]): string {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || "";
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

function capitalise(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function lowerFirst(s: string) {
  // keep acronyms / proper nouns ("BMU", "Level 3") intact
  if (!s) return s;
  if (/^[A-Z]{2,}/.test(s) || /^Level\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "on 11 September 2026" | "over two days, being 15-16 June 2026" | "over 3 days between 11 February and 10 March 2026" */
export function describeDates(m: InspectionMatrix): string {
  const s = parseISO(m.startDate);
  if (!s) return "";
  const f = parseISO(m.finishDate);
  if (!f || f.getTime() <= s.getTime()) return `on ${fmt(s)}`;
  const span = Math.round((f.getTime() - s.getTime()) / 86400000) + 1;
  const days = parseInt(m.daysOnSite, 10) > 0 ? parseInt(m.daysOnSite, 10) : span;
  const dayWord = days <= 10 ? NUM_WORDS[days] : String(days);
  const sameMonth = s.getUTCMonth() === f.getUTCMonth() && s.getUTCFullYear() === f.getUTCFullYear();
  if (days === span && sameMonth) {
    return `over ${dayWord} days, being ${s.getUTCDate()}-${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]} ${f.getUTCFullYear()}`;
  }
  const startText = s.getUTCFullYear() === f.getUTCFullYear()
    ? `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}`
    : fmt(s);
  return `over ${dayWord} days between ${startText} and ${fmt(f)}`;
}

export function describeExtent(row: InspectionRow): string {
  const def = getMethod(row.method);
  const ext = (row.extent || "").trim();
  if (!ext) return "";
  if (!def || !def.unit || def.key === "on_foot") return ext;
  // Already contains the unit word? leave as typed.
  if (new RegExp(`\\b(${def.unit}|${def.unitSingular})\\b`, "i").test(ext)) return ext;
  const isOne = /^1(\s|$)/.test(ext) || /^one(\s|$)/i.test(ext);
  return `${ext} ${isOne ? def.unitSingular : def.unit}`;
}

export interface CoveredItem { text: string; subPoints: string[] }

export interface InspectionText {
  opening: string;            // "The inspection was carried out ... of AFC with the assistance of ..."
  accessIntro: string;        // "The facades were accessed as follows:" or a single sentence
  accessDays: string[];       // "Day 1: BMU", ... (empty when no day split)
  accessClosing: string;      // "All other areas were accessed on foot." or ""
  coveredIntro: string;       // "The inspection covered:"
  covered: CoveredItem[];
}

export function buildRowSentence(row: InspectionRow, opts: { omitOnFoot?: boolean } = {}): string {
  const def = getMethod(row.method);
  const type = inspectionTypePhrase(row.inspectionType);
  const rawArea = (row.area || "").trim();
  const area = lowerFirst(rawArea);
  const extent = describeExtent(row);

  if (def?.key === "on_foot") {
    // "Visual inspection of areas accessible on foot" when no area is named (35 Clarence St style)
    let s = area
      ? `${type} of ${/^(the|all|parts|level|ground|internal|areas)\b/i.test(area) ? area : `the ${area}`}`
      : `${type} of areas accessible on foot`;
    if (/internal/i.test(rawArea)) s += ", where access was provided";
    else if (area && !opts.omitOnFoot) s += " on foot";
    return s;
  }

  const areaText = !area ? "the façade" : /^(the|all|parts|level|ground|internal)\b/i.test(area) ? area : `the ${area}`;
  let s = `${type} of ${areaText}`;
  if (def) s += extent ? ` ${def.phrase} in ${extent}` : ` ${def.phrase}`;
  else if (extent) s += ` in ${extent}`;
  return s;
}

export function buildInspectionText(m: InspectionMatrix): InspectionText {
  const dateText = describeDates(m);
  const who = m.inspectors.length > 0 ? `by ${joinList(m.inspectors)} of AFC` : "by AFC";
  const assist = m.assistedBy.length > 0 ? ` with the assistance of ${joinList(m.assistedBy.map(a => a.trim()))}` : "";
  const opening = `The inspection was carried out${dateText ? " " + dateText : ""} ${who}${assist}.`;

  const rows = m.rows.filter(r => r.area?.trim() || r.method);
  const facadeRows = rows.filter(r => getMethod(r.method)?.isFacadeAccess);
  const otherRows = rows.filter(r => !getMethod(r.method)?.isFacadeAccess);

  // Distinct specialist access methods, in first-used order, per day if given.
  const distinct = (rs: InspectionRow[]) => Array.from(new Set(rs.map(r => getMethod(r.method)!.accessWord)));
  const withDays = facadeRows.filter(r => r.day);
  let accessIntro = "";
  let accessDays: string[] = [];
  if (facadeRows.length > 0) {
    if (withDays.length > 0) {
      const days = Array.from(new Set(withDays.map(r => r.day))).sort((a, b) => Number(a) - Number(b));
      accessIntro = "The facades were accessed as follows:";
      accessDays = days.map(d => `Day ${d}: ${capitalise(joinList(distinct(withDays.filter(r => r.day === d))))}`);
      const undated = facadeRows.filter(r => !r.day);
      if (undated.length > 0) accessDays.push(capitalise(joinList(distinct(undated))));
    } else {
      accessIntro = `The facades were accessed via ${joinList(distinct(facadeRows))}.`;
    }
  }
  let accessClosing = "";
  if (otherRows.some(r => r.method === "on_foot")) {
    accessClosing = facadeRows.length > 0 ? "All other areas were accessed on foot." : "All areas were accessed on foot.";
  }

  const omitOnFoot = !!accessClosing;
  const covered: CoveredItem[] = rows.map((r, i) => {
    const lines = (r.notes || "").split(/\r?\n/).map(x => x.trim().replace(/[.;]$/, "")).filter(Boolean);
    // "Refer plan" style notes become an inline bracket, as in AFC reports: "... in 6 drops (refer roof plan)"
    const refers = lines.filter(l => /^\(?refer\b/i.test(l)).map(l => l.replace(/^\(|\)$/g, "").replace(/^Refer/, "refer"));
    const subs = lines.filter(l => !/^\(?refer\b/i.test(l));
    let text = buildRowSentence(r, { omitOnFoot });
    if (r.method === "on_foot" && (r.extent || "").trim()) {
      const areas = r.extent.split(/;|\n/).map(x => x.trim().replace(/\.$/, "")).filter(Boolean);
      if (areas.length === 1 && (r.area || "").trim()) text += ` (${areas[0]})`;
      else subs.unshift(...areas.map(x => x.charAt(0).toUpperCase() + x.slice(1)));
    }
    if (refers.length) text += ` (${refers.join("; ")})`;
    const isLast = i === rows.length - 1;
    // Punctuation: ":" before sub-points, "." on the final item / final sub-point.
    if (subs.length) text += ":";
    else if (isLast) text += ".";
    const subPoints = subs.map((sp, j) => (isLast && j === subs.length - 1 ? `${sp}.` : sp));
    return { text, subPoints };
  });

  return {
    opening,
    accessIntro,
    accessDays,
    accessClosing,
    coveredIntro: covered.length > 0 ? "The inspection covered:" : "",
    covered,
  };
}

/** Plain-text rendering — used for the in-app preview and AI prompt context. */
export function inspectionTextToPlain(t: InspectionText): string {
  const lines: string[] = [t.opening];
  if (t.accessIntro) lines.push(t.accessIntro);
  for (const d of t.accessDays) lines.push(`  • ${d}`);
  if (t.accessClosing) lines.push(t.accessClosing);
  if (t.coveredIntro) {
    lines.push("", t.coveredIntro);
    t.covered.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.text}`);
      c.subPoints.forEach((s, j) => lines.push(`   ${String.fromCharCode(97 + j)}. ${s}`));
    });
  }
  return lines.join("\n");
}

/** Dates as ISO strings for legacy fields (inspectionDates). */
export function matrixDates(m: InspectionMatrix): string[] {
  return [m.startDate, m.finishDate].filter((d, i, a) => d && a.indexOf(d) === i);
}
