import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerBundledPlugins } from "../src/plugins/bundled.js";
import { migratePlugins } from "../src/plugins/persistence.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);
  `);
  migratePlugins(db);
});

afterEach(() => {
  db.close();
});

describe("bundled Readable Studio catalog", () => {
  it("loads all 315 frozen bundled capabilities from canonical manifests", async () => {
    // Given: the real bundled plugin source tree.
    const bundledRoot = path.resolve(import.meta.dirname, "../../../plugins/_official");

    // When: the production daemon loader registers the catalog.
    const result = await registerBundledPlugins({ db, bundledRoot });

    // Then: every frozen capability loads once without parser warnings.
    expect(result.warnings).toEqual([]);
    expect(result.registered).toHaveLength(315);
    expect(new Set(result.registered.map((record) => record.id))).toHaveLength(315);
  });
});
