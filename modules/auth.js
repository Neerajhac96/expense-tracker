/**
 * Authentication module — login, logout, session persistence, ownership checks.
 * Manages the lifecycle: localStorage ↔ state ↔ Firestore listener.
 *
 * Security model
 * ══════════════
 * 1. Login attempts are rate-limited: 5 failures lock the form for 30 seconds.
 *    This prevents automated brute-force of the access codes from the UI.
 * 2. Access code comparison uses a character-by-character loop that always runs
 *    to completion, making timing-based attacks on the codes impractical.
 * 3. Session restoration re-validates that the saved name is still a known user
 *    (guards against localStorage tampering with an unknown name).
 * 4. isOwner() returns false for any expense lacking an ownerCode so that
 *    legacy data cannot be accidentally modified by anyone.
 */

import { isConfigured }  from "../firebase.js";
import { state }         from "./state.js";
import { ROOM_ID, USER_CODES, STORAGE_KEYS } from "./constants.js";
import { el }            from "./ui.js";
import { subscribeExpenses } from "./firestore.js";

// ── Rate limiting state ────────────────────────────────────────────────────────
const RATE_LIMIT = {
  maxAttempts:  5,
  lockoutMs:    30_000,   // 30 seconds
  attempts:     0,
  lockedUntil:  0,
};

/** Returns true when the login form is currently locked out. */
function isLockedOut() {
  return Date.now() < RATE_LIMIT.lockedUntil;
}

/** Records a failed attempt and locks the form if the threshold is reached. */
function recordFailedAttempt() {
  RATE_LIMIT.attempts += 1;
  if (RATE_LIMIT.attempts >= RATE_LIMIT.maxAttempts) {
    RATE_LIMIT.lockedUntil = Date.now() + RATE_LIMIT.lockoutMs;
    RATE_LIMIT.attempts    = 0;  // reset for the next window
  }
}

/** Resets the failure counter after a successful login. */
function recordSuccess() {
  RATE_LIMIT.attempts   = 0;
  RATE_LIMIT.lockedUntil = 0;
}

// ── Constant-time string comparison ───────────────────────────────────────────
/**
 * Compares two strings in O(max(a.length, b.length)) time, always iterating
 * to the end of the longer string. This prevents timing-oracle attacks from
 * measuring how many characters matched before the comparison returned false.
 *
 * NOTE: This is not cryptographic protection — the codes are visible in the
 * bundle. The goal is only to slightly harden the comparison against timing
 * analysis if an attacker has remote-timing access.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  const len = Math.max(sa.length, sb.length);
  let mismatch = sa.length !== sb.length ? 1 : 0;
  for (let i = 0; i < len; i++) {
    mismatch |= (sa.charCodeAt(i) ?? 0) ^ (sb.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}

// ── Ownership helper ───────────────────────────────────────────────────────────

/**
 * Returns true when the logged-in user is the original creator of an expense.
 * Expenses without an ownerCode (created before the auth system) are locked
 * for everyone to prevent accidental modification.
 * @param {object} expense - normalised expense object
 * @returns {boolean}
 */
export function isOwner(expense) {
  return (
    typeof state.userCode === "string" && state.userCode.length > 0 &&
    typeof expense?.ownerCode === "string" && expense.ownerCode.length > 0 &&
    safeEqual(expense.ownerCode, state.userCode)
  );
}

// ── Room title ─────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable label from the active room code.
 * e.g. "flat123" → "Flat 123"
 * @returns {string}
 */
export function roomTitle() {
  return `Flat ${state.roomCode.slice(-3)}`;
}

// ── Session management ─────────────────────────────────────────────────────────

/**
 * Activates the shared room for the authenticated user.
 * Persists session keys to localStorage, shows the app shell, and starts the
 * Firestore listener via subscribeExpenses(renderAll).
 *
 * @param {string}       userName  - display name (must be a key in USER_CODES)
 * @param {() => void}   renderAll - fan-out render callback for subscribeExpenses
 */
export function enterRoom(userName, renderAll) {
  state.roomCode    = ROOM_ID;
  state.currentUser = userName;
  state.userCode    = USER_CODES[userName] ?? "";

  localStorage.setItem(STORAGE_KEYS.currentUser,  userName);
  localStorage.setItem(STORAGE_KEYS.codeVerified,  "true");
  localStorage.setItem(STORAGE_KEYS.currentRoom,   ROOM_ID);

  el.joinScreen.classList.add("is-hidden");
  el.appShell.classList.remove("is-hidden");
  el.roomName.textContent   = roomTitle();
  el.footerRoom.textContent = `Shared in ${roomTitle()}`;

  subscribeExpenses(renderAll);
}

/**
 * Logs the user out: tears down the Firestore listener, resets all state,
 * clears session keys from localStorage, and shows the login screen.
 */
export function logout() {
  state.unsubscribe?.();
  state.unsubscribe         = null;
  state.expenses            = [];
  state.roomCode            = "";
  state.currentUser         = "";
  state.userCode            = "";
  state.selectedArchive     = "";

  localStorage.removeItem(STORAGE_KEYS.currentUser);
  localStorage.removeItem(STORAGE_KEYS.codeVerified);
  localStorage.removeItem(STORAGE_KEYS.currentRoom);

  el.appShell.classList.add("is-hidden");
  el.joinScreen.classList.remove("is-hidden");
  el.ownerName.value       = "";
  el.accessCode.value      = "";
  el.joinError.textContent = "";
  el.ownerName.focus();
}

/**
 * Handles the login form submission.
 *
 * Security steps:
 * 1. Checks lockout before any processing.
 * 2. Validates name is a known roommate (prevents unknown-name injection).
 * 3. Compares code with safeEqual (constant-time comparison).
 * 4. Records failed attempt and shows remaining-attempts hint after 3 failures.
 * 5. Resets rate-limit counter on success.
 *
 * @param {SubmitEvent}  event
 * @param {() => void}   renderAll - forwarded to enterRoom → subscribeExpenses
 */
export function login(event, renderAll) {
  event.preventDefault();

  // ── Lockout check ────────────────────────────────────────────────────────────
  if (isLockedOut()) {
    const remaining = Math.ceil((RATE_LIMIT.lockedUntil - Date.now()) / 1000);
    el.joinError.textContent =
      `Too many failed attempts. Please wait ${remaining}s before trying again.`;
    return;
  }

  if (!isConfigured) {
    el.joinError.textContent = "Firebase is not configured yet. Add your credentials in firebase.js.";
    return;
  }

  // ── Sanitise inputs ──────────────────────────────────────────────────────────
  const name = el.ownerName.value;
  const code = el.accessCode.value.trim();

  if (!name) {
    el.joinError.textContent = "Please select your name.";
    return;
  }
  if (!code) {
    el.joinError.textContent = "Please enter your access code.";
    return;
  }

  // ── Validate name is a known roommate ────────────────────────────────────────
  if (!Object.hasOwn(USER_CODES, name)) {
    el.joinError.textContent = "Invalid name selection.";
    recordFailedAttempt();
    el.accessCode.value = "";
    el.accessCode.focus();
    return;
  }

  // ── Constant-time code comparison ────────────────────────────────────────────
  if (!safeEqual(USER_CODES[name], code)) {
    recordFailedAttempt();

    const remaining = RATE_LIMIT.maxAttempts - RATE_LIMIT.attempts;
    if (remaining <= 2 && remaining > 0) {
      el.joinError.textContent =
        `Invalid Access Code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining before lockout.`;
    } else if (isLockedOut()) {
      el.joinError.textContent = "Too many failed attempts. Please wait 30s before trying again.";
    } else {
      el.joinError.textContent = "Invalid Access Code.";
    }

    el.accessCode.value = "";
    el.accessCode.focus();
    return;
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  recordSuccess();
  el.joinError.textContent = "";
  enterRoom(name, renderAll);
}

/**
 * Attempts to restore a previously persisted session from localStorage.
 *
 * Security steps:
 * 1. Validates that savedUser is an actual key in USER_CODES (not an injected value).
 * 2. Validates that codeVerified is exactly the string "true".
 * 3. Guards against old sessions that pre-date the currentRoom key.
 *
 * @param {() => void} renderAll
 * @returns {boolean} true if a session was found and restored
 */
export function restoreSession(renderAll) {
  const savedUser    = localStorage.getItem(STORAGE_KEYS.currentUser);
  const codeVerified = localStorage.getItem(STORAGE_KEYS.codeVerified);

  // Strictly validate both values before trusting them
  if (
    savedUser &&
    codeVerified === "true" &&
    Object.hasOwn(USER_CODES, savedUser)   // prevents unknown-name injection
  ) {
    // Guard against old sessions that pre-date the currentRoom key.
    if (!localStorage.getItem(STORAGE_KEYS.currentRoom)) {
      localStorage.setItem(STORAGE_KEYS.currentRoom, ROOM_ID);
    }
    enterRoom(savedUser, renderAll);
    return true;
  }

  // Invalid or tampered session — clear all keys
  localStorage.removeItem(STORAGE_KEYS.currentUser);
  localStorage.removeItem(STORAGE_KEYS.codeVerified);
  localStorage.removeItem(STORAGE_KEYS.currentRoom);
  return false;
}
