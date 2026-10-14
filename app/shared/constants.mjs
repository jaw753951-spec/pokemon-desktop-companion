/**
 * Values shared by the main and renderer processes.
 *
 * The renderer always draws at this fixed logical size and the window scales
 * it, so a pixel is always a pixel no matter how large the companion is.
 */
export const VIEW_WIDTH = 480;
export const VIEW_HEIGHT = 270;

/**
 * The field is drawn at twice the size of everything else.
 *
 * At 1:1 the window showed thirty 16px tiles across — twice the handheld's
 * fifteen — which made the map a busy carpet and every sprite on it a speck.
 * Doubling brings the framing back to what a Game Boy Advance actually put on
 * screen, and the companion and the things it meets come up to a size you can
 * read at a glance.
 */
export const FIELD_ZOOM = 2;

/**
 * The zoom the stage is drawn at for a window of a given width.
 *
 * Whole quarter steps once a source pixel is worth at least a screen pixel,
 * and free below that, where snapping would mean throwing away most of a tiny
 * window. Both the window sizer and the renderer read this, so a window is
 * never a size the picture inside it cannot fill.
 *
 * @param {number} zoom
 */
export const snapZoom = (zoom) => (zoom >= 1 ? Math.floor(zoom * 4) / 4 : zoom);

/**
 * The zoom a window is sized for, at a scale setting, on a screen this big.
 *
 * Scale 1 is a window about a quarter of the screen across. The zoom that
 * asks for is taken to the **nearest** quarter step rather than down to one:
 * rounding down swallowed most of a step, so on a 1080p screen 1.25x asked for
 * a zoom of 1.2 and got 1 — the same window as 1x, give or take four per cent.
 * Nearest keeps every scale setting its own size. A zoom that would not fit on
 * the screen comes down a step at a time until it does.
 *
 * @param {number} scale the setting
 * @param {number} screenWidth the work area, in pixels
 * @param {number} screenHeight
 */
export function windowZoom(scale, screenWidth, screenHeight) {
  const target = Math.min(screenWidth / 4, (screenHeight / 4) * (VIEW_WIDTH / VIEW_HEIGHT));
  const wanted = Math.max(0.5, (target * scale) / VIEW_WIDTH);
  if (wanted < 1) return wanted;
  let zoom = Math.max(1, Math.round(wanted * 4) / 4);
  while (zoom > 1 && (VIEW_WIDTH * zoom > screenWidth || VIEW_HEIGHT * zoom > screenHeight)) zoom -= 0.25;
  return zoom;
}

/** The field's own coordinate space, which the zoom scales up to the window. */
export const FIELD_WIDTH = VIEW_WIDTH / FIELD_ZOOM;
export const FIELD_HEIGHT = VIEW_HEIGHT / FIELD_ZOOM;

/**
 * The scrolling area background fills the field, as the map does in the
 * handheld games; the HUD sits over it rather than beside it.
 */
export const BACKGROUND_HEIGHT = FIELD_HEIGHT;

/**
 * How far below where the cartridge draws it the foe's platform stands in a
 * battle backdrop, in field pixels.
 *
 * The window is 135 field pixels tall where the Game Boy Advance was 160, and
 * a Black and White sprite stands up to 96 — so the far platform is moved
 * down this far to give the foe the height it needs, which the backdrop build
 * and the battle scene both read. It stops short of the near side's name
 * plate.
 */
export const FOE_PLATFORM_DROP = 10;

/** How often the game writes to the active save slot. */
export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

/** How often the field rolls for a random event. */
export const EVENT_INTERVAL_MS = 60 * 1000;

/**
 * How much faster the travelling view runs while the pointer is held down.
 *
 * One event a minute is the idle pace; a player holding the pointer on the
 * companion is asking it to get on with it. Holding runs the walk and the
 * event clock at this multiple, and **letting go stops it on the spot** —
 * nothing is banked, so the pace a player sees is always the one their hand is
 * asking for. The older behaviour shouldered half a second off the wait per
 * click, which kept hurrying the game along long after the clicking stopped.
 */
export const HOLD_BOOST_RATE = 6;

/**
 * How fast the companion walks while the pointer is held, as a multiple of its
 * ordinary pace. Lower than the event clock's: the point is to read as a jog,
 * not to tear the map past the window.
 */
export const HOLD_BOOST_WALK = 2.5;

/**
 * How fast an event on the road plays out while the pointer is held — a
 * berry picked, a ball opened, the find held up. As fast as the event clock:
 * waiting out ten seconds of picking is exactly what holding is asking to
 * skip, and there is no map to tear past.
 */
export const HOLD_BOOST_EVENT = 6;

/**
 * How fast an event's looping motions go while the pointer is held — the
 * companion bobbing as it gathers, the berry tree swaying, a trainer's idle
 * frames. Livelier than at rest, so the hurry shows, but nowhere near the
 * event clock's six times: at that the bob was a shake.
 */
export const HOLD_BOOST_LOOK = 2;

/**
 * How the hurry comes on and goes off, in milliseconds.
 *
 * Switching the pace the instant the pointer moved made the road lurch: full
 * speed on the frame it went down, a dead stop on the frame it came up. It
 * now takes a moment to get going and glides back down to a walk when it is
 * let go — long enough to read as momentum, short enough that the pace is
 * still plainly the one the player's hand is asking for.
 */
export const HOLD_BOOST_RAMP_MS = 150;
export const HOLD_BOOST_GLIDE_MS = 800;

/**
 * Damage the player's own Pokémon takes, as a share of what the formula says.
 *
 * The companion fights on its own for hours at a time with nobody to switch it
 * out, so it is given a standing half off everything aimed at it. The cut
 * comes last, after type effectiveness has done its work. What it deals is
 * untouched — this is armour, not strength.
 */
export const COMPANION_DAMAGE_TAKEN = 0.5;

/**
 * What a weakness multiplies a hit on the companion by, in place of the
 * type chart's two.
 *
 * With no party to switch to, a bad matchup is not something the companion
 * can get out of, so being hit where it is weak costs it half again rather
 * than double. Each weakness counts: a double weakness is this squared.
 * Resisted and neutral hits are the chart's own.
 */
export const COMPANION_WEAKNESS = 1.5;

/**
 * How long to wait before trying again when a roll came due while an event was
 * still playing out.
 *
 * The timers run on the walk, not on what is happening on it, so a rest stop
 * that takes a quarter of a minute can be holding the road when the next event
 * — or the area change — falls due. Putting the timer back to its full period
 * threw that turn away: a player watching a Pokémon Center would then go a
 * further minute with nothing happening, or ten more in the same place.
 */
export const EVENT_RETRY_MS = 5 * 1000;

/**
 * How soon a turn held back by a bridge overhead is tried again.
 *
 * Sooner than {@link EVENT_RETRY_MS}: the road moves on by itself, and five
 * seconds of walking is 170 field pixels, enough to step clean over a short
 * stretch of open road between two spans.
 */
export const OVERPASS_RETRY_MS = 1000;

/**
 * How long the walk from one area to the next takes, in milliseconds.
 *
 * Half of it is the screen shutting and half is it opening again, with the
 * road changed at the darkest point — which is how the games move you from
 * one place to another, and the reason somewhere else reads as somewhere else
 * rather than as the ground glitching under the companion's feet.
 */
export const CROSSING_MS = 900;

/**
 * How many events the companion sees in one area before moving on.
 *
 * It used to be ten minutes on a clock, which took no notice of the player at
 * all: a run being hurried along by clicking went through a dozen events
 * without the scenery ever changing. Counting events instead means the road
 * moves at the pace the run is actually being played at — ten things happen,
 * and then somewhere else.
 */
export const EVENTS_PER_AREA = 10;

/** The five daylight bands, and the hour each one starts at. */
export const TIME_BANDS = [
  { key: 'night', from: 0 },
  { key: 'dawn', from: 5 },
  { key: 'day', from: 10 },
  { key: 'afternoon', from: 14 },
  { key: 'dusk', from: 18 },
  { key: 'night', from: 21 },
];

/**
 * Which time-of-day background to show for a given local hour.
 * @param {Date} [now]
 * @returns {'dawn'|'day'|'afternoon'|'dusk'|'night'}
 */
export function timeOfDay(now = new Date()) {
  const hour = now.getHours();
  let key = 'night';
  for (const band of TIME_BANDS) {
    if (hour >= band.from) key = band.key;
  }
  return /** @type {any} */ (key);
}

/** The starters the game opens with, in Pokédex order. */
export const STARTERS = [1, 4, 7];

/** Maximum Pokémon held in the post-battle "keep or catch" tray. */
export const TRAY_LIMIT = 5;

/** Chances to catch a Pokémon once the capture screen opens. */
export const CAPTURE_ATTEMPTS = 3;

/** Badges needed before the Pokémon League opens. */
export const BADGES_FOR_LEAGUE = 8;

/**
 * The level each badge is due by, first to eighth.
 *
 * Leaders used to come on odds that rose with the journey, which left where
 * the eighth badge landed to how fast the companion happened to level: a
 * Lucky Egg ran it far ahead of its badges, a run of lost leader battles far
 * behind. So each badge now has a level it is due by, and a leader comes
 * looking for a companion that has reached it — which puts the eighth badge
 * around level 70, ready for a League that waits in the 70s.
 */
export const BADGE_LEVELS = [12, 20, 28, 36, 44, 52, 60, 68];

/**
 * The most base stats, all six summed, a Pokémon of the first, second and
 * third leaders' teams may have on the save's first run.
 *
 * A leader with no roster on file sends the strongest of their type, which
 * put a level-12 Tyranitar in front of a starter that had barely evolved. So
 * on the first run the early gyms field what their badge's level can stand
 * up to — a Graveler or an Onix for the first, a Golem at most by the third —
 * and from the fourth on, or once the save has a champion, the strongest
 * again.
 */
export const FIRST_RUN_LEADER_STATS = [400, 450, 500];

/**
 * How much more experience a battle pays on the save's first run, while the
 * companion is below `FIRST_RUN_EXPERIENCE_UNTIL`: half as much again, as a
 * Lucky Egg does, and on top of one. The first three badges are the climb a
 * companion makes alone from level 5; past them it is the usual pace.
 */
export const FIRST_RUN_EXPERIENCE_BONUS = 1.5;
export const FIRST_RUN_EXPERIENCE_UNTIL = 30;

/**
 * How far above a badge's level the leader's ace stands, and how far below
 * each Pokémon the one sent out before it.
 */
export const LEADER_ACE_ABOVE = 2;
export const LEADER_LEVEL_STEP = 2;

/**
 * The levels a leader's team stands at, in the order it is sent out.
 *
 * Fixed by the badge, as the League is by its round, rather than pitched
 * against the challenger: a leader one level above whoever walked in was the
 * same fight at level 15 as at 40, so there was nothing to train for and
 * nothing gained by it. Now the leader for the first badge stands around 12,
 * the eighth's around 68, the ace two above the badge's level and each before
 * it two below the next — the way a gym's team climbs to its ace. A companion
 * that comes early, by luck, finds a leader above it; one that has trained
 * past the badge finds one below.
 *
 * @param {number} badges the badges already held: the leader is for the next
 * @param {number} count how many Pokémon the team has
 * @returns {number[]}
 */
export function leaderLevels(badges, count) {
  const due = BADGE_LEVELS[Math.min(badges, BADGE_LEVELS.length - 1)];
  const ace = due + LEADER_ACE_ABOVE;
  return Array.from({ length: count }, (_, index) => Math.max(1, ace - (count - 1 - index) * LEADER_LEVEL_STEP));
}

/**
 * How often a trainer encounter is a gym leader instead, and how many trainer
 * wins since the last badge summon one without the roll.
 *
 * | the companion is…                 | chance | wins |
 * |-----------------------------------|--------|------|
 * | at or past the next badge's level |  50%   |   3  |
 * | within 6 levels of it             |   8%   |   —  |
 * | further below                     |    —   |   —  |
 *
 * A badge can come a little early, by luck, but not a whole gym early; and a
 * companion that has reached its level meets the leader within a few fights.
 * Except the first: its leader stands at a fixed level (see `leaderLevels`),
 * and a starter met six levels short of it — a level 6 against a level 14
 * ace — has one Pokémon, a couple of moves and no way to win. So the first
 * leader waits until the badge's level is reached.
 */
export const LEADER_ODDS = {
  due: { chance: 0.5, wins: 3 },
  near: { chance: 0.08, wins: Infinity, within: 6 },
  early: { chance: 0, wins: Infinity },
};

/**
 * Trainer encounters after a lost leader battle that are ordinary trainers
 * whatever the odds say.
 *
 * A companion that has reached a badge's level and lost to its leader was
 * otherwise back in front of a leader — the odds at 50% and the wins long
 * since counted — at the very next trainer, on the one hit point the loss
 * left it and with nothing learned in between. Three ordinary fights give it
 * a few levels' worth of road first.
 */
export const LEADER_REST_AFTER_LOSS = 3;

/**
 * The leader odds for a companion this far along.
 *
 * @param {number} badges
 * @param {number} level
 * @returns {{chance: number, wins: number}}
 */
export function leaderOdds(badges, level) {
  const due = BADGE_LEVELS[Math.min(badges, BADGE_LEVELS.length - 1)];
  if (level >= due) return LEADER_ODDS.due;
  if (badges === 0) return LEADER_ODDS.early;
  if (level >= due - LEADER_ODDS.near.within) return LEADER_ODDS.near;
  return LEADER_ODDS.early;
}
