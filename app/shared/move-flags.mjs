/**
 * How the games classify a move beyond its type and damage class.
 *
 * A move is not only Fire and physical: it is also a contact move, or a punch,
 * or a sound, and those classifications are what half the abilities and a good
 * number of the held items key off. Static only fires on contact, Bulletproof
 * only stops a bullet, Soundproof only stops a sound, Safety Goggles only stop
 * powder. Without the classification none of them can be written.
 *
 * PokeAPI does not carry them, so the pipeline reads them from the one public
 * source that states them for every move (see `SHOWDOWN` in the pipeline's
 * sources) and ships only the ones this game acts on — a flag no engine and no
 * screen reads would just be weight in a file the app loads at start-up.
 *
 * The order here is the order the Pokémon screen lists them in.
 */
export const MOVE_FLAGS = [
  'contact',
  'punch',
  'bite',
  'slicing',
  'sound',
  'powder',
  'bullet',
  'pulse',
  'wind',
  'dance',
  'charge',
  'recharge',
  'defrost',
  'heal',
];

/** @type {Set<string>} */
export const MOVE_FLAG_SET = new Set(MOVE_FLAGS);

/**
 * The classes the engine acts on that are no use as a chip on the Pokémon
 * screen, both of which the games list move by move: `bypasssub`, the moves
 * that go straight through a substitute — a Taunt, an Encore, a Hyperspace
 * Hole — and `reflectable`, the ones a Magic Coat or a Magic Bounce sends
 * back — a Toxic, a Taunt, but not a Skill Swap or a Transform.
 */
export const ENGINE_FLAGS = ['bypasssub', 'reflectable'];

/** Every class the pipeline ships: the ones shown, and the engine's own. @type {Set<string>} */
export const SHIPPED_FLAG_SET = new Set([...MOVE_FLAGS, ...ENGINE_FLAGS]);
