const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

// Same DATA_DIR convention as db.js — on a host with persistent volume
// storage, point uploads at the same mounted volume so files survive
// redeploys, not just the database rows referencing them.
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 15 * 1024 * 1024; // 15MB per file
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);

/* Saves a real file to disk (uploads/) and records it in the documents
   table. Accepts base64 (rather than multipart/form-data) since this
   backend is dependency-free and has no multipart parser available —
   any real client (the eventual frontend, or a driver's phone camera)
   can send a data URL / base64 payload over plain JSON. */
function saveDocument({ ownerUserId, loadId, kind, originalFilename, mimeType, base64Data }) {
  if (!base64Data) throw new Error('No file data provided.');
  if (!ALLOWED_MIME.has(mimeType)) throw new Error(`Unsupported file type: ${mimeType}`);

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length === 0) throw new Error('Uploaded file is empty.');
  if (buffer.length > MAX_BYTES) throw new Error('File exceeds the 15MB limit.');

  const id = crypto.randomUUID();
  const ext = path.extname(originalFilename || '').slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
  const storedFilename = `${id}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedFilename), buffer);

  db.prepare(`
    INSERT INTO documents (id, owner_user_id, load_id, kind, original_filename, stored_filename, mime_type, size_bytes, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ownerUserId || null, loadId || null, kind, originalFilename || storedFilename, storedFilename, mimeType, buffer.length, Date.now());

  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function documentFilePath(doc) {
  return path.join(UPLOAD_DIR, doc.stored_filename);
}

module.exports = { saveDocument, getDocument, documentFilePath, UPLOAD_DIR };
