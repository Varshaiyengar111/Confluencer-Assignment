'use strict';

const express = require('express');
const { ApiError, errors } = require('./errors');
const v = require('./validators');

function createApp(service) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const notAllowed = (msg) => (req, res, next) => next(errors.methodNotAllowed(msg));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---------- accounts ----------
  app.post('/accounts', (req, res) => {
    const input = v.validateCreateAccount(req.body);
    res.status(201).json({ data: service.createAccount(input) });
  });

  app.get('/accounts', (req, res) => {
    res.json(service.listAccounts(v.validatePagination(req.query)));
  });

  app.get('/accounts/:accountId', (req, res) => {
    res.json({ data: service.getAccount(req.params.accountId) });
  });

  app.get('/accounts/:accountId/reconciliation', (req, res) => {
    res.json({ data: service.reconcile(req.params.accountId) });
  });

  // ---------- transactions ----------
  app.post('/accounts/:accountId/transactions', (req, res) => {
    const input = v.validateCreateTransaction(req.body);
    const { transaction, created } = service.createTransaction(req.params.accountId, input);
    res.status(created ? 201 : 200).set('Idempotent-Replayed', String(!created)).json({ data: transaction });
  });

  app.get('/accounts/:accountId/transactions', (req, res) => {
    const pagination = v.validatePagination(req.query);
    res.json(service.listTransactions(req.params.accountId, pagination));
  });

  app.get('/accounts/:accountId/transactions/:transactionId', (req, res) => {
    res.json({ data: service.getTransaction(req.params.accountId, req.params.transactionId) });
  });

  // Transactions are immutable: explicitly reject edit/delete.
  app.all(
    '/accounts/:accountId/transactions/:transactionId',
    notAllowed('Transactions are immutable and cannot be modified or deleted')
  );

  // ---------- transfers (bonus) ----------
  app.post('/transfers', (req, res) => {
    const input = v.validateCreateTransfer(req.body);
    const { transfer, created } = service.createTransfer(input);
    res.status(created ? 201 : 200).set('Idempotent-Replayed', String(!created)).json({ data: transfer });
  });

  app.get('/transfers/:transferId', (req, res) => {
    res.json({ data: service.getTransfer(req.params.transferId) });
  });

  app.all('/transfers/:transferId', notAllowed('Transfers are immutable and cannot be modified or deleted'));

  // ---------- fallthrough + error handling ----------
  app.use((req, res, next) => next(errors.routeNotFound(req.method, req.path)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = errors.invalidBody();
    else if (err.type === 'entity.too.large') err = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

    if (!(err instanceof ApiError)) {
      if (process.env.NODE_ENV !== 'test') console.error(err);
      err = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    if (err.existing) body.error.existing = err.existing;
    res.status(err.status).json(body);
  });

  return app;
}

module.exports = { createApp };
