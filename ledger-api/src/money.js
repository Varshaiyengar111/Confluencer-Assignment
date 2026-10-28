'use strict';

// Amounts travel over the API as decimal numbers with at most 2 decimal places
// (e.g. 100, 49.99) and are stored as integer minor units (10000, 4999).

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

function toMinor(value) {
  // Caller guarantees value is a finite number with <= 2 decimals.
  return Math.round(value * 100);
}

function fromMinor(minor) {
  return minor / 100;
}

function hasAtMostTwoDecimals(value) {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

module.exports = { toMinor, fromMinor, hasAtMostTwoDecimals, MAX_MINOR };
