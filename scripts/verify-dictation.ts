// Harness (Facade Condition Assessment): dictation with the shared AFC word library.
// Uses stand-in GitHub and OpenAI servers (no real tokens or keys needed).
import express from "express";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { dataDir, storage } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { parseWordLibrary, transcriptionContext } from "../server/word-library";

const checks: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, d = "") => checks.push([n, ok, d]);

const WORDS = fs.readFileSync(path.join(process.cwd(), "scripts", "fixtures-words.txt"), "utf8");

// ---------------------------------------------------------------- stand-in services
let ghFile = WORDS;
let ghSha = "sha-1";
let ghMode: "ok" | "down" | "readonly" | "conflict-once" = "ok";
const ghPuts: any[] = [];
const oaCalls: Array<{ fields: Record<string, string[]>; fileType: string; fileName: string; auth: string }> = [];
let oaMode: "ok" | "reject-new-model" | "fail" = "ok";

function parseMultipart(buf: Buffer, ctype: string) {
  const boundary = "--" + /boundary=([^;]+)/.exec(ctype)![1];
  const parts = buf.toString("latin1").split(boundary).slice(1, -1);
  const fields: Record<string, string[]> = {};
  let fileType = "", fileName = "";
  for (const p of parts) {
    const [head, ...rest] = p.split("\r\n\r\n");
    const body = Buffer.from(rest.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1").toString("utf8");
    const name = /name="([^"]+)"/.exec(head)![1];
    const fn = /filename="([^"]+)"/.exec(head);
    if (fn) { fileName = fn[1]; fileType = (/Content-Type: ([^\r\n]+)/i.exec(head) || [])[1] || ""; continue; }
    (fields[name] ||= []).push(body);
  }
  return { fields, fileType, fileName };
}

async function startMocks() {
  const m = express();
  m.get("/repos/:o/:r/contents/:f", (req, res) => {
    if (req.headers.authorization !== "Bearer test-token") return res.status(401).json({});
    if (ghMode === "down") return res.status(500).json({});
    res.json({ sha: ghSha, content: Buffer.from(ghFile, "utf8").toString("base64") });
  });
  m.put("/repos/:o/:r/contents/:f", express.json(), (req, res) => {
    ghPuts.push(req.body);
    if (ghMode === "readonly") return res.status(403).json({});
    if (ghMode === "conflict-once") { ghMode = "ok"; ghSha = "sha-moved"; return res.status(409).json({}); }
    if (req.body.sha !== ghSha) return res.status(409).json({});
    ghFile = Buffer.from(req.body.content, "base64").toString("utf8");
    ghSha = "sha-" + (ghPuts.length + 1);
    res.json({ content: { sha: ghSha } });
  });
  m.post("/v1/audio/transcriptions", express.raw({ type: "*/*", limit: "30mb" }), (req, res) => {
    const mp = parseMultipart(req.body as Buffer, String(req.headers["content-type"]));
    oaCalls.push({ ...mp, auth: String(req.headers.authorization) });
    const model = mp.fields.model?.[0];
    if (oaMode === "fail") return res.status(500).json({ error: "boom" });
    if (oaMode === "reject-new-model" && model === "gpt-transcribe") return res.status(400).json({ error: "model not found" });
    res.json({ text: ` Sealant failure at the façade joint (${model}). ` });
  });
  const s = createServer(m);
  await new Promise<void>((r) => s.listen(0, r));
  return `http://127.0.0.1:${(s.address() as any).port}`;
}

async function main() {
  const MOCK = await startMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.WORD_LIBRARY_TOKEN;
  process.env.WORD_LIBRARY_API_BASE = MOCK;
  process.env.OPENAI_BASE_URL = `${MOCK}/v1`;
  try { fs.unlinkSync(path.join(dataDir, "word-library-cache.txt")); } catch {}

  const app = express();
  app.use(express.json());
  const http = createServer(app);
  await registerRoutes(http, app);
  await new Promise<void>((r) => http.listen(0, r));
  const B = `http://127.0.0.1:${(http.address() as any).port}`;
  const call = async (m: string, p: string, body?: any) => {
    const r = await fetch(`${B}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const audio = (type: string, bytes = 4000) => fetch(`${B}/api/dictation/transcribe`, { method: "POST", headers: { "Content-Type": type }, body: Buffer.alloc(bytes, 7) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  // ---------------------------------------------------------------- parsing
  const lib = parseWordLibrary(WORDS);
  check("words.txt: comments ignored, terms read", lib.terms.length > 80 && !lib.terms.some((t) => t.startsWith("#")), String(lib.terms.length));
  check("words.txt: mix-ups read with their notes", lib.soundAlikes.some((s) => s.heard === "Fejsa" && s.meant === "façade") && lib.soundAlikes.some((s) => s.heard === "ceiling" && s.meant === "sealant" && /joints/.test(s.note)), JSON.stringify(lib.soundAlikes));
  check("words.txt: duplicates removed (façade once)", lib.terms.filter((t) => t.toLowerCase() === "façade").length === 1);
  const odd = parseWordLibrary("a <b> c\n  spaced   out  \nheard=>meant # n\n=> nothing\n");
  check("unsafe characters stripped from keywords", odd.terms[0] === "a b c" && odd.terms[1] === "spaced out", JSON.stringify(odd.terms));
  check("incomplete mix-up lines are skipped", odd.soundAlikes.length === 1 && odd.soundAlikes[0].meant === "meant");
  const ctx = transcriptionContext(lib);
  check("context: keywords are the terms, prompt carries the mix-ups", ctx.keywords.includes("backer rod") && /"Fejsa" is usually "façade"/.test(ctx.prompt) && !/[<>\r\n]/.test(ctx.prompt));

  // ---------------------------------------------------------------- not set up
  let st = await call("GET", "/api/dictation/status");
  check("no OpenAI key: dictation reports unavailable (browser fallback)", st.body?.available === false, JSON.stringify(st.body));
  check("no token: built-in list used, reason reported", st.body?.library?.source === "built-in" && st.body.library.terms > 10 && /WORD_LIBRARY_TOKEN/.test(st.body.library.lastError || ""), JSON.stringify(st.body?.library));
  let t = await audio("audio/webm");
  check("no OpenAI key: transcribe refuses with 503", t.status === 503, String(t.status));
  check("no token: adding a word explains it isn't connected", (await call("POST", "/api/word-library/add", { term: "render" })).body?.message?.includes("isn't connected"));

  // ---------------------------------------------------------------- connected
  await storage.setSetting("openai_api_key", "sk-test"); // the Assessment app keeps its key in Settings
  process.env.WORD_LIBRARY_TOKEN = "test-token";
  let rf = await call("POST", "/api/word-library/refresh");
  check("refresh reads the private GitHub file", rf.body?.status?.source === "github" && rf.body.terms === lib.terms.length && rf.body.status.canEdit === true, JSON.stringify(rf.body));
  check("a copy is saved for when GitHub can't be reached", fs.readFileSync(path.join(dataDir, "word-library-cache.txt"), "utf8") === WORDS);
  st = await call("GET", "/api/dictation/status");
  check("status: available, with the GitHub edit link", st.body?.available === true && st.body.library.editUrl === "https://github.com/lanaangel-AFC/afc-word-library/edit/main/words.txt", JSON.stringify(st.body));

  t = await audio("audio/webm;codecs=opus");
  let c = oaCalls.at(-1)!;
  check("transcribe returns trimmed text", t.status === 200 && t.body?.text === "Sealant failure at the façade joint (gpt-transcribe).", JSON.stringify(t.body));
  check("sent to gpt-transcribe with the server's key", c.fields.model?.[0] === "gpt-transcribe" && c.auth === "Bearer sk-test");
  check("all library terms sent as keywords", (c.fields["keywords[]"] || []).length === lib.terms.length && c.fields["keywords[]"].includes("sealant") && c.fields["keywords[]"].includes("backer rod"), String(c.fields["keywords[]"]?.length));
  check("mix-ups and context sent in the prompt", /Fejsa/.test(c.fields.prompt?.[0] || "") && /condition assessment/.test(c.fields.prompt?.[0] || ""));
  check("languages[]=en sent, singular language not sent", c.fields["languages[]"]?.[0] === "en" && !c.fields.language);
  check("Chrome recording sent as dictation.webm (audio/webm)", c.fileName === "dictation.webm" && c.fileType === "audio/webm", `${c.fileName} ${c.fileType}`);
  await audio("audio/mp4");
  c = oaCalls.at(-1)!;
  check("Safari recording sent as dictation.m4a (audio/mp4)", c.fileName === "dictation.m4a" && c.fileType === "audio/mp4", `${c.fileName} ${c.fileType}`);

  oaMode = "reject-new-model";
  const before = oaCalls.length;
  t = await audio("audio/webm");
  c = oaCalls.at(-1)!;
  check("if gpt-transcribe is refused, retries gpt-4o-transcribe", t.status === 200 && t.body?.model === "gpt-4o-transcribe" && oaCalls.length === before + 2, JSON.stringify(t.body));
  check("fallback model gets the words inside the prompt", /Vocabulary: .*backer rod/.test(c.fields.prompt?.[0] || "") && c.fields.language?.[0] === "en" && !c.fields["keywords[]"]);
  oaMode = "fail";
  t = await audio("audio/webm");
  check("OpenAI failure returns 502 (client falls back to browser dictation)", t.status === 502, String(t.status));
  oaMode = "ok";
  check("empty recording rejected", (await audio("audio/webm", 10)).status === 400);
  check("recording over 25 MB rejected", (await audio("audio/webm", 26 * 1024 * 1024)).status === 413);

  // ---------------------------------------------------------------- GitHub unreachable
  ghMode = "down";
  rf = await call("POST", "/api/word-library/refresh");
  check("GitHub down: last copy kept, error reported", rf.body?.terms === lib.terms.length && /GitHub 500/.test(rf.body?.status?.lastError || ""), JSON.stringify(rf.body?.status));
  t = await audio("audio/webm");
  check("GitHub down: dictation still uses the kept list", t.status === 200 && (oaCalls.at(-1)!.fields["keywords[]"] || []).length === lib.terms.length);
  ghMode = "ok";

  // ---------------------------------------------------------------- adding words
  let a = await call("POST", "/api/word-library/add", { term: "render coat" });
  check("add a term: appended to words.txt on GitHub", a.status === 200 && ghFile.endsWith("\nrender coat\n") && ghPuts.at(-1)?.sha === "sha-1", JSON.stringify(a.body));
  check("added term is used straight away", (await call("GET", "/api/word-library")).body?.terms.includes("render coat"));
  a = await call("POST", "/api/word-library/add", { term: "spandrel", heard: "Spandau" });
  check("add a mix-up: 'heard => term' line", a.status === 200 && ghFile.endsWith("\nSpandau => spandrel\n"), ghFile.slice(-40));
  const puts = ghPuts.length;
  a = await call("POST", "/api/word-library/add", { term: "Sealant" });
  check("existing term not added twice", a.status === 200 && /Already/.test(a.body?.message) && ghPuts.length === puts, JSON.stringify(a.body));
  check("term required", (await call("POST", "/api/word-library/add", { heard: "x" })).status === 400);
  check("format characters refused", (await call("POST", "/api/word-library/add", { term: "a => b" })).status === 400);
  ghMode = "conflict-once";
  a = await call("POST", "/api/word-library/add", { term: "head flashing detail" });
  check("edited at the same moment: retried and saved", a.status === 200 && ghFile.includes("\nhead flashing detail\n"), JSON.stringify(a.body));
  ghMode = "readonly";
  a = await call("POST", "/api/word-library/add", { term: "brand new word" });
  check("read-only token: explains to add the word on GitHub", a.status === 400 && /only read/.test(a.body?.message), JSON.stringify(a.body));
  ghMode = "ok";

  const failed = checks.filter(([, ok]) => !ok);
  for (const [n, ok, d] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : "  " + d}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
