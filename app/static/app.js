"use strict";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAIN_SCREENS = ["home", "progress", "account"];
const GOAL_DEFAULT = 2000;
const GOAL_MIN = 800;
const GOAL_MAX = 6000;
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  user: null,
  day: localDate(),
  goal: GOAL_DEFAULT,
  screen: "home",
  mainScreen: "home",
  range: 7,
  file: null,
  previewUrl: null,
  currentMeal: null,
  lastTotals: null,
};

const $ = (selector) => document.querySelector(selector);

/* ── Icons (constant markup only, never built from data) ── */

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chart: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>',
  protein: '<circle cx="15" cy="9" r="5"/><path d="m11.5 12.5-6 6"/><circle cx="5" cy="19" r="1.4"/>',
  carbs: '<path d="M12 21V5"/><path d="M12 10c-2.8 0-4.2-1.6-4.2-3.8 2.8 0 4.2 1.6 4.2 3.8zM12 10c2.8 0 4.2-1.6 4.2-3.8-2.8 0-4.2 1.6-4.2 3.8zM12 16c-2.8 0-4.2-1.6-4.2-3.8 2.8 0 4.2 1.6 4.2 3.8zM12 16c2.8 0 4.2-1.6 4.2-3.8-2.8 0-4.2 1.6-4.2 3.8z"/>',
  fat: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-14 0 9-5 15-13 15M5 19c3-4 6-7 9-9"/>',
  logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
};

function icon(name, size = 22) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll("[data-icon]")) {
    node.replaceChildren(icon(node.dataset.icon, Number(node.dataset.size) || 22));
  }
}

/* ── Helpers ── */

/** Build an element. Children are inserted as text nodes, so model output is never parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseLocal(day) {
  return new Date(`${day}T00:00:00`);
}

function shiftDate(day, offset) {
  const date = parseLocal(day);
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  // Required by the server's CSRF check on every write. Browsers only send it same-origin.
  if (method !== "GET") headers["X-Requested-With"] = "NutriLens";

  const response = await fetch(path, { ...options, method, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      showAuth("Your session has ended. Please sign in again.");
    }
    let message = `Request failed (${response.status})`;
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail) && body.detail[0]?.msg) message = body.detail[0].msg;
    throw new Error(message);
  }
  return body;
}

function setStatus(selector, message, kind = "") {
  const node = $(selector);
  node.textContent = message;
  node.className = `status ${kind}`.trim();
}

/* ── Daily goal (kept on this device) ── */

function goalKey() {
  return `nutrilens.goal.${state.user.id}`;
}

function loadGoal() {
  try {
    const value = Number(localStorage.getItem(goalKey()));
    return value >= GOAL_MIN && value <= GOAL_MAX ? value : GOAL_DEFAULT;
  } catch {
    return GOAL_DEFAULT;
  }
}

function saveGoal(value) {
  try {
    localStorage.setItem(goalKey(), String(value));
  } catch {
    /* storage unavailable: the goal lasts for this session only */
  }
}

function macroGoals(kcal) {
  return {
    protein: Math.round((kcal * 0.3) / 4),
    carbs: Math.round((kcal * 0.4) / 4),
    fat: Math.round((kcal * 0.3) / 9),
  };
}

/* ── Navigation ── */

function go(screen) {
  state.screen = screen;
  if (MAIN_SCREENS.includes(screen)) state.mainScreen = screen;
  for (const section of document.querySelectorAll(".screen")) {
    section.hidden = section.id !== `screen-${screen}`;
  }
  $("#app").dataset.screen = screen;
  for (const button of document.querySelectorAll("[data-nav]")) {
    const active = button.dataset.nav === screen;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (screen === "home") loadHome();
  else if (screen === "progress") loadProgress();
  else if (screen === "account") renderAccount();
}

/** Add and detail screens sit on top of the history stack so the phone's back button closes them. */
function openOverlay(screen) {
  history.pushState({ overlay: screen }, "");
  go(screen);
}

function closeOverlay() {
  if (history.state && history.state.overlay) history.back();
  else go(state.mainScreen);
}

window.addEventListener("popstate", () => {
  if (!MAIN_SCREENS.includes(state.screen)) go(state.mainScreen);
});

/* ── Accounts ── */

let authMode = "login";

const AUTH_COPY = {
  login: {
    title: "Welcome back",
    sub: "Sign in to continue",
    submit: "Sign in",
    switchText: "Don't have an account?",
    switchLabel: "Sign up",
    hint: "",
    autocomplete: "current-password",
  },
  signup: {
    title: "Create account",
    sub: "Start tracking your meals",
    submit: "Create account",
    switchText: "Already have an account?",
    switchLabel: "Sign in",
    hint: "Use at least 10 characters.",
    autocomplete: "new-password",
  },
};

function setAuthMode(mode) {
  authMode = mode;
  const copy = AUTH_COPY[mode];
  $("#auth-title").textContent = copy.title;
  $("#auth-sub").textContent = copy.sub;
  $("#auth-submit").textContent = copy.submit;
  $("#auth-switch-text").textContent = copy.switchText;
  $("#auth-switch").textContent = copy.switchLabel;
  $("#auth-hint").textContent = copy.hint;
  $("#auth-password").autocomplete = copy.autocomplete;
  setStatus("#auth-status", "");
}

function togglePassword() {
  const input = $("#auth-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  const button = $("#toggle-password");
  button.replaceChildren(icon(show ? "eye-off" : "eye"));
  button.setAttribute("aria-label", show ? "Hide password" : "Show password");
}

function showAuth(message = "") {
  state.user = null;
  state.lastTotals = null;
  $("#app").hidden = true;
  $("#auth-screen").hidden = false;
  $("#auth-password").value = "";
  setStatus("#auth-status", message, message ? "error" : "");
}

function showApp(user) {
  state.user = user;
  state.goal = loadGoal();
  state.day = localDate();
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
  const initial = user.email.charAt(0);
  $("#avatar").textContent = initial;
  $("#account-avatar").textContent = initial;
  go("home");
  checkHealth();
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const button = $("#auth-submit");
  button.disabled = true;
  setStatus("#auth-status", authMode === "login" ? "Signing in…" : "Creating your account…");
  try {
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const user = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    $("#auth-password").value = "";
    showApp(user);
  } catch (error) {
    setStatus("#auth-status", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function onLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    showAuth("You have signed out.");
  }
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    state.analysisReady = health.groq_configured;
    if (!health.groq_configured) {
      setStatus("#analyze-status", "Add GROQ_API_KEY to the .env file and restart the server before analyzing.", "error");
    }
  } catch {
    setStatus("#analyze-status", "Cannot reach the NutriLens server.", "error");
  }
}

/* ── Home ── */

function renderWeek() {
  const today = localDate();
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
  $("#week").replaceChildren(
    ...days.map((day) => {
      const date = parseLocal(day);
      const selected = day === state.day;
      return el("button", {
        type: "button",
        class: `day${selected ? " selected" : ""}`,
        "aria-pressed": String(selected),
        "aria-label": date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
        onclick: () => {
          state.day = day;
          renderWeek();
          loadHome();
        },
      },
        el("span", { class: "dow", text: date.toLocaleDateString([], { weekday: "short" }) }),
        el("span", { class: "dom", text: String(date.getDate()) }),
      );
    }),
  );
}

async function loadHome() {
  renderWeek();
  const day = state.day;
  // Show the last known totals straight away, recalculated with the current goal,
  // so a changed goal never flashes the old numbers while fresh data loads.
  if (state.lastTotals && state.lastTotals.day === day) {
    renderHero(state.lastTotals.totals);
    renderMacros(state.lastTotals.totals);
  }
  try {
    const [summary, meals] = await Promise.all([
      api(`/api/summary?date=${day}&days=7`),
      api(`/api/meals?date=${day}`),
    ]);
    if (day !== state.day) return;
    state.lastTotals = { day, totals: summary.today };
    renderHero(summary.today);
    renderMacros(summary.today);
    renderMeals(meals, day);
  } catch (error) {
    $("#meal-list").replaceChildren(el("div", { class: "empty" }, error.message));
  }
}

function renderHero(totals) {
  const left = state.goal - totals.calories;
  $("#left-value").textContent = String(Math.abs(Math.round(left)));
  $("#left-label").textContent = left < 0 ? "Kcal over your goal" : "Kcal left";
  $("#goal-bar").style.width = `${Math.min(100, (totals.calories / state.goal) * 100)}%`;
  $("#eaten").textContent = `${totals.calories} eaten`;
  $("#goal-text").textContent = `Goal ${state.goal}`;
}

function ring(fraction, color, iconName, size = 76, stroke = 7) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    `<circle class="track" cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke-width="${stroke}"/>` +
    `<circle class="bar" cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke="${color}" stroke-dasharray="${circumference}" ` +
    `stroke-dashoffset="${circumference * (1 - Math.max(0, Math.min(1, fraction)))}"/>`;
  const iconBox = el("span", { class: "ring-icon", style: `color:${color}` }, icon(iconName, 20));
  return el("div", { class: "ring" }, svg, iconBox);
}

function renderMacros(totals) {
  const goals = macroGoals(state.goal);
  const cards = [
    { key: "protein", label: "Protein", color: "var(--protein)" },
    { key: "carbs", label: "Carbs", color: "var(--carbs)" },
    { key: "fat", label: "Fat", color: "var(--fat)" },
  ];
  $("#macro-row").replaceChildren(
    ...cards.map(({ key, label, color }) => {
      const eaten = totals[key];
      const left = Math.max(0, Math.round(goals[key] - eaten));
      return el("div", { class: "macro-card" },
        el("strong", { text: `${left}g` }),
        el("span", { class: "name", text: `${label} left` }),
        ring(eaten / goals[key], color, key),
      );
    }),
  );
}

function macroChip(kind, grams) {
  return el("span", { class: `macro-chip ${kind}` }, icon(kind, 15), `${grams}g`);
}

function mealCard(meal) {
  const { totals } = meal;
  return el("button", { type: "button", class: "meal-card", onclick: () => openDetail(meal) },
    el("img", { src: meal.thumbnail_url, alt: "", loading: "lazy" }),
    el("div", { class: "meal-body" },
      el("div", { class: "meal-title" },
        el("strong", { text: meal.meal_name }),
        el("span", { class: "time-pill", text: formatTime(meal.created_at) }),
      ),
      el("div", { class: "meal-kcal" }, icon("flame", 18), el("span", { text: `${totals.calories} calories` })),
      el("div", { class: "meal-macros" },
        macroChip("protein", totals.protein),
        macroChip("carbs", totals.carbs),
        macroChip("fat", totals.fat),
      ),
    ),
  );
}

function renderMeals(meals, day) {
  const list = $("#meal-list");
  if (meals.length === 0) {
    const isToday = day === localDate();
    list.replaceChildren(
      el("div", { class: "empty" },
        el("strong", { text: isToday ? "Nothing logged yet" : "No meals on this day" }),
        isToday ? "Tap + to snap your first meal." : "Pick another day or tap + to add one.",
      ),
    );
    return;
  }
  list.replaceChildren(...meals.map(mealCard));
}

/* ── Meal detail ── */

function openDetail(meal) {
  state.currentMeal = meal;
  renderDetail(meal);
  openOverlay("detail");
}

function foodRow(food) {
  return el("div", { class: "food" },
    el("span", { class: "food-emoji", "aria-hidden": "true", text: food.emoji }),
    el("div", {},
      el("div", { class: "food-name", text: food.name }),
      el("div", { class: "food-portion", text: food.portion }),
      el("div", { class: "food-macros" },
        macroChip("protein", food.protein),
        macroChip("carbs", food.carbs),
        macroChip("fat", food.fat),
      ),
    ),
    el("div", { class: "food-kcal" }, String(food.calories), " ", el("small", { text: "kcal" })),
  );
}

function macroBar(kind, label, grams, percent) {
  return el("div", { class: `macro-bar ${kind}`, style: `--h:${Math.max(6, Math.round(percent))}%` },
    el("span", { class: "mb-name", text: label }),
    el("div", {},
      el("span", { class: "mb-val", text: `${grams}g` }),
      el("span", { class: "mb-pct", text: `${Math.round(percent)}% of kcal` }),
    ),
  );
}

function renderDetail(meal) {
  const { totals, macro_split: split, health } = meal;
  const { foods, micronutrients, notes } = meal.analysis;

  const sheet = [
    el("div", { class: "score-row" },
      el("div", { class: "score-ring", style: `--p:${health.score}%`, role: "img", "aria-label": `Balance score ${health.score} out of 100` },
        el("span", { text: String(health.score) })),
      el("div", { class: "score-text" },
        el("strong", { text: "Meal balance" }),
        el("span", { text: health.label }),
      ),
    ),
    el("h2", { text: "Macros" }),
    el("div", { class: "macro-bars" },
      macroBar("protein", "Protein", totals.protein, split.protein_pct),
      macroBar("carbs", "Carbs", totals.carbs, split.carbs_pct),
      macroBar("fat", "Fat", totals.fat, split.fat_pct),
    ),
    el("h2", { text: `Detected items (${foods.length})` }),
    foods.map(foodRow),
    micronutrients.length
      ? [
          el("h2", { text: "Key micronutrients" }),
          el("div", { class: "chips" },
            micronutrients.map((m) => el("span", { class: "chip", text: m.amount ? `${m.name}: ${m.amount}` : m.name }))),
        ]
      : null,
    notes ? el("div", { class: "tip" }, el("strong", { text: "Tip: " }), notes) : null,
    el("button", { type: "button", class: "delete-btn", onclick: () => deleteMeal(meal) }, icon("trash", 18), "Delete meal"),
  ];

  $("#detail").replaceChildren(
    el("div", { class: "detail-hero" },
      el("img", { class: "detail-photo", src: meal.thumbnail_url, alt: "Meal photo" }),
      el("div", { class: "detail-shade" }),
      el("div", { class: "detail-bar" },
        el("button", { type: "button", class: "icon-btn round glass", "aria-label": "Back", onclick: closeOverlay }, icon("back")),
        el("span", { class: "detail-bar-title", text: "Nutrition" }),
        el("span", { class: "spacer" }),
      ),
      el("div", { class: "detail-title" },
        el("span", { class: "tag-pill", text: `${capitalize(meal.portion)} portion · ${formatTime(meal.created_at)}` }),
        el("div", { class: "detail-title-row" },
          el("h1", { text: meal.meal_name }),
          el("div", { class: "detail-kcal" }, el("strong", { text: String(totals.calories) }), el("span", { text: "kcal" })),
        ),
      ),
    ),
    el("div", { class: "detail-sheet" }, sheet.flat().filter(Boolean)),
  );
}

async function deleteMeal(meal) {
  if (!window.confirm(`Delete "${meal.meal_name}" from your log?`)) return;
  try {
    await api(`/api/meals/${meal.id}`, { method: "DELETE" });
    state.lastTotals = null;
    closeOverlay();
  } catch (error) {
    window.alert(error.message);
  }
}

/* ── Add meal ── */

function resetAddForm() {
  state.file = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  $("#analyze-form").reset();
  $("#preview").hidden = true;
  $("#drop-empty").hidden = false;
  $("#analyze-btn").disabled = true;
  if (state.analysisReady !== false) setStatus("#analyze-status", "");
}

function openAdd() {
  resetAddForm();
  openOverlay("add");
}

function selectFile(file) {
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    setStatus("#analyze-status", "Please choose a JPEG, PNG or WEBP image.", "error");
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus("#analyze-status", "That image is larger than 10 MB.", "error");
    return;
  }
  state.file = file;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  const preview = $("#preview");
  preview.src = state.previewUrl;
  preview.hidden = false;
  $("#drop-empty").hidden = true;
  $("#analyze-btn").disabled = state.analysisReady === false;
  setStatus("#analyze-status", "");
}

async function onAnalyze(event) {
  event.preventDefault();
  if (!state.file) return;

  const body = new FormData(event.currentTarget);
  body.set("file", state.file);
  body.set("meal_date", state.day);

  $("#analyze-btn").disabled = true;
  $("#loading").hidden = false;
  setStatus("#analyze-status", "");
  try {
    const meal = await api("/api/meals/analyze", { method: "POST", body });
    state.lastTotals = null;
    state.currentMeal = meal;
    renderDetail(meal);
    // Replace the add screen in history so Back returns to the main screen, not to the form.
    history.replaceState({ overlay: "detail" }, "");
    go("detail");
  } catch (error) {
    setStatus("#analyze-status", error.message, "error");
    $("#analyze-btn").disabled = false;
  } finally {
    $("#loading").hidden = true;
  }
}

/* ── Progress ── */

function renderRange() {
  $("#range").replaceChildren(
    ...[7, 14, 30].map((days) =>
      el("button", {
        type: "button",
        class: `pill${state.range === days ? " active" : ""}`,
        "aria-pressed": String(state.range === days),
        onclick: () => {
          state.range = days;
          loadProgress();
        },
      }, `${days} days`),
    ),
  );
}

async function loadProgress() {
  renderRange();
  try {
    const summary = await api(`/api/summary?date=${localDate()}&days=${state.range}`);
    renderProgress(summary.series);
  } catch (error) {
    $("#chart").replaceChildren(el("p", { class: "chart-empty", text: error.message }));
  }
}

function statTile(value, label) {
  return el("div", { class: "stat" }, el("strong", { text: value }), el("span", { text: label }));
}

function renderProgress(series) {
  const logged = series.filter((day) => day.calories > 0);
  const total = logged.reduce((sum, day) => sum + day.calories, 0);
  const meals = series.reduce((sum, day) => sum + day.meals, 0);
  $("#progress-stats").replaceChildren(
    statTile(logged.length ? String(Math.round(total / logged.length)) : "0", "Avg kcal / day"),
    statTile(`${logged.length}/${series.length}`, "Days logged"),
    statTile(String(meals), "Meals"),
  );

  const chart = $("#chart");
  if (logged.length === 0) {
    chart.replaceChildren(el("p", { class: "chart-empty", text: `No meals logged in the last ${series.length} days.` }));
    return;
  }
  const max = Math.max(state.goal, ...series.map((day) => day.calories)) * 1.1;
  const labelEvery = Math.ceil(series.length / 7);
  const columns = series.map((day, index) => {
    const date = parseLocal(day.date);
    const label = series.length <= 7
      ? date.toLocaleDateString([], { weekday: "short" })
      : index % labelEvery === 0 ? String(date.getDate()) : "";
    const classes = ["col", day.calories === 0 ? "empty-day" : "", day.calories > state.goal ? "over" : ""];
    return el("div", { class: classes.filter(Boolean).join(" "), title: `${day.date}: ${day.calories} kcal` },
      el("div", { class: "bar", style: `height:${(day.calories / max) * 100}%` }),
      el("span", { class: "label", text: label }),
    );
  });
  const goalLine = el("div", { class: "goal-line", style: `bottom:calc(22px + (100% - 22px) * ${state.goal / max})` },
    el("span", { text: `Goal ${state.goal}` }));
  chart.replaceChildren(...columns, goalLine);
}

/* ── Account ── */

function renderAccount() {
  $("#account-email").textContent = state.user.email;
  $("#goal-input").value = String(state.goal);
  setStatus("#goal-status", "");
}

function onGoalSubmit(event) {
  event.preventDefault();
  const value = Math.round(Number($("#goal-input").value));
  if (!Number.isFinite(value) || value < GOAL_MIN || value > GOAL_MAX) {
    setStatus("#goal-status", `Enter a goal between ${GOAL_MIN} and ${GOAL_MAX} kcal.`, "error");
    return;
  }
  state.goal = value;
  saveGoal(value);
  setStatus("#goal-status", "Goal saved.", "ok");
}

/* ── Wiring ── */

async function bootstrap() {
  try {
    showApp(await api("/api/auth/me"));
  } catch {
    showAuth();
  }
}

function init() {
  hydrateIcons();

  $("#auth-form").addEventListener("submit", onAuthSubmit);
  $("#auth-switch").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
  $("#toggle-password").addEventListener("click", togglePassword);
  $("#logout").addEventListener("click", onLogout);

  for (const button of document.querySelectorAll("[data-nav]")) {
    button.addEventListener("click", () => go(button.dataset.nav));
  }
  $("#fab").addEventListener("click", openAdd);
  $("#avatar").addEventListener("click", () => go("account"));
  $("#add-back").addEventListener("click", closeOverlay);

  const dropzone = $("#dropzone");
  const fileInput = $("#file");
  fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    selectFile(event.dataTransfer.files[0]);
  });
  $("#analyze-form").addEventListener("submit", onAnalyze);
  $("#goal-form").addEventListener("submit", onGoalSubmit);

  setAuthMode("login");
  bootstrap();
}

init();
