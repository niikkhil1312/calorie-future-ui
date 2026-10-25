"use strict";

/* Tell Me Calories — frontend.
   Plain JavaScript, no build step. All text from the server or the AI model is inserted with
   textContent (via el()), never as HTML. Icons are constant markup from icons.js (Lucide, ISC). */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CSRF_VALUE = "TellMeCalories";
const GOAL = { min: 800, max: 6000, def: 2000, step: 50, presets: [1500, 1800, 2000, 2200, 2500] };
const MAIN_SCREENS = ["home", "progress", "history", "profile"];
const SVG_NS = "http://www.w3.org/2000/svg";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

const MEAL_TYPES = [
  { key: "breakfast", label: "Breakfast", plural: "Breakfast", icon: "sunrise" },
  { key: "lunch", label: "Lunch", plural: "Lunch", icon: "sun" },
  { key: "dinner", label: "Dinner", plural: "Dinner", icon: "moon" },
  { key: "snack", label: "Snack", plural: "Snacks", icon: "cookie" },
];
const MACROS = [
  { key: "protein", label: "Protein", icon: "drumstick", color: "var(--protein)" },
  { key: "carbs", label: "Carbs", icon: "wheat", color: "var(--carbs)" },
  { key: "fat", label: "Fat", icon: "droplet", color: "var(--fat)" },
];
const SCAN_STEPS = ["Spotting foods…", "Estimating portions…", "Counting calories…", "Balancing macros…"];

const state = {
  user: null,
  day: localDate(),
  goal: GOAL.def,
  screen: "home",
  mainScreen: "home",
  homeTab: "meals",
  series: null, // the 7-day window around the selected day
  meals: [],
  range: 7,
  file: null,
  previewUrl: null,
  mealType: "lunch",
  goalDraft: GOAL.def,
  analysisReady: undefined, // is the Groq key configured on the server?
};

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const numberFormat = new Intl.NumberFormat();
const fmt = (n) => numberFormat.format(Math.round(n));
const fmt1 = (n) => numberFormat.format(Math.round(n * 10) / 10);

/* ───────── Small helpers ───────── */

function icon(name, size = 22) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = (window.ICONS && window.ICONS[name]) || "";
  return svg;
}

function hydrateIcons(root = document) {
  for (const node of $$("[data-icon]", root)) {
    node.replaceChildren(icon(node.dataset.icon, Number(node.dataset.size) || 22));
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(2)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const parseLocal = (day) => new Date(`${day}T00:00:00`);
function shiftDate(day, offset) {
  const date = parseLocal(day);
  date.setDate(date.getDate() + offset);
  return localDate(date);
}
function dayTitle(day) {
  const today = localDate();
  if (day === today) return "Today";
  if (day === shiftDate(today, -1)) return "Yesterday";
  return parseLocal(day).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const typeInfo = (key) => MEAL_TYPES.find((t) => t.key === key) || MEAL_TYPES[3];

function defaultMealType(hour = new Date().getHours()) {
  if (hour < 4) return "snack";
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 18) return "snack";
  if (hour < 22) return "dinner";
  return "snack";
}

/** Which meal group a logged meal belongs to: saved type, else a keyword in its name, else the time. */
function mealGroup(meal) {
  const saved = meal.analysis && meal.analysis.meal_type;
  if (saved) return saved;
  const name = meal.meal_name.toLowerCase();
  for (const type of MEAL_TYPES) if (name.includes(type.key)) return type.key;
  return defaultMealType(new Date(meal.created_at).getHours());
}

function animateNumber(node, to) {
  const from = Number(node.dataset.value || 0);
  node.dataset.value = String(to);
  if (reduceMotion || from === to) {
    node.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const duration = 600;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = fmt(from + (to - from) * eased);
    if (t < 1 && Number(node.dataset.value) === to) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let toastTimer;
function toast(message, kind = "info") {
  const node = $("#toast");
  node.replaceChildren(icon(kind === "error" ? "circle-alert" : "circle-check", 20), el("span", { text: message }));
  node.className = `toast ${kind}`;
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => { node.hidden = true; }, 250);
  }, 3200);
}

/** A bottom sheet that asks for confirmation. Resolves to true or false. */
function confirmSheet({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const close = (answer) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(answer);
    };
    const onKey = (event) => { if (event.key === "Escape") close(false); };
    const confirmButton = el("button", { type: "button", class: "btn primary danger-fill", onclick: () => close(true) }, confirmLabel);
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (event) => { if (event.target === backdrop) close(false); } },
      el("div", { class: "sheet", role: "alertdialog", "aria-modal": "true", "aria-label": title },
        el("h2", { text: title }),
        el("p", { class: "muted", text: message }),
        el("div", { class: "sheet-actions" },
          el("button", { type: "button", class: "btn outline", onclick: () => close(false) }, "Cancel"),
          confirmButton,
        ),
      ),
    );
    document.body.append(backdrop);
    document.addEventListener("keydown", onKey);
    confirmButton.focus();
  });
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  // Required by the server on every write. Browsers only send it from this site.
  if (method !== "GET") headers["X-Requested-With"] = CSRF_VALUE;

  let response;
  try {
    response = await fetch(path, { ...options, method, headers, credentials: "same-origin" });
  } catch {
    throw new Error("Can't reach Tell Me Calories. Check your connection and try again.");
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      showAuth("Your session ended. Please sign in again.");
    }
    let message = `Something went wrong (${response.status}).`;
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail) && body.detail[0]?.msg) message = body.detail[0].msg;
    throw new Error(message);
  }
  return body;
}

/* ───────── Daily goal (kept on this device) ───────── */

const goalKeys = () => [`tellmecalories.goal.${state.user.id}`, `nutrilens.goal.${state.user.id}`];

function loadGoal() {
  try {
    for (const key of goalKeys()) {
      const value = Number(localStorage.getItem(key));
      if (value >= GOAL.min && value <= GOAL.max) return value;
    }
  } catch { /* storage unavailable */ }
  return GOAL.def;
}

function saveGoal(value) {
  try { localStorage.setItem(goalKeys()[0], String(value)); } catch { /* the goal lasts for this visit only */ }
}

function macroGoals(kcal) {
  return {
    protein: Math.round((kcal * 0.3) / 4),
    carbs: Math.round((kcal * 0.4) / 4),
    fat: Math.round((kcal * 0.3) / 9),
  };
}

/* ───────── Navigation ───────── */

function go(screen) {
  state.screen = screen;
  if (MAIN_SCREENS.includes(screen)) state.mainScreen = screen;
  closeMenu();
  for (const section of $$(".screen")) section.hidden = section.id !== `screen-${screen}`;
  $("#app").dataset.screen = screen;
  for (const button of $$("[data-nav]")) {
    const active = button.dataset.nav === screen;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (screen !== "camera") stopCamera();
  const loaders = { home: loadHome, progress: loadProgress, history: loadHistory, profile: renderProfile, camera: startCamera };
  if (loaders[screen]) loaders[screen]();
}

/** The camera, add and detail screens sit on the history stack, so the phone's back button closes them. */
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

/* ───────── Accounts ───────── */

let authMode = "login";

function setFieldError(inputId, errorId, message) {
  const input = $(`#${inputId}`);
  input.closest(".input-row").classList.toggle("invalid", Boolean(message));
  input.setAttribute("aria-invalid", message ? "true" : "false");
  $(`#${errorId}`).textContent = message || "";
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login";
  $("#auth-title").textContent = login ? "Welcome back" : "Create your account";
  $("#auth-lede").textContent = login ? "Sign in to see today's meals." : "Takes a few seconds. No card needed.";
  $("#auth-submit").textContent = login ? "Sign in" : "Create account";
  $("#auth-switch-text").textContent = login ? "New here?" : "Already have an account?";
  $("#auth-switch").textContent = login ? "Create an account" : "Sign in";
  $("#auth-password").autocomplete = login ? "current-password" : "new-password";
  $("#auth-password").placeholder = login ? "Your password" : "At least 10 characters";
  $("#pw-rule").hidden = login;
  setFieldError("auth-email", "email-error", "");
  setFieldError("auth-password", "password-error", "");
  $("#pw-rule").classList.remove("bad");
  setAuthStatus("");
  updatePasswordRule();
}

function setAuthStatus(message, kind = "") {
  const node = $("#auth-status");
  node.textContent = message;
  node.className = `form-status ${kind}`.trim();
}

function updatePasswordRule() {
  const long = $("#auth-password").value.length >= 10;
  $("#pw-rule").classList.toggle("ok", long);
  if (long) {
    $("#pw-rule").classList.remove("bad");
    $("#auth-password").closest(".input-row").classList.remove("invalid");
  }
}

function togglePassword() {
  const input = $("#auth-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  const button = $("#toggle-password");
  button.replaceChildren(icon(show ? "eye-off" : "eye"));
  button.setAttribute("aria-label", show ? "Hide password" : "Show password");
}

function showAuth(message = "", kind = "") {
  state.user = null;
  state.series = null;
  $("#splash").hidden = true;
  $("#app").hidden = true;
  $("#auth-screen").hidden = false;
  $("#auth-password").value = "";
  setAuthStatus(message, kind);
}

function showApp(user) {
  state.user = user;
  state.goal = loadGoal();
  state.day = localDate();
  state.series = null;
  state.homeTab = "meals";
  const initial = user.email.charAt(0);
  $("#avatar").textContent = initial;
  $("#splash").hidden = true;
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
  go("home");
  checkHealth();
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  setAuthStatus("");

  let valid = true;
  if (!EMAIL_RE.test(email)) {
    setFieldError("auth-email", "email-error", "Enter a valid email address.");
    valid = false;
  } else setFieldError("auth-email", "email-error", "");
  if (!password) {
    setFieldError("auth-password", "password-error", "Enter your password.");
    valid = false;
  } else if (authMode === "signup" && password.length < 10) {
    // The rule line under the field already says what is needed, so just turn it red.
    setFieldError("auth-password", "password-error", "");
    $("#auth-password").closest(".input-row").classList.add("invalid");
    $("#pw-rule").classList.add("bad");
    valid = false;
  } else setFieldError("auth-password", "password-error", "");
  if (!valid) {
    ($(".input-row.invalid input") || $("#auth-email")).focus();
    return;
  }

  const button = $("#auth-submit");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = authMode === "login" ? "Signing in…" : "Creating account…";
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
    setAuthStatus(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function onLogout() {
  const ok = await confirmSheet({
    title: "Sign out?",
    message: "You can sign back in any time. Your meals stay saved.",
    confirmLabel: "Sign out",
  });
  if (!ok) return;
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    showAuth("You're signed out.", "info");
  }
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    state.analysisReady = health.groq_configured;
  } catch {
    /* the add screen reports connection problems when it matters */
  }
}

/* ───────── Home ───────── */

const windowEnd = (day) => {
  const today = localDate();
  const end = shiftDate(day, 3);
  return end > today ? today : end;
};

const emptyTotals = (day) => ({ date: day, meals: 0, calories: 0, protein: 0, carbs: 0, fat: 0 });
const totalsFor = (day) => (state.series && state.series.find((d) => d.date === day)) || emptyTotals(day);

function renderHomeHeader() {
  const today = localDate();
  $("#home-title").textContent = dayTitle(state.day);
  $("#day-next").disabled = state.day >= today;
  $("#goal-text").textContent = `Goal ${fmt(state.goal)}`;
}

function renderWeek() {
  const end = windowEnd(state.day);
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(end, index - 6));
  $("#week").replaceChildren(
    ...days.map((day) => {
      const date = parseLocal(day);
      const selected = day === state.day;
      const logged = state.series && (state.series.find((d) => d.date === day) || {}).calories > 0;
      return el("button", {
        type: "button",
        class: `day${selected ? " selected" : ""}${logged ? " logged" : ""}`,
        "aria-pressed": String(selected),
        "aria-label": date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
        onclick: () => selectDay(day),
      },
        el("span", { class: "dow", text: date.toLocaleDateString([], { weekday: "short" }).slice(0, 3) }),
        el("span", { class: "dom", text: String(date.getDate()) }),
        el("span", { class: "day-dot" }),
      );
    }),
  );
}

function selectDay(day) {
  if (day > localDate()) return;
  state.day = day;
  loadHome();
}

function showHomeSkeleton() {
  $("#left-value").textContent = "–";
  $("#left-value").dataset.value = "0";
  $("#eaten").textContent = "Loading…";
  $("#macro-track").replaceChildren(
    el("div", { class: "macro-slide" }, [0, 1, 2].map(() => el("div", { class: "skeleton macro-sk" }))),
  );
  $("#macro-dots").replaceChildren();
  $("#meal-groups").replaceChildren(el("div", { class: "skeleton card-sk" }), el("div", { class: "skeleton card-sk" }), el("div", { class: "skeleton card-sk" }));
}

async function loadHome() {
  const day = state.day;
  renderHomeHeader();
  renderWeek();
  if (state.series && state.series.some((d) => d.date === day)) renderTotals(totalsFor(day));
  else showHomeSkeleton();
  try {
    const [summary, meals] = await Promise.all([
      api(`/api/summary?date=${windowEnd(day)}&days=7`),
      api(`/api/meals?date=${day}`),
    ]);
    if (day !== state.day) return;
    state.series = summary.series;
    state.meals = meals;
    renderHomeData();
  } catch (error) {
    if (day === state.day) renderHomeError(error);
  }
}

function renderHomeData() {
  renderHomeHeader();
  renderWeek();
  renderTotals(totalsFor(state.day));
  renderGroups(state.meals);
  renderNutrients(state.meals);
  applyHomeTab();
}

function renderHomeError(error) {
  $("#meal-groups").replaceChildren(
    el("div", { class: "notice error" },
      icon("circle-alert", 22),
      el("div", {},
        el("strong", { text: "Couldn't load your day" }),
        error.message,
        el("div", {}, el("button", { type: "button", class: "chip", onclick: loadHome }, icon("refresh-cw", 16), "Try again")),
      ),
    ),
  );
}

function renderTotals(totals) {
  const left = state.goal - totals.calories;
  $("#screen-home .hero").classList.toggle("over", left < 0);
  animateNumber($("#left-value"), Math.abs(left));
  $("#left-label").textContent = left < 0 ? "Kcal over your goal" : "Kcal left";
  $("#eaten").textContent = `${fmt(totals.calories)} eaten`;
  $("#goal-text").textContent = `Goal ${fmt(state.goal)}`;
  renderMacros(totals);
}

function ring(color, iconName, fraction) {
  const size = 64;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const target = circumference * (1 - Math.max(0, Math.min(1, fraction)));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    `<circle class="track" cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke-width="${stroke}"/>` +
    `<circle class="bar" cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke="${color}" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>`;
  const bar = svg.querySelector(".bar");
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.strokeDashoffset = String(target); }));
  return el("div", { class: "ring" }, svg, el("span", { class: "ring-icon", style: `color:${color}` }, icon(iconName, 22)));
}

function renderMacros(totals) {
  const goals = macroGoals(state.goal);
  const kcalFromMacros = totals.protein * 4 + totals.carbs * 4 + totals.fat * 9;

  const remaining = el("div", { class: "macro-slide", "aria-label": "Left today" },
    MACROS.map((m) =>
      el("div", { class: "macro-card" },
        el("strong", { text: `${fmt(Math.max(0, goals[m.key] - totals[m.key]))}g` }),
        el("span", { class: "name", text: `${m.label} left` }),
        ring(m.color, m.icon, totals[m.key] / goals[m.key]),
      ),
    ),
  );

  const split = el("div", { class: "macro-slide", "aria-label": "Share of calories" },
    MACROS.map((m) => {
      const factor = m.key === "fat" ? 9 : 4;
      const pct = kcalFromMacros > 0 ? Math.round(((totals[m.key] * factor) / kcalFromMacros) * 100) : 0;
      return el("div", { class: "macro-card split-card" },
        el("strong", { text: kcalFromMacros > 0 ? `${pct}%` : "–" }),
        el("span", { class: "name", text: `${m.label} share` }),
        el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: `width:${pct}%;background:${m.color}` })),
      );
    }),
  );

  $("#macro-track").replaceChildren(remaining, split);
  $("#macro-dots").replaceChildren(
    ...[0, 1].map((index) => el("span", { class: `dot${index === 0 ? " active" : ""}` })),
  );
  $("#macro-track").scrollLeft = 0;
}

function renderGroups(meals) {
  const grouped = Object.fromEntries(MEAL_TYPES.map((t) => [t.key, []]));
  for (const meal of [...meals].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    (grouped[mealGroup(meal)] || grouped.snack).push(meal);
  }
  $("#meal-groups").replaceChildren(...MEAL_TYPES.map((type) => groupCard(type, grouped[type.key])));
}

function macroPill(m, grams) {
  return el("span", { class: "pill", style: `--c:${m.color}` }, el("i"), `${m.label} ${fmt1(grams)}g`);
}

function groupCard(type, meals) {
  const totals = meals.reduce(
    (sum, m) => ({
      calories: sum.calories + m.totals.calories,
      protein: sum.protein + m.totals.protein,
      carbs: sum.carbs + m.totals.carbs,
      fat: sum.fat + m.totals.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const head = el("header", { class: "group-head" },
    el("span", { class: "group-icon" }, icon(type.icon, 22)),
    el("div", { class: "group-title" },
      el("h3", { text: type.plural }),
      el("p", { text: meals.length ? `${fmt(totals.calories)} kcal` : "Nothing logged" }),
    ),
    el("button", { type: "button", class: "add-circle", "aria-label": `Add ${type.label.toLowerCase()}`, onclick: () => openCamera(type.key) }, icon("plus", 22)),
  );
  if (!meals.length) return el("article", { class: "group empty" }, head);

  return el("article", { class: "group" },
    head,
    el("div", { class: "pills" }, MACROS.map((m) => macroPill(m, totals[m.key]))),
    el("div", { class: "entries" },
      meals.map((meal) =>
        el("button", { type: "button", class: "entry", onclick: () => openDetail(meal) },
          el("img", { src: meal.thumbnail_url, alt: "", loading: "lazy" }),
          el("div", { class: "entry-body" },
            el("div", { class: "entry-name", text: meal.meal_name }),
            el("div", { class: "entry-meta", text: `${formatTime(meal.created_at)} · ${capitalize(meal.portion)}` }),
          ),
          el("div", { class: "entry-kcal" }, fmt(meal.totals.calories), el("small", { text: "kcal" })),
        ),
      ),
    ),
  );
}

function aggregateNutrients(meals) {
  const totals = new Map();
  for (const meal of meals) {
    for (const nutrient of meal.analysis.micronutrients || []) {
      const match = /(\d+(?:[.,]\d+)?)\s*([a-zA-Zµ%]*)/.exec(nutrient.amount || "");
      if (!match) continue;
      const key = nutrient.name.trim().toLowerCase();
      const unit = match[2].toLowerCase();
      const entry = totals.get(key) || { name: nutrient.name.trim(), unit, value: 0, mixed: false };
      if (entry.unit !== unit) entry.mixed = true;
      else entry.value += parseFloat(match[1].replace(",", "."));
      totals.set(key, entry);
    }
  }
  return [...totals.values()].filter((entry) => !entry.mixed).sort((a, b) => a.name.localeCompare(b.name));
}

function renderNutrients(meals) {
  const list = aggregateNutrients(meals);
  const tips = meals.filter((m) => m.analysis.notes).map((m) => ({ name: m.meal_name, note: m.analysis.notes }));
  const rows = [];
  if (!list.length && !tips.length) {
    rows.push(el("div", { class: "notice" }, icon("leaf", 22), el("div", {}, el("strong", { text: "No nutrient data yet" }), "Log a meal and its vitamins, minerals and tips show up here.")));
  }
  for (const entry of list) {
    rows.push(el("div", { class: "nutrient-row" },
      el("span", { class: "ni" }, icon("leaf", 20)),
      el("strong", { text: entry.name }),
      el("span", { class: "v", text: `${fmt1(entry.value)} ${entry.unit}`.trim() }),
    ));
  }
  if (tips.length) {
    rows.push(el("p", { class: "sub-title", text: "Tips from today's meals" }));
    for (const tip of tips) rows.push(el("div", { class: "tip-card" }, el("b", { text: `${tip.name}: ` }), tip.note));
  }
  $("#nutrients").replaceChildren(...rows);
}

function applyHomeTab() {
  const meals = state.homeTab === "meals";
  $("#meal-groups").hidden = !meals;
  $("#nutrients").hidden = meals;
  for (const button of $$("[data-home-tab]")) {
    const active = button.dataset.homeTab === state.homeTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

/* ───────── Meal detail ───────── */

function openDetail(meal) {
  renderDetail(meal);
  openOverlay("detail");
}

function closeMenu() {
  const menu = $(".menu");
  if (menu) menu.remove();
}

function toggleMenu(event, meal) {
  event.stopPropagation();
  if ($(".menu")) return closeMenu();
  const menu = el("div", { class: "menu", role: "menu" },
    el("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); deleteMeal(meal); } }, icon("trash-2", 20), "Delete meal"),
  );
  $(".detail-hero").append(menu);
}

async function deleteMeal(meal) {
  const ok = await confirmSheet({
    title: "Delete this meal?",
    message: `"${meal.meal_name}" will be removed from your log. This can't be undone.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  try {
    await api(`/api/meals/${meal.id}`, { method: "DELETE" });
    state.series = null;
    toast("Meal deleted");
    closeOverlay();
  } catch (error) {
    toast(error.message, "error");
  }
}

function macroBar(m, grams, percent) {
  return el("div", { class: "macro-bar", style: `--c:${m.color};--h:${Math.max(8, Math.round(percent))}%` },
    el("span", { class: "mb-name" }, icon(m.icon, 18), m.label),
    el("div", {},
      el("span", { class: "mb-val", text: `${fmt1(grams)}g` }),
      el("span", { class: "mb-pct", text: `${Math.round(percent)}% of kcal` }),
    ),
  );
}

function foodRow(food) {
  return el("div", { class: "food" },
    el("span", { class: "food-emoji", "aria-hidden": "true", text: food.emoji }),
    el("div", {},
      el("div", { class: "food-name", text: food.name }),
      el("div", { class: "food-portion", text: food.portion }),
      el("div", { class: "food-macros" },
        MACROS.map((m) => el("span", { style: `--c:${m.color}` }, icon(m.icon, 14), `${fmt1(food[m.key])}g`)),
      ),
    ),
    el("div", { class: "food-kcal" }, fmt(food.calories), el("small", { text: "kcal" })),
  );
}

function renderDetail(meal) {
  const { totals, macro_split: split, health } = meal;
  const { foods, micronutrients, notes } = meal.analysis;
  const type = typeInfo(mealGroup(meal));

  const hero = el("div", { class: "detail-hero" },
    el("img", { class: "detail-photo", src: meal.thumbnail_url, alt: `Photo of ${meal.meal_name}` }),
    el("div", { class: "detail-shade" }),
    el("div", { class: "detail-bar" },
      el("button", { type: "button", class: "round-btn glass", "aria-label": "Back", onclick: closeOverlay }, icon("arrow-left", 22)),
      el("h2", { text: "Nutrition" }),
      el("button", { type: "button", class: "round-btn glass", "aria-label": "More options", "aria-haspopup": "menu", onclick: (event) => toggleMenu(event, meal) }, icon("ellipsis", 22)),
    ),
    el("div", { class: "detail-title" },
      el("span", { class: "tag-pill" }, icon(type.icon, 16), `${type.label} · ${capitalize(meal.portion)} portion`),
      el("div", { class: "detail-title-row" },
        el("h1", { text: meal.meal_name }),
        el("div", { class: "detail-kcal" }, el("strong", { text: fmt(totals.calories) }), el("span", { text: "kcal" })),
      ),
    ),
  );

  const sheet = el("div", { class: "detail-sheet" },
    notes ? el("p", { class: "lead", text: notes }) : null,
    el("div", { class: "score-row" },
      el("div", { class: "score-ring", style: `--p:${health.score}%`, role: "img", "aria-label": `Balance score ${health.score} out of 100` },
        el("span", { text: String(health.score) })),
      el("div", { class: "score-text" },
        el("strong", { text: "Meal balance" }),
        el("span", { text: health.label }),
      ),
    ),
    el("h2", { text: "Macros" }),
    el("div", { class: "macro-bars" }, MACROS.map((m) => macroBar(m, totals[m.key], split[`${m.key}_pct`]))),
    el("h2", { text: `Detected items (${foods.length})` }),
    foods.map(foodRow),
    micronutrients.length
      ? [
          el("h2", { text: "Key nutrients" }),
          el("div", { class: "chips detail-chips" },
            micronutrients.map((n) => el("span", { class: "chip", text: n.amount ? `${n.name}: ${n.amount}` : n.name }))),
        ]
      : null,
    el("p", { class: "disclaimer", text: "AI estimate from your photo. Not medical advice." }),
  );

  $("#detail").replaceChildren(hero, sheet);
}

/* ───────── Add a meal ───────── */

let scanTimer = null;

function renderTypeChips() {
  $("#type-chips").replaceChildren(
    ...MEAL_TYPES.map((type) =>
      el("label", {},
        el("input", { type: "radio", name: "meal_type", value: type.key, ...(state.mealType === type.key ? { checked: true } : {}), onchange: () => { state.mealType = type.key; } }),
        icon(type.icon, 18),
        type.label,
      ),
    ),
  );
}

function resetAddForm() {
  state.file = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  $("#analyze-form").reset();
  $("#preview").hidden = true;
  $("#preview").removeAttribute("src");
  $("#photo-empty").hidden = false;
  $("#photo-card").classList.remove("filled");
  $("#analyze-btn").disabled = true;
  stopScan();
  setAnalyzeStatus("");
}

function openCamera(type) {
  resetAddForm();
  state.mealType = type || defaultMealType();
  renderTypeChips();
  openOverlay("camera");
}

function setAnalyzeStatus(message, kind = "") {
  const node = $("#analyze-status");
  node.textContent = message;
  node.className = `form-status ${kind}`.trim();
}

/** Returns a message when the photo can't be used, or an empty string when it is fine. */
function fileProblem(file) {
  if (file.type === "image/heic" || file.type === "image/heif") {
    return "HEIC photos aren't supported yet. Choose a JPEG, PNG or WEBP photo, or take a new one.";
  }
  if (file.type && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    return "Please choose a JPEG, PNG or WEBP photo.";
  }
  if (file.size > MAX_UPLOAD_BYTES) return "That photo is larger than 10 MB. Try a smaller one.";
  return "";
}

function selectFile(file) {
  if (!file) return;
  const problem = fileProblem(file);
  if (problem) {
    setAnalyzeStatus(problem);
    return;
  }
  state.file = file;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  const preview = $("#preview");
  preview.src = state.previewUrl;
  preview.hidden = false;
  $("#photo-empty").hidden = true;
  $("#photo-card").classList.add("filled");
  $("#analyze-btn").disabled = false;
  setAnalyzeStatus(state.analysisReady === false ? "The server isn't set up for photo analysis yet (missing Groq key)." : "");
}

/* ───────── Camera ───────── */

const camera = { stream: null, track: null, facing: "environment", torch: false, token: 0 };

/** Back from the review screen to the viewfinder, without stacking another history entry. */
function reopenCamera() {
  history.replaceState({ overlay: "camera" }, "");
  go("camera");
}

function closeCamera() {
  if (state.file) {
    // Opened to retake: return to the photo that was already taken.
    history.replaceState({ overlay: "add" }, "");
    go("add");
  } else {
    closeOverlay();
  }
}

function showCameraError(title, text) {
  $("#camera-error-title").textContent = title;
  $("#camera-error-text").textContent = text;
  $("#camera-error").hidden = false;
  $("#screen-camera").classList.add("failed");
}

function describeCameraError(error) {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return ["Camera access is blocked", "Allow camera access for this site in your browser settings, then try again. You can also use your phone's camera app or pick a photo."];
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return ["No camera found", "This device doesn't seem to have a camera we can use. Choose a photo from your library instead."];
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return ["The camera is busy", "Another app may be using the camera. Close it and try again."];
  }
  return ["Camera isn't available", "Your browser can't open the camera here. Use your phone's camera app or choose a photo."];
}

function resetTorchButton() {
  const button = $("#camera-flash");
  camera.torch = false;
  button.classList.remove("on");
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", "Turn flash on");
  button.replaceChildren(icon("zap-off", 22));
}

async function startCamera() {
  stopCamera();
  const token = ++camera.token;
  $("#camera-error").hidden = true;
  $("#screen-camera").classList.remove("failed");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError(
      "Camera isn't available",
      window.isSecureContext
        ? "Your browser can't open the camera here. Use your phone's camera app or choose a photo."
        : "The camera needs a secure (https) connection. Use your phone's camera app or choose a photo.",
    );
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: camera.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    // The person may have left the screen while the permission prompt was open.
    if (token !== camera.token || state.screen !== "camera") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    camera.stream = stream;
    camera.track = stream.getVideoTracks()[0];
    const video = $("#camera-video");
    video.classList.toggle("mirror", camera.facing === "user");
    video.srcObject = stream;
    await video.play().catch(() => {});
    const capabilities = camera.track.getCapabilities ? camera.track.getCapabilities() : {};
    $("#camera-flash").hidden = !capabilities.torch;
    resetTorchButton();
    const devices = await navigator.mediaDevices.enumerateDevices();
    $("#camera-flip").hidden = devices.filter((device) => device.kind === "videoinput").length < 2;
  } catch (error) {
    if (token !== camera.token) return;
    const [title, text] = describeCameraError(error);
    showCameraError(title, text);
  }
}

function stopCamera() {
  camera.token++; // cancels a start that is still waiting for permission
  if (camera.stream) camera.stream.getTracks().forEach((track) => track.stop());
  camera.stream = null;
  camera.track = null;
  camera.torch = false;
  const video = $("#camera-video");
  if (video) video.srcObject = null;
}

async function toggleTorch() {
  if (!camera.track) return;
  const next = !camera.torch;
  try {
    await camera.track.applyConstraints({ advanced: [{ torch: next }] });
  } catch {
    toast("Flash isn't available on this camera.", "error");
    return;
  }
  camera.torch = next;
  const button = $("#camera-flash");
  button.classList.toggle("on", next);
  button.setAttribute("aria-pressed", String(next));
  button.setAttribute("aria-label", next ? "Turn flash off" : "Turn flash on");
  button.replaceChildren(icon(next ? "zap" : "zap-off", 22));
}

/** Use a photo from the camera, the library or the phone's camera app: move on to the review screen. */
function reviewFile(file) {
  const problem = fileProblem(file);
  if (problem) {
    toast(problem, "error");
    return;
  }
  if (state.screen === "camera") {
    history.replaceState({ overlay: "add" }, "");
    go("add");
  }
  selectFile(file);
}

async function takePhoto() {
  const video = $("#camera-video");
  if (!camera.stream || !video.videoWidth) return;
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

  const flash = $("#shutter-flash");
  flash.classList.remove("go");
  void flash.offsetWidth; // restart the animation
  flash.classList.add("go");
  if (navigator.vibrate) navigator.vibrate(12);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) {
    toast("Couldn't capture the photo. Try again.", "error");
    return;
  }
  reviewFile(new File([blob], `meal-${Date.now()}.jpg`, { type: "image/jpeg" }));
}

function startScan() {
  let index = 0;
  $("#scan").hidden = false;
  $("#scan-text").textContent = SCAN_STEPS[0];
  scanTimer = setInterval(() => {
    index = (index + 1) % SCAN_STEPS.length;
    $("#scan-text").textContent = SCAN_STEPS[index];
  }, 1800);
}

function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  $("#scan").hidden = true;
}

async function onAnalyze(event) {
  event.preventDefault();
  if (!state.file) return;
  const typed = $("#meal-name").value.trim();
  const portion = ($('input[name="portion"]:checked') || {}).value || "regular";

  const body = new FormData();
  body.set("file", state.file);
  body.set("meal_name", typed || typeInfo(state.mealType).label);
  body.set("meal_type", state.mealType);
  body.set("portion", portion);
  body.set("meal_date", state.day);

  const button = $("#analyze-btn");
  button.disabled = true;
  button.textContent = "Analyzing…";
  setAnalyzeStatus("");
  startScan();
  try {
    const meal = await api("/api/meals/analyze", { method: "POST", body });
    state.series = null;
    renderDetail(meal);
    // Swap the add screen for the result in history, so Back returns to the main screen.
    history.replaceState({ overlay: "detail" }, "");
    go("detail");
    toast("Meal saved");
  } catch (error) {
    setAnalyzeStatus(error.message);
  } finally {
    stopScan();
    button.disabled = false;
    button.textContent = "Analyze with AI";
  }
}

/* ───────── History ───────── */

function noticeWithRetry(title, message, retry) {
  return el("div", { class: "notice error" },
    icon("circle-alert", 22),
    el("div", {},
      el("strong", { text: title }),
      message,
      el("div", {}, el("button", { type: "button", class: "chip", onclick: retry }, icon("refresh-cw", 16), "Try again")),
    ),
  );
}

async function loadHistory() {
  const list = $("#history-list");
  list.replaceChildren(...[0, 1, 2, 3, 4].map(() => el("div", { class: "skeleton", style: "height:82px;border-radius:20px" })));
  try {
    const summary = await api(`/api/summary?date=${localDate()}&days=31`);
    renderHistory(summary.series);
  } catch (error) {
    list.replaceChildren(noticeWithRetry("Couldn't load your history", error.message, loadHistory));
  }
}

function historyRow(day) {
  const today = localDate();
  const date = parseLocal(day.date);
  const none = day.meals === 0;
  const meta = none
    ? date.toLocaleDateString([], { month: "long", day: "numeric" })
    : `${day.meals} meal${day.meals === 1 ? "" : "s"} · ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  return el("button", {
    type: "button",
    class: `hrow${none ? " none" : ""}${day.date === today ? " today" : ""}`,
    onclick: () => { state.day = day.date; go("home"); },
  },
    el("div", { class: "hdate" }, el("b", { text: String(date.getDate()) }), el("small", { text: date.toLocaleDateString([], { weekday: "short" }) })),
    el("div", { class: "hmain" },
      el("strong", { text: none ? (day.date === today ? "Nothing logged yet" : "No meals") : `${fmt(day.calories)} kcal` }),
      el("div", { class: "meta", text: meta }),
      none ? null : el("div", { class: "hbar" }, el("i", { class: day.calories > state.goal ? "over" : "", style: `width:${Math.min(100, (day.calories / state.goal) * 100)}%` })),
    ),
    el("span", { class: "chev" }, icon("chevron-right", 20)),
  );
}

function renderHistory(series) {
  const list = $("#history-list");
  if (!series.some((day) => day.meals > 0)) {
    list.replaceChildren(
      el("div", { class: "notice" }, icon("history", 22), el("div", {}, el("strong", { text: "No history yet" }), "Your days will appear here once you log a meal. Tap + to start.")),
    );
    return;
  }
  list.replaceChildren(...[...series].reverse().map(historyRow));
}

/* ───────── Progress ───────── */

function renderRange() {
  $("#range").replaceChildren(
    ...[7, 14, 30].map((days) =>
      el("button", {
        type: "button",
        class: `seg-btn${state.range === days ? " active" : ""}`,
        "aria-pressed": String(state.range === days),
        onclick: () => { state.range = days; loadProgress(); },
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
    $("#chart").replaceChildren(noticeWithRetry("Couldn't load progress", error.message, loadProgress));
  }
}

function renderProgress(series) {
  const logged = series.filter((d) => d.calories > 0);
  const total = logged.reduce((sum, d) => sum + d.calories, 0);
  const average = logged.length ? total / logged.length : 0;
  animateNumber($("#avg-value"), average);
  $("#avg-sub").textContent = `Goal ${fmt(state.goal)} · ${logged.length} of ${series.length} days logged`;

  renderChart(series);

  let streak = 0;
  for (let i = series.length - 1; i >= 0 && series[i].calories > 0; i--) streak++;
  const mealCount = series.reduce((sum, d) => sum + d.meals, 0);
  const onTarget = logged.filter((d) => d.calories <= state.goal).length;
  const tile = (value, label) => el("div", { class: "stat" }, el("strong", { text: value }), el("span", { text: label }));
  $("#progress-stats").replaceChildren(tile(String(onTarget), "Days on target"), tile(String(mealCount), "Meals logged"), tile(String(streak), "Day streak"));

  renderMacroSplit(logged);
}

function renderChart(series) {
  const chart = $("#chart");
  chart.classList.remove("dim");
  $("#chart-detail").textContent = "Tap a bar for details.";
  if (!series.some((d) => d.calories > 0)) {
    chart.replaceChildren(
      el("div", { class: "chart-empty" },
        el("span", { class: "chart-empty-icon" }, icon("chart-column", 26)),
        el("span", { text: `No meals in the last ${series.length} days.` }),
        el("span", { class: "muted", text: "Tap + to log one and your chart appears here." }),
      ),
    );
    $("#chart-detail").textContent = "";
    $("#chart-goal").textContent = "";
    return;
  }
  const max = Math.max(state.goal, ...series.map((d) => d.calories)) * 1.12;
  const every = Math.ceil(series.length / 7);
  const columns = series.map((day, index) => {
    const date = parseLocal(day.date);
    const label = series.length <= 7
      ? date.toLocaleDateString([], { weekday: "short" })
      : index % every === 0 ? String(date.getDate()) : "";
    const classes = ["col", day.calories === 0 ? "none" : "", day.calories > state.goal ? "over" : ""].filter(Boolean).join(" ");
    const column = el("button", {
      type: "button",
      class: classes,
      "aria-label": `${date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}: ${fmt(day.calories)} kilocalories`,
      onclick: () => {
        for (const other of $$(".col", chart)) other.classList.remove("sel");
        column.classList.add("sel");
        chart.classList.add("dim");
        $("#chart-detail").textContent = day.calories
          ? `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · ${fmt(day.calories)} kcal · ${day.meals} meal${day.meals === 1 ? "" : "s"}`
          : `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · nothing logged`;
      },
    },
      el("div", { class: "bar", style: "height:0%" }),
      el("span", { class: "label", text: label }),
    );
    requestAnimationFrame(() => requestAnimationFrame(() => {
      column.firstElementChild.style.height = `${Math.max(0, (day.calories / max) * 100)}%`;
    }));
    return column;
  });
  $("#chart-goal").textContent = `Goal ${fmt(state.goal)}`;
  const line = el("div", { class: "goal-line", style: `bottom:calc(26px + (100% - 26px) * ${state.goal / max})` });
  chart.replaceChildren(...columns, line);
}

function renderMacroSplit(logged) {
  const holder = $("#macro-split");
  if (!logged.length) {
    holder.replaceChildren(el("p", { class: "muted", text: "Log a meal to see how your calories split between protein, carbs and fat." }));
    return;
  }
  const days = logged.length;
  const avg = (key) => logged.reduce((sum, d) => sum + d[key], 0) / days;
  const kcal = { protein: avg("protein") * 4, carbs: avg("carbs") * 4, fat: avg("fat") * 9 };
  const sum = kcal.protein + kcal.carbs + kcal.fat || 1;
  holder.replaceChildren(
    el("div", { class: "split" }, MACROS.map((m) => el("i", { style: `width:${(kcal[m.key] / sum) * 100}%;background:${m.color}` }))),
    el("div", { class: "legend" },
      MACROS.map((m) =>
        el("div", { class: "legend-row", style: `--c:${m.color}` },
          el("i"),
          el("span", { text: m.label }),
          el("small", { text: `${fmt1(avg(m.key))}g a day` }),
          el("strong", { text: `${Math.round((kcal[m.key] / sum) * 100)}%` }),
        ),
      ),
    ),
  );
}

/* ───────── Profile ───────── */

function renderProfile() {
  const initial = state.user.email.charAt(0);
  $("#profile-avatar").textContent = initial;
  $("#profile-email").textContent = state.user.email;
  state.goalDraft = state.goal;
  renderGoalDraft();
}

const clampGoal = (value) => Math.min(GOAL.max, Math.max(GOAL.min, Math.round(value / GOAL.step) * GOAL.step));

function renderGoalDraft() {
  const draft = state.goalDraft;
  const goals = macroGoals(draft);
  const input = $("#goal-input");
  if (document.activeElement !== input) input.value = String(draft);
  $("#goal-macros").textContent = `Protein ${goals.protein}g · Carbs ${goals.carbs}g · Fat ${goals.fat}g`;
  $("#goal-save").disabled = draft === state.goal || draft < GOAL.min || draft > GOAL.max;
  $("#goal-presets").replaceChildren(
    ...GOAL.presets.map((value) =>
      el("button", { type: "button", class: `chip${draft === value ? " active" : ""}`, onclick: () => { state.goalDraft = value; renderGoalDraft(); } }, fmt(value)),
    ),
  );
}

function onGoalSave() {
  const value = clampGoal(state.goalDraft);
  state.goal = value;
  state.goalDraft = value;
  saveGoal(value);
  renderGoalDraft();
  toast("Daily goal saved");
}

/* ───────── Wiring ───────── */

async function bootstrap() {
  let waited = false;
  const slow = setTimeout(() => {
    waited = true;
    $("#splash-note").textContent = "Waking the server. The first visit can take up to a minute.";
  }, 4000);
  try {
    showApp(await api("/api/auth/me"));
  } catch (error) {
    if (waited && /reach/i.test(error.message)) {
      $("#splash-note").textContent = error.message;
      return;
    }
    showAuth();
  } finally {
    clearTimeout(slow);
  }
}

function init() {
  hydrateIcons();

  $("#auth-form").addEventListener("submit", onAuthSubmit);
  $("#auth-switch").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
  $("#toggle-password").addEventListener("click", togglePassword);
  $("#auth-password").addEventListener("input", updatePasswordRule);
  $("#logout").addEventListener("click", onLogout);

  for (const button of $$("[data-nav]")) button.addEventListener("click", () => go(button.dataset.nav));
  $("#fab").addEventListener("click", () => openCamera());
  $("#avatar").addEventListener("click", () => go("profile"));
  $("#add-back").addEventListener("click", closeOverlay);

  $("#day-prev").addEventListener("click", () => selectDay(shiftDate(state.day, -1)));
  $("#day-next").addEventListener("click", () => selectDay(shiftDate(state.day, 1)));
  const picker = $("#date-picker");
  $("#open-calendar").addEventListener("click", () => {
    picker.max = localDate();
    picker.value = state.day;
    if (picker.showPicker) picker.showPicker();
    else picker.click();
  });
  picker.addEventListener("change", () => { if (picker.value) selectDay(picker.value); });

  for (const button of $$("[data-home-tab]")) {
    button.addEventListener("click", () => { state.homeTab = button.dataset.homeTab; applyHomeTab(); });
  }
  const track = $("#macro-track");
  track.addEventListener("scroll", () => {
    const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    $$(".dot", $("#macro-dots")).forEach((dot, i) => dot.classList.toggle("active", i === index));
  }, { passive: true });

  for (const id of ["file-camera", "file-gallery"]) {
    const input = $(`#${id}`);
    input.addEventListener("change", () => {
      const file = input.files[0];
      input.value = "";
      if (file) reviewFile(file);
    });
  }
  $("#camera-close").addEventListener("click", closeCamera);
  $("#shutter").addEventListener("click", takePhoto);
  $("#camera-flash").addEventListener("click", toggleTorch);
  $("#camera-flip").addEventListener("click", () => {
    camera.facing = camera.facing === "environment" ? "user" : "environment";
    startCamera();
  });
  $("#camera-retry").addEventListener("click", startCamera);
  $("#retake-btn").addEventListener("click", reopenCamera);
  // Release the camera when the app goes to the background, and reopen it on return.
  document.addEventListener("visibilitychange", () => {
    if (state.screen !== "camera") return;
    if (document.hidden) stopCamera();
    else startCamera();
  });
  $("#analyze-form").addEventListener("submit", onAnalyze);

  $("#goal-minus").addEventListener("click", () => { state.goalDraft = clampGoal(state.goalDraft - GOAL.step); renderGoalDraft(); });
  $("#goal-plus").addEventListener("click", () => { state.goalDraft = clampGoal(state.goalDraft + GOAL.step); renderGoalDraft(); });
  $("#goal-input").addEventListener("input", (event) => { state.goalDraft = Number(event.target.value) || 0; renderGoalDraft(); });
  $("#goal-input").addEventListener("change", () => { state.goalDraft = clampGoal(state.goalDraft || state.goal); renderGoalDraft(); $("#goal-input").value = String(state.goalDraft); });
  $("#goal-save").addEventListener("click", onGoalSave);

  document.addEventListener("click", (event) => { if (!event.target.closest(".menu")) closeMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });

  setAuthMode("login");
  bootstrap();
}

init();
