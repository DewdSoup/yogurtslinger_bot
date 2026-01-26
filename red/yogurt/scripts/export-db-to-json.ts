/**
 * Export capture.db tables to individual JSON files
 */

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', 'data', 'evidence', 'capture.db');
const outputDir = join(__dirname, '..', 'data', 'evidence', 'capture_db');

// Ensure output directory exists
mkdirSync(outputDir, { recursive: true });

const db = new Database(dbPath, { readonly: true });

// Get all table names (excluding sqlite internal tables)
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
`).all() as { name: string }[];

console.log(`Found ${tables.length} tables to export:`);
tables.forEach(t => console.log(`  - ${t.name}`));
console.log('');

for (const { name } of tables) {
  console.log(`Exporting ${name}...`);

  // Get row count
  const countResult = db.prepare(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as { cnt: number };
  console.log(`  Rows: ${countResult.cnt}`);

  // Get all data
  const rows = db.prepare(`SELECT * FROM "${name}"`).all();

  // Write to JSON file
  const outputPath = join(outputDir, `${name}.json`);
  writeFileSync(outputPath, JSON.stringify(rows, null, 2));
  console.log(`  Written to: ${outputPath}`);
}

db.close();
console.log('\nExport complete!');
