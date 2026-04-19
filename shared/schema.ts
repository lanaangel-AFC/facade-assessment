import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Projects (Layer 1 — Site & Project metadata)
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  client: text("client").notNull(),
  inspector: text("inspector").notNull(),
  afcReference: text("afc_reference").default(""),
  revision: text("revision").default("01"),
  buildingAge: text("building_age").default(""),
  buildingUse: text("building_use").default(""),
  storeyCount: text("storey_count").default(""),
  refurbishmentHistory: text("refurbishment_history").default(""),
  inspectionDates: text("inspection_dates").default("[]"), // JSON array of date strings
  inspectionScope: text("inspection_scope").default(""),
  limitations: text("limitations").default("[]"), // JSON array of limitation strings
  backgroundDocs: text("background_docs").default("[]"), // JSON array of {title, author, date}
  executiveSummary: text("executive_summary").default(""),
  createdAt: text("created_at").notNull(),
});

// Facade Systems (Layer 2 — System/material descriptions)
export const facadeSystems = sqliteTable("facade_systems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(), // e.g. "Tower curtain wall", "Annex Level 1 facade"
  location: text("location").notNull(), // e.g. "Northwest elevation, Levels 2-17"
  systemType: text("system_type").notNull(), // e.g. "Curtain wall - stick system"
  materials: text("materials").default("[]"), // JSON array of material entries
  keyFeatures: text("key_features").default("[]"), // JSON array of strings
  estimatedAge: text("estimated_age").default(""),
  relatedSystems: text("related_systems").default(""), // Free text referencing other systems
  aiDescription: text("ai_description").default(""), // AI-generated prose description
  sortOrder: integer("sort_order").default(0),
  createdAt: text("created_at").notNull(),
});

// Observations (Layer 3 — Field-collected defect data)
export const observations = sqliteTable("observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  systemId: integer("system_id"), // links to facade_systems
  observationId: text("observation_id").notNull(), // e.g. "4.2-1"
  location: text("location").notNull(), // specific location within the system
  defectCategory: text("defect_category").notNull(),
  severity: text("severity").notNull(), // Safety/Risk, Essential, Desirable, Monitor
  extent: text("extent").notNull(), // Isolated, Localised, Widespread, Systemic
  fieldNote: text("field_note").default(""), // Brief note from site
  indicators: text("indicators").default("[]"), // JSON array of observed indicators
  aiNarrative: text("ai_narrative").default(""), // AI-generated detailed narrative
  sortOrder: integer("sort_order").default(0),
  elevationId: integer("elevation_id"), // which elevation this observation is pinned on
  createdAt: text("created_at").notNull(),
});

// Elevations (drawings / roof plans)
export const elevations = sqliteTable("elevations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "elevation" | "roof_plan"
  filename: text("filename").notNull(),
  originalFilename: text("original_filename").notNull(),
  width: integer("width").default(0),
  height: integer("height").default(0),
  sortOrder: integer("sort_order").default(0),
  createdAt: text("created_at").notNull(),
});

// Pins placed on elevation drawings linking observations to a location
export const elevationPins = sqliteTable("elevation_pins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  elevationId: integer("elevation_id").notNull(),
  observationId: integer("observation_id").notNull(),
  x: integer("x").notNull(), // percentage * 100 (0..10000)
  y: integer("y").notNull(), // percentage * 100 (0..10000)
  createdAt: text("created_at").notNull(),
});

// Recommendations (Layer 4)
export const recommendations = sqliteTable("recommendations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  observationId: integer("observation_id").notNull(), // links to observations
  projectId: integer("project_id").notNull(),
  action: text("action").notNull(),
  timeframe: text("timeframe").notNull(), // Now, 1 year, 2 years, 5 years, Prior to leasing
  category: text("category").notNull(), // Essential, Desirable, Monitor
  budgetEstimate: text("budget_estimate").default(""),
  budgetBasis: text("budget_basis").default(""), // e.g. "$80-$120 per lineal m"
  dependencies: text("dependencies").default(""), // references to other recommendation IDs
  sortOrder: integer("sort_order").default(0),
  createdAt: text("created_at").notNull(),
});

// Photos (shared across systems, observations)
export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  systemId: integer("system_id"), // optional — context photos for system description
  observationId: integer("observation_id"), // optional — defect photos
  filename: text("filename").notNull(),
  caption: text("caption").default(""),
  slot: text("slot").default("photo"), // context, photo1-photo6
  createdAt: text("created_at").notNull(),
});

// Settings (key-value store for API key etc.)
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// AI Training Data (stores corrections for future fine-tuning)
export const aiTrainingData = sqliteTable("ai_training_data", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskType: text("task_type").notNull(),
  inputData: text("input_data").notNull(),
  aiOutput: text("ai_output").notNull(),
  userCorrected: text("user_corrected").default(""),
  accepted: integer("accepted").default(0),
  createdAt: text("created_at").notNull(),
});

// Users (kept from template)
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

// Insert schemas
export const insertProjectSchema = createInsertSchema(projects).omit({ id: true });
export const insertFacadeSystemSchema = createInsertSchema(facadeSystems).omit({ id: true });
export const insertObservationSchema = createInsertSchema(observations).omit({ id: true });
export const insertRecommendationSchema = createInsertSchema(recommendations).omit({ id: true });
export const insertPhotoSchema = createInsertSchema(photos).omit({ id: true });
export const insertElevationSchema = createInsertSchema(elevations).omit({ id: true });
export const insertElevationPinSchema = createInsertSchema(elevationPins).omit({ id: true });
export const insertSettingSchema = createInsertSchema(settings);
export const insertTrainingDataSchema = createInsertSchema(aiTrainingData).omit({ id: true });
export const insertUserSchema = createInsertSchema(users).pick({ username: true, password: true });

// Types
export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type FacadeSystem = typeof facadeSystems.$inferSelect;
export type InsertFacadeSystem = z.infer<typeof insertFacadeSystemSchema>;
export type Observation = typeof observations.$inferSelect;
export type InsertObservation = z.infer<typeof insertObservationSchema>;
export type Recommendation = typeof recommendations.$inferSelect;
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type Photo = typeof photos.$inferSelect;
export type InsertPhoto = z.infer<typeof insertPhotoSchema>;
export type Elevation = typeof elevations.$inferSelect;
export type InsertElevation = z.infer<typeof insertElevationSchema>;
export type ElevationPin = typeof elevationPins.$inferSelect;
export type InsertElevationPin = z.infer<typeof insertElevationPinSchema>;
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type TrainingData = typeof aiTrainingData.$inferSelect;
export type InsertTrainingData = z.infer<typeof insertTrainingDataSchema>;
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
