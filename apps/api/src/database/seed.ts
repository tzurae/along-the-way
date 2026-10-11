import type { Kysely } from "kysely";

import {
  createDatabase,
  requireDatabaseUrl,
  type AlongTheWayDatabase,
} from "./database";

export function requireBootstrapOwnerEmail(
  environment: Record<string, string | undefined> = process.env,
) {
  const email = environment.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new Error("BOOTSTRAP_OWNER_EMAIL is required");
  }
  return email;
}

export async function seedDatabase(
  database: Kysely<AlongTheWayDatabase>,
  ownerEmail: string,
) {
  await database
    .insertInto("users")
    .values({
      email: ownerEmail.trim().toLowerCase(),
      display_name: null,
      status: "active",
    })
    .onConflict((conflict) => conflict.column("email").doNothing())
    .execute();
}

if (import.meta.main) {
  const database = createDatabase(requireDatabaseUrl());

  try {
    await seedDatabase(database, requireBootstrapOwnerEmail());
  } finally {
    await database.destroy();
  }
}
