/**
 * Expense form and action handlers.
 * Manages the add/edit modal and delegates all Firestore writes to firestore.js.
 *
 * Security model
 * ══════════════
 * 1. All user input is validated and sanitised client-side before any Firestore write.
 * 2. Ownership is verified client-side (isOwner) AND re-verified server-side in
 *    firestore.js (isOwnerInState) before every mutating operation.
 * 3. An in-flight flag prevents duplicate submissions from rapid clicks or
 *    double-taps on touch devices.
 * 4. The save button is disabled for the full duration of the async write.
 */

import { state }            from "./state.js";
import { el, setModal, toast } from "./ui.js";
import { todayISO }         from "./utils.js";
import {
  friendlyError, createExpense, updateExpense,
  softDeleteExpense, restoreExpense, deleteExpense,
} from "./firestore.js";
import { isOwner }          from "./auth.js";

// ── Allowed-value sets (mirror the HTML <option> lists exactly) ────────────────
const ALLOWED_PAIDBY = new Set(["Niraj Kumar", "Vivekananda", "Aniket Gupta"]);
const ALLOWED_CATEGORY = new Set([
  "Groceries", "Rent & Utilities", "Food & Dining",
  "Transport", "Household", "Entertainment", "Other",
]);

// ── Validation constants ───────────────────────────────────────────────────────
const MAX_ITEM_LENGTH  = 80;
const MAX_NOTE_LENGTH  = 240;
const MAX_AMOUNT       = 1_000_000;   // ₹10 lakh ceiling — reasonable for a flat
const MIN_AMOUNT       = 0.01;
const ISO_DATE_RE      = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Earliest date allowed: 1 Jan 2020 (before the app existed = data entry error)
const MIN_DATE = "2020-01-01";

// ── In-flight guard ────────────────────────────────────────────────────────────
// Prevents duplicate Firestore writes caused by double-clicks / rapid taps.
let _saving = false;
let _inFlightAction = false; // guards trash row buttons

// ── Sanitisation helper ────────────────────────────────────────────────────────
/**
 * Strips control characters (except whitespace) from a string value.
 * Prevents embedding null bytes or other invisible chars in Firestore fields.
 * Does NOT HTML-encode — that is the renderer's job (escapeHTML in utils.js).
 * @param {string} value
 * @param {number} maxLen
 * @returns {string}
 */
function sanitiseText(value, maxLen) {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")  // strip control chars
    .trim()
    .slice(0, maxLen);
}

// ── Client-side validation ─────────────────────────────────────────────────────
/**
 * Validates the expense form fields and returns an error message string,
 * or an empty string when all fields are valid.
 * @param {{ date, paidBy, itemName, category, amount, note }} fields
 * @returns {string}
 */
function validateFields(fields) {
  const { date, paidBy, itemName, category, amount, note } = fields;

  if (!date || !ISO_DATE_RE.test(date))
    return "Enter a valid date (YYYY-MM-DD).";

  if (date < MIN_DATE)
    return `Date cannot be earlier than ${MIN_DATE}.`;

  const today = todayISO();
  if (date > today)
    return "Date cannot be in the future.";

  if (!itemName)
    return "Item name is required.";

  if (itemName.length > MAX_ITEM_LENGTH)
    return `Item name must be ${MAX_ITEM_LENGTH} characters or fewer.`;

  if (!ALLOWED_PAIDBY.has(paidBy))
    return "Select a valid roommate for 'Paid by'.";

  if (!ALLOWED_CATEGORY.has(category))
    return "Select a valid category.";

  if (!Number.isFinite(amount) || amount < MIN_AMOUNT)
    return `Amount must be at least ₹${MIN_AMOUNT.toFixed(2)}.`;

  if (amount > MAX_AMOUNT)
    return `Amount cannot exceed ₹${MAX_AMOUNT.toLocaleString("en-IN")}.`;

  // Note is optional — only validate length (already trimmed by sanitiseText)
  if (note.length > MAX_NOTE_LENGTH)
    return `Note must be ${MAX_NOTE_LENGTH} characters or fewer.`;

  return ""; // all good
}

// ── Expense form ───────────────────────────────────────────────────────────────

/** Resets the expense form to its default state with today's date. */
export function clearExpenseForm() {
  el.expenseForm.reset();
  el.expenseId.value       = "";
  el.expenseDate.value     = todayISO();
  el.expCategory.value     = "Groceries";
  el.formError.textContent = "";
}

/**
 * Opens the expense add/edit modal.
 * Pass an expense object to populate the form for editing;
 * call with no argument (or null) to open a blank "add" form.
 *
 * Edit access is re-verified here so that even if an action button somehow
 * has its disabled state removed via DevTools, the JS still blocks the open.
 * @param {object|null} [item=null]
 */
export function openExpense(item = null) {
  if (!state.roomCode) { toast("Join a room first.", true); return; }

  // Ownership re-check for edit mode
  if (item && !isOwner(item)) {
    toast("You can only edit your own expenses.", true);
    return;
  }

  clearExpenseForm();

  if (item) {
    el.modalTitle.textContent = "Edit expense";
    el.saveBtn.textContent    = "Save changes";
    el.expenseId.value    = item.id;
    el.expenseDate.value  = item.date;
    el.paidBy.value       = item.paidBy;
    el.itemName.value     = item.itemName;
    el.expCategory.value  = item.category;
    el.amount.value       = item.amount;
    el.note.value         = item.note ?? "";
  } else {
    el.modalTitle.textContent = "Add expense";
    el.saveBtn.textContent    = "Save expense";
  }

  setModal(el.expenseModal, true);
  setTimeout(() => el.itemName.focus(), 50);
}

/**
 * Handles the expense form submit event.
 * • Validates every field with explicit rules.
 * • Sanitises text fields before writing to Firestore.
 * • Re-checks ownership before any update operation.
 * • Blocks concurrent submissions with an in-flight flag.
 * @param {SubmitEvent} event
 */
export async function handleSaveExpense(event) {
  event.preventDefault();

  // ── Double-submit guard ──────────────────────────────────────────────────────
  if (_saving) return;

  const id = el.expenseId.value.trim();

  // ── Build and sanitise the fields object ─────────────────────────────────────
  const fields = {
    date:     sanitiseText(el.expenseDate.value, 10),
    paidBy:   el.paidBy.value,                          // enum — only sanitise category/text
    itemName: sanitiseText(el.itemName.value, MAX_ITEM_LENGTH),
    category: el.expCategory.value,                      // enum
    amount:   Math.round(Number(el.amount.value) * 100) / 100, // round to 2 dp
    note:     sanitiseText(el.note.value, MAX_NOTE_LENGTH),
  };

  // ── Client-side validation ───────────────────────────────────────────────────
  const validationError = validateFields(fields);
  if (validationError) {
    el.formError.textContent = validationError;
    return;
  }
  el.formError.textContent = "";

  // ── Ownership re-check for updates (second gate beyond the disabled button) ──
  if (id) {
    const existing = state.expenses.find((e) => e.id === id);
    if (!existing) {
      el.formError.textContent = "This expense no longer exists. It may have been deleted.";
      return;
    }
    if (!isOwner(existing)) {
      el.formError.textContent = "You can only edit your own expenses.";
      return;
    }
  }

  // ── Lock UI ──────────────────────────────────────────────────────────────────
  _saving = true;
  el.saveBtn.disabled    = true;
  el.saveBtn.textContent = "Saving…";

  try {
    if (id) {
      await updateExpense(id, fields);
    } else {
      await createExpense(fields, state.currentUser, state.userCode);
    }
    setModal(el.expenseModal, false);
    toast(id ? "Expense updated." : "Expense added for the room.");
  } catch (err) {
    console.error("[FlatSplit] Save expense failed:", err);
    el.formError.textContent = friendlyError(err);
  } finally {
    _saving = false;
    el.saveBtn.disabled    = false;
    el.saveBtn.textContent = id ? "Save changes" : "Save expense";
  }
}

// ── Expense actions ────────────────────────────────────────────────────────────

/**
 * Soft-deletes an expense (moves to Trash) after user confirmation.
 *
 * Guards:
 * 1. btn-disabled class check already in app.js delegated listener.
 * 2. isOwner re-check here — second gate against DevTools manipulation.
 * 3. In-flight flag prevents duplicate Firestore calls from rapid clicks.
 *
 * @param {string} id - Firestore document ID
 */
export async function handleSoftDelete(id) {
  if (_inFlightAction) return;

  const item = state.expenses.find((e) => e.id === id);
  if (!item) { toast("Expense not found.", true); return; }

  // Second ownership gate
  if (!isOwner(item)) {
    toast("You can only delete your own expenses.", true);
    return;
  }

  if (!window.confirm(`Move "${item.itemName}" to Trash?`)) return;

  _inFlightAction = true;
  try {
    await softDeleteExpense(id);
    toast("Moved to Trash. You can restore it anytime.");
  } catch (err) {
    console.error("[FlatSplit] Soft delete failed:", err);
    toast(friendlyError(err), true);
  } finally {
    _inFlightAction = false;
  }
}

/**
 * Restores a soft-deleted expense from the Trash.
 *
 * Guards:
 * 1. isOwner re-check — btn-disabled already set by renderer.
 * 2. In-flight flag prevents duplicate Firestore calls.
 *
 * @param {string} id - Firestore document ID
 */
export async function handleRestore(id) {
  if (_inFlightAction) return;

  const item = state.expenses.find((e) => e.id === id);
  if (!item) { toast("Expense not found.", true); return; }

  // Second ownership gate
  if (!isOwner(item)) {
    toast("You can only restore your own expenses.", true);
    return;
  }

  _inFlightAction = true;
  try {
    await restoreExpense(id);
    toast("Expense restored.");
  } catch (err) {
    console.error("[FlatSplit] Restore failed:", err);
    toast(friendlyError(err), true);
  } finally {
    _inFlightAction = false;
  }
}

/**
 * Permanently deletes an expense from Firestore after user confirmation.
 * This action cannot be undone.
 *
 * Guards:
 * 1. isOwner re-check.
 * 2. In-flight flag.
 * 3. Explicit confirm() with item name.
 *
 * @param {string} id - Firestore document ID
 */
export async function handlePermanentDelete(id) {
  if (_inFlightAction) return;

  const item = state.expenses.find((e) => e.id === id);
  if (!item) { toast("Expense not found.", true); return; }

  // Second ownership gate
  if (!isOwner(item)) {
    toast("You can only permanently delete your own expenses.", true);
    return;
  }

  if (!window.confirm(
    `Permanently delete "${item.itemName}"?\n\nThis cannot be undone.`
  )) return;

  _inFlightAction = true;
  try {
    await deleteExpense(id);
    toast("Expense permanently deleted.");
  } catch (err) {
    console.error("[FlatSplit] Permanent delete failed:", err);
    toast(friendlyError(err), true);
  } finally {
    _inFlightAction = false;
  }
}
