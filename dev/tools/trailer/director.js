/*
 * The trailer's director, run inside the game's own page by `record.mjs`.
 *
 * It takes the page's clock over — animation frames, timers, `performance.now`
 * and `Date` all run on a virtual clock that only moves when a frame is asked
 * for — so every shot plays out the same way however long a frame takes to
 * photograph. Each shot is a few lines that set the game up, and optionally
 * something to do before every frame. What the game asks the speakers for is
 * written down rather than played, and mixed into the soundtrack afterwards.
 *
 * Not part of the shipped app.
 */
(() => {
  const FPS = 60;
  const STEP_MS = 1000 / FPS;
  /** One bar of the soundtrack (Emerald's champion battle, which loops at ten bars). */
  const BAR = 1.1321;
  const BEAT = BAR / 4;

  const app = () => window.__pdcApp;
  const session = () => app().session;
  const lang = () => document.documentElement.lang || 'ko';

  // ------------------------------------------------------------------ clock

  const clock = {
    now: performance.now(),
    rafs: /** @type {Array<{id: number, cb: FrameRequestCallback}>} */ ([]),
    timers: /** @type {Array<{id: number, at: number, cb: () => void, every?: number}>} */ ([]),
    nextId: 1,
    /** How fast the game runs against the film: 1 is real time. */
    speed: 1,
    hour: 12,
  };
  const realRAF = window.requestAnimationFrame.bind(window);
  const RealDate = Date;
  const dateBase = RealDate.now();
  const clockBase = clock.now;

  function install() {
    performance.now = () => clock.now;
    // The road is lit for the hour, so the hour is the director's too.
    window.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) {
          super(dateBase + (clock.now - clockBase));
          this.setHours(clock.hour, 0, 0, 0);
        } else {
          super(...args);
        }
      }
      static now() {
        return dateBase + (clock.now - clockBase);
      }
    };
    window.requestAnimationFrame = (cb) => {
      const id = clock.nextId++;
      clock.rafs.push({ id, cb });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      clock.rafs = clock.rafs.filter((entry) => entry.id !== id);
    };
    window.setTimeout = (cb, ms = 0, ...rest) => {
      const id = clock.nextId++;
      clock.timers.push({ id, at: clock.now + Math.max(0, Number(ms) || 0), cb: () => cb(...rest) });
      return id;
    };
    window.clearTimeout = (id) => {
      clock.timers = clock.timers.filter((entry) => entry.id !== id);
    };
  }

  /** Move the clock on one frame's worth of film, and run the game's frame. */
  function step(ms = STEP_MS) {
    clock.now += ms * clock.speed;
    for (let guard = 0; guard < 100; guard++) {
      const due = clock.timers.filter((entry) => entry.at <= clock.now).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      for (const entry of due) {
        clock.timers = clock.timers.filter((other) => other !== entry);
        try { entry.cb(); } catch (error) { console.error(error); }
      }
    }
    const rafs = clock.rafs;
    clock.rafs = [];
    for (const entry of rafs) {
      try { entry.cb(clock.now); } catch (error) { console.error(error); }
    }
  }

  /** Let real time pass — for images to decode — without moving the game. */
  const settle = (ms = 50) => new Promise((resolve) => window.__realSetTimeout(resolve, ms));
  window.__realSetTimeout = window.setTimeout.bind(window);

  // ------------------------------------------------------------------ sound

  const audioLog = [];
  let recording = false;
  /** Whether the shot rolling keeps its Pokémon's cries out of the film (`quiet`). */
  let hushed = false;
  let filmTime = 0;

  function muteAndLog() {
    const audio = app().audio;
    for (const method of ['playCry', 'blip', 'playJingle', 'playMusic', 'playSample', 'stopMusic']) {
      audio[method] = (...args) => {
        if (method === 'playMusic') audio.wanted = args[0] ?? null;
        if (recording && !(hushed && method === 'playCry')) audioLog.push({ t: filmTime, method, args });
        return Promise.resolve();
      };
    }
  }

  // ------------------------------------------------------------------ helpers

  const wait = (ms) => settle(ms);
  const clickText = (selector, texts) => {
    const nodes = [...document.querySelectorAll(selector)];
    const match = nodes.find((node) => texts.some((text) => (node.textContent || '').includes(text)));
    if (match) { match.click(); return true; }
    console.log('no match for ' + JSON.stringify(texts));
    return false;
  };
  const clickImageAlt = (alts) => {
    const image = [...document.querySelectorAll('img')].find((node) => alts.includes(node.alt));
    if (image) { (image.closest('button') || image).click(); return true; }
    return false;
  };
  const closeAll = () => {
    for (const modal of document.querySelectorAll('.modal')) modal.remove();
    while (app().stack.length > 1) app().pop();
    app().scene.setPaused?.(false);
  };
  const imports = {};
  const load = async (path) => (imports[path] ??= await import(path));

  async function preload(paths) {
    const { loadImage } = await load('./core/assets.mjs');
    await Promise.all(paths.map((path) => loadImage(path).catch(() => null)));
  }

  async function pokemonArt(ids, battle = false) {
    const { artOf } = await load('./core/data.mjs');
    const { battlerArt } = await load('./render/battler.mjs');
    const paths = ids.map((id) => (battle ? battlerArt({ speciesId: id }) : artOf({ speciesId: id }))?.path).filter(Boolean);
    await preload(paths);
  }

  /** A Pokémon of a species at a level, put on as the travelling one. */
  async function travelWith(speciesId, level) {
    const { createPokemon } = await load('./engine/pokemon.mjs');
    const pokemon = createPokemon(session().rng, speciesId, level, { ivFloor: 20 });
    pokemon.shiny = false;
    session().active = pokemon;
    return pokemon;
  }

  async function foe(speciesId, level, hpShare = 1) {
    const { createPokemon, maxHp } = await load('./engine/pokemon.mjs');
    const pokemon = createPokemon(session().rng, speciesId, level, { ivFloor: 20 });
    pokemon.shiny = false;
    pokemon.hp = Math.max(1, Math.round(maxHp(pokemon) * hpShare));
    return pokemon;
  }

  /**
   * The battle engine's next turn, written out instead of fought: the shots
   * are about what a move looks like, not about how a fight goes.
   */
  let scripted = null;
  let turnTaken = false;
  /** Whether the turns the engine fights for itself are written to the console, for choosing a take. */
  let turnLog = false;
  /** Told each turn the engine fights for itself, as it is taken and before it is played. */
  let onTurn = /** @type {((entries: any[]) => void) | null} */ (null);
  /** Frames of white still to come after a cut inside a shot. */
  let flashLeft = 0;
  const FLASH_FRAMES = 12;
  /** How far a shot has closed the shutter itself, 0 open to 1 shut, over whatever the cuts ask for. */
  let manualShut = 0;
  async function scriptTurns() {
    const { Battle } = await load('./engine/battle.mjs');
    if (Battle.prototype.__trailer) return;
    const take = Battle.prototype.takeTurn;
    Battle.prototype.__trailer = true;
    Battle.prototype.takeTurn = function takeTurn() {
      // A fight that has played its script is over as far as the film goes:
      // the turn after it would open with whatever the engine has queued up,
      // an Intimidate or the like, before the cut.
      if (this.__scripted) return [];
      if (!scripted) {
        const entries = take.call(this);
        if (turnLog) console.log('turn: ' + entries.map((entry) => entry.kind + (entry.side ? ':' + entry.side : '') + (entry.data?.move ? '(' + entry.data.move + ')' : '')).join(' '));
        onTurn?.(entries);
        return entries;
      }
      const script = scripted;
      scripted = null;
      this.__scripted = true;
      turnTaken = true;
      if (script.outcome) this.outcome = script.outcome;
      return script.entries(this);
    };
  }

  /**
   * One move landing: used, hit, and how well it worked.
   *
   * @param {{move: string, foeHp: number, effectiveness?: number|null, faint?: boolean, won?: boolean}} options
   *   an `effectiveness` of null says nothing about how well it worked
   */
  function moveTurn({ move, foeHp, effectiveness = 2, faint = false, won = false }) {
    return {
      outcome: won ? 'won' : null,
      entries: (battle) => {
        const playerHp = battle.player.pokemon.hp;
        const startHp = battle.foe?.pokemon.hp ?? 1;
        const hp = (foe) => ({ player: playerHp, foe });
        const entries = [
          { kind: 'move', side: 'player', data: { move }, hp: hp(startHp) },
          { kind: 'damage', side: 'foe', data: { amount: startHp - foeHp }, hp: hp(foeHp) },
        ];
        if (effectiveness !== null) entries.push({ kind: 'effectiveness', side: 'foe', data: { effectiveness }, hp: hp(foeHp) });
        if (faint) entries.push({ kind: 'faint', side: 'foe', data: { pokemon: battle.foe?.pokemon }, hp: hp(0) });
        if (won) entries.push({ kind: 'end', data: { outcome: 'won' }, hp: hp(0) });
        return entries;
      },
    };
  }

  /** Run the game on without filming until something holds, or for so long. */
  async function preroll(until, limitMs = 20000) {
    for (let at = 0; at < limitMs; at += STEP_MS) {
      step();
      if (typeof until === 'function' && until()) return;
      if (typeof until === 'number' && at + STEP_MS >= until) return;
      // Give the art a moment to come in now and then.
      if (Math.round(at / STEP_MS) % 20 === 0) await settle(5);
    }
  }

  // ------------------------------------------------------------- the desktop

  const stage = () => /** @type {HTMLElement} */ (document.getElementById('stage'));
  /** The landscape frame every shot is placed in, in the page's own pixels. */
  const frameWidth = () => (upright ? FRAME.width : innerWidth);
  const frameHeight = () => (upright ? FRAME.height : innerHeight);
  /** A length on a 1920-wide desktop, in the page's own pixels. */
  const px = (value) => (value * frameWidth()) / 1920;
  /** The companion's window on the desktop: a quarter of the screen, bottom right. */
  const WINDOW = { width: 480, height: 270, right: 18, bottom: 48 + 18 };

  function placeStage(x, y, scale) {
    const node = stage();
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.transform = `scale(${scale})`;
  }

  function desktop(wallpaper) {
    const root = document.createElement('div');
    root.id = 'trailer-desktop';
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '0', backgroundImage: `url("${wallpaper}")`,
      backgroundSize: 'cover', backgroundPosition: 'center',
    });
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'absolute', left: '0', right: '0', bottom: '0', height: `${px(48)}px`,
      background: 'rgba(28, 32, 44, 0.82)', borderTop: '1px solid rgba(255,255,255,0.08)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${px(10)}px`,
    });
    const colours = ['#3a8ee6', '#f2c14e', '#e8603c', '#52b788', '#8e6fd8', '#4cc9f0'];
    for (const colour of colours) {
      const icon = document.createElement('i');
      Object.assign(icon.style, { width: `${px(26)}px`, height: `${px(26)}px`, borderRadius: `${px(7)}px`, background: colour, opacity: '0.92', display: 'block', margin: `0 ${px(4)}px` });
      bar.append(icon);
    }
    const tray = document.createElement('div');
    Object.assign(tray.style, {
      position: 'absolute', right: `${px(14)}px`, top: '0', bottom: '0', display: 'flex', flexDirection: 'column',
      justifyContent: 'center', alignItems: 'flex-end', color: '#eef', fontSize: `${px(12)}px`, lineHeight: '1.35',
      fontFamily: "'Segoe UI', 'Malgun Gothic', sans-serif",
    });
    tray.append(Object.assign(document.createElement('span'), { textContent: lang() === 'ko' ? '오후 3:12' : '3:12 PM' }));
    tray.append(Object.assign(document.createElement('span'), { textContent: '2026-10-27' }));
    bar.append(tray);
    root.append(bar);
    (film ?? document.body).prepend(root);
    // The page is see-through where the game is not, which is the desktop.
    document.getElementById('dragframe').style.display = 'none';
    stage().style.boxShadow = `0 ${px(6)}px ${px(24)}px rgba(0,0,0,0.35)`;
  }

  function cornerRect() {
    return {
      x: frameWidth() - px(WINDOW.right + WINDOW.width),
      y: frameHeight() - px(WINDOW.bottom + WINDOW.height),
      scale: px(WINDOW.width) / 480,
    };
  }

  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

  /**
   * Bring the camera in on a point of the game's picture: `amount` of the way
   * to `zoom` times the full-screen size, with the point drifting towards the
   * middle of the frame as it closes in, and never past the picture's edge.
   *
   * @param {number} amount 0 to 1
   * @param {number} zoom
   * @param {{x: number, y: number}} focus as shares of the picture
   */
  function closeUp(amount, zoom, focus) {
    const across = frameWidth();
    const down = frameHeight();
    const scale = (across / 480) * (1 + (zoom - 1) * amount);
    const width = 480 * scale;
    const height = 270 * scale;
    const x = focus.x * across + (across / 2 - focus.x * across) * amount;
    const y = focus.y * down + (down / 2 - focus.y * down) * amount;
    placeStage(
      Math.min(0, Math.max(across - width, x - focus.x * width)),
      Math.min(0, Math.max(down - height, y - focus.y * height)),
      scale,
    );
  }

  /**
   * A slow push in on a point of the picture across a whole shot, the point
   * held where it is on screen: the camera never quite stops, as it does not
   * in the trailers this one learns from, so a cut reads as the film moving on
   * rather than as one still picture swapped for another.
   *
   * @param {number} frame
   * @param {number} frames
   * @param {{x: number, y: number}} focus as shares of the picture
   * @param {number} [by] how much closer by the end
   */
  function push(frame, frames, focus, by = 0.035) {
    const scale = (frameWidth() / 480) * (1 + by * (frame / frames));
    placeStage(focus.x * frameWidth() - focus.x * 480 * scale, focus.y * frameHeight() - focus.y * 270 * scale, scale);
  }

  /**
   * Whether the game's picture is scaled smoothly. Hard pixels scaled by a
   * fraction that changes every frame crawl — a column of them doubling here
   * and there as the camera moves — which is the stutter a push in had; while
   * the camera moves the picture is sampled smoothly instead.
   *
   * @param {boolean} on
   */
  function smooth(on) {
    // The road's own layers under the canvas as well (`render/fieldlayers.mjs`).
    for (const node of document.querySelectorAll('#stage canvas, #stage .field-sky-marks')) {
      /** @type {HTMLElement} */ (node).style.imageRendering = on ? 'auto' : '';
    }
  }

  /**
   * The road's panels the berry picking clears away: the name panel, the
   * buttons along the bottom left, and the shop's beside the road's name —
   * which stays, since it is the road that is changing.
   */
  function roadChrome() {
    const hud = document.querySelector('.hud');
    if (!hud) return [];
    return [hud.children[0], hud.children[2], hud.children[3]?.querySelector('button')].filter(Boolean);
  }

  /** @param {number} amount 0 shown, 1 gone */
  function fadeChrome(amount) {
    for (const node of roadChrome()) {
      node.style.transition = 'none';
      node.style.opacity = String(1 - amount);
    }
  }

  /**
   * How far the camera has come in on the berry picking: from a moment before
   * the companion reaches the tree, so the walk eases into the close-up
   * rather than stopping dead under a camera that then starts to move.
   */
  function pickingCamera() {
    const from = montageFrame() - Math.round(PICKING_LEAD_S * FPS);
    return ease(Math.min(1, Math.max(0, (frameNumber - from) / (PICKING_IN_S * FPS))));
  }

  /**
   * The last blow: how long the move takes before it hits, in the game's
   * time, and how long the film gives that — the rest of the bar and a half
   * to the faint goes to the hit, which takes as long as it takes.
   */
  const FINAL_MOVE_MS = 520;
  const FINAL_HIT_MS = 680;
  const FINAL_WINDUP_S = 1.5 * BAR - FINAL_HIT_MS / 1000;

  /** The road the champion walks on at the end. */
  const ENDING_ROAD = 'route103';

  /** Where on screen the berry picking is, as the camera comes in on it. */
  const pickingPan = () => PICKING_FOCUS.x + (0.5 - PICKING_FOCUS.x) * pickingCamera();

  // ---------------------------------------------------------------- upright

  /*
   * The phone-shaped cut is filmed, not cropped out of the landscape one. Its
   * frame is 1080x1920, drawn on its side in the landscape window (no display
   * has room for a window that tall) and stood up by record.mjs.
   *
   * It is laid out the way a short is, not as a letterboxed trailer: the
   * picture fills the whole frame, with a big word or two over it on the beat.
   * Most shots are the game itself, eight screen pixels to a game pixel, slid
   * under the frame to wherever the shot says to look (`pan`, `tilt`). Two
   * kinds are panels drawn from the game's canvas instead: a battle cut in two,
   * the wild one on top and the companion below, so both are seen at once and
   * large; and the berry picking cut in three, a different Pokémon on a
   * different road in each, changing on beats of their own. The battle's own
   * panels and message box are left out — the words say what they would.
   */
  let upright = false;
  /** Whether the upright cut's lines are drawn over the picture. */
  let captions = true;
  const FRAME = { width: 960, height: 540 };
  const PHONE = { width: 540, height: 960 };
  /** The landscape frame to the phone's, for a picture that fills its height: eight screen pixels a game pixel. */
  const LOOK = 2;
  /** Where the two sides of a battle stand, as shares of the frame's width. */
  const FOE_SIDE = 0.72;
  const PLAYER_SIDE = 0.28;
  /** Between two panels, in the page's pixels (two screen pixels each). */
  const SEAM = 2;
  /** @type {HTMLElement | null} */
  let film = null;
  /** @type {HTMLElement | null} */
  let phone = null;
  /** @type {HTMLElement | null} */
  let view = null;
  const panels = { node: /** @type {HTMLElement | null} */ (null), canvases: /** @type {HTMLCanvasElement[]} */ ([]), kind: null, since: 0 };
  const caption = { node: null, small: null, big: null, key: null, since: 0 };
  /** Where the battle's words go: over the seam, a little high, off the companion's face. */
  const BATTLE_AT = 0.43;
  /** Where the words go for whoever the companion is up against: under their feet. */
  const RIVAL_AT = 0.8;
  /** The logo's colours. */
  const LOGO = { yellow: '#ffcb05', blue: '#2a5ab0', navy: '#0e2350' };

  /**
   * The battle cut in two: where on the game's canvas each half looks, six
   * screen pixels a game pixel — the wild one above its platform, the
   * companion from its feet up.
   */
  const SPLIT = { scale: 6, crops: [{ x: 260, y: 30 }, { x: 34, y: 92 }] };
  /** The berry picking cut in three, six screen pixels a game pixel: the companion and the tree. */
  const GRID = { scale: 6, crop: { x: 83, y: 82 } };

  /**
   * The Pokémon the three panels of the berry picking go through, each its
   * own run of them — none twice — across every generation.
   */
  const gridPickers = () => [
    ...PICKERS,
    1, 7, 39, 52, 54, 79, 92, 104, 129, 143, 155, 158, 179, 183, 216, 252, 255, 280, 300, 328, 387, 390, 427, 447,
    501, 570, 607, 650, 653, 661, 700, 725, 728, 810, 816, 835, 848, 877, 909, 912, 921, 926, 957, 446, 113,
  ];

  // Added to the game's own sheet: its policy turns away a style element.
  const UPRIGHT_RULES = [
    `body.trailer-upright :is(.battle-bar, .battle-actions, .battle-message, .battle-balls, .battle-field, .league-actions) { visibility: hidden; }`,
    // The ceremony's plate is wider than a phone's share of the picture, and
    // its banner says what the words over it do.
    `body.trailer-upright .fame-plate { zoom: 0.48; }`,
    `body.trailer-upright .fame-welcome { visibility: hidden; }`,
    // The champion's room names him under his portrait; the words over the picture do, larger.
    `body.trailer-upright .league-caption { visibility: hidden; }`,
  ];

  function uprightSetup() {
    document.body.classList.add('trailer-upright');
    document.body.style.background = '#11151f';
    const sheet = [...document.styleSheets].find((entry) => entry.href?.endsWith('styles.css')) ?? document.styleSheets[0];
    for (const rule of UPRIGHT_RULES) sheet.insertRule(rule, sheet.cssRules.length);
    // The phone's frame, turned a quarter clockwise to lie across the window:
    // its top edge along the window's right.
    phone = document.createElement('div');
    Object.assign(phone.style, {
      position: 'fixed', left: '0', top: '0', width: `${PHONE.width}px`, height: `${PHONE.height}px`,
      transform: `translateX(${FRAME.width}px) rotate(90deg)`, transformOrigin: '0 0', overflow: 'hidden',
      background: '#11151f',
    });
    document.body.append(phone);
    view = document.createElement('div');
    Object.assign(view.style, { position: 'absolute', inset: '0', overflow: 'hidden', zIndex: '1' });
    // Transformed, so that what is fixed inside it — the desktop — is fixed
    // to the landscape frame rather than the window.
    film = document.createElement('div');
    Object.assign(film.style, {
      position: 'absolute', left: '0', top: '0', width: `${FRAME.width}px`, height: `${FRAME.height}px`,
      transform: `scale(${LOOK})`, transformOrigin: '0 0', overflow: 'hidden',
    });
    film.append(stage());
    view.append(film);
    phone.append(view);
    panels.node = document.createElement('div');
    Object.assign(panels.node.style, { position: 'absolute', inset: '0', zIndex: '2', background: '#f4f4f0', display: 'none', overflow: 'hidden' });
    phone.append(panels.node);
    caption.node = document.createElement('div');
    Object.assign(caption.node.style, {
      // Over the transitions too: the words stay up through a cut.
      position: 'absolute', left: '0', right: '0', zIndex: '150', display: 'flex', flexDirection: 'column', alignItems: 'center',
      color: '#fff', fontFamily: "'Segoe UI Black', 'Malgun Gothic', sans-serif", fontWeight: '900', whiteSpace: 'nowrap',
      lineHeight: '1', pointerEvents: 'none',
    });
    const outline = (width, colour) => [...Array(16)].map((_, i) => {
      const angle = (i / 16) * Math.PI * 2;
      return `${(Math.cos(angle) * width).toFixed(1)}px ${(Math.sin(angle) * width).toFixed(1)}px 0 ${colour}`;
    }).join(', ');
    // In the logo's colours: the big line in its yellow, edged in its blue;
    // the small line white on the same blue.
    caption.small = document.createElement('div');
    Object.assign(caption.small.style, { fontSize: '30px', letterSpacing: '0.02em', textShadow: outline(3.5, LOGO.blue) });
    caption.big = document.createElement('div');
    Object.assign(caption.big.style, {
      fontSize: '96px', letterSpacing: '0.01em', color: LOGO.yellow, textShadow: `${outline(7, LOGO.blue)}, 0 10px 0 ${LOGO.navy}`,
    });
    caption.node.append(caption.small, caption.big);
    phone.append(caption.node);
  }

  /**
   * Slide the frame under the phone so it looks at a point: shares of the
   * frame's width and height, kept from running past its edges.
   */
  function aim(across, down = 0.5) {
    const width = PHONE.width / LOOK;
    const height = PHONE.height / LOOK;
    const left = Math.min(FRAME.width - width, Math.max(0, across * FRAME.width - width / 2));
    const top = Math.min(FRAME.height - height, Math.max(0, down * FRAME.height - height / 2));
    // To the screen pixel, of which there are two to the page's.
    film.style.left = `${-Math.round(left * LOOK * 2) / 2}px`;
    film.style.top = `${-Math.round(top * LOOK * 2) / 2}px`;
  }

  /**
   * A value eased from one to the next between moments of a shot, and held
   * before the first and after the last.
   *
   * @param {number} t seconds into the shot
   * @param {Array<[number, number]>} keys [seconds, value] in order
   */
  function glide(t, keys) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [from, start] = keys[i - 1];
      const [to, end] = keys[i];
      if (t < to) return start + (end - start) * ease((t - from) / (to - from));
    }
    return keys[keys.length - 1][1];
  }

  /** Past the mark and back, for a word that lands. */
  const overshoot = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;

  /**
   * Show the panels of a kind — 'split' or 'grid' — or the picture itself
   * (null). Panels coming in slide into place, a little apart.
   */
  function showPanels(kind) {
    if (panels.kind === kind) return;
    panels.kind = kind;
    panels.since = frameNumber;
    panels.node.style.display = kind ? 'block' : 'none';
    view.style.visibility = kind ? 'hidden' : 'visible';
    panels.node.replaceChildren();
    panels.canvases = [];
    if (!kind) return;
    const rows = kind === 'split' ? 2 : 3;
    const height = (PHONE.height - SEAM * (rows - 1)) / rows;
    for (let row = 0; row < rows; row++) {
      const canvas = document.createElement('canvas');
      canvas.width = PHONE.width * 2;
      canvas.height = Math.round(height * 2);
      Object.assign(canvas.style, {
        position: 'absolute', left: '0', top: `${row * (height + SEAM)}px`, width: `${PHONE.width}px`, height: `${height}px`,
        imageRendering: 'pixelated',
      });
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = false;
      panels.node.append(canvas);
      panels.canvases.push(canvas);
    }
  }

  /** Slide each panel the rest of the way in. */
  function settlePanels() {
    const t = (frameNumber - panels.since) / FPS;
    panels.canvases.forEach((canvas, row) => {
      const local = Math.min(1, Math.max(0, (t - row * 0.07) / 0.28));
      const away = 1 - ease(local);
      // A battle's halves meet from above and below; the picking's rows from either side.
      canvas.style.transform = panels.kind === 'split'
        ? `translateY(${(row === 0 ? -1 : 1) * away * 100}%)`
        : `translateX(${(row % 2 ? 1 : -1) * away * 100}%)`;
    });
  }

  /**
   * Draw part of the game's canvas into a panel, a whole number of screen
   * pixels to a game pixel.
   */
  function fill(canvas, scale, x, y) {
    const context = canvas.getContext('2d');
    const width = canvas.width / scale;
    const height = Math.ceil(canvas.height / scale);
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // The whole picture, the road's layers under the canvas included.
    const picture = app().snapshot();
    context.drawImage(picture, x, y, width, height, 0, 0, width * scale, height * scale);
    // A panel that looks past the picture's bottom edge has its last row
    // carried on down, rather than black under it.
    const rows = picture.height - y;
    if (rows < height) context.drawImage(picture, x, picture.height - 1, width, 1, 0, rows * scale, width * scale, canvas.height - rows * scale);
  }

  /**
   * Paint the game's canvas again as it stands, without moving the game on:
   * a frame of no time, so the road takes up whoever and wherever it was just
   * given. It picks up a new sprite and sky when they have loaded — from the
   * cache, but a promise later — so it is given a moment and painted again.
   */
  async function redraw() {
    app().tick(0);
    await settle(1);
    app().tick(0);
  }

  /**
   * The phone's picture for this frame, once the game has drawn it: the
   * panels the shot asks for, drawn from the game's canvas.
   */
  async function compose(shot, frame) {
    const kind = shot.panels?.call(shot, frame) ?? null;
    showPanels(kind);
    if (!kind) return;
    settlePanels();
    if (kind === 'split') {
      const crops = shot.crops ?? SPLIT.crops;
      panels.canvases.forEach((canvas, row) => fill(canvas, SPLIT.scale, crops[row].x, crops[row].y));
      return;
    }
    // The picking: the game drawn again for each row, with that row's
    // Pokémon on that row's road, the game itself not moved on.
    const keep = { speciesId: session().active.speciesId, area: session().area, hour: clock.hour };
    for (const [row, canvas] of panels.canvases.entries()) {
      const { picker, road } = gridCell(shot, frame, row);
      session().active.speciesId = picker;
      session().active.forme = null;
      if (road.area) session().area = road.area;
      clock.hour = road.hour;
      await redraw();
      fill(canvas, GRID.scale, GRID.crop.x, GRID.crop.y);
    }
    session().active.speciesId = keep.speciesId;
    session().area = keep.area;
    clock.hour = keep.hour;
  }

  /**
   * Who is on which road in a row of the picking: each row changes every
   * three eighth notes, as the bob goes, the next row an eighth after it, so
   * the change runs down the rows.
   */
  function gridCell(shot, frame, row) {
    const eighth = Math.floor(frame / FPS / (BEAT / 2) + 1e-6);
    const turn = Math.max(0, Math.floor((eighth - row) / 3));
    const index = turn * 3 + row;
    const pickers = gridPickers();
    return { picker: pickers[index % pickers.length], road: shot.areas[(index * 5) % shot.areas.length] };
  }

  /**
   * The words over the picture: a small line and a big one, which comes in
   * large and lands. Where on the phone they sit follows the layout — over
   * the top of the picture, or across the seam between two panels.
   *
   * @param {{key: string, small?: string, big: string, at?: number, under?: boolean}|null} line
   *   `under` puts the small line below the big one
   */
  function drawCaption(line) {
    if (!caption.node) return;
    if (!line) {
      caption.node.style.opacity = '0';
      caption.key = null;
      return;
    }
    if (line.key !== caption.key) {
      caption.key = line.key;
      caption.since = frameNumber;
    }
    caption.small.textContent = line.small ?? '';
    caption.small.style.display = line.small ? 'block' : 'none';
    caption.node.style.flexDirection = line.under ? 'column-reverse' : 'column';
    caption.small.style.margin = line.under ? '10px 0 0' : '0 0 8px';
    caption.big.textContent = line.big;
    // As large as fits across, with a margin either side.
    let size = 96;
    caption.big.style.fontSize = `${size}px`;
    while (caption.big.offsetWidth > PHONE.width - 36 && size > 30) caption.big.style.fontSize = `${(size -= 4)}px`;
    const middle = (line.at ?? 0.2) * PHONE.height;
    caption.node.style.top = `${middle - caption.node.offsetHeight / 2}px`;
    const t = (frameNumber - caption.since) / FPS;
    const land = Math.min(1, t / 0.22);
    caption.node.style.opacity = String(Math.min(1, t / 0.06));
    caption.big.style.transform = `scale(${1.5 - 0.5 * overshoot(land)}) rotate(${-3 * (1 - land) - 1}deg)`;
    caption.small.style.transform = `translateY(${(1 - ease(Math.min(1, t / 0.18))) * 14}px)`;
  }

  /** The lines, by language. */
  const SAY = {
    en: {
      desktop: ['A POKÉMON ADVENTURE', 'ON YOUR DESKTOP'],
      walk: ['IT WALKS ON ITS OWN', 'WITH YOU'],
      pokemon: ['POKÉMON TO MEET', ''],
      battle: ['WITH YOUR POKÉMON', 'BATTLE!'],
      rival: ['BATTLE AGAINST', ''],
      fame: ['YOU BECOME THE', 'CHAMPION!'],
      onward: ['AND THE JOURNEY', 'GOES ON'],
    },
    ko: {
      desktop: ['바탕화면에서 펼쳐지는', '포켓몬 모험'],
      walk: ['알아서 걷고 탐험하는', '나의 파트너'],
      pokemon: ['만날 수 있는 포켓몬', ''],
      battle: ['내 포켓몬과 함께', '배틀!'],
      rival: ['대결 상대', ''],
      fame: ['드디어', '챔피언!'],
      onward: ['모험은', '계속된다'],
    },
  };

  /** A line of {@link SAY}, as {@link drawCaption} takes it. */
  function say(key, options = {}) {
    const [small, big] = (SAY[lang()] ?? SAY.en)[key];
    return { key, small, big, ...options };
  }

  /** The number of Pokémon, counting up to 1,025 across the picking's first bar and a half. */
  function pokedexCount(frame) {
    const share = Math.min(1, frame / FPS / (1.5 * BAR));
    const count = Math.round(1 + 1024 * (1 - (1 - share) ** 3));
    return lang() === 'ko' ? `${count.toLocaleString('en-US')}종` : count.toLocaleString('en-US');
  }

  // ------------------------------------------------------------ transitions

  /*
   * How one shot gives way to the next, named by the shot coming in (into).
   * Every cut falls on a bar line and the transition is centred on it: out
   * frames at the end of the shot going out, in frames at the start of the next.
   *
   * - shutter: the game's own way into a battle — the dark closing from top
   *   and bottom and opening again — for the way from the gyms to the League.
   * - white: through a flash of white.
   * - fade: the last frame of the shot going out, laid over the next and
   *   faded off it; record.mjs hands that frame back (freeze).
   */
  const curtain = { top: null, bottom: null, white: null, frozen: null };

  function curtains() {
    if (curtain.top) return curtain;
    const layer = (style) => {
      const node = document.createElement('div');
      Object.assign(node.style, { position: 'fixed', left: '0', right: '0', zIndex: '100', pointerEvents: 'none', ...style });
      // Over the whole phone, panels and all.
      (phone ?? document.body).append(node);
      return node;
    };
    curtain.top = layer({ top: '0', height: '0', background: '#05070c' });
    curtain.bottom = layer({ bottom: '0', height: '0', background: '#05070c' });
    curtain.white = layer({ top: '0', bottom: '0', background: '#ffffff', opacity: '0' });
    // The whole window, as record.mjs photographed it.
    curtain.frozen = document.createElement('img');
    Object.assign(curtain.frozen.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '99', opacity: '0', pointerEvents: 'none' });
    document.body.append(curtain.frozen);
    return curtain;
  }

  /**
   * Draw this frame's share of the transition either side of a cut.
   *
   * @param {number} index the shot being filmed
   * @param {number} frame its frame
   */
  function drawTransition(index, frame) {
    const layers = curtains();
    const mine = SHOTS[index].into;
    const next = SHOTS[index + 1]?.into;
    let kind = null;
    let amount = 0;
    if (mine && mine.kind !== 'fade' && frame < (mine.in ?? 0)) {
      kind = mine.kind;
      amount = 1 - (frame + 1) / (mine.in + 1);
    }
    const left = counts[index] - frame;
    if (next && next.kind !== 'fade' && left <= (next.out ?? 0)) {
      kind = next.kind;
      amount = (next.out - left + 1) / next.out;
    }
    const shut = Math.max(kind === 'shutter' ? ease(amount) : 0, manualShut);
    layers.top.style.height = (shut * 50.5) + '%';
    layers.bottom.style.height = (shut * 50.5) + '%';
    // A cut inside a shot — a fight picked up again at its last turn — is
    // through a short flash of white as well.
    const flash = flashLeft > 0 ? flashLeft-- / FLASH_FRAMES : 0;
    layers.white.style.opacity = String(Math.max(kind === 'white' ? amount : 0, flash));
    layers.frozen.style.opacity = mine?.kind === 'fade' && frame < mine.frames ? String(1 - (frame + 1) / mine.frames) : '0';
  }


  // ------------------------------------------------------------------ shots

  /** The Pokémon that pick the berries, swapped in on the bob — one every three eighth notes. */
  const PICKERS = [4, 25, 10103, 152, 175, 258, 10174, 393, 448, 10238, 495, 658, 10162, 722, 778, 10253, 813, 887, 906, 10100, 133, 1000];
  /** And the roads behind them, changing with them: one road for each. */
  const ROADS = [
    ['route101', 12], ['petalburg-woods', 15], ['route119', 11], ['fiery-path', 13], ['route111', 15], ['meteor-falls', 12],
    ['route113', 16], ['kanto-route-24', 19], ['safari-zone', 11], ['viridian-forest', 14], ['shoal-cave', 12], ['route120', 22],
    ['mt-moon', 12], ['kanto-route-1', 7], ['route104', 18], ['seafoam-islands', 12], ['route123', 13], ['route110', 16],
    ['granite-cave', 12], ['kanto-route-25', 19], ['rock-tunnel', 12], ['route117', 8],
  ];

  /**
   * The fights: who is sent out against what, and where — and for the last,
   * the move it lands.
   */
  const FIGHTS = [
    { player: 448, foe: 10102, backdrop: 'cave' },
    { player: 658, foe: 10230, backdrop: 'water' },
    { player: 778, foe: 887, backdrop: 'long-grass' },
    { player: 908, foe: 195, backdrop: 'pond' },
    { player: 94, foe: 10163, backdrop: 'building' },
    { player: 248, foe: 823, backdrop: 'rock' },
    { player: 25, foe: 130, move: 'thunderbolt', backdrop: 'sky', effectiveness: 4, foeHp: 0.08 },
  ];

  /**
   * How long into a wild fight, after the way in, a send-out shot opens: just
   * before the companion's ball goes up, so that it lands — and the Pokémon
   * comes out — on the second beat of the shot's bar.
   */
  const SEND_OUT_AT = 1000 + 16 - (2 * BEAT * 1000 - 520);

  const LEADERS = [
    { id: 'normal-whitney', foe: 241 },
    { id: 'water-nessa', foe: 834 },
    { id: 'electric-iono', foe: 939 },
  ];

  /** The camera on the berry picking: the companion and the tree, a little closer. */
  const PICKING_ZOOM = 1.5;
  /** The close-up starts this long before the tree is reached, and takes this long. */
  const PICKING_LEAD_S = 0.35;
  const PICKING_IN_S = 1.2;
  const PICKING_FOCUS = { x: (Math.round(240 * 0.32) + 10) / 240, y: 0.58 };

  /** Where the camera pushes in on a send-out, and on a leader. */
  const SENT_OUT = { x: 0.32, y: 0.62 };
  const LEADER = { x: 0.72, y: 0.48 };

  let wallpaperUrl = '';
  let berryStarted = false;
  /**
   * How long the companion walks to an event that has just been spawned: it
   * spawns beyond the right edge and is met short of it (see `fieldevents`).
   */
  const BERRY_WALK_S = (240 - Math.round(240 * 0.32) + 24 - 20) / 34;
  const montageFrame = () => counts.slice(0, SHOTS.findIndex((shot) => shot.name === 'montage')).reduce((a, b) => a + b, 0);

  /**
   * One of the fights. Most are a send-out — the wild one standing there, the
   * companion's ball thrown and the companion out — and nobody moves after
   * it; `attack` opens on a move landing instead. `entry` keeps the game's
   * own way into the fight at the start of the shot.
   */
  async function fight(index, { attack = false, entry = false } = {}) {
    const spec = FIGHTS[index];
    const { battleScene } = await load('./scenes/battle.mjs');
    closeAll();
    await travelWith(spec.player, 60);
    await pokemonArt([spec.player, spec.foe], true);
    await preload([`battle/${spec.backdrop}.png`, 'items/poke-ball.png']);
    const enemy = await foe(spec.foe, 55);
    turnTaken = false;
    scripted = attack
      ? moveTurn({ move: spec.move, foeHp: Math.round(enemy.hp * spec.foeHp), effectiveness: spec.effectiveness })
      : { entries: () => [] };
    // Under a clear sky, whatever the road the montage ended on was having.
    app().push(battleScene({ session: session(), foes: [enemy], backdrop: spec.backdrop, weather: null, onFinish: () => {} }));
    if (attack) await preroll(() => turnTaken);
    else if (!entry) await preroll(780 + SEND_OUT_AT);
  }

  async function leader(index) {
    const spec = LEADERS[index];
    const { gameData } = await load('./core/data.mjs');
    const { battleScene } = await load('./scenes/battle.mjs');
    const record = gameData().leaders.find((entry) => entry.id === spec.id);
    closeAll();
    await travelWith(6, 50);
    await pokemonArt([6, spec.foe], true);
    await preload([`trainers/portraits/${record.portrait}.png`, 'battle/leader.png']);
    const enemy = await foe(spec.foe, 48);
    // The shot is the leader's entrance: nobody moves after the send-outs.
    scripted = { entries: () => [] };
    app().push(battleScene({ session: session(), foes: [enemy], trainer: record, leader: true, backdrop: 'leader', weather: null, onFinish: () => {} }));
    // From the moment the way in has opened on the leader, to just before the
    // line that sends the companion out.
    await preroll(780);
    return (record.name[lang()] ?? record.name.en).toUpperCase();
  }

  async function hoennLeague() {
    const { gameData } = await load('./core/data.mjs');
    return gameData().leagues.find((entry) => entry.region === 'hoenn');
  }

  const TRAILER = [
    {
      name: 'desktop',
      bars: 2,
      says: () => say('desktop'),
      async begin() {
        desktop(wallpaperUrl);
        const corner = cornerRect();
        placeStage(corner.x, corner.y, corner.scale);
      },
      // The corner the companion's window is in, and the taskbar under it.
      pan: () => 1,
      tilt: () => 1,
    },
    {
      name: 'zoom',
      bars: 1,
      says: () => say('desktop'),
      before(frame, frames) {
        const corner = cornerRect();
        const progress = ease(Math.min(1, frame / (frames - 1)));
        const scale = corner.scale + (frameWidth() / 480 - corner.scale) * progress;
        placeStage(corner.x * (1 - progress), corner.y * (1 - progress), scale);
        stage().style.borderRadius = `${px(6) * (1 - progress)}px`;
        // Upright, the window is too narrow for the panels: they go as the
        // camera comes in, as they do on the berry picking.
        if (upright) fadeChrome(progress);
        this.companion = (corner.x * (1 - progress) + PICKING_FOCUS.x * 480 * scale) / frameWidth();
        this.companionY = (corner.y * (1 - progress) + PICKING_FOCUS.y * 270 * scale) / frameHeight();
      },
      // On the companion all the way in.
      pan() {
        return this.companion;
      },
      tilt() {
        return this.companionY;
      },
      end() {
        document.getElementById('trailer-desktop')?.remove();
        stage().style.boxShadow = 'none';
      },
    },
    {
      name: 'walk',
      bars: 3,
      says: () => say('walk'),
      before() {
        if (upright) fadeChrome(1);
        const closing = pickingCamera();
        if (closing <= 0) return;
        smooth(true);
        closeUp(closing, PICKING_ZOOM, PICKING_FOCUS);
        if (!upright) fadeChrome(closing);
      },
      pan: pickingPan,
      tilt: () => PICKING_FOCUS.y + (0.5 - PICKING_FOCUS.y) * pickingCamera(),
    },
    {
      name: 'montage',
      bars: 8,
      // Upright, three panels with a Pokémon on a road each, and the count of them over the first seam.
      panels: () => 'grid',
      says: (frame) => ({ ...say('pokemon'), big: pokedexCount(frame), at: 1 / 3, under: true }),
      async begin() {
        const { gameData } = await load('./core/data.mjs');
        await pokemonArt(upright ? gridPickers() : PICKERS);
        const areas = gameData().areas;
        await preload(ROADS.flatMap(([id, hour]) => [`areas/${id}/${timeKey(hour)}.png`]));
        this.areas = ROADS.map(([id, hour]) => ({ area: areas.find((entry) => entry.id === id), hour }));
        // The bob is 460 ms a hop; three eighth notes are 424.5 ms, so the
        // whole road runs that much faster while the picking goes on.
        clock.speed = 460 / ((BEAT / 2) * 3 * 1000);
      },
      async before(frame) {
        const t = frame / FPS;
        const eighth = Math.floor(t / (BEAT / 2) + 1e-6);
        const picker = PICKERS[Math.floor(eighth / 3) % PICKERS.length];
        const road = this.areas[Math.floor(eighth / 3) % this.areas.length];
        if (session().active.speciesId !== picker) {
          session().active.speciesId = picker;
          session().active.forme = null;
        }
        if (road.area && session().area !== road.area) session().area = road.area;
        clock.hour = road.hour;
        // In on the picking and held there, the panels going as the camera
        // comes in: the name changes faster than it could be read.
        const closing = pickingCamera();
        closeUp(closing, PICKING_ZOOM, PICKING_FOCUS);
        fadeChrome(upright ? 1 : closing);
      },
      end() {
        clock.speed = 1;
        clock.hour = 12;
        // The berry tree put the road's own timer back; nothing else is to turn up.
        session().eventTimer = 1e9;
        for (const node of roadChrome()) {
          node.style.opacity = '';
          node.style.transition = '';
        }
      },
    },
    // Opened on the game's own way into a fight from the berry tree, with the
    // wild one's cry as it starts; the camera comes back out while the screen
    // is shut.
    {
      name: 'fight-1',
      bars: 3,
      listen: true,
      begin: () => fight(0, { entry: true }),
      // The berry tree while the screen flashes, then the fight cut in two.
      panels: (frame) => (frame / FPS < 0.45 ? null : 'split'),
      tilt: () => PICKING_FOCUS.y,
      says: (frame) => (frame / FPS < 0.45 ? null : say('battle', { at: BATTLE_AT, under: true })),
      before(frame, frames) {
        // Still in close on the berry tree while the screen flashes, and back
        // out to the whole picture while it is shut.
        const shut = Math.round(0.39 * FPS);
        if (frame < shut) closeUp(1, PICKING_ZOOM, PICKING_FOCUS);
        else push(frame - shut, frames - shut, SENT_OUT, 0.03);
      },
      pan: () => 0.5,
    },
    // A bar each: the ball thrown, the Pokémon out on the second beat, and on
    // into the next fight on the bar line — a send-out a bar, as the music
    // goes — and a move only in the last.
    ...[1, 2, 3, 4, 5].map((index) => ({
      name: 'fight-' + (index + 1),
      bars: 1,
      into: { kind: 'fade', frames: 6 },
      begin: () => fight(index),
      panels: () => 'split',
      says: () => say('battle', { at: BATTLE_AT, under: true }),
      before: (frame, frames) => push(frame, frames, SENT_OUT, 0.03),
    })),
    {
      name: 'fight-7',
      bars: 2,
      into: { kind: 'fade', frames: 8 },
      begin: () => fight(6, { attack: true }),
      panels: () => 'split',
      says: () => say('battle', { at: BATTLE_AT, under: true }),
      before: (frame, frames) => push(frame, frames, { x: 0.55, y: 0.45 }, 0.035),
    },
    // The leader standing there, stepping off and throwing out their first
    // Pokémon — and cut before the companion's ball goes up. Out of the fights
    // through white, and each leader dissolving into the next. Without the
    // cry the Pokémon gives as its ball opens: it comes a moment before each
    // cut and rings on into the next leader.
    {
      name: 'leader-1',
      bars: 1.5,
      quiet: true,
      into: { kind: 'white', out: 6, in: 10 },
      async begin() {
        this.leader = await leader(0);
      },
      says() {
        return { ...say('rival', { at: RIVAL_AT }), key: this.name, big: this.leader };
      },
      tilt: () => 0.42,
      before: (frame, frames) => push(frame, frames, LEADER, 0.04),
      pan: () => FOE_SIDE,
    },
    ...[1, 2].map((index) => ({
      name: `leader-${index + 1}`,
      bars: 1.5,
      quiet: true,
      into: { kind: 'fade', frames: 12 },
      async begin() {
        this.leader = await leader(index);
      },
      before: (frame, frames) => push(frame, frames, LEADER, 0.04),
      pan: () => FOE_SIDE,
      tilt: () => 0.42,
      says() {
        return { ...say('rival', { at: RIVAL_AT }), key: this.name, big: this.leader };
      },
    })),
    // The League's door and the champion's room in one take: the challenge
    // is taken, the game's own way into the fight plays, and Steven is
    // standing there when it opens.
    {
      name: 'league',
      bars: 3,
      into: { kind: 'shutter', out: 12, in: 14 },
      says() {
        return { ...say('rival', { at: RIVAL_AT }), key: 'champion', big: this.champion };
      },
      // Steven in his room, and over to his side once the fight has begun.
      pan: () => (document.querySelector('.battle-screen') ? FOE_SIDE : 0.5),
      async begin() {
        const { leagueScene } = await load('./scenes/league.mjs');
        const league = await hoennLeague();
        closeAll();
        await travelWith(6, 80);
        session().badges = ['rock', 'fighting', 'electric', 'fire', 'normal', 'flying', 'psychic', 'water'];
        session().leagueRun = { region: 'hoenn', alternate: null, round: 4 };
        // The League's fight takes its sky from the road, as in the game.
        session().area = (await load('./core/data.mjs')).gameData().areas.find((entry) => entry.id === 'route101');
        // Steven opens with the Metagross the last blow lands on, so the two
        // shots are one fight rather than two Pokémon.
        league.champion.party = [376];
        this.champion = (league.champion.name[lang()] ?? league.champion.name.en).toUpperCase();
        await pokemonArt([6, 376], true);
        await preload(['trainers/portraits/steven.png', 'rooms/champion.png', 'battle/champion.png']);
        app().push(leagueScene({ session: session(), onLeave: () => {}, onCrowned: () => {} }));
        await preroll(400);
      },
      before(frame, frames) {
        // So that the champion's Metagross is all the way out of its ball by
        // the cut, and the companion's has not yet been thrown — the cut the
        // leaders' shots make too.
        if (frame === Math.round((0.38 + 2 * BEAT) * FPS)) document.querySelector('.league-actions button.primary')?.click();
        push(frame, frames, { x: 0.6, y: 0.45 }, 0.04);
      },
    },
    {
      name: 'final-blow',
      bars: 3,
      into: { kind: 'fade', frames: 8 },
      before(frame, frames) {
        push(frame, frames, { x: 0.5, y: 0.5 }, 0.04);
        // The move wound up slowly, and the blow and the faint straight after:
        // the faint on the downbeat a bar and a half in, as the music has it.
        clock.speed = frame / FPS < FINAL_WINDUP_S ? FINAL_MOVE_MS / (FINAL_WINDUP_S * 1000) : 1;
      },
      end() {
        clock.speed = 1;
      },
      // The Metagross above and the companion's Charizard below.
      panels: () => 'split',

      async begin() {
        const { battleScene } = await load('./scenes/battle.mjs');
        const league = await hoennLeague();
        closeAll();
        await travelWith(6, 80);
        await pokemonArt([6, 376], true);
        const metagross = await foe(376, 80, 0.22);
        turnTaken = false;
        // Straight from the hit to the faint, without a word on how well it worked.
        scripted = moveTurn({ move: 'flare-blitz', foeHp: 0, effectiveness: null, faint: true, won: true });
        app().push(battleScene({ session: session(), foes: [metagross], trainer: league.champion, backdrop: 'champion', weather: null, onFinish: () => {} }));
        await preroll(() => turnTaken);
      },
    },
    {
      name: 'hall-of-fame',
      seconds: 5.4,
      says: () => say('fame', { at: 0.1 }),
      // Down far enough for the plate the champion is entered on.
      tilt: () => 0.85,
      // Out of the fight into white, which the ceremony opens out of itself.
      into: { kind: 'white', out: 14, in: 0 },
      async begin() {
        const { hallOfFameScene } = await load('./scenes/halloffame.mjs');
        const league = await hoennLeague();
        closeAll();
        session().champion = true;
        smooth(false);
        placeStage(0, 0, frameWidth() / 480);
        await pokemonArt([6], true);
        app().push(hallOfFameScene({ pokemon: session().active, league, onFinish: () => {} }));
      },
    },
    // The champion back on the road it started out on, in the afternoon,
    // closer and closing in: framed between the panels along the top and the
    // buttons along the bottom, so the road and the Pokémon are all there is.
    {
      name: 'champion-walk',
      seconds: 3,
      says: () => say('onward'),
      into: { kind: 'shutter', out: 12, in: 14 },
      // On the champion: the frame below is centred a little to its right.
      pan: () => 0.5 + ((PICKING_FOCUS.x * 480 - 190) * 1.55) / 480,
      async begin() {
        const { gameData } = await load('./core/data.mjs');
        closeAll();
        await travelWith(6, 80);
        session().champion = true;
        session().badges = ['rock', 'fighting', 'electric', 'fire', 'normal', 'flying', 'psychic', 'water'];
        // On an open road: Route 101's tall grass hides the champion's feet.
        session().area = gameData().areas.find((entry) => entry.id === ENDING_ROAD);
        // And nothing turning up on it: the road's events came back on their
        // own timer once the berry tree had been picked.
        session().eventTimer = 1e9;
        clock.hour = 16;
        smooth(true);
        await pokemonArt([6]);
        await preload([`areas/${ENDING_ROAD}/${timeKey(16)}.png`]);
        // Long enough for the berry tree the montage stopped at to be picked
        // and left behind.
        await preroll(3600);
        app().dismissToast();
      },
      before(frame, frames) {
        app().dismissToast();
        if (upright) fadeChrome(1);
        // Held on a point of the picture rather than eased towards one: the
        // frame is chosen to leave the panels out from the first frame.
        const zoom = 1.55 + 0.05 * (frame / frames);
        const centre = { x: 190, y: upright ? 122 : 158 };
        const scale = (frameWidth() / 480) * zoom;
        placeStage(-(centre.x - 240 / zoom) * scale, -(centre.y - 135 / zoom) * scale, scale);
      },
    },
    {
      name: 'logo',
      // In over a second and a half, and then held for three.
      seconds: 4.5,
      into: { kind: 'fade', frames: 20 },
      async begin() {
        closeAll();
        clock.hour = 12;
        smooth(false);
        placeStage(0, 0, frameWidth() / 480);
        // Upright, the card covers the phone's whole frame, the line above
        // the picture with it, and the title takes two lines; its sizes are
        // for a 1080-wide frame, as the landscape card's are for a 1920-wide one.
        const size = upright ? (value) => (value * PHONE.width) / 1080 : px;
        const card = document.createElement('div');
        card.id = 'trailer-logo';
        Object.assign(card.style, {
          position: upright ? 'absolute' : 'fixed', inset: '0', zIndex: upright ? '60' : '10', background: '#11151f', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: `${size(28)}px`, color: '#fff',
          fontFamily: "'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif", textAlign: 'center',
        });
        const icon = document.createElement('img');
        icon.src = window.__trailerIcon;
        Object.assign(icon.style, { width: `${size(upright ? 300 : 220)}px`, height: `${size(upright ? 300 : 220)}px`, imageRendering: 'pixelated' });
        const title = document.createElement('div');
        title.textContent = upright ? 'POKÉMON\nDESKTOP COMPANION' : 'POKÉMON DESKTOP COMPANION';
        Object.assign(title.style, {
          fontSize: `${size(upright ? 72 : 76)}px`, fontWeight: '800', letterSpacing: '0.04em', whiteSpace: 'pre-line', lineHeight: '1.15',
          textShadow: `0 ${size(8)}px 0 #384a63, 0 0 ${size(40)}px rgba(0,0,0,0.6)`,
        });
        const line = document.createElement('div');
        line.textContent = lang() === 'ko' ? '비영리 팬 게임 · Windows / macOS / Linux' : 'A non-commercial fan game · Windows / macOS / Linux';
        Object.assign(line.style, { fontSize: `${size(upright ? 30 : 28)}px`, color: '#a9b3c7' });
        card.append(icon, title, line);
        (phone ?? document.body).append(card);
        this.card = card;
        this.parts = [icon, title, line];
      },
      before(frame) {
        const t = frame / FPS;
        this.parts.forEach((part, index) => {
          const local = Math.min(1, Math.max(0, (t - index * 0.3) / 0.85));
          part.style.opacity = String(local);
          part.style.transform = `translateY(${px((1 - ease(local)) * 24)}px)`;
        });
      },
    },
  ];

  // ---------------------------------------------------------------- shorts

  /*
   * A short for the feed: the companion walking, a wild Pokémon met, the fight
   * won, and the walk again. One take of the game playing itself — the road's
   * own event, the engine's own turns — framed as the upright trailer frames
   * them: the road close on the companion, the fight cut in two, a line over
   * each. Unlike the trailer's fights this one is followed, so the game's own
   * nameplates, health bars and message box are kept, lifted out of the
   * battle screen and laid over the two halves. How it goes follows from the
   * seed, so a take can be looked for ('--seed', with '--dry' to read the
   * turns without filming).
   */
  /** How long the walk goes on after the fight. */
  const ENCOUNTER_AFTER_S = 4;
  /** How long into the game's way into a fight the screen is wholly dark (see `ENTRY_OPEN` in the battle scene). */
  const ENCOUNTER_SHUT_S = 0.48;
  /**
   * Where each half of this fight looks: the wild one a little higher than the
   * trailer has it, between its nameplate and the line across the seam, and
   * the companion higher in its own half, between its nameplate and the
   * message box.
   */
  const ENCOUNTER_CROPS = [{ x: 260, y: 38 }, { x: 34, y: 100 }];
  /** How much larger than in the game's window its battle panels are drawn on the phone. */
  const HUD_ZOOM = 2.2;
  /**
   * Where the companion's nameplate goes on the phone: under the line across
   * the seam when there is one, and otherwise just above the seam, where the
   * line would have been — clear of a companion taller than a Charmander.
   */
  const playerPlateTop = () => (captions ? 505 : 364);
  const encounter = { seed: 1, met: false, from: -1, to: -1, hud: /** @type {HTMLElement | null} */ (null), lifted: false };

  /**
   * The battle's own panels over the two halves: the wild one's nameplate at
   * the top of its half, the companion's under the seam, the message box
   * along the bottom. They are the battle scene's nodes, moved rather than
   * copied, so the scene goes on writing to them.
   */
  function liftBattleHud() {
    if (!encounter.hud) {
      const hud = document.createElement('div');
      hud.className = 'short-hud';
      const look = getComputedStyle(stage());
      Object.assign(hud.style, {
        position: 'absolute', left: '0', top: '0', width: `${PHONE.width / HUD_ZOOM}px`, height: `${PHONE.height / HUD_ZOOM}px`,
        zoom: String(HUD_ZOOM), zIndex: '3', pointerEvents: 'none', display: 'none',
        fontFamily: look.fontFamily, fontSize: look.fontSize, color: look.color, lineHeight: look.lineHeight,
      });
      phone.append(hud);
      encounter.hud = hud;
      // The upright cut hides these wherever they are; here they are wanted.
      const sheet = [...document.styleSheets].find((entry) => entry.href?.endsWith('styles.css')) ?? document.styleSheets[0];
      sheet.insertRule('body.trailer-upright .short-hud :is(.battle-bar, .battle-message) { visibility: visible; }', sheet.cssRules.length);
    }
    const screen = document.querySelector('.battle-screen');
    if (!screen || encounter.lifted) return;
    const player = /** @type {HTMLElement | null} */ (screen.querySelector('.battle-bar.player'));
    const parts = [screen.querySelector('.battle-bar.foe'), player, screen.querySelector('.battle-message')].filter(Boolean);
    if (player) {
      player.style.bottom = 'auto';
      player.style.top = `${playerPlateTop() / HUD_ZOOM}px`;
    }
    encounter.hud.replaceChildren(...parts);
    encounter.lifted = true;
  }

  /**
   * An evolution opens over the fight it follows. Its one panel is the line
   * along the bottom, which is wider than the phone: lifted in the same way,
   * in place of the fight's.
   */
  function liftEvolutionLine() {
    const line = document.querySelector('.evolution-screen .battle-message');
    if (!line || !encounter.hud) return;
    if (line.parentElement !== encounter.hud) {
      encounter.hud.replaceChildren(line);
      encounter.lifted = false;
    }
    encounter.hud.style.display = 'block';
    encounter.hud.style.opacity = '1';
  }

  /** The panels gone with the fight they belonged to. */
  function dropBattleHud() {
    if (!encounter.hud) return;
    encounter.hud.replaceChildren();
    encounter.hud.style.display = 'none';
    encounter.lifted = false;
  }

  const ENCOUNTER = [
    {
      name: 'encounter',
      // The most it may run: it ends itself, a while after the fight does.
      seconds: 90,
      open: true,
      async begin() {
        closeAll();
        session().rng.seed = encounter.seed >>> 0;
        clock.hour = 12;
        document.getElementById('dragframe').style.display = 'none';
        stage().style.boxShadow = 'none';
        stage().style.borderRadius = '0';
        smooth(false);
        placeStage(0, 0, frameWidth() / 480);
        await preload(['items/poke-ball.png']);
        // The road walks once its picture has come in, which takes real time
        // rather than the film's: given a moment, and walked a little way on.
        await settle(800);
        await preroll(3000);
        app().dismissToast();
        // The road's music is already playing when the take opens.
        audioLog.push({ t: 0, method: 'playMusic', args: [session().area?.music ?? null] });
        turnLog = true;
        // The wild one steps out beyond the right edge: about five seconds' walk away.
        forceEvent('wild');
      },
      async before(frame) {
        app().dismissToast();
        fadeChrome(1);
        // Whoever the road rolled, in its fighting art before the fight opens.
        if (!encounter.met && session().lastWildSpecies) {
          encounter.met = true;
          console.log('met ' + session().lastWildSpecies + ' on frame ' + frame);
          await pokemonArt([session().active.speciesId, session().lastWildSpecies], true);
        }
      },
      // The road while the screen flashes, the fight cut in two once it has
      // shut, and the road again on the very frame the fight hands back: this
      // is asked once the game has drawn the frame, so it goes by what is on
      // screen now.
      panels(frame) {
        const fighting = Boolean(document.querySelector('.battle-screen'));
        if (fighting && encounter.from < 0) {
          encounter.from = frame;
          console.log('fight from frame ' + frame);
        }
        if (!fighting && encounter.from >= 0 && encounter.to < 0) {
          encounter.to = frame;
          console.log('fight to frame ' + frame);
        }
        // What the fight's end has to say is said in the game's own toasts,
        // which nothing in this take leaves room for: gone before they are seen.
        app().dismissToast();
        // The halves come in over the dark the game has just shut the screen
        // with, and once they have met the seam between them is the trailer's
        // pale one again.
        const into = (frame - encounter.from) / FPS - ENCOUNTER_SHUT_S;
        if (panels.node) panels.node.style.background = into < 0.45 ? '#05070c' : '#f4f4f0';
        if (fighting && into >= 0) {
          // The game's panels with the halves: in as they meet.
          liftBattleHud();
          encounter.hud.style.display = 'block';
          encounter.hud.style.opacity = String(Math.min(1, Math.max(0, (into - 0.25) / 0.2)));
        } else if (!fighting) {
          dropBattleHud();
          // The line for this frame was chosen before the game ran it: on the
          // frame the fight hands back, it is the road's again.
          if (encounter.to === frame) drawCaption(captions ? say('onward') : null);
        }
        return fighting && into >= 0 ? 'split' : null;
      },
      crops: ENCOUNTER_CROPS,
      // A line over the road, another across the seam of the fight, and one for the road after it.
      says: () => (encounter.from < 0
        ? say('walk')
        : encounter.to >= 0
          ? say('onward')
          : panels.kind === 'split' ? say('battle', { at: BATTLE_AT, under: true }) : null),
      pan: () => PICKING_FOCUS.x,
      tilt: () => PICKING_FOCUS.y,
      over: (frame) => encounter.to >= 0 && frame - encounter.to >= Math.round(ENCOUNTER_AFTER_S * FPS),
    },
  ];

  /*
   * The serial: one companion's journey, a day of it a reel. Each day picks
   * the run up from the save the day before left, lets the road hand out its
   * next few events one straight after another — the game's own roll, with
   * the minute's wait between them taken out — and films them as one take
   * until it has enough film; whatever is left of the day's events then
   * happens off camera, as the game does while nobody is watching it. A
   * journey to Champion is some 260 events, so four a day is two months.
   *
   * The first day opens on the choice of a first partner. No two things of a
   * kind are shown one after the other — a fight is a fight, whoever it is
   * against — so an event of the kind just shown is left to happen behind a
   * closed shutter. A wild Pokémon worth having is thrown a ball when it has
   * been beaten; a badge is held up when it is won; and once the companion is
   * strong enough, the League is walked into.
   *
   * Nothing worth seeing happens off camera: the run is noted down before
   * every event, and if one that was not being filmed turns out to hold an
   * evolution, a badge or a rare Pokémon, the day ends at that note instead —
   * the event is rolled again, the same, at the start of the next day's film.
   */
  /** The hour each day is lit for, in turn, so the days do not all look alike. */
  const JOURNEY_HOURS = [11, 15, 18, 8, 13, 21];
  /** What an event is to someone watching: a fight is a fight, whoever it is against. */
  const kindOf = (kind) => (kind === 'wild' || kind === 'trainer' ? 'battle' : kind);
  /** The level the companion walks into the League at, once it has the badges. */
  const LEAGUE_LEVEL = 80;
  /**
   * The wild Pokémon a ball is thrown at, besides the rare ones: the ones
   * people know by sight, and their families.
   */
  const FAVOURITES = new Set([
    1, 2, 3, 4, 5, 6, 25, 26, 172, 37, 38, 39, 52, 54, 58, 59, 63, 77, 79, 92, 93, 94, 104, 123, 129, 130, 131,
    133, 134, 135, 136, 196, 197, 470, 471, 700, 137, 143, 446, 147, 148, 149, 152, 155, 158, 175, 179, 215, 228,
    246, 247, 248, 252, 255, 258, 280, 281, 282, 302, 303, 359, 371, 374, 387, 390, 393, 403, 443, 444, 445, 447, 448,
    495, 498, 501, 570, 571, 607, 610, 633, 650, 653, 656, 722, 725, 728, 744, 745, 778, 810, 813, 816, 835, 885,
    906, 909, 912,
  ]);

  const journey = {
    day: 1, events: 4, budget: 30, resume: false, starter: 'Squirtle',
    /** Species a ball is thrown at besides the usual ones, when a day is asked to catch something in particular. */
    wanted: /** @type {number[]} */ ([]),
    /** A stand-alone reel's script, in place of the road's own roll (see `momentPlan`). */
    plan: /** @type {any[] | null} */ (null),
    scene: /** @type {any} */ (null),
    intro: false,
    restore: /** @type {(() => void) | null} */ (null),
    /** Events finished today, and whether one is under way and has taken hold of the road. */
    done: 0, running: false, seen: false, since: 0,
    /** Whether frames are being photographed, and the frame the walk out began on. */
    filming: true, tail: -1, over: false,
    /** The kind last shown, and the shutter an event of the same kind happens behind. */
    lastKind: /** @type {string | null} */ (null),
    away: false, dark: false, shutter: { way: 0, at: 0 },
    checkpoint: /** @type {string | null} */ (null),
    final: /** @type {string | null} */ (null),
    current: /** @type {any} */ (null),
    log: /** @type {any[]} */ ([]),
    fight: -1,
    /** The film's frame a fight opened on, and whether its middle is being left out. */
    fightFilm: -1, cut: false,
    capture: /** @type {any} */ (null),
    league: /** @type {any} */ (null),
    leagueTried: false,
    badges: -1, card: /** @type {any} */ (null),
    label: /** @type {HTMLElement | null} */ (null),
    dock: /** @type {HTMLElement | null} */ (null),
    veil: /** @type {HTMLElement | null} */ (null),
  };

  /**
   * How much of a fight is filmed from its start before the rest is left out
   * down to its last turn: a gym leader's three Pokémon take two minutes, and
   * a reel is not that long. The cut falls between turns, and the last turn —
   * the blow that ends it, the experience, the win — is filmed whole.
   */
  const FIGHT_OPENING_S = 10;
  /**
   * A stand-alone reel is some thirty seconds: its fights are cut sooner, its
   * walk out is shorter, and the road between them — the walk, a berry
   * picked, a ball found — goes at the pace the game's own hold-to-hurry gives it.
   */
  const fightOpening = () => (journey.plan ? 6 : FIGHT_OPENING_S);
  const tailSeconds = () => (journey.plan ? 2.5 : ENCOUNTER_AFTER_S);
  const MOMENT_ROAD_SPEED = 2.5;
  /** The film's fade from black as it opens, and to black as it closes. */
  const FADE_IN_S = 0.5;
  const FADE_OUT_S = 0.6;

  function journeyTurn(entries) {
    if (!journey.filming || journey.dark || journey.fightFilm < 0) return;
    const last = entries.some((entry) => entry.kind === 'end');
    if (journey.cut && last) {
      journey.cut = false;
      flashLeft = FLASH_FRAMES;
    } else if (!journey.cut && !last && (frameNumber - journey.fightFilm) / FPS >= fightOpening()) {
      journey.cut = true;
    }
  }

  const levelNow = async () => (await load('./engine/pokemon.mjs')).levelOf(session().active);
  /** A line of the game's own, in the language it is being filmed in. */
  const line = async (key, values) => (await load('./core/i18n.mjs')).t(key, values);

  /** The road clear: no event on it, nothing opened over it. */
  const roadClear = () => app().stack.length === 1 && !app().scene?.busy;

  /** Whether a wild Pokémon is one to throw a ball at: rare, shiny, or one people know. */
  async function worthCatching(pokemon) {
    const { speciesOf } = await load('./core/data.mjs');
    const { isRare } = await load('./engine/encounter.mjs');
    if (session().caught.has(pokemon.speciesId)) return false;
    return Boolean(pokemon.shiny) || isRare(speciesOf(pokemon.speciesId)) || FAVOURITES.has(pokemon.speciesId) || journey.wanted.includes(pokemon.speciesId);
  }

  async function startJourneyEvent(frame) {
    const s = session();
    journey.checkpoint = JSON.stringify(s.toSave());
    journey.running = true;
    journey.seen = false;
    journey.since = frame;
    journey.current = {
      filmed: journey.filming && !journey.away, level: await levelNow(), badges: s.badges.length, species: s.active.speciesId,
      evolved: false, fought: false, tray: new Set(s.tray),
    };
    if (journey.plan) {
      const step = journey.plan[journey.done];
      journey.current.step = step;
      journey.current.kind = kindOf(step.kind === 'leader' ? 'trainer' : step.kind);
      await prepareStep(step);
      forceEvent(step.kind === 'leader' ? 'trainer' : step.kind);
      return;
    }
    // The road's own roll, now rather than in a minute.
    s.eventTimer = 0;
  }

  /**
   * Have the road's next event come out as a reel's script asks: a wild
   * Pokémon of one species (the area's table cut down to it for the roll, and
   * the dice kept from straying), a shiny one, or a gym leader due.
   */
  async function prepareStep(step) {
    const s = session();
    if (step.kind === 'wild' && step.species) {
      const { speciesOf } = await load('./core/data.mjs');
      const area = s.area;
      const chance = s.rng.chance;
      s.area = { ...area, encounters: [{ species: speciesOf(step.species).slug, minLevel: 1, maxLevel: 100, weight: 1 }] };
      // Nothing left to chance but what is certain; a shiny one is certain.
      s.rng.chance = (odds) => odds >= 1;
      if (step.shiny) Object.defineProperty(s, 'shinyOdds', { configurable: true, get: () => 1 });
      journey.restore = () => {
        s.area = area;
        s.rng.chance = chance;
        delete s.shinyOdds;
      };
    }
    if (step.kind === 'leader') {
      s.trainerWins = 99;
      s.leaderRest = 0;
    }
  }

  /**
   * The event the road has just rolled is known for what it is. One of the
   * kind just shown happens behind a closed shutter; the next that is not
   * opens it again.
   */
  function eventTakesHold(frame) {
    journey.restore?.();
    journey.restore = null;
    // A scripted event is what the script said, and is always filmed.
    if (journey.plan) return;
    const kind = kindOf(session().events.recent?.[0] ?? null);
    journey.current.kind = kind;
    if (!journey.filming) return;
    if (!journey.away && kind === journey.lastKind) {
      journey.away = true;
      journey.shutter = { way: 1, at: frame };
    } else if (journey.away && kind !== journey.lastKind) {
      journey.away = false;
      journey.dark = false;
      journey.shutter = { way: -1, at: frame };
    }
    journey.current.filmed = !journey.away;
  }

  async function finishJourneyEvent(frame) {
    const s = session();
    const event = journey.current;
    const beaten = s.tray.filter((pokemon) => !event.tray.has(pokemon));
    const { speciesOf } = await load('./core/data.mjs');
    const { isRare } = await load('./engine/encounter.mjs');
    const entry = {
      kind: event.step?.kind ?? s.events.recent?.[0] ?? null,
      filmed: event.filmed,
      fought: event.fought,
      level: [event.level, await levelNow()],
      badge: s.badges.length > event.badges ? s.badges[s.badges.length - 1] : null,
      evolved: event.evolved ? [event.species, s.active.speciesId] : null,
      beaten: beaten.map((pokemon) => pokemon.speciesId),
      area: s.area?.id ?? null,
    };
    journey.running = false;
    // Too good to have happened off camera: tomorrow opens on it instead.
    const rare = beaten.some((pokemon) => pokemon.shiny || isRare(speciesOf(pokemon.speciesId)));
    if (!journey.plan && !event.filmed && (entry.badge || entry.evolved || rare)) {
      console.log('held for the next day: ' + JSON.stringify(entry));
      journey.final = journey.checkpoint;
      journey.over = true;
      return;
    }
    journey.done++;
    journey.log.push(entry);
    console.log('event ' + journey.done + ': ' + JSON.stringify(entry));
    if (event.filmed) {
      journey.lastKind = event.kind;
      // One of the beaten worth having, with a ball to throw at it.
      for (const pokemon of beaten) {
        if (s.balls().length && (event.step?.catch || (!journey.plan && (await worthCatching(pokemon))))) {
          journey.capture = { target: pokemon, phase: 'open', at: frame, throws: 0, caught: false };
          return;
        }
      }
    }
    afterJourneyEvent(frame);
  }

  /** Enough on film, or the day's events done: the walk out begins. */
  function afterJourneyEvent(frame) {
    if (journey.filming && !journey.away && (frameNumber / FPS >= journey.budget || journey.done >= journey.events)) journey.tail = frame;
  }

  // ------------------------------------------------------------------ catching

  /** The capture screen's panels over the picture, as the fight's are. */
  function liftCaptureHud() {
    const screen = document.querySelector('.capture-screen');
    if (!screen) return;
    liftBattleHud();
    const name = /** @type {HTMLElement | null} */ (screen.querySelector('.capture-name'));
    const parts = [screen.querySelector('.capture-attempts'), name, screen.querySelector('.capture-tray'), screen.querySelector('.battle-message')].filter(Boolean);
    if (!parts.length) return;
    // Under the count of throws rather than beside it: the phone is narrow.
    if (name) name.style.top = '44px';
    encounter.hud.replaceChildren(...parts);
    encounter.lifted = false;
    encounter.hud.style.display = 'block';
    encounter.hud.style.opacity = '1';
  }

  /**
   * Throw at a Pokémon just beaten, as a player would: its place in the tray
   * pressed, the ball likeliest to work thrown, and again if it breaks out.
   */
  async function driveCapture(frame) {
    const capture = journey.capture;
    const t = (frame - capture.at) / FPS;
    const step = (phase) => {
      capture.phase = phase;
      capture.at = frame;
    };
    const screen = document.querySelector('.capture-screen');
    if (capture.phase === 'open') {
      // The menus this goes through are a player's own business, not the film's.
      document.body.classList.add('short-quiet');
      const index = session().tray.indexOf(capture.target);
      const slot = /** @type {HTMLElement | undefined} */ (document.querySelectorAll('.tray-slot')[index]);
      if (index < 0 || !slot) return endCapture(frame);
      slot.click();
      step('menu');
    } else if (capture.phase === 'menu') {
      if (clickText('.modal button', [await line('tray.capture')])) step('scene');
      else if (t > 3) endCapture(frame);
    } else if (capture.phase === 'scene') {
      if (screen) step('aim');
      else if (t > 3) endCapture(frame);
    } else if (capture.phase === 'aim') {
      if (!screen) return endCapture(frame);
      if (t < (capture.throws ? 0.7 : 1.3)) return;
      const balls = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.capture-balls:not(.capture-berries) .capture-ball')]).filter((ball) => !ball.disabled);
      if (!balls.length) return t > 4 ? endCapture(frame) : undefined;
      const odds = (ball) => Number.parseFloat(ball.querySelector('.odds')?.textContent ?? '0') || 0;
      balls.sort((a, b) => odds(b) - odds(a))[0].click();
      capture.throws++;
      step('thrown');
    } else if (capture.phase === 'thrown') {
      if (document.querySelector('.modal')) {
        capture.caught = true;
        step('caught');
      } else if (!screen) endCapture(frame);
      // Out of the ball again: another throw.
      else if (t > 2.6) step('aim');
    } else if (capture.phase === 'caught') {
      // Held on the ball shut and the line that says so, then no nickname.
      if (t >= 1.8 && clickText('.modal button', [await line('common.no')])) step('closing');
    } else if (capture.phase === 'closing') {
      if (!screen && roadClear()) endCapture(frame);
      else if (t > 6) endCapture(frame);
    }
  }

  function endCapture(frame) {
    const capture = journey.capture;
    journey.capture = null;
    document.body.classList.remove('short-quiet');
    for (const modal of document.querySelectorAll('.modal')) modal.remove();
    const entry = { kind: 'capture', filmed: true, species: capture.target.speciesId, caught: capture.caught, throws: capture.throws };
    journey.log.push(entry);
    console.log('capture: ' + JSON.stringify(entry));
    if (capture.throws) journey.lastKind = 'capture';
    afterJourneyEvent(frame);
  }

  // -------------------------------------------------------------------- badges

  /**
   * A badge won is held up: the badge itself, large, over the road the
   * companion walks back out onto, with the game's own line under it — for
   * as long as its fanfare plays.
   */
  async function showBadge(type, frame) {
    const { badgeIcon } = await load('./ui/badges.mjs');
    const icon = badgeIcon(type);
    // Its size is its own in the badge case, which lays it out; here it is given one.
    icon.style.display = 'block';
    const { gameData } = await load('./core/data.mjs');
    const { name: localized } = await load('./core/i18n.mjs');
    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'absolute', left: '0', right: '0', top: `${PHONE.height * 0.2}px`, zIndex: '140', display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: '26px', pointerEvents: 'none',
    });
    const shine = document.createElement('div');
    Object.assign(shine.style, {
      width: '300px', height: '300px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,243,176,0.85) 42%, rgba(255,203,5,0) 70%)',
    });
    // The badge as the game's own badge case draws it, many times the size.
    const holder = document.createElement('div');
    Object.assign(holder.style, { zoom: '11', lineHeight: '0', imageRendering: 'pixelated' });
    holder.append(icon);
    shine.append(holder);
    const words = document.createElement('div');
    words.textContent = await line('badge.obtained', { name: localized(gameData().types[type]?.name, type) });
    Object.assign(words.style, {
      padding: '12px 26px', border: '4px solid #384a63', borderRadius: '14px', background: 'rgba(248, 248, 240, 0.96)',
      boxShadow: 'inset 0 0 0 4px rgba(255, 255, 255, 0.7)', color: '#2f3542', fontSize: '30px', fontWeight: '700', maxWidth: '470px', textAlign: 'center', whiteSpace: 'nowrap',
      fontFamily: getComputedStyle(stage()).fontFamily,
    });
    card.append(shine, words);
    phone.append(card);
    journey.card = { node: card, shine, at: frame };
  }

  function drawBadge(frame) {
    const card = journey.card;
    if (!card) return;
    const t = (frame - card.at) / FPS;
    const HOLD_S = 3.4;
    if (t >= HOLD_S) {
      card.node.remove();
      journey.card = null;
      return;
    }
    const land = Math.min(1, t / 0.3);
    card.node.style.opacity = String(Math.min(1, t / 0.12, (HOLD_S - t) / 0.3));
    card.shine.style.transform = `scale(${1.6 - 0.6 * overshoot(land)}) rotate(${(1 - land) * -12}deg)`;
  }

  // ---------------------------------------------------------------- the League

  /**
   * The League, walked into as a player would: its button on the road, then
   * each round's as it comes up, and the ceremony pressed through.
   */
  async function driveLeague(frame) {
    const league = journey.league;
    const t = (frame - league.at) / FPS;
    if (league.phase === 'enter') {
      if (!clickText('.hud button', [await line('field.toLeague')])) return endLeague(frame);
      league.phase = 'inside';
      league.at = frame;
      return;
    }
    const hall = document.querySelector('.league-screen');
    const battling = Boolean(document.querySelector('.battle-screen'));
    const ceremony = /** @type {HTMLElement | null} */ (document.querySelector('.fame-screen'));
    if (hall || battling || ceremony) league.seen = true;
    if (ceremony && frame - (league.pressed ?? 0) > 2.6 * FPS) {
      ceremony.click();
      league.pressed = frame;
    } else if (hall && !battling && !ceremony) {
      // The next round, once its challenger has been looked at.
      const next = /** @type {HTMLButtonElement | null} */ (document.querySelector('.league-actions button.primary'));
      if (next && !next.disabled && frame - (league.pressed ?? league.at) > 1.6 * FPS) {
        next.click();
        league.pressed = frame;
      }
    }
    if ((league.seen && roadClear()) || (!league.seen && t > 6)) endLeague(frame);
  }

  function endLeague(frame) {
    journey.league = null;
    const entry = { kind: 'league', filmed: true, champion: Boolean(session().champion) };
    journey.log.push(entry);
    console.log('league: ' + JSON.stringify(entry));
    journey.lastKind = 'league';
    // A day with the League in it is that day's film, whatever else was to come.
    journey.done = journey.events;
    afterJourneyEvent(frame);
  }

  // ------------------------------------------------------------ what is put over

  /**
   * What a short puts over the picture: the black it fades in from and out
   * to, and for a day of the serial "DAY 12 / OF BECOMING CHAMPION" across
   * the top as it opens, in the trailer's lettering.
   *
   * @param {boolean} labelled
   */
  function layOver(labelled) {
    const outline = (width, colour) => [...Array(16)].map((_, i) => {
      const angle = (i / 16) * Math.PI * 2;
      return `${(Math.cos(angle) * width).toFixed(1)}px ${(Math.sin(angle) * width).toFixed(1)}px 0 ${colour}`;
    }).join(', ');
    const node = document.createElement('div');
    Object.assign(node.style, {
      position: 'absolute', left: '0', right: '0', top: `${PHONE.height * 0.09}px`, zIndex: '150', display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: '12px', fontFamily: "'Segoe UI Black', 'Malgun Gothic', sans-serif", fontWeight: '900', lineHeight: '1',
      pointerEvents: 'none', whiteSpace: 'nowrap',
    });
    const big = document.createElement('div');
    big.textContent = `DAY ${journey.day}`;
    Object.assign(big.style, { fontSize: '92px', letterSpacing: '0.02em', color: LOGO.yellow, textShadow: `${outline(6.5, LOGO.blue)}, 0 9px 0 ${LOGO.navy}` });
    const small = document.createElement('div');
    small.textContent = 'OF BECOMING CHAMPION';
    Object.assign(small.style, { fontSize: '30px', letterSpacing: '0.04em', color: '#fff', textShadow: outline(3.5, LOGO.blue) });
    node.append(big, small);
    if (labelled) {
      phone.append(node);
      journey.label = node;
      // And for the rest of the day, small in the top right corner — clear of
      // the wild one's nameplate, which runs along the top left in a fight.
      const dock = document.createElement('div');
      Object.assign(dock.style, {
        position: 'absolute', right: '16px', top: '16px', zIndex: '150', display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: '5px', fontFamily: "'Segoe UI Black', 'Malgun Gothic', sans-serif", fontWeight: '900', lineHeight: '1', pointerEvents: 'none',
        whiteSpace: 'nowrap', textAlign: 'right', opacity: '0',
      });
      const day = document.createElement('div');
      day.textContent = `DAY ${journey.day}`;
      Object.assign(day.style, { fontSize: '36px', color: LOGO.yellow, textShadow: `${outline(3.5, LOGO.blue)}, 0 4px 0 ${LOGO.navy}` });
      const under = document.createElement('div');
      under.innerHTML = 'OF BECOMING<br>CHAMPION';
      Object.assign(under.style, { fontSize: '13px', letterSpacing: '0.04em', lineHeight: '1.15', color: '#fff', textShadow: outline(2, LOGO.blue) });
      dock.append(day, under);
      phone.append(dock);
      journey.dock = dock;
    }
    const veil = document.createElement('div');
    Object.assign(veil.style, { position: 'absolute', inset: '0', zIndex: '200', background: '#000', pointerEvents: 'none' });
    phone.append(veil);
    journey.veil = veil;
    // The menus the film presses its way through are not part of it.
    const sheet = [...document.styleSheets].find((entry) => entry.href?.endsWith('styles.css')) ?? document.styleSheets[0];
    sheet.insertRule('body.short-quiet .modal { visibility: hidden; }', sheet.cssRules.length);
  }

  /** The day's number for its first moments, and the film's way in from black and out to it. */
  function drawOver(frame) {
    const t = frameNumber / FPS;
    if (journey.label) journey.label.style.opacity = journey.filming ? String(Math.min(1, t / 0.15, Math.max(0, (3.4 - t) / 0.35))) : '0';
    // The corner's as the large one goes, and up from then on.
    if (journey.dock) journey.dock.style.opacity = journey.filming ? String(Math.min(1, Math.max(0, (t - 3.2) / 0.35))) : '0';
    let dark = Math.max(0, 1 - t / FADE_IN_S);
    if (journey.tail >= 0) dark = Math.max(dark, 1 - (tailSeconds() - (frame - journey.tail) / FPS) / FADE_OUT_S);
    if (journey.veil) journey.veil.style.opacity = String(Math.min(1, Math.max(0, dark)));
  }

  /** The day opening on the choice of a first partner: the three balls, one looked at, and taken. */
  const STARTER_SHOT = {
    name: 'starter',
    seconds: 5,
    async begin() {
      document.getElementById('dragframe').style.display = 'none';
      stage().style.boxShadow = 'none';
      stage().style.borderRadius = '0';
      // The whole of the screen's middle rather than the road's close-up: the
      // three balls are wider than that. What shows above and below it is
      // the screen's own sky carried on.
      placeStage(120, 105, 1.5);
      // The line over the balls is as wide as the game's window, and the way
      // back is not the film's: the one folded to the phone, the other left out.
      const prompt = /** @type {HTMLElement | null} */ (document.querySelector('.starter-caption'));
      if (prompt) Object.assign(prompt.style, { maxWidth: '168px', margin: '0 auto' });
      const back = /** @type {HTMLElement | null} */ (document.querySelector('.starter-back'));
      if (back) back.style.visibility = 'hidden';
      film.style.background = 'linear-gradient(180deg, #2b3448 0%, #2b3448 14%, #151a26 86%, #151a26 100%)';
      audioLog.push({ t: 0, method: 'playMusic', args: [app().audio.wanted ?? null] });
      drawOver(0);
    },
    before(frame, frames) {
      drawOver(frame);
      const pick = /** @type {HTMLElement | undefined} */ ([...document.querySelectorAll('.starter-pick')].find((node) => {
        const alt = node.querySelector('img')?.getAttribute('alt') ?? '';
        return alt.toLowerCase() === journey.starter.toLowerCase() || alt === STARTER_NAMES[journey.starter.toLowerCase()];
      }));
      if (!pick) return;
      // Looked at, taken, and said yes to as the shutter closes on it.
      if (frame === Math.round(1.3 * FPS)) pick.dispatchEvent(new MouseEvent('mouseenter'));
      if (frame === Math.round(3.3 * FPS)) pick.click();
      if (frame === frames - 2) {
        const yes = /** @type {HTMLElement | null} */ (document.querySelector('.modal .actions button'));
        yes?.click();
      }
    },
    pan: () => 0.5,
    tilt: () => 0.5,
  };
  /** The starters by their Korean names, for a film shot in Korean. */
  const STARTER_NAMES = { bulbasaur: '이상해씨', charmander: '파이리', squirtle: '꼬부기' };

  const EPISODE_SHOT = {
    name: 'episode',
    // The most it may run, off camera included: it ends itself.
    seconds: 1800,
    open: true,
    crops: ENCOUNTER_CROPS,
    async begin() {
      // A run just begun on the starter's screen takes a moment to be there.
      for (let i = 0; i < 100 && !session(); i++) await settle(50);
      await settle(300);
      closeAll();
      const s = session();
      if (!journey.resume) {
        s.rng.seed = encounter.seed >>> 0;
        await pokemonArt([s.active.speciesId]);
      }
      // No event of the game's own choosing: the day asks for each.
      s.eventTimer = 1e9;
      clock.hour = journey.scene?.hour ?? JOURNEY_HOURS[(journey.day - 1) % JOURNEY_HOURS.length];
      document.getElementById('dragframe').style.display = 'none';
      stage().style.boxShadow = 'none';
      stage().style.borderRadius = '0';
      film.style.background = '';
      smooth(false);
      placeStage(0, 0, frameWidth() / 480);
      await preload(['items/poke-ball.png']);
      // The road walks once its picture has come in, which takes real time
      // rather than the film's: given a moment, and walked a little way on —
      // unless the film has been on it since the desktop.
      if (!journey.intro) {
        await settle(800);
        await preroll(3000);
      }
      app().dismissToast();
      if (!journey.intro) audioLog.push({ t: frameNumber / FPS, method: 'playMusic', args: [s.area?.music ?? null] });
      turnLog = true;
      onTurn = journeyTurn;
      journey.badges = s.badges.length;
    },
    async before(frame) {
      app().dismissToast();
      fadeChrome(1);
      drawOver(frame);
      const s = session();
      // On the road, everything at the pace the game's own hold-to-hurry gives it;
      // whatever opens over the road — a fight, a catch, an evolution — as it plays.
      if (journey.plan) clock.speed = app().stack.length === 1 ? MOMENT_ROAD_SPEED : 1;

      // The shutter an event of the kind just shown happens behind.
      const { way, at } = journey.shutter;
      if (way > 0) {
        manualShut = Math.min(1, (frame - at) / 12);
        if (manualShut >= 1) journey.dark = true;
      } else if (way < 0) {
        manualShut = Math.max(0, 1 - (frame - at) / 14);
        if (manualShut <= 0) journey.shutter = { way: 0, at: frame };
      }

      const battling = Boolean(document.querySelector('.battle-screen'));
      if (battling && journey.current) journey.current.fought = true;
      if (battling && journey.fightFilm < 0) journey.fightFilm = frameNumber;
      if (!battling) {
        journey.fightFilm = -1;
        journey.cut = false;
      }
      if (document.querySelector('.evolution-screen') && journey.current) journey.current.evolved = true;
      // A wild one's fighting art, before the fight opens on it.
      if (journey.running && s.lastWildSpecies && journey.current.wild !== s.lastWildSpecies) {
        journey.current.wild = s.lastWildSpecies;
        if (journey.filming && !journey.dark) await pokemonArt([s.active.speciesId, s.lastWildSpecies], true);
      }
      // A badge just won, held up — if the camera is there to see it.
      if (s.badges.length > journey.badges) {
        journey.badges = s.badges.length;
        if (journey.filming && !journey.dark) await showBadge(s.badges[s.badges.length - 1], frame);
      }
      drawBadge(frame);

      if (journey.capture) return driveCapture(frame);
      if (journey.league) return driveLeague(frame);

      const clear = roadClear();
      if (journey.running) {
        if (!clear) {
          if (!journey.seen) {
            journey.seen = true;
            eventTakesHold(frame);
          }
        } else if (journey.seen) await finishJourneyEvent(frame);
        // Rolled and nothing came of it: asked for again.
        else if (frame - journey.since > 20 * FPS) {
          journey.since = frame;
          s.eventTimer = 0;
        }
      }
      if (journey.running || journey.over || journey.capture || !clear) return;
      // The walk on after the last event filmed, and then the camera is off.
      if (journey.tail >= 0) {
        if (frame - journey.tail < Math.round(tailSeconds() * FPS)) return;
        journey.tail = -1;
        journey.filming = false;
        // The camera is off for the rest of the day: nothing of the fights to come is laid out.
        showPanels(null);
        dropBattleHud();
      }
      if (journey.done >= journey.events) {
        journey.final = JSON.stringify(s.toSave());
        journey.over = true;
        return;
      }
      // Strong enough, and the badges in hand: the League instead of the road's next event.
      if (!journey.plan && journey.filming && !journey.away && !journey.leagueTried && !s.champion && s.badges.length >= 8 && (await levelNow()) >= LEAGUE_LEVEL) {
        journey.leagueTried = true;
        journey.league = { phase: 'enter', at: frame, seen: false };
        return;
      }
      await startJourneyEvent(frame);
    },
    // As the encounter has it: the road while the screen flashes, the fight
    // cut in two with the game's panels over it — and an evolution or a
    // capture, which open over the road, as the whole picture again.
    panels(frame) {
      app().dismissToast();
      const evolving = Boolean(document.querySelector('.evolution-screen'));
      const catching = Boolean(document.querySelector('.capture-screen'));
      const fighting = Boolean(document.querySelector('.battle-screen')) && !evolving;
      if (fighting && journey.fight < 0) journey.fight = frame;
      if (!fighting) journey.fight = -1;
      const into = fighting ? (frame - journey.fight) / FPS - ENCOUNTER_SHUT_S : -1;
      if (panels.node) panels.node.style.background = into < 0.45 ? '#05070c' : '#f4f4f0';
      if (fighting && into >= 0) {
        liftBattleHud();
        encounter.hud.style.display = 'block';
        encounter.hud.style.opacity = String(Math.min(1, Math.max(0, (into - 0.25) / 0.2)));
      } else if (evolving) {
        liftEvolutionLine();
      } else if (catching) {
        liftCaptureHud();
      } else {
        dropBattleHud();
      }
      return fighting && into >= 0 ? 'split' : null;
    },
    // On the companion on the road; on the middle of the picture for what opens over it.
    pan: () => (document.querySelector('.evolution-screen, .capture-screen, .league-screen, .fame-screen') ? 0.5 : PICKING_FOCUS.x),
    tilt: () => (document.querySelector('.evolution-screen') ? 0.62 : document.querySelector('.capture-screen') ? 0.47 : document.querySelector('.league-screen, .fame-screen') ? 0.5 : PICKING_FOCUS.y),
    skip: () => !journey.filming || journey.cut || journey.dark,
    over: () => journey.over,
  };

  /*
   * Stand-alone reels, between the days of the serial: a moment or two of the
   * game with a companion and a road of their own, scripted rather than
   * rolled — a ball found and a Pokémon caught with it, a shiny one met, an
   * evolution, a gym and its badge, a quiet stretch of road. Who and where
   * follow from the seed, so each is a different reel every time. With
   * `intro` it opens as the trailer does, on the companion's window in the
   * corner of a desktop, and comes in on it.
   */
  /** Companions, from every generation: the first of a line, grown to the reel's level where it says so. */
  const MOMENT_COMPANIONS = [
    25, 133, 1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501, 650, 653, 656, 722, 725, 728, 810, 813, 816,
    906, 909, 912, 447, 175, 280, 371, 443, 610, 633, 744, 778, 885, 92, 147, 246, 37, 58, 39, 52, 54, 63, 129, 143, 359, 403,
  ];
  /** Who evolves, and the level it is at the moment before. */
  const MOMENT_EVOLVERS = [
    [4, 15], [1, 15], [7, 15], [152, 15], [155, 13], [158, 17], [252, 15], [255, 15], [258, 15], [387, 17], [390, 13], [393, 15],
    [495, 16], [498, 16], [501, 16], [650, 15], [653, 15], [656, 15], [722, 16], [725, 16], [728, 16], [810, 15], [813, 15],
    [816, 15], [906, 15], [909, 15], [912, 15], [92, 24], [280, 19], [403, 14], [147, 29], [443, 23], [610, 37], [633, 49],
    [246, 29], [371, 29], [744, 24], [129, 19], [63, 15], [374, 19], [436, 32], [602, 38],
  ];

  /** The everyday Pokémon of the first routes, for a fight the companion is to win. */
  const ROUTE_REGULARS = [16, 19, 10, 13, 161, 163, 261, 263, 265, 396, 399, 506, 504, 519, 659, 661, 731, 734, 819, 821, 831, 915, 921];

  /**
   * A stand-alone reel's script. Its companion, its road and whoever it meets
   * come from its own dice, so the reels made one after another (seeds a few
   * apart) are not the same few Pokémon going round.
   */
  function momentPlan(name, seed) {
    const dice = { s: (seed * 2654435761) >>> 0 };
    const roll = (n) => {
      dice.s = (dice.s + 0x6d2b79f5) >>> 0;
      let t = dice.s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0;
    };
    const pick = (list) => list[roll(list.length)];
    const [road, hour] = pick(ROADS);
    const companion = pick(MOMENT_COMPANIONS);
    // One worth the ball, and not the companion's own kind.
    const catches = [...FAVOURITES].filter((id) => id !== companion);
    const caught = pick(catches);
    switch (name) {
      case 'catch':
        return { scene: { companion, level: 18, grown: true, road, hour }, steps: [{ kind: 'ball' }, { kind: 'wild', species: caught, catch: true }] };
      case 'shiny':
        return { scene: { companion, level: 20, grown: true, road, hour }, steps: [{ kind: 'berry' }, { kind: 'wild', species: caught, shiny: true, catch: true }] };
      case 'evolve': {
        const [species, level] = pick(MOMENT_EVOLVERS);
        return { scene: { companion: species, level, almost: true, road, hour }, steps: [{ kind: 'ball' }, { kind: 'wild', species: pick(ROUTE_REGULARS) }] };
      }
      case 'gym':
        return { scene: { companion, level: 30, grown: true, road, hour }, steps: [{ kind: 'berry' }, { kind: 'leader' }] };
      case 'road':
      default:
        return { scene: { companion, level: 16, grown: true, road, hour }, steps: [{ kind: 'berry' }, { kind: 'wild', species: pick(catches) }, { kind: 'ball' }] };
    }
  }

  /** Put a reel's companion on its road, at its level — one experience point short of the next, for an evolution. */
  async function setTheScene() {
    const { gameData } = await load('./core/data.mjs');
    const { createPokemon } = await load('./engine/pokemon.mjs');
    const scene = journey.scene;
    const s = session();
    // As far along its line as its level has it, for a companion met part way through its journey.
    if (scene.grown) scene.companion = (await load('./engine/encounter.mjs')).evolveToLevel(scene.companion, scene.level);
    const companion = await travelWith(scene.companion, scene.level);
    if (scene.almost) companion.experience = createPokemon(s.rng, scene.companion, scene.level + 1, { ivFloor: 20 }).experience - 1;
    // Only the evolution reel evolves: anyone else holds an Everstone, so a
    // level gained in a fight does not turn a catch into an evolution.
    else companion.heldItem = 'everstone';
    // Balls good enough to be done in a throw or two.
    s.bag['ultra-ball'] = Math.max(s.bag['ultra-ball'] ?? 0, 5);
    s.seen.add(scene.companion);
    s.caught.add(scene.companion);
    s.area = gameData().areas.find((entry) => entry.id === scene.road) ?? s.area;
    clock.hour = scene.hour;
    await pokemonArt([scene.companion]);
    await preload([`areas/${scene.road}/${timeKey(scene.hour)}.png`]);
  }

  const momentShots = () => (journey.intro
    ? [TRAILER.find((shot) => shot.name === 'desktop'), TRAILER.find((shot) => shot.name === 'zoom'), EPISODE_SHOT]
    : [EPISODE_SHOT]);

  /** A day's shots: the first day opens on the choice of a partner, and every other on the road. */
  const episodeShots = () => (journey.resume ? [EPISODE_SHOT] : [STARTER_SHOT, { ...EPISODE_SHOT, into: { kind: 'shutter', out: 12, in: 14 } }]);

  /** The cuts by name; the trailer is the one filmed when none is asked for. */
  const CUTS = { trailer: TRAILER, encounter: ENCOUNTER };
  let SHOTS = TRAILER;

  function timeKey(hour) {
    const bands = [['night', 0], ['dawn', 5], ['day', 10], ['afternoon', 14], ['dusk', 18], ['night', 21]];
    let key = 'night';
    for (const [name, from] of bands) if (hour >= from) key = name;
    return key;
  }

  /** Start one of the road's events now, rather than waiting for the timer. */
  function forceEvent(kind) {
    const s = session();
    const roll = s.events.roll;
    s.events.roll = () => {
      s.events.roll = roll;
      return kind;
    };
    s.eventTimer = 0;
  }

  /** How many frames each shot runs, from its length in bars or seconds. */
  function frameCounts() {
    let at = 0;
    return SHOTS.map((shot) => {
      const seconds = shot.bars !== undefined ? shot.bars * BAR : shot.seconds;
      const from = Math.round(at * FPS);
      at += seconds;
      return Math.round(at * FPS) - from;
    });
  }

  // ------------------------------------------------------------------ the run

  let counts = [];
  let frameNumber = 0;

  window.__trailer = {
    FPS,
    BAR,

    /** Boot a fresh run with Charmander on Route 101, and take the clock. */
    async setup({ wallpaper, icon, upright: lying = false, captions: lines = true, cut = 'trailer', seed = 1, day = 1, resume = false, events = 4, budget = 30, starter = 'Squirtle', wanted = [], plan = 'road', intro = false }) {
      encounter.seed = seed;
      Object.assign(journey, { day, resume, events, budget, starter, wanted });
      if (cut === 'moment') {
        const script = momentPlan(plan, seed);
        // All of it is filmed: a script is as long as it was written to be.
        Object.assign(journey, { plan: script.steps, scene: script.scene, events: script.steps.length, budget: 1e9, intro });
      }
      SHOTS = cut === 'episode' ? episodeShots() : cut === 'moment' ? momentShots() : CUTS[cut] ?? TRAILER;
      // The serial's first day is filmed from the choice of a partner on.
      const fresh = cut === 'episode' && !resume;
      wallpaperUrl = wallpaper;
      window.__trailerIcon = icon;
      upright = lying;
      captions = lines;
      for (let i = 0; i < 200 && !app()?.scene; i++) await settle(50);
      document.getElementById('notice-screen')?.click();
      await settle(400);
      if (resume) {
        // The journey so far, which record.mjs has put in the first slot.
        clickText('button', ['이어하기', 'Continue']);
        await settle(400);
        clickText('button', ['1.']);
        await settle(1200);
      } else {
        clickText('button', ['새 게임', 'New Game']);
        await settle(300);
        clickText('button', ['1.']);
        await settle(400);
        if (!fresh) {
          clickImageAlt(['파이리', 'Charmander']);
          await settle(300);
          clickText('button', ['예', 'Yes']);
          await settle(800);
        }
      }
      muteAndLog();
      install();
      app().dismissToast();
      await scriptTurns();
      if (!fresh) {
        const s = session();
        // A run picked up is where it was left; a new one starts on Route 101.
        if (!resume) s.area = (await load('./core/data.mjs')).gameData().areas.find((entry) => entry.id === 'route101');
        // No event of the game's own choosing gets in the way of the script.
        s.eventTimer = 1e9;
        if (cut === 'moment') {
          s.rng.seed = seed >>> 0;
          await setTheScene();
          // The new road's picture takes real time to come in.
          await settle(800);
        }
        await pokemonArt([s.active.speciesId]);
        // Walk a few seconds in, so the road is moving and the windows have
        // faded the way they do with nobody's pointer over them.
        for (let i = 0; i < FPS * 6; i++) step();
        await settle(200);
      }
      if (upright) uprightSetup();
      if (cut === 'episode' || cut === 'moment') layOver(cut === 'episode');
      counts = frameCounts();
      return SHOTS.map((shot, index) => ({
        name: shot.name,
        frames: counts[index],
        freeze: shot.into?.kind === 'fade',
        open: Boolean(shot.open),
      }));
    },

    /**
     * Set a shot up. Its sounds are written down only once it is rolling,
     * unless it opens on a moment that makes one (`listen`): the run up to
     * the rest is not in the film.
     */
    async begin(index) {
      const shot = SHOTS[index];
      filmTime = frameNumber / FPS;
      recording = Boolean(shot.listen);
      hushed = Boolean(shot.quiet);
      await shot.begin?.call(shot);
      await settle(120);
      recording = true;
    },

    /**
     * Film one frame of a shot: what the shot does first, then a frame of game.
     * Answers 'over' on the last frame of a shot that decides its own length,
     * and 'skip' for a frame that was run but is not to be photographed
     * ('over-skip' for both).
     */
    async frame(index, frame) {
      const shot = SHOTS[index];
      filmTime = frameNumber / FPS;
      // The berry tree is put in the road so that the companion reaches it as
      // the melody comes in with the montage. The walk to a new event takes
      // about five seconds, so it is spawned while the desktop is still on.
      if (SHOTS === TRAILER && !berryStarted && frameNumber >= montageFrame() - Math.round(BERRY_WALK_S * FPS) - 1) {
        berryStarted = true;
        forceEvent('berry');
      }
      await shot.before?.call(shot, frame, counts[index]);
      if (journey.veil) drawOver(frame);
      // A shot may run a frame without its being photographed: nothing it
      // sounds is written down, and the film's own clock stays where it is.
      const skipped = Boolean(shot.skip?.call(shot, frame));
      if (shot.skip) recording = !skipped;
      if (upright) {
        aim(shot.pan?.call(shot, frame, counts[index]) ?? 0.5, shot.tilt?.call(shot, frame, counts[index]) ?? 0.5);
        drawCaption(captions ? (shot.says?.call(shot, frame) ?? null) : null);
      }
      drawTransition(index, frame);
      const before = app().scene?.offset;
      step();
      // Panels are drawn from the frame the game has just painted.
      // A frame not photographed is not laid out either; what was on the
      // phone stays as it was, for a shot that comes back to it.
      if (upright && !skipped) await compose(shot, frame);
      if (berryStarted && !window.__arrived && before !== undefined && app().scene?.offset === before) {
        window.__arrived = true;
        console.log(`arrived at the tree on frame ${frameNumber}, the montage starts on ${montageFrame()}`);
      }
      if (!skipped) frameNumber++;
      // A shot that ends itself says so, and the film moves on from this frame.
      const over = Boolean(shot.over?.call(shot, frame));
      if (over || frame === counts[index] - 1) shot.end?.call(shot);
      return over ? (skipped ? 'over-skip' : 'over') : skipped ? 'skip' : true;
    },

    /** Wait for the frame to reach the screen: two real frames, or a moment if the window gets none. */
    painted: () => Promise.race([
      new Promise((resolve) => realRAF(() => realRAF(() => resolve(true)))),
      settle(40),
    ]),

    /** Hold the last frame filmed over the start of the next shot, to fade off it. */
    async freeze(image) {
      const frozen = curtains().frozen;
      frozen.src = image;
      await frozen.decode().catch(() => {});
      frozen.style.opacity = '1';
      return true;
    },

    audioLog: () => audioLog,

    /** How a day of the journey came out: the run as it is to be picked up next, and what happened. */
    journey: () => ({ day: journey.day, save: journey.plan ? null : journey.final, log: journey.log }),

    /** Where each shot starts on the film, in seconds. */
    cuts: () => {
      let at = 0;
      return counts.map((count, index) => {
        const cut = { name: SHOTS[index].name, at: at / FPS };
        at += count;
        return cut;
      });
    },
  };
})();
