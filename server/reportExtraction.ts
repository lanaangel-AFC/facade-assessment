import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import mammoth from "mammoth";

export type PassageCategory = "description" | "narrative" | "recommendation" | "risk" | "general";

export interface ExtractedPassage {
  category: PassageCategory;
  text: string;
  sourceSection: string;
}

// Categorise a section heading into one of the RAG categories
function categoriseHeading(heading: string): PassageCategory {
  const h = heading.toLowerCase();
  if (/description|facade system|construction|site description|introduction/.test(h)) return "description";
  if (/observation|defect|finding|condition/.test(h)) return "narrative";
  if (/recommendation|action|remediation|repair|capex|works/.test(h)) return "recommendation";
  if (/\brisk\b|safety|consequence|hazard/.test(h)) return "risk";
  return "general";
}

// Detect if a line is a heading:
// - numeric patterns like "3.1", "3.2.1", "1.", "4.2 Observations"
// - common AFC section titles
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 120) return false;

  // Numeric section heading: "3.2", "3.2.1 Observations", "1. Introduction"
  if (/^(\d+\.){1,4}\s*[A-Z]/.test(trimmed)) return true;
  if (/^\d+\.\s+[A-Z]/.test(trimmed)) return true;

  // Common AFC headings
  const afcHeadings = [
    /^executive summary/i,
    /^introduction/i,
    /^site description/i,
    /^facade description/i,
    /^observations?/i,
    /^recommendations?/i,
    /^risk assessment/i,
    /^capex summary/i,
    /^limitations/i,
    /^background/i,
    /^inspection/i,
    /^methodology/i,
    /^conclusion/i,
  ];
  if (afcHeadings.some((re) => re.test(trimmed))) return true;

  return false;
}

// Split text into sections by detected headings
function splitIntoSections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = "General";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (isHeadingLine(line)) {
      if (currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n") });
      }
      currentHeading = line.trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n") });
  }

  return sections;
}

// Split a section body into paragraphs, filter by length, chunk long paragraphs
function chunkSectionBody(body: string): string[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 80);

  const chunks: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= 2000) {
      chunks.push(p);
    } else {
      // Split long paragraphs on sentence boundaries at ~1500 char targets
      const sentences = p.match(/[^.!?]+[.!?]+/g) || [p];
      let current = "";
      for (const s of sentences) {
        if ((current + s).length > 1500 && current.length >= 80) {
          chunks.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim().length >= 80) chunks.push(current.trim());
    }
  }
  return chunks;
}

async function extractPdfText(filePath: string): Promise<string> {
  // Prefer pdftotext (poppler-utils) if available — it's fast and installed in Dockerfile
  try {
    const out = execSync(`pdftotext -layout ${JSON.stringify(filePath)} -`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (out && out.trim().length > 0) return out;
  } catch (err) {
    // Fall through to pdf-parse
  }

  // Fall back to pdf-parse v2 (PDFParse class API)
  try {
    const { PDFParse } = await import("pdf-parse");
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result?.text || "";
  } catch (err: any) {
    throw new Error(`PDF extraction failed: ${err.message || err}`);
  }
}

async function extractDocxText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || "";
}

/**
 * Extract passages from a PDF or DOCX report file.
 * Returns an array of {category, text, sourceSection} chunks.
 */
export async function extractPassages(filePath: string, mimeType: string): Promise<ExtractedPassage[]> {
  const ext = path.extname(filePath).toLowerCase();
  let rawText = "";

  if (mimeType === "application/pdf" || ext === ".pdf") {
    rawText = await extractPdfText(filePath);
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    rawText = await extractDocxText(filePath);
  } else {
    throw new Error(`Unsupported file type: ${mimeType || ext}`);
  }

  if (!rawText || rawText.trim().length === 0) {
    throw new Error("No text extracted from document");
  }

  const sections = splitIntoSections(rawText);
  const passages: ExtractedPassage[] = [];

  for (const section of sections) {
    const category = categoriseHeading(section.heading);
    const chunks = chunkSectionBody(section.body);
    for (const chunk of chunks) {
      passages.push({
        category,
        text: chunk,
        sourceSection: section.heading.slice(0, 200),
      });
    }
  }

  return passages;
}
