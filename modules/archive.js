/**
 * Archive module — "Close current month" modal and batch archive operation.
 */

import { el, setModal, toast } from "./ui.js";
import { monthLabel, currentMonth } from "./utils.js";
import { friendlyError, archiveExpenses } from "./firestore.js";
import { dashboardExpenses } from "./dashboard.js";

/**
 * Opens the "Close current month" confirmation modal.
 * Shows a toast and aborts if there are no current-month expenses to archive.
 */
export function openArchiveModal() {
  const count = dashboardExpenses().length;
  if (!count) { toast("There are no current-month expenses to close.", true); return; }
  el.archiveMonthLabel.textContent = monthLabel(currentMonth());
  el.archiveError.textContent      = "";
  setModal(el.archiveModal, true);
}

/**
 * Archives all active current-month expenses via a Firestore batch write.
 * Closes the confirmation modal on success.
 */
export async function closeCurrentMonth() {
  const expenses = dashboardExpenses();
  if (!expenses.length) return;

  el.confirmArchive.disabled    = true;
  el.confirmArchive.textContent = "Closing…";

  try {
    await archiveExpenses(expenses, currentMonth());
    setModal(el.archiveModal, false);
    toast(`${monthLabel(currentMonth())} is safely archived.`);
  } catch (err) {
    el.archiveError.textContent = friendlyError(err);
  } finally {
    el.confirmArchive.disabled    = false;
    el.confirmArchive.textContent = "Close month";
  }
}
