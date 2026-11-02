import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll } from 'vitest';

/** Reuse the WASM engine, not scenario data or persistence providers. */
export function materialPGlite(): () => PGlite {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    // Keep the migration ledger with the schema it describes. Everything else,
    // including byte storage, ownership fences and reference metadata, is fresh.
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'openmaic_schema_migrations'`,
    );
    if (rows.length) {
      const tables = rows.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`);
      await db.exec(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    }
  });
  afterAll(async () => {
    await db?.close();
  });
  return () => db;
}
