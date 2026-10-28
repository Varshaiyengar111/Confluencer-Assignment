'use strict';

process.env.NODE_ENV = 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createDatabase } = require('../src/db');
const { createLedgerService } = require('../src/ledgerService');
const { createApp } = require('../src/app');

let app;
let db;
let service;

beforeEach(() => {
  db = createDatabase(':memory:');
  service = createLedgerService(db);
  app = createApp(service);
});

async function newAccount(name = 'Alice') {
  const res = await request(app).post('/accounts').send({ name });
  assert.equal(res.status, 201);
  return res.body.data;
}

function tx(accountId, body) {
  return request(app).post(`/accounts/${accountId}/transactions`).send(body);
}

let refCounter = 0;
const ref = () => `ref-${++refCounter}`;

describe('accounts', () => {
  test('creates an account with zero balance', async () => {
    const a = await newAccount('Alice');
    assert.equal(a.name, 'Alice');
    assert.equal(a.balance, 0);
    assert.ok(a.id);
  });

  test('rejects missing / blank / non-string name', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 42 }]) {
      const res = await request(app).post('/accounts').send(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.equal(res.body.error.details[0].field, 'name');
    }
  });

  test('rejects unknown fields such as a client-supplied balance', async () => {
    const res = await request(app).post('/accounts').send({ name: 'A', balance: 1000 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].field, 'balance');
  });

  test('404 for unknown account', async () => {
    const res = await request(app).get('/accounts/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ACCOUNT_NOT_FOUND');
  });

  test('malformed JSON body returns INVALID_REQUEST_BODY', async () => {
    const res = await request(app)
      .post('/accounts')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_REQUEST_BODY');
  });

  test('array body returns INVALID_REQUEST_BODY', async () => {
    const res = await request(app).post('/accounts').send([{ name: 'x' }]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_REQUEST_BODY');
  });
});

describe('transactions', () => {
  test('spec example: 0 +100 +50 -30 -20 = 100', async () => {
    const a = await newAccount();
    for (const [type, amount] of [['credit', 100], ['credit', 50], ['debit', 30], ['debit', 20]]) {
      const res = await tx(a.id, { type, amount, reference_id: ref() });
      assert.equal(res.status, 201);
    }
    const acct = (await request(app).get(`/accounts/${a.id}`)).body.data;
    assert.equal(acct.balance, 100);
    assert.equal(service.reconcile(a.id).consistent, true);
  });

  test('records balance_after and handles decimals without float drift', async () => {
    const a = await newAccount();
    for (let i = 0; i < 10; i++) await tx(a.id, { type: 'credit', amount: 0.1, reference_id: ref() });
    const acct = (await request(app).get(`/accounts/${a.id}`)).body.data;
    assert.equal(acct.balance, 1);
  });

  test('invalid type', async () => {
    const a = await newAccount();
    const res = await tx(a.id, { type: 'refund', amount: 10, reference_id: ref() });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_TRANSACTION_TYPE');
  });

  test('invalid amounts', async () => {
    const a = await newAccount();
    for (const amount of [0, -5, '10', null, 1.234, Infinity]) {
      const res = await tx(a.id, { type: 'credit', amount, reference_id: ref() });
      assert.equal(res.status, 400, `amount=${amount}`);
      assert.equal(res.body.error.code, 'INVALID_AMOUNT');
    }
  });

  test('missing reference_id', async () => {
    const a = await newAccount();
    const res = await tx(a.id, { type: 'credit', amount: 10 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].field, 'reference_id');
  });

  test('transaction on unknown account returns 404', async () => {
    const res = await tx('nope', { type: 'credit', amount: 10, reference_id: ref() });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ACCOUNT_NOT_FOUND');
  });

  test('insufficient balance is rejected and does not change balance', async () => {
    const a = await newAccount();
    await tx(a.id, { type: 'credit', amount: 50, reference_id: ref() });
    const res = await tx(a.id, { type: 'debit', amount: 50.01, reference_id: ref() });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'INSUFFICIENT_BALANCE');
    const acct = (await request(app).get(`/accounts/${a.id}`)).body.data;
    assert.equal(acct.balance, 50);
    const list = (await request(app).get(`/accounts/${a.id}/transactions`)).body;
    assert.equal(list.pagination.total_records, 1);
  });

  test('debit of exact balance succeeds', async () => {
    const a = await newAccount();
    await tx(a.id, { type: 'credit', amount: 50, reference_id: ref() });
    const res = await tx(a.id, { type: 'debit', amount: 50, reference_id: ref() });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.balance_after, 0);
  });

  test('duplicate reference_id with identical payload is an idempotent replay', async () => {
    const a = await newAccount();
    const body = { type: 'credit', amount: 100, reference_id: 'pay-1', description: 'salary' };
    const first = await tx(a.id, body);
    const second = await tx(a.id, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers['idempotent-replayed'], 'true');
    assert.equal(second.body.data.id, first.body.data.id);
    const acct = (await request(app).get(`/accounts/${a.id}`)).body.data;
    assert.equal(acct.balance, 100, 'balance applied only once');
  });

  test('duplicate reference_id with different payload returns 409', async () => {
    const a = await newAccount();
    await tx(a.id, { type: 'credit', amount: 100, reference_id: 'pay-1' });
    const res = await tx(a.id, { type: 'credit', amount: 200, reference_id: 'pay-1' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'DUPLICATE_TRANSACTION');
    assert.equal(res.body.error.existing.amount, 100);
  });

  test('same reference_id on different accounts is allowed', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    assert.equal((await tx(a.id, { type: 'credit', amount: 1, reference_id: 'shared' })).status, 201);
    assert.equal((await tx(b.id, { type: 'credit', amount: 1, reference_id: 'shared' })).status, 201);
  });

  test('transactions cannot be edited or deleted via the API', async () => {
    const a = await newAccount();
    const t = (await tx(a.id, { type: 'credit', amount: 10, reference_id: ref() })).body.data;
    for (const method of ['put', 'patch', 'delete']) {
      const res = await request(app)[method](`/accounts/${a.id}/transactions/${t.id}`).send({ amount: 999 });
      assert.equal(res.status, 405);
      assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED');
    }
    const fetched = (await request(app).get(`/accounts/${a.id}/transactions/${t.id}`)).body.data;
    assert.deepEqual(fetched, t);
  });

  test('transactions are immutable at the database level too', async () => {
    const a = await newAccount();
    const t = (await tx(a.id, { type: 'credit', amount: 10, reference_id: ref() })).body.data;
    assert.throws(() => db.prepare('UPDATE transactions SET amount = 1 WHERE id = ?').run(t.id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id), /immutable/);
  });

  test('database rejects a negative balance even if app checks are bypassed', () => {
    const a = service.createAccount({ name: 'X' });
    assert.throws(() => db.prepare('UPDATE accounts SET balance = -1 WHERE id = ?').run(a.id), /CHECK/);
  });
});

describe('atomicity', () => {
  test('if the ledger insert fails, the balance update is rolled back', async () => {
    const a = await newAccount();
    // Force the INSERT into transactions to fail after the balance UPDATE has run.
    db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON transactions
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    const res = await tx(a.id, { type: 'credit', amount: 100, reference_id: ref() });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.equal(service.getAccount(a.id).balance, 0);
  });
});

describe('pagination & sorting', () => {
  test('returns latest-first with pagination metadata', async () => {
    const a = await newAccount();
    for (let i = 1; i <= 25; i++) await tx(a.id, { type: 'credit', amount: i, reference_id: `r${i}` });

    const p1 = (await request(app).get(`/accounts/${a.id}/transactions?page=1&limit=10`)).body;
    assert.deepEqual(p1.pagination, {
      page: 1, limit: 10, total_records: 25, total_pages: 3, has_next: true, has_previous: false,
    });
    assert.equal(p1.data.length, 10);
    assert.equal(p1.data[0].reference_id, 'r25');
    assert.equal(p1.data[9].reference_id, 'r16');

    const p3 = (await request(app).get(`/accounts/${a.id}/transactions?page=3&limit=10`)).body;
    assert.equal(p3.data.length, 5);
    assert.equal(p3.data[4].reference_id, 'r1');
    assert.equal(p3.pagination.has_next, false);

    for (let i = 1; i < p1.data.length; i++) {
      assert.ok(p1.data[i - 1].created_at >= p1.data[i].created_at);
    }
  });

  test('defaults to page=1, limit=10', async () => {
    const a = await newAccount();
    const res = (await request(app).get(`/accounts/${a.id}/transactions`)).body;
    assert.equal(res.pagination.page, 1);
    assert.equal(res.pagination.limit, 10);
    assert.equal(res.pagination.total_pages, 0);
    assert.deepEqual(res.data, []);
  });

  test('page beyond the last returns empty data, not an error', async () => {
    const a = await newAccount();
    await tx(a.id, { type: 'credit', amount: 1, reference_id: ref() });
    const res = await request(app).get(`/accounts/${a.id}/transactions?page=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });

  test('invalid pagination params', async () => {
    const a = await newAccount();
    for (const q of ['page=0', 'page=-1', 'page=abc', 'limit=0', 'limit=101', 'limit=1.5', 'page=1&page=2']) {
      const res = await request(app).get(`/accounts/${a.id}/transactions?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.error.code, 'INVALID_PAGINATION');
    }
  });
});

describe('transfers (bonus)', () => {
  async function funded(name, amount) {
    const acct = await newAccount(name);
    if (amount) await tx(acct.id, { type: 'credit', amount, reference_id: ref() });
    return acct;
  }

  test('spec example: A=100, B=50, transfer 30 -> A=70, B=80', async () => {
    const a = await funded('A', 100);
    const b = await funded('B', 50);
    const res = await request(app).post('/transfers').send({
      from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 'tr-1',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.debit_transaction.type, 'debit');
    assert.equal(res.body.data.credit_transaction.type, 'credit');
    assert.equal(service.getAccount(a.id).balance, 70);
    assert.equal(service.getAccount(b.id).balance, 80);
    assert.ok(service.reconcile(a.id).consistent && service.reconcile(b.id).consistent);
  });

  test('insufficient balance: nothing changes on either side', async () => {
    const a = await funded('A', 10);
    const b = await funded('B', 50);
    const res = await request(app).post('/transfers').send({
      from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 'tr-2',
    });
    assert.equal(res.status, 422);
    assert.equal(service.getAccount(a.id).balance, 10);
    assert.equal(service.getAccount(b.id).balance, 50);
  });

  test('unknown destination: 404 and source untouched', async () => {
    const a = await funded('A', 100);
    const res = await request(app).post('/transfers').send({
      from_account_id: a.id, to_account_id: 'ghost', amount: 30, reference_id: 'tr-3',
    });
    assert.equal(res.status, 404);
    assert.equal(service.getAccount(a.id).balance, 100);
  });

  test('failure on the credit leg rolls back the debit leg', async () => {
    const a = await funded('A', 100);
    const b = await funded('B', 0);
    db.exec(`CREATE TRIGGER fail_credit BEFORE INSERT ON transactions
             WHEN NEW.type = 'credit' AND NEW.transfer_id IS NOT NULL
             BEGIN SELECT RAISE(ABORT, 'simulated credit failure'); END;`);
    const res = await request(app).post('/transfers').send({
      from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 'tr-4',
    });
    assert.equal(res.status, 500);
    assert.equal(service.getAccount(a.id).balance, 100);
    assert.equal(service.getAccount(b.id).balance, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transfers').get().n, 0);
  });

  test('same-account transfer is rejected', async () => {
    const a = await funded('A', 100);
    const res = await request(app).post('/transfers').send({
      from_account_id: a.id, to_account_id: a.id, amount: 1, reference_id: 'tr-5',
    });
    assert.equal(res.status, 400);
  });

  test('duplicate transfer reference: replay vs conflict', async () => {
    const a = await funded('A', 100);
    const b = await funded('B', 0);
    const body = { from_account_id: a.id, to_account_id: b.id, amount: 10, reference_id: 'tr-6' };
    assert.equal((await request(app).post('/transfers').send(body)).status, 201);
    assert.equal((await request(app).post('/transfers').send(body)).status, 200);
    assert.equal(service.getAccount(a.id).balance, 90);
    const conflict = await request(app).post('/transfers').send({ ...body, amount: 20 });
    assert.equal(conflict.status, 409);
  });

  test('GET /transfers/:id returns both legs', async () => {
    const a = await funded('A', 100);
    const b = await funded('B', 0);
    const created = (await request(app).post('/transfers').send({
      from_account_id: a.id, to_account_id: b.id, amount: 5, reference_id: 'tr-7',
    })).body.data;
    const res = await request(app).get(`/transfers/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.debit_transaction.account_id, a.id);
    assert.equal(res.body.data.credit_transaction.account_id, b.id);
  });
});

test('unknown route returns consistent 404 error', async () => {
  const res = await request(app).get('/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
});
