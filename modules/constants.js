/**
 * Application-wide constants.
 * All hardcoded values live here. Never inline these in other modules.
 */

/** The single shared Firestore room. All users share this collection. */
export const ROOM_ID = "flat123";

/** Ordered list of flat-mates. Index must match PEOPLE_META. */
export const ROOMMATES = ["Niraj Kumar", "Vivekananda", "Aniket Gupta"];

/**
 * Private access codes keyed by display name.
 *
 * SECURITY NOTE:
 * These codes are visible in the browser bundle because this is a client-side
 * only app deployed on GitHub Pages (no server). They serve as a lightweight
 * PIN mechanism to identify the user for ownership tracking.
 *
 * The REAL security boundary is Firestore Security Rules, which must enforce:
 *   - Read: allow only authenticated or room-verified clients.
 *   - Write: allow only the ownerCode-matched user.
 *
 * Do NOT rely on these codes to protect sensitive data — use Firestore Rules.
 */
export const USER_CODES = {
  "Niraj Kumar":  "flat246",
  "Aniket Gupta": "flat482",
  "Vivekananda":  "flat628",
};

/**
 * Allowlist arrays for server-side write validation in firestore.js.
 * Must stay in sync with the HTML <option> lists in index.html.
 */
export const ALLOWED_PAIDBY_ARRAY = ["Niraj Kumar", "Vivekananda", "Aniket Gupta"];

export const ALLOWED_CATEGORY_ARRAY = [
  "Groceries",
  "Rent & Utilities",
  "Food & Dining",
  "Transport",
  "Household",
  "Entertainment",
  "Other",
];

/** localStorage keys — grouped here to prevent typos. */
export const STORAGE_KEYS = {
  currentUser:  "flatsplit.currentUser",
  codeVerified: "flatsplit.userCodeVerified",
  currentRoom:  "flatsplit.currentRoom",
};

/**
 * Per-category display metadata.
 * Format: { categoryName: [emoji, hexColor] }
 */
export const CATEGORY_META = {
  Groceries:          ["🛒", "#3d9b70"],
  "Rent & Utilities": ["⌂",  "#5960cf"],
  "Food & Dining":    ["🍜", "#dc7552"],
  Transport:          ["⌁",  "#347dc4"],
  Household:          ["⌘",  "#a66ac5"],
  Entertainment:      ["✦",  "#d28c37"],
  Other:              ["•",  "#75809b"],
};

/**
 * Per-person avatar metadata.
 * Index must stay in sync with ROOMMATES.
 */
export const PEOPLE_META = [
  { color: "#5746d6", bg: "#eeecff", initials: "NK" },
  { color: "#168064", bg: "#e8f8f1", initials: "V"  },
  { color: "#d17537", bg: "#fff1e7", initials: "AG" },
];
