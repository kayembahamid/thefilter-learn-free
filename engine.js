/* =========================================================================
   THE FILTER AI · engine.js
   Game logic for the Mimo-style units/steps model, plus the paid hub.

   Reads UNITS (and helpers) from content.js, RANGE from range.js (when it
   ships), LAB_CONFIG from lab/lab-config.js, and certificateRank /
   buildCertificateSVG / downloadCertificatePNG from certificate.js.
   No inline scripts, no server, no build step.

   Each unit is an ordered `steps` array that interleaves:
     "teach"          read-only micro-lesson (no XP, Continue only)
     "allow-block"    Allow or Block
     "tap-injection"  tap the malicious span
     "name-technique" pick the OWASP category (two tries)

   Every exercise carries its own `xp`, a `difficulty`, and an `impact` block
   ({ headline, detail }) rendered after the answer as the "stakes" footnote.

   ROUTES (hash based, so deep links and Back work on a static host):
     #/            hub for paid players, intro for everyone else
     #/hub         the paid home: Course, Practice Range, Lab, badges
     #/course      the unit flow (state.pos decides where you are)
     #/range[/id]  the Practice Range, optionally scrolled to one stage
     #/lab[/id]    the Lab, rendered by lab/lab.js (paid build only)
     #/review/id   reopen any course step without touching progress
     #/unlock      the purchase screen

   The exercise renderers take a small context object ({ topline, onAnswer,
   onContinue, continueLabel }) so the course and the Lab drive the same
   code. Lab files reach them through window.FILTER.
   ========================================================================= */

(function () {
  "use strict";

  /* ---------- config (editable in index.html via data-* on #app) ---------- */
  var appEl = document.getElementById("app");
  var ds = (appEl && appEl.dataset) || {};
  var CONFIG = {
    purchaseKey: ds.purchaseKey || "",
    gumroadUrl:  ds.gumroadUrl  || "https://gumroad.com/checkout?product=jxdjnw",
    price:       ds.price       || "$39.90",
    fullUrl:     ds.fullUrl     || "https://private.hamcodes.com"
  };

  var STORAGE_KEY  = "thefilter_state";
  var PURCHASE_KEY = "thefilter_purchase_key";

  // Free-only build: the public deploy ships Unit 1 plus locked placeholders
  // for the paid units. In this mode paid units never unlock and the gate has
  // no key box (there is no paid content on the page to unlock).
  var FREE_ONLY = !!(ds.freeOnly === "true");

  var LABCFG = (typeof LAB_CONFIG !== "undefined" && LAB_CONFIG) ? LAB_CONFIG : { name: "Build & Break Lab" };
  var LAB_API = null;               // set by lab/lab.js via FILTER.registerLab

  /* ---------- flatten UNITS -> ordered step list with context ---------- */
  var FLAT = [];
  var UNIT_META = [];
  var STEP_INDEX = {};              // step id -> FLAT position
  (function buildIndex() {
    var exCount = 0;
    UNITS.forEach(function (u, ui) {
      var firstPos = FLAT.length;
      u.steps.forEach(function (s, si) {
        var isEx = s.type !== "teach";
        if (isEx) exCount++;
        if (s.id) STEP_INDEX[s.id] = FLAT.length;
        FLAT.push({
          unit: u, unitIndex: ui, step: s,
          stepIndexInUnit: si,
          isFirstStepInUnit: si === 0,
          isLastStepInUnit: si === u.steps.length - 1,
          isExercise: isEx,
          exerciseNo: isEx ? exCount : null
        });
      });
      UNIT_META.push({ unit: u, firstPos: firstPos, lastPos: FLAT.length - 1 });
    });
  })();

  var N_STEPS = FLAT.length;
  var N_EX    = ALL_EXERCISES.length;
  var N_UNITS = UNITS.length;
  var FREE_EX = FREE_UNITS.reduce(function (n, u) {
    return n + u.steps.filter(function (s) { return s.type !== "teach"; }).length;
  }, 0);

  var $ = function (id) { return document.getElementById(id); };
  var screenEl = $("screen");

  /* ---------- state ---------- */
  function defaultState() {
    return {
      xp: 0, streak: 0, bestStreak: 0,
      pos: 0,
      falseAlarms: 0, breaches: 0, caughtAttacks: 0,
      correctTotal: 0, totalAnswered: 0,
      awardedBonuses: [],   // unit ids that have paid out their bonus
      unitStart: null,      // snapshot at current unit's first step
      rangeDone: {},        // Practice Range resources ticked as tried
      lab: {}               // Lab progress, owned by lab/lab.js
    };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { return defaultState(); }
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  var state = loadState();

  /* ---------- purchase / unlock ---------- */
  function normKey(k) { return String(k || "").trim().toLowerCase(); }
  function isPurchased() {
    var stored = "";
    try { stored = localStorage.getItem(PURCHASE_KEY); } catch (e) {}
    return !!CONFIG.purchaseKey && normKey(stored) === normKey(CONFIG.purchaseKey);
  }
  // Paid AND on the full build. The free build never counts as paid, even
  // with a key in storage, because the paid content is not on the page.
  function isPaid() { return !FREE_ONLY && isPurchased(); }
  function isUnitUnlocked(unit) {
    if (unit.free) return true;
    return isPaid();
  }
  function tryUnlock(input) {
    if (CONFIG.purchaseKey && normKey(input) === normKey(CONFIG.purchaseKey)) {
      try { localStorage.setItem(PURCHASE_KEY, String(input).trim()); } catch (e) {}
      return true;
    }
    return false;
  }

  /* ---------- derived progress ---------- */
  function exercisesDone() {
    var n = 0;
    for (var i = 0; i < Math.min(state.pos, N_STEPS); i++) if (FLAT[i].isExercise) n++;
    return n;
  }
  function coursePct() { return Math.min(100, Math.round(exercisesDone() / N_EX * 100)); }
  function labXp() { return (state.lab && state.lab.xp) || 0; }
  function rangeKey(sec, it) {
    return sec.id + ":" + String(it.title).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }
  function rangeDoneCount() {
    var n = 0;
    for (var k in state.rangeDone) if (state.rangeDone[k]) n++;
    return n;
  }

  /* ---------- chrome: header, course HUD, unit map ---------- */
  var currentView = "";

  function currentUnitIndex() {
    if (state.pos >= N_STEPS) return N_UNITS - 1;
    return FLAT[state.pos].unitIndex;
  }

  function renderHeader() {
    var paid = isPaid();
    $("proBadge").hidden = !paid;
    $("freeBadge").hidden = paid;
    $("navHub").hidden = !paid;
    $("navBuy").hidden = paid;
    $("navLab").innerHTML = esc(LABCFG.name) + (paid ? "" : " <span class='lock' aria-label='Pro'>PRO</span>");
    $("hudXp").textContent = (state.xp + labXp()) + " XP";
    $("hudStreak").textContent = "🔥 " + state.streak;
    var links = document.querySelectorAll("#topnav a[data-nav]");
    for (var i = 0; i < links.length; i++) {
      if (links[i].dataset.nav === currentView) links[i].setAttribute("aria-current", "page");
      else links[i].removeAttribute("aria-current");
    }
  }

  function renderHUD() {
    var ui = currentUnitIndex();
    $("hudLevel").innerHTML = "Unit <b>" + (ui + 1) + "</b> / " + N_UNITS + " · " + esc(UNITS[ui].title);
    var done = exercisesDone();
    var max = isPaid() ? N_EX : FREE_EX;
    $("hudEx").textContent = Math.min(done, max) + " / " + max + " exercises";
    $("progressFill").style.width = Math.round(Math.min(done, max) / max * 100) + "%";
  }

  function renderUnitMap() {
    var el = $("levelmap");
    if (!el) return;
    var html = "<div class='lm-title'>Units</div>";
    UNIT_META.forEach(function (m, ui) {
      var done    = state.pos > m.lastPos;
      var current = state.pos >= m.firstPos && state.pos <= m.lastPos;
      var locked  = !isUnitUnlocked(m.unit) && !done;
      var cls = "lm-item";
      if (done) cls += " done";
      if (current) cls += " current";
      if (locked) cls += " locked";
      html += "<div class='" + cls + "'>" +
                "<span class='n'>" + (ui + 1) + "</span>" +
                "<span class='tier'>" + (m.unit.free ? "free" : "pro") + "</span>" +
              "</div>";
    });
    el.innerHTML = html;
  }

  function refreshChrome() { renderHeader(); renderHUD(); renderUnitMap(); }

  /* Switch the page into one of the views. Wide views (hub, range, lab) break
     out of the reading column; the course HUD and unit map only show in the
     course view. */
  function setView(view) {
    var changed = view !== currentView;
    currentView = view;
    ["course", "hub", "range", "lab"].forEach(function (v) {
      document.body.classList.toggle("view-" + v, v === view);
    });
    $("courseHud").hidden = view !== "course";
    refreshChrome();
    if (changed) {
      try { window.scrollTo(0, 0); } catch (e) {}
    }
  }

  function focusScreen() {
    try { screenEl.focus({ preventScroll: true }); } catch (e) {}
  }

  /* ---------- routing ---------- */
  function parseHash() {
    var h = String(location.hash || "").replace(/^#\/?/, "");
    var parts = h.split("/");
    return { name: parts[0] || "", arg: decodeURIComponent(parts.slice(1).join("/")) };
  }
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }
  function home() { return isPaid() ? renderHub() : showIntro(); }

  function route() {
    var r = parseHash();
    switch (r.name) {
      case "":
      case "hub":    home(); break;
      case "course": openCourse(); break;
      case "range":  showRange(r.arg); break;
      case "lab":    showLab(r.arg); break;
      case "review": renderReview(r.arg); break;
      case "unlock": renderGate(true); break;
      default:       home();
    }
    focusScreen();
  }

  function openCourse() {
    setView("course");
    if (state.pos >= N_STEPS) renderComplete(); else renderCurrent();
  }

  /* ---------- scoring ---------- */
  // Returns { gained, bonus }. Streak bonus of +10 every 5 correct in a row.
  function applyResult(correct, baseXp) {
    state.totalAnswered++;
    var gained = 0, bonus = 0;
    if (correct) {
      state.correctTotal++;
      state.streak++;
      if (state.streak > state.bestStreak) state.bestStreak = state.streak;
      gained = baseXp;
      if (state.streak % 5 === 0) { bonus = 10; gained += 10; }
      state.xp += gained;
    } else {
      state.streak = 0;
    }
    saveState();
    refreshChrome();
    return { gained: gained, bonus: bonus };
  }

  // The course's own tally of threats caught, breaches and false alarms.
  function courseTally(info) {
    if (info.type === "allow-block") {
      if (info.attack && info.blocked)  state.caughtAttacks++;
      if (info.attack && !info.blocked) state.breaches++;
      if (!info.attack && info.blocked) state.falseAlarms++;
    } else if (info.type === "tap-injection") {
      if (info.correct) state.caughtAttacks++; else state.breaches++;
    } else if (info.correct) {
      state.caughtAttacks++;
    }
  }

  function xpChipHTML(res) {
    if (!res || !res.gained) return "";
    var base = res.gained - res.bonus;
    var h = "<span class='chip xp'>+" + base + " XP</span>";
    if (res.bonus) h += "<span class='chip xp'>+" + res.bonus + " streak</span>";
    return h;
  }

  /* ---------- feedback building blocks ---------- */
  function whyHTML(item) {
    return "<div class='fb-why'><div class='fb-label'>Why</div>" +
           "<div class='fb-text'>" + esc(item.why) + "</div></div>";
  }
  function impactHTML(item, isThreat) {
    if (!item.impact) return "";
    var label = item.impact.label || (isThreat ? "If you miss this" : "The cost of blocking this");
    var cls   = isThreat ? "threat" : "benign";
    return "<div class='impact " + cls + "'>" +
             "<div class='impact-label'>" + esc(label) + "</div>" +
             "<div class='impact-headline'>" + esc(item.impact.headline) + "</div>" +
             "<div class='impact-detail'>" + esc(item.impact.detail) + "</div>" +
           "</div>";
  }

  /* ---------- exercise context ---------- */
  function exTopline(label, difficulty) {
    var diff = difficulty ? "<span class='ex-diff " + esc(difficulty) + "'>" + esc(difficulty) + "</span>" : "";
    return "<div class='ex-topline'><span class='ex-count'>" + esc(label) + "</span>" + diff + "</div>";
  }

  function courseCtx(entry) {
    return {
      topline: exTopline("Exercise " + entry.exerciseNo + " / " + N_EX, entry.step.difficulty),
      continueLabel: (state.pos >= N_STEPS - 1) ? "See your result →" : "Continue →",
      onContinue: advance,
      onAnswer: function (info) { courseTally(info); return applyResult(info.correct, info.xp); }
    };
  }

  function continueBtn(ctx) {
    return "<button class='btn full' id='next'>" + esc(ctx.continueLabel || "Continue →") + "</button>";
  }
  function wireContinue(ctx) {
    var n = $("next");
    n.onclick = function () { ctx.onContinue(); };
    n.focus();
  }
  function target(ctx) { return ctx.el || screenEl; }

  function renderExercise(item, ctx) {
    var t = item.type;
    if (t === "allow-block")    return renderAllowBlock(item, ctx);
    if (t === "tap-injection")  return renderTapInjection(item, ctx);
    if (t === "name-technique") return renderNameTechnique(item, ctx);
    target(ctx).innerHTML = "<div class='panel'><p>Unknown exercise type.</p></div>";
  }

  /* ---------- advance through the flattened list ---------- */
  function advance() {
    var cur = FLAT[state.pos];
    state.pos++;
    saveState();

    if (cur.isLastStepInUnit) {
      awardBonus(cur.unit);
      if (state.pos >= N_STEPS) { renderComplete(); return; }
      var nextUnit = FLAT[state.pos].unit;
      if (!isUnitUnlocked(nextUnit)) { renderCurrent(); return; }
      renderUnitComplete(cur.unit); return;
    }
    renderCurrent();
  }

  function awardBonus(unit) {
    if (state.awardedBonuses.indexOf(unit.id) !== -1) return;
    state.awardedBonuses.push(unit.id);
    state.xp += unit.bonusXp || 0;
    saveState();
    refreshChrome();
  }

  function renderCurrent() {
    setView("course");
    if (state.pos >= N_STEPS) return renderComplete();
    var entry = FLAT[state.pos];

    if (entry.isFirstStepInUnit && !isUnitUnlocked(entry.unit)) return renderGate();
    if (entry.isFirstStepInUnit) {
      state.unitStart = { unitId: entry.unit.id, xp: state.xp,
                          correct: state.correctTotal, answered: state.totalAnswered };
      saveState();
    }

    if (entry.step.type === "teach") return renderConceptCard(entry);
    return renderExercise(entry.step, courseCtx(entry));
  }

  /* ---------- TEACH: concept card (no XP) ---------- */
  // Tiny markup for Lab copy: **bold**, `code`, and paragraphs whose lines
  // all start with "- " become lists. Course copy stays plain text.
  function rich(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function paragraphs(body, isRich) {
    return String(body || "").split(/\n\s*\n/).map(function (p) {
      if (!isRich) return "<p>" + esc(p) + "</p>";
      var lines = p.split("\n");
      if (lines.every(function (l) { return /^\s*- /.test(l); })) {
        return "<ul>" + lines.map(function (l) { return "<li>" + rich(l.replace(/^\s*- /, "")) + "</li>"; }).join("") + "</ul>";
      }
      return "<p>" + rich(p) + "</p>";
    }).join("");
  }

  function teachHTML(s, opts) {
    opts = opts || {};
    var example = s.example
      ? "<div class='teach-example'>" +
          "<div class='ex-label'>" + esc(s.example.label) + "</div>" +
          "<div class='ex-body'>" + (opts.rich ? rich(s.example.text) : esc(s.example.text)) + "</div>" +
        "</div>"
      : "";
    var keyIdea = s.keyIdea ? "<div class='teach-key'>" + esc(s.keyIdea) + "</div>" : "";
    return (opts.tag || "") +
      "<div class='teach'>" +
        "<div class='teach-label'>" + esc(opts.label || "Concept") + "</div>" +
        "<h2 class='teach-heading'>" + esc(s.heading) + "</h2>" +
        "<div class='teach-body'>" + paragraphs(s.body, opts.rich) + "</div>" +
        (opts.extra || "") +
        example +
        keyIdea +
      "</div>";
  }

  function unitTag(u, ui) {
    return "<div class='unit-tag'>Unit " + (ui + 1) + " · " + esc(u.owasp) + " · " + esc(u.title) + "</div>";
  }

  function renderConceptCard(entry) {
    screenEl.innerHTML = teachHTML(entry.step, { tag: unitTag(entry.unit, entry.unitIndex) }) +
      "<button class='btn full' id='next'>Continue →</button>";
    wireContinue({ onContinue: advance });
  }

  /* ---------- TYPE 1: allow / block ---------- */
  function renderAllowBlock(item, ctx) {
    var cardHTML = item.card
      ? "<div class='card'><div class='from'>" + esc(item.card.from) + "</div>" +
        "<div class='body'>" + esc(item.card.body) + "</div></div>"
      : "";
    target(ctx).innerHTML =
      (ctx.before || "") + ctx.topline +
      "<p class='prompt-line'>" + esc(item.promptLine || "Incoming prompt. Allow it through, or block it?") + "</p>" +
      "<div class='inbox'>" +
        "<div class='inbox-head'><span class='live'></span>" +
          esc(item.tag || "Incoming prompt") + " · awaiting your call</div>" +
        "<div class='inbox-body'>" +
          "<div class='meta'>" + esc(item.meta || "") + "</div>" +
          "<div class='ptext'>" + esc(item.text) + "</div>" +
          cardHTML +
          "<div class='verdict-row'>" +
            "<button class='vbtn allow' id='bAllow'>" + esc(item.allowLabel || "Allow") + "<span class='kbd'>A</span></button>" +
            "<button class='vbtn block' id='bBlock'>" + esc(item.blockLabel || "Block") + "<span class='kbd'>B</span></button>" +
          "</div>" +
        "</div>" +
      "</div>";
    $("bAllow").onclick = function () { decideAllowBlock(item, ctx, false); };
    $("bBlock").onclick = function () { decideAllowBlock(item, ctx, true); };
  }

  function decideAllowBlock(item, ctx, blocked) {
    var correct = blocked === item.attack;
    var res = ctx.onAnswer({ type: "allow-block", correct: correct, attack: item.attack,
                             blocked: blocked, xp: item.xp || 20 });

    var btns = document.querySelectorAll(".vbtn");
    for (var i = 0; i < btns.length; i++) { btns[i].disabled = true; btns[i].onclick = null; }

    var head;
    if (item.attack) head = blocked ? "Attack blocked" : "Breach, this attack got through";
    else             head = blocked ? "False alarm, you blocked a real user" : "Allowed, correct";

    var chip = item.tech
      ? (item.attack ? "<span class='chip tech'>" + esc(item.tech) + "</span>"
                     : "<span class='chip safe'>" + esc(item.tech) + "</span>")
      : "";

    target(ctx).insertAdjacentHTML("beforeend",
      "<div class='fb " + (correct ? "right" : "wrong") + "' role='status'>" +
        "<div class='head'><span class='res'>" + head + "</span>" + chip +
          (correct ? xpChipHTML(res) : "") + "</div>" +
        whyHTML(item) +
        impactHTML(item, item.attack) +
      "</div>" + continueBtn(ctx));
    wireContinue(ctx);
  }

  /* ---------- TYPE 2: tap the injection ---------- */
  function renderTapInjection(item, ctx) {
    var segs = "";
    item.segments.forEach(function (s, idx) {
      segs += "<span class='seg' role='button' tabindex='0' data-i='" + idx + "'>" + esc(s.t) + "</span>";
    });
    target(ctx).innerHTML =
      (ctx.before || "") + ctx.topline +
      "<p class='prompt-line'>" + esc(item.prompt) + "</p>" +
      "<p class='hint'>" + esc(item.hint || "Tap the one span that's an instruction, not content.") + "</p>" +
      "<div class='doc'>" +
        "<div class='doc-head'><span class='dot'></span>" + esc(item.source) + "</div>" +
        "<div class='doc-body' id='docBody'>" + segs + "</div>" +
      "</div>";
    document.querySelectorAll(".seg").forEach(function (el) {
      el.onclick = function () { pickInjection(item, ctx, parseInt(el.dataset.i, 10), el); };
      el.onkeydown = function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); el.onclick(); }
      };
    });
  }

  function pickInjection(item, ctx, idx, el) {
    var correct = !!item.segments[idx].injection;
    $("docBody").classList.add("locked");
    document.querySelectorAll(".seg").forEach(function (s) {
      s.onclick = null; s.onkeydown = null; s.removeAttribute("tabindex"); s.removeAttribute("role");
    });

    if (correct) {
      el.classList.add("pick-right");
    } else {
      el.classList.add("pick-wrong");
      var realIdx = item.segments.findIndex(function (s) { return s.injection; });
      var realEl = document.querySelector(".seg[data-i='" + realIdx + "']");
      if (realEl) realEl.classList.add("reveal");
    }

    var res = ctx.onAnswer({ type: "tap-injection", correct: correct, xp: item.xp || 25 });
    var head = correct ? "Found it" : "Not quite. The highlighted line was the attack";

    target(ctx).insertAdjacentHTML("beforeend",
      "<div class='fb " + (correct ? "right" : "wrong") + "' role='status'>" +
        "<div class='head'><span class='res'>" + head + "</span>" +
          (correct ? xpChipHTML(res) : "") + "</div>" +
        whyHTML(item) +
        impactHTML(item, true) +
      "</div>" + continueBtn(ctx));
    wireContinue(ctx);
  }

  /* ---------- TYPE 3: name the technique (two attempts, then reveal) ---------- */
  function renderNameTechnique(item, ctx) {
    var opts = "";
    item.options.forEach(function (o, idx) {
      opts += "<button type='button' class='opt' data-o='" + idx + "'>" +
                "<span class='radio'></span><span class='lbl'>" + esc(o) + "</span>" +
              "</button>";
    });
    target(ctx).innerHTML =
      (ctx.before || "") + ctx.topline +
      "<p class='prompt-line'>" + esc(item.promptLine || "Name the technique.") + "</p>" +
      "<div class='scenario'>" + esc(item.scenario) + "</div>" +
      "<div class='opts' id='opts'>" + opts + "</div>" +
      "<div class='retry-note' id='retryNote' role='status'></div>" +
      "<button class='btn full' id='submitTech' disabled>Submit</button>";

    var st = { attempts: 0, selected: null };
    document.querySelectorAll(".opt").forEach(function (btn) {
      btn.onclick = function () {
        if (btn.disabled) return;
        document.querySelectorAll(".opt").forEach(function (b) { b.classList.remove("sel"); });
        btn.classList.add("sel");
        st.selected = parseInt(btn.dataset.o, 10);
        $("submitTech").disabled = false;
      };
    });
    $("submitTech").onclick = function () { submitTech(item, ctx, st); };
  }

  function submitTech(item, ctx, st) {
    if (st.selected == null) return;
    var isCorrect = item.options[st.selected] === item.correct;
    st.attempts++;
    var selBtn = document.querySelector(".opt[data-o='" + st.selected + "']");

    if (isCorrect) {
      selBtn.classList.remove("sel");
      selBtn.classList.add("correct");
      finishTech(item, ctx, true, st.attempts === 1 ? (item.xp || 15) : 5);
      return;
    }

    selBtn.classList.remove("sel");
    selBtn.classList.add("wrong", "dim");
    selBtn.disabled = true;

    if (st.attempts >= 2) {
      var correctIdx = item.options.indexOf(item.correct);
      var cBtn = document.querySelector(".opt[data-o='" + correctIdx + "']");
      if (cBtn) cBtn.classList.add("correct");
      finishTech(item, ctx, false, 0);
    } else {
      $("retryNote").textContent = "Not quite. One more try, no penalty.";
      $("submitTech").disabled = true;
      st.selected = null;
    }
  }

  function finishTech(item, ctx, correct, xp) {
    document.querySelectorAll(".opt").forEach(function (b) { b.disabled = true; b.onclick = null; });
    var submit = $("submitTech"); if (submit) submit.remove();
    var note = $("retryNote"); if (note) note.textContent = "";

    var res = ctx.onAnswer({ type: "name-technique", correct: correct, xp: xp });
    var head = correct ? "Correct" : "Revealed: " + item.correct;

    target(ctx).insertAdjacentHTML("beforeend",
      "<div class='fb " + (correct ? "right" : "wrong") + "' role='status'>" +
        "<div class='head'><span class='res'>" + esc(head) + "</span>" +
          (correct ? xpChipHTML(res) : "") + "</div>" +
        whyHTML(item) +
        impactHTML(item, item.attack !== false) +
      "</div>" + continueBtn(ctx));
    wireContinue(ctx);
  }

  /* ---------- unit complete (paid units) ---------- */
  function renderUnitComplete(unit) {
    setView("course");
    var base = state.unitStart && state.unitStart.unitId === unit.id
      ? state.unitStart
      : { xp: state.xp, correct: state.correctTotal, answered: state.totalAnswered };
    var xpEarned = state.xp - base.xp;
    var answered = state.totalAnswered - base.answered;
    var correct  = state.correctTotal - base.correct;
    var pct = answered ? Math.round(correct / answered * 100) : 100;
    var uNum = UNITS.indexOf(unit) + 1;

    screenEl.innerHTML =
      "<div class='unit-complete'>" +
        "<div class='uc-badge'>Unit " + uNum + " complete</div>" +
        "<h2>" + esc(unit.title) + "</h2>" +
        "<p class='uc-sub'>" + esc(unit.subtitle) + "</p>" +
        "<div class='stat-grid'>" +
          "<div class='stat-cell caught'><div class='v'>+" + xpEarned + "</div><div class='k'>XP this unit</div></div>" +
          "<div class='stat-cell false'><div class='v'>" + pct + "%</div><div class='k'>Accuracy</div></div>" +
          "<div class='stat-cell'><div class='v'>" + state.bestStreak + "</div><div class='k'>Best streak</div></div>" +
        "</div>" +
        "<button class='btn full' id='next'>Continue →</button>" +
        (isPaid() ? "<a class='btn ghost full' href='#/hub'>Back to the hub</a>" : "") +
      "</div>";
    wireContinue({ onContinue: renderCurrent });
  }

  /* ---------- intro (free players, and anyone without the key) ---------- */
  function showIntro() {
    setView("course");
    $("courseHud").hidden = true;
    var hasProgress = state.totalAnswered > 0 || state.pos > 0;
    screenEl.innerHTML =
      "<div class='panel'>" +
        "<h1>THE <span class='b'>FILTER</span></h1>" +
        "<p class='tagline'>You are the guardrail · OWASP LLM Top 10 for Applications 2025</p>" +
        "<p class='lede'>You sit in the seat of an AI guardrail. Your job: let real users through, and catch the attacks before they reach the model.</p>" +
        "<ul class='howto'>" +
          "<li><span class='ic'>1</span><div>Every prompt could be legitimate, or a <b>prompt injection</b>, a jailbreak, an encoded payload, or an instruction hidden inside a document.</div></li>" +
          "<li><span class='ic'>2</span><div>You score on two numbers: <b>threats caught</b> AND <b>false alarms</b>. A filter that blocks everything is as useless as one that blocks nothing.</div></li>" +
          "<li><span class='ic'>3</span><div>Short lessons, then drills. <b>Allow / Block</b>, <b>Tap the injection</b>, <b>Name the technique</b>. Earn XP, build streaks, finish with a certificate.</div></li>" +
        "</ul>" +
        "<button class='btn full' id='start'>" + (hasProgress ? "Resume training" : "Start Training") + "</button>" +
        (hasProgress ? "<button class='btn ghost full' id='restart'>Restart from the beginning</button>" : "") +
      "</div>" +
      "<div class='next-step'>" +
        "<div class='ns-label'>Also in here</div>" +
        "<p>The Practice Range opens its first stage free. The " + esc(LABCFG.name) + " comes with full access.</p>" +
        "<div class='review-bar'>" +
          "<a class='btn ghost' href='#/range'>Open the Practice Range</a>" +
          "<a class='btn ghost' href='#/lab'>See the " + esc(LABCFG.name) + "</a>" +
        "</div>" +
      "</div>";
    $("start").onclick = startTraining;
    if (hasProgress) $("restart").onclick = function () { resetProgress(); showIntro(); };
  }

  function startTraining() {
    if (state.pos >= N_STEPS) state.pos = 0;
    saveState();
    go("#/course");
  }

  // Restarting the course never wipes the Lab or the Range ticks.
  function resetProgress() {
    var keepLab = state.lab, keepRange = state.rangeDone;
    state = defaultState();
    state.lab = keepLab || {};
    state.rangeDone = keepRange || {};
    saveState();
    refreshChrome();
  }

  /* ---------- paid gate ---------- */
  function renderGate(fromNav) {
    setView("course");
    $("courseHud").hidden = !!fromNav;
    var covers = PAID_UNITS.map(function (u) {
      return "<span class='t'>" + esc(u.title) + "</span>";
    }).join("") +
      "<span class='t'>Practice Range</span><span class='t'>" + esc(LABCFG.name) + "</span>";
    var freeUnit = FREE_UNITS[0] || { title: "Prompt Injection" };
    var finishedFree = state.pos > (UNIT_META[0] ? UNIT_META[0].lastPos : 0);

    var keyRow = FREE_ONLY ? "" :
      "<div class='key-row'>" +
        "<input id='keyInput' type='text' autocomplete='off' autocapitalize='off' spellcheck='false' placeholder='Paste your purchase key' aria-label='Purchase key' />" +
        "<button class='btn ghost full' id='unlock'>Enter purchase key</button>" +
        "<div class='key-msg' id='keyMsg' role='status'></div>" +
      "</div>";

    var heading = (finishedFree && !fromNav)
      ? "<span class='gate-badge'>Free training complete</span><h2>You finished Unit 1: " + esc(freeUnit.title) + ".</h2>" +
        "<p>You've seen direct injection, narrative jailbreaks, indirect injection hidden in content, and the precision-versus-recall tension every real filter lives with.</p>"
      : "<span class='gate-badge pro'>Full access</span><h2>Everything, for one payment of " + esc(CONFIG.price) + ".</h2>";

    var haveKey = FREE_ONLY
      ? "<p class='have-key'>Already bought? <a href='" + esc(CONFIG.fullUrl) + "'>Open the full version</a> and paste your key there.</p>"
      : "";

    screenEl.innerHTML =
      "<div class='panel'>" +
        heading +
        "<p>Units 2 to " + N_UNITS + " cover evasion techniques, system prompt leakage, excessive agency, RAG and vector poisoning, output handling and supply chain, and a boss unit of combined attacks, all mapped to the OWASP LLM Top 10 for Applications 2025.</p>" +
        "<p>Then the <b>Practice Range</b>, a route through the best free AI security labs, and the <b>" + esc(LABCFG.name) + "</b>, where you run a model on your own laptop, build an agent, break it, and defend it.</p>" +
        "<div class='covers'>" + covers + "</div>" +
        "<div class='btn-stack'>" +
          "<button class='btn full' id='buy'>Get full access for " + esc(CONFIG.price) + " on Gumroad</button>" +
        "</div>" +
        keyRow +
        (finishedFree ? "<button class='btn ghost full' id='freeCert'>See your Free Defender certificate →</button>" : "") +
        haveKey +
      "</div>";

    $("buy").onclick = function () { window.open(CONFIG.gumroadUrl, "_blank", "noopener"); };
    if (!FREE_ONLY) {
      $("unlock").onclick = doUnlock;
      $("keyInput").addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doUnlock(); }
      });
    }
    if ($("freeCert")) $("freeCert").onclick = function () { showCertificate("free"); };
  }

  function doUnlock() {
    var val = $("keyInput").value;
    var msg = $("keyMsg");
    if (tryUnlock(val)) {
      msg.className = "key-msg ok";
      msg.textContent = "Unlocked. Opening your hub…";
      refreshChrome();
      window.setTimeout(function () { go("#/hub"); }, 450);
    } else {
      msg.className = "key-msg err";
      msg.textContent = "That key didn't match. Check your confirmation email and try again.";
    }
  }

  /* ---------- complete (full finish) ---------- */
  function renderComplete() {
    setView("course");
    var pct = state.totalAnswered ? Math.round(state.correctTotal / state.totalAnswered * 100) : 0;
    var cls, label, note;
    if (state.breaches === 0 && state.falseAlarms <= 1) {
      cls = "good"; label = "Production-ready filter";
      note = "You caught the attacks without slamming the door on real users. That balance, high recall without wrecking precision, is the whole job of a real guardrail.";
    } else if (pct >= 70) {
      cls = "mid"; label = "Solid, with gaps";
      note = "A decent instinct, but each breach is an attacker who got through and each false alarm is a real user you turned away. Real filters are judged on both at once.";
    } else {
      cls = "bad"; label = "Leaky filter";
      note = "Too many got past you, or you blocked too many real people. The good news: every technique here has an obvious tell once you've named it. Run it back.";
    }

    screenEl.innerHTML =
      "<div class='end'>" +
        "<div class='rating " + cls + "'>" + label + "</div>" +
        "<div class='line'><b>" + state.correctTotal + "/" + state.totalAnswered + "</b> calls correct · " +
          pct + "% · <b>" + state.xp + "</b> XP · best streak <b>" + state.bestStreak + "</b></div>" +
        statGrid() +
        "<p>" + note + "</p>" +
        "<button class='btn full' id='cert'>Get your certificate →</button>" +
        (isPaid() ? "<a class='btn pro full' href='#/lab'>You've been the filter. Now build one in the " + esc(LABCFG.name) + " →</a>" : "") +
        "<a class='btn ghost full' href='#/range'>You can spot them. Now go break real ones →</a>" +
        "<button class='btn ghost full' id='again'>Play again</button>" +
      "</div>";
    $("cert").onclick = function () { showCertificate(isPaid() ? "full" : "free"); };
    $("again").onclick = function () { resetProgress(); showIntro(); };
  }

  function statGrid() {
    return "<div class='stat-grid'>" +
      "<div class='stat-cell caught'><div class='v'>" + state.caughtAttacks + "</div><div class='k'>Threats caught</div></div>" +
      "<div class='stat-cell false'><div class='v'>" + state.falseAlarms + "</div><div class='k'>False alarms</div></div>" +
      "<div class='stat-cell breach'><div class='v'>" + state.breaches + "</div><div class='k'>Breaches</div></div>" +
    "</div>";
  }

  /* =========================================================================
     HUB · the paid home
     ========================================================================= */
  function ring(pct, tone) {
    var r = 27, c = 2 * Math.PI * r;
    var off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
    return "<div class='ring " + (tone || "") + "' role='img' aria-label='" + pct + " percent complete'>" +
             "<svg viewBox='0 0 64 64' aria-hidden='true'>" +
               "<circle class='trk' cx='32' cy='32' r='" + r + "'/>" +
               "<circle class='val' cx='32' cy='32' r='" + r + "' stroke-dasharray='" + c.toFixed(1) +
                 "' stroke-dashoffset='" + off.toFixed(1) + "'/>" +
             "</svg><span class='pct'>" + pct + "%</span></div>";
  }

  var BADGES = [
    { id: "first",  title: "First catch",       desc: "Got your first call right.",              test: function () { return state.correctTotal >= 1; } },
    { id: "unit1",  title: "Free Defender",     desc: "Cleared Unit 1, Prompt Injection.",        test: function () { return UNIT_META[0] && state.pos > UNIT_META[0].lastPos; } },
    { id: "streak", title: "Ten in a row",      desc: "A streak of ten correct calls.",           test: function () { return state.bestStreak >= 10; } },
    { id: "course", title: "Full course",       desc: "Finished all seven units.",                test: function () { return state.pos >= N_STEPS; } },
    { id: "clean",  title: "Production-ready",  desc: "Finished with no breaches and one false alarm at most.", test: function () { return state.pos >= N_STEPS && state.breaches === 0 && state.falseAlarms <= 1; } },
    { id: "range",  title: "Range regular",     desc: "Tried ten Practice Range resources.",      test: function () { return rangeDoneCount() >= 10; } }
  ];

  function allBadges() {
    var list = BADGES.map(function (b) {
      return { id: b.id, title: b.title, desc: b.desc, earned: !!b.test(), lab: false };
    });
    if (LAB_API && LAB_API.badges) list = list.concat(LAB_API.badges());
    return list;
  }

  function courseNext() {
    if (state.pos >= N_STEPS) return { label: "<b>Finished.</b> Your result and certificate are waiting.", cta: "See your result" };
    var e = FLAT[state.pos];
    var what = e.step.type === "teach" ? esc(e.step.heading) : "Exercise " + e.exerciseNo + " of " + N_EX;
    return {
      label: "<b>Unit " + (e.unitIndex + 1) + ": " + esc(e.unit.title) + "</b><br>" + what,
      cta: state.pos === 0 ? "Start Unit 1" : "Continue the course"
    };
  }

  function rangeNext() {
    if (!HAS_RANGE) return null;
    for (var s = 0; s < RANGE.sections.length; s++) {
      var sec = RANGE.sections[s];
      for (var i = 0; i < sec.items.length; i++) {
        if (!state.rangeDone[rangeKey(sec, sec.items[i])]) {
          return { sec: sec, item: sec.items[i] };
        }
      }
    }
    return null;
  }

  function renderHub() {
    if (!isPaid()) return showIntro();
    setView("hub");
    var badges = allBadges();
    var earned = badges.filter(function (b) { return b.earned; }).length;
    var acc = state.totalAnswered ? Math.round(state.correctTotal / state.totalAnswered * 100) : 0;

    /* Course card */
    var cn = courseNext();
    var courseCard =
      "<article class='hub-card'>" +
        "<div class='top'>" + ring(coursePct()) +
          "<div><div class='kicker'>Units 1 to " + N_UNITS + "</div><h2>The Course</h2></div></div>" +
        "<p>" + N_EX + " exercises across " + N_UNITS + " units, every one mapped to the OWASP LLM Top 10. You play the guardrail.</p>" +
        "<div class='next'><span class='lbl'>Where you left off</span>" + cn.label + "</div>" +
        "<a class='btn full' href='#/course'>" + esc(cn.cta) + " →</a>" +
      "</article>";

    /* Range card */
    var rTotal = HAS_RANGE ? RANGE_COUNT : 0;
    var rDone = rangeDoneCount();
    var rPct = rTotal ? Math.round(Math.min(rDone, rTotal) / rTotal * 100) : 0;
    var rn = rangeNext();
    var rangeCard =
      "<article class='hub-card'>" +
        "<div class='top'>" + ring(rPct, "amber") +
          "<div><div class='kicker'>" + rTotal + " resources</div><h2>Practice Range</h2></div></div>" +
        "<p>A route through the best free and self-hosted AI security labs, tools and bounties. Tick each one off as you try it.</p>" +
        "<div class='next'><span class='lbl'>Next to try</span>" +
          (rn ? "<b>" + esc(rn.item.title) + "</b><br>" + esc(rn.sec.title) : "<b>All tried.</b> Go and claim a bounty.") +
        "</div>" +
        "<a class='btn full' href='#/range" + (rn ? "/" + encodeURIComponent(rn.sec.id) : "") + "'>Open the Range →</a>" +
      "</article>";

    /* Lab card */
    var ls = LAB_API ? LAB_API.summary() : null;
    var labCard =
      "<article class='hub-card lab'>" +
        "<div class='top'>" + ring(ls ? ls.pct : 0, "violet") +
          "<div><div class='kicker'>New · 4 stages + capstone</div><h2>" + esc(LABCFG.name) + "</h2></div></div>" +
        "<p>" + esc(LABCFG.story || "") + "</p>" +
        "<div class='next'><span class='lbl'>" + (ls && ls.done ? "Where you left off" : "Start here") + "</span>" +
          (ls ? ls.nextLabel : "<b>Stage 1: Run it</b>") + "</div>" +
        "<a class='btn pro full' href='" + (ls ? ls.nextHref : "#/lab") + "'>" + (ls && ls.done ? "Continue the Lab" : "Open the Lab") + " →</a>" +
      "</article>";

    /* Badge shelf */
    var shelf = badges.map(function (b) {
      return "<div class='badge" + (b.earned ? " earned" : "") + (b.lab ? " lab" : "") + "'>" +
               "<span class='medal' aria-hidden='true'>" + (b.earned ? "★" : "·") + "</span>" +
               "<div><div class='t'>" + esc(b.title) + (b.earned ? "" : " <span class='sr-only'>(not earned yet)</span>") + "</div>" +
               "<div class='d'>" + esc(b.desc) + "</div></div>" +
             "</div>";
    }).join("");

    /* Lessons: every teach card, reopenable */
    var lessons = UNIT_META.map(function (m, ui) {
      var done = state.pos > m.lastPos;
      var items = m.unit.steps.filter(function (s) { return s.type === "teach"; }).map(function (s) {
        return "<li><a href='#/review/" + esc(s.id) + "'>" + esc(s.heading) + "</a></li>";
      }).join("");
      return "<div class='lesson-unit" + (done ? " done" : "") + "'>" +
               "<div class='uh'><span class='un'>" + (done ? "✓" : ui + 1) + "</span>" +
                 "<span class='ut'>" + esc(m.unit.title) + "</span><span class='uo'>" + esc(m.unit.owasp) + "</span></div>" +
               "<ul>" + items + "</ul>" +
             "</div>";
    }).join("");

    screenEl.innerHTML =
      "<section class='hub-hero'>" +
        "<div class='eyebrow'><span class='pro-badge'>Pro</span> Full access unlocked</div>" +
        "<h1>Everything is <span class='b'>open</span>.<br>Pick up where you left off.</h1>" +
        "<p>The course trains the reflex. The Practice Range sends you to real targets. The " + esc(LABCFG.name) +
          " has you build the thing a filter protects, break it, then defend it. Progress saves in this browser.</p>" +
        "<div class='hub-sum'>" +
          "<div class='s xp'><div class='v'>" + (state.xp + labXp()) + "</div><div class='k'>Total XP</div></div>" +
          "<div class='s acc'><div class='v'>" + acc + "%</div><div class='k'>Accuracy</div></div>" +
          "<div class='s str'><div class='v'>" + state.bestStreak + "</div><div class='k'>Best streak</div></div>" +
          "<div class='s bdg'><div class='v'>" + earned + " / " + badges.length + "</div><div class='k'>Badges</div></div>" +
        "</div>" +
      "</section>" +
      "<div class='hub-cards'>" + courseCard + rangeCard + labCard + "</div>" +
      "<section class='hub-sec'><h3>Badges</h3><p class='sub'>Earned as you go. The Lab ones are the hard ones.</p>" +
        "<div class='badges'>" + shelf + "</div></section>" +
      "<section class='hub-sec'><h3>Every lesson, any time</h3>" +
        "<p class='sub'>Reopen a concept card without touching your progress.</p>" +
        "<div class='lessons'>" + lessons + "</div></section>";
  }

  /* ---------- review: reopen a course step without scoring ---------- */
  function findCourseStep(id) {
    var pos = STEP_INDEX[id];
    if (pos == null) return null;
    var e = FLAT[pos];
    return { step: e.step, unit: e.unit, unitIndex: e.unitIndex, pos: pos };
  }

  function backOrHub() {
    if (window.history.length > 1) window.history.back();
    else go(isPaid() ? "#/hub" : "#/");
  }

  function renderReview(id) {
    setView(isPaid() ? "hub" : "course");
    $("courseHud").hidden = true;
    var f = findCourseStep(id);
    if (!f) { if (!isPaid() && /^u[2-7]/.test(String(id))) renderGate(true); else home(); return; }
    if (!isUnitUnlocked(f.unit)) { renderGate(true); return; }

    var bar = "<div class='review-bar'>" +
                "<button class='btn ghost' id='revBack'>← Back</button>" +
                "<a class='btn ghost' href='" + (isPaid() ? "#/hub" : "#/course") + "'>" + (isPaid() ? "Open the hub" : "Back to the course") + "</a>" +
              "</div>";
    var wrap = "<div class='review-col'>";

    if (f.step.type === "teach") {
      screenEl.innerHTML = wrap + teachHTML(f.step, {
        tag: unitTag(f.unit, f.unitIndex), label: "Review · concept"
      }) + bar + "</div>";
    } else {
      screenEl.innerHTML = wrap + "<div id='revEx'></div>" + bar + "</div>";
      renderExercise(f.step, {
        el: $("revEx"),
        topline: exTopline("Review · Unit " + (f.unitIndex + 1) + " · not scored", f.step.difficulty),
        continueLabel: "Done",
        onAnswer: function () { return { gained: 0, bonus: 0 }; },
        onContinue: backOrHub
      });
    }
    $("revBack").onclick = backOrHub;
  }

  /* =========================================================================
     PRACTICE RANGE
     A curated directory of free and self-hostable labs, tools and bounties.
     The full build ships range.js with every stage; the free build ships
     the first stage open and the rest as locked stubs (see build-free.js).
     ========================================================================= */
  var HAS_RANGE = (typeof RANGE !== "undefined") && RANGE && RANGE.sections;
  var RANGE_TOTAL = HAS_RANGE ? (RANGE.totalCount || RANGE_COUNT) : 0;

  function showRange(secId) {
    if (!HAS_RANGE) return renderRangeLocked();
    return renderRange(secId);
  }

  var RANGE_CREDIT_FALLBACK = {
    text: "Resource universe curated by Arcanum Information Security",
    url: "https://arcanum-sec.com",
    indexUrl: "https://arcanum-sec.github.io/ai-sec-resources/",
    note: "The selection, ordering and notes on this page are ours. The underlying directory of resources is theirs, and it is worth reading in full."
  };

  function rangeCredit() {
    var c = (HAS_RANGE && RANGE.credit) ? RANGE.credit : RANGE_CREDIT_FALLBACK;
    return "<div class='range-credit'>" +
             "<p>" + esc(c.text) + " (" +
               "<a href='" + esc(c.url) + "' target='_blank' rel='noopener'>arcanum-sec.com</a>" +
             ").</p>" +
             "<p>" + esc(c.note) + " " +
               "<a href='" + esc(c.indexUrl) + "' target='_blank' rel='noopener'>Read the full index</a>." +
             "</p>" +
           "</div>";
  }

  function rangeHostKind(host) {
    var h = String(host || "").toLowerCase();
    if (h.indexOf("bounty") !== -1) return "bounty";
    if (h.indexOf("self-hosted") === 0) return "self";
    return "online";
  }

  function renderRange(focusSec) {
    setView("range");
    var paid = isPaid();

    var nOnline = 0, nSelf = 0, nBounty = 0;
    RANGE_ITEMS.forEach(function (it) {
      var k = rangeHostKind(it.host);
      if (k === "online") nOnline++;
      else if (k === "self") nSelf++;
      else nBounty++;
    });

    var html =
      "<div class='range-head'>" +
        "<div class='range-label'>" + (paid ? "Included with full access" : "Free preview · first stage open") + "</div>" +
        "<h2>The Practice Range</h2>" +
        "<p class='range-intro'>" + esc(RANGE.intro) + "</p>" +
        "<div class='range-stats'>" +
          statTile(RANGE_TOTAL, "Resources", "cyan") +
          statTile(RANGE.sections.length, "Stages", "violet") +
          (paid
            ? statTile(rangeDoneCount(), "Tried", "safe") +
              statTile(nSelf, "Self-hosted", "amber") +
              statTile(nOnline, "No setup", "cyan") +
              statTile(nBounty, "Bounties", "threat")
            : statTile(RANGE_ITEMS.length, "Open free", "safe") +
              statTile(RANGE_TOTAL - RANGE_ITEMS.length, "With full access", "amber")) +
        "</div>" +
      "</div>";

    var pills = "<button type='button' class='r-pill on' data-sec='all' aria-pressed='true'>All" +
                  "<span class='n'>" + RANGE_TOTAL + "</span></button>";
    RANGE.sections.forEach(function (sec) {
      var n = sec.locked ? sec.lockedCount : sec.items.length;
      pills += "<button type='button' class='r-pill' data-sec='" + esc(sec.id) + "' aria-pressed='false'>" +
                 esc(sec.title) + "<span class='n'>" + n + "</span>" +
               "</button>";
    });

    html +=
      "<div class='range-filter' id='rangeFilter'>" +
        "<div class='rf-search'>" +
          "<span class='rf-icon' aria-hidden='true'>⌕</span>" +
          "<input type='search' id='rangeSearch' autocomplete='off' spellcheck='false' " +
            "placeholder='Search " + RANGE_ITEMS.length + " resources by name, level or topic' " +
            "aria-label='Search the Practice Range' />" +
        "</div>" +
        "<div class='rf-pills' id='rangePills'>" + pills + "</div>" +
      "</div>" +
      "<div class='r-empty' id='rangeEmpty' hidden>" +
        "<p>Nothing matches that.</p>" +
        "<button type='button' class='btn ghost' id='rangeClear'>Clear the filters</button>" +
      "</div>";

    RANGE.sections.forEach(function (sec, i) {
      if (sec.locked) {
        html +=
          "<section class='range-sec' id='sec-" + esc(sec.id) + "' data-sec='" + esc(sec.id) + "' data-locked='1'>" +
            "<div class='rs-head'><span class='rs-n'>" + (i + 1) + "</span><h3>" + esc(sec.title) + "</h3>" +
              "<span class='rs-count'><b>" + sec.lockedCount + "</b> resources</span></div>" +
            "<p class='rs-intro'>" + esc(sec.intro) + "</p>" +
            "<div class='r-locked-sec'><p><b>" + sec.lockedCount + " hand-picked resources</b> with notes on what each one teaches, in order. Included with full access.</p>" +
              "<a class='btn pro small' href='#/unlock'>Unlock for " + esc(CONFIG.price) + "</a></div>" +
          "</section>";
        return;
      }
      var cards = sec.items.map(function (it) {
        var key = rangeKey(sec, it);
        var done = !!state.rangeDone[key];
        var hay = (it.title + " " + it.level + " " + it.host + " " +
                   (it.status || "") + " " + it.note + " " + sec.title).toLowerCase();
        var flag = it.status ? "<span class='r-flag'>" + esc(it.status) + "</span>" : "";
        var tick = "<button type='button' class='r-done' data-key='" + esc(key) + "' aria-pressed='" + done + "' " +
                     "aria-label='Mark " + esc(it.title) + " as tried'><span class='box' aria-hidden='true'>" + (done ? "✓" : "") + "</span>Tried it</button>";
        return "<li class='r-item" + (it.status ? " flagged" : "") + (done ? " done" : "") + "' " +
                    "data-sec='" + esc(sec.id) + "' data-hay=\"" + esc(hay) + "\">" +
                 "<a class='r-title' href='" + esc(it.url) + "' target='_blank' rel='noopener'>" +
                   "<span>" + esc(it.title) + "</span>" +
                 "</a>" +
                 "<div class='r-tags'>" +
                   "<span class='r-tag level'>" + esc(it.level) + "</span>" +
                   "<span class='r-tag host'>" + esc(it.host) + "</span>" +
                 "</div>" +
                 "<p class='r-note'>" + esc(it.note) + "</p>" +
                 "<div class='r-foot'>" + flag + tick + "</div>" +
               "</li>";
      }).join("");

      html +=
        "<section class='range-sec' id='sec-" + esc(sec.id) + "' data-sec='" + esc(sec.id) + "'>" +
          "<div class='rs-head'>" +
            "<span class='rs-n'>" + (i + 1) + "</span>" +
            "<h3>" + esc(sec.title) + "</h3>" +
            "<span class='rs-count'><b class='shown'>" + sec.items.length + "</b> / " +
              sec.items.length + "</span>" +
          "</div>" +
          "<p class='rs-intro'>" + esc(sec.intro) + "</p>" +
          "<ul class='r-list'>" + cards + "</ul>" +
        "</section>";
    });

    html += rangeCredit() +
            "<a class='btn ghost full' href='" + (paid ? "#/hub" : "#/") + "'>" + (paid ? "Back to the hub" : "Back to the training") + "</a>";

    screenEl.innerHTML = html;
    wireRangeFilters();
    wireRangeTicks();
    if (focusSec) {
      var target = $("sec-" + focusSec);
      if (target) try { target.scrollIntoView({ block: "start" }); } catch (e) {}
    }
  }

  function wireRangeTicks() {
    var list = document.querySelectorAll(".r-done");
    for (var i = 0; i < list.length; i++) {
      list[i].onclick = function () {
        var key = this.dataset.key;
        var on = !state.rangeDone[key];
        if (on) state.rangeDone[key] = true; else delete state.rangeDone[key];
        saveState();
        this.setAttribute("aria-pressed", on);
        this.querySelector(".box").textContent = on ? "✓" : "";
        var li = this.closest(".r-item");
        if (li) li.classList.toggle("done", on);
        var tile = document.querySelector(".r-stat.safe .v");
        if (tile && isPaid()) tile.textContent = rangeDoneCount();
        refreshChrome();
      };
    }
  }

  function statTile(n, label, tone) {
    return "<div class='r-stat " + tone + "'>" +
             "<div class='v'>" + n + "</div>" +
             "<div class='k'>" + esc(label) + "</div>" +
           "</div>";
  }

  function wireRangeFilters() {
    var input   = $("rangeSearch");
    var pillBox = $("rangePills");
    var empty   = $("rangeEmpty");
    if (!input || !pillBox) return;

    var f = { q: "", sec: "all" };

    function apply() {
      var q = f.q, sec = f.sec, total = 0;
      var sections = document.querySelectorAll(".range-sec");
      for (var s = 0; s < sections.length; s++) {
        var secEl = sections[s], shown = 0;
        if (secEl.dataset.locked) {
          var vis = !q && (sec === "all" || secEl.dataset.sec === sec);
          secEl.hidden = !vis;
          if (vis) total++;
          continue;
        }
        var items = secEl.querySelectorAll(".r-item");
        for (var i = 0; i < items.length; i++) {
          var el = items[i];
          var ok = (sec === "all" || el.dataset.sec === sec) &&
                   (!q || el.dataset.hay.indexOf(q) !== -1);
          el.hidden = !ok;
          if (ok) shown++;
        }
        secEl.hidden = shown === 0;
        var c = secEl.querySelector(".rs-count .shown");
        if (c) c.textContent = shown;
        total += shown;
      }
      empty.hidden = total !== 0;
    }

    function setPill(btn) {
      var all = pillBox.querySelectorAll(".r-pill");
      for (var i = 0; i < all.length; i++) { all[i].classList.remove("on"); all[i].setAttribute("aria-pressed", "false"); }
      btn.classList.add("on"); btn.setAttribute("aria-pressed", "true");
      f.sec = btn.dataset.sec;
    }

    input.addEventListener("input", function () {
      f.q = input.value.trim().toLowerCase();
      apply();
    });

    pillBox.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".r-pill") : null;
      if (!btn) return;
      setPill(btn);
      apply();
    });

    $("rangeClear").onclick = function () {
      input.value = "";
      f.q = "";
      setPill(pillBox.querySelector("[data-sec='all']"));
      apply();
      input.focus();
    };
  }

  function renderRangeLocked() {
    setView("range");
    screenEl.innerHTML =
      "<div class='panel'>" +
        "<span class='gate-badge pro'>Included with full access</span>" +
        "<h2>The Practice Range</h2>" +
        "<p>The Practice Range is a curated route through the best free and " +
          "self-hostable AI security labs, CTFs, tools and bug bounty programmes.</p>" +
        "<div class='btn-stack'>" +
          "<a class='btn full' href='#/unlock'>Get full access for " + esc(CONFIG.price) + "</a>" +
        "</div>" +
        rangeCredit() +
      "</div>";
  }

  /* =========================================================================
     LAB · rendered by lab/lab.js on the full build. Everyone else sees the
     teaser built from the public LAB_CONFIG.teaser.
     ========================================================================= */
  function showLab(arg) {
    if (isPaid() && LAB_API) { setView("lab"); return LAB_API.render(arg, screenEl); }
    return renderLabLocked();
  }

  function renderLabLocked() {
    setView("lab");
    var t = LABCFG.teaser || {};
    var stages = (t.stages || []).map(function (s, i) {
      return "<li><span class='ic'>" + (i + 1) + "</span><div><b>" + esc(s.title) + "</b> " + esc(s.blurb) + "</div></li>";
    }).join("");
    var gets = (t.includes || []).map(function (x) { return "<span class='t'>" + esc(x) + "</span>"; }).join("");
    var already = FREE_ONLY
      ? "<p class='have-key'>Already bought? <a href='" + esc(CONFIG.fullUrl) + "/#/lab'>Open the Lab in the full version</a>.</p>"
      : "<p class='have-key'>Already bought? <a href='#/unlock'>Enter your purchase key</a>.</p>";
    screenEl.innerHTML =
      "<div class='lab-teaser'>" +
        "<div class='panel'>" +
          "<span class='gate-badge pro'>Included with full access</span>" +
          "<h1>" + esc(LABCFG.name) + "</h1>" +
          "<p class='lede'>" + esc(LABCFG.story || "") + "</p>" +
          (t.laptop ? "<p><b>You only need a laptop.</b> " + esc(String(t.laptop).replace(/^You only need a laptop\.\s*/, "")) + "</p>" : "") +
          "<ul class='howto'>" + stages + "</ul>" +
          (t.outcomes ? "<p><b>What you will be able to do:</b></p><ul class='howto'>" + t.outcomes.map(function (o, i) { return "<li><span class='ic'>" + (i + 1) + "</span><div>" + esc(o) + "</div></li>"; }).join("") + "</ul>" : "") +
          "<div class='covers'>" + gets + "</div>" +
          "<div class='btn-stack'>" +
            "<button class='btn pro full' id='labBuy'>Get full access for " + esc(CONFIG.price) + "</button>" +
          "</div>" +
          already +
        "</div>" +
      "</div>";
    $("labBuy").onclick = function () { window.open(CONFIG.gumroadUrl, "_blank", "noopener"); };
  }

  /* ---------- certificate ---------- */
  function showCertificate(tier) {
    setView("course");
    var data = {
      xp: state.xp,
      rank: (typeof certificateRank === "function") ? certificateRank(state.xp) : "Defender",
      caught: state.caughtAttacks,
      falseAlarms: state.falseAlarms,
      breaches: state.breaches,
      levels: tier === "full" ? N_EX : FREE_EX,
      tier: tier,
      date: new Date()
    };
    var svg = buildCertificateSVG(data);
    screenEl.innerHTML =
      "<div class='cert-wrap' id='certWrap'>" + svg + "</div>" +
      "<div class='cert-actions'>" +
        "<button class='btn full' id='dl'>Download PNG</button>" +
        "<button class='btn ghost full' id='back'>Back</button>" +
      "</div>" +
      "<div class='next-step'>" +
        "<div class='ns-label'>Next step</div>" +
        "<p>You can spot them. Now go break real ones.</p>" +
        "<a class='btn ghost full' href='#/range'>Open the Practice Range →</a>" +
      "</div>";
    $("dl").onclick = function () {
      var svgEl = $("certWrap").querySelector("svg");
      downloadCertificatePNG(svgEl, "the-filter-certificate.png");
    };
    $("back").onclick = function () {
      if (isPaid() && state.pos >= N_STEPS) renderComplete();
      else renderGate();
    };
    try { $("certWrap").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
  }

  /* ---------- util ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- keyboard: A / B on allow-block, Enter/Space to continue ---------- */
  document.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.target && e.target.closest && e.target.closest("a, button:not(#next), [role='button'], [role='tab']")) {
      if (e.key === "Enter" || e.key === " ") return;     // let the focused control act
    }
    var a = $("bAllow"), b = $("bBlock"), n = $("next");
    var k = e.key.toLowerCase();
    if (a && b && !a.disabled) {
      if (k === "a") { e.preventDefault(); a.click(); }
      else if (k === "b") { e.preventDefault(); b.click(); }
    } else if (n && (k === "enter" || k === " ")) {
      e.preventDefault();
      n.click();
    }
  });

  /* ---------- public API for lab/lab.js ---------- */
  window.FILTER = {
    config: CONFIG,
    labConfig: LABCFG,
    esc: esc,
    rich: rich,
    paragraphs: paragraphs,
    teachHTML: teachHTML,
    exTopline: exTopline,
    renderExercise: renderExercise,
    findCourseStep: findCourseStep,
    getState: function () { return state; },
    save: saveState,
    refresh: refreshChrome,
    go: go,
    isPaid: isPaid,
    courseDone: function () { return state.pos >= N_STEPS; },
    registerLab: function (api) { LAB_API = api; }
  };

  /* ---------- boot ----------
     Wait for DOMContentLoaded so lab/lab.js (loaded after this file) has
     registered itself before the first route renders. */
  window.addEventListener("hashchange", route);
  function boot() { refreshChrome(); route(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
