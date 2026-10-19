'use strict';

const express = require('express');
const store = require('../data/store');

const router = express.Router();

/**
 * Adds the computed remainingCapacity field to an invoice representation.
 *
 * @param {object} invoice invoice record
 * @returns {object} invoice with remainingCapacity
 */
function present(invoice) {
  if (!invoice) {
    return invoice;
  }
  return { ...invoice, remainingCapacity: store.remaining(invoice) };
}

/**
 * Validates a create-invoice payload.
 *
 * @param {object} body request body
 * @returns {{ value?: object, errors?: string[] }} validated fields or errors
 */
function validateInvoice(body) {
  const errors = [];
  const b = body || {};
  const str = (k, max = 120) => {
    if (typeof b[k] !== 'string' || !b[k].trim() || b[k].length > max) {
      errors.push(`${k} must be a non-empty string (max ${max} chars)`);
    }
  };
  str('sme');
  str('debtor');
  if (typeof b.amount !== 'number' || !(b.amount > 0) || b.amount > 1e12) {
    errors.push('amount must be a positive number');
  }
  const yieldBps = b.yieldBps === undefined ? 800 : b.yieldBps;
  if (!Number.isInteger(yieldBps) || yieldBps < 0 || yieldBps > 10000) {
    errors.push('yieldBps must be an integer between 0 and 10000');
  }
  if (typeof b.dueDate !== 'string' || Number.isNaN(Date.parse(b.dueDate))) {
    errors.push('dueDate must be an ISO date (YYYY-MM-DD)');
  }
  if (errors.length) {
    return { errors };
  }
  return {
    value: {
      sme: b.sme.trim(),
      debtor: b.debtor.trim(),
      smeAddress: typeof b.smeAddress === 'string' ? b.smeAddress : null,
      amount: b.amount,
      currency: typeof b.currency === 'string' ? b.currency.toUpperCase().slice(0, 12) : 'USDC',
      yieldBps,
      dueDate: b.dueDate,
    },
  };
}

router.get('/', (req, res) => {
  const { status } = req.query;
  if (status && !store.STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${store.STATUSES.join(', ')}` });
  }
  const data = status ? store.list().filter((i) => i.status === status) : store.list();
  return res.json({ data: data.map(present), count: data.length });
});

router.get('/:id', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  return res.json({ data: present(invoice) });
});

router.post('/', (req, res) => {
  const { value, errors } = validateInvoice(req.body);
  if (errors) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  return res.status(201).json({ data: present(store.create(value)) });
});

// Fund handler checks are ordered deterministically:
//   404  -> invoice not found
//   400 -> invalid amount (non-finite, non-positive, above face value)
//   409 -> invoice not open
//   422 -> contribution exceeds remaining capacity and allowPartial is false
router.post('/:id/fund', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const body = req.body || {};
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(amount > 0)) {
    return res.status(400).json({ error: 'amount must be a positive finite number', code: 'INVALID_AMOUNT' });
  }
  if (amount > invoice.amount) {
    return res.status(400).json({ error: 'amount must not exceed the invoice face value', code: 'INVALID_AMOUNT' });
  }
  if (invoice.status !== 'open') {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; only open invoices can be funded` });
  }

  const remainingCapacity = store.remaining(invoice);
  if (amount > remainingCapacity) {
    const allowPartial = body.allowPartial === true;
    if (!allowPartial) {
      return res.status(422).json({
        error: 'Contribution exceeds remaining capacity',
        code: 'FUNDING_EXCEEDS_CAPACITY',
        remainingCapacity,
      });
    }
    const accepted = remainingCapacity;
    const rejected = amount - accepted;
    const updated = store.fund(invoice, accepted);
    return res.json({ data: present(updated), accepted, rejected });
  }

  const updated = store.fund(invoice, amount);
  return res.json({ data: present(updated) });
});

module.exports = router;
module.exports.validateInvoice = validateInvoice;
