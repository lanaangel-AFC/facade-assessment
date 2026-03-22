import OpenAI from "openai";
import { storage, dataDir } from "./storage";
import fs from "fs";
import path from "path";

async function getClient(): Promise<OpenAI> {
  const apiKey = await storage.getSetting("openai_api_key");
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Go to Settings to add it.");
  }
  return new OpenAI({ apiKey });
}

export async function identifySystem(photoIds: number[]): Promise<{
  systemType: string;
  materials: { name: string; detail: string }[];
  keyFeatures: string[];
  estimatedAge: string;
  visibleConcerns: string[];
}> {
  const client = await getClient();
  const uploadDir = path.join(dataDir, "uploads");

  // Build image content parts
  const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const photoId of photoIds) {
    const photo = await storage.getPhoto(photoId);
    if (!photo) continue;
    const filePath = path.join(uploadDir, photo.filename);
    if (!fs.existsSync(filePath)) continue;
    const imageData = fs.readFileSync(filePath);
    const base64 = imageData.toString("base64");
    const ext = path.extname(photo.filename).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    imageParts.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
    });
  }

  if (imageParts.length === 0) {
    throw new Error("No valid photos found for analysis.");
  }

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert facade engineer performing a building envelope condition assessment. 
Analyze the facade photo(s) and identify:
1. System type (e.g., curtain wall - stick system, unitised curtain wall, concrete wall, render/plaster, metal cladding, composite cladding, fibre cement cladding, masonry/brick, glazed shopfront, roof membrane, balustrade/handrail, stone/tile cladding, louvre system)
2. Materials visible (framing material, glazing/infill type, sealants, gaskets, fixings)
3. Key features (butt-jointed corners, pressure-equalised system, face-sealed, toggle-fixed glass, structural silicone, etc.)
4. Approximate age/era based on construction style and materials
5. Any immediately visible defects or areas of concern

Be specific and technical. Use terminology consistent with Australian facade engineering practice.
Respond ONLY with valid JSON in this exact format:
{
  "systemType": "string",
  "materials": [{"name": "string", "detail": "string"}],
  "keyFeatures": ["string"],
  "estimatedAge": "string",
  "visibleConcerns": ["string"]
}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Identify the facade system in these photos:" },
          ...imageParts,
        ],
      },
    ],
    max_tokens: 1000,
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content || "";
  // Extract JSON from the response (handle markdown code blocks)
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
  try { materials = JSON.parse(system.materials || "[]"); } catch {}
  try { keyFeatures = JSON.parse(system.keyFeatures || "[]"); } catch {}

  const context = `
System Name: ${system.name}
Location on Building: ${system.location}
System Type: ${system.systemType}
Materials: ${materials.map(m => `${m.name}: ${m.detail}`).join("; ") || "Not specified"}
Key Features: ${keyFeatures.join(", ") || "Not specified"}
Estimated Age: ${system.estimatedAge || "Not specified"}
Related Systems: ${system.relatedSystems || "None noted"}
  `.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert facade engineer writing a Technical Due Diligence report for a commercial building.
Generate a professional system description in the style of Section 3.3 of an Australian facade condition assessment report.

The description should:
- Open with the system name and location on the building
- Describe the construction type and framing system
- Detail the glazing or cladding materials and their characteristics
- Mention key features, connections, and interfaces with adjacent systems
- Note the estimated age and any implications for expected performance
- Be written in formal, technical prose suitable for a commercial property report
- Be 2-4 paragraphs, approximately 150-300 words

Use terminology consistent with Australian Standards (AS 4284, NCC) and facade engineering practice.
Do NOT use bullet points — write in flowing paragraphs.
Return ONLY the description text, nothing else.`,
      },
      {
        role: "user",
        content: `Generate a Section 3.3 system description based on these details:\n\n${context}`,
      },
    ],
    max_tokens: 800,
    temperature: 0.4,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function generateObservationNarrative(observationId: number): Promise<string> {
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

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert facade engineer writing a Technical Due Diligence report. 
Generate a detailed observation narrative for a facade defect, in the style of Section 4 of an Australian facade condition assessment report.

The narrative should:
- Open with a clear statement of the defect type and its location
- Describe the observed indicators and their significance
- Provide causal analysis — explain WHY this defect likely occurred (age, UV exposure, thermal cycling, water ingress, poor detailing, etc.)
- Assess the current severity and likely progression if untreated
- Reference relevant performance expectations (design life of sealants ~15-20 years, gasket compression set, etc.)
- Be written in formal, technical prose suitable for a commercial property report
- Be 1-3 paragraphs, approximately 80-200 words

Use terminology consistent with Australian Standards and facade engineering practice.
Return ONLY the narrative text, nothing else.`,
      },
      {
        role: "user",
        content: `Generate a Section 4 observation narrative based on these details:\n\n${context}`,
      },
    ],
    max_tokens: 600,
    temperature: 0.4,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function generateRecommendation(observationId: number): Promise<{
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

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert facade engineer writing recommendations for a Technical Due Diligence report.
Based on the defect observation provided, generate a recommended remedial action.

The recommendation should include:
- A clear action statement (what needs to be done)
- Suggested timeframe: one of "Now", "1 year", "2 years", "5 years", "Prior to leasing"
- Category: one of "Essential", "Desirable", "Monitor"
- Budget estimate range if possible
- Budget basis (e.g., rate per lineal metre, per panel, lump sum)

Consider:
- Safety implications (prioritise Safety/Risk items as "Now")
- Whether temporary measures are needed before full remediation
- Grouped/batch efficiencies for widespread defects
- Common Australian facade remediation rates

Respond ONLY with valid JSON in this exact format:
{
  "action": "string",
  "timeframe": "string",
  "category": "string",
  "budgetEstimate": "string",
  "budgetBasis": "string"
}`,
      },
      {
        role: "user",
        content: `Generate a recommendation for this observation:\n\n${context}`,
      },
    ],
    max_tokens: 500,
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse AI response.");
  return JSON.parse(jsonMatch[0]);
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

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert facade engineer writing the Executive Summary for a Technical Due Diligence report on a commercial building's facade.

Generate a professional executive summary that:
- Opens with the purpose and scope of the assessment
- Summarises the building and its facade systems
- Highlights key findings, prioritising safety/risk items
- Summarises the recommended capital expenditure
- Identifies any items requiring immediate attention
- Provides an overall assessment of the facade condition
- Is 3-5 paragraphs, approximately 300-500 words
- Is written in formal, authoritative prose suitable for property transaction due diligence

Use terminology consistent with Australian Standards and facade engineering practice.
Return ONLY the executive summary text, nothing else.`,
      },
      {
        role: "user",
        content: `Generate an executive summary for this assessment:\n\n${context}`,
      },
    ],
    max_tokens: 1200,
    temperature: 0.4,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}
