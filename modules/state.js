/**
 * Central application state.
 * All modules read from and write to this single object.
 * Never create a parallel expense array — always use state.expenses.
 */
export const state = {
  /** Active Firestore room — always "flat123" once logged in. */
  roomCode: "",

  /** Display name of the authenticated user (e.g. "Niraj Kumar"). */
  currentUser: "",

  /** Private access code of the authenticated user. Used for ownership checks. */
  userCode: "",

  /** All expense documents from Firestore. Single source of truth for every renderer. */
  expenses: [],

  /** Firestore listener unsubscribe handle. Always call before creating a new listener. */
  unsubscribe: null,

  /** Timer handle for the auto-hiding toast notification. */
  toastTimer: null,

  /** Month key ("YYYY-MM") of the currently-expanded archive entry. */
  selectedArchive: "",

  /** Deferred PWA install prompt, captured from the `beforeinstallprompt` event. */
  deferredInstallPrompt: null,
};
