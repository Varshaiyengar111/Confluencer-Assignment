# API Documentation

Base URL: `http://localhost:3000`
All request and response bodies are JSON. Send `Content-Type: application/json` on `POST` requests.

## Conventions

**Success** responses wrap the resource in `data`:

```json
{ "data": { ... } }
```

**List** responses add `pagination`:

```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total_records": 25,
    "total_pages": 3,
    "has_next": true,
    "has_previous": false
  }
}
```

**Errors** always have the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [ { "field": "name", "message": "name is required" } ]
  }
}
```

`details` is present when the error relates to specific fields. Duplicate errors also include an
`existing` object showing the record already stored under that `reference_id`.

**Amounts** are numbers with up to 2 decimal places (e.g. `100`, `49.99`).
**Timestamps** are ISO 8601 UTC strings.

---

## Endpoints at a glance

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/accounts` | Create an account |
| `GET` | `/accounts` | List accounts (paginated) |
| `GET` | `/accounts/:accountId` | Get one account with its current balance |
| `POST` | `/accounts/:accountId/transactions` | Create a credit or debit |
| `GET` | `/accounts/:accountId/transactions` | List an account's transactions, latest first (paginated) |
| `GET` | `/accounts/:accountId/transactions/:transactionId` | Get one transaction |
| `POST` | `/transfers` | Transfer money between two accounts (bonus) |
| `GET` | `/transfers/:transferId` | Get a transfer with both legs (bonus) |
| `GET` | `/accounts/:accountId/reconciliation` | Compare stored balance with ledger sum |
| `GET` | `/health` | Liveness check |

`PUT`, `PATCH` and `DELETE` on a transaction or transfer return `405 METHOD_NOT_ALLOWED`.

---

## Accounts

### `POST /accounts`

Creates an account with a balance of `0`.

**Body**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `name` | string | yes | Non-empty after trimming, max 100 chars |

```json
{ "name": "Alice" }
```

**201 Created**

```json
{
  "data": {
    "id": "2c00f5dc-c66f-488a-b28e-64902d444d85",
    "name": "Alice",
    "balance": 0,
    "created_at": "2026-10-28T15:00:49.090Z",
    "updated_at": "2026-10-28T15:00:49.090Z"
  }
}
```

**Errors:** `400 VALIDATION_ERROR`, `400 INVALID_REQUEST_BODY`

### `GET /accounts?page=1&limit=10`

Lists accounts, newest first. Same pagination rules as transactions.

### `GET /accounts/:accountId`

**200 OK** — the account object (as above) with the current `balance`.
**Errors:** `404 ACCOUNT_NOT_FOUND`

---

## Transactions

### `POST /accounts/:accountId/transactions`

Creates a credit or debit and updates the balance in one atomic operation.

**Body**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `type` | string | yes | `"credit"` or `"debit"` |
| `amount` | number | yes | `> 0`, max 2 decimal places |
| `reference_id` | string | yes | Non-empty, max 100 chars, unique per account |
| `description` | string | no | Max 255 chars |

```json
{
  "type": "credit",
  "amount": 100,
  "reference_id": "dep-001",
  "description": "Opening deposit"
}
```

**201 Created**

```json
{
  "data": {
    "id": "8f0b8a3e-2b6c-4b0e-9d2a-0e4b5a1c9f11",
    "account_id": "2c00f5dc-c66f-488a-b28e-64902d444d85",
    "type": "credit",
    "amount": 100,
    "description": "Opening deposit",
    "reference_id": "dep-001",
    "balance_after": 100,
    "transfer_id": null,
    "created_at": "2026-10-28T15:00:49.100Z"
  }
}
```

**200 OK (idempotent replay)** — the same `reference_id` was sent again with an identical payload.
Returns the original transaction and header `Idempotent-Replayed: true`. The balance is not changed.

**Errors**

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_TRANSACTION_TYPE` | `type` missing or not `credit`/`debit` |
| 400 | `INVALID_AMOUNT` | `amount` missing, not a number, `<= 0`, or more than 2 decimals |
| 400 | `VALIDATION_ERROR` | Other or multiple field problems (e.g. missing `reference_id`, unknown field) |
| 400 | `INVALID_REQUEST_BODY` | Body is not valid JSON or not a JSON object |
| 404 | `ACCOUNT_NOT_FOUND` | `accountId` does not exist |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account with a different payload |
| 422 | `INSUFFICIENT_BALANCE` | Debit amount exceeds the current balance |

Example `422`:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance for this debit",
    "details": [ { "field": "amount", "message": "Available balance is 100, requested 500" } ]
  }
}
```

### `GET /accounts/:accountId/transactions?page=1&limit=10`

Returns the account's transactions sorted **latest first** by `created_at`.

| Query | Default | Rules |
| --- | --- | --- |
| `page` | `1` | Positive integer |
| `limit` | `10` | Positive integer, max `100` |

A page beyond the last returns `200` with an empty `data` array.

**Errors:** `400 INVALID_PAGINATION`, `404 ACCOUNT_NOT_FOUND`

### `GET /accounts/:accountId/transactions/:transactionId`

**Errors:** `404 ACCOUNT_NOT_FOUND`, `404 TRANSACTION_NOT_FOUND`

---

## Transfers (bonus)

### `POST /transfers`

Moves money between two accounts. The debit on the source and the credit on the destination are
written atomically; if either fails, nothing is saved.

**Body**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `from_account_id` | string | yes | Must exist |
| `to_account_id` | string | yes | Must exist, must differ from `from_account_id` |
| `amount` | number | yes | `> 0`, max 2 decimal places |
| `reference_id` | string | yes | Unique across transfers |
| `description` | string | no | Max 255 chars |

**201 Created**

```json
{
  "data": {
    "id": "80eff8d9-1d2a-4a09-bb94-3e1ecd3bca1e",
    "reference_id": "tr-001",
    "from_account_id": "<A>",
    "to_account_id": "<B>",
    "amount": 30,
    "description": null,
    "created_at": "2026-10-28T15:00:49.104Z",
    "debit_transaction":  { "type": "debit",  "account_id": "<A>", "balance_after": 70, "transfer_id": "80eff8d9-...", "...": "..." },
    "credit_transaction": { "type": "credit", "account_id": "<B>", "balance_after": 80, "transfer_id": "80eff8d9-...", "...": "..." }
  }
}
```

Replaying an identical request returns `200` with `Idempotent-Replayed: true`.

**Errors:** `400 VALIDATION_ERROR`, `404 ACCOUNT_NOT_FOUND`, `409 DUPLICATE_TRANSACTION`,
`422 INSUFFICIENT_BALANCE`

### `GET /transfers/:transferId`

Returns the transfer with both legs. **Errors:** `404 TRANSFER_NOT_FOUND`

---

## Reconciliation

### `GET /accounts/:accountId/reconciliation`

Recomputes the balance from the ledger and compares it with the stored balance.

```json
{
  "data": {
    "account_id": "<A>",
    "stored_balance": 70,
    "ledger_balance": 70,
    "consistent": true
  }
}
```

---

## Full list of error codes

| Status | Code |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_TRANSACTION_TYPE`, `INVALID_AMOUNT`, `INVALID_PAGINATION`, `INVALID_REQUEST_BODY` |
| 404 | `ACCOUNT_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `TRANSFER_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `DUPLICATE_TRANSACTION` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `INSUFFICIENT_BALANCE` |
| 500 | `INTERNAL_ERROR` |
