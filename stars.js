/* ═══════════════════════════════════════════════════════════
   THE FILTER AI · night sky

   A living sky. Three things happen at once and none of them
   asks for your attention:

     Twinkle   about two thirds of the stars breathe between
               half and full brightness on their own cycle,
               two and a half to seven seconds each, with
               random phases so the field never pulses together.

     Drift     the whole sky moves as one, a few pixels a
               minute, the way the real one turns. You notice
               it if you sit with the page; you never catch it
               moving.

     Parallax  five depth bands travel at different rates as
               you scroll, which is what gives the field depth
               and makes scrolling feel like going up into it.

   Shooting stars cross every eight to eighteen seconds, last
   under a second, and stay out of the middle third where the
   text sits. Reduced motion stops all of it and draws one
   still frame.

   The glow behind bright stars is pre-rendered once per tint
   into a small sprite, because building a radial gradient per
   star per frame is the one thing here that would actually
   cost something.

   Knobs, if this ever needs calming down: TWINKLE_DEPTH for
   how far the breathing swings, DRIFT for the crawl, and
   SHOOT_MIN / SHOOT_MAX for how often a streak appears.
   ═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var canvas = document.getElementById("bgCanvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  var reduceMotion = window.matchMedia &&
                     window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var TWINKLE_DEPTH = 0.5;    /* 0 steady, 1 blinks right down to nothing */
  var DRIFT_X = 0.10;         /* px per second, sideways */
  var DRIFT_Y = -0.035;       /* px per second, upward */
  var SHOOT_MIN = 8000, SHOOT_MAX = 18000;

  /* Real stars are coloured by surface temperature, and these are the
     published values for the main spectral classes. The weighting is not the
     true distribution, which is overwhelmingly dim red dwarfs, but the
     distribution of what the eye actually picks out of a dark sky: mostly
     white and blue-white, with a scattering of warm ones. */
  var TINTS = [
    [155, 176, 255],   /* O  blue            */
    [170, 191, 255],   /* B  blue-white      */
    [202, 215, 255],   /* A  white with blue */
    [202, 215, 255],
    [248, 247, 255],   /* F  white           */
    [248, 247, 255],
    [255, 244, 234],   /* G  yellow-white    */
    [255, 244, 234],
    [255, 210, 161],   /* K  orange          */
    [255, 204, 111]    /* M  red-orange      */
  ];

  var w = 0, h = 0, lastW = 0, dpr = 1, stars = [], span = 0, glows = [];
  var scrollY = 0, raf = null, t0 = 0, elapsed = 0;
  var shot = null, nextShot = 0;

  /* ── One glow sprite per tint, drawn once ─────────────── */
  function buildGlows() {
    glows = TINTS.map(function (c) {
      var r = 18, cv = document.createElement("canvas");
      cv.width = cv.height = r * 2;
      var g = cv.getContext("2d");
      var grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0,   "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.55)");
      grad.addColorStop(0.4, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.13)");
      grad.addColorStop(1,   "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, r * 2, r * 2);
      return cv;
    });
  }

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    /* Roughly a third of the previous density. The old field was busy enough
       that the eye kept catching it, which is the opposite of what a
       background is for. */
    var n = Math.round((w * h) / 6200);
    n = Math.max(60, Math.min(n, 210));
    span = h * 2;
    stars = [];
    for (var i = 0; i < n; i++) {
      var depth = Math.random();
          /* A quarter of what is left are the bright, spiked, obviously-a-star
       ones. Those are the feature; the rest are only depth behind them. */
      var bright = Math.random() > 0.86;
      var ti = (Math.random() * TINTS.length) | 0;
      /* index 4 and 5 are the pure whites; push faint stars off them so no
         small dot is ever the same colour as a full stop. */
      if (!bright && (ti === 4 || ti === 5)) ti = Math.random() < 0.5 ? 2 : 8;
      stars.push({
        x: Math.random() * w,
        y: Math.random() * span,
        d: depth,
        /* A full stop is small, crisp, opaque and white. So a faint star is
           none of those: always tinted, never above 0.4 alpha, and drawn with
           a soft edge below. The bright ones keep their strength because a
           spiked, glowing, coloured star is never mistaken for punctuation. */
        r: (bright ? 1.15 + depth * 0.7 : 0.55 + depth * 0.5),
        a: (bright ? 0.55 + depth * 0.4 : 0.14 + depth * 0.26),
        big: bright,
        ti: ti,
        c: TINTS[ti],
        /* Two thirds breathe; the rest hold steady, which is what keeps the
           field from reading as a single blinking mass. */
        /* Only the top slice of the bright stars get spikes, and each gets
           its own arm length so the sky is not a grid of identical crosses. */
        spike: bright && Math.random() < 0.5,
        flare: 0.75 + Math.random() * 0.7,
        tw: Math.random() < 0.66,
        ph: Math.random() * Math.PI * 2,
        sp: 0.9 + Math.random() * 1.6      /* radians per second */
      });
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);

    /* The reading column. Faint stars are suppressed inside it, because a dim
       dot beside a line of prose is read as a full stop before it is read as
       a star. Bright spiked ones are still allowed through: nobody mistakes
       one of those for punctuation. */
    var bandHalf = Math.min(760, w * 0.94) / 2;
    var bandL = w / 2 - bandHalf, bandR = w / 2 + bandHalf;

    var driftX = reduceMotion ? 0 : t * DRIFT_X;
    var driftY = reduceMotion ? 0 : t * DRIFT_Y;

    /* On a phone the text runs nearly edge to edge, so the moon peeks in
       from the right-hand edge, half out of frame, clear of the copy. */
    if (w < 700) drawMoon(w - 6 + driftX * 0.5, h * 0.2 + driftY * 0.5);
    else drawMoon(w * 0.84 + driftX * 0.5, h * 0.15 + driftY * 0.5);

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];

      var x = s.x + driftX;
      x = x % w; if (x < 0) x += w;
      if (!s.big && x > bandL && x < bandR) continue;

      var y = s.y + driftY - scrollY * (0.04 + s.d * 0.30);
      y = y % span; if (y < 0) y += span;
      if (y > h + 6) continue;

      var a = s.a;
      /* A feature star is allowed over the reading column, because a spiked
         glowing star is never misread as punctuation. It does dim while it is
         there, so it never competes with the line under it. */
      if (s.big && x > bandL && x < bandR) a *= 0.5;
      if (s.tw && !reduceMotion) {
        /* sin swings -1..1; map it so the star never fully disappears */
        a *= 1 - TWINKLE_DEPTH * (0.5 - 0.5 * Math.sin(t * s.sp + s.ph));
      }

      if (s.big) {
        var g = glows[s.ti], size2 = s.r * 9;
        ctx.globalAlpha = Math.min(1, a * 1.25);
        ctx.drawImage(g, x - size2 / 2, y - size2 / 2, size2, size2);
        ctx.globalAlpha = 1;
        if (s.spike) spikes(x, y, s, a);
      }
      var c = s.c;
      if (!s.big) {
        /* Two overlapping discs: a wider, very faint one under a small core.
           The result has no hard edge, which is the whole difference between
           a distant star and a typed full stop. */
        ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.32).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(x, y, s.r * 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (shot) drawShot();
  }


  /* A full moon, high on the right, drifting with the sky. The disc is the
     real near side: rendered from NASA's LRO colour map (CGI Moon Kit, public
     domain) onto a sphere, so the maria, Tycho and its rays are where they
     are in the actual sky. It sits in moon.webp beside this script. Until it
     loads only the halo shows, and a still (reduced-motion) sky redraws once
     it arrives. */
  var moonImg = new Image(), moonReady = false;
  moonImg.onload = function () { moonReady = true; if (reduceMotion) draw(0); };
  moonImg.src = (function () {
    var me = document.currentScript && document.currentScript.src;
    try { return new URL("moon.webp", me || location.href).href; } catch (e) { return "moon.webp"; }
  })();

  function drawMoon(mx, my) {
    var mr = Math.max(26, Math.min(64, Math.min(w, h) * 0.06));
    /* moonlight scattering in the air around it: wide, faint, cool */
    var halo = ctx.createRadialGradient(mx, my, mr * 0.9, mx, my, mr * 4.2);
    halo.addColorStop(0, "rgba(220,228,245,0.16)");
    halo.addColorStop(0.35, "rgba(205,216,238,0.06)");
    halo.addColorStop(1, "rgba(200,214,235,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(mx, my, mr * 4.2, 0, Math.PI * 2); ctx.fill();
    if (!moonReady) return;
    /* a tight bright rim of glow right at the limb, then the disc itself */
    ctx.save();
    ctx.shadowColor = "rgba(232,238,250,0.55)";
    ctx.shadowBlur = mr * 0.55;
    ctx.globalAlpha = 0.96;
    ctx.drawImage(moonImg, mx - mr, my - mr, mr * 2, mr * 2);
    ctx.restore();
  }

  /* The cross of light on a bright star. It is a real optical artefact, not a
     stylisation: four spikes at right angles, brightest at the centre and
     fading to nothing, with a shorter diagonal pair underneath. Only the
     handful of brightest stars carry them, which is what makes those stars
     read as bright rather than merely large. */
  function spikes(x, y, s, a) {
    var c = s.c, len = s.r * 11 * s.flare, i;
    var arms = [[1, 0], [0, 1], [0.7, 0.7], [0.7, -0.7]];
    var mul  = [1, 1, 0.45, 0.45];
    ctx.lineCap = "round";
    for (i = 0; i < arms.length; i++) {
      var L = len * mul[i];
      var dx = arms[i][0] * L, dy = arms[i][1] * L;
      var g = ctx.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
      var peak = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.55 * mul[i]).toFixed(3) + ")";
      g.addColorStop(0, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
      g.addColorStop(0.5, peak);
      g.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
      ctx.strokeStyle = g;
      ctx.lineWidth = i < 2 ? 0.9 : 0.6;
      ctx.beginPath();
      ctx.moveTo(x - dx, y - dy);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
    }
  }

  /* ── Shooting stars ─────────────────────────────────── */
  function planShot() {
    nextShot = Date.now() + SHOOT_MIN + Math.random() * (SHOOT_MAX - SHOOT_MIN);
  }

  function startShot() {
    var topHalf = Math.random() > 0.5;
    shot = {
      x: Math.random() * w * 0.75,
      y: topHalf ? Math.random() * h * 0.3 : h * 0.72 + Math.random() * h * 0.22,
      len: 90 + Math.random() * 100,
      vx: 5.5 + Math.random() * 3.5,
      vy: 1.8 + Math.random() * 1.4,
      life: 0,
      max: 46
    };
  }

  function drawShot() {
    var s = shot;
    var p = s.life / s.max;
    var fade = p < 0.25 ? p / 0.25 : (1 - p) / 0.75;
    var g = ctx.createLinearGradient(s.x, s.y, s.x - s.len, s.y - s.len * (s.vy / s.vx));
    g.addColorStop(0, "rgba(255,255,255," + (0.85 * fade).toFixed(3) + ")");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.len, s.y - s.len * (s.vy / s.vx));
    ctx.stroke();
  }

  /* ── Loop ───────────────────────────────────────────── */
  function frame(now) {
    if (!t0) t0 = now;
    var t = elapsed + (now - t0) / 1000;

    if (shot) {
      shot.x += shot.vx;
      shot.y += shot.vy;
      shot.life++;
      if (shot.life > shot.max || shot.x - shot.len > w) { shot = null; planShot(); }
    } else if (Date.now() > nextShot) {
      startShot();
    }

    draw(t);
    raf = window.requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) { window.cancelAnimationFrame(raf); raf = null; }
    /* Bank the time already run. Without this the drift would snap back to
       its origin every time the tab was left and returned to. */
    if (t0) { elapsed += (performance.now() - t0) / 1000; t0 = 0; }
  }
  function start() {
    if (raf || reduceMotion) return;
    raf = window.requestAnimationFrame(frame);
  }

  function rebuild() {
    size();
    lastW = window.innerWidth;
    buildGlows();
    seed();
    scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    if (reduceMotion) draw(0);
  }

  window.addEventListener("scroll", function () {
    scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    /* A still sky still has to follow the scroll, so redraw the one frame. */
    if (reduceMotion) draw(0);
  }, { passive: true });

  /* On a phone, scrolling shows and hides the browser's own address bar,
     which changes window.innerHeight and fires a resize here, over and over,
     for the whole time you scroll. A full rebuild reseeds every star at a new
     random spot, so the sky visibly jumped mid-scroll: the "wiggle". Only a
     real width change (turning the phone, resizing a window) is worth a
     reseed; a height-only change just resizes the canvas in place, so the
     stars already on screen do not move. */
  var rt = null;
  window.addEventListener("resize", function () {
    window.clearTimeout(rt);
    rt = window.setTimeout(function () {
      if (window.innerWidth !== lastW) { rebuild(); return; }
      size();
      if (reduceMotion) draw(0);
    }, 180);
  });

  /* Nothing runs against a hidden tab. */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else { planShot(); start(); }
  });

  planShot();
  rebuild();
  start();
})();
