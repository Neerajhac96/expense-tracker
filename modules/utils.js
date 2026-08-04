/**
 * Pure utility functions — no side effects, no state access, no DOM access.
 * Safe to import from any module without creating circular dependencies.
 */

import { ROOMMATES, CATEGORY_META } from "./constants.js";

// ── Date helpers ───────────────────────────────────────────────────────────────

/** @returns {string} Today's date as "YYYY-MM-DD". */
export function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/** @returns {string} Current month as "YYYY-MM". */
export function currentMonth() { return todayISO().slice(0, 7); }

/**
 * @param {string} ym - "YYYY-MM"
 * @returns {string} e.g. "August 2026"
 */
export function monthLabel(ym) {
  return ym
    ? new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" })
        .format(new Date(`${ym}-01T12:00:00`))
    : "";
}

/**
 * @param {string} iso - "YYYY-MM-DD"
 * @returns {string} e.g. "3 Aug 2026"
 */
export function formattedDate(iso) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  }).format(new Date(`${iso}T12:00:00`));
}

// ── Money helpers ──────────────────────────────────────────────────────────────

/**
 * Formats a number as an Indian Rupee currency string.
 * @param {number} value
 * @returns {string} e.g. "₹1,234.56"
 */
export function money(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", minimumFractionDigits: 2,
  }).format(Number(value) || 0);
}

/**
 * Converts a rupee value to integer paise to avoid floating-point rounding errors.
 * @param {number} value - rupees
 * @returns {number} paise (integer)
 */
export function toPaise(value) { return Math.round((Number(value) || 0) * 100); }

/**
 * Converts paise back to rupees.
 * @param {number} paise
 * @returns {number}
 */
export function fromPaise(paise) { return paise / 100; }

// ── String helpers ─────────────────────────────────────────────────────────────

/**
 * Returns an HTML-safe string with special characters entity-encoded.
 * Use whenever rendering untrusted user input into innerHTML.
 * @param {*} value
 * @returns {string}
 */
export function escapeHTML(value = "") {
  const span = document.createElement("span");
  span.textContent = String(value);
  return span.innerHTML;
}

// ── Expense data helpers ───────────────────────────────────────────────────────

/**
 * Reduces an expense array into a map of { key → total amount in rupees }.
 * @param {object[]} expenses
 * @param {(e: object) => string} keyFn - extracts the grouping key from each expense
 * @returns {{ [key: string]: number }}
 */
export function totalsBy(expenses, keyFn) {
  return expenses.reduce((acc, e) => {
    const k = keyFn(e);
    acc[k] = (acc[k] || 0) + Number(e.amount);
    return acc;
  }, {});
}

/**
 * Computes the minimum-transfer settlement plan for the three roommates.
 * Uses a greedy algorithm: resolves one creditor or debtor per iteration.
 *
 * @param {object[]} expenses - expenses to include in the calculation
 * @returns {{
 *   paid:       { [name: string]: number },   paise paid by each person
 *   balances:   { [name: string]: number },   positive = owed money back
 *   transfers:  { from: string, to: string, value: number }[],
 *   totalPaise: number
 * }}
 */
export function calculateBalances(expenses) {
  const paid       = Object.fromEntries(ROOMMATES.map((n) => [n, 0]));
  const totalPaise = expenses.reduce((s, e) => s + toPaise(e.amount), 0);

  expenses.forEach((e) => {
    if (Object.hasOwn(paid, e.paidBy)) paid[e.paidBy] += toPaise(e.amount);
  });

  const base     = Math.floor(totalPaise / ROOMMATES.length);
  const extra    = totalPaise % ROOMMATES.length;
  const balances = Object.fromEntries(
    ROOMMATES.map((n, i) => [n, paid[n] - base - (i < extra ? 1 : 0)])
  );

  const debtors   = ROOMMATES.filter((n) => balances[n] < 0).map((n) => ({ name: n, value: -balances[n] }));
  const creditors = ROOMMATES.filter((n) => balances[n] > 0).map((n) => ({ name: n, value:  balances[n] }));
  const transfers = [];
  let di = 0, ci = 0;

  while (debtors[di] && creditors[ci]) {
    const v = Math.min(debtors[di].value, creditors[ci].value);
    transfers.push({ from: debtors[di].name, to: creditors[ci].name, value: v });
    debtors[di].value   -= v;
    creditors[ci].value -= v;
    if (!debtors[di].value)   di++;
    if (!creditors[ci].value) ci++;
  }

  return { paid, balances, transfers, totalPaise };
}

/**
 * Returns the [emoji, hexColor] display metadata for a given expense category.
 * Falls back to "Other" for unrecognised category names.
 * @param {string} category
 * @returns {[string, string]}
 */
export function categoryIcon(category) {
  return CATEGORY_META[category] ?? CATEGORY_META.Other;
}
