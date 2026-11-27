import { getDb } from '../db.js';

/**
 * Robust RFC 4180 CSV parser supporting quotes, escaped quotes, commas, and multiline cells
 * @param {string} text
 * @returns {Array<Object>} Array of row objects mapped by lowercase header names
 */
export function parseCsv(text) {
  if (!text || !text.trim()) return [];

  const lines = [];
  let row = [];
  let inQuotes = false;
  let cur = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cur.trim());
      cur = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.some(cell => cell.length > 0)) {
        lines.push(row);
      }
      row = [];
    } else {
      cur += char;
    }
  }

  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    if (row.some(cell => cell.length > 0)) {
      lines.push(row);
    }
  }

  if (lines.length === 0) return [];

  const headers = lines[0].map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const obj = {};
    lines[i].forEach((val, idx) => {
      const header = headers[idx] || `col_${idx}`;
      obj[header] = val;
    });
    rows.push(obj);
  }

  return rows;
}

/**
 * Import a collection of leads into a list with syntax validation, normalization, and deduplication
 * @param {number} listId
 * @param {Array<Object>} rawRows
 * @returns {{ imported: number, skippedInvalid: number, skippedDuplicates: number }}
 */
export function importLeads(listId, rawRows = []) {
  const db = getDb();
  let imported = 0;
  let skippedInvalid = 0;
  let skippedDuplicates = 0;

  const listCheck = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!listCheck) {
    throw new Error(`List ID ${listId} not found`);
  }

  // RFC 5322 practical regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

  const insertStmt = db.prepare(`
    INSERT INTO leads (list_id, email, first_name, last_name, company, custom_fields_json, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `);

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const rawEmail = (r.email || r.Email || r['e-mail'] || r['E-mail'] || '').trim().toLowerCase();
      if (!rawEmail || !emailRegex.test(rawEmail) || rawEmail.length > 254) {
        skippedInvalid++;
        continue;
      }

      const firstName = (r.first_name || r.firstName || r.First_Name || r['first name'] || r['First Name'] || '').trim();
      const lastName = (r.last_name || r.lastName || r.Last_Name || r['last name'] || r['Last Name'] || '').trim();
      const company = (r.company || r.Company || '').trim();

      // Any remaining custom columns
      const custom = {};
      for (const [k, v] of Object.entries(r)) {
        const normKey = k.toLowerCase().replace(/[\s_-]+/g, '');
        if (!['email', 'firstname', 'lastname', 'company'].includes(normKey)) {
          custom[k] = v;
        }
      }

      try {
        insertStmt.run(listId, rawEmail, firstName, lastName, company, JSON.stringify(custom));
        imported++;
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
          skippedDuplicates++;
        } else {
          throw err;
        }
      }
    }
  });

  tx(rawRows);

  return { imported, skippedInvalid, skippedDuplicates };
}
