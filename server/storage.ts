import {
  type User, type InsertUser, users,
  type Project, type InsertProject, projects,
  type FacadeSystem, type InsertFacadeSystem, facadeSystems,
  type Observation, type InsertObservation, observations,
  type Recommendation, type InsertRecommendation, recommendations,
  type Photo, type InsertPhoto, photos,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and } from "drizzle-orm";
import path from "path";
import fs from "fs";

// Use DATA_DIR env var for persistent storage (Railway volume), fallback to cwd
const dataDir = process.env.DATA_DIR || process.cwd();
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "data.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);
export { dataDir };

export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  // Projects
  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProject(id: number, project: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;
  // Facade Systems
  getSystemsByProject(projectId: number): Promise<FacadeSystem[]>;
  getSystem(id: number): Promise<FacadeSystem | undefined>;
  createSystem(system: InsertFacadeSystem): Promise<FacadeSystem>;
  updateSystem(id: number, system: Partial<InsertFacadeSystem>): Promise<FacadeSystem | undefined>;
  deleteSystem(id: number): Promise<void>;
  // Observations
  getObservationsByProject(projectId: number): Promise<Observation[]>;
  getObservation(id: number): Promise<Observation | undefined>;
  createObservation(observation: InsertObservation): Promise<Observation>;
  updateObservation(id: number, observation: Partial<InsertObservation>): Promise<Observation | undefined>;
  deleteObservation(id: number): Promise<void>;
  getNextObservationId(projectId: number, systemId: number): Promise<string>;
  // Recommendations
  getRecommendationsByObservation(observationId: number): Promise<Recommendation[]>;
  getRecommendationsByProject(projectId: number): Promise<Recommendation[]>;
  createRecommendation(recommendation: InsertRecommendation): Promise<Recommendation>;
  updateRecommendation(id: number, recommendation: Partial<InsertRecommendation>): Promise<Recommendation | undefined>;
  deleteRecommendation(id: number): Promise<void>;
  // Photos
  getPhotosBySystem(systemId: number): Promise<Photo[]>;
  getPhotosByObservation(observationId: number): Promise<Photo[]>;
  createPhoto(photo: InsertPhoto): Promise<Photo>;
  updatePhotoCaption(id: number, caption: string): Promise<Photo | undefined>;
  deletePhoto(id: number): Promise<Photo | undefined>;
}

export class DatabaseStorage implements IStorage {
  // Users
  async getUser(id: number): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.id, id)).get();
  }
  async getUserByUsername(username: string): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.username, username)).get();
  }
  async createUser(insertUser: InsertUser): Promise<User> {
    return db.insert(users).values(insertUser).returning().get();
  }

  // Projects
  async getProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(desc(projects.id)).all();
  }
  async getProject(id: number): Promise<Project | undefined> {
    return db.select().from(projects).where(eq(projects.id, id)).get();
  }
  async createProject(project: InsertProject): Promise<Project> {
    return db.insert(projects).values(project).returning().get();
  }
  async updateProject(id: number, project: Partial<InsertProject>): Promise<Project | undefined> {
    return db.update(projects).set(project).where(eq(projects.id, id)).returning().get();
  }
  async deleteProject(id: number): Promise<void> {
    // Cascade: delete all photos, recommendations, observations, systems for this project
    const projectObservations = db.select().from(observations).where(eq(observations.projectId, id)).all();
    for (const obs of projectObservations) {
      db.delete(recommendations).where(eq(recommendations.observationId, obs.id)).run();
      db.delete(photos).where(eq(photos.observationId, obs.id)).run();
    }
    const projectSystems = db.select().from(facadeSystems).where(eq(facadeSystems.projectId, id)).all();
    for (const sys of projectSystems) {
      db.delete(photos).where(eq(photos.systemId, sys.id)).run();
    }
    db.delete(observations).where(eq(observations.projectId, id)).run();
    db.delete(recommendations).where(eq(recommendations.projectId, id)).run();
    db.delete(facadeSystems).where(eq(facadeSystems.projectId, id)).run();
    db.delete(projects).where(eq(projects.id, id)).run();
  }

  // Facade Systems
  async getSystemsByProject(projectId: number): Promise<FacadeSystem[]> {
    return db.select().from(facadeSystems).where(eq(facadeSystems.projectId, projectId)).all();
  }
  async getSystem(id: number): Promise<FacadeSystem | undefined> {
    return db.select().from(facadeSystems).where(eq(facadeSystems.id, id)).get();
  }
  async createSystem(system: InsertFacadeSystem): Promise<FacadeSystem> {
    return db.insert(facadeSystems).values(system).returning().get();
  }
  async updateSystem(id: number, system: Partial<InsertFacadeSystem>): Promise<FacadeSystem | undefined> {
    return db.update(facadeSystems).set(system).where(eq(facadeSystems.id, id)).returning().get();
  }
  async deleteSystem(id: number): Promise<void> {
    // Cascade: delete photos for this system
    db.delete(photos).where(eq(photos.systemId, id)).run();
    db.delete(facadeSystems).where(eq(facadeSystems.id, id)).run();
  }

  // Observations
  async getObservationsByProject(projectId: number): Promise<Observation[]> {
    return db.select().from(observations).where(eq(observations.projectId, projectId)).all();
  }
  async getObservation(id: number): Promise<Observation | undefined> {
    return db.select().from(observations).where(eq(observations.id, id)).get();
  }
  async createObservation(observation: InsertObservation): Promise<Observation> {
    return db.insert(observations).values(observation).returning().get();
  }
  async updateObservation(id: number, observation: Partial<InsertObservation>): Promise<Observation | undefined> {
    return db.update(observations).set(observation).where(eq(observations.id, id)).returning().get();
  }
  async deleteObservation(id: number): Promise<void> {
    // Cascade: delete recommendations and photos for this observation
    db.delete(recommendations).where(eq(recommendations.observationId, id)).run();
    db.delete(photos).where(eq(photos.observationId, id)).run();
    db.delete(observations).where(eq(observations.id, id)).run();
  }

  async getNextObservationId(projectId: number, systemId: number): Promise<string> {
    // Get the system to determine its sort order for the section number
    const system = db.select().from(facadeSystems).where(eq(facadeSystems.id, systemId)).get();
    if (!system) return "4.1-1";

    // Get all systems for this project to determine the system's position
    const allSystems = db.select().from(facadeSystems)
      .where(eq(facadeSystems.projectId, projectId))
      .all();

    // Sort by sortOrder then by id for stable ordering
    allSystems.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    const systemIndex = allSystems.findIndex(s => s.id === systemId);
    const sectionNum = `4.${systemIndex + 1}`;

    // Count existing observations for this system
    const existing = db.select().from(observations)
      .where(eq(observations.projectId, projectId))
      .all();

    const matching = existing.filter(o => o.observationId.startsWith(sectionNum + "-"));
    const nextNum = matching.length + 1;

    return `${sectionNum}-${nextNum}`;
  }

  // Recommendations
  async getRecommendationsByObservation(observationId: number): Promise<Recommendation[]> {
    return db.select().from(recommendations).where(eq(recommendations.observationId, observationId)).all();
  }
  async getRecommendationsByProject(projectId: number): Promise<Recommendation[]> {
    return db.select().from(recommendations).where(eq(recommendations.projectId, projectId)).all();
  }
  async createRecommendation(recommendation: InsertRecommendation): Promise<Recommendation> {
    return db.insert(recommendations).values(recommendation).returning().get();
  }
  async updateRecommendation(id: number, recommendation: Partial<InsertRecommendation>): Promise<Recommendation | undefined> {
    return db.update(recommendations).set(recommendation).where(eq(recommendations.id, id)).returning().get();
  }
  async deleteRecommendation(id: number): Promise<void> {
    db.delete(recommendations).where(eq(recommendations.id, id)).run();
  }

  // Photos
  async getPhotosBySystem(systemId: number): Promise<Photo[]> {
    return db.select().from(photos).where(eq(photos.systemId, systemId)).all();
  }
  async getPhotosByObservation(observationId: number): Promise<Photo[]> {
    return db.select().from(photos).where(eq(photos.observationId, observationId)).all();
  }
  async createPhoto(photo: InsertPhoto): Promise<Photo> {
    return db.insert(photos).values(photo).returning().get();
  }
  async updatePhotoCaption(id: number, caption: string): Promise<Photo | undefined> {
    return db.update(photos).set({ caption }).where(eq(photos.id, id)).returning().get();
  }
  async deletePhoto(id: number): Promise<Photo | undefined> {
    const photo = db.select().from(photos).where(eq(photos.id, id)).get();
    if (photo) {
      db.delete(photos).where(eq(photos.id, id)).run();
    }
    return photo;
  }
}

export const storage = new DatabaseStorage();
