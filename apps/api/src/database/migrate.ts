import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";

import {
  createDatabase,
  requireDatabaseUrl,
  type AlongTheWayDatabase,
} from "./database";

const migrationFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export async function runMigrations(database: Kysely<AlongTheWayDatabase>) {
  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    console.info(
      JSON.stringify({
        event: "database_migration",
        migration: result.migrationName,
        status: result.status,
      }),
    );
  }

  if (error) {
    throw error;
  }
}

if (import.meta.main) {
  const database = createDatabase(requireDatabaseUrl());

  try {
    await runMigrations(database);
  } finally {
    await database.destroy();
  }
}
