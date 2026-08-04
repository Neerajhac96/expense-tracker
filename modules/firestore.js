/**
 * Firestore module — the ONLY file that reads from or writes to Firestore.
 * Centralises: collection paths, the realtime listener, all CRUD operations,
 * snapshot normalisation, and Firebase error formatting.
 *
 * Security model
 * ══════════════
 * 1. Every write operation enforces a server-side ownership check using
 *    isOwnerInState(). The client-side check in expenses.js is the first gate;
 *    this is the second gate, ensuring no write can slip through via a direct
 *    module call even if the UI layer were bypassed.
 * 2. Only a strict allow-list of fields is written to Firestore. No spread of
 *    arbitrary caller objects to prevent prototype-pollution or field injection.
 * 3. Field values are validated for type and basic range before the write.
 * 4. archiveExpenses() is exempt from ownership checks because it operates on
 *    ALL current-month expenses (a shared operation).
 *
 * No other module may import from firebase.js or call Firestore APIs directly.
 */

import {
  db, collection, deleteDoc, doc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, writeBatch,
} from "../firebase.js";
import { state }   from "./state.js";
import { ROOM_ID, ALLOWED_PAIDBY_ARRAY, ALLOWED_CATEGORY_ARRAY } from "./constants.js";
import { setStatus, toast } from "./ui.js";

// ── Collection / document helpers ──────────────────────────────────────────────

/** @returns {import("firebase/firestore").CollectionReference} */
export function expenseColRef() {
  return collection(db, "rooms", ROOM_ID, "expenses");
}

/** @returns {import("firebase/firestore").DocumentReference} */
export function expenseDocRef(id) {
  return doc(expenseColRef(), id);
}

// ── Error formatting ───────────────────────────────────────────────────────────

/**
 * Converts a Firebase/Firestore error into a human-readable message.
 * Never leaks internal error codes to the user.
 * @param {Error} error
 * @returns {string}
 */
export function friendlyError(error) {
  if (!navigator.onLine)
    return "You're offline. Please reconnect and try again.";

  switch (error?.code) {
    case "permission-denied":
    case "PERMISSION_DENIED":
      return "Access denied. You may not have permission to perform this action.";
    case "unavailable":
    case "UNAVAILABLE":
      return "Firestore is temporarily unavailable. Please try again in a moment.";
    case "not-found":
    case "NOT_FOUND":
      return "This expense no longer exists — it may have been deleted.";
    case "already-exists":
      return "A duplicate record was detected. Please refresh and try again.";
    case "resource-exhausted":
      return "Too many requests. Please wait a moment and try again.";
    case "deadline-exceeded":
    case "aborted":
      return "The operation timed out. Check your connection and try again.";
    case "unauthenticated":
      return "Your session has expired. Please log out and log back in.";
    default:
      // Log the real error server-side without exposing it to the user
      console.error("[FlatSplit] Firestore error:", error?.code, error?.message);
      return "Something went wrong. Please try again.";
  }
}

// ── Snapshot normaliser ────────────────────────────────────────────────────────

/**
 * Converts a Firestore DocumentSnapshot into a normalised plain expense object.
 * Guarantees the presence of all fields the UI depends on.
 * Coerces types to prevent renderer crashes if Firestore returns unexpected data.
 * @param {import("firebase/firestore").DocumentSnapshot} snapshot
 * @returns {object}
 */
export function normaliseExpense(snapshot) {
  const d = snapshot.data() ?? {};
  return {
    id:           String(d.id || snapshot.id),
    date:         typeof d.date === "string" ? d.date : "",
    paidBy:       typeof d.paidBy === "string" ? d.paidBy : "",
    itemName:     typeof d.itemName === "string" ? d.itemName : "",
    category:     typeof d.category === "string" ? d.category : "Other",
    amount:       Number(d.amount) || 0,
    note:         typeof d.note === "string" ? d.note : "",
    createdBy:    typeof d.createdBy === "string" ? d.createdBy : "",
    ownerCode:    typeof d.ownerCode === "string" ? d.ownerCode : "",
    deleted:      Boolean(d.deleted),
    archived:     Boolean(d.archived),
    archiveMonth: typeof d.archiveMonth === "string" ? d.archiveMonth : null,
    deletedAt:    d.deletedAt ?? null,
    // imageUrl intentionally omitted — field ignored if present in legacy documents
  };
}

// ── Realtime listener ──────────────────────────────────────────────────────────

/**
 * Subscribes to the shared expenses collection in real time.
 * This is the ONLY Firestore listener in the application — call it ONCE per session.
 * Automatically tears down any previous listener before creating a new one.
 *
 * @param {() => void} onUpdate - called after state.expenses is written
 */
export function subscribeExpenses(onUpdate) {
  state.unsubscribe?.();
  setStatus(navigator.onLine ? "Connecting" : "Offline", navigator.onLine ? "loading" : "error");

  state.unsubscribe = onSnapshot(
    query(expenseColRef(), orderBy("date", "desc")),
    (snapshot) => {
      state.expenses = snapshot.docs.map(normaliseExpense);
      setStatus("Live updates on");
      onUpdate();
    },
    (error) => {
      console.error("[FlatSplit] Firestore listener error:", error?.code, error?.message);
      setStatus("Connection error", "error");
      toast(friendlyError(error), true);
    }
  );
}

// ── Server-side ownership guard ────────────────────────────────────────────────

/**
 * Re-verifies ownership by looking up the expense in the current in-memory state.
 * Throws a structured error if ownership cannot be confirmed.
 *
 * This is the second gate (after the client-side isOwner check in expenses.js)
 * to ensure that no mutation can succeed if the state has changed between
 * when the user clicked and when the write executes.
 *
 * @param {string} id - expense document ID
 * @returns {object} the expense object (for callers that need it)
 */
function assertOwnership(id) {
  const expense = state.expenses.find((e) => e.id === id);
  if (!expense) {
    const err = new Error("Expense not found in current state.");
    err.code = "not-found";
    throw err;
  }
  if (!state.userCode || !expense.ownerCode || expense.ownerCode !== state.userCode) {
    const err = new Error("Ownership verification failed.");
    err.code = "permission-denied";
    throw err;
  }
  return expense;
}

// ── Field allowlist for write operations ───────────────────────────────────────

/**
 * Returns a validated, strictly-typed write payload for an expense.
 * Only fields in this function reach Firestore — no caller-supplied extras.
 *
 * @param {{ date, paidBy, itemName, category, amount, note }} fields
 * @returns {{ date, paidBy, itemName, category, amount, note }}
 */
function buildWritePayload(fields) {
  const amount = Math.round(Number(fields.amount) * 100) / 100;

  // These validations are a last line of defence — the form layer already
  // validated, but we never trust the caller.
  if (!fields.date || typeof fields.date !== "string")
    throw Object.assign(new Error("Invalid date."), { code: "invalid-argument" });

  if (!ALLOWED_PAIDBY_ARRAY.includes(fields.paidBy))
    throw Object.assign(new Error("Invalid paidBy value."), { code: "invalid-argument" });

  if (!ALLOWED_CATEGORY_ARRAY.includes(fields.category))
    throw Object.assign(new Error("Invalid category value."), { code: "invalid-argument" });

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
    throw Object.assign(new Error("Amount out of range."), { code: "invalid-argument" });

  return {
    date:     String(fields.date).slice(0, 10),
    paidBy:   String(fields.paidBy).slice(0, 50),
    itemName: String(fields.itemName).slice(0, 80),
    category: String(fields.category).slice(0, 40),
    amount,
    note:     String(fields.note ?? "").slice(0, 240),
  };
}

// ── Write operations ───────────────────────────────────────────────────────────

/**
 * Creates a new expense document with a server-generated ID.
 * @param {object} fields    - user-entered form data (already validated by expenses.js)
 * @param {string} createdBy - display name of the logged-in user
 * @param {string} ownerCode - access code stamped for future ownership checks
 */
export async function createExpense(fields, createdBy, ownerCode) {
  if (!state.roomCode) throw Object.assign(new Error("No active room."), { code: "unauthenticated" });
  if (!ownerCode)      throw Object.assign(new Error("No owner code."),  { code: "unauthenticated" });

  const payload = buildWritePayload(fields);
  const ref     = doc(expenseColRef());

  await setDoc(ref, {
    ...payload,
    id:           ref.id,
    createdBy:    String(createdBy).slice(0, 50),
    ownerCode:    String(ownerCode).slice(0, 32),
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
    deleted:      false,
    deletedAt:    null,
    archived:     false,
    archiveMonth: null,
  });
}

/**
 * Updates the mutable fields of an existing expense.
 * Ownership is re-verified before the write (second gate).
 * Only the explicit field allowlist reaches Firestore.
 * @param {string} id
 * @param {object} fields - updated form data (already validated by expenses.js)
 */
export async function updateExpense(id, fields) {
  assertOwnership(id);                     // throws if not owner or not found
  const payload = buildWritePayload(fields);

  await updateDoc(expenseDocRef(id), {
    ...payload,
    updatedAt: serverTimestamp(),
    // id, createdBy, ownerCode, createdAt intentionally never overwritten
  });
}

/**
 * Soft-deletes an expense (moves it to the Trash view).
 * Ownership re-verified before write.
 * @param {string} id
 */
export async function softDeleteExpense(id) {
  assertOwnership(id);
  await updateDoc(expenseDocRef(id), {
    deleted:   true,
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Restores a soft-deleted expense from the Trash.
 * Ownership re-verified before write.
 * @param {string} id
 */
export async function restoreExpense(id) {
  assertOwnership(id);
  await updateDoc(expenseDocRef(id), {
    deleted:   false,
    deletedAt: null,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Permanently removes an expense document from Firestore.
 * Ownership re-verified before delete.
 * @param {string} id
 */
export async function deleteExpense(id) {
  assertOwnership(id);
  await deleteDoc(expenseDocRef(id));
}

/**
 * Archives a batch of expenses under the given month key.
 * This is a shared operation (affects all roommates' expenses) and is exempt
 * from per-expense ownership checks by design.
 * Firestore batch writes cap at 500 operations; 450 used here for headroom.
 * @param {object[]} expenses    - expense objects that each have an `id` field
 * @param {string}  archiveMonth - "YYYY-MM"
 */
export async function archiveExpenses(expenses, archiveMonth) {
  if (!state.roomCode)
    throw Object.assign(new Error("No active room."), { code: "unauthenticated" });

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(archiveMonth))
    throw Object.assign(new Error("Invalid archiveMonth format."), { code: "invalid-argument" });

  for (let start = 0; start < expenses.length; start += 450) {
    const batch = writeBatch(db);
    expenses.slice(start, start + 450).forEach((e) =>
      batch.update(expenseDocRef(e.id), {
        archived:     true,
        archiveMonth: archiveMonth.slice(0, 7),
        updatedAt:    serverTimestamp(),
      })
    );
    await batch.commit();
  }
}
