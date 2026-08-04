/**
 * Shared UI primitives: DOM element cache, toast, status, modal, page, and theme.
 * All DOM queries run once at module-load time; use `el` everywhere instead of
 * calling getElementById / querySelector repeatedly in other modules.
 */

import { state } from "./state.js";


// ── Cached DOM references ──────────────────────────────────────────────────────
// ES modules are deferred by default, so the DOM is ready when this executes.

const $ = (id) => document.getElementById(id);

export const el = {
  // ── Screens
  joinScreen:    $("joinScreen"),
  appShell:      $("appShell"),

  // ── Login form
  joinForm:      $("joinForm"),
  ownerName:     $("ownerNameInput"),
  accessCode:    $("accessCodeInput"),
  joinError:     $("joinError"),

  // ── Header / connection
  status:        $("connectionStatus"),
  roomName:      $("roomName"),
  footerRoom:    $("footerRoom"),
  installBtn:    $("installButton"),

  // ── Dashboard stat cards
  dashMonth:    $("dashboardMonth"),
  total:        $("totalExpense"),
  count:        $("expenseCount"),
  share:        $("perPersonShare"),
  hint:         $("selectedExpenseHint"),
  people:       $("peopleSummary"),
  settlements:  $("settlementList"),
  settleSub:    $("settlementSubtitle"),
  expenseList:  $("expenseList"),

  // ── Dashboard filters
  search:   $("searchInput"),
  category: $("categoryFilter"),
  dateFrom: $("dateFrom"),
  dateTo:   $("dateTo"),

  // ── Modals
  expenseModal: $("expenseModal"),
  archiveModal: $("archiveModal"),

  // ── Expense form (inside expenseModal)
  expenseForm:  $("expenseForm"),
  expenseId:    $("expenseId"),
  expenseDate:  $("expenseDate"),
  paidBy:       $("paidBy"),
  itemName:     $("itemName"),
  expCategory:  $("expenseCategory"),
  amount:       $("expenseAmount"),
  note:         $("expenseNote"),
  modalTitle:   $("expenseModalTitle"),
  saveBtn:      $("saveExpense"),
  formError:    $("formError"),

  // ── Archive modal
  confirmArchive:    $("confirmArchive"),
  archiveError:      $("archiveError"),
  archiveMonthLabel: $("archiveMonthLabel"),

  // ── Page containers
  archiveMonths:  $("archiveMonthList"),
  archiveDetail:  $("archiveDetail"),
  analyticsStats: $("analyticsStats"),
  trendChart:     $("trendChart"),
  categoryChart:  $("categoryChart"),
  personChart:    $("personChart"),
  topCategories:  $("topCategories"),
  trashList:      $("trashList"),

  // ── Notifications
  toast: $("toast"),
};

// ── Toast ──────────────────────────────────────────────────────────────────────

/**
 * Shows a brief auto-hiding notification message.
 * @param {string}  message
 * @param {boolean} [isError=false] - renders error (red) styling when true
 */
export function toast(message, isError = false) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.className   = `toast show${isError ? " error" : ""}`;
  state.toastTimer     = setTimeout(() => { el.toast.className = "toast"; }, 3300);
}

// ── Connection status ──────────────────────────────────────────────────────────

/**
 * Updates the connection status badge in the header.
 * @param {string} label
 * @param {"ready"|"loading"|"error"} [type="ready"]
 */
export function setStatus(label, type = "ready") {
  el.status.className = `connection-status${type === "ready" ? "" : ` is-${type}`}`;
  el.status.innerHTML = `<i></i> ${label}`;
}

// ── Modal ──────────────────────────────────────────────────────────────────────

/**
 * Opens or closes a modal dialog and toggles body scroll lock.
 * @param {HTMLElement} modal
 * @param {boolean}     open
 */
export function setModal(modal, open) {
  modal.classList.toggle("is-open", open);
  modal.setAttribute("aria-hidden", String(!open));
  document.body.style.overflow = open ? "hidden" : "";
}

// ── Page navigation ────────────────────────────────────────────────────────────

/**
 * Activates the named page panel, updates nav-link active states, and calls
 * onPageChange(page) so the caller can trigger page-specific renders.
 * @param {string}               page         - "dashboard"|"history"|"analytics"|"trash"
 * @param {(page: string) => void} onPageChange
 */
export function setPage(page, onPageChange) {
  document.querySelectorAll(".page-panel").forEach((panel) =>
    panel.classList.toggle("is-active", panel.id === `${page}Page`)
  );
  document.querySelectorAll(".nav-link").forEach((btn) =>
    btn.classList.toggle("is-active", btn.dataset.page === page)
  );
  state.page = page;
  onPageChange(page);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Sets the dark theme on the document root.
 * Theme is dark-only — this function exists so callers don't break.
 * @param {"dark"} _theme - ignored; always applies dark
 */
export function setTheme(_theme) {
  document.documentElement.dataset.theme = "dark";
}

/**
 * Applies the dark theme on bootstrap.
 * Call once at startup.
 */
export function initialiseTheme() {
  document.documentElement.dataset.theme = "dark";
}
