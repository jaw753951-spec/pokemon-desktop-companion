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
  let filmTime = 0;

  function muteAndLog() {
    const audio = app().audio;
    for (const method of ['playCry', 'blip', 'playJingle', 'playMusic', 'playSample', 'stopMusic']) {
      audio[method] = (...args) => {
        if (method === 'playMusic') audio.wanted = args[0] ?? null;
        if (recording) audioLog.push({ t: filmTime, method, args });
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
      if (!scripted) return take.call(this);
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
   * @param {{move: string, foeHp: number, effectiveness?: number, faint?: boolean, won?: boolean}} options
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
          { kind: 'effectiveness', side: 'foe', data: { effectiveness }, hp: hp(foeHp) },
        ];
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
  /** A length on a 1920-wide desktop, in the page's own pixels. */
  const px = (value) => (value * innerWidth) / 1920;
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
    document.body.prepend(root);
    // The page is see-through where the game is not, which is the desktop.
    document.getElementById('dragframe').style.display = 'none';
    stage().style.boxShadow = `0 ${px(6)}px ${px(24)}px rgba(0,0,0,0.35)`;
  }

  function cornerRect() {
    return {
      x: innerWidth - px(WINDOW.right + WINDOW.width),
      y: innerHeight - px(WINDOW.bottom + WINDOW.height),
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
    const scale = (innerWidth / 480) * (1 + (zoom - 1) * amount);
    const width = 480 * scale;
    const height = 270 * scale;
    const x = focus.x * innerWidth + (innerWidth / 2 - focus.x * innerWidth) * amount;
    const y = focus.y * innerHeight + (innerHeight / 2 - focus.y * innerHeight) * amount;
    placeStage(
      Math.min(0, Math.max(innerWidth - width, x - focus.x * width)),
      Math.min(0, Math.max(innerHeight - height, y - focus.y * height)),
      scale,
    );
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
      document.body.append(node);
      return node;
    };
    curtain.top = layer({ top: '0', height: '0', background: '#05070c' });
    curtain.bottom = layer({ bottom: '0', height: '0', background: '#05070c' });
    curtain.white = layer({ top: '0', bottom: '0', background: '#ffffff', opacity: '0' });
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
    const shut = kind === 'shutter' ? ease(amount) : 0;
    layers.top.style.height = (shut * 50.5) + '%';
    layers.bottom.style.height = (shut * 50.5) + '%';
    layers.white.style.opacity = String(kind === 'white' ? amount : 0);
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

  /** The five fights: who throws what at whom, and where. */
  const FIGHTS = [
    { player: 448, foe: 10102, move: 'aura-sphere', backdrop: 'cave', effectiveness: 4, foeHp: 0.18 },
    { player: 658, foe: 10230, move: 'water-shuriken', backdrop: 'water', effectiveness: 4, foeHp: 0.3 },
    { player: 778, foe: 887, move: 'play-rough', backdrop: 'long-grass', effectiveness: 2, foeHp: 0.35 },
    { player: 908, foe: 195, move: 'flower-trick', backdrop: 'pond', effectiveness: 4, foeHp: 0.12 },
    { player: 25, foe: 130, move: 'thunderbolt', backdrop: 'sky', effectiveness: 4, foeHp: 0.08 },
  ];

  const LEADERS = [
    { id: 'normal-whitney', foe: 241 },
    { id: 'water-nessa', foe: 834 },
    { id: 'electric-iono', foe: 939 },
  ];

  /** The camera on the berry picking: the companion and the tree, a little closer. */
  const PICKING_ZOOM = 1.4;
  const PICKING_FOCUS = { x: (Math.round(240 * 0.32) + 10) / 240, y: 0.58 };

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
   * it; \`attack\` opens on a move landing instead. \`entry\` keeps the game's
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
    else if (!entry) await preroll(780);
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
  }

  async function hoennLeague() {
    const { gameData } = await load('./core/data.mjs');
    return gameData().leagues.find((entry) => entry.region === 'hoenn');
  }

  const SHOTS = [
    {
      name: 'desktop',
      bars: 2,
      async begin() {
        desktop(wallpaperUrl);
        const corner = cornerRect();
        placeStage(corner.x, corner.y, corner.scale);
      },
    },
    {
      name: 'zoom',
      bars: 1,
      before(frame, frames) {
        const corner = cornerRect();
        const progress = ease(Math.min(1, frame / (frames - 1)));
        const scale = corner.scale + (innerWidth / 480 - corner.scale) * progress;
        placeStage(corner.x * (1 - progress), corner.y * (1 - progress), scale);
        stage().style.borderRadius = `${px(6) * (1 - progress)}px`;
      },
      end() {
        document.getElementById('trailer-desktop')?.remove();
        stage().style.boxShadow = 'none';
      },
    },
    { name: 'walk', bars: 3 },
    {
      name: 'montage',
      bars: 8,
      async begin() {
        const { gameData } = await load('./core/data.mjs');
        await pokemonArt(PICKERS);
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
        // In on the picking as it starts, and held there — the name panel
        // going as the camera comes in, since the name changes faster than it
        // can be read.
        const closing = ease(Math.min(1, frame / (0.7 * FPS)));
        closeUp(closing, PICKING_ZOOM, PICKING_FOCUS);
        const panel = namePanel();
        if (panel) {
          panel.style.transition = 'none';
          panel.style.opacity = String(1 - closing);
        }
      },
      end() {
        clock.speed = 1;
        clock.hour = 12;
        const panel = namePanel();
        if (panel) {
          panel.style.opacity = '';
          panel.style.transition = '';
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
      before(frame) {
        if (frame < Math.round(0.39 * FPS)) closeUp(1, PICKING_ZOOM, PICKING_FOCUS);
        else placeStage(0, 0, innerWidth / 480);
      },
    },
    // Send-outs, the wild one's cry with each — and a move only in the last.
    { name: 'fight-2', bars: 1.75, listen: true, begin: () => fight(1) },
    { name: 'fight-3', bars: 1.75, listen: true, begin: () => fight(2) },
    { name: 'fight-4', bars: 1.75, listen: true, begin: () => fight(3) },
    { name: 'fight-5', bars: 1.75, begin: () => fight(4, { attack: true }) },
    // The leader standing there, stepping off and throwing out their first
    // Pokémon — and cut before the companion's ball goes up. Each dissolves
    // into the next, the way into the gyms as well.
    { name: 'leader-1', bars: 1.5, into: { kind: 'fade', frames: 14 }, begin: () => leader(0) },
    { name: 'leader-2', bars: 1.5, into: { kind: 'fade', frames: 14 }, begin: () => leader(1) },
    { name: 'leader-3', bars: 1.5, into: { kind: 'fade', frames: 14 }, begin: () => leader(2) },
    // The League's door and the champion's room in one take: the challenge
    // is taken, the game's own way into the fight plays, and Steven is
    // standing there when it opens.
    {
      name: 'league',
      bars: 2.5,
      into: { kind: 'shutter', out: 12, in: 14 },
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
        await pokemonArt([6, 376], true);
        await preload(['trainers/portraits/steven.png', 'rooms/champion.png', 'battle/champion.png']);
        app().push(leagueScene({ session: session(), onLeave: () => {}, onCrowned: () => {} }));
        await preroll(400);
      },
      before(frame) {
        // So that the champion's Metagross is all the way out of its ball by
        // the cut, and the companion's has not yet been thrown — the cut the
        // leaders' shots make too.
        if (frame === Math.round(0.38 * FPS)) document.querySelector('.league-actions button.primary')?.click();
      },
    },
    {
      name: 'final-blow',
      bars: 3,
      async begin() {
        const { battleScene } = await load('./scenes/battle.mjs');
        const league = await hoennLeague();
        closeAll();
        await travelWith(6, 80);
        await pokemonArt([6, 376], true);
        const metagross = await foe(376, 80, 0.22);
        turnTaken = false;
        scripted = moveTurn({ move: 'flare-blitz', foeHp: 0, effectiveness: 2, faint: true, won: true });
        app().push(battleScene({ session: session(), foes: [metagross], trainer: league.champion, backdrop: 'champion', weather: null, onFinish: () => {} }));
        await preroll(() => turnTaken);
        // Into the move, so the faint lands on the downbeat a bar and a half in.
        await preroll(Math.max(0, 520 + 680 + 620 - 1.5 * BAR * 1000));
      },
    },
    {
      name: 'hall-of-fame',
      seconds: 5.4,
      // Out of the fight into white, which the ceremony opens out of itself.
      into: { kind: 'white', out: 14, in: 0 },
      async begin() {
        const { hallOfFameScene } = await load('./scenes/halloffame.mjs');
        const league = await hoennLeague();
        closeAll();
        session().champion = true;
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
      into: { kind: 'fade', frames: 16 },
      async begin() {
        const { gameData } = await load('./core/data.mjs');
        closeAll();
        await travelWith(6, 80);
        session().champion = true;
        session().badges = ['rock', 'fighting', 'electric', 'fire', 'normal', 'flying', 'psychic', 'water'];
        session().area = gameData().areas.find((entry) => entry.id === 'route101');
        clock.hour = 16;
        await pokemonArt([6]);
        await preload(['areas/route101/' + timeKey(16) + '.png']);
        // Long enough for the berry tree the montage stopped at to be picked
        // and left behind.
        await preroll(3600);
        app().dismissToast();
      },
      before(frame, frames) {
        app().dismissToast();
        // Held on a point of the picture rather than eased towards one: the
        // frame is chosen to leave the panels out from the first frame.
        const zoom = 1.55 + 0.05 * (frame / frames);
        const centre = { x: 190, y: 158 };
        const scale = (innerWidth / 480) * zoom;
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
        placeStage(0, 0, innerWidth / 480);
        const card = document.createElement('div');
        card.id = 'trailer-logo';
        Object.assign(card.style, {
          position: 'fixed', inset: '0', zIndex: '10', background: '#11151f', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: `${px(28)}px`, color: '#fff',
          fontFamily: "'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif",
        });
        const icon = document.createElement('img');
        icon.src = window.__trailerIcon;
        Object.assign(icon.style, { width: `${px(220)}px`, height: `${px(220)}px`, imageRendering: 'pixelated' });
        const title = document.createElement('div');
        title.textContent = 'POKÉMON DESKTOP COMPANION';
        Object.assign(title.style, { fontSize: `${px(76)}px`, fontWeight: '800', letterSpacing: '0.04em', textShadow: `0 ${px(8)}px 0 #384a63, 0 0 ${px(40)}px rgba(0,0,0,0.6)` });
        const line = document.createElement('div');
        line.textContent = lang() === 'ko' ? '비영리 팬 게임 · Windows / macOS / Linux' : 'A non-commercial fan game · Windows / macOS / Linux';
        Object.assign(line.style, { fontSize: `${px(28)}px`, color: '#a9b3c7' });
        card.append(icon, title, line);
        document.body.append(card);
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

  /** The road's panel with the companion's name and health on it. */
  const namePanel = () => /** @type {HTMLElement|null} */ (document.querySelector('.hud > .panel.hud-window'));

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
    async setup({ wallpaper, icon }) {
      wallpaperUrl = wallpaper;
      window.__trailerIcon = icon;
      for (let i = 0; i < 200 && !app()?.scene; i++) await settle(50);
      document.getElementById('notice-screen')?.click();
      await settle(400);
      clickText('button', ['새 게임', 'New Game']);
      await settle(300);
      clickText('button', ['1.']);
      await settle(400);
      clickImageAlt(['파이리', 'Charmander']);
      await settle(300);
      clickText('button', ['예', 'Yes']);
      await settle(800);
      muteAndLog();
      install();
      app().dismissToast();
      await scriptTurns();
      const s = session();
      s.area = (await load('./core/data.mjs')).gameData().areas.find((entry) => entry.id === 'route101');
      // No event of the game's own choosing gets in the way of the script.
      s.eventTimer = 1e9;
      await pokemonArt([4]);
      // Walk a few seconds in, so the road is moving and the windows have
      // faded the way they do with nobody's pointer over them.
      for (let i = 0; i < FPS * 6; i++) step();
      await settle(200);
      counts = frameCounts();
      return SHOTS.map((shot, index) => ({
        name: shot.name,
        frames: counts[index],
        freeze: shot.into?.kind === 'fade',
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
      await shot.begin?.call(shot);
      await settle(120);
      recording = true;
    },

    /** Film one frame of a shot: what the shot does first, then a frame of game. */
    async frame(index, frame) {
      const shot = SHOTS[index];
      filmTime = frameNumber / FPS;
      // The berry tree is put in the road so that the companion reaches it as
      // the melody comes in with the montage. The walk to a new event takes
      // about five seconds, so it is spawned while the desktop is still on.
      if (!berryStarted && frameNumber >= montageFrame() - Math.round(BERRY_WALK_S * FPS) - 1) {
        berryStarted = true;
        forceEvent('berry');
      }
      await shot.before?.call(shot, frame, counts[index]);
      drawTransition(index, frame);
      const before = app().scene?.offset;
      step();
      if (berryStarted && !window.__arrived && before !== undefined && app().scene?.offset === before) {
        window.__arrived = true;
        console.log(`arrived at the tree on frame ${frameNumber}, the montage starts on ${montageFrame()}`);
      }
      frameNumber++;
      if (frame === counts[index] - 1) shot.end?.call(shot);
      return true;
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
