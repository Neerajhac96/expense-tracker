/**
 * Dashboard module — data selectors, expense row HTML, and all dashboard renderers.
 *
 * Data selectors (activeExpenses, currentMonthExpenses, dashboardExpenses,
 * filteredDashboardExpenses) are the only place in the app that derive sub-arrays
 * from state.expenses. All other modules that need filtered data import from here.
 */

import { state }  from "./state.js";
import { el }     from "./ui.js";
import { ROOMMATES, PEOPLE_META } from "./constants.js";
import {
  money, fromPaise, toPaise, monthLabel, currentMonth,
  formattedDate, escapeHTML, calculateBalances, totalsBy, categoryIcon,
} from "./utils.js";
import { isOwner } from "./auth.js";

// ── Safe date display helper ───────────────────────────────────────────────────
/**
 * Returns a formatted date string, or a safe fallback if the value is missing
 * or unparseable. Prevents a corrupted Firestore date field from crashing the
 * renderer.
 * @param {string} iso
 * @returns {string}
 */
function safeDate(iso) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso))
    return "—";
  try   { return formattedDate(iso); }
  catch { return iso; }  // last resort: show raw string
}

// ── Data selectors ─────────────────────────────────────────────────────────────

/** Returns all expenses that have not been soft-deleted. */
export function activeExpenses() {
  return state.expenses.filter((e) => !e.deleted);
}

/** Returns active, non-archived expenses for the current calendar month. */
export function currentMonthExpenses() {
  return activeExpenses().filter((e) => !e.archived && e.date?.startsWith(currentMonth()));
}

/**
 * Alias of currentMonthExpenses().
 * Retained so archive.js callers continue working unchanged.
 */
export function dashboardExpenses() { return currentMonthExpenses(); }

/**
 * Returns currentMonthExpenses() filtered by the search/category/date inputs.
 * Used for the expense row list and the CSV / WhatsApp report exports.
 * @returns {object[]}
 */
export function filteredDashboardExpenses() {
  const needle = el.search.value.trim().toLowerCase();
  return currentMonthExpenses().filter((e) =>
    (!needle            || `${e.itemName} ${e.note} ${e.paidBy}`.toLowerCase().includes(needle)) &&
    (!el.category.value || e.category === el.category.value) &&
    (!el.dateFrom.value || e.date >= el.dateFrom.value) &&
    (!el.dateTo.value   || e.date <= el.dateTo.value)
  );
}

// ── Expense row HTML ───────────────────────────────────────────────────────────

/**
 * Returns the HTML string for a single expense row.
 * Used by the dashboard list (mode "active") and the trash list (mode "trash").
 * @param {object}            item
 * @param {"active"|"trash"}  mode
 * @returns {string} HTML
 */
export function expenseRowHTML(item, mode) {
  // Guard: id must be a non-empty string before placing in the DOM
  if (!item?.id || typeof item.id !== "string") return "";

  const [icon, color] = categoryIcon(item.category);
  const owner      = isOwner(item);
  const lockAttr   = owner ? "" : ' title="You can only modify your own expenses." class="btn-disabled"';
  const lockClass  = owner ? "" : " btn-disabled";
  const lockTitle  = owner ? "" : ` title="You can only modify your own expenses."`;

  const actions = mode === "trash"
    ? `<button type="button" data-action="restore"${owner ? "" : lockAttr}>Restore</button>` +
      `<button type="button" class="delete${lockClass}" data-action="permanent"${lockTitle}>Delete forever</button>`
    : `<button type="button" data-action="edit" aria-label="Edit expense"${owner ? "" : lockAttr}>✎</button>` +
      `<button type="button" class="delete${lockClass}" data-action="soft-delete" aria-label="Move expense to trash"${lockTitle}>×</button>`;

  // item.id comes from Firestore's auto-generated document ID (alphanumeric only)
  // and is safe to use as a data attribute without escaping.
  return `<article class="expense-row${mode === "trash" ? " trash-row" : ""}" data-id="${item.id}">
    <div class="category-icon" style="--cat:${color}">${icon}</div>
    <div class="expense-main">
      <strong>${escapeHTML(item.itemName)}</strong>
      <small>${escapeHTML(item.note || item.category || "Other")}</small>
    </div>
    <div class="expense-meta">${safeDate(item.date)}</div>
    <div class="expense-payer"><small>Paid by</small><b>${escapeHTML(item.paidBy)}</b></div>
    <div class="expense-amount">${money(item.amount)}</div>
    <div class="row-actions">${actions}</div>
  </article>`;
}

// ── Private sub-renderers ──────────────────────────────────────────────────────

function renderPeople(expenses) {
  const { paid, balances } = calculateBalances(expenses);
  el.people.innerHTML = ROOMMATES.map((name, i) => {
    const meta    = PEOPLE_META[i];
    const balance = balances[name];
    const label   = balance > 0 ? "Will receive" : balance < 0 ? "Needs to pay" : "All settled";
    const cls     = balance > 0 ? "receive" : balance < 0 ? "pay" : "even";
    return `<article class="person-card" style="--person-color:${meta.color};--avatar-bg:${meta.bg}">
      <div class="person-top">
        <div class="avatar">${meta.initials}</div>
        <span class="person-paid">Paid <strong>${money(fromPaise(paid[name]))}</strong></span>
      </div>
      <p class="person-name">${name}</p>
      <div class="balance">
        <span>${label}</span>
        <strong class="${cls}">${balance ? money(fromPaise(Math.abs(balance))) : "₹0.00"}</strong>
      </div>
    </article>`;
  }).join("");
}

function renderSettlement(expenses) {
  const { transfers } = calculateBalances(expenses);
  el.settleSub.textContent = transfers.length
    ? `${transfers.length} transfer${transfers.length > 1 ? "s" : ""} clears every balance.`
    : "Everything is even. Nice!";
  el.settlements.innerHTML = transfers.length
    ? transfers.map((t) =>
        `<div class="transfer">
          <strong>${escapeHTML(t.from)}</strong> <span>→</span> <strong>${escapeHTML(t.to)}</strong>
          &nbsp;${money(fromPaise(t.value))}
        </div>`
      ).join("")
    : '<p class="settlement-empty">No payments are needed right now.</p>';
}

function renderRows(expenses) {
  el.expenseList.innerHTML = expenses.length
    ? expenses.map((e) => expenseRowHTML(e, "active")).join("")
    : '<div class="empty-state"><strong>No expenses found</strong><span>Add an expense or change the filters to see activity here.</span></div>';
}

// ── Main renderer ──────────────────────────────────────────────────────────────

/**
 * Renders the complete dashboard from state.expenses.
 *
 * Stat cards (total, count, share, people, settlement) use ALL current-month
 * expenses — filters are intentionally not applied to totals so the summary
 * always matches the Analytics page, which also reads all active expenses.
 *
 * The expense row list respects the search / category / date filter inputs.
 *
 * Called after every Firestore update and after any filter input change.
 */
export function renderDashboard() {
  const allMonth = currentMonthExpenses();
  const filtered = filteredDashboardExpenses();
  const balances = calculateBalances(allMonth);

  el.dashMonth.textContent = monthLabel(currentMonth());
  el.total.textContent     = money(fromPaise(balances.totalPaise));
  el.count.textContent     = allMonth.length;
  el.share.textContent     = money(fromPaise(balances.totalPaise) / ROOMMATES.length);
  el.hint.textContent      = allMonth.length
    ? `${allMonth.length} expense${allMonth.length === 1 ? "" : "s"} in ${monthLabel(currentMonth())}`
    : "No current-month expenses yet";

  renderPeople(allMonth);
  renderSettlement(allMonth);
  renderRows(filtered);
}

// ── Export / report helpers ────────────────────────────────────────────────────

/**
 * Builds a WhatsApp-formatted expense summary and writes it to the clipboard.
 * Falls back to document.execCommand when the Clipboard API is unavailable.
 * @param {string} title - human-readable room label (e.g. "Flat 123")
 */
export async function copyReport(title) {
  const expenses = filteredDashboardExpenses();
  const result   = calculateBalances(expenses);
  const lines    = [
    `*${title} Expense Report*`,
    `*Month:* ${monthLabel(currentMonth())}`,
    `*Total:* ${money(fromPaise(result.totalPaise))}`,
    `*Per person share:* ${money(fromPaise(result.totalPaise) / ROOMMATES.length)}`,
    "",
    "*Who paid*",
    ...ROOMMATES.map((n) => `${n}: ${money(fromPaise(result.paid[n]))}`),
    "",
    "*Settlement*",
    ...(result.transfers.length
      ? result.transfers.map((t) => `${t.from} → ${t.to} ${money(fromPaise(t.value))}`)
      : ["Everyone is settled up."]),
  ];
  const report = lines.join("\n");
  try {
    await navigator.clipboard.writeText(report);
  } catch {
    const area = document.createElement("textarea");
    area.value = report;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * Exports the currently-filtered dashboard expenses as a UTF-8 CSV download.
 * @param {string} roomCode - used in the downloaded filename
 */
export function exportCSV(roomCode) {
  const rows  = filteredDashboardExpenses();
  const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const csv   = [
    ["Date", "Paid By", "Item Name", "Category", "Amount (INR)", "Note"],
    ...rows.map((e) => [e.date, e.paidBy, e.itemName, e.category, Number(e.amount).toFixed(2), e.note]),
  ].map((row) => row.map(quote).join(",")).join("\r\n");

  const link    = document.createElement("a");
  link.href     = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `${roomCode}-${currentMonth()}-expenses.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}
