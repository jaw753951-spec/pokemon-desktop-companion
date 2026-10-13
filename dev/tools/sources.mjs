/**
 * Where the pipeline gets its raw material, and which slices of it we ship.
 *
 * Only `raw.githubusercontent.com` is used, so the whole pipeline works from a
 * plain HTTPS client with no API keys and no tarballs.
 */

export { TAG_TYPES } from '../../app/shared/area-tags.mjs';
export { BALL_TIERS } from '../../app/shared/ball-tiers.mjs';
export { MOVE_FLAGS, MOVE_FLAG_SET } from '../../app/shared/move-flags.mjs';

export const POKEAPI = 'https://raw.githubusercontent.com/PokeAPI/api-data/master/data/api/v2';
export const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites';
export const CRIES = 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries';
export const EMERALD = 'https://raw.githubusercontent.com/pret/pokeemerald/master';
export const FIRERED = 'https://raw.githubusercontent.com/pret/pokefirered/master';
export const PLATINUM = 'https://raw.githubusercontent.com/pret/pokeplatinum/main';

/**
 * How a move is classified — contact, sound, powder, punch and the rest.
 *
 * PokeAPI has no field for it, and the decompilations only carry the flags
 * their own generation knew about, so a Gen-3 dump cannot say whether a move
 * is a bullet or a slicing move. Pokémon Showdown's move table states every
 * flag for every move and is served from the same plain HTTPS host as the
 * rest, which is the whole of why it is here: one file, read once, for the
 * one thing nothing else publishes.
 */
export const SHOWDOWN = 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data';

/**
 * Portraits of named characters the league needs and Emerald never drew.
 *
 * Fire Red is the same generation and the same hand, so its Elite Four sit
 * beside Hoenn's without a seam. Will and Karen were never drawn on a Game Boy
 * Advance at all; Crystal's four-colour sprites stood in for them once, a red
 * and a pink silhouette beside everyone else's full colour, so HeartGold and
 * SoulSilver's take their place with Johto's leaders (below).
 *
 * Sinnoh's Elite Four, champion and gym leaders come from the Platinum
 * decompilation, whose front sprites are a strip of animation frames 80 pixels
 * wide; the last frame is the pose the trainer stands in.
 *
 * Everyone past Sinnoh, Johto's leaders, Will and Karen come from the Smogon / Pokémon
 * Showdown sprite repository (`smogon`, kept under `data/vendor/smogon-sprites`):
 * HeartGold and SoulSilver's own sprites for Johto, Black and White's and
 * Black 2 and White 2's for Unova, and — since the 3D games drew nobody in
 * pixels — the community's sprites in the Black and White style for Kalos and
 * Alola, credited in the game.
 *
 * Nobody drew Diantha, Grant, Galar, Paldea or Blueberry in pixels for a
 * game either. Their pictures are the fan game PokéRogue's (`pokerogue`, CC
 * BY-NC-SA 4.0, kept under `data/vendor/pokerogue`), whose trainer sprites
 * are an animation sheet and a TexturePacker atlas side by side — `path`
 * names both without the extension, and the first frame is the picture.
 * Avery and Klara, who are not there and were drawn nowhere else, come from
 * Pokémon Showdown's trainer sprites (`showdown`, through a mirror of its
 * sprite folder) — Brumirage's, shared on condition of credit and no edits,
 * so the build only trims their empty margin.
 *
 * @type {Record<string, {source: 'firered'|'platinum'|'smogon'|'pokerogue'|'showdown', path: string}>}
 */
export const NAMED_PORTRAITS = {
  bruno: { source: 'firered', path: 'graphics/trainers/front_pics/elite_four_bruno_front_pic.png' },
  lance: { source: 'firered', path: 'graphics/trainers/front_pics/elite_four_lance_front_pic.png' },
  koga: { source: 'firered', path: 'graphics/trainers/front_pics/leader_koga_front_pic.png' },
  // Kanto's gym leaders, the same hand again: each is drawn for the person
  // whose name it goes under, and nobody else.
  brock: { source: 'firered', path: 'graphics/trainers/front_pics/leader_brock_front_pic.png' },
  misty: { source: 'firered', path: 'graphics/trainers/front_pics/leader_misty_front_pic.png' },
  lt_surge: { source: 'firered', path: 'graphics/trainers/front_pics/leader_lt_surge_front_pic.png' },
  erika: { source: 'firered', path: 'graphics/trainers/front_pics/leader_erika_front_pic.png' },
  sabrina: { source: 'firered', path: 'graphics/trainers/front_pics/leader_sabrina_front_pic.png' },
  blaine: { source: 'firered', path: 'graphics/trainers/front_pics/leader_blaine_front_pic.png' },
  giovanni: { source: 'firered', path: 'graphics/trainers/front_pics/leader_giovanni_front_pic.png' },
  aaron: { source: 'platinum', path: 'res/trainers/classes/elite_four_aaron/front.png' },
  bertha: { source: 'platinum', path: 'res/trainers/classes/elite_four_bertha/front.png' },
  flint: { source: 'platinum', path: 'res/trainers/classes/elite_four_flint/front.png' },
  lucian: { source: 'platinum', path: 'res/trainers/classes/elite_four_lucian/front.png' },
  cynthia: { source: 'platinum', path: 'res/trainers/classes/champion_cynthia/front.png' },
  roark: { source: 'platinum', path: 'res/trainers/classes/leader_roark/front.png' },
  gardenia: { source: 'platinum', path: 'res/trainers/classes/leader_gardenia/front.png' },
  maylene: { source: 'platinum', path: 'res/trainers/classes/leader_maylene/front.png' },
  wake: { source: 'platinum', path: 'res/trainers/classes/leader_wake/front.png' },
  fantina: { source: 'platinum', path: 'res/trainers/classes/leader_fantina/front.png' },
  byron: { source: 'platinum', path: 'res/trainers/classes/leader_byron/front.png' },
  candice: { source: 'platinum', path: 'res/trainers/classes/leader_candice/front.png' },
  volkner: { source: 'platinum', path: 'res/trainers/classes/leader_volkner/front.png' },
  // Johto's leaders, and the two of its Elite Four nobody else drew, as
  // HeartGold and SoulSilver did.
  will: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Will.png' },
  karen: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Karen.png' },
  falkner: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Falkner.png' },
  bugsy: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Bugsy.png' },
  whitney: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Whitney.png' },
  morty: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Morty.png' },
  chuck: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Chuck.png' },
  jasmine: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Jasmine.png' },
  pryce: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Pryce.png' },
  clair: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Clair.png' },
  janine: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen4/heartgold-soulsilver/Janine.png' },
  // Unova, from Black and White: the first leaders, the Elite Four, and Iris
  // as the Opelucid leader she is there.
  cress: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Cress.png' },
  cilan: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Cilan.png' },
  chili: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Chili.png' },
  lenora: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Lenora.png' },
  burgh: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Burgh.png' },
  elesa: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Elesa.png' },
  clay: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Clay.png' },
  skyla: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Skyla.png' },
  brycen: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Brycen.png' },
  drayden: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Drayden.png' },
  iris: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Iris.png' },
  shauntal: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Shauntal.png' },
  grimsley: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Grimsley.png' },
  caitlin: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Caitlin.png' },
  marshal: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black-white/Marshal.png' },
  // Black 2 and White 2's new leaders, and Iris as the champion she becomes.
  cheren: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black2-white2/Cheren.png' },
  roxie: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black2-white2/Roxie.png' },
  marlon: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black2-white2/Marlon.png' },
  iris_champion: { source: 'smogon', path: 'src/_uncategorized/canonical/trainers/gen5/black2-white2/Iris.png' },
  // Kalos and Alola were drawn in 3D; these are the community's sprites in
  // Black and White's style.
  viola: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Viola.png' },
  korrina: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Korrina.png' },
  ramos: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Ramos.png' },
  clemont: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Clemont.png' },
  valerie: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Valerie.png' },
  olympia: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Olympia.png' },
  wulfric: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Wulfric.png' },
  drasna: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Drasna.png' },
  wikstrom: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Wikstrom.png' },
  malva: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Malva.png' },
  siebold: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen6/x-y/Siebold.png' },
  olivia: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen7/sun-moon/Olivia.png' },
  acerola: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen7/sun-moon/Acerola.png' },
  kahili: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen7/sun-moon/Kahili.png' },
  hala: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen7/sun-moon/Hala.png' },
  molayne: { source: 'smogon', path: 'src/_uncategorized/noncanonical/trainers/gen7/sun-moon/Molayne.png' },
  // Kalos's champion and its rock leader, Alola's champion, Galar's leaders,
  // and Paldea's and Blueberry Academy's leaders, Elite Four and champions,
  // from PokéRogue. Hau is here rather than with the rest of Alola: Smogon's
  // drawing of him has his skin grey-olive and his hair olive, where the games
  // have him tanned with dark green hair.
  hau: { source: 'pokerogue', path: 'images/trainer/hau' },
  diantha: { source: 'pokerogue', path: 'images/trainer/diantha' },
  grant: { source: 'pokerogue', path: 'images/trainer/grant' },
  allister: { source: 'pokerogue', path: 'images/trainer/allister' },
  bea: { source: 'pokerogue', path: 'images/trainer/bea' },
  bede: { source: 'pokerogue', path: 'images/trainer/bede' },
  gordie: { source: 'pokerogue', path: 'images/trainer/gordie' },
  kabu: { source: 'pokerogue', path: 'images/trainer/kabu' },
  marnie: { source: 'pokerogue', path: 'images/trainer/marnie' },
  melony: { source: 'pokerogue', path: 'images/trainer/melony' },
  milo: { source: 'pokerogue', path: 'images/trainer/milo' },
  nessa: { source: 'pokerogue', path: 'images/trainer/nessa' },
  opal: { source: 'pokerogue', path: 'images/trainer/opal' },
  piers: { source: 'pokerogue', path: 'images/trainer/piers' },
  raihan: { source: 'pokerogue', path: 'images/trainer/raihan' },
  katy: { source: 'pokerogue', path: 'images/trainer/katy' },
  brassius: { source: 'pokerogue', path: 'images/trainer/brassius' },
  iono: { source: 'pokerogue', path: 'images/trainer/iono' },
  kofu: { source: 'pokerogue', path: 'images/trainer/kofu' },
  larry: { source: 'pokerogue', path: 'images/trainer/larry' },
  ryme: { source: 'pokerogue', path: 'images/trainer/ryme' },
  tulip: { source: 'pokerogue', path: 'images/trainer/tulip' },
  grusha: { source: 'pokerogue', path: 'images/trainer/grusha' },
  rika: { source: 'pokerogue', path: 'images/trainer/rika' },
  poppy: { source: 'pokerogue', path: 'images/trainer/poppy' },
  hassel: { source: 'pokerogue', path: 'images/trainer/hassel' },
  geeta: { source: 'pokerogue', path: 'images/trainer/geeta' },
  crispin: { source: 'pokerogue', path: 'images/trainer/crispin' },
  amarys: { source: 'pokerogue', path: 'images/trainer/amarys' },
  lacey: { source: 'pokerogue', path: 'images/trainer/lacey' },
  drayton: { source: 'pokerogue', path: 'images/trainer/drayton' },
  kieran: { source: 'pokerogue', path: 'images/trainer/kieran' },
  avery: { source: 'showdown', path: 'sprites/trainers/avery.png' },
  klara: { source: 'showdown', path: 'sprites/trainers/klara.png' },
};

/** Highest National Dex number the game ships (Gen 9, Pecharunt). */
export const MAX_SPECIES = 1025;

/** The version group whose rules the game follows, newest first for fallback. */
export const VERSION_GROUP_PRIORITY = [
  'scarlet-violet',
  'sword-shield',
  'brilliant-diamond-and-shining-pearl',
  'lets-go-pikachu-lets-go-eevee',
  'ultra-sun-ultra-moon',
  'sun-moon',
  'omega-ruby-alpha-sapphire',
  'x-y',
  'black-2-white-2',
  'black-white',
  'heartgold-soulsilver',
  'platinum',
  'diamond-pearl',
  'emerald',
  'firered-leafgreen',
  'ruby-sapphire',
  'crystal',
  'gold-silver',
  'yellow',
  'red-blue',
];

/**
 * Areas the companion can wander through.
 *
 * Every entry is a real Hoenn map from the Emerald decompilation: `dir` names
 * the map directory (which yields its layout, music and weather), `location`
 * is the PokeAPI location whose official Korean name we display, and `tags`
 * drive wild-encounter fallbacks for species the game has no encounter data
 * for. Only the two Game Boy Advance regions are here — Hoenn from Emerald and
 * Kanto from Fire Red, drawn by the same hand in the same engine — so every
 * area shares one look. PokeAPI carries Korean names for Hoenn locations but
 * not for Kanto ones, so a Kanto area names itself in `ko`.
 *
 * Only places under the sky, or in a cave, which reads as the same road
 * underfoot. The insides of buildings are left out: New Mauville's floor tiles
 * and Sky Pillar's corridors are rooms, and a companion walking the road
 * through one looked as though it had wandered indoors. The cartridge files
 * both as underground, alongside the caves, so they are named out by hand.
 *
 * A Kanto route whose tags lean it towards rocky Pokémon still fights on the
 * grass its lane runs through: Fire Red has no mountain battle background of
 * its own, and Emerald's — near white above a pebbled platform — read as a
 * backdrop that failed to load (`backdrop`). And a strip can be slid down the
 * map a few blocks to show more of what stands under the lane (`bandDrop`):
 * Route 10's showed only the tops of the rocks beside its road.
 *
 * The lane is found as the longest run with two rows of headroom over it, which
 * on a road two blocks wide with trees or a fence along its far side is the
 * grass along its near side: the companion walked beside the road rather than
 * on it. An area can name the map row to walk along instead (`lane`), the
 * road's own nearer row.
 *
 * The strip loops by mirroring the walked run at both ends, and where it ends
 * is chosen so that each mirror join reads as the map going on — open ground,
 * a tree line, the middle of a road — rather than as half of something
 * doubled (see `pickLoopEnds`). Where nothing in the run joins cleanly, an
 * area names its first and last block column itself (`loop`): Route 10's
 * strip stops short of the Power Plant, since half a dome against its own
 * mirror image is a building no one built, and Route 2's walks the gap in
 * its tall grass rather than the edge of the sand path beside it.
 *
 * @type {Array<{id: string, dir: string, location: string, tags: string[], game?: 'emerald'|'firered', region?: string, ko?: string, backdrop?: string, bandDrop?: number, loop?: [number, number], lane?: number}>}
 */
export const AREAS = [
  { id: 'route101', dir: 'Route101', location: 'hoenn-route-101', tags: ['grass', 'plain'], loop: [9, 17] },
  { id: 'route102', dir: 'Route102', location: 'hoenn-route-102', tags: ['grass', 'water'] },
  { id: 'route103', dir: 'Route103', location: 'hoenn-route-103', tags: ['grass', 'beach'], lane: 13 },
  { id: 'route104', dir: 'Route104', location: 'hoenn-route-104', tags: ['beach', 'forest'], lane: 25 },
  { id: 'route110', dir: 'Route110', location: 'hoenn-route-110', tags: ['grass', 'urban'], lane: 70 },
  { id: 'route111', dir: 'Route111', location: 'hoenn-route-111', tags: ['desert', 'sand'], lane: 9 },
  { id: 'route112', dir: 'Route112', location: 'hoenn-route-112', tags: ['mountain', 'volcano'], lane: 51 },
  { id: 'route113', dir: 'Route113', location: 'hoenn-route-113', tags: ['volcano', 'ash'] },
  { id: 'route114', dir: 'Route114', location: 'hoenn-route-114', tags: ['mountain', 'rough'] },
  { id: 'route115', dir: 'Route115', location: 'hoenn-route-115', tags: ['beach', 'mountain'] },
  { id: 'route116', dir: 'Route116', location: 'hoenn-route-116', tags: ['grass', 'rough'] },
  { id: 'route117', dir: 'Route117', location: 'hoenn-route-117', tags: ['grass', 'meadow'] },
  { id: 'route118', dir: 'Route118', location: 'hoenn-route-118', tags: ['beach', 'water'] },
  { id: 'route119', dir: 'Route119', location: 'hoenn-route-119', tags: ['jungle', 'rain'] },
  { id: 'route120', dir: 'Route120', location: 'hoenn-route-120', tags: ['jungle', 'water'], lane: 6 },
  { id: 'route121', dir: 'Route121', location: 'hoenn-route-121', tags: ['grass', 'meadow'] },
  { id: 'route123', dir: 'Route123', location: 'hoenn-route-123', tags: ['grass', 'meadow'], lane: 15 },
  { id: 'petalburg-woods', dir: 'PetalburgWoods', location: 'petalburg-woods', tags: ['forest'] },
  { id: 'granite-cave', dir: 'GraniteCave_1F', location: 'granite-cave', tags: ['cave', 'rough'] },
  { id: 'fiery-path', dir: 'FieryPath', location: 'fiery-path', tags: ['volcano', 'cave'] },
  { id: 'jagged-pass', dir: 'JaggedPass', location: 'jagged-pass', tags: ['mountain', 'volcano'] },
  { id: 'meteor-falls', dir: 'MeteorFalls_1F_1R', location: 'meteor-falls', tags: ['cave', 'water'] },
  { id: 'mt-pyre', dir: 'MtPyre_Exterior', location: 'mt-pyre', tags: ['mountain', 'graveyard'], loop: [12, 18] },
  { id: 'safari-zone', dir: 'SafariZone_South', location: 'hoenn-safari-zone', tags: ['grass', 'safari'] },
  { id: 'shoal-cave', dir: 'ShoalCave_LowTideEntranceRoom', location: 'shoal-cave', tags: ['cave', 'ice'] },
  { id: 'victory-road', dir: 'VictoryRoad_1F', location: 'hoenn-victory-road', tags: ['cave', 'rough'] },
  { id: 'seafloor-cavern', dir: 'SeafloorCavern_Room1', location: 'seafloor-cavern', tags: ['cave', 'water'] },
  { id: 'cave-of-origin', dir: 'CaveOfOrigin_1F', location: 'cave-of-origin', tags: ['cave', 'ruins'] },

  // Kanto, from the Fire Red decompilation: the same engine and the same hand
  // as Emerald, so the two regions share one look. PokeAPI carries no Korean
  // names for Kanto, so `ko` gives the official one. The sea routes (19-21)
  // are nearly all water, and the Sevii Islands never had a Korean release to
  // name them, so neither is here.
  { id: 'kanto-route-1', dir: 'Route1', location: 'kanto-route-1', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '1번도로' },
  { id: 'kanto-route-2', dir: 'Route2', location: 'kanto-route-2', tags: ['grass', 'forest'], game: 'firered', region: 'kanto', ko: '2번도로', loop: [7, 13] },
  { id: 'kanto-route-3', dir: 'Route3', location: 'kanto-route-3', tags: ['mountain', 'rough'], game: 'firered', region: 'kanto', backdrop: 'grass', ko: '3번도로' },
  { id: 'kanto-route-4', dir: 'Route4', location: 'kanto-route-4', tags: ['mountain', 'grass'], game: 'firered', region: 'kanto', backdrop: 'grass', ko: '4번도로' },
  { id: 'kanto-route-5', dir: 'Route5', location: 'kanto-route-5', tags: ['grass', 'urban'], game: 'firered', region: 'kanto', ko: '5번도로' },
  { id: 'kanto-route-6', dir: 'Route6', location: 'kanto-route-6', tags: ['grass', 'water'], game: 'firered', region: 'kanto', ko: '6번도로' },
  { id: 'kanto-route-7', dir: 'Route7', location: 'kanto-route-7', tags: ['grass', 'urban'], game: 'firered', region: 'kanto', ko: '7번도로' },
  { id: 'kanto-route-8', dir: 'Route8', location: 'kanto-route-8', tags: ['grass', 'urban'], game: 'firered', region: 'kanto', ko: '8번도로' },
  { id: 'kanto-route-9', dir: 'Route9', location: 'kanto-route-9', tags: ['mountain', 'rough'], game: 'firered', region: 'kanto', backdrop: 'grass', ko: '9번도로' },
  { id: 'kanto-route-10', dir: 'Route10', location: 'kanto-route-10', tags: ['mountain', 'electric'], game: 'firered', region: 'kanto', backdrop: 'grass', bandDrop: 2, ko: '10번도로', loop: [3, 13] },
  { id: 'kanto-route-11', dir: 'Route11', location: 'kanto-route-11', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '11번도로' },
  { id: 'kanto-route-12', dir: 'Route12', location: 'kanto-route-12', tags: ['grass', 'water'], game: 'firered', region: 'kanto', ko: '12번도로' },
  { id: 'kanto-route-13', dir: 'Route13', location: 'kanto-route-13', tags: ['grass', 'meadow'], game: 'firered', region: 'kanto', ko: '13번도로' },
  { id: 'kanto-route-14', dir: 'Route14', location: 'kanto-route-14', tags: ['grass', 'meadow'], game: 'firered', region: 'kanto', ko: '14번도로' },
  { id: 'kanto-route-15', dir: 'Route15', location: 'kanto-route-15', tags: ['grass', 'meadow'], game: 'firered', region: 'kanto', lane: 6, ko: '15번도로' },
  { id: 'kanto-route-16', dir: 'Route16', location: 'kanto-route-16', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', lane: 7, ko: '16번도로' },
  { id: 'kanto-route-17', dir: 'Route17', location: 'kanto-route-17', tags: ['beach', 'plain'], game: 'firered', region: 'kanto', ko: '17번도로' },
  { id: 'kanto-route-18', dir: 'Route18', location: 'kanto-route-18', tags: ['beach', 'grass'], game: 'firered', region: 'kanto', ko: '18번도로' },
  { id: 'kanto-route-22', dir: 'Route22', location: 'kanto-route-22', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '22번도로' },
  { id: 'kanto-route-23', dir: 'Route23', location: 'kanto-route-23', tags: ['mountain', 'rough'], game: 'firered', region: 'kanto', backdrop: 'grass', lane: 17, ko: '23번도로' },
  { id: 'kanto-route-24', dir: 'Route24', location: 'kanto-route-24', tags: ['grass', 'water'], game: 'firered', region: 'kanto', ko: '24번도로' },
  { id: 'kanto-route-25', dir: 'Route25', location: 'kanto-route-25', tags: ['grass', 'beach'], game: 'firered', region: 'kanto', ko: '25번도로' },
  { id: 'viridian-forest', dir: 'ViridianForest', location: 'viridian-forest', tags: ['forest'], game: 'firered', region: 'kanto', ko: '상록숲' },
  { id: 'mt-moon', dir: 'MtMoon_1F', location: 'mt-moon', tags: ['cave', 'rough'], game: 'firered', region: 'kanto', ko: '달맞이산' },
  { id: 'rock-tunnel', dir: 'RockTunnel_1F', location: 'rock-tunnel', tags: ['cave', 'rough'], game: 'firered', region: 'kanto', ko: '돌산터널' },
  { id: 'digletts-cave', dir: 'DiglettsCave_B1F', location: 'digletts-cave', tags: ['cave', 'sand'], game: 'firered', region: 'kanto', ko: '디그다의굴' },
  { id: 'seafoam-islands', dir: 'SeafoamIslands_1F', location: 'seafoam-islands', tags: ['cave', 'ice'], game: 'firered', region: 'kanto', ko: '쌍둥이섬' },
  { id: 'kanto-victory-road', dir: 'VictoryRoad_1F', location: 'kanto-victory-road-2', tags: ['cave', 'rough'], game: 'firered', region: 'kanto', ko: '챔피언로드', loop: [9, 18] },
  { id: 'cerulean-cave', dir: 'CeruleanCave_1F', location: 'cerulean-cave', tags: ['cave', 'ruins'], game: 'firered', region: 'kanto', ko: '블루시티동굴' },
];

/** The three Kanto starters the game opens with, in Pokédex order. */
export const STARTERS = [1, 4, 7];

/** Window geometry: roughly one sixteenth of the screen's area. */
export const VIEW_WIDTH = 480;
export const VIEW_HEIGHT = 270;

/** The field is drawn at twice size; see `FIELD_ZOOM` in the shared constants. */
export const FIELD_ZOOM = 2;
export const FIELD_WIDTH = VIEW_WIDTH / FIELD_ZOOM;
export const FIELD_HEIGHT = VIEW_HEIGHT / FIELD_ZOOM;

/**
 * The scrolling background fills the field, as the map does in the real games.
 * A map shorter than this contributes every row it has.
 */
export const BACKGROUND_HEIGHT = FIELD_HEIGHT;

/**
 * The battle backdrop is composed at exactly the field's own size, so the
 * battle scene draws it one-to-one over the same doubled space the map uses.
 * The handheld shows the leftmost 240 columns of its 256-wide tilemap, which
 * is what cropping to the field width reproduces.
 */
export const BATTLE_WIDTH = FIELD_WIDTH;
export const BATTLE_HEIGHT = FIELD_HEIGHT;

/**
 * The eight badges on the Hoenn trainer card, in sheet order, named for the
 * type of the gym that awards each one.
 */
export const HOENN_BADGE_TYPES = [
  'rock',
  'fighting',
  'electric',
  'fire',
  'normal',
  'flying',
  'psychic',
  'water',
];

