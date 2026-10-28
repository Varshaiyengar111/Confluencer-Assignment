'use strict';

const { randomUUID } = require('node:crypto');
const { errors } = require('./errors');
const { fromMinor } = require('./money');
const { withTransaction } = require('./db');

// ---------- presenters (DB row -> API shape) ----------

function presentAccount(row) {
  return {
    id: row.id,
    name: row.name,
    balance: fromMinor(row.balance),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentTransaction(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    type: row.type,
    amount: fromMinor(row.amount),
    description: row.description,
    reference_id: row.reference_id,
    balance_after: fromMinor(row.balance_after),
    transfer_id: row.transfer_id,
    created_at: row.created_at,
  };
}

function presentTransfer(row, debitTx, creditTx) {
  return {
    id: row.id,
    reference_id: row.reference_id,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    amount: fromMinor(row.amount),
    description: row.description,
    created_at: row.created_at,
    debit_transaction: debitTx ? presentTransaction(debitTx) : undefined,
    credit_transaction: creditTx ? presentTransaction(creditTx) : undefined,
  };
}

// ---------- service ----------

function createLedgerService(db, { now = () => new Date().toISOString() } = {}) {
  const stmt = {
    insertAccount: db.prepare(
      'INSERT INTO accounts (id, name, balance, created_at, updated_at) VALUES (?, ?, 0, ?, ?)'
    ),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    listAccounts: db.prepare('SELECT * FROM accounts ORDER BY created_at DESC, id LIMIT ? OFFSET ?'),
    countAccounts: db.prepare('SELECT COUNT(*) AS n FROM accounts'),

    // Guarded balance updates: the WHERE clause makes an overdraft impossible
    // even under concurrent writers; CHECK (balance >= 0) is the last line of defence.
    credit: db.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?'),
    debit: db.prepare(
      'UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?'
    ),

    insertTx: db.prepare(`
      INSERT INTO transactions
        (id, account_id, type, amount, description, reference_id, balance_after, transfer_id, created_at)
      VALUES (@id, @account_id, @type, @amount, @description, @reference_id, @balance_after, @transfer_id, @created_at)
    `),
    getTx: db.prepare('SELECT * FROM transactions WHERE id = ? AND account_id = ?'),
    getTxByRef: db.prepare('SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?'),
    listTx: db.prepare(`
      SELECT * FROM transactions WHERE account_id = ?
      ORDER BY created_at DESC, seq DESC
      LIMIT ? OFFSET ?
    `),
    countTx: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?'),
    sumTx: db.prepare(`
      SELECT COALESCE(SUM(CASE type WHEN 'credit' THEN amount ELSE -amount END), 0) AS net
      FROM transactions WHERE account_id = ?
    `),

    insertTransfer: db.prepare(`
      INSERT INTO transfers (id, reference_id, from_account_id, to_account_id, amount, description, created_at)
      VALUES (@id, @reference_id, @from_account_id, @to_account_id, @amount, @description, @created_at)
    `),
    getTransfer: db.prepare('SELECT * FROM transfers WHERE id = ?'),
    getTransferByRef: db.prepare('SELECT * FROM transfers WHERE reference_id = ?'),
    getTransferLegs: db.prepare('SELECT * FROM transactions WHERE transfer_id = ? ORDER BY seq'),
  };

  function mustGetAccount(id) {
    const row = stmt.getAccount.get(id);
    if (!row) throw errors.accountNotFound(id);
    return row;
  }

  function paginate(total, page, limit) {
    return {
      page,
      limit,
      total_records: total,
      total_pages: total === 0 ? 0 : Math.ceil(total / limit),
      has_next: page * limit < total,
      has_previous: page > 1,
    };
  }

  /** Applies one ledger entry inside an already-open DB transaction. */
  function applyEntry({ accountId, type, amount, description, referenceId, transferId, ts }) {
    if (type === 'credit') {
      stmt.credit.run(amount, ts, accountId);
    } else {
      const res = stmt.debit.run(amount, ts, accountId, amount);
      if (res.changes === 0) {
        const acct = stmt.getAccount.get(accountId);
        throw errors.insufficientBalance(fromMinor(acct.balance), fromMinor(amount));
      }
    }
    const balanceAfter = stmt.getAccount.get(accountId).balance;
    const row = {
      id: randomUUID(),
      account_id: accountId,
      type,
      amount,
      description,
      reference_id: referenceId,
      balance_after: balanceAfter,
      transfer_id: transferId ?? null,
      created_at: ts,
    };
    stmt.insertTx.run(row);
    return row;
  }

  // ---- accounts ----

  function createAccount({ name }) {
    const ts = now();
    const id = randomUUID();
    stmt.insertAccount.run(id, name, ts, ts);
    return presentAccount(stmt.getAccount.get(id));
  }

  function getAccount(id) {
    return presentAccount(mustGetAccount(id));
  }

  function listAccounts({ page, limit }) {
    const total = stmt.countAccounts.get().n;
    const rows = stmt.listAccounts.all(limit, (page - 1) * limit);
    return { data: rows.map(presentAccount), pagination: paginate(total, page, limit) };
  }

  // ---- transactions ----

  /**
   * Returns { transaction, created } — created=false means an identical request
   * with the same reference_id was already processed (idempotent replay).
   */
  const createTransaction = withTransaction(db, (accountId, input) => {
    mustGetAccount(accountId);

    const existing = stmt.getTxByRef.get(accountId, input.reference_id);
    if (existing) {
      const samePayload =
        existing.type === input.type &&
        existing.amount === input.amount &&
        (existing.description ?? null) === (input.description ?? null) &&
        existing.transfer_id === null;
      if (samePayload) return { transaction: presentTransaction(existing), created: false };
      throw errors.duplicate(
        `reference_id '${input.reference_id}' has already been used for a different transaction on this account`,
        presentTransaction(existing)
      );
    }

    const row = applyEntry({
      accountId,
      type: input.type,
      amount: input.amount,
      description: input.description,
      referenceId: input.reference_id,
      ts: now(),
    });
    return { transaction: presentTransaction(row), created: true };
  });

  function listTransactions(accountId, { page, limit }) {
    mustGetAccount(accountId);
    const total = stmt.countTx.get(accountId).n;
    const rows = stmt.listTx.all(accountId, limit, (page - 1) * limit);
    return { data: rows.map(presentTransaction), pagination: paginate(total, page, limit) };
  }

  function getTransaction(accountId, txId) {
    mustGetAccount(accountId);
    const row = stmt.getTx.get(txId, accountId);
    if (!row) throw errors.transactionNotFound(txId);
    return presentTransaction(row);
  }

  // ---- transfers (bonus) ----

  const createTransfer = withTransaction(db, (input) => {
    // Both accounts must exist before anything is written.
    mustGetAccount(input.from_account_id);
    mustGetAccount(input.to_account_id);

    const existing = stmt.getTransferByRef.get(input.reference_id);
    if (existing) {
      const samePayload =
        existing.from_account_id === input.from_account_id &&
        existing.to_account_id === input.to_account_id &&
        existing.amount === input.amount &&
        (existing.description ?? null) === (input.description ?? null);
      const [d, c] = stmt.getTransferLegs.all(existing.id);
      if (samePayload) return { transfer: presentTransfer(existing, d, c), created: false };
      throw errors.duplicate(
        `reference_id '${input.reference_id}' has already been used for a different transfer`,
        presentTransfer(existing)
      );
    }

    for (const acct of [input.from_account_id, input.to_account_id]) {
      if (stmt.getTxByRef.get(acct, input.reference_id)) {
        throw errors.duplicate(
          `reference_id '${input.reference_id}' is already used by a transaction on account '${acct}'`
        );
      }
    }

    const ts = now();
    const transfer = {
      id: randomUUID(),
      reference_id: input.reference_id,
      from_account_id: input.from_account_id,
      to_account_id: input.to_account_id,
      amount: input.amount,
      description: input.description,
      created_at: ts,
    };
    stmt.insertTransfer.run(transfer);

    const description = input.description ?? null;
    const debitTx = applyEntry({
      accountId: input.from_account_id,
      type: 'debit',
      amount: input.amount,
      description,
      referenceId: input.reference_id,
      transferId: transfer.id,
      ts,
    });
    const creditTx = applyEntry({
      accountId: input.to_account_id,
      type: 'credit',
      amount: input.amount,
      description,
      referenceId: input.reference_id,
      transferId: transfer.id,
      ts,
    });
    return { transfer: presentTransfer(transfer, debitTx, creditTx), created: true };
  });

  function getTransfer(id) {
    const row = stmt.getTransfer.get(id);
    if (!row) throw Object.assign(errors.transactionNotFound(id), { code: 'TRANSFER_NOT_FOUND', message: `Transfer '${id}' was not found` });
    const [d, c] = stmt.getTransferLegs.all(id);
    return presentTransfer(row, d, c);
  }

  /** Integrity check: stored balance must equal the sum of the ledger. */
  function reconcile(accountId) {
    const acct = mustGetAccount(accountId);
    const net = stmt.sumTx.get(accountId).net;
    return {
      account_id: accountId,
      stored_balance: fromMinor(acct.balance),
      ledger_balance: fromMinor(net),
      consistent: acct.balance === net,
    };
  }

  return {
    createAccount,
    getAccount,
    listAccounts,
    createTransaction,
    listTransactions,
    getTransaction,
    createTransfer,
    getTransfer,
    reconcile,
  };
}

module.exports = { createLedgerService };
