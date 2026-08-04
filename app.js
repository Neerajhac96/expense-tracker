/**
 * app.js — Application entry point.
 *
 * This file is intentionally thin: it imports all modules and wires events.
 * All business logic, Firestore access, and rendering live in modules/.
 */

import { state }          from "./modules/state.js";
import {
  el, setModal, setPage, setStatus, initialiseTheme, toast,
} from "./modules/ui.js";
import { subscribeExpenses } from "./modules/firestore.js";
import { login, logout, restoreSession, roomTitle } from "./modules/auth.js";
import {
  clearExpenseForm, openExpense, handleSaveExpense,
  handleSoftDelete, handleRestore, handlePermanentDelete,
} from "./modules/expenses.js";
import { renderDashboard, copyReport, exportCSV } from "./modules/dashboard.js";
import { renderHistory }    from "./modules/history.js";
import { renderAnalytics }  from "./modules/analytics.js";
import { renderTrash }      from "./modules/trash.js";
import { openArchiveModal, closeCurrentMonth } from "./modules/archive.js";
import { currentMonth, monthLabel } from "./modules/utils.js";

// ── Single render fan-out ──────────────────────────────────────────────────────
// Called by subscribeExpenses() after every Firestore snapshot.
// Every renderer reads exclusively from state.expenses.

function renderAll() {
  renderDashboard();
  renderHistory();
  renderAnalytics();
  renderTrash();
}

// ── Page-change handler ────────────────────────────────────────────────────────
// Called by setPage() when the user switches tabs.
// Dashboard is always kept current by subscribeExpenses → renderAll.

function onPageChange(page) {
  if (page === "history")   renderHistory();
  if (page === "analytics") renderAnalytics();
  if (page === "trash")     renderTrash();
}

// ── Event binding ──────────────────────────────────────────────────────────────

function bindEvents() {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  el.joinForm.addEventListener("submit", (e) => login(e, renderAll));
  document.getElementById("logoutButton").addEventListener("click", logout);

  // ── Add expense buttons ────────────────────────────────────────────────────────
  ["addExpenseTop", "addExpenseHero"].forEach((id) =>
    document.getElementById(id).addEventListener("click", () => openExpense())
  );

  // ── Expense form ───────────────────────────────────────────────────────────────
  el.expenseForm.addEventListener("submit", handleSaveExpense);

  // ── Navigation ────────────────────────────────────────────────────────────────
  document.querySelectorAll("[data-page]").forEach((btn) =>
    btn.addEventListener("click", () => setPage(btn.dataset.page, onPageChange))
  );
  document.querySelector("[data-page-link]").addEventListener("click", () =>
    setPage("dashboard", onPageChange)
  );

  // ── Dashboard filters ──────────────────────────────────────────────────────────
  [el.search, el.category, el.dateFrom, el.dateTo].forEach((input) =>
    input.addEventListener("input", renderDashboard)
  );
  document.getElementById("clearFilters").addEventListener("click", () => {
    el.search.value   = "";
    el.category.value = "";
    el.dateFrom.value = "";
    el.dateTo.value   = "";
    renderDashboard();
  });

  // ── Expense list actions (edit / soft-delete) ─────────────────────────────────
  el.expenseList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.classList.contains("btn-disabled")) return;
    const id   = e.target.closest(".expense-row")?.dataset.id;
    if (!id) return;
    const item = state.expenses.find((x) => x.id === id);
    if (btn.dataset.action === "edit")        openExpense(item);
    if (btn.dataset.action === "soft-delete") await handleSoftDelete(id);
  });

  // ── Trash list actions (restore / permanent-delete) ───────────────────────────
  el.trashList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.classList.contains("btn-disabled")) return;
    const id = e.target.closest(".expense-row")?.dataset.id;
    if (!id) return;
    if (btn.dataset.action === "restore")   await handleRestore(id);
    if (btn.dataset.action === "permanent") await handlePermanentDelete(id);
  });

  // ── Archive month navigation ───────────────────────────────────────────────────
  el.archiveMonths.addEventListener("click", (e) => {
    const month = e.target.closest("[data-month]")?.dataset.month;
    if (!month) return;
    state.selectedArchive = month;
    renderHistory();
    el.archiveDetail.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  el.archiveDetail.addEventListener("click", (e) => {
    if (e.target.closest("#closeArchiveDetail")) {
      state.selectedArchive = "";
      renderHistory();
    }
  });

  // ── Dashboard actions ──────────────────────────────────────────────────────────
  document.getElementById("copyReport").addEventListener("click", async () => {
    await copyReport(roomTitle());
    toast("WhatsApp report copied.");
  });
  document.getElementById("exportCsv").addEventListener("click", () => {
    exportCSV(state.roomCode);
    toast("CSV export downloaded.");
  });
  document.getElementById("closeMonth").addEventListener("click", openArchiveModal);
  el.confirmArchive.addEventListener("click", closeCurrentMonth);

  // ── Modal close — [data-close-*] buttons and Escape key ───────────────────────
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-modal]"))   setModal(el.expenseModal, false);
    if (e.target.closest("[data-close-archive]")) setModal(el.archiveModal, false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    setModal(el.expenseModal, false);
    setModal(el.archiveModal, false);
  });

  // ── PWA install prompt ─────────────────────────────────────────────────────────
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    el.installBtn.classList.remove("is-hidden");
  });
  el.installBtn.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    const { outcome } = await state.deferredInstallPrompt.userChoice;
    if (outcome === "accepted") el.installBtn.classList.add("is-hidden");
    state.deferredInstallPrompt = null;
  });

  // ── Online / offline ───────────────────────────────────────────────────────────
  window.addEventListener("offline", () => setStatus("Offline", "error"));
  window.addEventListener("online",  () => { if (state.roomCode) subscribeExpenses(renderAll); });

  // ── Cleanup on unload ──────────────────────────────────────────────────────────
  window.addEventListener("beforeunload", () => state.unsubscribe?.());
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

initialiseTheme();
clearExpenseForm();
el.dashMonth.textContent = monthLabel(currentMonth());
bindEvents();

// Restore session from localStorage, or show the login screen if none found.
if (!restoreSession(renderAll)) {
  el.ownerName.focus();
}
