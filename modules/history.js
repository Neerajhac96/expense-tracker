/**
 * History module — renders the archived-months list and the read-only detail panel.
 */

import { state }     from "./state.js";
import { el }        from "./ui.js";
import { ROOMMATES } from "./constants.js";
import {
  money, fromPaise, monthLabel, formattedDate, escapeHTML, calculateBalances,
} from "./utils.js";
import { activeExpenses } from "./dashboard.js";

// ── Safe date helper (mirrors dashboard.js — guards against corrupted dates) ───
/**
 * Returns a formatted date string, or "—" if the value is invalid.
 * Prevents a corrupted Firestore date field from crashing the history renderer.
 * @param {string} iso
 * @returns {string}
 */
function safeDate(iso) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  try   { return formattedDate(iso); }
  catch { return iso; }
}

// ── History page renderer ──────────────────────────────────────────────────────

/**
 * Renders the list of archived months from state.expenses.
 * If a month is currently selected (state.selectedArchive), also renders its detail.
 * Called after every Firestore update and when the History page is activated.
 */
export function renderHistory() {
  // Compute once — reused for both the month list and the selected archive detail.
  const active = activeExpenses();

  const archived = active.filter((e) => e.archived && e.archiveMonth);
  const months   = [...new Set(archived.map((e) => e.archiveMonth))].sort().reverse();

  el.archiveMonths.innerHTML = months.length
    ? months.map((month) => {
        const exps  = archived.filter((e) => e.archiveMonth === month);
        const total = exps.reduce((s, e) => s + Number(e.amount), 0);
        return `<button class="archive-month-card${state.selectedArchive === month ? " is-selected" : ""}" type="button" data-month="${month}">
          <span class="archive-month-icon">▣</span>
          <span><strong>${monthLabel(month)}</strong><small>${exps.length} expenses · ${money(total)}</small></span>
          <b>View →</b>
        </button>`;
      }).join("")
    : '<div class="empty-state"><strong>No archived months yet</strong><span>Close a month from the dashboard to keep a permanent, read-only record here.</span></div>';

  if (state.selectedArchive && months.includes(state.selectedArchive)) {
    renderArchiveDetail(state.selectedArchive, active);
  } else {
    state.selectedArchive = "";
    el.archiveDetail.classList.add("is-hidden");
  }
}

// ── Archive detail renderer ────────────────────────────────────────────────────

/**
 * Renders the read-only expense detail for a single archived month.
 * @param {string}   month  - "YYYY-MM"
 * @param {object[]} active - pre-computed activeExpenses() array (passed to avoid re-computing)
 */
function renderArchiveDetail(month, active) {
  const expenses = active
    .filter((e) => e.archived && e.archiveMonth === month)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const result = calculateBalances(expenses);
  const groups = Object.entries(
    expenses.reduce((acc, e) => { (acc[e.date ?? ""] ??= []).push(e); return acc; }, {})
  );

  el.archiveDetail.classList.remove("is-hidden");
  el.archiveDetail.innerHTML = `
    <div class="archive-detail-head">
      <div><p class="eyebrow">READ-ONLY MONTH</p><h2>${monthLabel(month)}</h2></div>
      <button id="closeArchiveDetail" class="text-button" type="button" aria-label="Close archive detail">Close detail</button>
    </div>
    <div class="archive-summary">
      <span>Monthly total <strong>${money(fromPaise(result.totalPaise))}</strong></span>
      <span>Per person share <strong>${money(fromPaise(result.totalPaise) / ROOMMATES.length)}</strong></span>
      <span>Expenses <strong>${expenses.length}</strong></span>
    </div>
    <div class="history-settlement">
      <strong>Settlement</strong>
      ${result.transfers.length
        ? result.transfers.map((t) =>
            `<span>${escapeHTML(t.from)} → ${escapeHTML(t.to)} <b>${money(fromPaise(t.value))}</b></span>`
          ).join("")
        : "<span>Everyone is settled up.</span>"}
    </div>
    <div class="daily-groups">
      ${groups.map(([date, items]) => `
        <section class="daily-group">
          <div class="daily-head">
            <strong>${safeDate(date)}</strong>
            <span>${money(items.reduce((s, e) => s + Number(e.amount), 0))}</span>
          </div>
          ${items.map((e) => `
            <div class="readonly-row">
              <span>${escapeHTML(e.itemName)}</span>
              <small>${escapeHTML(e.category)} · ${escapeHTML(e.paidBy)}</small>
              <b>${money(e.amount)}</b>
            </div>`).join("")}
        </section>`).join("")}
    </div>`;
}
