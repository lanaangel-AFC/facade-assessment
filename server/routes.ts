import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, dataDir } from "./storage";
import {
  insertProjectSchema,
  insertFacadeSystemSchema,
  insertObservationSchema,
  insertRecommendationSchema,
} from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";

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

  return httpServer;
}
