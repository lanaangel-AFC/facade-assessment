import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, dataDir } from "./storage";
import {
  insertProjectSchema,
  insertFacadeSystemSchema,
  insertObservationSchema,
  insertRecommendationSchema,
} from "@shared/schema";
import type { FacadeSystem, Observation, Recommendation, Photo } from "@shared/schema";
import {
  identifySystem,
  generateSystemDescription,
  generateObservationNarrative,
  generateRecommendation,
  generateExecutiveSummary,
} from "./ai";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
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
    const parsed = insertProjectSchema.safeParse(req.body);
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
    res.json(observation);
  });

  app.post("/api/projects/:projectId/observations", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const systemId = req.body.systemId ? Number(req.body.systemId) : null;
    let observationId = req.body.observationId;

    // Auto-generate observation ID if not provided and systemId is given
    if (!observationId && systemId) {
      observationId = await storage.getNextObservationId(projectId, systemId);
    }

    const data = { ...req.body, projectId, systemId, observationId };
    const parsed = insertObservationSchema.safeParse(data);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const observation = await storage.createObservation(parsed.data);
    res.status(201).json(observation);
  });

  app.patch("/api/observations/:id", async (req, res) => {
    const observation = await storage.updateObservation(Number(req.params.id), req.body);
    if (!observation) return res.status(404).json({ message: "Observation not found" });
    res.json(observation);
  });

  app.delete("/api/observations/:id", async (req, res) => {
    await storage.deleteObservation(Number(req.params.id));
    res.status(204).end();
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

  // Upload photo for an observation
  app.post("/api/observations/:observationId/photos", upload.single("photo"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const observationId = Number(req.params.observationId);
    const slot = req.body.slot || "photo1";

    // Get the observation to find its projectId
    const observation = await storage.getObservation(observationId);
    if (!observation) return res.status(404).json({ message: "Observation not found" });

    // If a photo already exists in this slot for this observation, replace it
    const existingPhotos = await storage.getPhotosByObservation(observationId);
    const existingInSlot = existingPhotos.find((p) => p.slot === slot);
    if (existingInSlot) {
      const oldPath = path.join(uploadDir, existingInSlot.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      await storage.deletePhoto(existingInSlot.id);
    }

    const photo = await storage.createPhoto({
      projectId: observation.projectId,
      systemId: null,
      observationId,
      filename: req.file.filename,
      caption: req.body.caption || "",
      slot,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(photo);
  });

  // Update photo caption
  app.patch("/api/photos/:id", async (req, res) => {
    const photo = await storage.updatePhotoCaption(Number(req.params.id), req.body.caption || "");
    if (!photo) return res.status(404).json({ message: "Photo not found" });
    res.json(photo);
  });

  app.delete("/api/photos/:id", async (req, res) => {
    const photo = await storage.deletePhoto(Number(req.params.id));
    if (photo) {
      const filePath = path.join(uploadDir, photo.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
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
      const { observationId } = req.body;
      if (!observationId) return res.status(400).json({ message: "observationId is required" });
      const narrative = await generateObservationNarrative(Number(observationId));
      res.json({ narrative });
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Narrative generation failed" });
    }
  });

  app.post("/api/ai/generate-recommendation", async (req, res) => {
    try {
      const { observationId } = req.body;
      if (!observationId) return res.status(400).json({ message: "observationId is required" });
      const result = await generateRecommendation(Number(observationId));
      res.json(result);
    } catch (err: any) {
      const status = err.message?.includes("API key") ? 400 : 500;
      res.status(status).json({ message: err.message || "Recommendation generation failed" });
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

  // === WORD EXPORT ===
  app.get("/api/export/word/:projectId", async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const systems = await storage.getSystemsByProject(projectId);
      const allObservations = await storage.getObservationsByProject(projectId);
      const allRecommendations = await storage.getRecommendationsByProject(projectId);

      // Fetch photos for each system and observation
      const systemPhotosMap: Record<number, Photo[]> = {};
      for (const sys of systems) {
        systemPhotosMap[sys.id] = await storage.getPhotosBySystem(sys.id);
      }
      const obsPhotosMap: Record<number, Photo[]> = {};
      for (const obs of allObservations) {
        obsPhotosMap[obs.id] = await storage.getPhotosByObservation(obs.id);
      }

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
      const buildPhotoRows = (photoList: Photo[], figureCounter: { n: number }): Paragraph[] => {
        const paragraphs: Paragraph[] = [];
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
            // Captions
            const cap1 = photoList[i].caption || "";
            const capText = `Figure ${figureCounter.n}${cap1 ? ` \u2013 ${cap1}` : ""}`;
            figureCounter.n++;
            let capLine = capText;
            if (i + 1 < photoList.length) {
              const cap2 = photoList[i + 1].caption || "";
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

      // Teal border for headers/footers
      const tealBorder = { style: BorderStyle.SINGLE, size: 6, color: TEAL };
      const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };

      // Common header for content sections
      const contentHeader = new Header({
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
      const contentFooter = new Footer({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: "FACADE DUE DILIGENCE REPORT", font: "Arial", size: 16, color: MUTED }),
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
        isHeader: boolean, isAlt: boolean, withLink: boolean
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

        const idChildren = withLink && !isHeader
          ? [new InternalHyperlink({
              anchor: sanitizeBookmark(obsId),
              children: [new TextRun({ text: obsId, font: "Arial", size: fontSize, color: TEAL, bold: true, underline: {} })],
            })]
          : [textRun(obsId)];

        return new TableRow({
          children: [
            new TableCell({ ...cellProps(800), children: [new Paragraph({ children: idChildren })] }),
            new TableCell({ ...cellProps(1200), children: [new Paragraph({ children: [textRun(location)] })] }),
            new TableCell({ ...cellProps(1800), children: [new Paragraph({ children: [textRun(defect)] })] }),
            new TableCell({ ...cellProps(2200), children: [new Paragraph({ children: [textRun(action)] })] }),
            new TableCell({ ...cellProps(800), children: [new Paragraph({ children: [textRun(timeframe)] })] }),
            new TableCell({ ...cellProps(900), children: [new Paragraph({ children: [textRun(category)] })] }),
            new TableCell({ ...cellProps(1326), children: [new Paragraph({ children: [textRun(budget)] })] }),
          ],
        });
      };

      // Build CAPEX table rows for a set of recommendations
      const buildCapexTableRows = (recs: { obsId: string; location: string; defect: string; rec: Recommendation }[]): TableRow[] => {
        const rows: TableRow[] = [
          buildCapexRow("ID", "Location", "Defect/Issue", "Actions", "Time", "Category", "Budget", true, false, false),
        ];
        recs.forEach((r, idx) => {
          rows.push(buildCapexRow(
            r.obsId, r.location, r.defect,
            r.rec.action, r.rec.timeframe, r.rec.category, r.rec.budgetEstimate || "",
            false, idx % 2 === 1, true
          ));
        });
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
        children: [new TextRun({ text: "FACADE DUE DILIGENCE REPORT", font: "Arial", size: 32, bold: true, color: DARK_GRAY })],
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

      // === SECTION 1: EXECUTIVE SUMMARY ===
      const execChildren: (Paragraph | Table)[] = [];
      execChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "1. Executive Summary", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

      if (project.executiveSummary) {
        // Split executive summary into paragraphs
        const summaryParagraphs = project.executiveSummary.split("\n").filter(l => l.trim());
        for (const para of summaryParagraphs) {
          execChildren.push(new Paragraph({
            children: [new TextRun({ text: para, font: "Arial", size: 22 })],
            spacing: { after: 150 },
          }));
        }
      } else {
        execChildren.push(new Paragraph({
          children: [new TextRun({ text: "Executive summary not yet generated.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      }

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
          };
        });

        execChildren.push(new Table({
          layout: TableLayoutType.FIXED,
          width: { size: 9026, type: WidthType.DXA },
          rows: buildCapexTableRows(majorCapexData),
        } as any));
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
      introChildren.push(new Paragraph({
        children: [new TextRun({ text: `Angel Fa\u00E7ade Consulting (AFC) was engaged by ${project.client} to carry out a condition assessment of the building envelope(s) at ${project.address}.`, font: "Arial", size: 22 })],
        spacing: { after: 150 },
      }));

      // 2.2 Inspection
      introChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "2.2 Inspection", font: "Arial", size: 28, bold: true, color: DARK_GRAY })],
        spacing: { before: 300, after: 150 },
      }));
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

      // === SECTION 3: SITE DESCRIPTION ===
      const siteChildren: Paragraph[] = [];
      const figureCounter = { n: 1 };

      siteChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "3. Site Description", font: "Arial", size: 36, bold: true, color: TEAL })],
        spacing: { before: 400, after: 200 },
      }));

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

          if (sys.aiDescription) {
            const descParas = sys.aiDescription.split("\n").filter(l => l.trim());
            for (const p of descParas) {
              siteChildren.push(new Paragraph({
                children: [new TextRun({ text: p, font: "Arial", size: 22 })],
                spacing: { after: 100 },
              }));
            }
          }

          // System photos
          const sysPhotos = systemPhotosMap[sys.id] || [];
          if (sysPhotos.length > 0) {
            siteChildren.push(...buildPhotoRows(sysPhotos, figureCounter));
          }
        });
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

      if (allObservations.length === 0) {
        obsChildren.push(new Paragraph({
          children: [new TextRun({ text: "No observations recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
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

            // AI Narrative
            if (obs.aiNarrative) {
              const narrativeParas = obs.aiNarrative.split("\n").filter(l => l.trim());
              for (const p of narrativeParas) {
                obsChildren.push(new Paragraph({
                  children: [new TextRun({ text: p, font: "Arial", size: 22 })],
                  spacing: { after: 100 },
                }));
              }
            }

            // Observation photos
            const oPhotos = obsPhotosMap[obs.id] || [];
            if (oPhotos.length > 0) {
              obsChildren.push(...buildPhotoRows(oPhotos, figureCounter));
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

            if (obs.aiNarrative) {
              const narrativeParas = obs.aiNarrative.split("\n").filter(l => l.trim());
              for (const p of narrativeParas) {
                obsChildren.push(new Paragraph({
                  children: [new TextRun({ text: p, font: "Arial", size: 22 })],
                  spacing: { after: 100 },
                }));
              }
            }

            const oPhotos = obsPhotosMap[obs.id] || [];
            if (oPhotos.length > 0) {
              obsChildren.push(...buildPhotoRows(oPhotos, figureCounter));
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

      // === SECTION 5: CAPEX SUMMARY ===
      const capexChildren: (Paragraph | Table)[] = [];
      capexChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "5. CAPEX Summary", font: "Arial", size: 36, bold: true, color: TEAL })],
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
          };
        }).sort((a, b) => a.obsId.localeCompare(b.obsId));

        capexChildren.push(new Table({
          layout: TableLayoutType.FIXED,
          width: { size: 9026, type: WidthType.DXA },
          rows: buildCapexTableRows(allCapexData),
        } as any));
      } else {
        capexChildren.push(new Paragraph({
          children: [new TextRun({ text: "No recommendations recorded.", font: "Arial", size: 22, italics: true, color: MUTED })],
          spacing: { after: 150 },
        }));
      }

      // Build the document with multiple sections
      const doc = new Document({
        styles: {
          default: {
            document: {
              run: { font: "Arial", size: 22 },
            },
          },
        },
        sections: [
          // Cover page - no header/footer
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
              },
            },
            children: coverChildren,
          },
          // Executive Summary
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
              },
            },
            headers: { default: contentHeader },
            footers: { default: contentFooter },
            children: execChildren,
          },
          // Introduction
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
              },
            },
            headers: { default: contentHeader },
            footers: { default: contentFooter },
            children: introChildren,
          },
          // Site Description
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
              },
            },
            headers: { default: contentHeader },
            footers: { default: contentFooter },
            children: siteChildren,
          },
          // Observations
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
              },
            },
            headers: { default: contentHeader },
            footers: { default: contentFooter },
            children: obsChildren,
          },
          // CAPEX Summary
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
              },
            },
            headers: { default: contentHeader },
            footers: { default: contentFooter },
            children: capexChildren,
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      const filename = `${project.afcReference || project.name}-Report.docx`.replace(/[^a-zA-Z0-9._-]/g, "_");

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(Buffer.from(buffer));
    } catch (err: any) {
      console.error("Word export error:", err);
      res.status(500).json({ message: err.message || "Word export failed" });
    }
  });

  return httpServer;
}
