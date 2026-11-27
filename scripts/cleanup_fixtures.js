import Database from 'better-sqlite3';
import fs from 'fs';

const paths = ['mailcheck.db', 'data/mailcheck.db'];
for (const p of paths) {
  if (fs.existsSync(p)) {
    const db = new Database(p);
    try {
      const stepInfo = db.prepare('DELETE FROM lead_steps WHERE id = 999').run();
      console.log(`Deleted lead_step 999 from ${p}:`, stepInfo.changes);
    } catch (e) {
      console.log(`Could not delete lead_step 999 from ${p}:`, e.message);
    }
    try {
      const suppInfo = db.prepare('DELETE FROM suppression WHERE email = ?').run('audit_test@example.com');
      console.log(`Deleted suppression audit_test@example.com from ${p}:`, suppInfo.changes);
    } catch (e) {
      console.log(`Could not delete suppression from ${p}:`, e.message);
    }
    db.close();
  }
}
