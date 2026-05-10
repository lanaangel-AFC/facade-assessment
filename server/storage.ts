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
  type CustomRoofType, type InsertCustomRoofType, customRoofTypes,
  type CustomDefectCategory, type InsertCustomDefectCategory, customDefectCategories,
  type ProjectRoofLevel, type InsertProjectRoofLevel, projectRoofLevels,
  type Drop, type InsertDrop, drops,
  type ReportLibraryDocument, type InsertReportLibraryDocument, reportLibraryDocuments,
  type ReportLibraryPassage, type InsertReportLibraryPassage, reportLibraryPassages,
  type ObservationLocation, type InsertObservationLocation, observationLocations,
  type ProjectDocument, type InsertProjectDocument, projectDocuments,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and, asc } from "drizzle-orm";
import path from "path";
import fs from "fs";

// Use DATA_DIR env var for persistent storage (Railway volume), fallback to cwd
const dataDir = process.env.DATA_DIR || process.cwd();
try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  console.log(`[storage] Using DATA_DIR: ${dataDir}`);
} catch (e) {
  console.error(`[storage] Failed to create DATA_DIR ${dataDir}:`, e);
}

const dbPath = path.join(dataDir, "data.db");
console.log(`[storage] Opening SQLite database at: ${dbPath}`);
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

// Auto-create tables that may not exist yet (safe to run on every start)
try {
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
  CREATE TABLE IF NOT EXISTS custom_roof_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custom_defect_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS report_library_documents (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    uploaded_at TEXT NOT NULL,
    extraction_status TEXT DEFAULT 'pending',
    extraction_error TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS report_library_passages (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT,
    source_section TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
`);
  console.log("[storage] Base CREATE TABLE migrations completed");
} catch (e) {
  console.error("[storage] Base CREATE TABLE migration failed:", e);
}

// Report library tables — ALTER TABLE for defensive future migrations
try { sqlite.exec(`ALTER TABLE report_library_documents ADD COLUMN extraction_error TEXT DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE report_library_passages ADD COLUMN source_section TEXT DEFAULT ''`); } catch {}

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

// Project Context — free-form notes fed into AI generation prompts
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN project_context TEXT DEFAULT ''`); } catch {}

// AI-rewritten introduction (polished Background/Introduction section text)
try { sqlite.exec(`ALTER TABLE projects ADD COLUMN ai_introduction TEXT DEFAULT ''`); } catch {}

// Roof types column on facade_systems
try { sqlite.exec(`ALTER TABLE facade_systems ADD COLUMN roof_types TEXT DEFAULT '[]'`); } catch {}

// Photo caption column (defensive — already declared in CREATE TABLE above, but add for legacy DBs)
try { sqlite.exec(`ALTER TABLE photos ADD COLUMN caption TEXT DEFAULT ''`); } catch {}

// Mixed-criteria observation grouping columns
try { sqlite.exec(`ALTER TABLE observation_groups ADD COLUMN grouping_criterion TEXT DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE observation_groups ADD COLUMN display_order INTEGER DEFAULT 0`); } catch {}

// Multi-location observations: additional location records and photo->location link
// NOTE: "drop" is a reserved SQL keyword — must be quoted in DDL.
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS observation_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      "drop" TEXT DEFAULT '',
      elevation TEXT DEFAULT '',
      level TEXT DEFAULT '',
      description TEXT DEFAULT '',
      display_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
} catch (e) {
  console.error("[migration] observation_locations CREATE failed:", e);
}
try { sqlite.exec(`ALTER TABLE photos ADD COLUMN location_id INTEGER DEFAULT NULL`); } catch {}

// Project-scoped roof levels (used by Level field dropdown in observation form)
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_roof_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
} catch (e) {
  console.error("[migration] project_roof_levels CREATE failed:", e);
}

// Project Documents (project-scoped uploads used as AI factual context and Harvard
// references in the Word export)
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      uploaded_at TEXT NOT NULL,
      author TEXT DEFAULT '',
      year TEXT DEFAULT '',
      title TEXT DEFAULT '',
      publisher TEXT DEFAULT '',
      document_type TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      extraction_status TEXT DEFAULT 'pending',
      extraction_error TEXT DEFAULT '',
      extracted_text TEXT DEFAULT ''
    );
  `);
} catch (e) {
  console.error("[migration] project_documents CREATE failed:", e);
}

export const db = drizzle(sqlite);
export { dataDir };

// ---------------------------------------------------------------------------
// Observation ID helpers (module-scope, synchronous — safe to call from
// inside a sqlite.transaction() callback as well as from async callers).
// ---------------------------------------------------------------------------

function computeSectionNumberSync(projectId: number, systemId: number): string | null {
  const system = db.select().from(facadeSystems).where(eq(facadeSystems.id, systemId)).get();
  if (!system) return null;
  const allSystems = db.select().from(facadeSystems)
    .where(eq(facadeSystems.projectId, projectId))
    .all();
  allSystems.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const systemIndex = allSystems.findIndex(s => s.id === systemId);
  if (systemIndex < 0) return null;
  return `4.${systemIndex + 1}`;
}

function computeNextObservationIdSync(projectId: number, systemId: number, excludeObservationId?: number): string {
  const sectionNum = computeSectionNumberSync(projectId, systemId);
  if (!sectionNum) return "4.1-1";
  const prefix = sectionNum + "-";
  const existing = db.select().from(observations).where(eq(observations.projectId, projectId)).all();
  let maxSuffix = 0;
  for (const o of existing) {
    if (excludeObservationId !== undefined && o.id === excludeObservationId) continue;
    const oid = o.observationId;
    if (typeof oid !== "string" || !oid.startsWith(prefix)) continue;
    const suffix = parseInt(oid.slice(prefix.length), 10);
    if (Number.isFinite(suffix) && suffix > maxSuffix) maxSuffix = suffix;
  }
  return `${prefix}${maxSuffix + 1}`;
}

/**
 * Renumber observations within a single project. Groups by systemId, orders
 * by id (oldest first), and assigns `${sectionNum}-1..N`. When
 * onlyIfDuplicates is true, a system is skipped if its current IDs already
 * form a unique set (no duplicates) — gaps alone do not trigger renumber.
 * Returns counts of systems and observations actually changed.
 */
function renumberObservationsForProject(projectId: number, onlyIfDuplicates: boolean): { systemsRenumbered: number; observationsRenumbered: number } {
  const projObservations = db.select().from(observations).where(eq(observations.projectId, projectId)).all();
  // Group by systemId
  const bySystem = new Map<number, typeof projObservations>();
  for (const o of projObservations) {
    if (o.systemId == null) continue;
    const list = bySystem.get(o.systemId) ?? [];
    list.push(o);
    bySystem.set(o.systemId, list);
  }

  let systemsRenumbered = 0;
  let observationsRenumbered = 0;

  const tx = sqlite.transaction(() => {
    bySystem.forEach((obsList, sysId) => {
      // Sort by id for stable, monotonic order (oldest first).
      obsList.sort((a: typeof obsList[number], b: typeof obsList[number]) => a.id - b.id);

      if (onlyIfDuplicates) {
        const seen = new Set<string>();
        let hasDuplicate = false;
        for (const o of obsList) {
          const oid = o.observationId ?? "";
          if (oid === "") continue; // empty IDs are handled by repairMissingObservationIds
          if (seen.has(oid)) { hasDuplicate = true; break; }
          seen.add(oid);
        }
        if (!hasDuplicate) return; // skip this system
      }

      const sectionNum = computeSectionNumberSync(projectId, sysId);
      if (!sectionNum) return;
      const prefix = sectionNum + "-";

      let changedInSystem = 0;
      const oldIds: string[] = [];
      const newIds: string[] = [];
      for (let i = 0; i < obsList.length; i++) {
        const obs = obsList[i];
        const newId = `${prefix}${i + 1}`;
        if (obs.observationId !== newId) {
          db.update(observations).set({ observationId: newId }).where(eq(observations.id, obs.id)).run();
          changedInSystem++;
          oldIds.push(obs.observationId || "(empty)");
          newIds.push(newId);
        }
      }
      if (changedInSystem > 0) {
        systemsRenumbered++;
        observationsRenumbered += changedInSystem;
        console.log(`[renumber] project ${projectId} system ${sysId} (${sectionNum}): renumbered ${changedInSystem} observation${changedInSystem === 1 ? "" : "s"} — old [${oldIds.join(", ")}] → new [${newIds.join(", ")}]`);
      }
    });
  });
  tx();

  return { systemsRenumbered, observationsRenumbered };
}

function renumberObservationsAcrossProjects(onlyIfDuplicates: boolean): { systemsRenumbered: number; observationsRenumbered: number } {
  const allProjects = db.select().from(projects).all();
  let systemsRenumbered = 0;
  let observationsRenumbered = 0;
  for (const p of allProjects) {
    const r = renumberObservationsForProject(p.id, onlyIfDuplicates);
    systemsRenumbered += r.systemsRenumbered;
    observationsRenumbered += r.observationsRenumbered;
  }
  return { systemsRenumbered, observationsRenumbered };
}

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
  createObservationWithAutoId(observation: InsertObservation): Promise<Observation>;
  assignObservationId(id: number, systemId: number): Promise<Observation | undefined>;
  updateObservation(id: number, observation: Partial<InsertObservation>): Promise<Observation | undefined>;
  deleteObservation(id: number): Promise<void>;
  getNextObservationId(projectId: number, systemId: number, excludeObservationId?: number): Promise<string>;
  repairMissingObservationIds(): Promise<number>;
  renumberDuplicateObservationIds(): Promise<{ systemsRenumbered: number; observationsRenumbered: number }>;
  renumberProjectObservations(projectId: number): Promise<{ systemsRenumbered: number; observationsRenumbered: number }>;
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
    db.delete(observationGroups).where(eq(observationGroups.projectId, id)).run();
    db.delete(customIndicators).where(eq(customIndicators.projectId, id)).run();
    db.delete(customDefectCategories).where(eq(customDefectCategories.projectId, id)).run();
    db.delete(projectRoofLevels).where(eq(projectRoofLevels.projectId, id)).run();
    // Delete project documents (and their files on disk)
    const projDocs = db.select().from(projectDocuments).where(eq(projectDocuments.projectId, id)).all();
    for (const d of projDocs) {
      if (d.filePath) {
        try { if (fs.existsSync(d.filePath)) fs.unlinkSync(d.filePath); } catch {}
      }
    }
    db.delete(projectDocuments).where(eq(projectDocuments.projectId, id)).run();
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
  /**
   * Atomically generate the next observationId AND insert the row in a single
   * SQLite transaction. Prevents two concurrent POSTs from both reading the
   * same max-suffix and producing duplicate IDs.
   */
  async createObservationWithAutoId(observation: InsertObservation): Promise<Observation> {
    const sysId = observation.systemId;
    // No system → just store as-is (observationId will be empty until system is linked).
    if (sysId == null) {
      return db.insert(observations).values(observation).returning().get();
    }
    const tx = sqlite.transaction((): Observation => {
      const newId = computeNextObservationIdSync(observation.projectId, sysId);
      const row = db.insert(observations).values({ ...observation, observationId: newId }).returning().get();
      return row;
    });
    return tx();
  }
  /**
   * Assign an observationId to an existing observation atomically (used by
   * the PATCH path when a system is linked to an observation that was
   * created without one). Returns the updated row, or undefined if missing.
   */
  async assignObservationId(id: number, systemId: number): Promise<Observation | undefined> {
    const tx = sqlite.transaction((): Observation | undefined => {
      const current = db.select().from(observations).where(eq(observations.id, id)).get();
      if (!current) return undefined;
      // Don't overwrite an existing non-empty ID.
      if (current.observationId && current.observationId !== "") return current;
      const newId = computeNextObservationIdSync(current.projectId, systemId, id);
      return db.update(observations).set({ observationId: newId }).where(eq(observations.id, id)).returning().get();
    });
    return tx();
  }
  async updateObservation(id: number, observation: Partial<InsertObservation>): Promise<Observation | undefined> {
    return db.update(observations).set(observation).where(eq(observations.id, id)).returning().get();
  }
  async deleteObservation(id: number): Promise<void> {
    // Cascade: delete recommendations, photos, additional locations, and elevation pins for this observation
    db.delete(recommendations).where(eq(recommendations.observationId, id)).run();
    db.delete(photos).where(eq(photos.observationId, id)).run();
    db.delete(observationLocations).where(eq(observationLocations.observationId, id)).run();
    db.delete(elevationPins).where(eq(elevationPins.observationId, id)).run();
    db.delete(observations).where(eq(observations.id, id)).run();
  }

  // Observation Locations (additional locations for the same defect)
  async getObservationLocations(observationId: number): Promise<ObservationLocation[]> {
    return db.select().from(observationLocations)
      .where(eq(observationLocations.observationId, observationId))
      .orderBy(asc(observationLocations.displayOrder), asc(observationLocations.id))
      .all();
  }
  async getObservationLocation(id: number): Promise<ObservationLocation | undefined> {
    return db.select().from(observationLocations).where(eq(observationLocations.id, id)).get();
  }
  async createObservationLocation(data: InsertObservationLocation): Promise<ObservationLocation> {
    return db.insert(observationLocations).values(data).returning().get();
  }
  async updateObservationLocation(id: number, data: Partial<InsertObservationLocation>): Promise<ObservationLocation | undefined> {
    return db.update(observationLocations).set(data).where(eq(observationLocations.id, id)).returning().get();
  }
  async deleteObservationLocation(id: number): Promise<void> {
    // Cascade: delete photos linked via locationId, then the location itself
    db.delete(photos).where(eq(photos.locationId, id)).run();
    db.delete(observationLocations).where(eq(observationLocations.id, id)).run();
  }

  async getNextObservationId(projectId: number, systemId: number, excludeObservationId?: number): Promise<string> {
    return computeNextObservationIdSync(projectId, systemId, excludeObservationId);
  }

  /**
   * Backfill observation_id for any rows that have a system linked but a
   * missing/empty identifier. Idempotent — safe to call on every boot.
   * Reads observation state fresh inside the transaction after each write
   * so each backfilled row sees prior repairs and receives a unique ID.
   */
  async repairMissingObservationIds(): Promise<number> {
    const broken = db.select().from(observations).all().filter(o =>
      o.systemId != null && (o.observationId == null || o.observationId === "")
    );
    if (broken.length === 0) return 0;

    const repair = sqlite.transaction(() => {
      for (const obs of broken) {
        const newId = computeNextObservationIdSync(obs.projectId, obs.systemId!, obs.id);
        db.update(observations).set({ observationId: newId }).where(eq(observations.id, obs.id)).run();
      }
    });
    repair();
    return broken.length;
  }

  /**
   * Detect duplicate observationIds within each system of each project and
   * renumber that system's observations sequentially (1..N) ordered by id
   * (stable, monotonic — oldest first). Only systems that contain at least
   * one duplicate are renumbered; clean systems are left untouched.
   *
   * Safe because observations are referenced internally by their primary
   * key `id`, not by the human-readable `observationId`. Renumbering only
   * changes the display/export identifier.
   */
  async renumberDuplicateObservationIds(): Promise<{ systemsRenumbered: number; observationsRenumbered: number }> {
    return renumberObservationsAcrossProjects(/* onlyIfDuplicates */ true);
  }

  /**
   * Force-renumber all observations in a project sequentially per system.
   * Used by the manual admin endpoint. Idempotent for already-sequential data.
   */
  async renumberProjectObservations(projectId: number): Promise<{ systemsRenumbered: number; observationsRenumbered: number }> {
    return renumberObservationsForProject(projectId, /* onlyIfDuplicates */ false);
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
  async reorderObservationGroups(projectId: number, orderedIds: number[]): Promise<void> {
    orderedIds.forEach((gid, idx) => {
      db.update(observationGroups)
        .set({ displayOrder: idx, sortOrder: idx } as any)
        .where(and(eq(observationGroups.id, gid), eq(observationGroups.projectId, projectId)))
        .run();
    });
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

  // Custom Roof Types (GLOBAL)
  async getCustomRoofTypes(): Promise<CustomRoofType[]> {
    return db.select().from(customRoofTypes).orderBy(asc(customRoofTypes.name)).all();
  }
  async createCustomRoofType(data: InsertCustomRoofType): Promise<CustomRoofType> {
    const trimmed = data.name.trim();
    // Case-insensitive dedupe: return existing if present
    const existing = db.select().from(customRoofTypes).all()
      .find(r => r.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    return db.insert(customRoofTypes).values({ ...data, name: trimmed }).returning().get();
  }
  async deleteCustomRoofType(id: number): Promise<void> {
    db.delete(customRoofTypes).where(eq(customRoofTypes.id, id)).run();
  }

  // Custom Defect Categories (PROJECT-SCOPED)
  async getCustomDefectCategoriesByProject(projectId: number): Promise<CustomDefectCategory[]> {
    return db.select().from(customDefectCategories)
      .where(eq(customDefectCategories.projectId, projectId))
      .orderBy(asc(customDefectCategories.name))
      .all();
  }
  async createCustomDefectCategory(data: InsertCustomDefectCategory): Promise<CustomDefectCategory> {
    const trimmed = data.name.trim();
    // Case-insensitive dedupe within the project
    const existing = db.select().from(customDefectCategories)
      .where(eq(customDefectCategories.projectId, data.projectId))
      .all()
      .find(r => r.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    return db.insert(customDefectCategories).values({ ...data, name: trimmed }).returning().get();
  }
  async deleteCustomDefectCategory(id: number): Promise<void> {
    db.delete(customDefectCategories).where(eq(customDefectCategories.id, id)).run();
  }

  // Project Roof Levels (PROJECT-SCOPED)
  async getProjectRoofLevels(projectId: number): Promise<ProjectRoofLevel[]> {
    return db.select().from(projectRoofLevels)
      .where(eq(projectRoofLevels.projectId, projectId))
      .orderBy(asc(projectRoofLevels.label))
      .all();
  }
  async createProjectRoofLevel(data: InsertProjectRoofLevel): Promise<ProjectRoofLevel> {
    const trimmed = data.label.trim();
    // Case-insensitive dedupe within the project
    const existing = db.select().from(projectRoofLevels)
      .where(eq(projectRoofLevels.projectId, data.projectId))
      .all()
      .find(r => r.label.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    return db.insert(projectRoofLevels).values({ ...data, label: trimmed }).returning().get();
  }
  async deleteProjectRoofLevel(id: number): Promise<void> {
    db.delete(projectRoofLevels).where(eq(projectRoofLevels.id, id)).run();
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

  // === Report Library (RAG) ===
  async getReportDocuments(): Promise<ReportLibraryDocument[]> {
    return db.select().from(reportLibraryDocuments).orderBy(desc(reportLibraryDocuments.uploadedAt)).all();
  }
  async getReportDocument(id: string): Promise<ReportLibraryDocument | undefined> {
    return db.select().from(reportLibraryDocuments).where(eq(reportLibraryDocuments.id, id)).get();
  }
  async createReportDocument(data: InsertReportLibraryDocument): Promise<ReportLibraryDocument> {
    return db.insert(reportLibraryDocuments).values(data).returning().get();
  }
  async updateReportDocument(id: string, patch: Partial<InsertReportLibraryDocument>): Promise<ReportLibraryDocument> {
    return db.update(reportLibraryDocuments).set(patch).where(eq(reportLibraryDocuments.id, id)).returning().get();
  }
  async deleteReportDocument(id: string): Promise<void> {
    const doc = db.select().from(reportLibraryDocuments).where(eq(reportLibraryDocuments.id, id)).get();
    // Cascade passages
    db.delete(reportLibraryPassages).where(eq(reportLibraryPassages.documentId, id)).run();
    db.delete(reportLibraryDocuments).where(eq(reportLibraryDocuments.id, id)).run();
    // Delete file from disk
    if (doc && doc.filePath) {
      try {
        if (fs.existsSync(doc.filePath)) fs.unlinkSync(doc.filePath);
      } catch {}
    }
  }
  async getPassagesByDocument(documentId: string): Promise<ReportLibraryPassage[]> {
    return db.select().from(reportLibraryPassages).where(eq(reportLibraryPassages.documentId, documentId)).all();
  }
  async getAllPassages(): Promise<ReportLibraryPassage[]> {
    return db.select().from(reportLibraryPassages).all();
  }
  async getPassagesByCategory(category: string): Promise<ReportLibraryPassage[]> {
    return db.select().from(reportLibraryPassages).where(eq(reportLibraryPassages.category, category)).all();
  }
  async createPassage(data: InsertReportLibraryPassage): Promise<ReportLibraryPassage> {
    return db.insert(reportLibraryPassages).values(data).returning().get();
  }
  async updatePassage(id: string, patch: Partial<InsertReportLibraryPassage>): Promise<ReportLibraryPassage> {
    return db.update(reportLibraryPassages).set(patch).where(eq(reportLibraryPassages.id, id)).returning().get();
  }
  async deletePassage(id: string): Promise<void> {
    db.delete(reportLibraryPassages).where(eq(reportLibraryPassages.id, id)).run();
  }

  // === Project Documents (project-scoped factual context + Harvard references) ===
  async getProjectDocuments(projectId: number): Promise<ProjectDocument[]> {
    return db.select().from(projectDocuments)
      .where(eq(projectDocuments.projectId, projectId))
      .orderBy(desc(projectDocuments.uploadedAt))
      .all();
  }
  async getProjectDocument(id: number): Promise<ProjectDocument | undefined> {
    return db.select().from(projectDocuments).where(eq(projectDocuments.id, id)).get();
  }
  async createProjectDocument(data: InsertProjectDocument): Promise<ProjectDocument> {
    return db.insert(projectDocuments).values(data).returning().get();
  }
  async updateProjectDocument(id: number, patch: Partial<InsertProjectDocument>): Promise<ProjectDocument | undefined> {
    return db.update(projectDocuments).set(patch).where(eq(projectDocuments.id, id)).returning().get();
  }
  async deleteProjectDocument(id: number): Promise<ProjectDocument | undefined> {
    const doc = db.select().from(projectDocuments).where(eq(projectDocuments.id, id)).get();
    if (!doc) return undefined;
    db.delete(projectDocuments).where(eq(projectDocuments.id, id)).run();
    if (doc.filePath) {
      try { if (fs.existsSync(doc.filePath)) fs.unlinkSync(doc.filePath); } catch {}
    }
    return doc;
  }
  // Returns documents suitable for AI context: status complete with non-empty extracted text
  async getProjectDocumentsForAI(projectId: number): Promise<ProjectDocument[]> {
    return db.select().from(projectDocuments)
      .where(eq(projectDocuments.projectId, projectId))
      .all()
      .filter((d) => d.extractionStatus === "complete" && (d.extractedText || "").trim().length > 0);
  }
}

export const storage = new DatabaseStorage();

// Idempotent startup repair: if an observation was saved without a system
// (so no observation_id was generated) and later linked to a system, the
// PATCH used to leave observation_id blank. Backfill those here on every
// boot — cheap query, no-op when nothing needs fixing.
(async () => {
  try {
    const repaired = await storage.repairMissingObservationIds();
    if (repaired > 0) {
      console.log(`[startup] Repaired ${repaired} observation ID${repaired === 1 ? "" : "s"} that were linked to a system without an identifier`);
    }
  } catch (e) {
    console.error("[startup] repairMissingObservationIds failed:", e);
  }
  // Idempotent: only renumbers systems that actually contain duplicate
  // observationIds. Clean systems are left alone (no churn). Safe to run
  // on every boot because observations are referenced by primary-key id,
  // not by the human-readable observationId.
  try {
    const r = await storage.renumberDuplicateObservationIds();
    if (r.observationsRenumbered > 0) {
      console.log(`[startup] Renumbered ${r.observationsRenumbered} observation ID${r.observationsRenumbered === 1 ? "" : "s"} across ${r.systemsRenumbered} system${r.systemsRenumbered === 1 ? "" : "s"} to resolve duplicates`);
    }
  } catch (e) {
    console.error("[startup] renumberDuplicateObservationIds failed:", e);
  }
})();
