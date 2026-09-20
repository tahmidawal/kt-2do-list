/* K & T 2do list — front end */

const $ = (id) => document.getElementById(id);

const el = {
  backdrop: $("backdrop"),
  banner: $("banner"),
  bgInput: $("bgInput"),
  portrait: $("portrait"),
  frameEmpty: $("frameEmpty"),
  addForm: $("addForm"),
  ideaText: $("ideaText"),
  addBtn: $("addBtn"),
  micBtn: $("micBtn"),
  planForm: $("planForm"),
  katherineLoc: $("katherineLoc"),
  tahmidLoc: $("tahmidLoc"),
  available: $("available"),
  when: $("when"),
  planBtn: $("planBtn"),
  planResult: $("planResult"),
  list: $("list"),
  showDone: $("showDone"),
  page: $("page"),
  lock: $("lock"),
  lockForm: $("lockForm"),
  lockPassword: $("lockPassword"),
  lockBtn: $("lockBtn"),
  lockError: $("lockError"),
};

let items = [];
let bannerTimer = null;

/* ------------------------------------------------------------ helpers */

function say(message, isError = false) {
  clearTimeout(bannerTimer);
  el.banner.textContent = message;
  el.banner.classList.toggle("error", isError);
  el.banner.classList.remove("hidden");
  bannerTimer = setTimeout(() => el.banner.classList.add("hidden"), isError ? 9000 : 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (response.status === 401 && path !== "/api/login") {
    showLock(); // session expired mid-use
    throw new Error("Please sign in again.");
  }
  if (!response.ok) {
    throw new Error(body?.detail || `Something went wrong (${response.status}).`);
  }
  return body;
}

function humanMinutes(total) {
  if (total == null) return "";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours && minutes) return `${hours} hr ${minutes} min`;
  if (hours) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${minutes} min`;
}

function localNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

/* ------------------------------------------------------------ list */

function renderList() {
  const showDone = el.showDone.checked;
  const visible = items.filter((item) => showDone || !item.done);

  if (!visible.length) {
    el.list.innerHTML = `<p class="empty">${
      items.length
        ? "All done — nice work. Tick “Show done” to look back."
        : "Nothing here yet. Add the first thing above."
    }</p>`;
    return;
  }

  el.list.replaceChildren(...visible.map(renderItem));
}

function renderItem(item) {
  const row = document.createElement("div");
  row.className = `item${item.done ? " done" : ""}`;

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = item.done;
  check.title = item.done ? "Mark as not done" : "Mark as done";
  check.addEventListener("change", () => toggleDone(item, check));

  const body = document.createElement("div");
  body.className = "item-body";

  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = item.title;
  body.appendChild(title);

  if (item.notes) {
    const notes = document.createElement("div");
    notes.className = "item-notes";
    notes.textContent = item.notes;
    body.appendChild(notes);
  }

  const chips = document.createElement("div");
  chips.className = "chips";
  addChip(chips, humanMinutes(item.duration_minutes), "time");
  if (item.setting !== "either") {
    addChip(chips, item.setting, item.setting === "outdoor" ? "outdoor" : "");
  }
  if (item.weather_sensitive) addChip(chips, "weather matters", "rain");
  if (item.best_time !== "anytime") addChip(chips, item.best_time);
  if (item.cost && item.cost !== "$") addChip(chips, item.cost);
  if (item.location_hint) addChip(chips, item.location_hint);
  body.appendChild(chips);

  const trash = document.createElement("button");
  trash.className = "trash";
  trash.textContent = "✕";
  trash.title = "Remove from the list";
  trash.addEventListener("click", () => removeItem(item));

  row.append(check, body, trash);
  return row;
}

function addChip(parent, text, variant = "") {
  if (!text) return;
  const chip = document.createElement("span");
  chip.className = `chip ${variant}`.trim();
  chip.textContent = text;
  parent.appendChild(chip);
}

async function loadItems() {
  try {
    items = await api("/api/items");
    renderList();
  } catch (error) {
    say(error.message, true);
  }
}

async function toggleDone(item, checkbox) {
  const next = checkbox.checked;
  try {
    const updated = await api(`/api/items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: next }),
    });
    Object.assign(item, updated);
    renderList();
  } catch (error) {
    checkbox.checked = !next;
    say(error.message, true);
  }
}

async function removeItem(item) {
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    items = items.filter((i) => i.id !== item.id);
    renderList();
  } catch (error) {
    say(error.message, true);
  }
}

/* ------------------------------------------------------------ add */

el.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = el.ideaText.value.trim();
  if (!text) return;

  el.addBtn.disabled = true;
  el.addBtn.textContent = "Reading that…";
  try {
    const { created } = await api("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    items = [...created.slice().reverse(), ...items];
    el.ideaText.value = "";
    renderList();
    say(created.length === 1 ? "Added." : `Added ${created.length} things.`);
  } catch (error) {
    say(error.message, true);
  } finally {
    el.addBtn.disabled = false;
    el.addBtn.textContent = "Add to the list";
  }
});

/* ------------------------------------------------------------ dictation */

// Chrome, Edge, and Safari (including iPhones) ship speech recognition under
// the webkit prefix; Firefox has neither, so the button only appears when it
// will actually work.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

if (Speech) {
  el.micBtn.hidden = false;

  const recognizer = new Speech();
  recognizer.lang = navigator.language || "en-US";
  recognizer.continuous = true;
  recognizer.interimResults = true;

  let listening = false;
  let base = ""; // whatever was typed before the mic came on
  let finals = "";

  recognizer.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finals += transcript;
      else interim += transcript;
    }
    el.ideaText.value = (base + finals + interim).trimStart();
  };

  recognizer.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      say("The browser needs microphone permission for this — check the icon in the address bar.", true);
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      say("Couldn't hear that — try again?", true);
    }
  };

  // Fires both when we stop it and when the browser gives up on its own
  // (silence timeout, tab switch), so the button state lives here.
  recognizer.onend = () => {
    listening = false;
    el.micBtn.classList.remove("listening");
    el.micBtn.title = "Say it out loud instead";
    el.ideaText.value = (base + finals).trimStart();
  };

  el.micBtn.addEventListener("click", () => {
    if (listening) {
      recognizer.stop();
      return;
    }
    base = el.ideaText.value ? el.ideaText.value.replace(/\s*$/, " ") : "";
    finals = "";
    try {
      recognizer.start();
    } catch {
      return; // double-tap while it was already winding down
    }
    listening = true;
    el.micBtn.classList.add("listening");
    el.micBtn.title = "Done talking";
    el.ideaText.focus();
  });
}

/* ------------------------------------------------------------ plan */

el.planForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.planBtn.disabled = true;
  el.planBtn.textContent = "Having a think…";
  el.planResult.innerHTML = "";

  try {
    const data = await api("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        katherine_location: el.katherineLoc.value.trim(),
        tahmid_location: el.tahmidLoc.value.trim(),
        available_minutes: el.available.value ? Number(el.available.value) : null,
        when: el.when.value || null,
      }),
    });
    renderPlan(data);
  } catch (error) {
    say(error.message, true);
  } finally {
    el.planBtn.disabled = false;
    el.planBtn.textContent = "Pick something for us";
  }
});

function renderPlan({ suggestion, weather, travel }) {
  const frag = document.createDocumentFragment();

  const headline = document.createElement("div");
  headline.className = "headline";
  headline.textContent = suggestion.headline;
  frag.appendChild(headline);

  const conditions = document.createElement("div");
  conditions.className = "conditions";
  addChip(conditions, `${Math.round(weather.temperature_c)}°C ${weather.description}`, "time");
  if (weather.precipitation_chance != null) {
    addChip(conditions, `${weather.precipitation_chance}% rain`, "rain");
  }
  const area = travel.meeting_area || "";
  addChip(conditions, area.startsWith("halfway") ? `meet ${area}` : `meet near ${area}`);
  addChip(conditions, `Katherine ${travel.katherine.minutes} min`);
  addChip(conditions, `Tahmid ${travel.tahmid.minutes} min`);
  frag.appendChild(conditions);

  (suggestion.picks || []).forEach((pick, index) => {
    const block = document.createElement("div");
    block.className = "pick";

    const rank = document.createElement("div");
    rank.className = "pick-rank";
    rank.textContent = index === 0 ? "Do this" : "Or this";

    const title = document.createElement("div");
    title.className = "pick-title";
    title.textContent = pick.title;

    const why = document.createElement("div");
    why.className = "pick-why";
    why.textContent = pick.why;

    block.append(rank, title, why);

    if (pick.total_minutes) {
      const total = document.createElement("div");
      total.className = pick.over_budget ? "meeting over-budget" : "meeting";
      total.textContent = pick.over_budget
        ? `${humanMinutes(pick.total_minutes)} door to door — more than the time you said you had.`
        : `About ${humanMinutes(pick.total_minutes)} door to door.`;
      block.appendChild(total);
    }
    frag.appendChild(block);
  });

  if (suggestion.skip_today?.length) {
    const skips = document.createElement("div");
    skips.className = "skips";
    const heading = document.createElement("h3");
    heading.textContent = "Not today";
    skips.appendChild(heading);
    suggestion.skip_today.forEach((skip) => {
      const line = document.createElement("div");
      line.className = "skip-line";
      const name = document.createElement("b");
      name.textContent = `${skip.title} — `;
      line.append(name, document.createTextNode(skip.why));
      skips.appendChild(line);
    });
    frag.appendChild(skips);
  }

  if (suggestion.meeting_note) {
    const note = document.createElement("div");
    note.className = "meeting";
    note.textContent = suggestion.meeting_note;
    frag.appendChild(note);
  }

  if (travel.estimates_only) {
    const caveat = document.createElement("div");
    caveat.className = "meeting";
    caveat.textContent = "Drive times are rough estimates — the routing service didn't answer.";
    frag.appendChild(caveat);
  }

  el.planResult.replaceChildren(frag);
}

/* ------------------------------------------------------------ background */

el.bgInput.addEventListener("change", async () => {
  const file = el.bgInput.files?.[0];
  if (!file) return;

  const form = new FormData();
  form.append("file", file);
  try {
    const photos = await api("/api/background", { method: "POST", body: form });
    showPhoto(photos.background, photos.portrait);
    say("Lovely.");
  } catch (error) {
    say(error.message, true);
  } finally {
    el.bgInput.value = "";
  }
});

function showPhoto(backgroundUrl, portraitUrl) {
  const bust = `?v=${Date.now()}`;
  el.backdrop.classList.toggle("no-photo", !backgroundUrl);
  if (backgroundUrl) {
    el.backdrop.style.backgroundImage = `url("${backgroundUrl}${bust}")`;
  }
  if (portraitUrl) {
    el.portrait.src = portraitUrl + bust;
    el.portrait.hidden = false;
    el.frameEmpty.classList.add("hidden");
  }
}

/* ------------------------------------------------------------ signing in */

function showLock() {
  el.lock.classList.remove("hidden");
  el.page.classList.add("hidden");
  el.lockPassword.focus();
}

el.lockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.lockBtn.disabled = true;
  el.lockError.classList.add("hidden");
  try {
    await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: el.lockPassword.value }),
    });
    el.lockPassword.value = "";
    el.lock.classList.add("hidden");
    el.page.classList.remove("hidden");
    await boot();
  } catch (error) {
    el.lockError.textContent = error.message;
    el.lockError.classList.remove("hidden");
  } finally {
    el.lockBtn.disabled = false;
  }
});

/* ------------------------------------------------------------ boot */

async function boot() {
  const status = await api("/api/status");
  if (!status.signed_in) {
    showLock();
    return;
  }

  showPhoto(status.background, status.portrait);
  // Only prefill fields the person hasn't already started typing in.
  if (!el.katherineLoc.value) el.katherineLoc.value = status.katherine_location || "";
  if (!el.tahmidLoc.value) el.tahmidLoc.value = status.tahmid_location || "";
  if (!status.llm_configured) {
    say(
      "No OpenRouter API key yet — adding ideas and picking a plan won't work until you put one in the .env file and restart.",
      true
    );
  }
  await loadItems();
}

(async function start() {
  el.when.value = localNow();
  el.showDone.addEventListener("change", renderList);
  try {
    await boot();
  } catch (error) {
    say(error.message, true);
  }
})();

/* ------------------------------------------------------------ puppies */

(function hangOut() {
  const golden = $("puppyGolden");
  const poodle = $("puppyPoodle");
  if (!golden || !poodle) return;

  const WIDTH = 124;
  const HEIGHT = 90;

  const pack = [
    { el: golden, x: 24, y: 0, destX: 24, destY: 0, wait: 0, mood: "wander", moodUntil: 0 },
    { el: poodle, x: 220, y: 0, destX: 220, destY: 0, wait: 400, mood: "wander", moodUntil: 0 },
  ];

  function bounds() {
    return {
      w: Math.max(160, window.innerWidth),
      h: Math.max(160, window.innerHeight),
    };
  }

  function clamp(dog) {
    const { w, h } = bounds();
    dog.x = Math.min(Math.max(8, dog.x), w - WIDTH - 8);
    dog.y = Math.min(Math.max(8, dog.y), h - HEIGHT - 8);
  }

  function pickSpot(dog, toward) {
    const { w, h } = bounds();
    if (toward) {
      dog.destX = toward.x + (Math.random() * 70 - 35);
      dog.destY = toward.y + (Math.random() * 36 - 18);
      clampDest(dog);
      return;
    }
    const roll = Math.random();
    if (roll < 0.6) {
      dog.destX = 10 + Math.random() * (w - WIDTH - 20);
      dog.destY = h - HEIGHT - 10 - Math.random() * Math.min(260, h * 0.42);
    } else if (roll < 0.82) {
      dog.destX = Math.random() < 0.5 ? 10 : w - WIDTH - 10;
      dog.destY = 64 + Math.random() * (h - HEIGHT - 80);
    } else {
      dog.destX = 10 + Math.random() * (w - WIDTH - 20);
      dog.destY = 48 + Math.random() * (h - HEIGHT - 64);
    }
    clampDest(dog);
  }

  function clampDest(dog) {
    const { w, h } = bounds();
    dog.destX = Math.min(Math.max(8, dog.destX), w - WIDTH - 8);
    dog.destY = Math.min(Math.max(8, dog.destY), h - HEIGHT - 8);
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function setMood(dog, mood, duration) {
    dog.mood = mood;
    dog.moodUntil = performance.now() + duration;
    dog.el.classList.toggle("is-playing", mood === "play");
    dog.el.classList.toggle("is-bowing", mood === "bow");
    dog.el.classList.toggle("is-spinning", mood === "spin");
  }

  function chooseFun(now) {
    const [a, b] = pack;
    if (a.mood !== "wander" || b.mood !== "wander") return;
    const together = dist(a, b) < 110;
    const roll = Math.random();
    if (together && roll < 0.55) {
      const game = roll < 0.22 ? "spin" : roll < 0.38 ? "bow" : "play";
      setMood(a, game, 1400 + Math.random() * 900);
      setMood(b, game === "bow" ? "play" : game, 1400 + Math.random() * 900);
      return;
    }
    if (roll < 0.18) {
      const chaser = Math.random() < 0.5 ? a : b;
      const chasee = chaser === a ? b : a;
      setMood(chaser, "chase", 2200);
      pickSpot(chaser, chasee);
    } else if (roll < 0.28) {
      pack.forEach((dog) => {
        setMood(dog, "zoomies", 1600);
        pickSpot(dog);
      });
    }
  }

  function speedFor(dog) {
    if (dog.mood === "zoomies") return 280;
    if (dog.mood === "chase") return 190;
    return 110;
  }

  pack.forEach((dog, index) => {
    const { h, w } = bounds();
    dog.y = h - HEIGHT - 18;
    dog.x = index === 0 ? 28 : Math.max(28, w - WIDTH - 48);
    dog.destX = dog.x;
    dog.destY = dog.y;
    pickSpot(dog);
  });

  let last = performance.now();
  let nextIdea = 0;

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (now > nextIdea) {
      chooseFun(now);
      nextIdea = now + 900 + Math.random() * 1400;
    }

    pack.forEach((dog, index) => {
      if (now > dog.moodUntil && dog.mood !== "wander") {
        setMood(dog, "wander", 0);
        pickSpot(dog);
      }

      if (dog.mood === "chase") {
        pickSpot(dog, pack[1 - index]);
      }

      const dx = dog.destX - dog.x;
      const dy = dog.destY - dog.y;
      const away = Math.hypot(dx, dy);
      const paused = dog.mood === "bow" || dog.mood === "spin" || dog.mood === "play";
      const moving = away > 4 && !paused;

      if (!moving) {
        dog.wait -= dt * 1000;
        if (dog.wait <= 0 && dog.mood === "wander") {
          pickSpot(dog, Math.random() < 0.28 ? pack[1 - index] : null);
          dog.wait = 280 + Math.random() * 900;
        }
      } else {
        const step = speedFor(dog) * dt;
        const reach = Math.min(1, step / away);
        dog.x += dx * reach;
        dog.y += dy * reach;
      }

      clamp(dog);
      const facing = dx < -2 ? -1 : dx > 2 ? 1 : Number(dog.el.dataset.facing || 1);
      dog.el.dataset.facing = String(facing);
      dog.el.classList.toggle("is-walking", moving);
      dog.el.style.transform = `translate(${dog.x}px, ${dog.y}px) scaleX(${facing})`;
    });

    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", () => pack.forEach(clamp));
  requestAnimationFrame(tick);
})();
