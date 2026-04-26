import OpenAI from "openai";
import { storage, dataDir } from "./storage";
import fs from "fs";
import path from "path";
import { findSimilarPassages } from "./embeddings";

/**
 * Retrieve style exemplars from the user's past AFC reports (RAG).
 * Returns a formatted block to prepend to the system prompt, or "" if library is empty.
 */
async function getStyleExamples(query: string, category: string, topK: number = 2): Promise<string> {
  try {
    const passages = await findSimilarPassages(query, category, topK);
    if (passages.length === 0) return "";

    const numbered = passages
      .map((p, idx) => `${idx + 1}. ${p.text.trim()}`)
      .join("\n\n");

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
function buildCaptionedImageParts(
  photos: { filename: string; caption?: string | null }[]
): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  const uploadDir = path.join(dataDir, "uploads");
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const photo of photos) {
    const filePath = path.join(uploadDir, photo.filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const imageData = fs.readFileSync(filePath);
      const base64 = imageData.toString("base64");
      const ext = path.extname(photo.filename).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const caption = (photo.caption || "").trim();
      parts.push({
        type: "text",
        text: `Photo caption: ${caption || "(no caption provided)"}`,
      });
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
      });
    } catch {}
  }
  return parts;
}

const CAPTION_GUIDANCE = `Each image is preceded by its caption (provided by the engineer on-site). Read captions as authoritative context — they describe what the engineer observed that may not be visually obvious.`;

/**
 * Build a PROJECT CONTEXT block to inject into AI prompts.
 * Returns "" if no context is configured for the project.
 */
function buildProjectContextBlock(projectContext: string | null | undefined): string {
  if (!projectContext || !projectContext.trim()) return "";
  return `PROJECT CONTEXT (provided by the engineer — read carefully and weigh when forming recommendations and analysis):

${projectContext.trim()}

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

export async function identifySystem(photoIds: number[], projectContext: string = ""): Promise<{
  systemType: string;
  materials: { name: string; detail: string }[];
  keyFeatures: string[];
  estimatedAge: string;
  visibleConcerns: string[];
}> {
  const client = await getClient();

  const photosToSend: { filename: string; caption?: string | null }[] = [];
  let resolvedContext = projectContext;
  for (const photoId of photoIds) {
    const photo = await storage.getPhoto(photoId);
    if (!photo) continue;
    photosToSend.push(photo);
    if (!resolvedContext) {
      resolvedContext = await getProjectContextById((photo as any).projectId);
    }
  }
  const captionedParts = buildCaptionedImageParts(photosToSend);

  if (captionedParts.length === 0) {
    throw new Error("No valid photos found for analysis.");
  }

  const contextBlock = buildProjectContextBlock(resolvedContext);

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `${contextBlock}You are an expert facade engineer in Australia. Identify the facade system in the photo(s) concisely.

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

Keep each field brief. Materials: list only what you can see. Key features: 2-4 items max. Visible concerns: only obvious defects, not speculation.`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Identify the facade system in these photos. Each image below is preceded by its caption from the engineer:" },
          ...captionedParts,
        ],
      },
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
  const imageParts = buildCaptionedImageParts(systemPhotos);

  const trainingExamples = await getTrainingExamples("system_description");
  const styleQuery = `${system.systemType} ${materials.map(m => m.name + " " + m.detail).join(" ")} ${keyFeatures.join(" ")}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "description", 2);
  const projectContext = await getProjectContextById(system.projectId);
  const contextBlock = buildProjectContextBlock(projectContext);

  const hasPhotos = imageParts.length > 0;
  const systemPrompt = `${contextBlock}${styleExamples}You are an expert facade engineer writing Section 3.2 (Facade Description) of an Australian facade condition assessment report.

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

  const response = await client.chat.completions.create({
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

  const context = `
System: ${systemName} (${systemType})
Observation ID: ${observation.observationId}
Location: ${observation.location}
Defect Category: ${observation.defectCategory}
Severity: ${observation.severity}
Extent: ${observation.extent}
Field Note: ${observation.fieldNote || "None"}
Indicators Observed: ${indicators.join(", ") || "None specified"}
  `.trim();

  // Fetch observation photos for vision analysis
  const obsPhotos = await storage.getPhotosByObservation(observationId);
  const imageParts = buildCaptionedImageParts(obsPhotos);

  const hasPhotos = imageParts.length > 0;
  const hasExisting = existingNarrative.trim().length > 0;

  const trainingExamples = await getTrainingExamples("observation_narrative");
  const styleQuery = `${observation.defectCategory} ${observation.fieldNote || ""} ${indicators.join(" ")} ${existingNarrative || ""}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "narrative", 2);
  const projectContext = await getProjectContextById(observation.projectId);
  const contextBlock = buildProjectContextBlock(projectContext);

  const systemPrompt = `${contextBlock}${styleExamples}You are an expert facade engineer writing Section 4 (Observations) of an Australian facade condition assessment report.

${hasPhotos ? CAPTION_GUIDANCE + "\n\n" : ""}STYLE RULES:
- Use numbered points with lettered sub-items (a, b, c) for details.
- State what was observed, the likely cause, and the implication.
- Use your expertise as a facade engineer to provide professional analysis: explain WHY defects occur, what mechanisms are at play (e.g. UV degradation, thermal cycling, moisture ingress), and what the consequences are if unaddressed.
- Use Australian facade engineering terminology.
${hasPhotos ? "- Analyse the attached photos (each preceded by its engineer-provided caption) to identify visible defects, their severity, and any additional details not captured in the field notes (e.g. extent of cracking, staining patterns, gasket condition, sealant failure mode). Treat captions as authoritative context." : ""}
${hasExisting ? "- The user has written an existing narrative. Incorporate their observations and commentary into the output — preserve their specific details, measurements, and wording where appropriate, while enriching with your technical analysis." : ""}

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

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
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

  const context = `
System: ${systemName} (${systemType})
Observation ID: ${observation.observationId}
Location: ${observation.location}
Defect Category: ${observation.defectCategory}
Severity: ${observation.severity}
Extent: ${observation.extent}
Field Note: ${observation.fieldNote || "None"}
Indicators: ${indicators.join(", ") || "None specified"}
  `.trim();

  const trainingExamples = await getTrainingExamples("recommendation");
  const styleQuery = `${observation.defectCategory} ${observation.aiNarrative || observation.fieldNote || ""} ${indicators.join(" ")}`.trim();
  const styleExamples = await getStyleExamples(styleQuery, "recommendation", 2);
  const projectContext = await getProjectContextById(observation.projectId);
  const contextBlock = buildProjectContextBlock(projectContext);

  // Include observation photos with captions so recommendations can reflect visible severity
  const obsPhotos = await storage.getPhotosByObservation(observationId);
  const imageParts = buildCaptionedImageParts(obsPhotos);
  const hasPhotos = imageParts.length > 0;

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: `Generate a recommendation for this observation:\n\n${context}${hasPhotos ? "\n\nPhotos of the defect are attached below, each preceded by its engineer-provided caption." : ""}`,
    },
    ...imageParts,
  ];

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `${contextBlock}${styleExamples}You are an expert facade engineer writing recommendations for a facade condition assessment CAPEX table.
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
}${trainingExamples}`,
      },
      {
        role: "user",
        content: userContent,
      },
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
  projectId?: number
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

  // Build vision input: for each photo that has a filename, include its caption + image
  const photosWithFiles = photos.filter(p => p.filename) as { observationId: string; caption: string; filename: string }[];
  const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const uploadDir = path.join(dataDir, "uploads");
  for (const p of photosWithFiles) {
    const filePath = path.join(uploadDir, p.filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const imageData = fs.readFileSync(filePath);
      const base64 = imageData.toString("base64");
      const ext = path.extname(p.filename).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const caption = (p.caption || "").trim();
      imageParts.push({
        type: "text",
        text: `Photo for observation ${p.observationId} — caption: ${caption || "(no caption provided)"}`,
      });
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
      });
    } catch {}
  }
  const hasPhotos = imageParts.length > 0;

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: `Group name: ${groupName}\n\nObservations in this group:\n\n${obsContext}${hasPhotos ? "\n\nPhotos (each preceded by its engineer-provided caption and observation ID) follow below." : ""}` },
    ...imageParts,
  ];

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `${contextBlock}${styleExamples}You are an expert facade engineer writing a grouped observations section for an Australian facade condition assessment report.
${hasPhotos ? "\n" + CAPTION_GUIDANCE + "\n" : ""}

You will be given a group name (e.g. "Eastern Facade" or "Sealant Failure") and a set of related observations. Produce ONE combined narrative covering all of them, as a numbered list of defects with lettered sub-items.

STYLE RULES:
- Concise. Australian facade engineering terminology.
- Do NOT restate the group name as a heading — the heading is already there.
- Open with an optional short (1-2 sentence) overall statement about the group condition, then immediately go to the numbered list.
- Each distinct defect type is one numbered item. Sub-items (a, b, c) carry detail: what was observed, likely cause, implication.
- Do not invent details beyond what the input data provides.

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

Return ONLY the narrative text.${trainingExamples}`,
      },
      {
        role: "user",
        content: userContent,
      },
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

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `${contextBlock}${styleExamples}You are an expert facade engineer writing Section 1 (Executive Summary) of an Australian facade condition assessment report.

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
Return ONLY the executive summary text.${trainingExamples}`,
      },
      {
        role: "user",
        content: `Generate an executive summary for this assessment:\n\n${context}`,
      },
    ],
    max_tokens: 800,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}
