# Ledger API

A small REST API for managing accounts and their transactions, with strict data integrity:
immutable transactions, balances that always match the ledger, atomic writes, and an atomic
money-transfer endpoint (bonus).

- **Stack:** Node.js 22.13+ · Express 5 · SQLite via Node's built-in `node:sqlite` (no native build step, no DB server)
- **Tests:** 33 integration tests using the built-in `node:test` runner + `supertest`
- **API reference:** see [`API.md`](./API.md)

---

## Running locally

```bash
# 1. Install dependencies (Node.js 22.13 or newer — check with `node -v`)
npm install

# 2. Start the server  →  http://localhost:3000
npm start

# 3. Run the test suite
npm test
```

No database server is needed. On first start the SQLite file is created at `data/ledger.db`
and the schema is applied automatically.

| Environment variable | Default            | Purpose                                         |
| -------------------- | ------------------ | ----------------------------------------------- |
| `PORT`               | `3000`             | HTTP port                                       |
| `DB_FILE`            | `./data/ledger.db` | SQLite file path (`:memory:` for a throwaway DB) |

To reset all data, stop the server and delete the `data/` folder.

### Try it

```bash
# Create two accounts
curl -s -X POST localhost:3000/accounts -H 'Content-Type: application/json' -d '{"name":"Alice"}'
curl -s -X POST localhost:3000/accounts -H 'Content-Type: application/json' -d '{"name":"Bob"}'

# Credit Alice (replace <ALICE_ID>)
curl -s -X POST localhost:3000/accounts/<ALICE_ID>/transactions \
  -H 'Content-Type: application/json' \
  -d '{"type":"credit","amount":100,"reference_id":"dep-001","description":"Opening deposit"}'

# Transfer 30 from Alice to Bob
curl -s -X POST localhost:3000/transfers -H 'Content-Type: application/json' \
  -d '{"from_account_id":"<ALICE_ID>","to_account_id":"<BOB_ID>","amount":30,"reference_id":"tr-001"}'

# List Alice's transactions, latest first
curl -s 'localhost:3000/accounts/<ALICE_ID>/transactions?page=1&limit=10'
```

---

## Project structure

```
src/
  server.js          Entry point: config, DB bootstrap, HTTP listener, graceful shutdown
  app.js             Express app: routes, 405 guards, 404 fallthrough, central error handler
  db.js              Schema: tables, CHECK/UNIQUE/FK constraints, immutability triggers
  ledgerService.js   Business logic: accounts, transactions, transfers, reconciliation
  validators.js      Request validation for bodies and pagination
  errors.js          ApiError class + catalogue of error codes
  money.js           Decimal <-> integer minor-unit conversion
test/
  api.test.js        Integration tests (HTTP level, fresh in-memory DB per test)
API.md               Endpoint reference
```

Layers are kept separate so each can be read and tested on its own: **routes** parse HTTP and
pick status codes, **validators** turn raw input into clean typed values, the **service** owns all
rules and DB transactions, and **db.js** enforces the rules a second time at the storage layer.

---

## How the requirements are met

### Data integrity

| Requirement | How it is enforced |
| --- | --- |
| **Transaction immutability** | No update/delete endpoints exist; `PUT`/`PATCH`/`DELETE` on a transaction return `405`. In the database, `BEFORE UPDATE` / `BEFORE DELETE` triggers abort any change to the `transactions` table, so even direct SQL cannot alter history. |
| **Balance consistency** | The balance only changes inside the same DB transaction that writes the ledger row. Each transaction stores `balance_after`, and `GET /accounts/:id/reconciliation` recomputes the balance from the ledger and compares it with the stored value (tests assert they match). |
| **Failed transactions don't affect balance** | Validation and balance checks run before or inside the DB transaction; any error rolls the whole unit back. |
| **Atomicity** | The balance `UPDATE` and the ledger `INSERT` run inside one SQLite transaction (`BEGIN IMMEDIATE` … `COMMIT`, `ROLLBACK` on any error — see `withTransaction` in `db.js`). Tests inject a failure *after* the balance update and verify it is rolled back. |
| **No overdrafts** | Debits use a guarded update (`... WHERE id = ? AND balance >= ?`), plus a `CHECK (balance >= 0)` constraint as a last line of defence. |
| **Database constraints** | `NOT NULL`, `CHECK (type IN ('credit','debit'))`, `CHECK (amount > 0)`, `CHECK (balance >= 0)`, `UNIQUE (account_id, reference_id)`, foreign keys (enabled via `PRAGMA foreign_keys = ON`). |

### Transfers (bonus)

A transfer writes one `transfers` row plus two linked ledger entries — a **debit** on the source
and a **credit** on the destination — all inside a single DB transaction. Both accounts are checked
for existence first; if the source has insufficient funds or any write fails, nothing is persisted.
A test forces the credit leg to fail and confirms the debit leg, the transfer row and both balances
are all rolled back. Transfer legs appear in each account's normal transaction history with a
`transfer_id` so they can be traced.

### Money handling

Amounts are accepted as JSON numbers with up to 2 decimal places and stored as **integer minor
units** (e.g. `49.99` → `4999`). This avoids floating-point drift (a test adds `0.1` ten times and
expects exactly `1`).

### Duplicate `reference_id`

`reference_id` works as an **idempotency key** scoped to an account:

- Same `reference_id` **and** same payload → treated as a safe retry: returns the original
  transaction with `200 OK` and header `Idempotent-Replayed: true`. The balance is not changed again.
- Same `reference_id` with a **different** payload → `409 DUPLICATE_TRANSACTION`, with the
  existing transaction included in the error body.
- The same `reference_id` may be reused on a **different** account.

This handles the common real-world case of a client retrying after a network timeout, without
risking a double charge.

### Concurrency

`node:sqlite` is synchronous and every write runs under `BEGIN IMMEDIATE`, which takes SQLite's
write lock up front. Writes are therefore serialised, so two concurrent debits cannot both pass the
balance check. The guarded `UPDATE ... WHERE balance >= ?` would still prevent an overdraft if the
storage engine were swapped for one with concurrent writers (e.g. PostgreSQL).

---

## Assumptions

1. **Missing sections of the brief.** The copy of the brief I worked from began at *Pagination*, so the
   endpoint list for accounts and transactions (sections 1–4) is inferred from the rest of the
   document. Endpoint paths and field names are my own choices; see `API.md`.
2. **Accounts start at a balance of 0.** The only way to change a balance is a transaction, so the
   ledger always fully explains the balance. Supplying `balance` when creating an account is
   rejected.
3. **Account fields.** An account has `id`, `name`, `balance`, `created_at`, `updated_at`.
   Account names do not need to be unique. Accounts cannot be edited or deleted (out of scope; deleting
   an account with history would conflict with immutability).
4. **IDs** are server-generated UUID v4 strings.
5. **Amounts** are positive JSON numbers with at most 2 decimal places; a single currency is assumed.
   Strings such as `"100"` are rejected rather than coerced, to avoid ambiguity.
6. **`description`** is optional (max 255 chars). **`reference_id`** is required (max 100 chars) and is
   trimmed of surrounding whitespace.
7. **Duplicate `reference_id`** is handled idempotently as described above (200 replay vs 409 conflict).
   Uniqueness is per account, as the brief specifies "for the same account".
8. **Transfer `reference_id`** is unique across all transfers, and is also recorded on both legs.
   It may not clash with an existing transaction `reference_id` on either account.
9. **Insufficient balance** returns `422 Unprocessable Entity` (request is well-formed but violates
   a business rule). Validation problems return `400`, duplicates `409`, missing resources `404`.
10. **Pagination:** `page` defaults to 1, `limit` defaults to 10, max `limit` is 100. Both must be
    positive integers. Requesting a page past the end returns an empty `data` array with valid
    metadata, not an error.
11. **Sorting:** latest first by `created_at`; when two rows share the same millisecond, insertion
    order (an internal auto-increment) breaks the tie so ordering is always deterministic.
12. **Unknown fields** in request bodies are rejected with a validation error to catch client typos
    early.
13. **Authentication/authorisation** is out of scope for this assessment.
14. **SQLite** (Node's built-in driver) was chosen so the project runs with zero setup and no native
    compilation; the SQL and constraints are standard and port to PostgreSQL with minimal changes.
    Node marks `node:sqlite` as experimental; the start/test scripts silence that warning.

---

## Possible next steps

- Authentication and per-user account ownership
- Cursor-based pagination for very large histories
- OpenAPI spec generated from the validators
- Multi-currency support with a `currency` column on accounts
- PostgreSQL adapter with `SELECT ... FOR UPDATE` row locking for multi-process deployments
