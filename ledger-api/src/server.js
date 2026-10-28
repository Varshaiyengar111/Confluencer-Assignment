'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createDatabase } = require('./db');
const { createLedgerService } = require('./ledgerService');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ledger.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = createDatabase(DB_FILE);
const app = createApp(createLedgerService(db));

const server = app.listen(PORT, () => {
  console.log(`Ledger API listening on http://localhost:${PORT} (db: ${DB_FILE})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
