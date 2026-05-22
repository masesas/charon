import { initDb, db } from '../src/db/connection.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runTests() {
  console.log('\n=== Running lesson_applications tests ===\n');

  initDb();

  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='lesson_applications'"
  ).get();
  assert(tableCheck, 'lesson_applications table not found');
  console.log('✓ lesson_applications table exists');

  const columns = db.prepare('PRAGMA table_info(lesson_applications)').all();
  const columnNames = columns.map((c) => c.name);
  for (const col of ['id', 'strategy_id', 'lesson_id', 'applied_at', 'result']) {
    assert(columnNames.includes(col), `Missing column: ${col}`);
  }
  console.log('✓ Columns:', columnNames.join(', '));

  const fks = db.prepare('PRAGMA foreign_key_list(lesson_applications)').all();
  assert(fks.length >= 2, 'Expected foreign keys to strategies and learning_lessons');
  console.log('✓ Foreign keys:', fks.map((fk) => `${fk.from}->${fk.table}.${fk.to}`).join(', '));

  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lesson_applications'"
  ).all();
  const indexNames = indexes.map((i) => i.name);
  assert(indexNames.some((name) => name.includes('strategy')), 'Missing strategy_id index');
  assert(indexNames.some((name) => name.includes('lesson')), 'Missing lesson_id index');
  console.log('✓ Indexes:', indexNames.join(', '));

  const lessonResult = db.prepare(
    'INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json) VALUES (?, ?, ?, ?, ?)'
  ).run(1, Date.now(), 'active', 'Test lesson application lesson', '{}');

  const insertResult = db.prepare(
    'INSERT INTO lesson_applications (strategy_id, lesson_id, applied_at, result) VALUES (?, ?, ?, ?)'
  ).run('sniper', lessonResult.lastInsertRowid, new Date().toISOString(), 'success');
  assert(insertResult.changes === 1, 'Failed to insert lesson application');
  console.log('✓ Inserted lesson_application id:', insertResult.lastInsertRowid);

  const row = db.prepare('SELECT * FROM lesson_applications WHERE id = ?').get(insertResult.lastInsertRowid);
  assert(row && row.strategy_id === 'sniper' && row.lesson_id === lessonResult.lastInsertRowid, 'Failed to query inserted row');
  console.log('✓ Queried inserted lesson_application');

  db.prepare('DELETE FROM lesson_applications WHERE id = ?').run(insertResult.lastInsertRowid);
  db.prepare('DELETE FROM learning_lessons WHERE id = ?').run(lessonResult.lastInsertRowid);

  console.log('\n=== All lesson_applications tests passed ===\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch((err) => {
    console.error('\n✗ Test failed:', err.message);
    process.exit(1);
  });
}

export { runTests };
