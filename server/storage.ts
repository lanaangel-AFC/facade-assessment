import {
  type User, type InsertUser, users,
  type Project, type InsertProject, projects,
  type FacadeSystem, type InsertFacadeSystem, facadeSystems,
  type Observation, type InsertObservation, observations,
  type Recommendation, type InsertRecommendation, recommendations,
  type Photo, type InsertPhoto, photos,
  type Setting, settings,
  type TrainingData, type InsertTrainingData, aiTrainingData,
  type Elevation, type InsertElevation, elevations,
  type ElevationPin, type InsertElevationPin, elevationPins,
  type ObservationGroup, type InsertObservationGroup, observationGroups,
  type CustomIndicator, type InsertCustomIndicator, customIndicators,
  type Drop, type InsertDrop, drops,
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

// Auto-create tables that may not exist yet (safe to run on every start)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    client TEXT NOT NULL,
    inspector TEXT NOT NULL,
    afc_reference TEXT DEFAULT '',
    revision TEXT DEFAULT '01',
    building_age TEXT DEFAULT '',
    building_use TEXT DEFAULT '',
    storey_count TEXT DEFAULT '',
    refurbishment_history TEXT DEFAULT '',
    inspection_dates TEXT DEFAULT '[]',
    inspection_scope TEXT DEFAULT '',
    limitations TEXT DEFAULT '[]',
    background_docs TEXT DEFAULT '[]',
    executive_summary TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS facade_systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    system_type TEXT NOT NULL,
    materials TEXT DEFAULT '[]',
    key_features TEXT DEFAULT '[]',
    estimated_age TEXT DEFAULT '',
    related_systems TEXT DEFAULT '',
    ai_description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    system_id INTEGER,
    observation_id TEXT NOT NULL,
    location TEXT NOT NULL,
    defect_category TEXT NOT NULL,
    severity TEXT NOT NULL,
    extent TEXT NOT NULL,
    field_note TEXT DEFAULT '',
    indicators TEXT DEFAULT '[]',
    ai_narrative TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    category TEXT NOT NULL,
    budget_estimate TEXT DEFAULT '',
    budget_basis TEXT DEFAULT '',
    dependencies TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    system_id INTEGER,
    observation_id INTEGER,
    filename TEXT NOT NULL,
    caption TEXT DEFAULT '',
    slot TEXT DEFAULT 'photo',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_training_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    input_data TEXT NOT NULL,
    ai_output TEXT NOT NULL,
    user_corrected TEXT DEFAULT '',
    accepted INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS elevations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS elevation_pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    elevation_id INTEGER NOT NULL,
    observation_id INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS observation_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    group_key TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    combined_narrative TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custom_indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    drop_number TEXT NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Add executive_summary column to projects if it doesn't exist
try {
  sqlite.exec(`ALTER TABLE projects ADD COLUMN executive_summary TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists — ignore
}

// Add elevation_id column to observations if it doesn't exist
try {
  sqlite.exec(`ALTER TABLE observations ADD COLUMN elevation_id INTEGER DEFAULT NULL`);
} catch (e) {
  // Column already exists — ignore
}

// Feature 1: grid location columns on observations
try { sqlite.exec(`ALTER TABLE observations ADD COLUMN grid_drop TEXT DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE observations ADD COLUMN grid_elevation TEXT DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE observations ADD COLUMN grid_level TEXT DEFAULT ''`); } catch {}

// Feature 2: inspection status + observation grouping
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN inspection_status TEXT DEFAULT 'in_progress'`); } catch {}
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN observation_grouping TEXT DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN project_elevations TEXT DEFAULT '[]'`); } catch {}
try { sqlite.exec(`ALTER TABLE observations ADD COLUMN group_id INTEGER DEFAULT NULL`); } catch {}

// Roof plan feature columns on projects
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN roof_plan_image_path TEXT DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN roof_plan_original_name TEXT DEFAULT ''`); } catch {}

export const db = drizzle(sqlite);
export { dataDir };

export interface IStorage {
  // Settings
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  // Training Data
  createTrainingData(data: InsertTrainingData): Promise<TrainingData>;
  getTrainingDataCount(): Promise<number>;
  getAllTrainingData(): Promise<TrainingData[]>;
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
  getPhoto(id: number): Promise<Photo | undefined>;
  getPhotosBySystem(systemId: number): Promise<Photo[]>;
  getPhotosByObservation(observationId: number): Promise<Photo[]>;
  createPhoto(photo: InsertPhoto): Promise<Photo>;
  updatePhotoCaption(id: number, caption: string): Promise<Photo | undefined>;
  deletePhoto(id: number): Promise<Photo | undefined>;
}

export class DatabaseStorage implements IStorage {
  // Settings
  async getSetting(key: string): Promise<string | undefined> {
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    return row?.value;
  }
  async setSetting(key: string, value: string): Promise<void> {
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    if (existing) {
      db.update(settings).set({ value }).where(eq(settings.key, key)).run();
    } else {
      db.insert(settings).values({ key, value }).run();
    }
  }

  // Training Data
  async createTrainingData(data: InsertTrainingData): Promise<TrainingData> {
    return db.insert(aiTrainingData).values(data).returning().get();
  }
  async getTrainingDataCount(): Promise<number> {
    const rows = db.select().from(aiTrainingData).all();
    return rows.length;
  }
  async getAllTrainingData(): Promise<TrainingData[]> {
    return db.select().from(aiTrainingData).all();
  }

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
    // Delete elevation pins for elevations in this project
    const projectElevations = db.select().from(elevations).where(eq(elevations.projectId, id)).all();
    for (const elev of projectElevations) {
      db.delete(elevationPins).where(eq(elevationPins.elevationId, elev.id)).run();
    }
    db.delete(elevations).where(eq(elevations.projectId, id)).run();
    db.delete(observations).where(eq(observations.projectId, id)).run();
    db.delete(recommendations).where(eq(recommendations.projectId, id)).run();
    db.delete(facadeSystems).where(eq(facadeSystems.projectId, id)).run();
    db.delete(drops).where(eq(drops.projectId, id)).run();
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
    // Cascade: delete recommendations, photos, and elevation pins for this observation
    db.delete(recommendations).where(eq(recommendations.observationId, id)).run();
    db.delete(photos).where(eq(photos.observationId, id)).run();
    db.delete(elevationPins).where(eq(elevationPins.observationId, id)).run();
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
  async getPhoto(id: number): Promise<Photo | undefined> {
    return db.select().from(photos).where(eq(photos.id, id)).get();
  }
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

  // Elevations
  async createElevation(data: InsertElevation): Promise<Elevation> {
    return db.insert(elevations).values(data).returning().get();
  }
  async getElevation(id: number): Promise<Elevation | undefined> {
    return db.select().from(elevations).where(eq(elevations.id, id)).get();
  }
  async getElevationsByProject(projectId: number): Promise<Elevation[]> {
    return db.select().from(elevations).where(eq(elevations.projectId, projectId)).all();
  }
  async updateElevation(id: number, data: Partial<InsertElevation>): Promise<Elevation | undefined> {
    return db.update(elevations).set(data).where(eq(elevations.id, id)).returning().get();
  }
  async deleteElevation(id: number): Promise<Elevation | undefined> {
    const elevation = db.select().from(elevations).where(eq(elevations.id, id)).get();
    if (!elevation) return undefined;
    db.delete(elevationPins).where(eq(elevationPins.elevationId, id)).run();
    db.delete(elevations).where(eq(elevations.id, id)).run();
    return elevation;
  }

  // Elevation Pins
  async createElevationPin(data: InsertElevationPin): Promise<ElevationPin> {
    return db.insert(elevationPins).values(data).returning().get();
  }
  async getElevationPin(id: number): Promise<ElevationPin | undefined> {
    return db.select().from(elevationPins).where(eq(elevationPins.id, id)).get();
  }
  async getPinsByElevation(elevationId: number): Promise<ElevationPin[]> {
    return db.select().from(elevationPins).where(eq(elevationPins.elevationId, elevationId)).all();
  }
  async getPinByObservation(observationId: number): Promise<ElevationPin | undefined> {
    return db.select().from(elevationPins).where(eq(elevationPins.observationId, observationId)).get();
  }
  async updateElevationPin(id: number, data: Partial<InsertElevationPin>): Promise<ElevationPin | undefined> {
    return db.update(elevationPins).set(data).where(eq(elevationPins.id, id)).returning().get();
  }
  async deleteElevationPin(id: number): Promise<void> {
    db.delete(elevationPins).where(eq(elevationPins.id, id)).run();
  }
  async deleteElevationPinByObservation(observationId: number): Promise<void> {
    db.delete(elevationPins).where(eq(elevationPins.observationId, observationId)).run();
  }

  // Observation Groups
  async getGroupsByProject(projectId: number): Promise<ObservationGroup[]> {
    return db.select().from(observationGroups).where(eq(observationGroups.projectId, projectId)).all();
  }
  async getGroup(id: number): Promise<ObservationGroup | undefined> {
    return db.select().from(observationGroups).where(eq(observationGroups.id, id)).get();
  }
  async createGroup(data: InsertObservationGroup): Promise<ObservationGroup> {
    return db.insert(observationGroups).values(data).returning().get();
  }
  async updateGroup(id: number, data: Partial<InsertObservationGroup>): Promise<ObservationGroup | undefined> {
    return db.update(observationGroups).set(data).where(eq(observationGroups.id, id)).returning().get();
  }
  async deleteGroup(id: number): Promise<void> {
    db.delete(observationGroups).where(eq(observationGroups.id, id)).run();
  }
  async deleteGroupsByProject(projectId: number): Promise<void> {
    db.delete(observationGroups).where(eq(observationGroups.projectId, projectId)).run();
  }

  // Custom Indicators
  async getCustomIndicatorsByProject(projectId: number): Promise<CustomIndicator[]> {
    return db.select().from(customIndicators).where(eq(customIndicators.projectId, projectId)).all();
  }
  async createCustomIndicator(data: InsertCustomIndicator): Promise<CustomIndicator> {
    return db.insert(customIndicators).values(data).returning().get();
  }
  async deleteCustomIndicator(id: number): Promise<void> {
    db.delete(customIndicators).where(eq(customIndicators.id, id)).run();
  }

  // Drops (roof plan markers)
  async getDropsByProject(projectId: number): Promise<Drop[]> {
    return db.select().from(drops).where(eq(drops.projectId, projectId)).all();
  }
  async getDrop(id: number): Promise<Drop | undefined> {
    return db.select().from(drops).where(eq(drops.id, id)).get();
  }
  async createDrop(data: InsertDrop): Promise<Drop> {
    return db.insert(drops).values(data).returning().get();
  }
  async updateDrop(id: number, data: Partial<InsertDrop>): Promise<Drop | undefined> {
    return db.update(drops).set(data).where(eq(drops.id, id)).returning().get();
  }
  async deleteDrop(id: number): Promise<void> {
    db.delete(drops).where(eq(drops.id, id)).run();
  }
  async deleteDropsByProject(projectId: number): Promise<void> {
    db.delete(drops).where(eq(drops.projectId, projectId)).run();
  }

  // Project roof plan
  async updateProjectRoofPlan(projectId: number, imagePath: string, originalName: string): Promise<Project | undefined> {
    return db.update(projects)
      .set({ roofPlanImagePath: imagePath, roofPlanOriginalName: originalName } as any)
      .where(eq(projects.id, projectId))
      .returning()
      .get();
  }
  async clearProjectRoofPlan(projectId: number): Promise<Project | undefined> {
    return db.update(projects)
      .set({ roofPlanImagePath: "", roofPlanOriginalName: "" } as any)
      .where(eq(projects.id, projectId))
      .returning()
      .get();
  }
}

export const storage = new DatabaseStorage();
