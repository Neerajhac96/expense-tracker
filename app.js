import {
  db, storage, isConfigured, collection, deleteDoc, doc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, writeBatch, deleteObject, getDownloadURL, ref, uploadBytes
} from "./firebase.js";

const ROOMMATES = ["Niraj Kumar", "Vivekananda", "Aniket Gupta"];
// JJust testing the git a[proach
// ─── User Access Code System ──────────────────────────────────────────────────
// Each roommate has a private access code. The room is always the same shared
// Firestore collection; only permissions change per user.
const USER_CODES = {
  "Niraj Kumar":  "flat246",
  "Aniket Gupta": "flat482",
  "Vivekananda":  "flat628",
};
const HARDCODED_ROOM_CODE = "flat123";  // single shared room — never changes
const USER_STORAGE_KEY    = "flatsplit.currentUser";      // stores display name
const CODE_VERIFIED_KEY   = "flatsplit.userCodeVerified"; // "true" when logged in
const DEVICE_STORAGE_KEY  = "flatsplit.deviceId";         // kept for legacy compat
const OWNER_STORAGE_KEY   = "flatsplit.ownerName";        // kept for legacy compat
const THEME_STORAGE_KEY   = "flatsplit.theme";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // 5 MB hard cap on raw file selection
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024;  // target after compression (≈1 MB)
const MAX_IMAGE_PX    = 1600;              // maximum dimension after resize

/**
 * Compress an image File using an off-screen canvas.
 * Resizes so neither dimension exceeds MAX_IMAGE_PX, then encodes as JPEG
 * at decreasing quality until the blob fits within MAX_UPLOAD_BYTES.
 * Returns a Blob ready for Firebase Storage upload.
 */
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Calculate target dimensions, preserving aspect ratio
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > MAX_IMAGE_PX || h > MAX_IMAGE_PX) {
        const ratio = Math.min(MAX_IMAGE_PX / w, MAX_IMAGE_PX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      // Try progressively lower quality until we hit the size budget
      let quality = 0.85;
      const tryEncode = () => {
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error("Canvas toBlob failed")); return; }
          if (blob.size <= MAX_UPLOAD_BYTES || quality <= 0.3) {
            resolve(blob);
          } else {
            quality = Math.max(quality - 0.1, 0.3);
            tryEncode();
          }
        }, "image/jpeg", quality);
      };
      tryEncode();
    };
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = url;
  });
}

/**
 * Upload an image file to Firebase Storage under expenses/
 * Returns the public download URL.
 * @param {File} file
 * @param {(pct: number) => void} onProgress  - called with 0–100
 */
async function uploadExpenseImage(file, onProgress) {
  // Compress first
  onProgress(5);
  const blob = await compressImage(file);
  onProgress(20);
  // Build a unique storage path: expenses/<timestamp>-<random>.<ext>
  const ext  = file.type === "image/webp" ? "webp" : "jpg";
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const storageRef = ref(storage, `expenses/${name}`);
  // uploadBytes doesn't give byte-level progress, so we simulate 20→80 during the call
  const midTimer = setInterval(() => {
    onProgress(Math.min(79, (onProgress._pct || 20) + 12));
  }, 300);
  // Patch onProgress so the interval can read the last reported value
  const originalOnProgress = onProgress;
  let _pct = 20;
  onProgress = (pct) => { _pct = pct; originalOnProgress(pct); };
  onProgress._pct = _pct;
  try {
    const snapshot = await uploadBytes(storageRef, blob, { contentType: "image/jpeg" });
    clearInterval(midTimer);
    originalOnProgress(90);
    const url = await getDownloadURL(snapshot.ref);
    originalOnProgress(100);
    return url;
  } catch (err) {
    clearInterval(midTimer);
    throw err;
  }
}

const CATEGORY_META = {
  Groceries: ["🛒", "#3d9b70"], "Rent & Utilities": ["⌂", "#5960cf"], "Food & Dining": ["🍜", "#dc7552"],
  Transport: ["⌁", "#347dc4"], Household: ["⌘", "#a66ac5"], Entertainment: ["✦", "#d28c37"], Other: ["•", "#75809b"]
};
const PEOPLE_META = [{ color: "#5746d6", bg: "#eeecff", initials: "NK" }, { color: "#168064", bg: "#e8f8f1", initials: "V" }, { color: "#d17537", bg: "#fff1e7", initials: "AG" }];
const $ = (selector) => document.querySelector(selector);
const elements = {
  joinScreen: $("#joinScreen"), app: $("#appShell"), joinForm: $("#joinForm"), roomInput: $("#roomCodeInput"), ownerName: $("#ownerNameInput"), joinError: $("#joinError"), status: $("#connectionStatus"), roomName: $("#roomName"), footerRoom: $("#footerRoom"), dashboardMonth: $("#dashboardMonth"),
  total: $("#totalExpense"), count: $("#expenseCount"), share: $("#perPersonShare"), hint: $("#selectedExpenseHint"), people: $("#peopleSummary"), settlements: $("#settlementList"), settlementSubtitle: $("#settlementSubtitle"), list: $("#expenseList"),
  search: $("#searchInput"), category: $("#categoryFilter"), from: $("#dateFrom"), to: $("#dateTo"), expenseModal: $("#expenseModal"), archiveModal: $("#archiveModal"), imageModal: $("#imageModal"), previewImage: $("#previewImage"), form: $("#expenseForm"), formError: $("#formError"), archiveError: $("#archiveError"), toast: $("#toast"), imageInput: $("#expenseImage"), imageHint: $("#imageHint"), themeToggle: $("#themeToggle"), installButton: $("#installButton"),
  archiveMonths: $("#archiveMonthList"), archiveDetail: $("#archiveDetail"), analyticsStats: $("#analyticsStats"), trend: $("#trendChart"), categoryChart: $("#categoryChart"), personChart: $("#personChart"), topCategories: $("#topCategories"), trash: $("#trashList")
};
const state = {
  roomCode: "",
  ownerName: "",
  deviceId: "",
  // ── Auth ──────────────────────────────────────────────────────────────────
  currentUser: "",   // display name of the logged-in roommate
  userCode: "",      // their private access code (used for ownership checks)
  // ─────────────────────────────────────────────────────────────────────────
  expenses: [],
  unsubscribe: null,
  toastTimer: null,
  selectedArchive: "",
  page: "dashboard",
  deferredInstallPrompt: null,
  editingExpense: null,
};

function todayISO() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function currentMonth() { return todayISO().slice(0, 7); }
function roomTitle() { return `Flat ${state.roomCode.slice(-3)}`; }
function monthLabel(month) { return month ? new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00:00`)) : ""; }
function formattedDate(date) { return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00`)); }
function money(value) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(Number(value) || 0); }
function toCents(value) { return Math.round((Number(value) || 0) * 100); }
function fromCents(value) { return value / 100; }
function escapeHTML(value = "") { const node = document.createElement("span"); node.textContent = String(value); return node.innerHTML; }
function expenseRef() { return collection(db, "rooms", state.roomCode, "expenses"); }
/**
 * Returns true when the currently logged-in user is the creator of this expense.
 * Ownership is determined by matching the stored ownerCode on the expense document
 * against the current user's code. Expenses with no ownerCode (created before this
 * feature was added) are treated as unowned — no one may modify them.
 */
function isOwner(expense) {
  return !!state.userCode && !!expense.ownerCode && expense.ownerCode === state.userCode;
}
function ensureDeviceId() { let id = localStorage.getItem(DEVICE_STORAGE_KEY); if (!id) { id = crypto.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`; localStorage.setItem(DEVICE_STORAGE_KEY, id); } return id; }
function setTheme(theme) { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_STORAGE_KEY, theme); elements.themeToggle.textContent = theme === "dark" ? "☼" : "◐"; elements.themeToggle.setAttribute("aria-pressed", String(theme === "dark")); }
function initialiseTheme() { const saved = localStorage.getItem(THEME_STORAGE_KEY); setTheme(saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); }
function toggleTheme() { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }
function setStatus(label, type = "ready") { elements.status.className = `connection-status${type === "ready" ? "" : ` is-${type}`}`; elements.status.innerHTML = `<i></i> ${label}`; }
function toast(message, isError = false) { clearTimeout(state.toastTimer); elements.toast.textContent = message; elements.toast.className = `toast show${isError ? " error" : ""}`; state.toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 3300); }
function friendlyError(error) { if (!navigator.onLine) return "You’re offline. Changes will work again when you reconnect."; if (error?.code === "permission-denied") return "Firestore denied this action. Check your room security rules."; if (error?.code === "unavailable") return "Firestore is unavailable. Check your connection and try again."; return "Something went wrong. Please try again."; }
function activeExpenses() { return state.expenses.filter((item) => !item.deleted); }
function dashboardExpenses() { return activeExpenses().filter((item) => !item.archived && item.date?.startsWith(currentMonth())); }

function filteredDashboardExpenses() {
  const needle = elements.search.value.trim().toLowerCase();
  return dashboardExpenses().filter((expense) => (!needle || `${expense.itemName} ${expense.note} ${expense.paidBy}`.toLowerCase().includes(needle)) && (!elements.category.value || expense.category === elements.category.value) && (!elements.from.value || expense.date >= elements.from.value) && (!elements.to.value || expense.date <= elements.to.value));
}

// There are exactly three roommates, so this greedy pairing resolves a participant on each transfer and produces the minimum settlement plan.
function calculateBalances(expenses) {
  const paid = Object.fromEntries(ROOMMATES.map((name) => [name, 0]));
  const totalCents = expenses.reduce((sum, item) => sum + toCents(item.amount), 0);
  expenses.forEach((item) => { if (Object.hasOwn(paid, item.paidBy)) paid[item.paidBy] += toCents(item.amount); });
  const base = Math.floor(totalCents / ROOMMATES.length); const extra = totalCents % ROOMMATES.length;
  const balances = Object.fromEntries(ROOMMATES.map((name, index) => [name, paid[name] - base - (index < extra ? 1 : 0)]));
  const debtors = ROOMMATES.filter((name) => balances[name] < 0).map((name) => ({ name, value: -balances[name] }));
  const creditors = ROOMMATES.filter((name) => balances[name] > 0).map((name) => ({ name, value: balances[name] }));
  const transfers = []; let debtor = 0; let creditor = 0;
  while (debtors[debtor] && creditors[creditor]) { const value = Math.min(debtors[debtor].value, creditors[creditor].value); transfers.push({ from: debtors[debtor].name, to: creditors[creditor].name, value }); debtors[debtor].value -= value; creditors[creditor].value -= value; if (!debtors[debtor].value) debtor += 1; if (!creditors[creditor].value) creditor += 1; }
  return { paid, balances, transfers, totalCents };
}

function renderPeople(expenses) {
  const { paid, balances } = calculateBalances(expenses);
  elements.people.innerHTML = ROOMMATES.map((person, index) => { const meta = PEOPLE_META[index]; const balance = balances[person]; const status = balance > 0 ? "Will receive" : balance < 0 ? "Needs to pay" : "All settled"; return `<article class="person-card" style="--person-color:${meta.color};--avatar-bg:${meta.bg}"><div class="person-top"><div class="avatar">${meta.initials}</div><span class="person-paid">Paid <strong>${money(fromCents(paid[person]))}</strong></span></div><p class="person-name">${person}</p><div class="balance"><span>${status}</span><strong class="${balance > 0 ? "receive" : balance < 0 ? "pay" : "even"}">${balance ? money(fromCents(Math.abs(balance))) : "₹0.00"}</strong></div></article>`; }).join("");
}
function renderSettlement(expenses) {
  const { transfers } = calculateBalances(expenses); elements.settlementSubtitle.textContent = transfers.length ? `${transfers.length} transfer${transfers.length > 1 ? "s" : ""} clears every balance.` : "Everything is even. Nice!"; elements.settlements.innerHTML = transfers.length ? transfers.map((item) => `<div class="transfer"><strong>${escapeHTML(item.from)}</strong> <span>→</span> <strong>${escapeHTML(item.to)}</strong> &nbsp;${money(fromCents(item.value))}</div>`).join("") : '<p class="settlement-empty">No payments are needed right now.</p>';
}
function renderExpenseRows(expenses, mode = "active") {
  if (!expenses.length) { elements.list.innerHTML = '<div class="empty-state"><strong>No expenses found</strong><span>Add an expense or change the filters to see activity here.</span></div>'; return; }
  elements.list.innerHTML = expenses.map((item) => expenseRow(item, mode)).join("");
}
function expenseRow(item, mode) {
  const [icon, color] = CATEGORY_META[item.category] || CATEGORY_META.Other;
  const owner = isOwner(item);
  const lockedTitle = owner ? "" : ' title="You can only modify your own expenses." class="btn-disabled"';
  // Action buttons are visible to all but only clickable by the expense owner.
  // Expenses without an ownerCode (created before the auth system) are locked for everyone.
  let actions;
  if (mode === "trash") {
    actions = `<button type="button" data-action="restore"${owner ? "" : lockedTitle}>Restore</button>` +
              `<button type="button" class="delete${owner ? "" : " btn-disabled"}" data-action="permanent"${owner ? "" : ` title="You can only modify your own expenses."`}>Delete forever</button>`;
  } else {
    actions = `<button type="button" data-action="edit" aria-label="Edit expense"${owner ? "" : lockedTitle}>✎</button>` +
              `<button type="button" class="delete${owner ? "" : " btn-disabled"}" data-action="soft-delete" aria-label="Move expense to trash"${owner ? "" : ` title="You can only modify your own expenses."`}>×</button>`;
  }
  // Thumbnail: shown to all users if imageUrl exists; clicking opens full-screen viewer
  const thumb = item.imageUrl
    ? `<button type="button" class="thumb-btn" data-action="view-image" aria-label="View receipt image" title="View receipt">
         <img class="expense-thumb" src="${escapeHTML(item.imageUrl)}" alt="Receipt" loading="lazy"
              onerror="this.onerror=null;this.parentElement.innerHTML='<span class=thumb-err aria-label=Image\ failed>🖼️</span>'" />
       </button>`
    : "";
  return `<article class="expense-row ${mode === "trash" ? "trash-row" : ""}${item.imageUrl ? " has-thumb" : ""}" data-id="${item.id}">${thumb}<div class="category-icon" style="--cat:${color}">${icon}</div><div class="expense-main"><strong>${escapeHTML(item.itemName)}</strong><small>${escapeHTML(item.note || item.category || "Other")}</small></div><div class="expense-meta">${formattedDate(item.date)}</div><div class="expense-payer"><small>Paid by</small><b>${escapeHTML(item.paidBy)}</b></div><div class="expense-amount">${money(item.amount)}</div><div class="row-actions">${actions}</div></article>`;
}
function renderDashboard() {
  const allCurrent = dashboardExpenses(); const expenses = filteredDashboardExpenses(); const balances = calculateBalances(expenses);
  elements.dashboardMonth.textContent = monthLabel(currentMonth()); elements.total.textContent = money(fromCents(balances.totalCents)); elements.count.textContent = expenses.length; elements.share.textContent = money(fromCents(balances.totalCents) / ROOMMATES.length); elements.hint.textContent = `${expenses.length} expense${expenses.length === 1 ? "" : "s"} in ${monthLabel(currentMonth())}`;
  renderPeople(expenses); renderSettlement(expenses); renderExpenseRows(expenses); if (!allCurrent.length && !elements.search.value && !elements.category.value) elements.hint.textContent = "No current-month expenses yet";
}

function setPage(page) { document.querySelectorAll(".page-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `${page}Page`)); document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("is-active", button.dataset.page === page)); if (page === "history") renderHistory(); if (page === "analytics") renderAnalytics(); if (page === "trash") renderTrash(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function setModal(modal, open) { modal.classList.toggle("is-open", open); modal.setAttribute("aria-hidden", String(!open)); document.body.style.overflow = open ? "hidden" : ""; }
function clearExpenseForm() {
  elements.form.reset();
  $("#expenseId").value = "";
  $("#expenseDate").value = todayISO();
  $("#expenseCategory").value = "Groceries";
  elements.formError.textContent = "";
  elements.imageHint.textContent = "No image selected";
  elements.imageHint.className = "image-hint";
  // Also clear any existing imageUrl preview that was set when editing
  $("#currentImageUrl").value = "";
}
function openExpense(item) {
  if (!isConfigured || !state.roomCode) { toast("Join a room and configure Firebase first.", true); return; }
  clearExpenseForm();
  if (item) {
    $("#expenseModalTitle").textContent = "Edit expense";
    $("#saveExpense").textContent = "Save changes";
    $("#expenseId").value = item.id;
    $("#expenseDate").value = item.date;
    $("#paidBy").value = item.paidBy;
    $("#itemName").value = item.itemName;
    $("#expenseCategory").value = item.category;
    $("#expenseAmount").value = item.amount;
    $("#expenseNote").value = item.note || "";
    // Preserve existing imageUrl when editing so we don't overwrite it
    if (item.imageUrl) {
      $("#currentImageUrl").value = item.imageUrl;
      elements.imageHint.textContent = "✅ Image already uploaded";
      elements.imageHint.className = "image-hint image-hint--ok";
    }
  } else {
    $("#expenseModalTitle").textContent = "Add expense";
    $("#saveExpense").textContent = "Save expense";
  }
  setModal(elements.expenseModal, true);
  setTimeout(() => $("#itemName").focus(), 50);
}

async function saveExpense(event) {
  event.preventDefault();
  const id        = $("#expenseId").value;
  const imageFile = elements.imageInput.files?.[0] || null;
  const data = {
    date:     $("#expenseDate").value,
    paidBy:   $("#paidBy").value,
    itemName: $("#itemName").value.trim(),
    category: $("#expenseCategory").value,
    amount:   Number($("#expenseAmount").value),
    note:     $("#expenseNote").value.trim(),
  };
  if (!data.date || !data.itemName || data.amount <= 0) {
    elements.formError.textContent = "Enter a date, item name, and an amount greater than zero.";
    return;
  }
  // Reject files that are too large before even trying to compress
  if (imageFile && imageFile.size > MAX_IMAGE_BYTES) {
    elements.formError.textContent = "Image is too large (max 5 MB). Please choose a smaller file.";
    return;
  }

  const button = $("#saveExpense");
  button.disabled = true;

  // ── Step 1: upload image to Firebase Storage (if a new file was chosen) ────
  let imageUrl = $("#currentImageUrl").value || null; // keep existing url when editing
  if (imageFile && storage) {
    button.textContent = "Uploading image… 0%";
    try {
      imageUrl = await uploadExpenseImage(imageFile, (pct) => {
        button.textContent = `Uploading… ${pct}%`;
      });
    } catch (uploadErr) {
      console.error("Image upload failed:", uploadErr);
      elements.formError.textContent = "Image upload failed. Please try again.";
      button.disabled = false;
      button.textContent = id ? "Save changes" : "Save expense";
      return;
    }
  }

  // ── Step 2: save/update the Firestore document ────────────────────────────
  button.textContent = "Saving…";
  try {
    if (id) {
      // Edit: only update mutable fields. If a new image was uploaded, update imageUrl too.
      const updatePayload = { ...data, id, updatedAt: serverTimestamp() };
      if (imageUrl) updatePayload.imageUrl = imageUrl;
      await updateDoc(doc(expenseRef(), id), updatePayload);
    } else {
      // New expense: stamp creator info and save imageUrl if present.
      const newDoc = doc(expenseRef());
      const payload = {
        id:           newDoc.id,
        ...data,
        createdBy:    state.currentUser,
        ownerCode:    state.userCode,
        createdAt:    serverTimestamp(),
        updatedAt:    serverTimestamp(),
        deleted:      false,
        deletedAt:    null,
        archived:     false,
        archiveMonth: null,
      };
      if (imageUrl) payload.imageUrl = imageUrl;  // only set when an image was uploaded
      await setDoc(newDoc, payload);
    }
    setModal(elements.expenseModal, false);
    toast(id ? "Expense updated." : "Expense added for the room.");
  } catch (error) {
    console.error(error);
    elements.formError.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
    button.textContent = id ? "Save changes" : "Save expense";
  }
}
async function softDelete(id) { const item = state.expenses.find((expense) => expense.id === id); if (!item || !window.confirm(`Move “${item.itemName}” to Trash?`)) return; try { await updateDoc(doc(expenseRef(), id), { deleted: true, deletedAt: serverTimestamp(), updatedAt: serverTimestamp() }); toast("Moved to Trash. You can restore it anytime."); } catch (error) { toast(friendlyError(error), true); } }
async function restoreExpense(id) { try { await updateDoc(doc(expenseRef(), id), { deleted: false, deletedAt: null, updatedAt: serverTimestamp() }); toast("Expense restored."); } catch (error) { toast(friendlyError(error), true); } }
async function permanentlyDelete(id) { const item = state.expenses.find((expense) => expense.id === id); if (!item || !window.confirm(`Permanently delete “${item.itemName}”? This cannot be undone.`)) return; try { await deleteDoc(doc(expenseRef(), id)); toast("Expense permanently deleted."); } catch (error) { toast(friendlyError(error), true); } }

function renderTrash() { const deleted = state.expenses.filter((item) => item.deleted); elements.trash.innerHTML = deleted.length ? deleted.map((item) => expenseRow(item, "trash")).join("") : '<div class="empty-state"><strong>Trash is empty</strong><span>Deleted expenses will appear here until permanently removed.</span></div>'; }
function renderHistory() { const months = [...new Set(activeExpenses().filter((item) => item.archived && item.archiveMonth).map((item) => item.archiveMonth))].sort().reverse(); elements.archiveMonths.innerHTML = months.length ? months.map((month) => { const expenses = activeExpenses().filter((item) => item.archived && item.archiveMonth === month); const total = expenses.reduce((sum, item) => sum + Number(item.amount), 0); return `<button class="archive-month-card ${state.selectedArchive === month ? "is-selected" : ""}" type="button" data-month="${month}"><span class="archive-month-icon">▣</span><span><strong>${monthLabel(month)}</strong><small>${expenses.length} expenses · ${money(total)}</small></span><b>View →</b></button>`; }).join("") : '<div class="empty-state"><strong>No archived months yet</strong><span>Close a month from the dashboard to keep a permanent, read-only record here.</span></div>'; if (state.selectedArchive && months.includes(state.selectedArchive)) renderArchiveDetail(state.selectedArchive); else { state.selectedArchive = ""; elements.archiveDetail.classList.add("is-hidden"); } }
function renderArchiveDetail(month) {
  const expenses = activeExpenses().filter((item) => item.archived && item.archiveMonth === month).sort((a, b) => b.date.localeCompare(a.date)); const result = calculateBalances(expenses); const groups = Object.entries(expenses.reduce((all, item) => { (all[item.date] ||= []).push(item); return all; }, {}));
  elements.archiveDetail.classList.remove("is-hidden"); elements.archiveDetail.innerHTML = `<div class="archive-detail-head"><div><p class="eyebrow">READ-ONLY MONTH</p><h2>${monthLabel(month)}</h2></div><button id="closeArchiveDetail" class="text-button" type="button">Close detail</button></div><div class="archive-summary"><span>Monthly total <strong>${money(fromCents(result.totalCents))}</strong></span><span>Per person share <strong>${money(fromCents(result.totalCents) / ROOMMATES.length)}</strong></span><span>Expenses <strong>${expenses.length}</strong></span></div><div class="history-settlement"><strong>Settlement</strong>${result.transfers.length ? result.transfers.map((item) => `<span>${item.from} → ${item.to} <b>${money(fromCents(item.value))}</b></span>`).join("") : '<span>Everyone is settled up.</span>'}</div><div class="daily-groups">${groups.map(([date, items]) => `<section class="daily-group"><div class="daily-head"><strong>${formattedDate(date)}</strong><span>${money(items.reduce((sum, item) => sum + Number(item.amount), 0))}</span></div>${items.map((item) => `<div class="readonly-row"><span>${escapeHTML(item.itemName)}</span><small>${escapeHTML(item.category)} · ${escapeHTML(item.paidBy)}</small><b>${money(item.amount)}</b></div>`).join("")}</section>`).join("")}</div>`;
}

function renderAnalytics() {
  const expenses = activeExpenses(); const current = dashboardExpenses(); const total = expenses.reduce((sum, item) => sum + Number(item.amount), 0); const highest = expenses.reduce((top, item) => !top || Number(item.amount) > Number(top.amount) ? item : top, null); const stats = [["Total expenses", money(total)], ["Average expense", money(expenses.length ? total / expenses.length : 0)], ["Expense count", expenses.length], ["Current month", money(current.reduce((sum, item) => sum + Number(item.amount), 0))], ["Per person share", money(current.reduce((sum, item) => sum + Number(item.amount), 0) / ROOMMATES.length)], ["Highest expense", highest ? `${escapeHTML(highest.itemName)} · ${money(highest.amount)}` : "—"]];
  elements.analyticsStats.innerHTML = stats.map(([label, value]) => `<article class="mini-stat"><span>${label}</span><strong>${value}</strong></article>`).join("");
  const categoryTotals = totalsBy(expenses, (item) => item.category || "Other"); renderTrend(expenses); renderCategoryChart(categoryTotals); renderPersonChart(totalsBy(expenses, (item) => item.paidBy)); renderTopCategories(categoryTotals);
}
function totalsBy(expenses, key) { return expenses.reduce((all, item) => { const name = key(item); all[name] = (all[name] || 0) + Number(item.amount); return all; }, {}); }
function renderTrend(expenses) { const totals = totalsBy(expenses, (item) => item.date.slice(0, 7)); const entries = Object.entries(totals).sort().slice(-6); if (!entries.length) { elements.trend.innerHTML = '<p class="chart-empty">Add expenses to see your monthly trend.</p>'; return; } const max = Math.max(...entries.map(([, value]) => value)); const points = entries.map(([, value], index) => `${index * (100 / Math.max(entries.length - 1, 1))},${90 - (value / max) * 70}`).join(" "); elements.trend.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Monthly expense trend"><polyline points="${points}" fill="none" stroke="#5746d6" stroke-width="3" vector-effect="non-scaling-stroke"/><line x1="0" y1="90" x2="100" y2="90" stroke="#e8eaf0" stroke-width="1" vector-effect="non-scaling-stroke"/></svg><div class="chart-labels">${entries.map(([month, value]) => `<span>${monthLabel(month).split(" ")[0]}<b>${money(value)}</b></span>`).join("")}</div>`; }
function renderCategoryChart(totals) { const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]); if (!entries.length) { elements.categoryChart.innerHTML = '<p class="chart-empty">No category data yet.</p>'; return; } const total = entries.reduce((sum, [, value]) => sum + value, 0); let position = 0; const slices = entries.map(([name, value]) => { const color = (CATEGORY_META[name] || CATEGORY_META.Other)[1]; const start = position; position += value / total * 100; return `${color} ${start}% ${position}%`; }).join(", "); elements.categoryChart.innerHTML = `<div class="pie-donut" style="background:conic-gradient(${slices})"><span>${money(total)}</span></div><div class="chart-legend">${entries.map(([name, value]) => `<span><i style="background:${(CATEGORY_META[name] || CATEGORY_META.Other)[1]}"></i>${escapeHTML(name)} <b>${Math.round(value / total * 100)}%</b></span>`).join("")}</div>`; }
function renderPersonChart(totals) { const max = Math.max(...ROOMMATES.map((name) => totals[name] || 0), 1); elements.personChart.innerHTML = ROOMMATES.map((name, index) => `<div class="bar-row"><span>${escapeHTML(name)}</span><div><i style="width:${(totals[name] || 0) / max * 100}%;background:${PEOPLE_META[index].color}"></i></div><b>${money(totals[name] || 0)}</b></div>`).join(""); }
function renderTopCategories(totals) { const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5); elements.topCategories.innerHTML = entries.length ? entries.map(([name, value], index) => `<div><span>${index + 1}</span><strong>${escapeHTML(name)}</strong><b>${money(value)}</b></div>`).join("") : '<p class="chart-empty">No spending data yet.</p>'; }

async function copyReport() { const expenses = filteredDashboardExpenses(); const result = calculateBalances(expenses); const lines = [`*${roomTitle()} Expense Report*`, `*Month:* ${monthLabel(currentMonth())}`, `*Total:* ${money(fromCents(result.totalCents))}`, `*Per person share:* ${money(fromCents(result.totalCents) / ROOMMATES.length)}`, "", "*Who paid*"]; ROOMMATES.forEach((name) => lines.push(`${name}: ${money(fromCents(result.paid[name]))}`)); lines.push("", "*Settlement*"); result.transfers.length ? result.transfers.forEach((item) => lines.push(`${item.from} → ${item.to} ${money(fromCents(item.value))}`)) : lines.push("Everyone is settled up."); const report = lines.join("\n"); try { await navigator.clipboard.writeText(report); toast("WhatsApp report copied."); } catch { const area = document.createElement("textarea"); area.value = report; document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); toast("WhatsApp report copied."); } }
function exportCSV() { const rows = filteredDashboardExpenses(); const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; const csv = [["Date", "Paid By", "Item Name", "Category", "Amount (INR)", "Note"], ...rows.map((item) => [item.date, item.paidBy, item.itemName, item.category, Number(item.amount).toFixed(2), item.note])].map((row) => row.map(quote).join(",")).join("\r\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `${state.roomCode}-${currentMonth()}-expenses.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); toast("CSV export downloaded."); }
function openArchiveModal() { const count = dashboardExpenses().length; if (!count) { toast("There are no current-month expenses to close.", true); return; } $("#archiveMonthLabel").textContent = monthLabel(currentMonth()); elements.archiveError.textContent = ""; setModal(elements.archiveModal, true); }
async function archiveExpenseBatch(expenses) {
  // Firestore batches are limited to 500 writes; 450 keeps room for future metadata writes.
  for (let start = 0; start < expenses.length; start += 450) {
    const batch = writeBatch(db);
    expenses.slice(start, start + 450).forEach((item) => batch.update(doc(expenseRef(), item.id), { archived: true, archiveMonth: currentMonth(), updatedAt: serverTimestamp() }));
    await batch.commit();
  }
}
async function closeCurrentMonth() { const expenses = dashboardExpenses(); if (!expenses.length) return; const button = $("#confirmArchive"); button.disabled = true; button.textContent = "Closing…"; try { await archiveExpenseBatch(expenses); setModal(elements.archiveModal, false); toast(`${monthLabel(currentMonth())} is safely archived.`); } catch (error) { elements.archiveError.textContent = friendlyError(error); } finally { button.disabled = false; button.textContent = "Close month"; } }

function normaliseExpense(snapshot) {
  const data = snapshot.data();
  return {
    ...data,
    id:           data.id || snapshot.id,
    deleted:      Boolean(data.deleted),
    archived:     Boolean(data.archived),
    archiveMonth: data.archiveMonth || null,
    note:         data.note || "",
    imageUrl:     data.imageUrl || null,  // pass through download URL for display
  };
}
function startListener() { state.unsubscribe?.(); if (!isConfigured) { setStatus("Firebase setup required", "error"); return; } setStatus(navigator.onLine ? "Connecting" : "Offline", navigator.onLine ? "loading" : "error"); state.unsubscribe = onSnapshot(query(expenseRef(), orderBy("date", "desc")), (snapshot) => { state.expenses = snapshot.docs.map(normaliseExpense); setStatus("Live updates on"); renderDashboard(); renderHistory(); renderAnalytics(); renderTrash(); }, (error) => { console.error(error); setStatus("Connection error", "error"); toast(friendlyError(error), true); }); }
/**
 * Enter the shared room with the given authenticated user.
 * The room code is always the same constant — one shared Firestore collection.
 */
function enterRoom(userName) {
  state.roomCode    = HARDCODED_ROOM_CODE;
  state.currentUser = userName;
  state.userCode    = USER_CODES[userName] || "";
  elements.joinScreen.classList.add("is-hidden");
  elements.app.classList.remove("is-hidden");
  elements.roomName.textContent    = roomTitle();
  elements.footerRoom.textContent  = `Shared in ${roomTitle()}`;
  setPage("dashboard");
  startListener();
}

/**
 * Log out: wipe auth keys from localStorage and return to the login screen.
 */
function logout() {
  state.unsubscribe?.();
  state.unsubscribe  = null;
  state.expenses     = [];
  state.roomCode     = "";
  state.currentUser  = "";
  state.userCode     = "";
  state.selectedArchive = "";
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(CODE_VERIFIED_KEY);
  elements.app.classList.add("is-hidden");
  elements.joinScreen.classList.remove("is-hidden");
  // Reset form
  elements.ownerName.value = "";
  $("#accessCodeInput").value = "";
  elements.joinError.textContent = "";
  elements.ownerName.focus();
}

/**
 * Handle the login form submission.
 * Validates the selected name against the expected access code.
 */
function login(event) {
  event.preventDefault();
  const name = elements.ownerName.value;
  const code = $("#accessCodeInput").value.trim();
  if (!isConfigured) {
    elements.joinError.textContent = "Firebase is not configured yet. Add the values in firebase.js.";
    return;
  }
  if (!name) {
    elements.joinError.textContent = "Please select your name.";
    return;
  }
  if (!code) {
    elements.joinError.textContent = "Please enter your access code.";
    return;
  }
  // Validate: the code entered must match this user's private code
  if (USER_CODES[name] !== code) {
    elements.joinError.textContent = "Invalid Access Code.";
    $("#accessCodeInput").value = "";
    $("#accessCodeInput").focus();
    return;
  }
  elements.joinError.textContent = "";
  // Persist session so the user is auto-logged in on next visit
  localStorage.setItem(USER_STORAGE_KEY, name);
  localStorage.setItem(CODE_VERIFIED_KEY, "true");
  enterRoom(name);
}

function bindEvents() {
  // Login form now calls login() instead of the old joinRoom()
  elements.joinForm.addEventListener("submit", login);
  [$("#addExpenseTop"), $("#addExpenseHero")].forEach((button) => button.addEventListener("click", () => openExpense()));
  // Logout button now calls logout() instead of leaveRoom()
  $("#logoutButton").addEventListener("click", logout);
  $("#expenseForm").addEventListener("submit", saveExpense);
  $("#copyReport").addEventListener("click", copyReport);
  $("#exportCsv").addEventListener("click", exportCSV);
  $("#closeMonth").addEventListener("click", openArchiveModal);
  $("#confirmArchive").addEventListener("click", closeCurrentMonth);
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  document.querySelector("[data-page-link]").addEventListener("click", () => setPage("dashboard"));
  [elements.search, elements.category, elements.from, elements.to].forEach((input) => input.addEventListener("input", renderDashboard));
  $("#clearFilters").addEventListener("click", () => { elements.search.value = ""; elements.category.value = ""; elements.from.value = ""; elements.to.value = ""; renderDashboard(); });
  elements.list.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    // Ignore clicks on ownership-locked buttons
    if (!btn || btn.classList.contains("btn-disabled")) return;
    const action = btn.dataset.action;
    const id = event.target.closest(".expense-row")?.dataset.id;
    if (!action || !id) return;
    const item = state.expenses.find((expense) => expense.id === id);
    if (action === "edit") openExpense(item);
    if (action === "soft-delete") softDelete(id);
  });
  elements.trash.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    // Ignore clicks on ownership-locked buttons
    if (!btn || btn.classList.contains("btn-disabled")) return;
    const action = btn.dataset.action;
    const id = event.target.closest(".expense-row")?.dataset.id;
    if (action === "restore") restoreExpense(id);
    if (action === "permanent") permanentlyDelete(id);
  });
  elements.archiveMonths.addEventListener("click", (event) => { const month = event.target.closest("[data-month]")?.dataset.month; if (month) { state.selectedArchive = month; renderHistory(); elements.archiveDetail.scrollIntoView({ behavior: "smooth", block: "start" }); } }); elements.archiveDetail.addEventListener("click", (event) => { if (event.target.closest("#closeArchiveDetail")) { state.selectedArchive = ""; renderHistory(); } });

  // ── Image viewer: open modal when clicking a receipt thumbnail ─────────────
  function openImageModal(url) {
    elements.previewImage.src = url;
    elements.previewImage.alt = "Expense receipt preview";
    setModal(elements.imageModal, true);
  }
  function closeImageModal() {
    setModal(elements.imageModal, false);
    // Delay src clear so the close animation completes
    setTimeout(() => { elements.previewImage.src = ""; }, 250);
  }
  // Delegate thumbnail clicks from both expense list and trash list
  [elements.list, elements.trash].forEach((container) => {
    container.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action='view-image']");
      if (!btn) return;
      const id   = btn.closest(".expense-row")?.dataset.id;
      const item = id ? state.expenses.find((e) => e.id === id) : null;
      if (item?.imageUrl) openImageModal(item.imageUrl);
    });
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-modal]"))  setModal(elements.expenseModal, false);
    if (event.target.closest("[data-close-archive]")) setModal(elements.archiveModal, false);
    if (event.target.closest("[data-close-image]"))  closeImageModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setModal(elements.expenseModal, false);
      setModal(elements.archiveModal, false);
      closeImageModal();
    }
  });

  // ── File input: show selected filename and validate size ───────────────────
  elements.imageInput.addEventListener("change", () => {
    const file = elements.imageInput.files?.[0];
    if (!file) { elements.imageHint.textContent = "No image selected"; elements.imageHint.className = "image-hint"; return; }
    if (file.size > MAX_IMAGE_BYTES) {
      elements.imageHint.textContent = "File too large (max 5 MB)";
      elements.imageHint.className = "image-hint image-hint--error";
      elements.imageInput.value = "";
      return;
    }
    elements.imageHint.textContent = `✅ ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
    elements.imageHint.className = "image-hint image-hint--ok";
  });

  window.addEventListener("offline", () => setStatus("Offline", "error"));
  window.addEventListener("online", () => { if (state.roomCode) startListener(); });
  window.addEventListener("beforeunload", () => state.unsubscribe?.());
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
bindEvents();
clearExpenseForm();
elements.dashboardMonth.textContent = monthLabel(currentMonth());
initialiseTheme();

// Auto-login: if a verified session exists in localStorage, skip the login screen.
const savedUser     = localStorage.getItem(USER_STORAGE_KEY);
const codeVerified  = localStorage.getItem(CODE_VERIFIED_KEY);
if (savedUser && codeVerified === "true" && USER_CODES[savedUser]) {
  enterRoom(savedUser);
} else {
  // No valid session — show the login screen
  elements.ownerName.focus();
}
