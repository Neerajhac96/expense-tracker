/**
 * Trash module — renders the soft-deleted expense list.
 */

import { state } from "./state.js";
import { el }    from "./ui.js";
import { expenseRowHTML } from "./dashboard.js";

/**
 * Renders the trash list from state.expenses.
 * Reuses expenseRowHTML (mode "trash") for consistent row layout with restore/delete actions.
 * Called after every Firestore update and when the Trash page is activated.
 */
export function renderTrash() {
  const deleted = state.expenses.filter((e) => e.deleted);
  el.trashList.innerHTML = deleted.length
    ? deleted.map((e) => expenseRowHTML(e, "trash")).join("")
    : '<div class="empty-state"><strong>Trash is empty</strong><span>Deleted expenses will appear here until permanently removed.</span></div>';
}
