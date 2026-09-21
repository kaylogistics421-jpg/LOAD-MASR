const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// DATA_DIR lets a host with persistent volume storage (Railway, Fly.io,
// etc.) point this at a mounted volume, e.g. DATA_DIR=/data with a volume
// mounted at /data — so the database survives redeploys/restarts on a
// real host, not just locally. Defaults to the same relative path used
// during local development, unchanged.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'loadmasr.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;'); // safe concurrent reads while a write is in progress
db.exec('PRAGMA foreign_keys = ON;');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
