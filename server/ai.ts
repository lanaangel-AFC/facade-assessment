import OpenAI from "openai";
import { storage, dataDir } from "./storage";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { encode as encodeGpt4o } from "gpt-tokenizer/model/gpt-4o";
import { findSimilarPassages } from "./embeddings";

const MAX_INPUT_TOKENS = 24000;
const PROJECT_CONTEXT_TOKEN_CAP = 1500;
const PROJECT_DOCS_TOKEN_CAP = 4000;
const STYLE_EXEMPLARS_TOKEN_CAP = 4000;
const STYLE_EXEMPLARS_MAX_COUNT = 5;
const IMAGE_TOKEN_BUDGET = 1000;
const MAX_GROUP_PHOTOS = 8;
const MAX_PER_CALL_PHOTOS = 6;
const VISION_MAX_EDGE_PX = 1024;
const LINKED_OBS_TOKEN_CAP = 4000;

// Two style guidance rules added per Lana's feedback (Feature 3). Appended to
// both observation and group narrative system prompts so the model:
//   1. Doesn't repeat the same idea in different words within a narrative.
//   2. Actively looks for contributory causes across observations / photos /
//      text and weaves them into a unified failure mode.
const AFC_NARRATIVE_STYLE_RULES = `
- Avoid repetition of ideas and language within the same narrative. Each idea should appear once, in the strongest place.
- Seek contributory actions from the observations, photographs and text provided, and link them together in the narrative. Where multiple factors share a single failure mechanism, describe how they combine rather than listing them in isolation.`;

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encodeGpt4o(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (!text) return "";
  const toks = countTokens(text);
  if (toks <= maxTokens) return text;
  // Binary-ish search: shrink by character ratio, then refine.
  const ratio = maxTokens / toks;
  let approxChars = Math.max(1, Math.floor(text.length * ratio) - 32);
  let candidate = text.slice(0, approxChars);
  while (countTokens(candidate) > maxTokens && candidate.length > 0) {
    candidate = candidate.slice(0, Math.max(0, candidate.length - 64));
  }
  return candidate.trimEnd() + " …[truncated]";
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/**
 * Wrapper that tries gpt-4o first then falls back to gpt-4o-mini on 429 /
 * "Request too large" / "rate limit" errors. Throws a user-friendly error
 * if the fallback also rate-limits.
 */
async function callOpenAIChat(
  client: OpenAI,
  params: ChatParams
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  try {
    return await client.chat.completions.create(params);
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const message = String(err?.message || err || "");
    const isRateLimit =
      status === 429 ||
      /request too large/i.test(message) ||
      /rate limit/i.test(message);
    if (!isRateLimit) throw err;
    console.warn("[ai] gpt-4o hit 429, retrying with gpt-4o-mini");
    try {
      return await client.chat.completions.create({ ...params, model: "gpt-4o-mini" });
    } catch (err2: any) {
      const status2 = err2?.status ?? err2?.response?.status;
      const message2 = String(err2?.message || err2 || "");
      const isRateLimit2 =
        status2 === 429 ||
        /request too large/i.test(message2) ||
        /rate limit/i.test(message2);
      if (isRateLimit2) {
        throw new Error("AI temporarily rate-limited. Please wait 30 seconds and try again.");
      }
      throw err2;
    }
  }
}

/**
 * Retrieve style exemplars from the user's past AFC reports (RAG).
 * Returns a formatted block to prepend to the system prompt, or "" if library is empty.
 */
async function getStyleExamples(query: string, category: string, topK: number = 2): Promise<string> {
  try {
    // Pull a wider candidate pool, then budget-cap by tokens.
    const fetchK = Math.max(topK, STYLE_EXEMPLARS_MAX_COUNT);
    const passages = await findSimilarPassages(query, category, fetchK);
    if (passages.length === 0) return "";

    const selected: string[] = [];
    let cumulative = 0;
    for (const p of passages) {
      if (selected.length >= STYLE_EXEMPLARS_MAX_COUNT) break;
      const text = (p.text || "").trim();
      if (!text) continue;
      const toks = countTokens(text);
      if (cumulative + toks > STYLE_EXEMPLARS_TOKEN_CAP && selected.length > 0) break;
      selected.push(text);
      cumulative += toks;
      if (cumulative >= STYLE_EXEMPLARS_TOKEN_CAP) break;
    }
    if (selected.length === 0) return "";

    const numbered = selected.map((t, idx) => `${idx + 1}. ${t}`).join("\n\n");

    return `\n\nSTYLE EXEMPLARS from past AFC reports (match this voice, tone, sentence structure, and phrasing. Do not copy verbatim — mimic style only):\n\n${numbered}\n\n---\n`;
  } catch {
    return "";
  }
}

async function getClient(): Promise<OpenAI> {
  const apiKey = await storage.getSetting("openai_api_key");
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Go to Settings to add it.");
  }
  return new OpenAI({ apiKey });
}

/**
 * Build caption+image content-part pairs for OpenAI vision.
 * Each photo gets a "Photo caption: ..." text block IMMEDIATELY BEFORE its image,
 * so the model associates the engineer's on-site context with the correct image.
 */
async function loadResizedImage(filePath: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const buf = await sharp(filePath)
      .rotate()
      .resize({ width: VISION_MAX_EDGE_PX, height: VISION_MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { base64: buf.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    try {
      const imageData = fs.readFileSync(filePath);
      const base64 = imageData.toString("base64");
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return { base64, mimeType };
    } catch {
      return null;
    }
  }
}

async function buildCaptionedImageParts(
  photos: { filename: string; caption?: string | null }[],
  maxPhotos: number = MAX_PER_CALL_PHOTOS
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
  const uploadDir = path.join(dataDir, "uploads");
  // Sort so photos with captions are kept first when capped.
  const sorted = [...photos].sort((a, b) => {
    const aHas = (a.caption || "").trim().length > 0 ? 0 : 1;
    const bHas = (b.caption || "").trim().length > 0 ? 0 : 1;
    return aHas - bHas;
  });
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  let count = 0;
  for (const photo of sorted) {
    if (count >= maxPhotos) break;
    const filePath = path.join(uploadDir, photo.filename);
    if (!fs.existsSync(filePath)) continue;
    const loaded = await loadResizedImage(filePath);
    if (!loaded) continue;
    const caption = (photo.caption || "").trim();
    parts.push({
      type: "text",
      text: `Photo caption: ${caption || "(no caption provided)"}`,
    });
    parts.push({
      type: "image_url",
      image_url: { url: `data:${loaded.mimeType};base64,${loaded.base64}`, detail: "high" },
    });
    count += 1;
  }
  return parts;
}

const CAPTION_GUIDANCE = `Each image is preceded by its caption (provided by the engineer on-site). Read captions as authoritative context — they describe what the engineer observed that may not be visually obvious.`;

function countContentTokens(parts: OpenAI.Chat.Completions.ChatCompletionContentPart[]): {
  textTokens: number;
  imageCount: number;
} {
  let textTokens = 0;
  let imageCount = 0;
  for (const part of parts) {
    if ((part as any).type === "text") {
      textTokens += countTokens((part as any).text || "");
    } else if ((part as any).type === "image_url") {
      imageCount += 1;
    }
  }
  return { textTokens, imageCount };
}

function logTokenBreakdown(label: string, sections: Record<string, number>, imageCount: number) {
  const total = Object.values(sections).reduce((s, v) => s + v, 0) + imageCount * IMAGE_TOKEN_BUDGET;
  const parts = Object.entries(sections)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.debug(`[ai] tokens ${label}: ${parts} photos=${imageCount} total=${total}`);
}

/**
 * Build a PROJECT CONTEXT block to inject into AI prompts.
 * Returns "" if no context is configured for the project.
 */
function buildProjectContextBlock(projectContext: string | null | undefined): string {
  if (!projectContext || !projectContext.trim()) return "";
  const trimmed = truncateToTokens(projectContext.trim(), PROJECT_CONTEXT_TOKEN_CAP);
  return `PROJECT CONTEXT (provided by the engineer — read carefully and weigh when forming recommendations and analysis):

${trimmed}

When relevant, factor this PROJECT CONTEXT into recommendations and analysis. For example, if context mentions imminent works in a particular area, recommend that adjacent or related items be addressed within that scope where reasonable. Do not invent context — only use what is explicitly provided.

---

`;
}

/**
 * Resolve the project context for a given project id. Returns "" if not set
 * or if the lookup fails — callers should be defensive.
 */
async function getProjectContextById(projectId: number | null | undefined): Promise<string> {
  if (!projectId) return "";
  try {
    const project = await storage.getProject(projectId);
    return ((project as any)?.projectContext || "") as string;
  } catch {
    return "";
  }
}

// Token-based caps live as MAX_INPUT_TOKENS / PROJECT_DOCS_TOKEN_CAP constants near the top.

/**
 * Build a "Project Documents" context block from the documents the engineer has
 * uploaded for this project. Documents are presented as factual context — the
 * model is told NOT to cite them inline; they will be listed as Harvard
 * references separately in Section 2.x of the Word export.
 *
 * Prioritisation when total text exceeds PROJECT_DOC_TOTAL_CAP:
 *   1. Most recently uploaded
 *   2. Documents with non-empty notes
 *   3. Smaller documents first
 * Skips docs with status "skipped" or "error" (handled upstream by the storage
 * helper, which only returns status=complete with non-empty text).
 */
async function buildProjectDocumentsBlock(projectId: number | null | undefined): Promise<string> {
  if (!projectId) return "";
  let docs;
  try {
    docs = await storage.getProjectDocumentsForAI(projectId);
  } catch {
    return "";
  }
  if (!docs || docs.length === 0) return "";

  // Score: lower is better. Negative most-recent-uploaded weight is dominant.
  const scored = docs.map((d) => {
    const uploadedAt = Date.parse(d.uploadedAt || "") || 0;
    const hasNotes = (d.notes || "").trim().length > 0;
    const size = (d.extractedText || "").length;
    return { d, uploadedAt, hasNotes, size };
  });
  scored.sort((a, b) => {
    if (b.uploadedAt !== a.uploadedAt) return b.uploadedAt - a.uploadedAt;
    if (a.hasNotes !== b.hasNotes) return a.hasNotes ? -1 : 1;
    return a.size - b.size;
  });

  // Per-doc budget so multiple docs share the cap fairly.
  const perDocBudget = Math.max(
    300,
    Math.floor(PROJECT_DOCS_TOKEN_CAP / Math.max(1, Math.min(scored.length, 4)))
  );

  let totalTokens = 0;
  const sections: string[] = [];
  let included = 0;
  for (const { d } of scored) {
    if (totalTokens >= PROJECT_DOCS_TOKEN_CAP) break;
    const titleStr = (d.title || d.originalName || "Untitled").trim();
    const yearStr = (d.year || "").trim();
    const typeStr = (d.documentType || "").trim();
    const headerBits = [titleStr];
    if (yearStr || typeStr) {
      const meta = [yearStr, typeStr].filter(Boolean).join(", ");
      headerBits.push(`(${meta})`);
    }
    const header = `--- DOCUMENT ${included + 1}: ${headerBits.join(" ")} ---`;
    const remainingBudget = PROJECT_DOCS_TOKEN_CAP - totalTokens;
    const docBudget = Math.min(perDocBudget, remainingBudget);
    const body = truncateToTokens((d.extractedText || "").trim(), docBudget);
    const block = `${header}\n${body}`;
    const blockTokens = countTokens(block);
    if (totalTokens + blockTokens > PROJECT_DOCS_TOKEN_CAP && sections.length > 0) {
      continue;
    }
    sections.push(block);
    totalTokens += blockTokens;
    included += 1;
  }

  if (sections.length === 0) return "";

  return `PROJECT DOCUMENTS PROVIDED BY THE ENGINEER (use as factual context where relevant — do not cite inline; the engineer will reference them separately in Section 2 of the report. Do not invent information that is not in these documents or the project metadata):

${sections.join("\n\n")}

---

`;
}

// Load training data for style calibration
async function getTrainingExamples(outputType: string, limit: number = 3): Promise<string> {
  try {
    const allTraining = await storage.getAllTrainingData();
    const relevant = allTraining
      .filter((t: any) => t.outputType === outputType && t.correctedOutput)
      .slice(-limit);
    if (relevant.length === 0) return "";
    return "\n\nHere are examples of corrected outputs to match in style and tone:\n" +
      relevant.map((t: any) => `---\nInput: ${t.originalPrompt}\nCorrected output: ${t.correctedOutput}`).join("\n");
  } catch {
    return "";
  }
}

export async function identifySystem(photoIds: number[], projectContext: string = "", projectId?: number | null): Promise<{
  systemType: string;
  materials: { name: string; detail: string }[];
  keyFeatures: string[];
  estimatedAge: string;
  visibleConcerns: string[];
}> {
  const client = await getClient();

  const photosToSend: { filename: string; caption?: string | null }[] = [];
  let resolvedContext = projectContext;
  let resolvedProjectId: number | null | undefined = projectId ?? null;
  for (const photoId of photoIds) {
    const photo = await storage.getPhoto(photoId);
    if (!photo) continue;
    photosToSend.push(photo);
    if (!resolvedProjectId) resolvedProjectId = (photo as any).projectId ?? null;
    if (!resolvedContext) {
      resolvedContext = await getProjectContextById((photo as any).projectId);
    }
  }
  const captionedParts = await buildCaptionedImageParts(photosToSend);

  if (captionedParts.length === 0) {
    throw new Error("No valid photos found for analysis.");
  }

  const contextBlock = buildProjectContextBlock(resolvedContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(resolvedProjectId);

  const systemContent = `${contextBlock}${projectDocsBlock}You are an expert facade engineer in Australia. Identify the facade system in the photo(s) concisely.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.

${CAPTION_GUIDANCE}

Report only what is visible. Do not speculate or pad. Use Australian facade engineering terminology.

Respond ONLY with valid JSON:
{
  "systemType": "e.g. stick system curtain wall, window wall, unitised curtain wall, rendered concrete, metal cladding, fibre cement cladding, masonry, glazed shopfront, louvre system",
  "materials": [{"name": "Framing", "detail": "white powdercoated aluminium"}, {"name": "Glazing", "detail": "blue-tinted monolithic, gasket retained"}],
  "keyFeatures": ["e.g. structural silicone retained", "vertical sunshades with perforated steel infill"],
  "estimatedAge": "e.g. circa 2010s based on materials and style",
  "visibleConcerns": ["only list if clearly visible, e.g. gasket shortening at mullion heads"]
}

Keep each field brief. Materials: list only what you can see. Key features: 2-4 items max. Visible concerns: only obvious defects, not speculation.`;

  const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: "Identify the facade system in these photos. Each image below is preceded by its caption from the engineer:" },
    ...captionedParts,
  ];
  const { textTokens: userTextTokens, imageCount } = countContentTokens(userParts);
  logTokenBreakdown("identifySystem", {
    context: countTokens(contextBlock),
    docs: countTokens(projectDocsBlock),
    system: countTokens(systemContent) - countTokens(contextBlock) - countTokens(projectDocsBlock),
    user: userTextTokens,
  }, imageCount);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userParts },
    ],
    max_tokens: 600,
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse AI response.");
  return JSON.parse(jsonMatch[0]);
}

export async function generateSystemDescription(systemId: number): Promise<string> {
  const client = await getClient();
  const system = await storage.getSystem(systemId);
  if (!system) throw new Error("System not found.");

  let materials: { name: string; detail: string }[] = [];
  let keyFeatures: string[] = [];
  let roofTypes: string[] = [];
  try { materials = JSON.parse(system.materials || "[]"); } catch {}
  try { keyFeatures = JSON.parse(system.keyFeatures || "[]"); } catch {}
  try { roofTypes = JSON.parse((system as any).roofTypes || "[]"); } catch {}

  const roofTypesLine = roofTypes.length > 0
    ? `\nRoof Types (as selected by engineer): ${roofTypes.join("; ")}`
    : "";

  const context = `
System Name: ${system.name}
Location on Building: ${system.location}
System Type: ${system.systemType}${roofTypesLine}
Materials: ${materials.map(m => `${m.name}: ${m.detail}`).join("; ") || "Not specified"}
Key Features: ${keyFeatures.join(", ") || "Not specified"}
Estimated Age: ${system.estimatedAge || "Not specified"}
Related Systems: ${system.relatedSystems || "None noted"}
  `.trim();

  // Fetch system photos for vision analysis
  const systemPhotos = await storage.getPhotosBySystem(systemId);
  const imageParts = await buildCaptionedImageParts(systemPhotos);

  const trainingExamples = await getTrainingExamples("system_description");
  const styleQuery = `${system.systemType} ${materials.map(m => m.name + " " + m.detail).join(" ")} ${keyFeatures.join(" ")}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "description", 2);
  const projectContext = await getProjectContextById(system.projectId);
  const contextBlock = buildProjectContextBlock(projectContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(system.projectId);

  const hasPhotos = imageParts.length > 0;
  const systemPrompt = `${contextBlock}${projectDocsBlock}${styleExamples}You are an expert facade engineer writing Section 3.2 (Facade Description) of an Australian facade condition assessment report.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.

${hasPhotos ? CAPTION_GUIDANCE + "\n\n" : ""}STYLE RULES:
- Use a structured numbered/lettered list format, NOT flowing paragraphs.
- Be concise. Elaborate on the information provided by the user, and${hasPhotos ? " use the photos (and the caption accompanying each) to identify additional details about the system (glazing type, retention method, frame finish, cladding material, jointing, etc.)." : " do not invent details not supported by the data."}
- Use Australian facade engineering terminology.

FORMAT — follow this exact structure:
a. [System type and key characteristic, e.g. "Stick system curtain wall with white powdercoated aluminium framing"]
b. [Glazing/infill description, e.g. "Glass is blue-tinted monolithic, gasket retained on four sides"]
   i. [Sub-detail if relevant, e.g. "Fully toughened (FT) spandrels"]
   ii. [Sub-detail if relevant, e.g. "Heat strengthened (HS) visions"]
c. [Additional features, e.g. "Vertically affixed white powdercoated metal sunshades present on north and west elevations"]

EXAMPLE (from a real report):
a. Stick system curtain wall with white powdercoated aluminium framing
b. Glass is blue-tinted monolithic, gasket retained on four sides, with stamps that indicate:
   i. Fully toughened (FT) spandrels
   ii. Heat strengthened (HS) visions
c. Vertically affixed white powdercoated metal sunshades are present on the north and west elevations. Infill panels are perforated steel.

ANOTHER EXAMPLE:
a. Cantilevered precast concrete ledges at slab levels. Some areas are also bordered by vertical concrete fins.
   i. Panel joints are transverse to the direction of the ledge, regularly spaced, and sealed with a polymeric sealant.
   ii. The undersides of the cantilevered ledges have cast in drip grooves.
b. Floor to ceiling glazing assembly comprising three panels: spandrel/vision/spandrel.
   i. All glass is retained on four sides with structural silicone.
   ii. Spandrel glass is monolithic colour-backed heat strengthened (HS).
   iii. Vision panes are insulated glazing units (IGUs).
c. Frames are aluminium with a powdercoated finish.

Keep it to 3-6 lettered items.${hasPhotos ? " Use the photos to supplement the user-provided data — identify visible details like glass type, retention method, frame colour/material, joint types, cladding profiles, etc. that the user may not have noted." : ""} Do not add boilerplate about standards compliance or expected performance.
Return ONLY the description text.${trainingExamples}`;

  // Build the user message content with text and optional photos
  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: `Generate a facade system description based on these details:\n\n${context}${hasPhotos ? "\n\nPhotos of this facade system are attached. Use them to identify additional details not covered in the text above." : ""}` },
    ...imageParts,
  ];

  const { textTokens: userTextTokens, imageCount } = countContentTokens(userContent);
  logTokenBreakdown("generateSystemDescription", {
    context: countTokens(contextBlock),
    docs: countTokens(projectDocsBlock),
    exemplars: countTokens(styleExamples),
    system: countTokens(systemPrompt) - countTokens(contextBlock) - countTokens(projectDocsBlock) - countTokens(styleExamples),
    user: userTextTokens,
  }, imageCount);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: 600,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

/**
 * Build a LINKED OBSERVATIONS context block describing other observations the
 * engineer has flagged as causally related to the one being generated. The
 * model is instructed to weave these into a combined narrative rather than
 * repeating the ideas.
 */
async function buildLinkedObservationsBlock(observationId: number, projectId: number): Promise<string> {
  let linked: any[] = [];
  try {
    linked = await (storage as any).getLinkedObservations(observationId);
  } catch {
    return "";
  }
  if (!linked || linked.length === 0) return "";

  const formatted: string[] = [];
  for (const obs of linked) {
    let indicators: string[] = [];
    try { indicators = JSON.parse(obs.indicators || "[]"); } catch {}
    let captionLines: string[] = [];
    try {
      const photoRows = await storage.getPhotosByObservation(obs.id);
      captionLines = photoRows
        .map((p: any) => (p?.caption || "").trim())
        .filter((c: string) => c.length > 0);
    } catch {}
    // Pull the highest-priority recommendation category, if any, to convey
    // remedial direction without dumping the full rec list.
    let recCategory = "";
    try {
      const recs = await storage.getRecommendationsByObservation(obs.id);
      if (recs.length > 0) recCategory = recs[0].category || "";
    } catch {}
    formatted.push(
      `LINKED OBSERVATION ${obs.observationId || `#${obs.id}`}:
  Location: ${obs.location || "Unspecified"}
  Defect Category: ${obs.defectCategory || "Unspecified"}
  Severity: ${obs.severity || "Unspecified"}
  Extent: ${obs.extent || "Unspecified"}${recCategory ? `\n  Recommendation category: ${recCategory}` : ""}
  Indicators: ${indicators.join(", ") || "None"}
  Field Note: ${obs.fieldNote || "None"}
  Engineer-written narrative: ${(obs.aiNarrative || "").trim() || "None"}${captionLines.length > 0 ? `\n  Photo captions: ${captionLines.join(" | ")}` : ""}`
    );
  }

  const body = formatted.join("\n\n");
  const trimmed = truncateToTokens(body, LINKED_OBS_TOKEN_CAP);

  return `\n\nThe following observations have been identified as CAUSALLY LINKED to this observation. Your narrative MUST weave them together — describe how they contribute to a combined defect or failure mode. Do not repeat ideas across the linked observations; instead, identify each contributing factor and connect them.\n\n${trimmed}\n\n---\n`;
}

export async function generateObservationNarrative(observationId: number, existingNarrative: string = ""): Promise<string> {
  const client = await getClient();
  const observation = await storage.getObservation(observationId);
  if (!observation) throw new Error("Observation not found.");

  let systemName = "Unknown system";
  let systemType = "";
  if (observation.systemId) {
    const system = await storage.getSystem(observation.systemId);
    if (system) {
      systemName = system.name;
      systemType = system.systemType;
    }
  }

  let indicators: string[] = [];
  try { indicators = JSON.parse(observation.indicators || "[]"); } catch {}

  const additionalLocations = await storage.getObservationLocations(observationId);
  const formatLoc = (drop?: string | null, elev?: string | null, level?: string | null) => {
    const parts = [
      drop ? `Drop ${drop}` : "",
      elev ? `${elev} Elevation` : "",
      level ? `L${level}` : "",
    ].filter(Boolean);
    return parts.join(", ");
  };
  const primaryLocLabel = formatLoc((observation as any).gridDrop, (observation as any).gridElevation, (observation as any).gridLevel);
  const multiLocBlock = additionalLocations.length > 0
    ? `\nThis defect was observed at multiple locations across the building. Additional locations:\n${additionalLocations.map((l, i) => {
        const label = formatLoc(l.drop, l.elevation, l.level) || "(unspecified)";
        return `  ${i + 1}. ${label}${l.description ? ` — ${l.description}` : ""}`;
      }).join("\n")}\nWrite the narrative so the reader understands the defect repeats across these locations (e.g. "These defects were observed at multiple locations across the building...").`
    : "";

  const context = `
System: ${systemName} (${systemType})
Observation ID: ${observation.observationId}
Location: ${observation.location}${primaryLocLabel ? ` (Primary: ${primaryLocLabel})` : ""}
Defect Category: ${observation.defectCategory}
Severity: ${observation.severity}
Extent: ${observation.extent}
Field Note: ${observation.fieldNote || "None"}
Indicators Observed: ${indicators.join(", ") || "None specified"}${multiLocBlock}
  `.trim();

  // Fetch observation photos for vision analysis — include both primary and additional-location photos
  const obsPhotos = await storage.getPhotosByObservation(observationId);
  const imageParts = await buildCaptionedImageParts(obsPhotos);

  const hasPhotos = imageParts.length > 0;
  const hasExisting = existingNarrative.trim().length > 0;

  const trainingExamples = await getTrainingExamples("observation_narrative");
  const styleQuery = `${observation.defectCategory} ${observation.fieldNote || ""} ${indicators.join(" ")} ${existingNarrative || ""}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "narrative", 2);
  const projectContext = await getProjectContextById(observation.projectId);
  const contextBlock = buildProjectContextBlock(projectContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(observation.projectId);
  const linkedObsBlock = await buildLinkedObservationsBlock(observationId, observation.projectId);

  const systemPrompt = `${contextBlock}${projectDocsBlock}${styleExamples}${linkedObsBlock}You are an expert facade engineer writing Section 4 (Observations) of an Australian facade condition assessment report.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.

${hasPhotos ? CAPTION_GUIDANCE + "\n\n" : ""}STYLE RULES:
- Use numbered points with lettered sub-items (a, b, c) for details.
- State what was observed, the likely cause, and the implication.
- Use your expertise as a facade engineer to provide professional analysis: explain WHY defects occur, what mechanisms are at play (e.g. UV degradation, thermal cycling, moisture ingress), and what the consequences are if unaddressed.
- Use Australian facade engineering terminology.
${hasPhotos ? "- Analyse the attached photos (each preceded by its engineer-provided caption) to identify visible defects, their severity, and any additional details not captured in the field notes (e.g. extent of cracking, staining patterns, gasket condition, sealant failure mode). Treat captions as authoritative context." : ""}
${hasExisting ? "- The user has written an existing narrative. Incorporate their observations and commentary into the output — preserve their specific details, measurements, and wording where appropriate, while enriching with your technical analysis." : ""}${AFC_NARRATIVE_STYLE_RULES}

FORMAT — follow this structure:
Start with a brief opening line about the system condition, then numbered observations:

1. [Defect type]:
   a. [What was observed]
   b. [Likely cause or contributing factor]
   c. [Implication if left unaddressed]

2. [Next defect if applicable]:
   a. [Details]

EXAMPLE (from a real report):
The WW facade system appears to be in generally good condition from a materials perspective. We have some concerns relating to its construction detailing.

Key observations are:
1. WW unit installation:
   a. Very high unsealed joints at sill level between the WW units and the cantilevered slab edges; open joint widths ~50mm were commonly observed.
   b. Lack of sealants at the heads of units in some areas.
2. PCC panel joint sealants are cracked, torn, damaged by birds and debonding.

ANOTHER EXAMPLE:
1. Disengaged spandrel panels:
   a. We identified 6 glass spandrel panels which are not engaged within the head glazing pocket.
   b. All panels are at the Level 4 slab edge.
   c. If left unaddressed, the gaps may result in air and water leaks.
   d. There is an unlikely, though non-zero chance that the glass may become disengaged entirely and fall from the building.

Return ONLY the narrative text.${trainingExamples}`;

  // Build user message with text, optional existing narrative, and optional photos
  let userText = `Generate an observation narrative based on these field data:\n\n${context}`;
  if (hasExisting) {
    userText += `\n\nExisting narrative written by the inspector (incorporate and build upon this):\n${existingNarrative.trim()}`;
  }
  if (hasPhotos) {
    userText += `\n\nPhotos of the defect are attached. Analyse them to identify additional visible details about the defect condition, extent, and severity.`;
  }

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: userText },
    ...imageParts,
  ];

  // Token budgeting — linked observations are higher priority than style
  // exemplars (per task spec). When the 24k cap is exceeded, drop exemplars
  // first, then project docs, then project context, before truncating
  // linked context. The linked block stays unless absolutely required.
  let contextBlockFinal = contextBlock;
  let projectDocsBlockFinal = projectDocsBlock;
  let styleExamplesFinal = styleExamples;
  let linkedObsBlockFinal = linkedObsBlock;
  let systemPromptFinal = systemPrompt;
  const rebuildSystemPrompt = () =>
    systemPrompt.replace(
      contextBlock + projectDocsBlock + styleExamples + linkedObsBlock,
      contextBlockFinal + projectDocsBlockFinal + styleExamplesFinal + linkedObsBlockFinal,
    );
  const imageTokenAllowance = imageParts.filter(p => (p as any).type === "image_url").length * IMAGE_TOKEN_BUDGET;
  const textBudget = Math.max(4000, MAX_INPUT_TOKENS - imageTokenAllowance);
  let totalText = countTokens(systemPromptFinal) + countContentTokens(userContent).textTokens;
  if (totalText > textBudget) {
    styleExamplesFinal = "";
    systemPromptFinal = rebuildSystemPrompt();
    totalText = countTokens(systemPromptFinal) + countContentTokens(userContent).textTokens;
  }
  if (totalText > textBudget) {
    projectDocsBlockFinal = "";
    systemPromptFinal = rebuildSystemPrompt();
    totalText = countTokens(systemPromptFinal) + countContentTokens(userContent).textTokens;
  }
  if (totalText > textBudget) {
    contextBlockFinal = "";
    systemPromptFinal = rebuildSystemPrompt();
    totalText = countTokens(systemPromptFinal) + countContentTokens(userContent).textTokens;
  }
  if (totalText > textBudget && linkedObsBlockFinal) {
    // Last resort — shrink the linked-obs block rather than drop it entirely
    const overflow = totalText - textBudget;
    const targetLinkedTokens = Math.max(800, countTokens(linkedObsBlockFinal) - overflow - 200);
    linkedObsBlockFinal = truncateToTokens(linkedObsBlockFinal, targetLinkedTokens);
    systemPromptFinal = rebuildSystemPrompt();
  }

  const { textTokens: userTextTokens, imageCount } = countContentTokens(userContent);
  logTokenBreakdown("generateObservationNarrative", {
    context: countTokens(contextBlockFinal),
    docs: countTokens(projectDocsBlockFinal),
    exemplars: countTokens(styleExamplesFinal),
    linked: countTokens(linkedObsBlockFinal),
    system: countTokens(systemPromptFinal) - countTokens(contextBlockFinal) - countTokens(projectDocsBlockFinal) - countTokens(styleExamplesFinal) - countTokens(linkedObsBlockFinal),
    user: userTextTokens,
  }, imageCount);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPromptFinal },
      { role: "user", content: userContent },
    ],
    max_tokens: 800,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function generateRecommendation(observationId: number, conservativeness: string = "medium"): Promise<{
  action: string;
  timeframe: string;
  category: string;
  budgetEstimate: string;
  budgetBasis: string;
}> {
  const client = await getClient();
  const observation = await storage.getObservation(observationId);
  if (!observation) throw new Error("Observation not found.");

  let systemName = "Unknown system";
  let systemType = "";
  if (observation.systemId) {
    const system = await storage.getSystem(observation.systemId);
    if (system) {
      systemName = system.name;
      systemType = system.systemType;
    }
  }

  let indicators: string[] = [];
  try { indicators = JSON.parse(observation.indicators || "[]"); } catch {}

  const additionalLocations = await storage.getObservationLocations(observationId);
  const formatLoc = (drop?: string | null, elev?: string | null, level?: string | null) => {
    const parts = [
      drop ? `Drop ${drop}` : "",
      elev ? `${elev} Elevation` : "",
      level ? `L${level}` : "",
    ].filter(Boolean);
    return parts.join(", ");
  };
  const multiLocBlock = additionalLocations.length > 0
    ? `\nDefect repeats across the following locations:\n${additionalLocations.map((l, i) => {
        const label = formatLoc(l.drop, l.elevation, l.level) || "(unspecified)";
        return `  ${i + 1}. ${label}${l.description ? ` — ${l.description}` : ""}`;
      }).join("\n")}\nFactor this multi-location occurrence into the recommended scope and budget (e.g. quantity / lineal metres should reflect all locations).`
    : "";

  const context = `
System: ${systemName} (${systemType})
Observation ID: ${observation.observationId}
Location: ${observation.location}
Defect Category: ${observation.defectCategory}
Severity: ${observation.severity}
Extent: ${observation.extent}
Field Note: ${observation.fieldNote || "None"}
Indicators: ${indicators.join(", ") || "None specified"}${multiLocBlock}
  `.trim();

  const trainingExamples = await getTrainingExamples("recommendation");
  const styleQuery = `${observation.defectCategory} ${observation.aiNarrative || observation.fieldNote || ""} ${indicators.join(" ")}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "recommendation", 2);
  const projectContext = await getProjectContextById(observation.projectId);
  const contextBlock = buildProjectContextBlock(projectContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(observation.projectId);

  // Include observation photos with captions so recommendations can reflect visible severity
  const obsPhotos = await storage.getPhotosByObservation(observationId);
  const imageParts = await buildCaptionedImageParts(obsPhotos);
  const hasPhotos = imageParts.length > 0;

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: `Generate a recommendation for this observation:\n\n${context}${hasPhotos ? "\n\nPhotos of the defect are attached below, each preceded by its engineer-provided caption." : ""}`,
    },
    ...imageParts,
  ];

  const systemContent = `${contextBlock}${projectDocsBlock}${styleExamples}You are an expert facade engineer writing recommendations for a facade condition assessment CAPEX table.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.
${hasPhotos ? "\n" + CAPTION_GUIDANCE + "\n" : ""}

CONSERVATIVENESS LEVEL: ${conservativeness.toUpperCase()}
${conservativeness === "high" ? `HIGH conservativeness:
- Recommend comprehensive repairs, full replacement where appropriate
- Aim for "near new" outcome and long-term longevity (10-25 years)
- Include invasive investigation/probing (IBP) where warranted
- Higher budget expectations, thorough remedial approach
- Timeframes should reflect urgency — prefer "Immediate" or "3 months" for Essential items
- Example: "Strip and replace all sealant joints to the full curtain wall system. All sealant to be Class 20-25LM silicone. Independent hold-point inspection required."
- Example: "Remove and replace full membrane system. Introduce falls (min 1:80) and re-level all drains. IBP to 10% of area to confirm substrate condition prior to specification."` : conservativeness === "low" ? `LOW conservativeness:
- Recommend temporary repairs, maintenance-level fixes
- Short-term longevity expected (1-2 years), treating symptoms rather than root cause
- Minimal invasiveness, lowest practical cost
- Timeframes can be more relaxed — "1 year" to "2 years" unless safety-critical
- Example: "Apply sealant patch repair to failed joints as a temporary measure. Monitor for recurrence."
- Example: "Clean and re-seal affected areas. Localised repair only — no full system replacement at this stage."` : `MEDIUM conservativeness:
- Moderate repair approach, balancing cost with 3-5 year longevity
- Targeted replacement of failed elements without full system overhaul
- Moderate invasiveness
- Example: "Replace all external PU with new sealant. Compatibility with glazing weather seals must be considered."
- Example: "Identify and repair all developing spalls and failing repair patches. Technical specification by remedial engineer to suit concrete characteristics."`}

STYLE RULES:
- The "action" field should be concise and direct — what needs to be done, in 1-3 sentences max.
- Do not pad with generic advice. Be specific to the defect described.
- Scale the scope, budget, and timeframe to match the conservativeness level above.
- Use Australian facade engineering terminology.

Timeframe options: "Immediate", "3 months", "1 year", "2 years", "5 years", "10 years"
Category options: "Essential", "Desirable", "Monitor"

Respond ONLY with valid JSON:
{
  "action": "string — concise remedial action, 1-3 sentences",
  "timeframe": "string",
  "category": "string",
  "budgetEstimate": "string — e.g. $5,000-$10,000 or TBC",
  "budgetBasis": "string — e.g. per lineal metre, per panel, lump sum, rate-based"
}${trainingExamples}`;

  const { textTokens: userTextTokens, imageCount } = countContentTokens(userContent);
  logTokenBreakdown("generateRecommendation", {
    context: countTokens(contextBlock),
    docs: countTokens(projectDocsBlock),
    exemplars: countTokens(styleExamples),
    system: countTokens(systemContent) - countTokens(contextBlock) - countTokens(projectDocsBlock) - countTokens(styleExamples),
    user: userTextTokens,
  }, imageCount);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    max_tokens: 300,
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse AI response.");
  return JSON.parse(jsonMatch[0]);
}

export async function generateGroupNarrative(
  groupName: string,
  observations: Array<{ observationId: string; defectCategory: string; location: string; severity: string; extent: string; fieldNote: string; indicators: string[]; aiNarrative: string }>,
  photos: Array<{ observationId: string; caption: string; filename?: string }>,
  projectId?: number,
  groupingCriterion?: string
): Promise<string> {
  const client = await getClient();

  const obsContext = observations.map((o) => {
    const photoCaptions = photos.filter(p => p.observationId === o.observationId).map(p => p.caption).filter(Boolean);
    return `[${o.observationId}] ${o.defectCategory} at ${o.location}
  Severity/Extent: ${o.severity} / ${o.extent}
  Indicators: ${(o.indicators || []).join(", ") || "None"}
  Field Note: ${o.fieldNote || "None"}
  Existing narrative: ${o.aiNarrative || "None"}
  Photos: ${photoCaptions.join("; ") || "None"}`;
  }).join("\n\n");

  const trainingExamples = await getTrainingExamples("group_narrative");
  const styleQuery = `${groupName} ${observations.slice(0, 3).map(o => `${o.defectCategory} ${o.fieldNote}`).join(" ")}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "narrative", 2);
  const projectContext = await getProjectContextById(projectId);
  const contextBlock = buildProjectContextBlock(projectContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(projectId);

  // Build vision input: cap at MAX_GROUP_PHOTOS across the whole group, prioritising
  // photos that carry an engineer caption (more informative).
  const photosWithFiles = photos.filter(p => p.filename) as { observationId: string; caption: string; filename: string }[];
  const sortedPhotos = [...photosWithFiles].sort((a, b) => {
    const aHas = (a.caption || "").trim().length > 0 ? 0 : 1;
    const bHas = (b.caption || "").trim().length > 0 ? 0 : 1;
    return aHas - bHas;
  });
  const cappedPhotos = sortedPhotos.slice(0, MAX_GROUP_PHOTOS);
  const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const uploadDir = path.join(dataDir, "uploads");
  for (const p of cappedPhotos) {
    const filePath = path.join(uploadDir, p.filename);
    if (!fs.existsSync(filePath)) continue;
    const loaded = await loadResizedImage(filePath);
    if (!loaded) continue;
    const caption = (p.caption || "").trim();
    imageParts.push({
      type: "text",
      text: `Photo for observation ${p.observationId} — caption: ${caption || "(no caption provided)"}`,
    });
    imageParts.push({
      type: "image_url",
      image_url: { url: `data:${loaded.mimeType};base64,${loaded.base64}`, detail: "high" },
    });
  }
  const hasPhotos = imageParts.length > 0;

  const criterionLine = (groupingCriterion || "").trim()
    ? `Grouping criterion: ${groupingCriterion!.trim()} (this is how the group was formed — frame the narrative accordingly, e.g. by defect type, by location/elevation, by system, etc.)\n\n`
    : "";
  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: `Group name: ${groupName}\n${criterionLine}Observations in this group:\n\n${obsContext}${hasPhotos ? "\n\nPhotos (each preceded by its engineer-provided caption and observation ID) follow below." : ""}` },
    ...imageParts,
  ];

  const systemContent = `${contextBlock}${projectDocsBlock}${styleExamples}You are an expert facade engineer writing a grouped observations section for an Australian facade condition assessment report.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.
${hasPhotos ? "\n" + CAPTION_GUIDANCE + "\n" : ""}

You will be given a group name (e.g. "Eastern Facade" or "Sealant Failure") and a set of related observations. Produce ONE combined narrative covering all of them, as a numbered list of defects with lettered sub-items.

STYLE RULES:
- Concise. Australian facade engineering terminology.
- Do NOT restate the group name as a heading — the heading is already there.
- Open with an optional short (1-2 sentence) overall statement about the group condition, then immediately go to the numbered list.
- Each distinct defect type is one numbered item. Sub-items (a, b, c) carry detail: what was observed, likely cause, implication.
- Do not invent details beyond what the input data provides.${AFC_NARRATIVE_STYLE_RULES}

FORMAT:
[Optional 1-2 sentence opening]

1. [Defect type]:
   a. [Observed detail]
   b. [Likely cause or contributing factor]
   c. [Implication if left unaddressed]

2. [Next defect type]:
   a. [Detail]
   b. [Detail]

EXAMPLE (from a real report, Section 4.4 Eastern Facade):
1. Disengaged spandrel panels:
   a. We identified 6 glass spandrel panels which are not engaged within the head glazing pocket.
   b. All panels are at the Level 4 slab edge.
   c. If left unaddressed, the gaps may result in air and water leaks.
2. Misaligned curtain wall framing:
   a. Significant bowing of horizontal and vertical members.
   b. Likely caused by thermal cycling combined with construction tolerances.
3. Gasket shortening:
   a. Gaskets at mullion heads have shortened, exposing the glazing rebate.

Return ONLY the narrative text.${trainingExamples}`;

  // Enforce overall text-token budget: if context + docs + exemplars + system + user
  // exceed MAX_INPUT_TOKENS (minus image budget), shave the lowest-priority sections.
  // The non-negotiables are the system task instructions + observations payload.
  let projectDocsBlockFinal = projectDocsBlock;
  let styleExamplesFinal = styleExamples;
  let contextBlockFinal = contextBlock;
  const imageTokenAllowance = imageParts.filter(p => (p as any).type === "image_url").length * IMAGE_TOKEN_BUDGET;
  const textBudget = Math.max(4000, MAX_INPUT_TOKENS - imageTokenAllowance);
  const buildSystem = (ctx: string, docs: string, exemplars: string) =>
    systemContent.replace(contextBlock + projectDocsBlock + styleExamples, ctx + docs + exemplars);
  let systemContentFinal = systemContent;
  let totalText =
    countTokens(systemContentFinal) + countContentTokens(userContent).textTokens;
  if (totalText > textBudget) {
    // Drop exemplars first.
    styleExamplesFinal = "";
    systemContentFinal = buildSystem(contextBlockFinal, projectDocsBlockFinal, styleExamplesFinal);
    totalText = countTokens(systemContentFinal) + countContentTokens(userContent).textTokens;
  }
  if (totalText > textBudget) {
    // Then docs.
    projectDocsBlockFinal = "";
    systemContentFinal = buildSystem(contextBlockFinal, projectDocsBlockFinal, styleExamplesFinal);
    totalText = countTokens(systemContentFinal) + countContentTokens(userContent).textTokens;
  }
  if (totalText > textBudget) {
    // Then context.
    contextBlockFinal = "";
    systemContentFinal = buildSystem(contextBlockFinal, projectDocsBlockFinal, styleExamplesFinal);
  }

  const { textTokens: userTextTokens, imageCount } = countContentTokens(userContent);
  logTokenBreakdown("generateGroupNarrative", {
    context: countTokens(contextBlockFinal),
    docs: countTokens(projectDocsBlockFinal),
    exemplars: countTokens(styleExamplesFinal),
    system: countTokens(systemContentFinal) - countTokens(contextBlockFinal) - countTokens(projectDocsBlockFinal) - countTokens(styleExamplesFinal),
    user: userTextTokens,
  }, imageCount);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemContentFinal },
      { role: "user", content: userContent },
    ],
    max_tokens: 700,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function generateProjectIntroduction(projectId: number): Promise<string> {
  const client = await getClient();
  const project = await storage.getProject(projectId);
  if (!project) throw new Error("Project not found.");

  const rawContext = ((project as any).projectContext || "").trim();

  let dates: string[] = [];
  try { dates = JSON.parse(project.inspectionDates || "[]"); } catch {}
  let bgDocs: { title?: string; author?: string; date?: string }[] = [];
  try { bgDocs = JSON.parse(project.backgroundDocs || "[]"); } catch {}

  const meta = `
Building / Project: ${project.name}
Address: ${project.address}
Client: ${project.client}
Inspector: ${project.inspector}
AFC Reference: ${project.afcReference || "Not specified"}
Building Age: ${project.buildingAge || "Not specified"}
Building Use: ${project.buildingUse || "Not specified"}
Storeys: ${project.storeyCount || "Not specified"}
Refurbishment History: ${project.refurbishmentHistory || "None noted"}
Inspection Scope: ${project.inspectionScope || "Not specified"}
Inspection Dates: ${dates.length > 0 ? dates.join(", ") : "Not specified"}
Background Documents: ${bgDocs.length > 0 ? bgDocs.map(d => `${d.title || "Untitled"}${d.author ? " — " + d.author : ""}${d.date ? " (" + d.date + ")" : ""}`).join("; ") : "None"}
  `.trim();

  const styleQuery = `${project.name} ${project.address} ${project.buildingUse || ""} ${rawContext}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "general", 2);
  const descStyleExamples = await getStyleExamples(styleQuery, "description", 1);
  const combinedStyle = styleExamples + descStyleExamples;
  const projectContextBlock = buildProjectContextBlock(rawContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(projectId);

  const userInputBlock = rawContext
    ? `ENGINEER'S ROUGH NOTES (rewrite into polished prose — do not invent facts beyond these notes and the project metadata):\n\n${rawContext}`
    : `(No engineer notes were provided — write a concise generic Background and Introduction using only the project metadata above.)`;

  const systemContent = `${projectContextBlock}${projectDocsBlock}${combinedStyle}You are AFC, Angel Façade Consulting. Rewrite the engineer's rough background notes into a polished Background and Introduction section for a façade inspection report.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.

STYLE RULES:
- Concise, professional, structured. Australian English, Australian facade engineering terminology.
- No fluff. No marketing language. No boilerplate about the importance of due diligence.
- Match the voice and sentence structure of the STYLE EXEMPLARS above (if any).
- Open with one sentence stating that AFC was engaged by the client to assess the building envelope at the address.
- Follow with concise paragraphs (or short numbered points where appropriate) covering: building character/age/use, refurbishment history, scope of the inspection, dates, and any background context the engineer noted.
- Do NOT invent details that are not in the engineer's notes or the project metadata.
- Length: 150-300 words.
- Return ONLY the introduction text, plain prose with optional light structure (numbered or lettered points only if it genuinely improves clarity). No section heading.`;

  const userContent = `Project metadata:\n\n${meta}\n\n${userInputBlock}\n\nRewrite this as the Background and Introduction section of an AFC façade condition assessment report.`;
  logTokenBreakdown("generateProjectIntroduction", {
    context: countTokens(projectContextBlock),
    docs: countTokens(projectDocsBlock),
    exemplars: countTokens(combinedStyle),
    system: countTokens(systemContent) - countTokens(projectContextBlock) - countTokens(projectDocsBlock) - countTokens(combinedStyle),
    user: countTokens(userContent),
  }, 0);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    max_tokens: 700,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function generateExecutiveSummary(projectId: number): Promise<string> {
  const client = await getClient();
  const project = await storage.getProject(projectId);
  if (!project) throw new Error("Project not found.");

  const systems = await storage.getSystemsByProject(projectId);
  const allObservations = await storage.getObservationsByProject(projectId);
  const allRecommendations = await storage.getRecommendationsByProject(projectId);

  const systemsSummary = systems.map(s => `- ${s.name}: ${s.systemType} at ${s.location}`).join("\n");

  const obsSummary = allObservations.map(o => {
    const recs = allRecommendations.filter(r => r.observationId === o.id);
    const recTexts = recs.map(r => `  Action: ${r.action} (${r.timeframe}, ${r.category}, ${r.budgetEstimate || "TBC"})`).join("\n");
    return `- [${o.observationId}] ${o.defectCategory} at ${o.location} — ${o.severity}/${o.extent}${o.fieldNote ? ": " + o.fieldNote : ""}${recTexts ? "\n" + recTexts : ""}`;
  }).join("\n");

  const totalBudget = allRecommendations
    .map(r => {
      const match = (r.budgetEstimate || "").match(/\$?([\d,]+)/);
      return match ? parseInt(match[1].replace(/,/g, "")) : 0;
    })
    .reduce((sum, val) => sum + val, 0);

  const safetyItems = allObservations.filter(o => o.severity === "Safety/Risk").length;
  const essentialItems = allObservations.filter(o => o.severity === "Essential").length;

  const context = `
Building: ${project.name}
Address: ${project.address}
Client: ${project.client}
Building Age: ${project.buildingAge || "Not specified"}
Building Use: ${project.buildingUse || "Not specified"}
Storeys: ${project.storeyCount || "Not specified"}

Facade Systems:
${systemsSummary || "None defined"}

Observations & Recommendations:
${obsSummary || "None recorded"}

Summary Statistics:
- Total observations: ${allObservations.length}
- Safety/Risk items: ${safetyItems}
- Essential items: ${essentialItems}
- Total recommendations: ${allRecommendations.length}
- Approximate total CAPEX: $${totalBudget.toLocaleString() || "TBC"}
  `.trim();

  const trainingExamples = await getTrainingExamples("executive_summary");
  const styleQuery = `${project.name} ${project.address} ${project.buildingUse || ""} ${systems.map(s => s.systemType).join(" ")}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "general", 2);
  const contextBlock = buildProjectContextBlock((project as any).projectContext);
  const projectDocsBlock = await buildProjectDocumentsBlock(projectId);

  const systemContent = `${contextBlock}${projectDocsBlock}${styleExamples}You are an expert facade engineer writing Section 1 (Executive Summary) of an Australian facade condition assessment report.

Use information from the project documents to inform your analysis. Do not cite documents inline — they will be listed as references in the report.

STYLE RULES:
- Be concise. Summarise what was done, what was found, and what needs to happen.
- Use a brief opening paragraph (2-3 sentences) stating scope, then go straight to key findings as a numbered list.
- Do not pad with generic statements about building envelopes or due diligence.
- Only reference findings that come from the data provided.

FORMAT:
[1-3 sentence opening: who engaged AFC, what was assessed, when]

[Optional 1 sentence overall condition statement]

Key findings:
1. [Finding — concise, specific]
2. [Finding]
...

Major recommendations:
1. [Action — concise]
2. [Action]
...

EXAMPLE (from a real report):
Angel Facade Consulting (AFC) assessed the building envelope of the Fox Sports Building at 4 Broadcast Way, Artarmon, over two occasions in 2025.

The facade was found to be in generally good condition from a materials perspective.

Key findings:
1. We identified a total of 7 glass spandrel panels which are not engaged within the head glazing pocket; these require repositioning to maintain safety.
2. The south elevation curtain wall has significant bowing of horizontal members (transoms, heads and sills) and vertical members (mullions).
3. The tiled surfaces at Ground - Level 1 are adhered in position, and this is not compliant with Australian Standards.

Major recommendations:
1. Carry out urgent stabilisation (repositioning) works to the 7 glass spandrels.
2. Stabilise (remove) the drummy tiles above Ground at the southeastern corner.

Keep total length to 150-350 words. Only state facts from the data. Do not speculate.
Return ONLY the executive summary text.${trainingExamples}`;

  const userContent = `Generate an executive summary for this assessment:\n\n${context}`;
  logTokenBreakdown("generateExecutiveSummary", {
    context: countTokens(contextBlock),
    docs: countTokens(projectDocsBlock),
    exemplars: countTokens(styleExamples),
    system: countTokens(systemContent) - countTokens(contextBlock) - countTokens(projectDocsBlock) - countTokens(styleExamples),
    user: countTokens(userContent),
  }, 0);

  const response = await callOpenAIChat(client, {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    max_tokens: 800,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}
