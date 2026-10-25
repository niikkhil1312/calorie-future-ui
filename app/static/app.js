"use strict";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const state = { file: null, previewUrl: null };

const $ = (selector) => document.querySelector(selector);

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

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

function setStatus(message, kind = "") {
  const status = $("#analyze-status");
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

/* ── Tabs ── */

function showTab(name) {
  for (const tab of document.querySelectorAll("#tabs .tab")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const view of document.querySelectorAll(".view")) {
    const active = view.id === `view-${name}`;
    view.classList.toggle("active", active);
    view.hidden = !active;
  }
  if (name === "dashboard") loadDashboard();
}

/* ── Analyze ── */

function selectFile(file) {
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    setStatus("Please choose a JPEG, PNG or WEBP image.", "error");
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus("That image is larger than 10 MB.", "error");
    return;
  }
  state.file = file;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  const preview = $("#preview");
  preview.src = state.previewUrl;
  preview.hidden = false;
  $("#drop-hint").hidden = true;
  $("#analyze-btn").disabled = false;
  setStatus("");
}

function setBusy(busy) {
  const button = $("#analyze-btn");
  button.disabled = busy || !state.file;
  button.textContent = busy ? "Analyzing…" : "Analyze meal";
}

function renderResult(meal) {
  const { totals } = meal;
  const split = meal.macro_split;
  const { score, label } = meal.health;
  const foods = meal.analysis.foods;

  const donut = el("div", {
    class: "donut",
    "data-score": score,
    style: `--p:${split.protein_pct}%;--pc:${split.protein_pct + split.carbs_pct}%`,
    role: "img",
    "aria-label": `Health score ${score} out of 100`,
  });

  const parts = [
    el("div", { class: "result-head" },
      el("h2", { text: meal.meal_name }),
      el("span", { text: `${formatTime(meal.created_at)} · ${meal.portion}` }),
    ),
    el("img", { class: "result-photo", src: meal.thumbnail_url, alt: "Meal photo" }),
    el("div", { class: "stats" },
      statCard("kcal", totals.calories, "Calories"),
      statCard("protein", `${totals.protein}g`, "Protein"),
      statCard("carbs", `${totals.carbs}g`, "Carbs"),
      statCard("fat", `${totals.fat}g`, "Fat"),
    ),
    el("div", { class: "score-row" },
      donut,
      el("div", { class: "score-text" },
        el("strong", { text: `Balance score ${score}/100` }),
        el("span", { class: "meta", text: label }),
        el("div", { class: "legend" },
          legendItem("var(--protein)", `Protein ${split.protein_pct}%`),
          legendItem("var(--carbs)", `Carbs ${split.carbs_pct}%`),
          legendItem("var(--fat)", `Fat ${split.fat_pct}%`),
        ),
      ),
    ),
    el("div", { class: "section-title", text: `Detected items (${foods.length})` }),
    foods.map(foodRow),
    meal.analysis.micronutrients.length
      ? [
          el("div", { class: "section-title", text: "Key micronutrients" }),
          el("div", { class: "chips" },
            meal.analysis.micronutrients.map((m) => el("span", { class: "chip", text: m.amount ? `${m.name}: ${m.amount}` : m.name }))),
        ]
      : null,
    meal.analysis.notes ? el("div", { class: "tip" }, el("strong", { text: "Tip: " }), meal.analysis.notes) : null,
  ];
  $("#result").replaceChildren(...parts.flat().filter(Boolean));
}

function statCard(kind, value, label) {
  return el("div", { class: `stat ${kind}` },
    el("div", { class: "stat-value", text: String(value) }),
    el("div", { class: "stat-label", text: label }),
  );
}

function legendItem(color, text) {
  return el("span", {}, el("span", { class: "dot", style: `background:${color}` }), text);
}

function foodRow(food) {
  return el("div", { class: "food" },
    el("span", { class: "food-emoji", "aria-hidden": "true", text: food.emoji }),
    el("div", {},
      el("div", { class: "food-name", text: food.name }),
      el("div", { class: "food-portion", text: food.portion }),
      el("div", { class: "food-tags" },
        el("span", { class: "tag p", text: `P ${food.protein}g` }),
        el("span", { class: "tag c", text: `C ${food.carbs}g` }),
        el("span", { class: "tag f", text: `F ${food.fat}g` }),
      ),
    ),
    el("div", { class: "food-kcal" }, String(food.calories), " ", el("small", { text: "kcal" })),
  );
}

async function onAnalyze(event) {
  event.preventDefault();
  if (!state.file) return;

  const form = event.currentTarget;
  const body = new FormData(form);
  body.set("file", state.file);
  body.set("meal_date", localDate());

  setBusy(true);
  setStatus("Analyzing your meal. This usually takes a few seconds…");
  try {
    const meal = await api("/api/meals/analyze", { method: "POST", body });
    renderResult(meal);
    setStatus("Saved to your log.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    if (!health.groq_configured) {
      setStatus("Add GROQ_API_KEY to the .env file and restart the server before analyzing.", "error");
      $("#analyze-btn").disabled = true;
    }
  } catch {
    setStatus("Cannot reach the NutriLens server.", "error");
  }
}

/* ── Dashboard ── */

async function loadDashboard() {
  const day = $("#day").value || localDate();
  try {
    const [summary, meals] = await Promise.all([
      api(`/api/summary?date=${day}&days=7`),
      api(`/api/meals?date=${day}`),
    ]);
    renderStats(summary.today);
    renderWeek(summary.series, day);
    renderMeals(meals, day);
  } catch (error) {
    $("#meal-list").replaceChildren(el("p", { class: "empty-list", text: error.message }));
  }
}

function renderStats(today) {
  $("#today-stats").replaceChildren(
    statCard("kcal", today.calories, "Calories"),
    statCard("protein", `${today.protein}g`, "Protein"),
    statCard("carbs", `${today.carbs}g`, "Carbs"),
    statCard("fat", `${today.fat}g`, "Fat"),
  );
}

function renderWeek(series, selectedDay) {
  const chart = $("#week-chart");
  const max = Math.max(1, ...series.map((d) => d.calories));
  if (series.every((d) => d.calories === 0)) {
    chart.replaceChildren(el("p", { class: "chart-empty", text: "No meals logged in the last 7 days." }));
    return;
  }
  chart.replaceChildren(...series.map((day) => {
    const height = Math.max(0, (day.calories / max) * 100);
    const weekday = new Date(`${day.date}T00:00:00`).toLocaleDateString([], { weekday: "short" });
    return el("div", { class: "bar-wrap", title: `${day.date}: ${day.calories} kcal, ${day.meals} meals` },
      el("span", { class: "bar-value", text: day.calories ? String(day.calories) : "" }),
      el("div", {
        class: `bar ${day.date === selectedDay ? "selected" : ""}`.trim(),
        style: `height:${height}%`,
      }),
      el("span", { class: "bar-label", text: weekday }),
    );
  }));
}

function renderMeals(meals, day) {
  const list = $("#meal-list");
  if (meals.length === 0) {
    list.replaceChildren(el("p", { class: "empty-list", text: `No meals logged for ${day}.` }));
    return;
  }
  list.replaceChildren(...meals.map(mealCard));
}

function mealCard(meal) {
  const names = meal.analysis.foods.map((f) => f.name).join(", ");
  return el("article", { class: "meal" },
    el("img", { src: meal.thumbnail_url, alt: "", loading: "lazy" }),
    el("div", {},
      el("div", { class: "meal-head" },
        el("strong", { text: meal.meal_name }),
        el("span", { class: "kcal", text: `${meal.totals.calories} kcal` }),
      ),
      el("div", { class: "meal-meta", text: `${formatTime(meal.created_at)} · ${meal.portion} · P ${meal.totals.protein}g · C ${meal.totals.carbs}g · F ${meal.totals.fat}g` }),
      el("div", { class: "meal-foods", text: names }),
      el("div", { class: "meal-actions" },
        el("button", { type: "button", class: "link-danger", onclick: () => deleteMeal(meal) }, "Delete"),
      ),
    ),
  );
}

async function deleteMeal(meal) {
  if (!window.confirm(`Delete "${meal.meal_name}" from your log?`)) return;
  try {
    await api(`/api/meals/${meal.id}`, { method: "DELETE" });
    loadDashboard();
  } catch (error) {
    window.alert(error.message);
  }
}

/* ── Wiring ── */

/* ── Accounts ── */

let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  for (const button of document.querySelectorAll("[data-auth-mode]")) {
    const active = button.dataset.authMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  $("#auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-hint").textContent = mode === "login" ? "" : "At least 10 characters.";
  setAuthStatus("");
}

function setAuthStatus(message, kind = "") {
  const status = $("#auth-status");
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

function showAuth(message = "") {
  $("#app-view").hidden = true;
  $("#account").hidden = true;
  $("#tabs").hidden = true;
  $("#view-auth").hidden = false;
  $("#auth-password").value = "";
  setAuthStatus(message, message ? "error" : "");
}

function showApp(user) {
  $("#view-auth").hidden = true;
  $("#app-view").hidden = false;
  $("#tabs").hidden = false;
  $("#account").hidden = false;
  $("#account-email").textContent = user.email;
  showTab("analyze");
  checkHealth();
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const button = $("#auth-submit");
  button.disabled = true;
  setAuthStatus(authMode === "login" ? "Signing in…" : "Creating your account…");
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
    setAuthStatus(error.message, "error");
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

async function bootstrap() {
  try {
    const user = await api("/api/auth/me");
    showApp(user);
  } catch {
    showAuth();
  }
}

function init() {
  const dropzone = $("#dropzone");
  const fileInput = $("#file");

  $("#auth-form").addEventListener("submit", onAuthSubmit);
  for (const button of document.querySelectorAll("[data-auth-mode]")) {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  }
  $("#logout").addEventListener("click", onLogout);

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

  for (const tab of document.querySelectorAll("#tabs .tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  }
  $("#day").value = localDate();
  $("#day").addEventListener("change", loadDashboard);
  $("#refresh").addEventListener("click", loadDashboard);

  setAuthMode("login");
  bootstrap();
}

init();
