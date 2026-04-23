import OpenAI from "openai";
import { storage } from "./storage";
import type { ReportLibraryPassage } from "@shared/schema";

async function getClient(): Promise<OpenAI> {
  const apiKey = await storage.getSetting("openai_api_key");
  if (!apiKey) {
    throw new Error("OpenAI API key not configured.");
  }
  return new OpenAI({ apiKey });
}

export async function embedText(text: string): Promise<number[]> {
  const client = await getClient();
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = await getClient();
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Retrieve the top-K passages matching the given category (with fallback to "general")
 * ranked by cosine similarity of their stored embedding against the query text embedding.
 * Returns [] gracefully if the library is empty or embeddings are missing.
 */
export async function findSimilarPassages(
  queryText: string,
  category: string,
  topK: number = 3
): Promise<ReportLibraryPassage[]> {
  try {
    let candidates = await storage.getPassagesByCategory(category);
    // Fall back to "general" if not enough in this category
    if (candidates.length < topK && category !== "general") {
      const generals = await storage.getPassagesByCategory("general");
      candidates = [...candidates, ...generals];
    }

    // Skip passages without embeddings
    const withEmb = candidates.filter((p) => p.embedding && p.embedding.trim().length > 0);
    if (withEmb.length === 0) return [];

    const queryEmb = await embedText(queryText);

    const scored = withEmb
      .map((p) => {
        let emb: number[] = [];
        try { emb = JSON.parse(p.embedding as string); } catch { return null; }
        const score = cosineSimilarity(queryEmb, emb);
        return { passage: p, score };
      })
      .filter((x): x is { passage: ReportLibraryPassage; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map((s) => s.passage);
  } catch (err) {
    console.warn("findSimilarPassages error:", err);
    return [];
  }
}
