import type { Express } from "express";
import express from "express";
import { registerDictationRoutes } from "./word-library";
import { parseMatrix, matrixHasContent, buildInspectionText, emptyMatrix, DEFAULT_INSPECTOR } from "@shared/inspectionMatrix";
import {
  REPORT_VERSION_CURRENT, isV2, STANDARD_LIMITATIONS, REFERENCES_INTRO_PRESETS, parseLimitations, stripBrackets,
  reportTitleOf, timeframeRank, isWithinOneYear, parseBudget, parseBudgetRange, formatMoney, TIMEFRAME_GROUP_LABELS, assessmentPhrase, authorPhoneFor,
} from "@shared/reportV2";
import { createServer, type Server } from "http";
import type { ReportIssue } from "@shared/schema";
import { storage, dataDir } from "./storage";
import {
  insertProjectSchema,
  insertFacadeSystemSchema,
  insertObservationSchema,
  insertRecommendationSchema,
  effectiveSeverity,
} from "@shared/schema";
import type { FacadeSystem, Observation, Recommendation, Photo } from "@shared/schema";
import {
  identifySystem,
  generateSystemDescription,
  generateObservationNarrative,
  generateRecommendation,
  generateExecutiveSummary,
  generateGroupNarrative,
  generateProjectIntroduction,
  generateIntroductionV2,
  suggestIssues,
  writeIssue,
  writeObservationsOverview,
} from "./ai";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import crypto from "crypto";
import sharp from "sharp";
import { AFC_LOGO_JPEG_BASE64 } from "./afcBrand";
import {
  Document,
  Packer,
  Paragraph,
  Paragraph as DocxParagraph,
  TextRun,
  TextRun as DocxTextRun,
  TableOfContents,
  NumberFormat,
  LevelFormat,
  HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom,
  TextWrappingType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  ImageRun,
  BookmarkStart,
  BookmarkEnd,
  InternalHyperlink,
  PageBreak,
  Header,
  Footer,
  PageNumber,
  ShadingType,
  VerticalAlign,
  TableLayoutType,
  TabStopPosition,
  TabStopType,
} from "docx";

const uploadDir = path.join(dataDir, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const elevationDir = path.join(uploadDir, "elevations");
if (!fs.existsSync(elevationDir)) {
  fs.mkdirSync(elevationDir, { recursive: true });
}

const roofPlanDir = path.join(uploadDir, "roofplans");
if (!fs.existsSync(roofPlanDir)) {
  fs.mkdirSync(roofPlanDir, { recursive: true });
}

const roofPlanUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, roofPlanDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const name = `${crypto.randomUUID()}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
    if (ok) cb(null, true);
    else cb(new Error("Only image or PDF files are allowed"));
  },
});

const elevationUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, elevationDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const name = `${crypto.randomUUID()}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
    if (ok) cb(null, true);
    else cb(new Error("Only image or PDF files are allowed"));
  },
});

async function getImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  // Try sharp first (always available), fall back to identify
  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
  } catch {}
  try {
    const out = execSync(`identify -format "%w %h" ${JSON.stringify(filePath)}`).toString().trim();
    const [w, h] = out.split(/\s+/).map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
  } catch {}
  return { width: 0, height: 0 };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Dictation with the shared AFC word library (github.com/lanaangel-AFC/afc-word-library).
  registerDictationRoutes(app, {
    dataDir,
    getOpenAIKey: async () => (await storage.getSetting("openai_api_key")) || process.env.OPENAI_API_KEY,
    rawBodyParser: express.raw,
    appContext: "A façade consultant dictating façade condition assessment notes (system descriptions, observations, defects and recommendations) about building envelopes, in Australian English.",
  });

  // Serve static public assets (logo etc.)
  app.use("/api/public", (req, res, next) => {
    const publicDir = path.join(process.cwd(), "public");
    const filePath = path.join(publicDir, path.basename(req.path));
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ message: "File not found" });
    }
  });

  // Serve uploaded photos
  app.use("/api/uploads", (req, res, next) => {
    const filePath = path.join(uploadDir, path.basename(req.path));
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ message: "File not found" });
    }
  });

  // === PROJECTS ===
  app.get("/api/projects", async (_req, res) => {
    const projects = await storage.getProjects();
    res.json(projects);
  });

  app.get("/api/projects/:id", async (req, res) => {
    const project = await storage.getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  });

  app.post("/api/projects", async (req, res) => {
    // New projects use the Stage 1 (v2) report layout; existing projects are untouched.
    const body = { ...req.body };
    if (body.reportVersion == null) body.reportVersion = REPORT_VERSION_CURRENT;
    if (body.reportVersion >= 2) {
      if (!body.inspector || !String(body.inspector).trim()) body.inspector = DEFAULT_INSPECTOR;
      if (!body.limitations || body.limitations === "[]") body.limitations = JSON.stringify(STANDARD_LIMITATIONS);
      if (!body.assessmentType) body.assessmentType = "condition";
      if (!body.referencesIntro) body.referencesIntro = REFERENCES_INTRO_PRESETS[0];
      if (!body.inspectionMatrix) body.inspectionMatrix = JSON.stringify({ ...emptyMatrix(), inspectors: [body.inspector] });
    }
    const parsed = insertProjectSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const project = await storage.createProject(parsed.data);
    res.status(201).json(project);
  });

  app.patch("/api/projects/:id", async (req, res) => {
    const project = await storage.updateProject(Number(req.params.id), req.body);
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  });

  app.delete("/api/projects/:id", async (req, res) => {
    await storage.deleteProject(Number(req.params.id));
    res.status(204).end();
  });

  // === FACADE SYSTEMS ===
  app.get("/api/projects/:projectId/systems", async (req, res) => {
    const systems = await storage.getSystemsByProject(Number(req.params.projectId));
    systems.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    res.json(systems);
  });

  app.get("/api/systems/:id", async (req, res) => {
    const system = await storage.getSystem(Number(req.params.id));
    if (!system) return res.status(404).json({ message: "System not found" });
    res.json(system);
  });

  app.post("/api/projects/:projectId/systems", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const data = { ...req.body, projectId };
    const parsed = insertFacadeSystemSchema.safeParse(data);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const system = await storage.createSystem(parsed.data);
    res.status(201).json(system);
  });

  app.patch("/api/systems/:id", async (req, res) => {
    const system = await storage.updateSystem(Number(req.params.id), req.body);
    if (!system) return res.status(404).json({ message: "System not found" });
    res.json(system);
  });

  // Reorder systems: body { order: number[] } (system ids in display order)
  app.post("/api/projects/:projectId/systems/reorder", async (req, res) => {
    const order: number[] = Array.isArray(req.body?.order) ? req.body.order.map(Number) : [];
    for (let i = 0; i < order.length; i++) await storage.updateSystem(order[i], { sortOrder: i } as any);
    res.json({ success: true });
  });

  app.delete("/api/systems/:id", async (req, res) => {
    await storage.deleteSystem(Number(req.params.id));
    res.status(204).end();
  });

  // === OBSERVATIONS ===
  app.get("/api/projects/:projectId/observations", async (req, res) => {
    const observations = await storage.getObservationsByProject(Number(req.params.projectId));
    res.json(observations);
  });

  app.get("/api/observations/:id", async (req, res) => {
    const observation = await storage.getObservation(Number(req.params.id));
    if (!observation) return res.status(404).json({ message: "Observation not found" });
    const additionalLocations = await storage.getObservationLocations(observation.id);
    const allObsPhotos = await storage.getPhotosByObservation(observation.id);
    const locationsWithPhotos = additionalLocations.map(loc => ({
      ...loc,
      photos: allObsPhotos.filter(p => (p as any).locationId === loc.id),
    }));
    res.json({ ...observation, additionalLocations: locationsWithPhotos });
  });

  app.post("/api/projects/:projectId/observations", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const systemId = req.body.systemId ? Number(req.body.systemId) : null;
    const clientObservationId = req.body.observationId;

    const data = {
      ...req.body,
      projectId,
      systemId,
      // Placeholder — when a systemId is present and no client-supplied id,
      // createObservationWithAutoId will compute and write the real id atomically.
      observationId: clientObservationId ?? "",
    };
    const parsed = insertObservationSchema.safeParse(data);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

    let observation;
    if (!clientObservationId && systemId) {
      // Atomic: generate next id + insert in a single SQLite transaction so
      // two concurrent POSTs cannot both pick the same max-suffix.
      observation = await storage.createObservationWithAutoId(parsed.data);
    } else {
      observation = await storage.createObservation(parsed.data);
    }
    res.status(201).json(observation);
  });

  app.patch("/api/observations/:id", async (req, res) => {
    const id = Number(req.params.id);
    const patch = { ...req.body };

    // If the patch links this observation to a system and it has no
    // observationId yet, allocate one atomically. The PATCH itself still
    // applies the rest of the fields after the assignment.
    const incomingSystemId = patch.systemId != null ? Number(patch.systemId) : undefined;
    if (incomingSystemId) {
      const current = await storage.getObservation(id);
      if (current && (!current.observationId || current.observationId === "")) {
        await storage.assignObservationId(id, incomingSystemId);
        // assignObservationId already wrote observationId; remove it from
        // the patch so updateObservation doesn't overwrite it.
        delete patch.observationId;
      }
    }

    const observation = await storage.updateObservation(id, patch);
    if (!observation) return res.status(404).json({ message: "Observation not found" });
    res.json(observation);
  });

  // Manual admin endpoint: force per-system sequential renumber for a
  // project. Useful after bulk imports or to clean up legacy duplicates.
  app.post("/api/projects/:projectId/renumber-observations", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const result = await storage.renumberProjectObservations(projectId);
    res.json(result);
  });

  app.delete("/api/observations/:id", async (req, res) => {
    await storage.deleteObservation(Number(req.params.id));
    res.status(204).end();
  });

  // === OBSERVATION LINKS (causal links between observations within a project) ===
  app.get("/api/observations/:id/links", async (req, res) => {
    const id = Number(req.params.id);
    const linked = await (storage as any).getLinkedObservations(id);
    res.json(linked);
  });

  app.patch("/api/observations/:id/links", async (req, res) => {
    const id = Number(req.params.id);
    const observation = await storage.getObservation(id);
    if (!observation) return res.status(404).json({ message: "Observation not found" });
    const incoming = Array.isArray(req.body?.relatedIds) ? req.body.relatedIds : [];
    const ids = incoming.map((v: any) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0 && n !== id);
    // Constrain to same-project observations (defensive — UI already filters)
    const projectObs = await storage.getObservationsByProject(observation.projectId);
    const projectObsIds = new Set(projectObs.map(o => o.id));
    const filtered = ids.filter((rid: number) => projectObsIds.has(rid));
    await (storage as any).setObservationLinks(id, filtered);
    const linked = await (storage as any).getLinkedObservations(id);
    res.json(linked);
  });

  // === NEXT OBSERVATION ID ===
  app.get("/api/projects/:projectId/next-observation-id", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const systemId = Number(req.query.systemId);
    if (!systemId) return res.status(400).json({ message: "systemId query param is required" });
    const observationId = await storage.getNextObservationId(projectId, systemId);
    res.json({ observationId });
  });

  // === RECOMMENDATIONS ===
  app.get("/api/observations/:observationId/recommendations", async (req, res) => {
    const recs = await storage.getRecommendationsByObservation(Number(req.params.observationId));
    res.json(recs);
  });

  app.get("/api/projects/:projectId/recommendations", async (req, res) => {
    const recs = await storage.getRecommendationsByProject(Number(req.params.projectId));
    res.json(recs);
  });

  app.post("/api/observations/:observationId/recommendations", async (req, res) => {
    const observationId = Number(req.params.observationId);
    const data = { ...req.body, observationId };
    const parsed = insertRecommendationSchema.safeParse(data);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const rec = await storage.createRecommendation(parsed.data);
    res.status(201).json(rec);
  });

  // ===== v2 Report Issues (Section 4 built from a ranked list of issues) =====
  const ISSUE_FIELDS = ["title", "steer", "summary", "keyObservations", "observationIds", "photoIds", "parentId", "sortOrder"] as const;
  const pickIssue = (body: any) => {
    const out: any = {};
    for (const k of ISSUE_FIELDS) if (body[k] !== undefined) out[k] = (k === "observationIds" || k === "photoIds") && Array.isArray(body[k]) ? JSON.stringify(body[k]) : body[k];
    return out;
  };
  app.get("/api/projects/:projectId/issues", async (req, res) => {
    res.json(await storage.getIssuesByProject(Number(req.params.projectId)));
  });
  app.post("/api/projects/:projectId/issues", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const existing = await storage.getIssuesByProject(projectId);
    const data = { title: "New issue", ...pickIssue(req.body), projectId, createdAt: new Date().toISOString() };
    if (data.sortOrder === undefined) data.sortOrder = existing.length ? Math.max(...existing.map(i => i.sortOrder ?? 0)) + 1 : 0;
    res.status(201).json(await storage.createIssue(data));
  });
  app.patch("/api/issues/:id", async (req, res) => {
    const issue = await storage.updateIssue(Number(req.params.id), pickIssue(req.body));
    if (!issue) return res.status(404).json({ message: "Issue not found" });
    res.json(issue);
  });
  app.delete("/api/issues/:id", async (req, res) => {
    await storage.deleteIssue(Number(req.params.id));
    res.status(204).end();
  });
  // Body: { order: [{ id, parentId }] } in display order.
  app.post("/api/projects/:projectId/issues/reorder", async (req, res) => {
    const order = (req.body?.order || []) as { id: number; parentId?: number | null }[];
    for (let i = 0; i < order.length; i++) {
      await storage.updateIssue(Number(order[i].id), { sortOrder: i, parentId: order[i].parentId ?? null } as any);
    }
    res.json(await storage.getIssuesByProject(Number(req.params.projectId)));
  });
  // Issue-level recommendation: stored against the first linked observation with issueId set.
  app.post("/api/issues/:id/recommendations", async (req, res) => {
    const issue = await storage.getIssue(Number(req.params.id));
    if (!issue) return res.status(404).json({ message: "Issue not found" });
    let obsIds: number[] = [];
    try { obsIds = JSON.parse(issue.observationIds || "[]"); } catch {}
    if (!obsIds.length) return res.status(400).json({ message: "Link at least one observation to this issue first." });
    const parsed = insertRecommendationSchema.safeParse({
      timeframe: "Within 1 year", category: "Essential", ...req.body,
      observationId: obsIds[0], projectId: issue.projectId, issueId: issue.id, createdAt: new Date().toISOString(),
    });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(await storage.createRecommendation(parsed.data));
  });
  app.post("/api/ai/suggest-issues", async (req, res) => {
    try {
      const projectId = Number(req.body?.projectId);
      const suggestions = await suggestIssues(projectId);
      const existing = await storage.getIssuesByProject(projectId);
      let order = existing.length ? Math.max(...existing.map(i => i.sortOrder ?? 0)) + 1 : 0;
      const created = [];
      for (const sg of suggestions) {
        created.push(await storage.createIssue({
          projectId, title: sg.title, steer: sg.steer || "", observationIds: JSON.stringify(sg.observationIds),
          sortOrder: order++, createdAt: new Date().toISOString(),
        } as any));
      }
      res.json(created);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Suggestion failed" });
    }
  });
  app.post("/api/ai/write-observations-overview", async (req, res) => {
    try {
      const projectId = Number(req.body?.projectId);
      const overview = await writeObservationsOverview(projectId);
      await storage.updateProject(projectId, { observationsOverview: overview } as any);
      res.json({ overview });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Writing failed" });
    }
  });
  app.post("/api/ai/write-issue", async (req, res) => {
    try {
      const issueId = Number(req.body?.issueId);
      const out = await writeIssue(issueId);
      res.json(await storage.updateIssue(issueId, { summary: out.summary, keyObservations: out.keyObservations } as any));
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Writing failed" });
    }
  });

  app.patch("/api/recommendations/:id", async (req, res) => {
    const rec = await storage.updateRecommendation(Number(req.params.id), req.body);
    if (!rec) return res.status(404).json({ message: "Recommendation not found" });
    res.json(rec);
  });

  app.delete("/api/recommendations/:id", async (req, res) => {
    await storage.deleteRecommendation(Number(req.params.id));
    res.status(204).end();
  });

  // === PHOTOS ===
  app.get("/api/systems/:systemId/photos", async (req, res) => {
    const photos = await storage.getPhotosBySystem(Number(req.params.systemId));
    res.json(photos);
  });

  app.get("/api/observations/:observationId/photos", async (req, res) => {
    const photos = await storage.getPhotosByObservation(Number(req.params.observationId));
    res.json(photos);
  });

  // Upload photo for a system
  app.post("/api/systems/:systemId/photos", upload.single("photo"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const systemId = Number(req.params.systemId);
    const slot = req.body.slot || "context";

    // Get the system to find its projectId
    const system = await storage.getSystem(systemId);
    if (!system) return res.status(404).json({ message: "System not found" });

    // If a photo already exists in this slot for this system, replace it
    const existingPhotos = await storage.getPhotosBySystem(systemId);
    const existingInSlot = existingPhotos.find((p) => p.slot === slot);
    if (existingInSlot) {
      const oldPath = path.join(uploadDir, existingInSlot.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      await storage.deletePhoto(existingInSlot.id);
    }

    const photo = await storage.createPhoto({
      projectId: system.projectId,
      systemId,
      observationId: null,
      filename: req.file.filename,
      caption: req.body.caption || "",
      slot,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(photo);
  });

  // Upload photo for an observation (optionally tied to an additional location)
  app.post("/api/observations/:observationId/photos", upload.single("photo"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const observationId = Number(req.params.observationId);
    const slot = req.body.slot || "photo1";
    const rawLocationId = req.body.locationId;
    const locationId = rawLocationId && rawLocationId !== "null" && rawLocationId !== "" ? Number(rawLocationId) : null;

    // Get the observation to find its projectId
    const observation = await storage.getObservation(observationId);
    if (!observation) return res.status(404).json({ message: "Observation not found" });

    // Replace within the same scope (primary or specific location) and same slot
    const existingPhotos = await storage.getPhotosByObservation(observationId);
    const existingInSlot = existingPhotos.find((p) => {
      const pLoc = (p as any).locationId ?? null;
      return p.slot === slot && pLoc === locationId;
    });
    if (existingInSlot) {
      const oldPath = path.join(uploadDir, existingInSlot.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      await storage.deletePhoto(existingInSlot.id);
    }

    const photo = await storage.createPhoto({
      projectId: observation.projectId,
      systemId: null,
      observationId,
      locationId,
      filename: req.file.filename,
      caption: req.body.caption || "",
      slot,
      createdAt: new Date().toISOString(),
    } as any);
    res.status(201).json(photo);
  });

  // === OBSERVATION LOCATIONS (additional locations) ===
  app.get("/api/observations/:observationId/locations", async (req, res) => {
    const list = await storage.getObservationLocations(Number(req.params.observationId));
    res.json(list);
  });

  app.post("/api/observations/:observationId/locations", async (req, res) => {
    const observationId = Number(req.params.observationId);
    const observation = await storage.getObservation(observationId);
    if (!observation) return res.status(404).json({ message: "Observation not found" });
    const existing = await storage.getObservationLocations(observationId);
    const created = await storage.createObservationLocation({
      observationId,
      drop: req.body.drop || "",
      elevation: req.body.elevation || "",
      level: req.body.level || "",
      description: req.body.description || "",
      displayOrder: req.body.displayOrder ?? existing.length,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(created);
  });

  app.patch("/api/observation-locations/:id", async (req, res) => {
    const updated = await storage.updateObservationLocation(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ message: "Location not found" });
    res.json(updated);
  });

  app.delete("/api/observation-locations/:id", async (req, res) => {
    const id = Number(req.params.id);
    // Unlink photo files on disk before cascade-deleting location
    const loc = await storage.getObservationLocation(id);
    if (loc) {
      const obsPhotos = await storage.getPhotosByObservation(loc.observationId);
      for (const p of obsPhotos) {
        if ((p as any).locationId === id) {
          const oldPath = path.join(uploadDir, p.filename);
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch {}
          }
        }
      }
    }
    await storage.deleteObservationLocation(id);
    res.status(204).end();
  });

  // Update photo caption
  app.patch("/api/photos/:id", async (req, res) => {
    const id = Number(req.params.id);
    let photo = await storage.getPhoto(id);
    if (!photo) return res.status(404).json({ message: "Photo not found" });
    if (typeof req.body.caption === "string") photo = await storage.updatePhotoCaption(id, req.body.caption);
    if (req.body.includeInReport !== undefined) photo = await storage.updatePhotoInclude(id, req.body.includeInReport ? 1 : 0);
    res.json(photo);
  });

  // Download full-size photo (triggers save on mobile)
  app.get("/api/photos/:id/download", async (req, res) => {
    const photo = await storage.getPhoto(Number(req.params.id));
    if (!photo) return res.status(404).json({ message: "Photo not found" });
    const filePath = path.join(uploadDir, photo.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "File not found" });
    const ext = path.extname(photo.filename).toLowerCase();
    const downloadName = photo.caption
      ? `${photo.caption.replace(/[^a-zA-Z0-9_\- ]/g, "")}${ext}`
      : photo.filename;
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.sendFile(filePath);
  });

  app.delete("/api/photos/:id", async (req, res) => {
    const photo = await storage.deletePhoto(Number(req.params.id));
    if (photo) {
      const filePath = path.join(uploadDir, photo.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.status(204).end();
  });

  // === ELEVATIONS ===
  app.get("/api/projects/:projectId/elevations", async (req, res) => {
    const list = await storage.getElevationsByProject(Number(req.params.projectId));
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    res.json(list);
  });

  app.get("/api/elevations/:id", async (req, res) => {
    const elevation = await storage.getElevation(Number(req.params.id));
    if (!elevation) return res.status(404).json({ message: "Elevation not found" });
    res.json(elevation);
  });

  app.get("/api/elevations/:id/image", async (req, res) => {
    const elevation = await storage.getElevation(Number(req.params.id));
    if (!elevation) return res.status(404).json({ message: "Elevation not found" });
    const filePath = path.join(elevationDir, elevation.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "Image file not found" });
    res.sendFile(filePath);
  });

  app.post("/api/projects/:projectId/elevations", elevationUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const projectId = Number(req.params.projectId);
      const name = req.body.name || req.file.originalname;
      const type = req.body.type || "elevation";
      const originalFilename = req.file.originalname;
      let storedFilename = req.file.filename;
      const isPdf = req.file.mimetype === "application/pdf" || path.extname(req.file.originalname).toLowerCase() === ".pdf";

      if (isPdf) {
        // Convert first page to PNG using pdftoppm
        const pdfPath = path.join(elevationDir, storedFilename);
        const outBase = crypto.randomUUID();
        const outPrefix = path.join(elevationDir, outBase);
        try {
          execSync(`pdftoppm -png -r 200 -singlefile ${JSON.stringify(pdfPath)} ${JSON.stringify(outPrefix)}`);
          const pngPath = `${outPrefix}.png`;
          if (!fs.existsSync(pngPath)) {
            return res.status(500).json({ message: "PDF conversion produced no image" });
          }
          // Remove the original PDF
          try { fs.unlinkSync(pdfPath); } catch {}
          storedFilename = `${outBase}.png`;
        } catch (err: any) {
          console.error("pdftoppm failed:", err);
          return res.status(500).json({ message: "Failed to convert PDF" });
        }
      }

      const fullPath = path.join(elevationDir, storedFilename);
      const { width, height } = await getImageDimensions(fullPath);

      const elevation = await storage.createElevation({
        projectId,
        name,
        type,
        filename: storedFilename,
        originalFilename,
        width,
        height,
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(elevation);
    } catch (err: any) {
      console.error("Elevation upload error:", err);
      res.status(500).json({ message: err.message || "Upload failed" });
    }
  });

  app.patch("/api/elevations/:id", async (req, res) => {
    const elevation = await storage.updateElevation(Number(req.params.id), req.body);
    if (!elevation) return res.status(404).json({ message: "Elevation not found" });
    res.json(elevation);
  });

  app.delete("/api/elevations/:id", async (req, res) => {
    const id = Number(req.params.id);
    const elevation = await storage.deleteElevation(id);
    if (elevation) {
      const filePath = path.join(elevationDir, elevation.filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    res.status(204).end();
  });

  // === ELEVATION PINS ===
  app.get("/api/elevations/:id/pins", async (req, res) => {
    const elevationId = Number(req.params.id);
    const pins = await storage.getPinsByElevation(elevationId);
    // Enrich with observation data
    const enriched = await Promise.all(pins.map(async (pin) => {
      const obs = await storage.getObservation(pin.observationId);
      return {
        ...pin,
        observationIdText: obs?.observationId || "",
        defectCategory: obs?.defectCategory || "",
        severity: obs?.severity || "",
        location: obs?.location || "",
      };
    }));
    res.json(enriched);
  });

  app.post("/api/elevations/:id/pins", async (req, res) => {
    const elevationId = Number(req.params.id);
    const { observationId, x, y } = req.body;
    if (!observationId || x === undefined || y === undefined) {
      return res.status(400).json({ message: "observationId, x, y required" });
    }
    // Remove any existing pin for this observation
    await storage.deleteElevationPinByObservation(Number(observationId));
    const pin = await storage.createElevationPin({
      elevationId,
      observationId: Number(observationId),
      x: Number(x),
      y: Number(y),
      createdAt: new Date().toISOString(),
    });
    // Also update observation.elevationId
    await storage.updateObservation(Number(observationId), { elevationId } as any);
    res.status(201).json(pin);
  });

  app.patch("/api/elevation-pins/:id", async (req, res) => {
    const pin = await storage.updateElevationPin(Number(req.params.id), req.body);
    if (!pin) return res.status(404).json({ message: "Pin not found" });
    res.json(pin);
  });

  app.delete("/api/elevation-pins/:id", async (req, res) => {
    const pin = await storage.getElevationPin(Number(req.params.id));
    if (pin) {
      await storage.updateObservation(pin.observationId, { elevationId: null } as any);
    }
    await storage.deleteElevationPin(Number(req.params.id));
    res.status(204).end();
  });

  // === OBSERVATION PIN MANAGEMENT ===
  app.get("/api/observations/:id/pin", async (req, res) => {
    const pin = await storage.getPinByObservation(Number(req.params.id));
    if (!pin) return res.json({ pin: null });
    res.json(pin);
  });

  app.put("/api/observations/:id/pin", async (req, res) => {
    const observationId = Number(req.params.id);
    const { elevationId, x, y } = req.body;
    if (!elevationId || x === undefined || y === undefined) {
      return res.status(400).json({ message: "elevationId, x, y required" });
    }
    const existing = await storage.getPinByObservation(observationId);
    let pin;
    if (existing) {
      pin = await storage.updateElevationPin(existing.id, {
        elevationId: Number(elevationId),
        x: Number(x),
        y: Number(y),
      });
    } else {
      pin = await storage.createElevationPin({
        elevationId: Number(elevationId),
        observationId,
        x: Number(x),
        y: Number(y),
        createdAt: new Date().toISOString(),
      });
    }
    await storage.updateObservation(observationId, { elevationId: Number(elevationId) } as any);
    res.json(pin);
  });

  app.delete("/api/observations/:id/pin", async (req, res) => {
    const observationId = Number(req.params.id);
    await storage.deleteElevationPinByObservation(observationId);
    await storage.updateObservation(observationId, { elevationId: null } as any);
    res.status(204).end();
  });

  // === ROOF PLAN ===
  // Serve roof plan image
  app.get("/api/projects/:projectId/roof-plan/image", async (req, res) => {
    const project = await storage.getProject(Number(req.params.projectId));
    if (!project || !project.roofPlanImagePath) {
      return res.status(404).json({ message: "Roof plan not found" });
    }
    const filename = path.basename(project.roofPlanImagePath);
    const filePath = path.join(roofPlanDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "Image file not found" });
    res.sendFile(filePath);
  });

  app.post("/api/projects/:projectId/roof-plan", roofPlanUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const originalFilename = req.file.originalname;
      let storedFilename = req.file.filename;
      const isPdf = req.file.mimetype === "application/pdf" || path.extname(originalFilename).toLowerCase() === ".pdf";

      if (isPdf) {
        const pdfPath = path.join(roofPlanDir, storedFilename);
        const outBase = crypto.randomUUID();
        const outPrefix = path.join(roofPlanDir, outBase);
        try {
          execSync(`pdftoppm -png -r 200 -singlefile ${JSON.stringify(pdfPath)} ${JSON.stringify(outPrefix)}`);
          const pngPath = `${outPrefix}.png`;
          if (!fs.existsSync(pngPath)) {
            return res.status(500).json({ message: "PDF conversion produced no image" });
          }
          try { fs.unlinkSync(pdfPath); } catch {}
          storedFilename = `${outBase}.png`;
        } catch (err: any) {
          console.error("pdftoppm failed:", err);
          return res.status(500).json({ message: "Failed to convert PDF" });
        }
      }

      // If project already had a roof plan, delete the old file
      if (project.roofPlanImagePath) {
        const oldFilename = path.basename(project.roofPlanImagePath);
        const oldFilePath = path.join(roofPlanDir, oldFilename);
        if (fs.existsSync(oldFilePath)) {
          try { fs.unlinkSync(oldFilePath); } catch {}
        }
      }

      const imagePath = `/uploads/roofplans/${storedFilename}`;
      const updated = await storage.updateProjectRoofPlan(projectId, imagePath, originalFilename);
      res.status(201).json(updated);
    } catch (err: any) {
      console.error("Roof plan upload error:", err);
      res.status(500).json({ message: err.message || "Upload failed" });
    }
  });

  app.delete("/api/projects/:projectId/roof-plan", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = await storage.getProject(projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });

    if (project.roofPlanImagePath) {
      const filename = path.basename(project.roofPlanImagePath);
      const filePath = path.join(roofPlanDir, filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    await storage.deleteDropsByProject(projectId);
    const updated = await storage.clearProjectRoofPlan(projectId);
    res.json(updated);
  });

  // === DROPS ===
  app.get("/api/projects/:projectId/drops", async (req, res) => {
    const drops = await storage.getDropsByProject(Number(req.params.projectId));
    drops.sort((a, b) => a.id - b.id);
    res.json(drops);
  });

  app.post("/api/projects/:projectId/drops", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const { dropNumber, x, y } = req.body;
    if (!dropNumber || x === undefined || y === undefined) {
      return res.status(400).json({ message: "dropNumber, x, y required" });
    }
    const drop = await storage.createDrop({
      projectId,
      dropNumber: String(dropNumber),
      x: Number(x),
      y: Number(y),
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(drop);
  });

  app.patch("/api/drops/:id", async (req, res) => {
    const id = Number(req.params.id);
    const patch: any = {};
    if (req.body.dropNumber !== undefined) patch.dropNumber = String(req.body.dropNumber);
    if (req.body.x !== undefined) patch.x = Number(req.body.x);
    if (req.body.y !== undefined) patch.y = Number(req.body.y);
    const drop = await storage.updateDrop(id, patch);
    if (!drop) return res.status(404).json({ message: "Drop not found" });
    res.json(drop);
  });

  app.delete("/api/drops/:id", async (req, res) => {
    await storage.deleteDrop(Number(req.params.id));
    res.status(204).end();
  });

  // === SETTINGS ===
  app.get("/api/settings/:key", async (req, res) => {
    const value = await storage.getSetting(req.params.key);
    if (value === undefined) return res.json({ value: null });
    // Mask API key for security — only return last 4 chars
    if (req.params.key === "openai_api_key" && value) {
      return res.json({ value: "sk-..." + value.slice(-4), hasKey: true });
    }
    res.json({ value });
  });

  app.post("/api/settings", async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ message: "Key and value are required" });
    await storage.setSetting(key, value);
    res.json({ success: true });
  });

  // === AI ENDPOINTS ===
  app.post("/api/ai/identify-system", async (req, res) => {
    try {
      const { photoIds } = req.body;
      if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        return res.status(400).json({ message: "photoIds array is required" });
      }
      const result = await identifySystem(photoIds);
      res.json(result);
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "AI identification failed" });
    }
  });

  app.post("/api/ai/generate-system-description", async (req, res) => {
    try {
      const { systemId } = req.body;
      if (!systemId) return res.status(400).json({ message: "systemId is required" });
      const description = await generateSystemDescription(Number(systemId));
      res.json({ description });
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Description generation failed" });
    }
  });

  app.post("/api/ai/generate-observation-narrative", async (req, res) => {
    try {
      const { observationId, existingNarrative } = req.body;
      if (!observationId) return res.status(400).json({ message: "observationId is required" });
      const narrative = await generateObservationNarrative(Number(observationId), existingNarrative || "");
      res.json({ narrative });
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Narrative generation failed" });
    }
  });

  app.post("/api/ai/generate-recommendation", async (req, res) => {
    try {
      const { observationId, conservativeness } = req.body;
      if (!observationId) return res.status(400).json({ message: "observationId is required" });
      const result = await generateRecommendation(Number(observationId), conservativeness || "medium");
      res.json(result);
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Recommendation generation failed" });
    }
  });

  app.post("/api/ai/generate-introduction", async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ message: "projectId is required" });
      const proj = await storage.getProject(Number(projectId));
      if (proj && isV2(proj as any)) {
        const out = await generateIntroductionV2(Number(projectId));
        const updates: any = { aiIntroduction: out.general, aiBackground: out.background };
        if (!((proj as any).locationDescription || "").trim()) updates.locationDescription = out.location;
        await storage.updateProject(Number(projectId), updates);
        return res.json({ introduction: out.general, background: out.background, location: updates.locationDescription ?? (proj as any).locationDescription });
      }
      const introduction = await generateProjectIntroduction(Number(projectId));
      // Persist on the project so the Word export picks it up automatically.
      await storage.updateProject(Number(projectId), { aiIntroduction: introduction } as any);
      res.json({ introduction });
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Introduction generation failed" });
    }
  });

  app.post("/api/ai/generate-executive-summary", async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ message: "projectId is required" });
      const summary = await generateExecutiveSummary(Number(projectId));
      res.json({ summary });
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Executive summary generation failed" });
    }
  });

  // === TRAINING DATA ===
  app.post("/api/ai/training-data", async (req, res) => {
    try {
      const { taskType, inputData, aiOutput, userCorrected, accepted } = req.body;
      if (!taskType || !inputData || !aiOutput) {
        return res.status(400).json({ message: "taskType, inputData, and aiOutput are required" });
      }
      const record = await storage.createTrainingData({
        taskType,
        inputData: typeof inputData === "string" ? inputData : JSON.stringify(inputData),
        aiOutput,
        userCorrected: userCorrected || "",
        accepted: accepted ? 1 : 0,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(record);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to save training data" });
    }
  });

  app.get("/api/ai/training-data/count", async (_req, res) => {
    const count = await storage.getTrainingDataCount();
    res.json({ count });
  });

  app.get("/api/ai/training-data/export", async (_req, res) => {
    const data = await storage.getAllTrainingData();
    const jsonl = data.map(d => JSON.stringify({
      messages: [
        { role: "system", content: `Task: ${d.taskType}` },
        { role: "user", content: d.inputData },
        { role: "assistant", content: d.userCorrected || d.aiOutput },
      ],
    })).join("\n");
    res.setHeader("Content-Type", "application/jsonl");
    res.setHeader("Content-Disposition", "attachment; filename=training-data.jsonl");
    res.send(jsonl);
  });

  // === INSPECTION STATUS + GROUPS ===
  app.patch("/api/projects/:id/status", async (req, res) => {
    const { inspectionStatus, observationGrouping } = req.body as { inspectionStatus?: string; observationGrouping?: string };
    const updates: any = {};
    if (inspectionStatus !== undefined) updates.inspectionStatus = inspectionStatus;
    if (observationGrouping !== undefined) updates.observationGrouping = observationGrouping;
    const project = await storage.updateProject(Number(req.params.id), updates);
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  });

  // Build or rebuild observation groups for a project based on chosen grouping method
  app.post("/api/projects/:id/observation-groups/rebuild", async (req, res) => {
    const projectId = Number(req.params.id);
    const project = await storage.getProject(projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });

    const grouping = (req.body.grouping as string) || project.observationGrouping || "by_type";
    const obs = await storage.getObservationsByProject(projectId);

    // Delete existing groups and clear groupId on observations so we can rebuild cleanly
    await storage.deleteGroupsByProject(projectId);
    for (const o of obs) {
      if (o.groupId) await storage.updateObservation(o.id, { groupId: null } as any);
    }

    const keyFor = (o: typeof obs[number]) => {
      if (grouping === "by_elevation") {
        return (o.gridElevation || o.location || "Unassigned").trim() || "Unassigned";
      }
      return (o.defectCategory || "Unassigned").trim() || "Unassigned";
    };

    const groupedKeys: Record<string, typeof obs> = {};
    for (const o of obs) {
      const k = keyFor(o);
      if (!groupedKeys[k]) groupedKeys[k] = [];
      groupedKeys[k].push(o);
    }

    const createdAt = new Date().toISOString();
    let sortOrder = 0;
    const created: any[] = [];
    const criterionLabel = grouping === "by_elevation" ? "Location" : "Type";
    for (const [key, list] of Object.entries(groupedKeys)) {
      const group = await storage.createGroup({
        projectId,
        name: key,
        groupKey: key,
        groupingCriterion: criterionLabel,
        displayOrder: sortOrder,
        sortOrder: sortOrder++,
        combinedNarrative: "",
        createdAt,
      } as any);
      for (const o of list) {
        await storage.updateObservation(o.id, { groupId: group.id } as any);
      }
      created.push(group);
    }

    await storage.updateProject(projectId, { observationGrouping: grouping } as any);
    res.json({ groups: created });
  });

  app.get("/api/projects/:id/observation-groups", async (req, res) => {
    const projectId = Number(req.params.id);
    const groups = await storage.getGroupsByProject(projectId);
    groups.sort((a, b) => ((a as any).displayOrder ?? a.sortOrder ?? 0) - ((b as any).displayOrder ?? b.sortOrder ?? 0) || a.id - b.id);
    const allObs = await storage.getObservationsByProject(projectId);

    const result = await Promise.all(groups.map(async (g) => {
      const members = allObs.filter(o => o.groupId === g.id)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
      const memberDetails = await Promise.all(members.map(async (m) => {
        const ps = await storage.getPhotosByObservation(m.id);
        return { ...m, photos: ps };
      }));
      return { ...g, observations: memberDetails };
    }));
    res.json(result);
  });

  app.patch("/api/observation-groups/:id", async (req, res) => {
    const updated = await storage.updateGroup(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ message: "Group not found" });
    res.json(updated);
  });

  // Create a single new group (used for mixed-criteria manual grouping)
  app.post("/api/projects/:id/observation-groups", async (req, res) => {
    const projectId = Number(req.params.id);
    const project = await storage.getProject(projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const groupingCriterion = (req.body?.groupingCriterion || "").trim();
    const combinedNarrative = (req.body?.combinedNarrative || "").trim();
    const existingGroups = await storage.getGroupsByProject(projectId);
    const nextOrder = existingGroups.length;
    const group = await storage.createGroup({
      projectId,
      name,
      groupKey: name,
      groupingCriterion,
      displayOrder: nextOrder,
      sortOrder: nextOrder,
      combinedNarrative,
      createdAt: new Date().toISOString(),
    } as any);
    res.status(201).json(group);
  });

  // Reorder groups within a project
  app.post("/api/projects/:id/groups/reorder", async (req, res) => {
    const projectId = Number(req.params.id);
    const orderedIds = (req.body?.orderedIds || []) as Array<number | string>;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ message: "orderedIds must be an array" });
    const ids = orderedIds.map(n => Number(n)).filter(n => !isNaN(n));
    await storage.reorderObservationGroups(projectId, ids);
    res.json({ ok: true });
  });

  app.delete("/api/observation-groups/:id", async (req, res) => {
    const groupId = Number(req.params.id);
    // Unassign any observations referencing this group
    const group = await storage.getGroup(groupId);
    if (group) {
      const obs = await storage.getObservationsByProject(group.projectId);
      for (const o of obs) {
        if (o.groupId === groupId) await storage.updateObservation(o.id, { groupId: null } as any);
      }
    }
    await storage.deleteGroup(groupId);
    res.status(204).end();
  });

  // Merge group source into target
  app.post("/api/observation-groups/merge", async (req, res) => {
    const { sourceId, targetId } = req.body as { sourceId: number; targetId: number };
    if (!sourceId || !targetId) return res.status(400).json({ message: "sourceId and targetId required" });
    const source = await storage.getGroup(Number(sourceId));
    const target = await storage.getGroup(Number(targetId));
    if (!source || !target) return res.status(404).json({ message: "Group not found" });
    if (source.projectId !== target.projectId) return res.status(400).json({ message: "Groups must be in the same project" });
    const obs = await storage.getObservationsByProject(source.projectId);
    for (const o of obs) {
      if (o.groupId === source.id) await storage.updateObservation(o.id, { groupId: target.id } as any);
    }
    await storage.deleteGroup(source.id);
    res.json({ ok: true });
  });

  // Move observation to a different group
  app.patch("/api/observations/:id/group", async (req, res) => {
    const { groupId } = req.body as { groupId: number | null };
    const updated = await storage.updateObservation(Number(req.params.id), { groupId: groupId ?? null } as any);
    if (!updated) return res.status(404).json({ message: "Observation not found" });
    res.json(updated);
  });

  // Generate AI combined narratives for all groups in a project
  app.post("/api/projects/:id/observation-groups/generate", async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const groups = await storage.getGroupsByProject(projectId);
      const allObs = await storage.getObservationsByProject(projectId);

      const results: { id: number; combinedNarrative: string }[] = [];
      for (const g of groups) {
        const members = allObs.filter(o => o.groupId === g.id);
        if (members.length === 0) continue;
        const obsPayload = members.map((m) => {
          let ind: string[] = [];
          try { ind = JSON.parse(m.indicators || "[]"); } catch {}
          return {
            observationId: m.observationId,
            defectCategory: m.defectCategory,
            location: m.location,
            severity: m.severity,
            extent: m.extent,
            fieldNote: m.fieldNote || "",
            indicators: ind,
            aiNarrative: m.aiNarrative || "",
          };
        });
        const photos: { observationId: string; caption: string; filename: string }[] = [];
        for (const m of members) {
          const ps = await storage.getPhotosByObservation(m.id);
          for (const p of ps) photos.push({ observationId: m.observationId, caption: p.caption || "", filename: p.filename });
        }
        const narrative = await generateGroupNarrative(g.name, obsPayload, photos, projectId, (g as any).groupingCriterion || "");
        await storage.updateGroup(g.id, { combinedNarrative: narrative } as any);
        results.push({ id: g.id, combinedNarrative: narrative });
      }
      res.json({ groups: results });
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Group narrative generation failed" });
    }
  });

  // === CUSTOM INDICATORS ===
  const DEFAULT_INDICATORS = [
    "Water staining",
    "Corrosion products",
    "Displacement/movement",
    "Cracking",
    "Delamination",
    "Biological growth",
    "Efflorescence",
    "Ponding water",
    "Air leaks",
    "Debris accumulation",
    "Surface chalking",
    "Loss of adhesion",
    "Compression set",
    "Discolouration",
    "Missing material",
  ];

  app.get("/api/projects/:projectId/indicators", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const custom = await storage.getCustomIndicatorsByProject(projectId);
    res.json({
      defaults: DEFAULT_INDICATORS,
      custom: custom.map(c => ({ id: c.id, name: c.name })),
    });
  });

  app.post("/api/projects/:projectId/indicators", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const indicator = await storage.createCustomIndicator({
      projectId,
      name,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(indicator);
  });

  app.delete("/api/indicators/:id", async (req, res) => {
    await storage.deleteCustomIndicator(Number(req.params.id));
    res.status(204).end();
  });

  // === CUSTOM ROOF TYPES (global, reusable across projects) ===
  app.get("/api/custom-roof-types", async (_req, res) => {
    const types = await storage.getCustomRoofTypes();
    res.json(types);
  });

  app.post("/api/custom-roof-types", async (req, res) => {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const type = await storage.createCustomRoofType({
      name,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(type);
  });

  app.delete("/api/custom-roof-types/:id", async (req, res) => {
    await storage.deleteCustomRoofType(Number(req.params.id));
    res.status(204).end();
  });

  // === CUSTOM DEFECT CATEGORIES (project-scoped, available in observation form dropdown) ===
  app.get("/api/projects/:projectId/custom-defect-categories", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const cats = await storage.getCustomDefectCategoriesByProject(projectId);
    res.json(cats);
  });

  app.post("/api/projects/:projectId/custom-defect-categories", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const category = await storage.createCustomDefectCategory({
      projectId,
      name,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(category);
  });

  app.delete("/api/custom-defect-categories/:id", async (req, res) => {
    await storage.deleteCustomDefectCategory(Number(req.params.id));
    res.status(204).end();
  });

  // === PROJECT ROOF LEVELS (project-scoped, used by Level dropdown on observation form) ===
  app.get("/api/projects/:projectId/roof-levels", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const levels = await storage.getProjectRoofLevels(projectId);
    res.json(levels);
  });

  // Server constructs the canonical label as "Roof – {descriptor}" (en-dash separator)
  // so the format stays consistent across the project. Case-insensitive dedupe.
  app.post("/api/projects/:projectId/roof-levels", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const descriptor = (req.body?.descriptor || "").trim();
    if (!descriptor) return res.status(400).json({ message: "descriptor is required" });
    const label = `Roof – ${descriptor}`;
    const level = await storage.createProjectRoofLevel({
      projectId,
      label,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(level);
  });

  app.delete("/api/project-roof-levels/:id", async (req, res) => {
    await storage.deleteProjectRoofLevel(Number(req.params.id));
    res.status(204).end();
  });

  // === PROJECT DOCUMENTS (project-scoped factual context + Harvard references) ===
  const projectDocsDir = path.join(uploadDir, "project-docs");
  if (!fs.existsSync(projectDocsDir)) {
    fs.mkdirSync(projectDocsDir, { recursive: true });
  }

  const projectDocUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, projectDocsDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok =
        file.mimetype === "application/pdf" ||
        file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        file.mimetype === "image/jpeg" ||
        file.mimetype === "image/png" ||
        /\.(pdf|docx|jpg|jpeg|png)$/i.test(file.originalname);
      if (ok) cb(null, true);
      else cb(new Error("Only PDF, DOCX, JPG, or PNG files are allowed"));
    },
  });

  const PROJECT_DOC_TEXT_CAP = 30000;

  async function processProjectDocument(documentId: number) {
    const { extractRawText } = await import("./reportExtraction");
    try {
      const doc = await storage.getProjectDocument(documentId);
      if (!doc) return;

      const ext = path.extname(doc.filePath).toLowerCase();
      const isImage = /^image\//.test(doc.mimeType || "") || /\.(jpe?g|png)$/i.test(ext);

      if (isImage) {
        await storage.updateProjectDocument(documentId, {
          extractionStatus: "skipped",
          extractionError: "",
          extractedText: "",
        });
        return;
      }

      await storage.updateProjectDocument(documentId, { extractionStatus: "processing" });

      let text = await extractRawText(doc.filePath, doc.mimeType || "");
      if (text.length > PROJECT_DOC_TEXT_CAP) {
        text = text.slice(0, PROJECT_DOC_TEXT_CAP) + "\n[...truncated]";
      }
      await storage.updateProjectDocument(documentId, {
        extractionStatus: "complete",
        extractionError: "",
        extractedText: text,
      });
    } catch (err: any) {
      console.error("Project document processing failed:", err);
      try {
        await storage.updateProjectDocument(documentId, {
          extractionStatus: "error",
          extractionError: err?.message || String(err),
        });
      } catch {}
    }
  }

  app.post("/api/projects/:projectId/documents", projectDocUpload.single("file"), async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      if (!Number.isFinite(projectId)) {
        return res.status(400).json({ message: "Invalid projectId" });
      }
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const body = req.body || {};
      const titleField = (body.title || "").trim() || req.file.originalname;

      const doc = await storage.createProjectDocument({
        projectId,
        originalName: req.file.originalname,
        filePath: req.file.path,
        mimeType: req.file.mimetype || "",
        fileSize: req.file.size || 0,
        uploadedAt: new Date().toISOString(),
        author: (body.author || "").toString(),
        year: (body.year || "").toString(),
        title: titleField,
        publisher: (body.publisher || "").toString(),
        documentType: (body.documentType || "").toString(),
        notes: (body.notes || "").toString(),
        extractionStatus: "pending",
        extractionError: "",
        extractedText: "",
      });

      processProjectDocument(doc.id).catch((err) => console.error("Background project-doc processing error:", err));
      res.status(201).json(doc);
    } catch (err: any) {
      console.error("Project document upload error:", err);
      res.status(500).json({ message: err.message || "Upload failed" });
    }
  });

  app.get("/api/projects/:projectId/documents", async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) {
      return res.status(400).json({ message: "Invalid projectId" });
    }
    const docs = await storage.getProjectDocuments(projectId);
    res.json(docs);
  });

  app.patch("/api/project-documents/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const body = req.body || {};
      // Only accept bibliographic / display fields here
      const patch: Record<string, unknown> = {};
      const ALLOWED = ["author", "year", "title", "publisher", "documentType", "notes"];
      for (const k of ALLOWED) {
        if (k in body) patch[k] = (body[k] ?? "").toString();
      }
      const updated = await storage.updateProjectDocument(id, patch as any);
      if (!updated) return res.status(404).json({ message: "Document not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Update failed" });
    }
  });

  app.delete("/api/project-documents/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    await storage.deleteProjectDocument(id);
    res.status(204).end();
  });

  app.get("/api/project-documents/:id/file", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await storage.getProjectDocument(id);
    if (!doc) return res.status(404).json({ message: "Document not found" });
    if (!doc.filePath || !fs.existsSync(doc.filePath)) {
      return res.status(404).json({ message: "File missing on disk" });
    }
    res.download(doc.filePath, doc.originalName);
  });

  // === REPORT LIBRARY (RAG) ===
  const reportsDir = path.join(uploadDir, "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const reportUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, reportsDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok =
        file.mimetype === "application/pdf" ||
        file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        /\.(pdf|docx)$/i.test(file.originalname);
      if (ok) cb(null, true);
      else cb(new Error("Only PDF or DOCX files are allowed"));
    },
  });

  /**
   * Background ingestion of finalised in-app project narratives into the
   * Report Library. Triggered after a successful Word export. Idempotent —
   * passages already present with the same source project + textHash are
   * skipped. Failures are logged, never thrown, never block the response.
   */
  async function ingestProjectNarrativesIntoLibrary(projectId: number) {
    try {
      const { embedBatch } = await import("./embeddings");
      const project = await storage.getProject(projectId);
      if (!project) return;
      const allObservations = await storage.getObservationsByProject(projectId);
      const candidates = allObservations
        .map(o => ({ obs: o, text: (o.aiNarrative || "").trim() }))
        .filter(c => c.text.length > 0);
      if (candidates.length === 0) {
        console.log(`[auto-ingest] project ${projectId}: no narratives to ingest`);
        return;
      }
      const projectLabel = `In-app project: ${project.name} (${projectId})`;
      const created: { id: string; text: string }[] = [];
      for (const { obs, text } of candidates) {
        const textHash = crypto.createHash("sha256").update(text).digest("hex");
        const existing = await (storage as any).findPassageByProjectAndHash(projectId, textHash);
        if (existing) continue;
        const passage = await storage.createPassage({
          id: crypto.randomUUID(),
          documentId: `inapp-project-${projectId}`,
          category: "narrative",
          text,
          embedding: null,
          sourceSection: `${projectLabel} — observation ${obs.observationId || obs.id}`,
          sourceProjectId: projectId as any,
          textHash: textHash as any,
          createdAt: new Date().toISOString(),
        } as any);
        created.push({ id: passage.id, text: passage.text });
      }
      // Embed in batches of 10 — same pattern as processReportDocument
      for (let i = 0; i < created.length; i += 10) {
        const batch = created.slice(i, i + 10);
        try {
          const embeddings = await embedBatch(batch.map((b) => b.text));
          for (let j = 0; j < batch.length; j++) {
            await storage.updatePassage(batch[j].id, {
              embedding: JSON.stringify(embeddings[j]),
            });
          }
        } catch (err: any) {
          console.warn("[auto-ingest] embedding batch failed, leaving passages without embedding:", err?.message || err);
        }
      }
      console.log(`[auto-ingest] project ${projectId}: created ${created.length} passage${created.length === 1 ? "" : "s"} (out of ${candidates.length} candidates)`);
    } catch (err: any) {
      console.error(`[auto-ingest] failed for project ${projectId}:`, err?.message || err);
    }
  }

  async function processReportDocument(documentId: string) {
    const { extractPassages } = await import("./reportExtraction");
    const { embedBatch } = await import("./embeddings");

    try {
      await storage.updateReportDocument(documentId, { extractionStatus: "processing" });
      const doc = await storage.getReportDocument(documentId);
      if (!doc) return;

      const extracted = await extractPassages(doc.filePath, doc.mimeType || "");

      // Create passage records without embeddings first
      const createdPassages = [] as { id: string; text: string }[];
      for (const p of extracted) {
        const passage = await storage.createPassage({
          id: crypto.randomUUID(),
          documentId,
          category: p.category,
          text: p.text,
          embedding: null,
          sourceSection: p.sourceSection,
          createdAt: new Date().toISOString(),
        });
        createdPassages.push({ id: passage.id, text: passage.text });
      }

      // Embed in batches of 10
      for (let i = 0; i < createdPassages.length; i += 10) {
        const batch = createdPassages.slice(i, i + 10);
        try {
          const embeddings = await embedBatch(batch.map((b) => b.text));
          for (let j = 0; j < batch.length; j++) {
            await storage.updatePassage(batch[j].id, {
              embedding: JSON.stringify(embeddings[j]),
            });
          }
        } catch (err: any) {
          console.warn(`Embedding batch failed, skipping:`, err?.message || err);
        }
      }

      await storage.updateReportDocument(documentId, { extractionStatus: "complete" });
    } catch (err: any) {
      console.error("Report processing failed:", err);
      await storage.updateReportDocument(documentId, {
        extractionStatus: "error",
        extractionError: err?.message || String(err),
      });
    }
  }

  app.post("/api/report-library/upload", reportUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const id = crypto.randomUUID();
      const doc = await storage.createReportDocument({
        id,
        originalName: req.file.originalname,
        filePath: req.file.path,
        mimeType: req.file.mimetype || "",
        fileSize: req.file.size || 0,
        uploadedAt: new Date().toISOString(),
        extractionStatus: "pending",
        extractionError: "",
      });
      // Fire and forget
      processReportDocument(id).catch((err) => console.error("Background processing error:", err));
      res.status(201).json(doc);
    } catch (err: any) {
      console.error("Report upload error:", err);
      res.status(500).json({ message: err.message || "Upload failed" });
    }
  });

  app.get("/api/report-library/documents", async (_req, res) => {
    const docs = await storage.getReportDocuments();
    const enriched = await Promise.all(docs.map(async (d) => {
      const passages = await storage.getPassagesByDocument(d.id);
      return { ...d, passageCount: passages.length };
    }));
    res.json(enriched);
  });

  app.get("/api/report-library/documents/:id/passages", async (req, res) => {
    const passages = await storage.getPassagesByDocument(req.params.id);
    res.json(passages);
  });

  app.delete("/api/report-library/documents/:id", async (req, res) => {
    await storage.deleteReportDocument(req.params.id);
    res.status(204).end();
  });

  app.delete("/api/report-library/passages/:id", async (req, res) => {
    await storage.deletePassage(req.params.id);
    res.status(204).end();
  });

  // Auto-ingested passages (from completed in-app projects). Used by the
  // Settings → Report Library UI to show project-derived style references
  // separately from manually uploaded report passages.
  app.get("/api/report-library/auto-ingested", async (_req, res) => {
    const rows = await (storage as any).getAutoIngestedPassages();
    const projectMap: Record<number, string> = {};
    for (const p of rows) {
      const pid = (p as any).sourceProjectId as number | null;
      if (pid && !(pid in projectMap)) {
        const proj = await storage.getProject(pid);
        projectMap[pid] = proj?.name || `Project ${pid}`;
      }
    }
    res.json(rows.map((p: any) => ({
      id: p.id,
      category: p.category,
      text: p.text,
      sourceSection: p.sourceSection,
      sourceProjectId: p.sourceProjectId,
      sourceProjectName: p.sourceProjectId ? projectMap[p.sourceProjectId] : null,
      createdAt: p.createdAt,
    })));
  });

  app.get("/api/report-library/status/:id", async (req, res) => {
    const doc = await storage.getReportDocument(req.params.id);
    if (!doc) return res.status(404).json({ message: "Document not found" });
    const passages = await storage.getPassagesByDocument(req.params.id);
    res.json({
      status: doc.extractionStatus,
      passageCount: passages.length,
      error: doc.extractionError || null,
    });
  });

  // === PHOTO EXPORT (ZIP) ===
  app.get("/api/export/photos/:projectId", async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const allObservations = await storage.getObservationsByProject(projectId);
      const systems = await storage.getSystemsByProject(projectId);

      // Collect all photos: system photos + observation photos
      const allPhotos: { photo: Photo; folder: string }[] = [];

      for (const sys of systems) {
        const sysPhotos = await storage.getPhotosBySystem(sys.id);
        for (const p of sysPhotos) {
          const safeName = sys.name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || `System-${sys.id}`;
          allPhotos.push({ photo: p, folder: `Systems/${safeName}` });
        }
      }

      for (const obs of allObservations) {
        const obsPhotos = await storage.getPhotosByObservation(obs.id);
        for (const p of obsPhotos) {
          const safeId = obs.observationId.replace(/[^a-zA-Z0-9_\-.]/g, "") || `Obs-${obs.id}`;
          allPhotos.push({ photo: p, folder: `Observations/${safeId}` });
        }
      }

      if (allPhotos.length === 0) {
        return res.status(404).json({ message: "No photos to download" });
      }

      const archiver = require("archiver");
      const archive = archiver("zip", { zlib: { level: 5 } });
      const safeProjName = (project.afcReference || project.name).replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeProjName}-Photos.zip"`);
      archive.pipe(res);

      for (const { photo, folder } of allPhotos) {
        const filePath = path.join(uploadDir, photo.filename);
        if (!fs.existsSync(filePath)) continue;
        const ext = path.extname(photo.filename);
        const displayName = photo.caption
          ? `${photo.caption.replace(/[^a-zA-Z0-9_\- ]/g, "")}${ext}`
          : photo.filename;
        archive.file(filePath, { name: `${folder}/${displayName}` });
      }

      await archive.finalize();
    } catch (err: any) {
      console.error("Photo export error:", err);
      if (!res.headersSent) {
        res.status(500).json({ message: err.message || "Photo export failed" });
      }
    }
  });

  // === ANNOTATED ELEVATIONS ZIP EXPORT ===
  app.get("/api/export/elevations/:projectId", async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const projectElevations = await storage.getElevationsByProject(projectId);
      projectElevations.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
      const allObservations = await storage.getObservationsByProject(projectId);
      const projectDrops = await storage.getDropsByProject(projectId);
      projectDrops.sort((a, b) => a.id - b.id);

      // Helper to render an annotated image (elevation or roof plan) to a JPEG buffer.
      const renderAnnotated = async (
        srcPath: string,
        markers: { cx: number; cy: number; label: string; color: string }[]
      ): Promise<Buffer | null> => {
        try {
          const baseImg = sharp(srcPath);
          const meta = await baseImg.metadata();
          const W = meta.width || 1600;
          const H = meta.height || 1200;
          const radius = Math.max(24, Math.round(Math.min(W, H) * 0.02));
          const fontSize = Math.round(radius * 0.75);
          const svgPins = markers.map((m) => {
            const cx = Math.round((m.cx / 10000) * W);
            const cy = Math.round((m.cy / 10000) * H);
            const label = (m.label || "").replace(/[<>&"']/g, "");
            return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${m.color}" stroke="white" stroke-width="3" />
<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${label}</text>`;
          }).join("");
          const svgOverlay = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgPins}</svg>`
          );
          return await baseImg
            .composite([{ input: svgOverlay, top: 0, left: 0 }])
            .jpeg({ quality: 90 })
            .toBuffer();
        } catch (err) {
          console.warn("Failed to render annotated image:", err);
          try { return fs.readFileSync(srcPath); } catch { return null; }
        }
      };

      // Pre-render everything so we can return 404 cleanly if there is nothing.
      type ZipEntry = { buf: Buffer; name: string };
      const entries: ZipEntry[] = [];

      for (const elev of projectElevations) {
        const srcPath = path.join(elevationDir, elev.filename);
        if (!fs.existsSync(srcPath)) continue;
        const pins = await storage.getPinsByElevation(elev.id);
        const markers = pins.map((pin) => {
          const obs = allObservations.find(o => o.id === pin.observationId);
          const color = obs?.severity === "Safety/Risk" ? "#EF4444"
            : obs?.severity === "Essential" ? "#F97316"
            : obs?.severity === "Desirable" ? "#EAB308"
            : "#22C55E";
          return { cx: pin.x, cy: pin.y, label: obs?.observationId || String(pin.id), color };
        });
        const buf = await renderAnnotated(srcPath, markers);
        if (!buf) continue;
        const safeName = (elev.name || `Elevation-${elev.id}`).replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
        entries.push({ buf, name: `Elevations/Elevation - ${safeName}.jpg` });
      }

      if (project.roofPlanImagePath) {
        const roofPlanFilename = path.basename(project.roofPlanImagePath);
        const roofPlanPath = path.join(roofPlanDir, roofPlanFilename);
        if (fs.existsSync(roofPlanPath)) {
          const markers = projectDrops.map((d) => ({
            cx: d.x, cy: d.y, label: d.dropNumber || String(d.id), color: "#00B5B8",
          }));
          const buf = await renderAnnotated(roofPlanPath, markers);
          if (buf) {
            entries.push({ buf, name: `Roof Plan/Roof Plan.jpg` });
          }
        }
      }

      if (entries.length === 0) {
        return res.status(404).json({ message: "No elevations or roof plan to download" });
      }

      const archiver = require("archiver");
      const archive = archiver("zip", { zlib: { level: 5 } });
      const safeProjName = (project.afcReference || project.name).replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeProjName}-Elevations.zip"`);
      archive.pipe(res);
      for (const e of entries) archive.append(e.buf, { name: e.name });
      await archive.finalize();
    } catch (err: any) {
      console.error("Elevations export error:", err);
      if (!res.headersSent) {
        res.status(500).json({ message: err.message || "Elevations export failed" });
      }
    }
  });

  // === WORD EXPORT ===
  app.get("/api/export/word/:projectId", async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const v2 = isV2(project as any);

      // ---- v2 house style (Stage 2 formatting) ----
      // Legacy projects keep the original Arial/teal look. For v2 projects every
      // TextRun / Paragraph created in this handler is passed through a small
      // style map so the export matches the AFC final report without touching
      // each of the ~130 call sites:
      //   H1 20pt #3A3A3A regular, H2 16pt black regular, H3 14pt black regular,
      //   body Aptos 11pt black, list markers ("1.", "a.", "iv.") teal 10pt,
      //   bullets as teal squares, headings collected for the CONTENTS page.
      // Pass `__raw: true` on a TextRun to opt out of the map (cover, captions...).
      const V2_FONT = "Aptos";
      const V2_LIST_TEAL = "52C6CC";
      const V2_RULE_TEAL = "00CDC8";
      const V2_HEAD_GREY = "3A3A3A";
      const v2RunText = new WeakMap<object, string>();
      const mapV2Run = (o: any): any => {
        if (!o || typeof o !== "object") return o;
        if (o.__raw) { const { __raw, ...r } = o; return { font: V2_FONT, ...r }; }
        const r: any = { ...o };
        if (!r.font || r.font === "Arial") r.font = V2_FONT;
        const isMarker = typeof r.text === "string" && /^\s*(\d+|[a-z]|[ivx]+)\.[\t ]?$/i.test(r.text);
        if (r.bold && r.size === 36) { r.size = 40; r.bold = false; r.color = V2_HEAD_GREY; }
        else if (r.bold && r.size === 28) { r.size = 32; r.bold = false; r.color = "000000"; }
        else if (r.bold && r.size === 24 && r.color === "333333") { r.size = 28; r.bold = false; r.color = "000000"; }
        else if (isMarker) { r.color = V2_LIST_TEAL; r.bold = false; r.size = Math.max(16, (r.size || 22) - 2); }
        else if (r.color === "333333") r.color = "000000";
        return r;
      };
      // Shadow the docx classes inside this handler only (types still resolve to the imports).
      const TextRun = class extends DocxTextRun {
        constructor(o: any) {
          const m = v2 ? mapV2Run(o) : o;
          super(m);
          if (m && typeof m === "object" && typeof m.text === "string") v2RunText.set(this, m.text);
          else if (typeof m === "string") v2RunText.set(this, m);
        }
      } as typeof DocxTextRun;
      const v2Toc = new WeakMap<object, { title: string; level: number }>();
      const HEADING_LEVEL_NUM: Record<string, number> = { [HeadingLevel.HEADING_1]: 1, [HeadingLevel.HEADING_2]: 2, [HeadingLevel.HEADING_3]: 3 };
      const Paragraph = class extends DocxParagraph {
        constructor(o: any) {
          let m = o;
          if (v2 && o && typeof o === "object") {
            m = { ...o };
            if (m.bullet) { m.numbering = { reference: "v2-bullet", level: m.bullet.level || 0 }; delete m.bullet; }
            if (m.heading) m.keepNext = true;
          }
          super(m);
          if (v2 && m && typeof m === "object" && m.heading && HEADING_LEVEL_NUM[m.heading]) {
            const title = (m.children || []).map((c: any) => v2RunText.get(c) || "").join("").trim();
            if (title) v2Toc.set(this, { title, level: HEADING_LEVEL_NUM[m.heading] });
          }
        }
      } as typeof DocxParagraph;
      // A4 with 0.5" side margins (v2) → 10466 twips of text width.
      const TEXT_W = v2 ? 10466 : 9026;
      const REPORT_TITLE = v2 ? reportTitleOf(project as any) : "FACADE DUE DILIGENCE REPORT";
      // v2 Issues: ordered list (top-level then sub-issues), numbered from 4.2.
      const rawIssues = v2 ? await storage.getIssuesByProject(projectId) : [];
      const orderedIssues: { issue: ReportIssue; number: string; depth: number }[] = [];
      {
        const top = rawIssues.filter(i => !i.parentId || !rawIssues.some(p => p.id === i.parentId));
        top.forEach((t, n) => {
          orderedIssues.push({ issue: t, number: `4.${n + 2}`, depth: 0 });
          rawIssues.filter(c => c.parentId === t.id).forEach((c, m) => orderedIssues.push({ issue: c, number: `4.${n + 2}.${m + 1}`, depth: 1 }));
        });
      }
      const useIssues = orderedIssues.length > 0;
      const jsonIds = (raw: string | null | undefined): number[] => { try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };
      const systems = await storage.getSystemsByProject(projectId);
      const allObservations = await storage.getObservationsByProject(projectId);
      const allRecommendations = await storage.getRecommendationsByProject(projectId);
      // Budget IDs follow the issue numbering (4.2-1, 4.2-2 …) when issues are used.
      const budgetIdByRec = new Map<number, { id: string; anchor: string; issueTitle?: string }>();
      for (const { issue, number } of orderedIssues) {
        const linked = jsonIds(issue.observationIds);
        const recs = [
          ...linked.flatMap(oid => allRecommendations.filter(r => r.observationId === oid && !(r as any).issueId)),
          ...allRecommendations.filter(r => (r as any).issueId === issue.id),
        ];
        let k = 1;
        for (const r of recs) {
          if (budgetIdByRec.has(r.id)) continue;
          budgetIdByRec.set(r.id, { id: `${number}-${k++}`, anchor: number, issueTitle: (r as any).issueId ? issue.title : undefined });
        }
      }
      const projectDocs = await storage.getProjectDocuments(projectId);

      // Fetch photos for each system and observation
      const systemPhotosMap: Record<number, Photo[]> = {};
      for (const sys of systems) {
        systemPhotosMap[sys.id] = await storage.getPhotosBySystem(sys.id);
      }
      const obsPhotosMap: Record<number, Photo[]> = {};
      for (const obs of allObservations) {
        obsPhotosMap[obs.id] = await storage.getPhotosByObservation(obs.id);
      }
      // Additional locations per observation (multi-location feature)
      const obsLocationsMap: Record<number, Awaited<ReturnType<typeof storage.getObservationLocations>>> = {};
      for (const obs of allObservations) {
        obsLocationsMap[obs.id] = await storage.getObservationLocations(obs.id);
      }
      const formatLocLabel = (drop?: string | null, elev?: string | null, level?: string | null): string => {
        const parts = [
          drop ? `Drop ${drop}` : "",
          elev ? `${elev} Elevation` : "",
          level ? `L${level}` : "",
        ].filter(Boolean);
        return parts.join(", ");
      };

      // Sort systems by sortOrder then id
      systems.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);

      // Group observations by system
      const obsBySystem: Record<number, Observation[]> = {};
      const unlinkedObs: Observation[] = [];
      for (const obs of allObservations) {
        if (obs.systemId) {
          if (!obsBySystem[obs.systemId]) obsBySystem[obs.systemId] = [];
          obsBySystem[obs.systemId].push(obs);
        } else {
          unlinkedObs.push(obs);
        }
      }

      // Map recommendations by observation id
      const recsByObs: Record<number, Recommendation[]> = {};
      for (const rec of allRecommendations) {
        if (!recsByObs[rec.observationId]) recsByObs[rec.observationId] = [];
        recsByObs[rec.observationId].push(rec);
      }

      // Helper: sanitize bookmark id (only alphanumeric and underscores)
      const sanitizeBookmark = (obsId: string) => `obs_${obsId.replace(/[^a-zA-Z0-9]/g, "_")}`;

      // Bookmark numeric ID counter
      let bookmarkLinkId = 1;
      const bookmarkIdMap: Record<string, number> = {}; // obsId → numeric linkId
      const getBookmarkLinkId = (obsId: string): number => {
        if (!bookmarkIdMap[obsId]) {
          bookmarkIdMap[obsId] = bookmarkLinkId++;
        }
        return bookmarkIdMap[obsId];
      };

      // Helper: parse JSON safely
      const safeJsonArray = (str: string | null | undefined): any[] => {
        if (!str) return [];
        try { return JSON.parse(str); } catch { return []; }
      };

      // Helper: format date
      const formatDate = (dateStr: string) => {
        try {
          const d = new Date(dateStr);
          return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
        } catch { return dateStr; }
      };

      // Color constants
      const TEAL = "00B5B8";
      const WHITE = "FFFFFF";
      const BLACK = "000000";
      const DARK_GRAY = "333333";
      const MUTED = "666666";
      const ALT_ROW = "F5F5F5";

      // Render narrative text into structured docx paragraphs.
      // Recognises:
      //   "1. **Heading**:" / "1. Heading:"          → bold numbered heading line
      //   "   a. detail" / "a. detail"               → lettered sub-item, indented
      //   "   i. detail" / "i. detail"               → roman numeral sub-sub-item, more indented
      //   "**bold**" inline                          → bold run
      //   blank line                                 → paragraph break
      // Anything else renders as a plain paragraph.
      const renderNarrativeParagraphs = (
        narrative: string,
        opts: { fontSize?: number; afterSpacing?: number; plainIndent?: number } = {}
      ): Paragraph[] => {
        const fontSize = opts.fontSize ?? 22;
        const afterSpacing = opts.afterSpacing ?? 100;
        const out: Paragraph[] = [];
        if (!narrative) return out;
        const lines = narrative.split(/\r?\n/);

        // Build inline runs from a string with optional **bold** markers.
        const buildRuns = (text: string, baseProps: { bold?: boolean; italics?: boolean; color?: string } = {}): TextRun[] => {
          const runs: TextRun[] = [];
          const re = /\*\*([^*]+)\*\*/g;
          let lastIdx = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            if (m.index > lastIdx) {
              runs.push(new TextRun({ text: text.slice(lastIdx, m.index), font: "Arial", size: fontSize, ...baseProps }));
            }
            runs.push(new TextRun({ text: m[1], font: "Arial", size: fontSize, ...baseProps, bold: true }));
            lastIdx = m.index + m[0].length;
          }
          if (lastIdx < text.length) {
            runs.push(new TextRun({ text: text.slice(lastIdx), font: "Arial", size: fontSize, ...baseProps }));
          }
          if (runs.length === 0) {
            runs.push(new TextRun({ text, font: "Arial", size: fontSize, ...baseProps }));
          }
          return runs;
        };

        for (const rawLine of lines) {
          const line = rawLine.replace(/\s+$/, "");
          if (!line.trim()) continue;

          // Numbered heading: "1. ..." (with optional bold or trailing colon)
          const numMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
          // Lettered sub-item: "a." or "  b."
          const letterMatch = line.match(/^\s*([a-z])\.\s+(.*)$/i);
          // Roman numeral sub-sub-item: "i.", "ii.", "iii.", "iv.", etc.
          const romanMatch = line.match(/^\s*((?:x{0,3})(?:i{1,3}|iv|v|vi{0,3}|ix))\.\s+(.*)$/i);
          // Bullet
          const bulletMatch = line.match(/^\s*[\-•]\s+(.*)$/);

          if (romanMatch && /^\s{2,}/.test(rawLine)) {
            // Indented roman numerals → sub-sub-item
            out.push(new Paragraph({
              children: [
                new TextRun({ text: `${romanMatch[1]}.${v2 ? "\t" : " "}`, font: "Arial", size: fontSize, bold: false }),
                ...buildRuns(romanMatch[2]),
              ],
              ...(v2 ? { indent: { left: 1080, hanging: 360 }, tabStops: [{ type: TabStopType.LEFT, position: 1080 }] } : { indent: { left: 1080 } }),
              spacing: { after: 60 },
            }));
            continue;
          }

          if (letterMatch) {
            out.push(new Paragraph({
              children: [
                new TextRun({ text: `${letterMatch[1]}.${v2 ? "\t" : " "}`, font: "Arial", size: fontSize, bold: false }),
                ...buildRuns(letterMatch[2]),
              ],
              ...(v2 ? { indent: { left: 720, hanging: 360 }, tabStops: [{ type: TabStopType.LEFT, position: 720 }] } : { indent: { left: 720 } }),
              spacing: { after: 60 },
            }));
            continue;
          }

          if (numMatch) {
            // Strip optional trailing colon and ** markers in the heading
            const headingText = numMatch[2];
            out.push(new Paragraph({
              children: [
                new TextRun({ text: `${numMatch[1]}.${v2 ? "\t" : " "}`, font: "Arial", size: fontSize, bold: true, color: DARK_GRAY }),
                ...buildRuns(headingText, { bold: true, color: DARK_GRAY }),
              ],
              ...(v2 ? { indent: { left: 360 + (opts.plainIndent || 0), hanging: 360 }, tabStops: [{ type: TabStopType.LEFT, position: 360 + (opts.plainIndent || 0) }] } : {}),
              spacing: { before: 100, after: 60 },
            }));
            continue;
          }

          if (bulletMatch) {
            out.push(new Paragraph({
              children: buildRuns(bulletMatch[1]),
              bullet: { level: 0 },
              spacing: { after: 60 },
            }));
            continue;
          }

          out.push(new Paragraph({
            children: buildRuns(line),
            ...(opts.plainIndent ? { indent: { left: opts.plainIndent } } : {}),
            spacing: { after: afterSpacing },
          }));
        }
        return out;
      };

      // Helper: read photo from disk and return ImageRun or null
      const embedPhoto = (filename: string, caption: string, maxWidth: number): ImageRun | null => {
        const filePath = path.join(uploadDir, filename);
        if (!fs.existsSync(filePath)) {
          console.warn(`Photo file not found: ${filePath}`);
          return null;
        }
        try {
          const data = fs.readFileSync(filePath);
          const ext = path.extname(filename).toLowerCase();
          let type: "jpg" | "png" | "gif" | "bmp" = "jpg";
          if (ext === ".png") type = "png";
          else if (ext === ".gif") type = "gif";
          else if (ext === ".bmp") type = "bmp";

          return new ImageRun({
            data,
            transformation: { width: maxWidth, height: Math.round(maxWidth * 0.75) },
            type,
            altText: { title: caption || filename, description: caption || "", name: filename },
          });
        } catch (err) {
          console.warn(`Failed to read photo ${filename}:`, err);
          return null;
        }
      };

      // Helper: create photo rows (2 per row) with captions
      // photoLocationLabels: optional map from photo.id -> location label (e.g. "Drop 5, South Elevation")
      const buildPhotoRows = (
        photoList: Photo[],
        figureCounter: { n: number },
        photoLocationLabels?: Record<number, string>
      ): Paragraph[] => {
        const paragraphs: Paragraph[] = [];
        const tagFor = (photo: Photo, baseCaption: string): string => {
          const loc = photoLocationLabels?.[photo.id];
          if (!loc) return baseCaption;
          return baseCaption ? `${baseCaption} (${loc})` : `(${loc})`;
        };
        for (let i = 0; i < photoList.length; i += 2) {
          const rowChildren: (ImageRun | TextRun)[] = [];
          const photo1 = embedPhoto(photoList[i].filename, photoList[i].caption || "", 240);
          if (photo1) {
            rowChildren.push(photo1);
            if (i + 1 < photoList.length) {
              rowChildren.push(new TextRun({ text: "    " }));
              const photo2 = embedPhoto(photoList[i + 1].filename, photoList[i + 1].caption || "", 240);
              if (photo2) rowChildren.push(photo2);
            }
          }
          if (rowChildren.length > 0) {
            paragraphs.push(new Paragraph({ children: rowChildren, spacing: { before: 100, after: 50 } }));
            // Captions (with optional location tag)
            const cap1 = tagFor(photoList[i], photoList[i].caption || "");
            const capText = `Figure ${figureCounter.n}${cap1 ? ` \u2013 ${cap1}` : ""}`;
            figureCounter.n++;
            let capLine = capText;
            if (i + 1 < photoList.length) {
              const cap2 = tagFor(photoList[i + 1], photoList[i + 1].caption || "");
              capLine += `          Figure ${figureCounter.n}${cap2 ? ` \u2013 ${cap2}` : ""}`;
              figureCounter.n++;
            }
            paragraphs.push(new Paragraph({
              children: [new TextRun({ text: capLine, font: "Arial", size: 18, italics: true, color: MUTED })],
              spacing: { after: 150 },
            }));
          }
        }
        return paragraphs;
      };

      // v2 photos: EXIF-rotated, down-sampled JPEGs (keeps the .docx small), laid out
      // in a borderless table with a "Figure N – caption" under each photo, a thin
      // blue outline, and either 2-up 4:3 crops (issues) or one full-width photo
      // per row at its natural aspect (façade description), as in the final report.
      const v2PhotoCache = new Map<string, { data: Buffer; w: number; h: number } | null>();
      const prepV2Photo = async (filename: string, crop43: boolean) => {
        const key = `${filename}|${crop43}`;
        if (v2PhotoCache.has(key)) return v2PhotoCache.get(key)!;
        const filePath = path.join(uploadDir, filename);
        let out: { data: Buffer; w: number; h: number } | null = null;
        try {
          if (fs.existsSync(filePath)) {
            const img = sharp(filePath).rotate();
            const r = await (crop43
              ? img.resize({ width: 1200, height: 900, fit: "cover", position: "centre" })
              : img.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
            ).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
            out = { data: r.data, w: r.info.width, h: r.info.height };
          } else console.warn(`Photo file not found: ${filePath}`);
        } catch (err) { console.warn(`Failed to process photo ${filename}:`, err); }
        v2PhotoCache.set(key, out);
        return out;
      };
      const V2_CAPTION_BLUE = "0E2841";
      const V2_PHOTO_OUTLINE = { type: "solidFill", solidFillType: "rgb", value: "156082", width: 9144 } as const;
      const buildPhotoGridV2 = async (
        photoList: Photo[], figureCounter: { n: number }, opts: { single?: boolean } = {},
      ): Promise<(Paragraph | Table)[]> => {
        const perRow = opts.single ? 1 : 2;
        const colW = Math.floor(TEXT_W / perRow);
        const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
        const cells: TableCell[] = [];
        for (const ph of photoList) {
          const img = await prepV2Photo(ph.filename, !opts.single);
          if (!img) continue;
          // px at 96 dpi: 2-up ≈ 3.4" wide, single ≈ 6.1" wide (max 4.6" tall)
          let w = opts.single ? 585 : 330;
          let h = Math.round(w * img.h / img.w);
          const maxH = opts.single ? 440 : 248;
          if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
          const cap = (ph.caption || "").trim();
          const capText = `Figure ${figureCounter.n++}${cap ? ` \u2013 ${cap}` : ""}`;
          cells.push(new TableCell({
            width: { size: colW, type: WidthType.DXA },
            borders: { top: none, bottom: none, left: none, right: none },
            margins: { top: 60, bottom: 120, left: 0, right: perRow > 1 ? 180 : 0 },
            children: [
              new Paragraph({ children: [new ImageRun({ data: img.data, type: "jpg", transformation: { width: w, height: h }, outline: V2_PHOTO_OUTLINE as any, altText: { title: cap || ph.filename, description: cap, name: ph.filename } } as any)], spacing: { after: 40 } }),
              new Paragraph({ children: [new TextRun({ __raw: true, text: capText, size: 18, bold: true, color: V2_CAPTION_BLUE } as any)], spacing: { after: 0 } }),
            ],
          }));
        }
        if (!cells.length) return [];
        const rows: TableRow[] = [];
        for (let i = 0; i < cells.length; i += perRow) {
          const rc = cells.slice(i, i + perRow);
          while (rc.length < perRow) rc.push(new TableCell({ width: { size: colW, type: WidthType.DXA }, borders: { top: none, bottom: none, left: none, right: none }, children: [new Paragraph({ children: [] })] }));
          rows.push(new TableRow({ children: rc, cantSplit: true }));
        }
        return [
          new Table({ layout: TableLayoutType.FIXED, width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: Array(perRow).fill(colW), borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none }, rows } as any),
          new Paragraph({ children: [], spacing: { after: 120 } }),
        ];
      };

      // Helper: render "Also observed at" block + return per-photo location label map
      const buildAlsoObservedAtBlock = (obsId: number): {
        paragraphs: Paragraph[];
        photoLabels: Record<number, string>;
      } => {
        const paragraphs: Paragraph[] = [];
        const photoLabels: Record<number, string> = {};
        const locs = obsLocationsMap[obsId] || [];
        if (locs.length === 0) return { paragraphs, photoLabels };
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: "Also observed at:", font: "Arial", size: 22, bold: true })],
          spacing: { before: 50, after: 50 },
        }));
        for (const loc of locs) {
          const label = formatLocLabel(loc.drop, loc.elevation, loc.level) || "(unspecified)";
          const desc = (loc.description || "").trim();
          paragraphs.push(new Paragraph({
            children: [
              new TextRun({ text: `\u2022 ${label}`, font: "Arial", size: 22 }),
              ...(desc ? [new TextRun({ text: ` \u2014 ${desc}`, font: "Arial", size: 22, italics: true, color: MUTED })] : []),
            ],
            spacing: { after: 30 },
          }));
        }
        // Build photo\u2192label map for figure tagging
        const allObsPhotos = obsPhotosMap[obsId] || [];
        for (const p of allObsPhotos) {
          const lid = (p as any).locationId as number | null;
          if (lid != null) {
            const loc = locs.find(l => l.id === lid);
            if (loc) {
              photoLabels[p.id] = formatLocLabel(loc.drop, loc.elevation, loc.level) || "additional location";
            }
          }
        }
        return { paragraphs, photoLabels };
      };

      // Teal border for headers/footers
      const tealBorder = { style: BorderStyle.SINGLE, size: 6, color: TEAL };
      const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };

      // v2 header/footer: 8pt grey uppercase text between thin teal rules.
      const v2Rule = { style: BorderStyle.SINGLE, size: 4, color: V2_RULE_TEAL };
      const v2HF = (text: string) => new TextRun({ __raw: true, text, size: 16, color: V2_HEAD_GREY } as any);
      const contentHeaderV2 = new Header({
        children: [new Paragraph({
          children: [v2HF((project.address || project.name || "").toUpperCase()), new TextRun({ __raw: true, text: "\t" } as any), v2HF("ANGEL FA\u00C7ADE CONSULTING PTY LTD")],
          tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }],
          border: { bottom: v2Rule },
          spacing: { after: 0 },
        })],
      });
      const contentFooterV2 = new Footer({
        children: [new Paragraph({
          children: [
            v2HF(REPORT_TITLE.toUpperCase()),
            new TextRun({ __raw: true, text: "\t" } as any),
            new TextRun({ __raw: true, children: ["Page ", PageNumber.CURRENT], size: 16, color: V2_HEAD_GREY } as any),
          ],
          tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }],
          border: { top: v2Rule },
          spacing: { before: 0 },
        })],
      });

      // Common header for content sections
      const contentHeader = v2 ? contentHeaderV2 : new Header({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: project.address, font: "Arial", size: 18, color: TEAL }),
              new TextRun({ text: "\t" }),
              new TextRun({ text: "ANGEL FA\u00C7ADE CONSULTING", font: "Arial", size: 18, color: TEAL, bold: true }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
            border: { bottom: tealBorder },
            spacing: { after: 100 },
          }),
        ],
      });

      // Common footer for content sections
      const contentFooter = v2 ? contentFooterV2 : new Footer({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: REPORT_TITLE, font: "Arial", size: 16, color: MUTED }),
              new TextRun({ text: "\t" }),
              new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: MUTED }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
            border: { top: tealBorder },
            spacing: { before: 100 },
          }),
        ],
      });

      // Helper: build a CAPEX table row
      const buildCapexRow = (
        obsId: string, location: string, defect: string, action: string,
        timeframe: string, category: string, budget: string,
        isHeader: boolean, isAlt: boolean, withLink: boolean, anchorOverride?: string
      ): TableRow => {
        const bgColor = isHeader ? TEAL : isAlt ? ALT_ROW : WHITE;
        const textColor = isHeader ? WHITE : BLACK;
        const fontSize = isHeader ? 18 : 16;
        const bold = isHeader;

        const cellProps = (width: number) => ({
          width: { size: width, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: bgColor },
          verticalAlign: VerticalAlign.CENTER,
        });

        const textRun = (text: string) => new TextRun({ text, font: "Arial", size: fontSize, color: textColor, bold });

        if (v2) {
          // v2: plain white grid, grey rules, bold header/IDs, red Safety/Risk,
          // "MAJOR RENEWAL:" bolded in actions, shaded budget-total rows. 10pt.
          const isTotal = isAlt;
          const W2 = [850, 1300, 1300, 3316, 1300, 1200, 1200];
          const run = (text: string, extra: any = {}) => new TextRun({ __raw: true, text, size: 20, color: isHeader ? V2_HEAD_GREY : BLACK, bold: isHeader || isTotal, ...extra } as any);
          const cell = (w: number, children: any[], extra: any = {}) => new TableCell({
            width: { size: w, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: isTotal ? "F2F2F2" : WHITE },
            verticalAlign: VerticalAlign.TOP,
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            children: [new Paragraph({ children, ...extra })],
          });
          const idKids = withLink && !isHeader
            ? [new InternalHyperlink({ anchor: sanitizeBookmark(anchorOverride || obsId), children: [run(obsId, { bold: true, color: BLACK })] })]
            : [run(obsId, { bold: true })];
          const mr = !isHeader && action.match(/^\s*(MAJOR RENEWAL:)([\s\S]*)$/i);
          const actionKids = mr ? [run(mr[1].toUpperCase(), { bold: true }), run(mr[2])] : [run(action)];
          const sevKids = [run(category, !isHeader && /safety/i.test(category) ? { color: "EE0000" } : {})];
          return new TableRow({
            cantSplit: true,
            tableHeader: isHeader,
            children: [
              cell(W2[0], idKids), cell(W2[1], [run(location)]), cell(W2[2], [run(defect)]),
              cell(W2[3], actionKids), cell(W2[4], [run(timeframe)]), cell(W2[5], sevKids),
              cell(W2[6], [run(budget)], isTotal ? { alignment: AlignmentType.RIGHT } : {}),
            ],
          } as any);
        }

        const idChildren = withLink && !isHeader
          ? [new InternalHyperlink({
              anchor: sanitizeBookmark(anchorOverride || obsId),
              children: [new TextRun({ text: obsId, font: "Arial", size: fontSize, color: TEAL, bold: true, underline: {} })],
            })]
          : [textRun(obsId)];

        // v2: wider Actions column so long actions don't stretch rows over pages (legacy widths unchanged)
        const W = v2 ? [800, 1050, 1100, 2950, 1050, 1000, 1076] : [800, 1200, 1800, 2200, 800, 900, 1326];
        return new TableRow({
          children: [
            new TableCell({ ...cellProps(W[0]), children: [new Paragraph({ children: idChildren })] }),
            new TableCell({ ...cellProps(W[1]), children: [new Paragraph({ children: [textRun(location)] })] }),
            new TableCell({ ...cellProps(W[2]), children: [new Paragraph({ children: [textRun(defect)] })] }),
            new TableCell({ ...cellProps(W[3]), children: [new Paragraph({ children: [textRun(action)] })] }),
            new TableCell({ ...cellProps(W[4]), children: [new Paragraph({ children: [textRun(timeframe)] })] }),
            new TableCell({ ...cellProps(W[5]), children: [new Paragraph({ children: [textRun(category)] })] }),
            new TableCell({ ...cellProps(W[6]), children: [new Paragraph({ children: [textRun(budget)] })] }),
          ],
        });
      };

      const v2Grey = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
      const V2_TABLE_BORDERS = { top: v2Grey, bottom: v2Grey, left: v2Grey, right: v2Grey, insideHorizontal: v2Grey, insideVertical: v2Grey };

      // Build CAPEX table rows for a set of recommendations.
      // The displayed Severity column is the *effective* severity: Safety/Risk on
      // the observation is promoted because the AI never assigns Safety/Risk to
      // rec.category (it's only Essential/Desirable/Monitor at the rec layer).
      const buildCapexTableRows = (recs: { obsId: string; location: string; defect: string; rec: Recommendation; severity: string }[]): TableRow[] => {
        const rows: TableRow[] = [
          buildCapexRow("ID", "Location", "Defect/Issue", "Actions", "Time", "Severity", "Budget", true, false, false),
        ];
        recs.forEach((r, idx) => {
          rows.push(buildCapexRow(
            r.obsId, r.location, r.defect,
            r.rec.action, r.rec.timeframe, r.severity, r.rec.budgetEstimate || "",
            false, idx % 2 === 1, true
          ));
        });
        return rows;
      };

      // v2: budget rows grouped by timeframe, with a subtotal row per group.
      const buildBudgetTableRowsV2 = (items: { rec: Recommendation; obs?: Observation }[]): TableRow[] => {
        const rows: TableRow[] = [buildCapexRow("ID", "Location", "Defect/Issue", "Actions", "Time", "Severity", "Budget", true, false, false)];
        const sorted = [...items].sort((a, b) =>
          timeframeRank(a.rec.timeframe) - timeframeRank(b.rec.timeframe) ||
          (budgetIdByRec.get(a.rec.id)?.id || a.obs?.observationId || "").localeCompare(budgetIdByRec.get(b.rec.id)?.id || b.obs?.observationId || "", undefined, { numeric: true }));
        const groups = new Map<number, typeof sorted>();
        // v2: Immediate + Within 1 year share one total ("BUDGET FOR NOW TO 1 YEAR").
        const groupKey = (tf: string | null | undefined) => Math.max(1, timeframeRank(tf));
        const V2_TOTAL_LABELS: Record<number, string> = { 1: "NOW TO 1 YEAR", 2: "5 YEARS", 3: "THE LONGER TERM", 4: "ONGOING ITEMS" };
        for (const it of sorted) {
          const k = groupKey(it.rec.timeframe);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(it);
        }

        for (const [rank, list] of Array.from(groups.entries())) {
          let lo = 0; let sum = 0; let unpriced = 0;
          for (const { rec, obs } of list) {
            const bid = budgetIdByRec.get(rec.id);
            rows.push(buildCapexRow(
              bid?.id || obs?.observationId || "", obs?.location || "", bid?.issueTitle || obs?.defectCategory || "",
              rec.action, rec.timeframe || "", effectiveSeverity(rec.category, obs?.severity), rec.budgetEstimate || "",
              false, false, useIssues ? !!bid : true, bid?.anchor,
            ));
            const br = parseBudgetRange(rec.budgetEstimate);
            if (br) { lo += br[0]; sum += br[1]; } else unpriced++;
          }
          const label = TIMEFRAME_GROUP_LABELS[rank] || "Other";
          const amt = !sum ? "TBC" : (lo === sum ? formatMoney(sum) : `${formatMoney(lo)} – ${formatMoney(sum)}`) + (unpriced ? " + TBC" : "");
          rows.push(v2
            ? buildCapexRow("", "", "", `BUDGET FOR ${V2_TOTAL_LABELS[rank] || label.toUpperCase()}`, "", "", amt, false, true, false)
            : buildCapexRow("", "", `Subtotal – ${label}`, "", "", "", amt, false, true, false));
        }
        return rows;
      };

      // === SECTION 0: COVER PAGE ===
      const coverChildren: Paragraph[] = [];
      // Spacing at top
      coverChildren.push(new Paragraph({ spacing: { before: 2000 } }));
      // AFC text top right
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "ANGEL FA\u00C7ADE CONSULTING", font: "Arial", size: 28, bold: true, color: TEAL })],
        spacing: { after: 600 },
      }));
      // Project address large caps
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: (project.address || "").toUpperCase(), font: "Arial", size: 72, bold: true, color: BLACK })],
        spacing: { before: 1600, after: 200 },
      }));
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: REPORT_TITLE, font: "Arial", size: 32, bold: true, color: DARK_GRAY })],
        spacing: { after: 400 },
      }));
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `Revision: ${project.revision || "01"}`, font: "Arial", size: 22, color: MUTED })],
        spacing: { after: 100 },
      }));
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `Date: ${formatDate(project.createdAt)}`, font: "Arial", size: 22, color: MUTED })],
        spacing: { after: 600 },
      }));
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "ANGEL FA\u00C7ADE CONSULTING", font: "Arial", size: 24, bold: true, color: TEAL })],
        spacing: { after: 100 },
      }));
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `${project.inspector} (0419 630 922)`, font: "Arial", size: 22, color: MUTED })],
        spacing: { after: 400 },
      }));
      coverChildren.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `AFC Reference: ${project.afcReference || ""}`, font: "Arial", size: 22, color: MUTED })],
      }));

      if (v2) {
        // v2 cover (matches the AFC final): logo top right, teal bar + dark block
        // down the left page edge, right-aligned title block in the lower third.
        coverChildren.length = 0;
        const PT = 12700; // EMU per point
        const solid = (hex: string) => sharp({ create: { width: 8, height: 8, channels: 3, background: `#${hex}` } }).png().toBuffer();
        const [barPng, blockPng] = await Promise.all([solid("00EBE6"), solid("3A3A3A")]);
        const floatAt = (xPt: number, yPt: number) => ({
          horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(xPt * PT) },
          verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(yPt * PT) },
          wrap: { type: TextWrappingType.NONE }, behindDocument: true, allowOverlap: true,
        });
        const px = (pt: number) => Math.round(pt * 96 / 72);
        coverChildren.push(new Paragraph({
          children: [
            new ImageRun({ data: Buffer.from(AFC_LOGO_JPEG_BASE64, "base64"), type: "jpg", transformation: { width: px(145.4), height: px(46.6) }, floating: floatAt(371.5, 42.5), altText: { title: "AFC logo", description: "Angel Fa\u00E7ade Consulting", name: "afc-logo" } } as any),
            new ImageRun({ data: barPng, type: "png", transformation: { width: px(18), height: px(735) }, floating: floatAt(27, 38), altText: { title: "", description: "", name: "cover-bar" } } as any),
            new ImageRun({ data: blockPng, type: "png", transformation: { width: px(18), height: px(19) }, floating: floatAt(27, 785), altText: { title: "", description: "", name: "cover-block" } } as any),
          ],
        }));
        const coverLine = (text: string, size: number, color: string, after = 0, extra: any = {}) => new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ __raw: true, text, size, color, ...extra } as any)],
          spacing: { after },
        });
        // Cover date: the issue date set on the project, else the export date.
        const rd = String((project as any).reportDate || "").trim();
        const rdParsed = /^\d{4}-\d{2}-\d{2}$/.test(rd) ? new Date(`${rd}T12:00:00Z`) : null;
        const exportDate = (rdParsed && !isNaN(rdParsed.getTime()) ? rdParsed : new Date())
          .toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric", timeZone: "Australia/Sydney" }).toUpperCase();
        const authorName = (project.inspector || "").trim() || DEFAULT_INSPECTOR;
        const authorPhone = authorPhoneFor(authorName, (project as any).authorPhone);
        const rev = String((project as any).revision ?? "0").replace(/^0+(?=\d)/, "") || "0";
        coverChildren.push(new Paragraph({ children: [], spacing: { before: 9600 } }));
        coverChildren.push(coverLine((project.address || project.name || "").toUpperCase(), 52, "0A1D30"));
        coverChildren.push(coverLine(REPORT_TITLE.toUpperCase(), 36, "0E2841"));
        coverChildren.push(coverLine(`Revision ${rev}`, 24, "0E2841", 160, { smallCaps: true }));
        coverChildren.push(coverLine(exportDate, 24, "262626", 840));
        coverChildren.push(coverLine("ANGEL FA\u00C7ADE CONSULTING", 28, "262626"));
        coverChildren.push(coverLine(`${authorName.toUpperCase()}${authorPhone ? ` | ${authorPhone}` : ""}`, 20, "262626"));
        coverChildren.push(coverLine(project.afcReference || "", 20, "262626"));
      }

      // === SECTION 1: EXECUTIVE SUMMARY ===
      const execChildren: (Paragraph | Table)[] = [];
      execChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "1. Executive Summary", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

      if (project.executiveSummary && v2) {
        // v2: the three fixed headings are bold sub-headings; numbered items are plain list items.
        const EXEC_HEADS = /^(safety and risk items|other key findings|major recommendations)\s*:?$/i;
        for (const raw of project.executiveSummary.split(/\r?\n/)) {
          const line = raw.trim().replace(/^\*\*(.*)\*\*$/, "$1");
          if (!line) continue;
          const num = line.match(/^(\d+)\.\s+(.*)$/);
          if (EXEC_HEADS.test(line)) {
            execChildren.push(new Paragraph({ children: [new TextRun({ text: `${line.replace(/:$/, "")}:`, font: "Arial", size: 22, bold: true, color: BLACK })], spacing: { before: 200, after: 80 }, keepNext: true }));
          } else if (num) {
            execChildren.push(new Paragraph({ children: [new TextRun({ text: `${num[1]}.\t`, font: "Arial", size: 22 }), new TextRun({ text: num[2], font: "Arial", size: 22 })], indent: { left: 360, hanging: 360 }, tabStops: [{ type: TabStopType.LEFT, position: 360 }], spacing: { after: 60 } }));
          } else {
            execChildren.push(new Paragraph({ children: [new TextRun({ text: line, font: "Arial", size: 22 })], spacing: { after: 150 } }));
          }
        }
      } else if (project.executiveSummary) {
        execChildren.push(...renderNarrativeParagraphs(project.executiveSummary, { fontSize: 22, afterSpacing: 150 }));
      } else {
        execChildren.push(new Paragraph({
          children: [new TextRun({ text: "Executive summary not yet generated.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      }

      if (v2) {
        // BUDGETS table: safety items + Immediate / Within 1 year + the most
        // expensive 25% (by parsed budget), grouped by timeframe with subtotals.
        const withObs = allRecommendations.map(rec => ({ rec, obs: allObservations.find(o => o.id === rec.observationId) }));
        const priced = withObs.map(x => parseBudget(x.rec.budgetEstimate)).filter((n): n is number => n != null).sort((a, b) => b - a);
        const topN = Math.max(1, Math.ceil(priced.length * 0.25));
        const threshold = priced.length ? priced[topN - 1] : Infinity;
        const picked = withObs.filter(({ rec, obs }) => {
          const b = parseBudget(rec.budgetEstimate);
          return obs?.severity === "Safety/Risk" || isWithinOneYear(rec.timeframe) || (b != null && b >= threshold);
        });
        if (picked.length > 0) {
          execChildren.push(new Paragraph({
            children: [new TextRun({ __raw: true, text: "BUDGETS for major and safety-related recommendations:", size: 22, bold: true, color: BLACK } as any)],
            spacing: { before: 300, after: 150 },
            keepNext: true,
          }));
          execChildren.push(new Table({
            layout: TableLayoutType.FIXED,
            width: { size: TEXT_W, type: WidthType.DXA },
            columnWidths: [850, 1300, 1300, 3316, 1300, 1200, 1200],
            borders: V2_TABLE_BORDERS,
            rows: buildBudgetTableRowsV2(picked),
          } as any));
        }
      } else {
      // Major recommendations table (Essential or Safety/Risk)
      const majorRecs = allRecommendations.filter(r => {
        const obs = allObservations.find(o => o.id === r.observationId);
        return r.category === "Essential" || obs?.severity === "Safety/Risk";
      });

      if (majorRecs.length > 0) {
        execChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "Major Recommendations", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        }));

        const majorCapexData = majorRecs.map(rec => {
          const obs = allObservations.find(o => o.id === rec.observationId);
          return {
            obsId: obs?.observationId || "",
            location: obs?.location || "",
            defect: obs?.defectCategory || "",
            rec,
            severity: effectiveSeverity(rec.category, obs?.severity),
          };
        });

        execChildren.push(new Table({
          layout: TableLayoutType.FIXED,
          width: { size: 9026, type: WidthType.DXA },
          rows: buildCapexTableRows(majorCapexData),
        } as any));
      }
      }

      // === SECTION 2: INTRODUCTION ===
      const introChildren: Paragraph[] = [];
      introChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "2. Introduction", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

      // 2.1 General
      introChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "2.1 General", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));

      // Prefer the AI-rewritten introduction when present; otherwise fall back to
      // a one-line engagement statement plus the raw project context (if any).
      const aiIntro = ((project as any).aiIntroduction || "").trim();
      const rawProjectContext = ((project as any).projectContext || "").trim();
      if (aiIntro) {
        introChildren.push(...renderNarrativeParagraphs(aiIntro, { fontSize: 22, afterSpacing: 150 }));
      } else if (v2) {
        const onBehalf = ((project as any).clientOnBehalfOf || "").trim();
        introChildren.push(new Paragraph({
          children: [new TextRun({ text: `Angel Fa\u00E7ade Consulting (AFC) was engaged by ${project.client}${onBehalf ? ` on behalf of their client ${onBehalf}` : ""} to carry out ${assessmentPhrase((project as any).assessmentType)} of the building envelope of ${project.name}${project.address && project.address !== project.name ? `, ${project.address}` : ""}.`, font: "Arial", size: 22 })],
          spacing: { after: 150 },
        }));
      } else {
        introChildren.push(new Paragraph({
          children: [new TextRun({ text: `Angel Fa\u00E7ade Consulting (AFC) was engaged by ${project.client} to carry out a condition assessment of the building envelope(s) at ${project.address}.`, font: "Arial", size: 22 })],
          spacing: { after: 150 },
        }));
        if (rawProjectContext) {
          introChildren.push(...renderNarrativeParagraphs(rawProjectContext, { fontSize: 22, afterSpacing: 150 }));
        }
      }

      // 2.2 Inspection
      introChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "2.2 Inspection", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));
      const inspMatrix = parseMatrix((project as any).inspectionMatrix);
      if (matrixHasContent(inspMatrix)) {
        // Structured inspection matrix → AFC-standard 2.2 wording (deterministic, no AI).
        const it = buildInspectionText(inspMatrix);
        const bodyPara = (text: string, after = 120) => new Paragraph({
          children: [new TextRun({ text, font: "Arial", size: 22 })],
          spacing: { after },
        });
        introChildren.push(bodyPara(it.opening, it.accessIntro ? 60 : 150));
        if (it.accessIntro) introChildren.push(bodyPara(it.accessIntro, it.accessDays.length ? 60 : (it.accessClosing ? 60 : 150)));
        for (const d of it.accessDays) {
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: d, font: "Arial", size: 22 })],
            bullet: { level: 0 },
            spacing: { after: 40 },
          }));
        }
        if (it.accessClosing) introChildren.push(bodyPara(it.accessClosing, 150));
        if (it.coveredIntro) {
          introChildren.push(bodyPara(it.coveredIntro, 80));
          it.covered.forEach((c, i) => {
            const text = c.text;
            introChildren.push(new Paragraph({
              children: [
                new TextRun({ text: `${i + 1}.\t`, font: "Arial", size: 22 }),
                new TextRun({ text, font: "Arial", size: 22 }),
              ],
              tabStops: [{ type: TabStopType.LEFT, position: 360 }],
              indent: { left: 360, hanging: 360 },
              spacing: { after: 60 },
            }));
            c.subPoints.forEach((sp, j) => {
              introChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: `${String.fromCharCode(97 + j)}.\t`, font: "Arial", size: 22 }),
                  new TextRun({ text: sp, font: "Arial", size: 22 }),
                ],
                tabStops: [{ type: TabStopType.LEFT, position: 720 }],
                indent: { left: 720, hanging: 360 },
                spacing: { after: 40 },
              }));
            });
          });
          introChildren.push(new Paragraph({ children: [], spacing: { after: 100 } }));
        }
      } else {
        introChildren.push(new Paragraph({
          children: [new TextRun({ text: "The inspection was carried out on the following dates:", font: "Arial", size: 22 })],
          spacing: { after: 100 },
        }));

        const dates = safeJsonArray(project.inspectionDates);
        if (dates.length > 0) {
          for (const date of dates) {
            introChildren.push(new Paragraph({
              children: [new TextRun({ text: formatDate(date), font: "Arial", size: 22 })],
              bullet: { level: 0 },
              spacing: { after: 50 },
            }));
          }
        } else {
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: "No inspection dates recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
            spacing: { after: 100 },
          }));
        }

        if (project.inspectionScope) {
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: project.inspectionScope, font: "Arial", size: 22 })],
            spacing: { before: 100, after: 150 },
          }));
        }
      }

      // Harvard-style reference: Author (Year). Title. Publisher.
      const formatHarvardRef = (d: { author?: string | null; year?: string | null; title?: string | null; originalName?: string | null; publisher?: string | null }): string => {
        const author = (d.author || "").trim();
        const year = (d.year || "").trim();
        const titleStr = (d.title || d.originalName || "Untitled").trim();
        const publisher = (d.publisher || "").trim();
        const parts: string[] = [];
        if (author) parts.push(year ? `${author} (${year}).` : `${author}.`);
        else if (year) parts.push(`(${year}).`);
        parts.push(`${titleStr}.`);
        if (publisher) parts.push(`${publisher}.`);
        return parts.join(" ");
      };
      const numberedPara = (num: string, text: string, level = 0, after = 60) => new Paragraph({
        children: [
          new TextRun({ text: `${num}\t`, font: "Arial", size: 22 }),
          new TextRun({ text, font: "Arial", size: 22 }),
        ],
        tabStops: [{ type: TabStopType.LEFT, position: 360 * (level + 1) }],
        indent: { left: 360 * (level + 1), hanging: 360 },
        spacing: { after },
      });

      if (v2) {
        introChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "2.3 Background information", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        }));
        const refs: string[] = [
          ...projectDocs.map(d => formatHarvardRef(d as any)),
          ...safeJsonArray(project.backgroundDocs).filter((d: any) => (d.title || "").trim()).map((d: any) =>
            formatHarvardRef({ author: d.author, year: d.date ? String(d.date).slice(0, 4) : "", title: d.title })),
        ];
        const refIntro = ((project as any).referencesIntro || "").trim()
          || (refs.length ? REFERENCES_INTRO_PRESETS[0] : REFERENCES_INTRO_PRESETS[3]);
        introChildren.push(new Paragraph({
          children: [new TextRun({ text: refIntro, font: "Arial", size: 22 })],
          spacing: { after: refs.length ? 80 : 150 },
        }));
        refs.forEach((r, i) => introChildren.push(numberedPara(`${i + 1}.`, r, 0, i === refs.length - 1 ? 150 : 60)));

        introChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "2.4 Limitations", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        }));
        const limsV2 = parseLimitations(project.limitations).filter(l => l.text.trim());
        if (limsV2.length) {
          limsV2.forEach((l, i) => {
            introChildren.push(numberedPara(`${i + 1}.`, stripBrackets(l.text), 0, l.subs.length ? 40 : 80));
            l.subs.filter(sb => sb.trim()).forEach((sb, j) => introChildren.push(numberedPara(`${String.fromCharCode(97 + j)}.`, stripBrackets(sb), 1, 40)));
          });
        } else {
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: "No limitations recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
            spacing: { after: 150 },
          }));
        }
      } else {
      // 2.3 Background Information
      introChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "2.3 Background Information", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));

      const bgDocs = safeJsonArray(project.backgroundDocs);
      if (bgDocs.length > 0) {
        for (const doc of bgDocs) {
          const docText = `${doc.title || "Untitled"}${doc.author ? ` \u2014 ${doc.author}` : ""}${doc.date ? ` (${doc.date})` : ""}`;
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: docText, font: "Arial", size: 22 })],
            bullet: { level: 0 },
            spacing: { after: 50 },
          }));
        }
      } else {
        introChildren.push(new Paragraph({
          children: [new TextRun({ text: "No background documents recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      }

      // 2.4 Limitations
      introChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "2.4 Limitations", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));

      const lims = safeJsonArray(project.limitations);
      if (lims.length > 0) {
        lims.forEach((lim: string, idx: number) => {
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: `${idx + 1}. ${lim}`, font: "Arial", size: 22 })],
            spacing: { after: 80 },
          }));
        });
      } else {
        introChildren.push(new Paragraph({
          children: [new TextRun({ text: "No limitations recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      }

      // 2.5 References — Harvard format. Omitted entirely if no project documents.
      if (projectDocs.length > 0) {
        introChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "2.5 References", font: "Arial", size: 28, bold: true, color: TEAL })],
          spacing: { before: 300, after: 150 },
        }));

        const formatHarvard = (d: typeof projectDocs[number]): string => {
          const author = (d.author || "").trim();
          const year = (d.year || "").trim();
          const titleStr = (d.title || d.originalName || "Untitled").trim();
          const publisher = (d.publisher || "").trim();
          // Harvard: Author (Year). Title. Publisher.
          const parts: string[] = [];
          if (author) {
            parts.push(year ? `${author} (${year}).` : `${author}.`);
          } else if (year) {
            parts.push(`(${year}).`);
          }
          parts.push(`${titleStr}.`);
          if (publisher) parts.push(`${publisher}.`);
          return parts.join(" ");
        };

        const sortedRefs = [...projectDocs].sort((a, b) => {
          const aKey = (a.author || a.title || a.originalName || "").toLowerCase();
          const bKey = (b.author || b.title || b.originalName || "").toLowerCase();
          return aKey.localeCompare(bKey);
        });

        for (const d of sortedRefs) {
          introChildren.push(new Paragraph({
            children: [new TextRun({ text: formatHarvard(d), font: "Arial", size: 20 })],
            // Hanging indent: left indent + negative first-line offset (~36pt)
            indent: { left: 720, hanging: 720 },
            spacing: { after: 120 },
          }));
        }
      }

      } // end legacy 2.3-2.5

      // === SECTION 3: SITE DESCRIPTION ===
      const siteChildren: Paragraph[] = [];
      const figureCounter = { n: 1 };

      siteChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "3. Site Description", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

      const projectElevations = await storage.getElevationsByProject(projectId);
      projectElevations.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
      const renderElevationFigures = async (target: Paragraph[]) => {
        for (const elev of projectElevations) {
          const srcPath = path.join(elevationDir, elev.filename);
          if (!fs.existsSync(srcPath)) continue;

          const pins = await storage.getPinsByElevation(elev.id);
          let annotatedBuffer: Buffer | null = null;
          let annotatedWidth = elev.width || 1600;
          let annotatedHeight = elev.height || 1200;

          try {
            const baseImg = sharp(srcPath);
            const meta = await baseImg.metadata();
            const W = meta.width || 1600;
            const H = meta.height || 1200;
            annotatedWidth = W;
            annotatedHeight = H;

            // Build SVG overlay with pins
            const pinRadius = Math.max(24, Math.round(Math.min(W, H) * 0.02));
            const svgPins = pins.map((pin) => {
              const obs = allObservations.find(o => o.id === pin.observationId);
              if (!obs) return "";
              const color = obs.severity === "Safety/Risk" ? "#EF4444"
                : obs.severity === "Essential" ? "#F97316"
                : obs.severity === "Desirable" ? "#EAB308"
                : "#22C55E";
              const cx = Math.round((pin.x / 10000) * W);
              const cy = Math.round((pin.y / 10000) * H);
              const label = (obs.observationId || "").replace(/[<>&"']/g, "");
              const fontSize = Math.round(pinRadius * 0.75);
              return `
                <circle cx="${cx}" cy="${cy}" r="${pinRadius}" fill="${color}" stroke="white" stroke-width="3" />
                <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${label}</text>
              `;
            }).join("");

            const svgOverlay = Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgPins}</svg>`
            );

            annotatedBuffer = await baseImg
              .composite([{ input: svgOverlay, top: 0, left: 0 }])
              .png()
              .toBuffer();
          } catch (err) {
            console.warn("Failed to annotate elevation", elev.id, err);
            try {
              annotatedBuffer = fs.readFileSync(srcPath);
            } catch {}
          }

          if (!annotatedBuffer) continue;
          let elevImgType: "png" | "jpg" = "png";
          if (v2) {
            // v2: flatten + down-sample the annotated drawing (multi-MB PNGs otherwise).
            try { annotatedBuffer = await sharp(annotatedBuffer).resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer(); elevImgType = "jpg"; } catch {}
          }
          const elevCaption = `Figure ${figureCounter.n} \u2013 ${elev.name}`;

          // Figure heading (legacy) — v2 puts a caption under the drawing instead
          if (!v2) target.push(new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun({ text: elevCaption, font: "Arial", size: 22, bold: true, color: DARK_GRAY })],
            spacing: { before: 200, after: 100 },
          }));
          figureCounter.n++;

          // Scale to fit page width ~500px target
          const targetWidth = 500;
          const aspect = annotatedHeight && annotatedWidth ? annotatedHeight / annotatedWidth : 0.75;
          const targetHeight = Math.round(targetWidth * aspect);

          target.push(new Paragraph({
            children: [
              new ImageRun({
                data: annotatedBuffer,
                transformation: { width: targetWidth, height: targetHeight },
                type: elevImgType,
                ...(v2 ? { outline: V2_PHOTO_OUTLINE } : {}),
                altText: { title: elev.name, description: elev.name, name: elev.filename },
              } as any),
            ],
            spacing: { after: v2 ? 40 : 200 },
            ...(v2 ? { keepNext: true } : {}),
          }));
          if (v2) target.push(new Paragraph({ children: [new TextRun({ __raw: true, text: elevCaption, size: 18, bold: true, color: V2_CAPTION_BLUE } as any)], spacing: { after: 200 } }));

          // Legend / pin list
          if (pins.length > 0) {
            for (const pin of pins) {
              const obs = allObservations.find(o => o.id === pin.observationId);
              if (!obs) continue;
              target.push(new Paragraph({
                children: [
                  new TextRun({ text: `Pin ${obs.observationId}: `, font: "Arial", size: 20, bold: true, color: DARK_GRAY }),
                  new TextRun({ text: `${obs.defectCategory} — ${obs.location} (${obs.severity})${(() => {
                    const hit = orderedIssues.find(x => jsonIds(x.issue.observationIds).includes(obs.id));
                    return hit ? `; refer Section ${hit.number}` : "";
                  })()}`, font: "Arial", size: 20, color: MUTED }),
                ],
                spacing: { after: 40 },
              }));
            }
          }
        }
      };
      const renderRoofPlanFigure = async (target: Paragraph[], caption: string, showDropList: boolean) => {
        if (!project.roofPlanImagePath) return false;
        const roofPlanFilename = path.basename(project.roofPlanImagePath);
        const roofPlanPath = path.join(roofPlanDir, roofPlanFilename);
        const projectDrops = await storage.getDropsByProject(projectId);
        projectDrops.sort((a, b) => a.id - b.id);
        if (!fs.existsSync(roofPlanPath)) return false;
          let annotatedBuffer: Buffer | null = null;
          let W = 1600;
          let H = 1200;

          try {
            const baseImg = sharp(roofPlanPath);
            const meta = await baseImg.metadata();
            W = meta.width || 1600;
            H = meta.height || 1200;

            const markerRadius = Math.max(24, Math.round(Math.min(W, H) * 0.02));
            const svgMarkers = projectDrops.map((drop) => {
              const cx = Math.round((drop.x / 10000) * W);
              const cy = Math.round((drop.y / 10000) * H);
              const label = (drop.dropNumber || "").replace(/[<>&"']/g, "");
              const fontSize = Math.round(markerRadius * 0.7);
              return `
                <circle cx="${cx}" cy="${cy}" r="${markerRadius}" fill="#00B5B8" stroke="white" stroke-width="3" />
                <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${label}</text>
              `;
            }).join("");

            const svgOverlay = Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgMarkers}</svg>`
            );

            annotatedBuffer = await baseImg
              .composite([{ input: svgOverlay, top: 0, left: 0 }])
              .png()
              .toBuffer();
          } catch (err) {
            console.warn("Failed to annotate roof plan", err);
            try {
              annotatedBuffer = fs.readFileSync(roofPlanPath);
            } catch {}
          }

          if (annotatedBuffer) {
            let roofImgType: "png" | "jpg" = "png";
            if (v2) {
              try { annotatedBuffer = await sharp(annotatedBuffer).resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer(); roofImgType = "jpg"; } catch {}
            }
            const roofCaption = `Figure ${figureCounter.n} \u2013 ${caption}`;
            if (!v2) target.push(new Paragraph({
              heading: HeadingLevel.HEADING_3,
              children: [new TextRun({ text: roofCaption, font: "Arial", size: 22, bold: true, color: DARK_GRAY })],
              spacing: { before: 200, after: 100 },
            }));
            figureCounter.n++;

            const targetWidth = 500;
            const aspect = H && W ? H / W : 0.75;
            const targetHeight = Math.round(targetWidth * aspect);

            target.push(new Paragraph({
              children: [
                new ImageRun({
                  data: annotatedBuffer,
                  transformation: { width: targetWidth, height: targetHeight },
                  type: roofImgType,
                  ...(v2 ? { outline: V2_PHOTO_OUTLINE } : {}),
                  altText: { title: "Roof Plan", description: "Roof plan with drop locations", name: roofPlanFilename },
                } as any),
              ],
              spacing: { after: v2 ? 40 : 200 },
              ...(v2 ? { keepNext: true } : {}),
            }));
            if (v2) target.push(new Paragraph({ children: [new TextRun({ __raw: true, text: roofCaption, size: 18, bold: true, color: V2_CAPTION_BLUE } as any)], spacing: { after: 200 } }));

            if (!showDropList) {
              // v2: drops are shown on the figure only
            } else if (projectDrops.length > 0) {
              target.push(new Paragraph({
                children: [new TextRun({ text: `${projectDrops.length} drop${projectDrops.length === 1 ? "" : "s"} annotated:`, font: "Arial", size: 20, italics: true, color: MUTED })],
                spacing: { after: 60 },
              }));
              const dropLabels = projectDrops.map(d => d.dropNumber).join(", ");
              target.push(new Paragraph({
                children: [new TextRun({ text: dropLabels, font: "Arial", size: 20, color: DARK_GRAY })],
                spacing: { after: 150 },
              }));
            } else {
              target.push(new Paragraph({
                children: [new TextRun({ text: "No drops annotated on the roof plan.", font: "Arial", size: 20, italics: true, color: MUTED })],
                spacing: { after: 150 },
              }));
            }
          }
        return true;
      };

      const appendixChildren: Paragraph[] = [];
      if (v2) {
        const h2 = (t: string) => new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: t, font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        });
        // 3.1 General background
        siteChildren.push(h2("3.1 General background"));
        const bg = ((project as any).aiBackground || "").trim();
        if (bg) siteChildren.push(...renderNarrativeParagraphs(bg, { fontSize: 22, afterSpacing: 150 }));
        else siteChildren.push(new Paragraph({
          children: [new TextRun({ text: `${project.name} is a ${project.buildingAge || ""} ${project.buildingUse || "building"}${project.storeyCount ? ` of ${project.storeyCount} storeys` : ""}.`.replace(/\s+/g, " "), font: "Arial", size: 22 })],
          spacing: { after: 150 },
        }));
        // 3.2 Location (+ roof plan with drops)
        const locText = ((project as any).locationDescription || "").trim() || `The Property is located at ${project.address}.`;
        siteChildren.push(h2("3.2 Location"));
        siteChildren.push(...renderNarrativeParagraphs(locText, { fontSize: 22, afterSpacing: 150 }));
        await renderRoofPlanFigure(siteChildren, "Site layout, showing inspection drop locations", false);

        // 3.3 Façade description — one numbered list; systems sharing a report heading are combined.
        if (systems.length > 0) {
          siteChildren.push(h2("3.3 Fa\u00E7ade description"));
          siteChildren.push(new Paragraph({
            children: [new TextRun({ text: "The building envelope comprises the following key systems:", font: "Arial", size: 22 })],
            spacing: { after: 100 },
          }));
          const groups: { heading: string; items: typeof systems }[] = [];
          for (const sy of systems) {
            const h = (((sy as any).reportHeading || "").trim()) || sy.name;
            const g = groups.find(x => x.heading.toLowerCase() === h.toLowerCase());
            if (g) g.items.push(sy); else groups.push({ heading: h, items: [sy] });
          }
          groups.forEach((g, gi) => {
            siteChildren.push(new Paragraph({
              children: [
                new TextRun({ text: `${gi + 1}.\t`, font: "Arial", size: 22, bold: true }),
                new TextRun({ text: g.heading, font: "Arial", size: 22, bold: true }),
              ],
              tabStops: [{ type: TabStopType.LEFT, position: 360 }],
              indent: { left: 360, hanging: 360 },
              spacing: { before: 120, after: 60 },
            }));
            for (const sy of g.items) {
              if (g.items.length > 1) {
                siteChildren.push(new Paragraph({
                  children: [new TextRun({ text: sy.name, font: "Arial", size: 22, italics: true })],
                  indent: { left: 360 },
                  spacing: { before: 60, after: 40 },
                }));
              }
              const desc = (sy.aiDescription || "").trim();
              if (desc) {
                const paras = renderNarrativeParagraphs(desc, { fontSize: 22, afterSpacing: 80, plainIndent: 360 });
                siteChildren.push(...paras);
              } else {
                siteChildren.push(new Paragraph({
                  children: [new TextRun({ text: `${sy.systemType}${sy.location ? `, ${sy.location}` : ""}.`, font: "Arial", size: 22 })],
                  indent: { left: 360 },
                  spacing: { after: 80 },
                }));
              }
            }
          });
          const chosen = systems.flatMap(sy => (systemPhotosMap[sy.id] || []).filter(ph => (ph as any).includeInReport));
          if (chosen.length) {
            siteChildren.push(new Paragraph({ children: [], spacing: { after: 100 } }));
            siteChildren.push(...((await buildPhotoGridV2(chosen, figureCounter, { single: true })) as any[]));
          }
        }

        // Appendix A (elevations) is rendered after Section 4 so figure numbers run in page order.
      } else {
      // 3.1 Introduction
      siteChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "3.1 Introduction", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));

      const buildingDesc = `${project.address} is a ${project.buildingAge || "building"} ${project.buildingUse || "property"}${project.refurbishmentHistory ? ` that ${project.refurbishmentHistory}` : ""}.`;
      siteChildren.push(new Paragraph({
        children: [new TextRun({ text: buildingDesc, font: "Arial", size: 22 })],
        spacing: { after: 150 },
      }));

      // 3.2 Facade Description
      if (systems.length > 0) {
        siteChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "3.2 Facade Description", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        }));

        systems.forEach((sys, idx) => {
          siteChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun({ text: `3.2.${idx + 1} ${sys.name}`, font: "Arial", size: 24, bold: true, color: DARK_GRAY })],
            spacing: { before: 200, after: 100 },
          }));

          // System description — use AI description, or fall back to structured summary
          const descText = sys.aiDescription || "";
          if (descText.trim()) {
            siteChildren.push(...renderNarrativeParagraphs(descText, { fontSize: 22, afterSpacing: 100 }));
          } else {
            // Fallback: structured summary from system fields
            const fallbackLines: string[] = [];
            if (sys.systemType) fallbackLines.push(`System type: ${sys.systemType}`);
            let mats: {name: string; detail: string}[] = [];
            try { mats = JSON.parse(sys.materials || "[]"); } catch {}
            if (mats.length > 0) {
              fallbackLines.push(`Materials: ${mats.map((m: {name: string; detail: string}) => `${m.name} — ${m.detail}`).join("; ")}`);
            }
            let feats: string[] = [];
            try { feats = JSON.parse(sys.keyFeatures || "[]"); } catch {}
            if (feats.length > 0) fallbackLines.push(`Key features: ${feats.join(", ")}`);
            if (sys.estimatedAge) fallbackLines.push(`Estimated age: ${sys.estimatedAge}`);
            for (const line of fallbackLines) {
              siteChildren.push(new Paragraph({
                children: [new TextRun({ text: line, font: "Arial", size: 22 })],
                spacing: { after: 80 },
              }));
            }
            if (fallbackLines.length === 0) {
              siteChildren.push(new Paragraph({
                children: [new TextRun({ text: "Description not yet generated.", font: "Arial", size: 22, italics: true, color: "999999" })],
                spacing: { after: 100 },
              }));
            }
          }

          // Roof Types — for Roof systems, list the selected roof types
          let roofTypesList: string[] = [];
          try { roofTypesList = JSON.parse((sys as any).roofTypes || "[]"); } catch {}
          if (roofTypesList.length > 0) {
            siteChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Roof Types: ", font: "Arial", size: 22, bold: true, color: TEAL }),
                new TextRun({ text: roofTypesList.join("; "), font: "Arial", size: 22 }),
              ],
              spacing: { after: 100 },
            }));
          }

          // System photos
          const sysPhotos = systemPhotosMap[sys.id] || [];
          if (sysPhotos.length > 0) {
            siteChildren.push(...buildPhotoRows(sysPhotos, figureCounter));
          }
        });
      }

      // 3.3 Elevation Drawings (with pinned observations)
      if (projectElevations.length > 0) {
        siteChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "3.3 Elevation Drawings", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        }));
        await renderElevationFigures(siteChildren);
      }

      // 3.4 Roof Plan and Drop Locations
      if (project.roofPlanImagePath && fs.existsSync(path.join(roofPlanDir, path.basename(project.roofPlanImagePath)))) {
        siteChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "3.4 Roof Plan and Drop Locations", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
          spacing: { before: 300, after: 150 },
        }));
        await renderRoofPlanFigure(siteChildren, "Roof Plan with Drop Locations", true);
      }
      } // end legacy section 3

      // Build pin-to-elevation map for observation cross-references
      const pinByObs: Record<number, { elevationName: string; observationId: string }> = {};
      for (const elev of projectElevations) {
        const ePins = await storage.getPinsByElevation(elev.id);
        for (const pin of ePins) {
          const obs = allObservations.find(o => o.id === pin.observationId);
          if (obs) {
            pinByObs[obs.id] = { elevationName: elev.name, observationId: obs.observationId };
          }
        }
      }

      // === SECTION 4: OBSERVATIONS ===
      const obsChildren: Paragraph[] = [];
      obsChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "4. Observations", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

      obsChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "4.1 Overview", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));

      if (useIssues) {
        const ov = ((project as any).observationsOverview || "").trim();
        if (ov) obsChildren.push(...renderNarrativeParagraphs(ov, { fontSize: 22, afterSpacing: 150 }));
        const allObsPhotos = new Map<number, Photo>();
        for (const o of allObservations) for (const ph of (obsPhotosMap[o.id] || [])) allObsPhotos.set(ph.id, ph);
        for (const { issue, number, depth } of orderedIssues) {
          const bm = sanitizeBookmark(number);
          obsChildren.push(new Paragraph({
            heading: depth ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
            children: [
              new BookmarkStart(bm, getBookmarkLinkId(number)),
              new TextRun({ text: `${number} ${issue.title}`, font: "Arial", size: depth ? 24 : 28, bold: true, color: DARK_GRAY }),
              new BookmarkEnd(getBookmarkLinkId(number)),
            ],
            spacing: { before: depth ? 200 : 300, after: 150 },
          }));
          const summary = (issue.summary || "").trim();
          if (summary) obsChildren.push(...renderNarrativeParagraphs(summary, { fontSize: 22, afterSpacing: 120 }));
          const keyObs = (issue.keyObservations || "").trim();
          if (keyObs) obsChildren.push(...renderNarrativeParagraphs(keyObs, { fontSize: 22, afterSpacing: 80 }));
          if (!summary && !keyObs) {
            obsChildren.push(new Paragraph({
              children: [new TextRun({ text: "[Issue text not yet written]", font: "Arial", size: 22, italics: true, color: MUTED })],
              spacing: { after: 120 },
            }));
          }
          const photosForIssue = jsonIds(issue.photoIds).map(pid => allObsPhotos.get(pid)).filter((p): p is Photo => !!p);
          if (photosForIssue.length) {
            obsChildren.push(new Paragraph({ children: [], spacing: { after: 80 } }));
            obsChildren.push(...((v2 ? await buildPhotoGridV2(photosForIssue, figureCounter) : buildPhotoRows(photosForIssue, figureCounter)) as any[]));
          }
        }
      }

      // Fetch groups for this project (if inspection is complete, we use grouped structure)
      const projectGroups = await storage.getGroupsByProject(projectId);
      projectGroups.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
      const useGroups = project.inspectionStatus === "complete" && projectGroups.length > 0;

      if (useIssues) {
        // Section 4 already built from issues above.
      } else if (allObservations.length === 0) {
        obsChildren.push(new Paragraph({
          children: [new TextRun({ text: "No observations recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      } else if (useGroups) {
        obsChildren.push(new Paragraph({
          children: [new TextRun({ text: "The following sections detail the observations recorded during the facade inspection.", font: "Arial", size: 22 })],
          spacing: { after: 150 },
        }));

        let sectionNum = 2;
        for (const grp of projectGroups) {
          const members = allObservations.filter(o => o.groupId === grp.id);
          if (members.length === 0) continue;

          obsChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: `4.${sectionNum} ${grp.name}`, font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
            spacing: { before: 300, after: 150 },
          }));
          sectionNum++;

          const grpCriterion = ((grp as any).groupingCriterion || "").trim();
          if (grpCriterion) {
            obsChildren.push(new Paragraph({
              children: [new TextRun({ text: `Grouped by: ${grpCriterion}`, font: "Arial", size: 18, italics: true, color: MUTED })],
              spacing: { after: 100 },
            }));
          }

          if (grp.combinedNarrative) {
            obsChildren.push(...renderNarrativeParagraphs(grp.combinedNarrative, { fontSize: 22, afterSpacing: 100 }));
          }

          // Render each member observation with its full detail block (narrative,
          // photos, recommendations) under the group narrative. Each member gets a
          // bookmark so CAPEX links still resolve.
          for (const obs of members) {
            const bookmarkId = sanitizeBookmark(obs.observationId);
            obsChildren.push(new Paragraph({
              heading: HeadingLevel.HEADING_3,
              children: [
                new BookmarkStart(bookmarkId, getBookmarkLinkId(obs.observationId)),
                new TextRun({ text: `${obs.observationId} ${obs.defectCategory}`, font: "Arial", size: 24, bold: true, color: DARK_GRAY }),
                new BookmarkEnd(getBookmarkLinkId(obs.observationId)),
              ],
              spacing: { before: 200, after: 100 },
            }));

            obsChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Location: ", font: "Arial", size: 22, bold: true }),
                new TextRun({ text: obs.location, font: "Arial", size: 22 }),
              ],
              spacing: { after: 50 },
            }));

            obsChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Severity: ", font: "Arial", size: 22, bold: true }),
                new TextRun({ text: `${obs.severity} — ${obs.extent}`, font: "Arial", size: 22 }),
              ],
              spacing: { after: 100 },
            }));

            if (pinByObs[obs.id]) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: `Refer to ${pinByObs[obs.id].elevationName}, Pin ${pinByObs[obs.id].observationId}.`, font: "Arial", size: 20, italics: true, color: MUTED }),
                ],
                spacing: { after: 100 },
              }));
            }

            if (obs.fieldNote && obs.fieldNote.trim()) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: "Field note: ", font: "Arial", size: 20, bold: true, color: MUTED }),
                  new TextRun({ text: obs.fieldNote, font: "Arial", size: 20, italics: true, color: MUTED }),
                ],
                spacing: { after: 80 },
              }));
            }

            if (obs.aiNarrative) {
              obsChildren.push(...renderNarrativeParagraphs(obs.aiNarrative, { fontSize: 22, afterSpacing: 100 }));
            }

            const { paragraphs: alsoParagraphs, photoLabels: photoLocLabels } = buildAlsoObservedAtBlock(obs.id);
            if (alsoParagraphs.length > 0) {
              obsChildren.push(...alsoParagraphs);
            }
            const oPhotos = obsPhotosMap[obs.id] || [];
            if (oPhotos.length > 0) {
              obsChildren.push(...buildPhotoRows(oPhotos, figureCounter, photoLocLabels));
            }

            const obsRecs = recsByObs[obs.id] || [];
            for (const rec of obsRecs) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: "Recommended action: ", font: "Arial", size: 22, bold: true }),
                  new TextRun({ text: rec.action, font: "Arial", size: 22 }),
                ],
                spacing: { before: 100, after: 50 },
              }));
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: `Timeframe: ${rec.timeframe} | Category: ${rec.category} | Budget: ${rec.budgetEstimate || "TBD"}`, font: "Arial", size: 20, color: MUTED }),
                ],
                spacing: { after: 150 },
              }));
            }
          }
        }
      } else {
        obsChildren.push(new Paragraph({
          children: [new TextRun({ text: "The following sections detail the observations recorded during the facade inspection.", font: "Arial", size: 22 })],
          spacing: { after: 150 },
        }));

        let sectionNum = 2;
        // Observations grouped by system
        for (const sys of systems) {
          const sysObs = obsBySystem[sys.id] || [];
          if (sysObs.length === 0) continue;

          obsChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: `4.${sectionNum} ${sys.name}`, font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
            spacing: { before: 300, after: 150 },
          }));
          sectionNum++;

          for (const obs of sysObs) {
            const bookmarkId = sanitizeBookmark(obs.observationId);
            obsChildren.push(new Paragraph({
              heading: HeadingLevel.HEADING_3,
              children: [
                new BookmarkStart(bookmarkId, getBookmarkLinkId(obs.observationId)),
                new TextRun({ text: `${obs.observationId} ${obs.defectCategory}`, font: "Arial", size: 24, bold: true, color: DARK_GRAY }),
                new BookmarkEnd(getBookmarkLinkId(obs.observationId)),
              ],
              spacing: { before: 200, after: 100 },
            }));

            // Location
            obsChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Location: ", font: "Arial", size: 22, bold: true }),
                new TextRun({ text: obs.location, font: "Arial", size: 22 }),
              ],
              spacing: { after: 50 },
            }));

            // Severity & Extent
            obsChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Severity: ", font: "Arial", size: 22, bold: true }),
                new TextRun({ text: `${obs.severity} \u2014 ${obs.extent}`, font: "Arial", size: 22 }),
              ],
              spacing: { after: 100 },
            }));

            // Elevation reference
            if (pinByObs[obs.id]) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: `Refer to ${pinByObs[obs.id].elevationName}, Pin ${pinByObs[obs.id].observationId}.`, font: "Arial", size: 20, italics: true, color: MUTED }),
                ],
                spacing: { after: 100 },
              }));
            }

            // Field note (engineer's raw input)
            if (obs.fieldNote && obs.fieldNote.trim()) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: "Field note: ", font: "Arial", size: 20, bold: true, color: MUTED }),
                  new TextRun({ text: obs.fieldNote, font: "Arial", size: 20, italics: true, color: MUTED }),
                ],
                spacing: { after: 80 },
              }));
            }

            // AI Narrative — render with markdown-aware structure (numbered/lettered)
            if (obs.aiNarrative) {
              obsChildren.push(...renderNarrativeParagraphs(obs.aiNarrative, { fontSize: 22, afterSpacing: 100 }));
            }

            // Observation photos
            const { paragraphs: alsoParagraphs, photoLabels: photoLocLabels } = buildAlsoObservedAtBlock(obs.id);
            if (alsoParagraphs.length > 0) {
              obsChildren.push(...alsoParagraphs);
            }
            const oPhotos = obsPhotosMap[obs.id] || [];
            if (oPhotos.length > 0) {
              obsChildren.push(...buildPhotoRows(oPhotos, figureCounter, photoLocLabels));
            }

            // Recommendations for this observation
            const obsRecs = recsByObs[obs.id] || [];
            if (obsRecs.length > 0) {
              for (const rec of obsRecs) {
                obsChildren.push(new Paragraph({
                  children: [
                    new TextRun({ text: "Recommended action: ", font: "Arial", size: 22, bold: true }),
                    new TextRun({ text: rec.action, font: "Arial", size: 22 }),
                  ],
                  spacing: { before: 100, after: 50 },
                }));
                obsChildren.push(new Paragraph({
                  children: [
                    new TextRun({ text: `Timeframe: ${rec.timeframe} | Category: ${rec.category} | Budget: ${rec.budgetEstimate || "TBD"}`, font: "Arial", size: 20, color: MUTED }),
                  ],
                  spacing: { after: 150 },
                }));
              }
            }
          }
        }

        // Unlinked observations
        if (unlinkedObs.length > 0) {
          obsChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: `4.${sectionNum} General Observations`, font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
            spacing: { before: 300, after: 150 },
          }));

          for (const obs of unlinkedObs) {
            const bookmarkId = sanitizeBookmark(obs.observationId);
            obsChildren.push(new Paragraph({
              heading: HeadingLevel.HEADING_3,
              children: [
                new BookmarkStart(bookmarkId, getBookmarkLinkId(obs.observationId)),
                new TextRun({ text: `${obs.observationId} ${obs.defectCategory}`, font: "Arial", size: 24, bold: true, color: DARK_GRAY }),
                new BookmarkEnd(getBookmarkLinkId(obs.observationId)),
              ],
              spacing: { before: 200, after: 100 },
            }));

            obsChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Location: ", font: "Arial", size: 22, bold: true }),
                new TextRun({ text: obs.location, font: "Arial", size: 22 }),
              ],
              spacing: { after: 50 },
            }));

            obsChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "Severity: ", font: "Arial", size: 22, bold: true }),
                new TextRun({ text: `${obs.severity} \u2014 ${obs.extent}`, font: "Arial", size: 22 }),
              ],
              spacing: { after: 100 },
            }));

            if (pinByObs[obs.id]) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: `Refer to ${pinByObs[obs.id].elevationName}, Pin ${pinByObs[obs.id].observationId}.`, font: "Arial", size: 20, italics: true, color: MUTED }),
                ],
                spacing: { after: 100 },
              }));
            }

            if (obs.fieldNote && obs.fieldNote.trim()) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: "Field note: ", font: "Arial", size: 20, bold: true, color: MUTED }),
                  new TextRun({ text: obs.fieldNote, font: "Arial", size: 20, italics: true, color: MUTED }),
                ],
                spacing: { after: 80 },
              }));
            }

            if (obs.aiNarrative) {
              obsChildren.push(...renderNarrativeParagraphs(obs.aiNarrative, { fontSize: 22, afterSpacing: 100 }));
            }

            const { paragraphs: alsoParagraphs, photoLabels: photoLocLabels } = buildAlsoObservedAtBlock(obs.id);
            if (alsoParagraphs.length > 0) {
              obsChildren.push(...alsoParagraphs);
            }
            const oPhotos = obsPhotosMap[obs.id] || [];
            if (oPhotos.length > 0) {
              obsChildren.push(...buildPhotoRows(oPhotos, figureCounter, photoLocLabels));
            }

            const obsRecs = recsByObs[obs.id] || [];
            for (const rec of obsRecs) {
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: "Recommended action: ", font: "Arial", size: 22, bold: true }),
                  new TextRun({ text: rec.action, font: "Arial", size: 22 }),
                ],
                spacing: { before: 100, after: 50 },
              }));
              obsChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: `Timeframe: ${rec.timeframe} | Category: ${rec.category} | Budget: ${rec.budgetEstimate || "TBD"}`, font: "Arial", size: 20, color: MUTED }),
                ],
                spacing: { after: 150 },
              }));
            }
          }
        }
      }

      // v2 Appendix A — elevation drawings with pinned observations (built here so
      // its figure numbers follow the Section 4 photos).
      if (v2 && projectElevations.length > 0) {
        appendixChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: "Appendix A \u2013 Elevations", font: "Arial", size: 36, bold: true, color: TEAL })],
          spacing: { before: 400, after: 200 },
        }));
        await renderElevationFigures(appendixChildren);
      }

      // === SECTION 5: CAPEX SUMMARY ===
      const capexChildren: (Paragraph | Table)[] = [];
      capexChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: v2 ? "5. Works BUDGET Summary" : "5. CAPEX Summary", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

      capexChildren.push(new Paragraph({
        children: [new TextRun({ text: "The following table is an aggregation of the recommendations presented in this report, allocated against key timeframes.", font: "Arial", size: 22 })],
        spacing: { after: 200 },
      }));

      if (allRecommendations.length > 0) {
        const allCapexData = allRecommendations.map(rec => {
          const obs = allObservations.find(o => o.id === rec.observationId);
          return {
            obsId: obs?.observationId || "",
            location: obs?.location || "",
            defect: obs?.defectCategory || "",
            rec,
            severity: effectiveSeverity(rec.category, obs?.severity),
          };
        }).sort((a, b) => a.obsId.localeCompare(b.obsId));

        capexChildren.push(new Table({
          layout: TableLayoutType.FIXED,
          width: { size: TEXT_W, type: WidthType.DXA },
          ...(v2 ? { columnWidths: [850, 1300, 1300, 3316, 1300, 1200, 1200], borders: V2_TABLE_BORDERS } : {}),
          rows: v2
            ? buildBudgetTableRowsV2(allRecommendations.map(rec => ({ rec, obs: allObservations.find(o => o.id === rec.observationId) })))
            : buildCapexTableRows(allCapexData),
        } as any));
      } else {
        capexChildren.push(new Paragraph({
          children: [new TextRun({ text: "No recommendations recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      }

      // Build the document with multiple sections
      const pageLegacy = { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } };
      // v2: 0.5" side margins, header/footer close to the page edge (as the final report).
      const pageV2 = { size: { width: 11906, height: 16838 }, margin: { top: 1200, right: 720, bottom: 1000, left: 720, header: 600, footer: 460 } };
      const page = v2 ? pageV2 : pageLegacy;
      const contentSection = (children: any[], extra: any = {}) => ({
        properties: { page: { ...page, ...(extra.page || {}) } },
        headers: { default: contentHeader },
        footers: { default: contentFooter },
        children,
      });

      // v2 CONTENTS page: a real Word TOC field (headings 1–3) with the entries
      // pre-filled so it reads correctly before Word refreshes the page numbers.
      const tocChildren: any[] = [];
      if (v2) {
        const entries: { title: string; level: number }[] = [];
        for (const arr of [execChildren, introChildren, siteChildren, obsChildren, capexChildren, appendixChildren] as any[][]) {
          for (const c of arr) { const e = v2Toc.get(c); if (e) entries.push(e); }
        }
        tocChildren.push(new Paragraph({ children: [new TextRun({ __raw: true, text: "CONTENTS", size: 32, color: "0F4761" } as any)], spacing: { after: 120 } }));
        tocChildren.push(new TableOfContents("CONTENTS", { hyperlink: true, headingStyleRange: "1-3", cachedEntries: entries } as any));
      }

      const v2Styles = {
        default: { document: { run: { font: V2_FONT, size: 22, color: BLACK } } },
        paragraphStyles: [
          { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: V2_FONT, size: 40, color: V2_HEAD_GREY }, paragraph: { spacing: { before: 0, after: 200 }, keepNext: true } },
          { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: V2_FONT, size: 32, color: BLACK }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true } },
          { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: V2_FONT, size: 28, color: BLACK }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true } },
        ],
      };
      const doc = new Document({
        styles: v2 ? (v2Styles as any) : {
          default: {
            document: {
              run: { font: "Arial", size: 22 },
            },
          },
        },
        ...(v2 ? {
          features: { updateFields: true },
          numbering: { config: [{ reference: "v2-bullet", levels: [0, 1, 2].map(level => ({
            level, format: LevelFormat.BULLET, text: "\u25AA", alignment: AlignmentType.LEFT,
            style: { run: { color: V2_RULE_TEAL, font: V2_FONT }, paragraph: { indent: { left: 360 * (level + 1), hanging: 360 } } },
          })) }] },
        } : {}),
        sections: [
          // Cover page - no header/footer
          {
            properties: { page: v2 ? { ...pageV2, margin: { ...pageV2.margin, top: 1440, right: 1400 } } : pageLegacy },
            children: coverChildren,
          },
          ...(v2 ? [contentSection(tocChildren, { page: { pageNumbers: { start: 1, formatType: NumberFormat.LOWER_ROMAN } } })] : []),
          // Executive Summary
          contentSection(execChildren, v2 ? { page: { pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } } : {}),
          // Introduction
          contentSection(introChildren),
          // Site Description
          contentSection(siteChildren),
          // Observations
          contentSection(obsChildren),
          // CAPEX Summary
          contentSection(capexChildren),
          ...(appendixChildren.length ? [contentSection(appendixChildren)] : []),
        ],
      } as any);

      const buffer = await Packer.toBuffer(doc);
      const filename = `${project.afcReference || project.name}-Report.docx`.replace(/[^a-zA-Z0-9._-]/g, "_");

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(Buffer.from(buffer));

      // Post-export: mark project as completed (first time only) and trigger
      // background ingestion of finalised narratives into the Report Library
      // so future projects can RAG against Lana's edited voice. Fire-and-forget
      // so it does not delay the response or block on OpenAI calls.
      try {
        if (!(project as any).completedAt) {
          await storage.updateProject(project.id, { completedAt: new Date().toISOString() } as any);
        }
        ingestProjectNarrativesIntoLibrary(project.id).catch((e) =>
          console.error("[auto-ingest] background error:", e?.message || e),
        );
      } catch (e: any) {
        console.error("[auto-ingest] failed to mark completedAt:", e?.message || e);
      }
    } catch (err: any) {
      console.error("Word export error:", err);
      res.status(500).json({ message: err.message || "Word export failed" });
    }
  });

  return httpServer;
}
