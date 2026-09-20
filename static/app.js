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

  function view() {
    const port = window.visualViewport;
    return {
      w: Math.max(180, port ? port.width : window.innerWidth),
      h: Math.max(180, port ? port.height : window.innerHeight),
      left: port ? port.offsetLeft : 0,
      top: port ? port.offsetTop : 0,
    };
  }

  function size() {
    return {
      w: golden.offsetWidth || (view().w <= 520 ? 96 : 132),
      h: golden.offsetHeight || (view().w <= 520 ? 70 : 96),
    };
  }

  function isPhone() {
    return view().w <= 520;
  }

  function pad() {
    const phone = isPhone();
    return { x: phone ? 6 : 10, y: phone ? 8 : 10 };
  }

  const pack = [
    makeDog(golden, 1),
    makeDog(poodle, -1),
  ];

  function makeDog(el, facing) {
    return {
      el,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      destX: 0,
      destY: 0,
      arc: 0,
      trip: 1,
      startX: 0,
      startY: 0,
      facing,
      lean: 0,
      hop: 0,
      hopV: 0,
      wait: 0,
      mood: "wander",
      moodUntil: 0,
      orbit: Math.random() * Math.PI * 2,
    };
  }

  function clampToYard(x, y) {
    const { w, h } = view();
    const { w: W, h: H } = size();
    const p = pad();
    return {
      x: Math.min(Math.max(p.x, x), Math.max(p.x, w - W - p.x)),
      y: Math.min(Math.max(p.y, y), Math.max(p.y, h - H - p.y)),
    };
  }

  function clampDog(dog) {
    const next = clampToYard(dog.x, dog.y);
    dog.x = next.x;
    dog.y = next.y;
  }

  function pickSpot(dog, toward) {
    const { w, h } = view();
    const { w: W, h: H } = size();
    const phone = isPhone();
    dog.startX = dog.x;
    dog.startY = dog.y;
    dog.trip = 1;
    dog.arc = (Math.random() * 2 - 1) * (phone ? 28 : 48);

    if (toward) {
      dog.destX = toward.x + (Math.random() * 56 - 28);
      dog.destY = toward.y + (Math.random() * 28 - 14);
    } else {
      const roll = Math.random();
      const floor = h - H - pad().y;
      if (phone || roll < 0.62) {
        dog.destX = pad().x + Math.random() * Math.max(8, w - W - pad().x * 2);
        dog.destY = floor - Math.random() * Math.min(phone ? h * 0.38 : 240, h * 0.4);
      } else if (roll < 0.84) {
        dog.destX = Math.random() < 0.5 ? pad().x : w - W - pad().x;
        dog.destY = 56 + Math.random() * Math.max(8, h - H - 72);
      } else {
        dog.destX = pad().x + Math.random() * Math.max(8, w - W - pad().x * 2);
        dog.destY = 40 + Math.random() * Math.max(8, h - H - 56);
      }
    }

    const dest = clampToYard(dog.destX, dog.destY);
    dog.destX = dest.x;
    dog.destY = dest.y;
    const span = Math.hypot(dog.destX - dog.startX, dog.destY - dog.startY);
    dog.trip = Math.max(40, span);
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function setMood(dog, mood, duration) {
    dog.mood = mood;
    dog.moodUntil = performance.now() + duration;
    const playing = mood === "play";
    const excited = playing || mood === "chase" || mood === "zoomies" || mood === "circle" || mood === "bow";
    dog.el.classList.toggle("is-playing", playing);
    dog.el.classList.toggle("is-bowing", mood === "bow");
    dog.el.classList.toggle("is-sitting", mood === "sit");
    dog.el.classList.toggle("is-sniffing", mood === "sniff");
    dog.el.classList.toggle("is-circling", mood === "circle");
    dog.el.classList.toggle("is-excited", excited);
  }

  function chooseFun(now) {
    const [a, b] = pack;
    if (a.mood !== "wander" || b.mood !== "wander") return;

    const close = dist(a, b) < (isPhone() ? 88 : 120);
    const roll = Math.random();

    if (close && roll < 0.72) {
      if (roll < 0.22) {
        setMood(a, "bow", 1600);
        setMood(b, "sit", 1600);
      } else if (roll < 0.4) {
        setMood(a, "sit", 1800);
        setMood(b, "sit", 1800);
      } else if (roll < 0.55) {
        a.orbit = 0;
        b.orbit = Math.PI;
        setMood(a, "circle", 2400);
        setMood(b, "circle", 2400);
      } else {
        setMood(a, "play", 1700);
        setMood(b, "play", 1700);
      }
      return;
    }

    if (roll < 0.34) {
      const chaser = Math.random() < 0.5 ? a : b;
      setMood(chaser, "chase", 2600);
      pickSpot(chaser, chaser === a ? b : a);
    } else if (roll < 0.46) {
      pack.forEach((dog) => {
        setMood(dog, "zoomies", 1500);
        pickSpot(dog);
      });
    } else if (roll < 0.58) {
      const sniffer = Math.random() < 0.5 ? a : b;
      setMood(sniffer, "sniff", 1100);
    }
  }

  function maxSpeed(dog) {
    const phone = isPhone();
    if (dog.mood === "zoomies") return phone ? 210 : 260;
    if (dog.mood === "chase" || dog.mood === "circle") return phone ? 150 : 180;
    if (dog.mood === "play") return phone ? 70 : 90;
    return phone ? 78 : 96;
  }

  function steer(dog, aimX, aimY, dt) {
    const dx = aimX - dog.x;
    const dy = aimY - dog.y;
    const away = Math.hypot(dx, dy);
    const slow = isPhone() ? 64 : 86;
    const top = maxSpeed(dog);
    const want = away < 6 ? 0 : top * Math.min(1, away / slow);
    const nx = away > 0.001 ? dx / away : 0;
    const ny = away > 0.001 ? dy / away : 0;
    const accel = dog.mood === "zoomies" ? 7.5 : 4.2;
    dog.vx += (nx * want - dog.vx) * Math.min(1, accel * dt);
    dog.vy += (ny * want - dog.vy) * Math.min(1, accel * dt);
    dog.x += dog.vx * dt;
    dog.y += dog.vy * dt;
    return away;
  }

  function aimPoint(dog) {
    const dx = dog.destX - dog.startX;
    const dy = dog.destY - dog.startY;
    const remaining = Math.hypot(dog.destX - dog.x, dog.destY - dog.y);
    const done = 1 - Math.min(1, remaining / dog.trip);
    const lift = Math.sin(Math.max(0, done) * Math.PI) * dog.arc;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: dog.destX - (dy / len) * lift,
      y: dog.destY + (dx / len) * lift,
    };
  }

  pack.forEach((dog, index) => {
    const { w, h } = view();
    const { w: W, h: H } = size();
    dog.y = h - H - pad().y - 6;
    dog.x = index === 0 ? pad().x + 12 : Math.max(pad().x + 12, w - W - pad().x - 18);
    dog.destX = dog.x;
    dog.destY = dog.y;
    pickSpot(dog, pack[1 - index]);
  });

  let last = performance.now();
  let nextIdea = 0;
  let raf = 0;

  function tick(now) {
    const dt = Math.min(0.04, (now - last) / 1000);
    last = now;
    const phone = isPhone();
    const { w: W } = size();

    if (now > nextIdea) {
      chooseFun(now);
      nextIdea = now + (phone ? 1100 : 900) + Math.random() * 1200;
    }

    const midX = (pack[0].x + pack[1].x) / 2;
    const midY = (pack[0].y + pack[1].y) / 2;

    pack.forEach((dog, index) => {
      const other = pack[1 - index];
      if (now > dog.moodUntil && dog.mood !== "wander") {
        setMood(dog, "wander", 0);
        pickSpot(dog, Math.random() < 0.55 ? other : null);
      }

      const posed = dog.mood === "bow" || dog.mood === "sit" || dog.mood === "sniff";
      let moving = false;

      if (dog.mood === "circle") {
        dog.orbit += dt * (phone ? 1.7 : 1.45);
        const radius = phone ? 34 : 46;
        const aimX = midX + Math.cos(dog.orbit) * radius - W * 0.15;
        const aimY = midY + Math.sin(dog.orbit) * radius * 0.45;
        steer(dog, aimX, aimY, dt);
        moving = true;
      } else if (dog.mood === "chase") {
        steer(dog, other.x, other.y, dt);
        moving = Math.hypot(dog.vx, dog.vy) > 8;
      } else if (!posed) {
        const aim = aimPoint(dog);
        const away = steer(dog, aim.x, aim.y, dt);
        moving = away > 8 && Math.hypot(dog.vx, dog.vy) > 6;
        if (!moving) {
          dog.vx *= 0.82;
          dog.vy *= 0.82;
          dog.wait -= dt * 1000;
          if (dog.wait <= 0 && dog.mood === "wander") {
            pickSpot(dog, Math.random() < 0.5 ? other : null);
            dog.wait = 420 + Math.random() * 900;
          }
        }
      } else {
        dog.vx *= 0.7;
        dog.vy *= 0.7;
      }

      if (dog.mood === "play") {
        dog.hopV -= (phone ? 1600 : 1450) * dt;
        dog.hop += dog.hopV * dt;
        if (dog.hop < 0) {
          dog.hop = 0;
          dog.hopV = phone ? 240 : 300;
        }
      } else if (dog.hop > 0) {
        dog.hopV -= 1600 * dt;
        dog.hop = Math.max(0, dog.hop + dog.hopV * dt);
        if (dog.hop === 0) dog.hopV = 0;
      }

      clampDog(dog);

      const speed = Math.hypot(dog.vx, dog.vy);
      if (speed > 14) {
        const want = dog.vx >= 0 ? 1 : -1;
        if (dog.facing * want < 0) {
          dog.facing += want * 7.5 * dt;
        } else {
          dog.facing += (want - dog.facing) * Math.min(1, 9 * dt);
        }
        dog.facing = Math.max(-1, Math.min(1, dog.facing));
      }

      const wantLean = Math.max(-8, Math.min(8, dog.vx * 0.035));
      dog.lean += (wantLean - dog.lean) * Math.min(1, 6 * dt);

      const gait = Math.max(0.34, 0.56 - speed / 820);
      dog.el.style.setProperty("--gait", `${gait.toFixed(2)}s`);
      dog.el.classList.toggle("is-walking", moving && !posed && dog.mood !== "play");

      const { left, top } = view();
      dog.el.style.transform =
        `translate3d(${(left + dog.x).toFixed(1)}px, ${(top + dog.y - dog.hop).toFixed(1)}px, 0) ` +
        `rotate(${dog.lean.toFixed(2)}deg) scaleX(${dog.facing.toFixed(3)})`;
    });
  }

  function loop(now) {
    tick(now);
    raf = requestAnimationFrame(loop);
  }

  function resume() {
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else resume();
  });
  window.addEventListener("resize", () => pack.forEach(clampDog), { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => pack.forEach(clampDog), { passive: true });
    window.visualViewport.addEventListener("scroll", () => pack.forEach(clampDog), { passive: true });
  }

  resume();
})();
