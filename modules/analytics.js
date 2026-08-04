/**
 * Analytics module — renders the full analytics page (stats + four charts).
 * All data comes from state.expenses via the same selectors used by the dashboard,
 * ensuring totals are always identical across both pages.
 */

import { el }      from "./ui.js";
import { ROOMMATES, PEOPLE_META, CATEGORY_META } from "./constants.js";
import { money, monthLabel, escapeHTML, totalsBy } from "./utils.js";
import { activeExpenses, currentMonthExpenses } from "./dashboard.js";

// ── Analytics page renderer ────────────────────────────────────────────────────

/**
 * Renders the full analytics page from state.expenses.
 * Called after every Firestore update and when the Analytics page is activated.
 */
export function renderAnalytics() {
  const expenses = activeExpenses();
  const current  = currentMonthExpenses();

  // Compute total and highest in a single pass to avoid two separate .reduce() calls.
  let total   = 0;
  let highest = null;
  for (const e of expenses) {
    const amt = Number(e.amount);
    total += amt;
    if (!highest || amt > Number(highest.amount)) highest = e;
  }

  const monthTotal = current.reduce((s, e) => s + Number(e.amount), 0);

  el.analyticsStats.innerHTML = [
    ["Total expenses",   money(total)],
    ["Average expense",  money(expenses.length ? total / expenses.length : 0)],
    ["Expense count",    expenses.length],
    ["Current month",    money(monthTotal)],
    ["Per person share", money(monthTotal / ROOMMATES.length)],
    ["Highest expense",  highest ? `${escapeHTML(highest.itemName)} · ${money(highest.amount)}` : "—"],
  ].map(([label, value]) =>
    `<article class="mini-stat"><span>${label}</span><strong>${value}</strong></article>`
  ).join("");

  const byCategory = totalsBy(expenses, (e) => e.category || "Other");
  renderTrend(expenses);
  renderCategoryChart(byCategory);
  renderPersonChart(totalsBy(expenses, (e) => e.paidBy));
  renderTopCategories(byCategory);
}

// ── Chart sub-renderers (private) ──────────────────────────────────────────────

function renderTrend(expenses) {
  const totals  = totalsBy(expenses, (e) => (e.date ?? "").slice(0, 7));
  const entries = Object.entries(totals).sort().slice(-6);

  if (!entries.length) {
    el.trendChart.innerHTML = '<p class="chart-empty">Add expenses to see your monthly trend.</p>';
    return;
  }

  const max    = Math.max(...entries.map(([, v]) => v));
  const points = entries
    .map(([, v], i) => `${i * (100 / Math.max(entries.length - 1, 1))},${90 - (v / max) * 70}`)
    .join(" ");

  // Colours use CSS custom properties so they stay correct in the dark theme.
  el.trendChart.innerHTML = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Monthly expense trend">
      <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <line x1="0" y1="90" x2="100" y2="90" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="chart-labels">
      ${entries.map(([m, v]) => `<span>${monthLabel(m).split(" ")[0]}<b>${money(v)}</b></span>`).join("")}
    </div>`;
}

function renderCategoryChart(totals) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    el.categoryChart.innerHTML = '<p class="chart-empty">No category data yet.</p>';
    return;
  }

  const total = entries.reduce((s, [, v]) => s + v, 0);
  let pos = 0;
  const slices = entries.map(([name, value]) => {
    const color = (CATEGORY_META[name] ?? CATEGORY_META.Other)[1];
    const start = pos;
    pos += (value / total) * 100;
    return `${color} ${start}% ${pos}%`;
  }).join(", ");

  el.categoryChart.innerHTML = `
    <div class="pie-donut" style="background:conic-gradient(${slices})"><span>${money(total)}</span></div>
    <div class="chart-legend">
      ${entries.map(([name, value]) => {
        const color = (CATEGORY_META[name] ?? CATEGORY_META.Other)[1];
        return `<span><i style="background:${color}"></i>${escapeHTML(name)} <b>${Math.round((value / total) * 100)}%</b></span>`;
      }).join("")}
    </div>`;
}

function renderPersonChart(totals) {
  const max = Math.max(...ROOMMATES.map((n) => totals[n] || 0), 1);
  el.personChart.innerHTML = ROOMMATES.map((name, i) =>
    `<div class="bar-row">
      <span>${escapeHTML(name)}</span>
      <div><i style="width:${((totals[name] || 0) / max) * 100}%;background:${PEOPLE_META[i].color}"></i></div>
      <b>${money(totals[name] || 0)}</b>
    </div>`
  ).join("");
}

function renderTopCategories(totals) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  el.topCategories.innerHTML = entries.length
    ? entries.map(([name, value], i) =>
        `<div><span>${i + 1}</span><strong>${escapeHTML(name)}</strong><b>${money(value)}</b></div>`
      ).join("")
    : '<p class="chart-empty">No spending data yet.</p>';
}
