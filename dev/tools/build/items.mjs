/**
 * Collect item icons, and sort the items the game can hand out into rarity
 * tiers so the ball-pickup event can draw from a tier that matches the ball.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { VENDOR_DIR } from '../lib/vendor.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { crop, opaqueBounds } from '../lib/image.mjs';
import { defaultLanguage } from '../../../app/shared/languages.mjs';
import { LANGUAGES } from '../languages.mjs';
import { BALL_TIERS, SPRITES } from '../sources.mjs';
import { signatureItems } from '../../../app/renderer/engine/forms.mjs';

/**
 * The language the tiers and the generated document are judged in: an item with
 * no official name of its own in it is one of the dex's unused oddities, and is
 * kept out of the field pickups.
 */
const BASE = defaultLanguage(LANGUAGES);

/**
 * That language's name for a record, or whatever it falls back to.
 * @param {{name?: Record<string, string>}} record
 * @param {string} fallback
 */
const label = (record, fallback) => record?.name?.[BASE.code] || fallback;

/**
 * Whether a record only carries the name it borrowed from another language.
 * @param {{name?: Record<string, string>}} record
 */
function unnamed(record) {
  const own = record?.name?.[BASE.code];
  if (!own) return true;
  return Boolean(BASE.fallback) && own === record.name[/** @type {string} */ (BASE.fallback)];
}

/**
 * @param {{assetDir: string, dataDir: string, docsDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildItems({ assetDir, dataDir, docsDir, log, pool }) {
  /** @type {Record<string, any>} */
  const items = JSON.parse(await readFile(join(dataDir, 'items.json'), 'utf8'));
  /** @type {Record<string, string>} */
  const machines = JSON.parse(await readFile(join(dataDir, 'machines.json'), 'utf8'));
  /** @type {Record<string, any>} */
  const moves = JSON.parse(await readFile(join(dataDir, 'moves.json'), 'utf8'));

  let saved = 0;
  const withoutIcon = [];
  await Promise.all(
    Object.keys(items).map((name) =>
      pool(async () => {
        const found = await firstAvailable(iconCandidates(name, items[name], machines, moves));
        const icon = found && ICON_TINTS[name] ? tinted(found, ICON_TINTS[name]) : found;
        if (icon) {
          await writeOut(join(assetDir, 'items', `${name}.png`), icon);
          items[name].sprite = true;
          saved++;
        } else {
          items[name].sprite = false;
          withoutIcon.push(name);
        }
      }),
    ),
  );

  // A TM is only usable if we know which move it teaches.
  for (const [name, item] of Object.entries(items)) {
    if (item.pocket === 'machines') item.move = machines[name] ?? null;
  }

  const tiers = assignRarityTiers(items, moves);
  await writeOut(join(dataDir, 'items.json'), JSON.stringify(items));
  await writeOut(join(dataDir, 'item-tiers.json'), JSON.stringify(tiers));
  await writeOut(join(docsDir, 'item-rarity.md'), renderTierDocument(items, tiers, moves));

  log(`item icons ${saved}/${Object.keys(items).length} (${withoutIcon.length} without art)`);
  for (const tier of BALL_TIERS) log(`  ${tier.ball.padEnd(12)} ${tiers[tier.ball].length} items @ ${tier.chance}%`);
  return tiers;
}

/**
 * Where an item's icon might live. TMs and HMs share one icon per move type
 * rather than having their own art, which is also how the games draw them.
 *
 * @param {string} name
 * @param {any} item
 * @param {Record<string, string>} machines
 * @param {Record<string, any>} moves
 * @returns {string[]}
 */
function iconCandidates(name, item, machines, moves) {
  // The newest items are only drawn in the generation folders, and a few not
  // at all; those borrow the nearest picture there is.
  const drawn = ICON_STAND_INS[name] ?? name;
  const candidates = [
    ...(MOCHI.includes(name) ? [archiveBagIcon(name)] : []),
    ...(pokespriteIcon(name) ? [`${POKESPRITE}/items/${pokespriteIcon(name)}.png`] : []),
    `${SPRITES}/items/${drawn}.png`,
    `${SPRITES}/items/gen9/${drawn}.png`,
    `${SPRITES}/items/gen8/${drawn}.png`,
    `${POKESPRITE}/items/key-item/${drawn}.png`,
    `${POKESPRITE}/items/evo-item/${drawn}.png`,
  ];
  if (item.pocket === 'machines') {
    const type = moves[machines[name]]?.type;
    const prefix = name.startsWith('hm') ? 'hm' : 'tm';
    if (type) candidates.push(`${SPRITES}/items/${prefix}-${type}.png`);
    candidates.push(`${SPRITES}/items/${prefix}-normal.png`);
  }
  return candidates;
}

/** The PokéSprite item set, which draws a few key items PokeAPI does not. */
const POKESPRITE = 'https://raw.githubusercontent.com/msikma/pokesprite/master';

/**
 * The seven mochi of The Teal Mask, which neither published set draws. The
 * only pictures of them are Scarlet and Violet's own bag icons, which
 * Bulbagarden Archives keeps — and which it refuses to the build machines
 * releases are made on, so they are kept in `data/vendor/bulbagarden` and
 * read from there. They are smooth renders at 160 pixels rather than pixel
 * art, and are brought down to the bag's size on the way in.
 */
const MOCHI = [
  'health-mochi', 'muscle-mochi', 'resist-mochi', 'genius-mochi', 'clever-mochi', 'swift-mochi', 'fresh-start-mochi',
];

/**
 * An item's Scarlet and Violet bag icon as kept in the vendor folder, under
 * the archive's own file name: "Bag_Health_Mochi_SV_Sprite.png".
 *
 * @param {string} slug
 */
function archiveBagIcon(slug) {
  const title = slug.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join('_')
    .replace('Fresh_Start', 'Fresh-Start');
  return `${VENDORED}bulbagarden/Bag_${title}_SV_Sprite.png`;
}

/** Marks a candidate that is a file in `data/vendor` rather than a URL. */
const VENDORED = 'vendor:';

/**
 * Where PokéSprite files the Sword and Shield items PokeAPI draws none of,
 * which it keeps under names of its own: the Exp. Candies by size, the Mints
 * by the stat their nature raises (one picture for the four of each), and
 * the Ability Patch.
 *
 * @param {string} name
 * @returns {string|null} the path under PokéSprite's `items/`
 */
function pokespriteIcon(name) {
  const candy = /^exp-candy-(xs|s|m|l|xl)$/.exec(name);
  if (candy) return `exp-candy/${candy[1]}`;
  const mint = /^([a-z]+)-mint$/.exec(name);
  if (mint && MINT_STATS[mint[1]]) return `mint/${MINT_STATS[mint[1]]}`;
  if (name === 'ability-patch') return 'other-item/ability-patch';
  return null;
}

/** Which of PokéSprite's five Mint pictures each Mint is: the stat its nature raises. */
const MINT_STATS = Object.fromEntries([
  ...['lonely', 'adamant', 'naughty', 'brave'].map((nature) => [nature, 'attack']),
  ...['bold', 'impish', 'lax', 'relaxed'].map((nature) => [nature, 'defense']),
  ...['modest', 'mild', 'rash', 'quiet'].map((nature) => [nature, 'special-attack']),
  ...['calm', 'gentle', 'careful', 'sassy'].map((nature) => [nature, 'special-defense']),
  ...['timid', 'hasty', 'jolly', 'naive'].map((nature) => [nature, 'speed']),
  ['serious', 'neutral'],
]);

/**
 * Items no published set draws, and the one each is shown as: Legends: Arceus's
 * crystal and globe look like the orbs they replaced.
 *
 * @type {Record<string, string>}
 */
const ICON_STAND_INS = {
  // Let's Go's silver and golden catching berries, drawn as the plain berry
  // they are a better kind of.
  'silver-razz-berry': 'razz-berry',
  'golden-razz-berry': 'razz-berry',
  'adamant-crystal': 'adamant-orb',
  'lustrous-globe': 'lustrous-orb',
  // The evolution items of the newest games, drawn by nobody yet: each shown
  // as the nearest thing that is — an apple as an apple, an alloy as a coat
  // of metal, a cord as silk, armour as armour.
  'syrupy-apple': 'sweet-apple',
  // The one Sweet, drawn as the strawberry one.
  sweet: 'strawberry-sweet',
  'metal-alloy': 'metal-coat',
  'black-augurite': 'dusk-stone',
  'peat-block': 'soft-sand',
  'leaders-crest': 'razor-claw',
  'linking-cord': 'silk-scarf',
  'scroll-of-darkness': 'dread-plate',
  'auspicious-armor': 'protector',
  'malicious-armor': 'reaper-cloth',
  'meltan-candy': 'rare-candy',
  'gimmighoul-coin': 'amulet-coin',
  'scroll-of-waters': 'splash-plate',
  // Poltchageist's teacups, as the pots Sinistea evolves by; and the mochi,
  // should the archive below be out of reach, as a sweet of the same size.
  'unremarkable-teacup': 'cracked-pot',
  'masterpiece-teacup': 'chipped-pot',
  ...Object.fromEntries(MOCHI.map((slug) => [slug, 'lava-cookie'])),
};

/**
 * The icons that borrow another's picture and need telling apart from it: a
 * silver and a golden Razz Berry are the plain one in metal.
 */
const ICON_TINTS = {
  'silver-razz-berry': 'silver',
  'golden-razz-berry': 'gold',
};

/**
 * Recolour an icon by its brightness: grey for silver, a gold ramp for gold,
 * outlines kept dark.
 *
 * @param {Buffer} buffer
 * @param {'silver'|'gold'} metal
 * @returns {Buffer}
 */
function tinted(buffer, metal) {
  const png = decodePng(buffer);
  const data = Buffer.from(png.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const light = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    if (metal === 'silver') {
      const grey = clamp(light * 1.15 + 35);
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = clamp(grey + 12);
    } else {
      data[i] = clamp(light * 1.1 + 70);
      data[i + 1] = clamp(light * 0.95 + 40);
      data[i + 2] = clamp(light * 0.35);
    }
  }
  return encodePng(png.width, png.height, data);
}

/**
 * The first icon that exists, trimmed to its opaque area.
 *
 * The published icons float inside a 30x30 canvas whose padding is most of the
 * image. In a bag cell that is invisible — the cell is a fixed box and the art
 * is centred in it either way — but in the field, where a gathered item is
 * held up over the companion's head at the map's own scale, the padding makes
 * a berry twice the size of the Pokémon holding it. Trimmed, an item comes out
 * about a tile across, which is what one looks like on the ground.
 *
 * @param {string[]} urls
 * @returns {Promise<Buffer|null>}
 */
async function firstAvailable(urls) {
  for (const url of urls) {
    const buffer = url.startsWith(VENDORED)
      ? await readFile(join(VENDOR_DIR, url.slice(VENDORED.length))).catch(() => null)
      : await fetchBuffer(url, { allowMissing: true });
    if (!buffer) continue;

    const png = decodePng(buffer);
    const bounds = opaqueBounds(png);
    if (!bounds) continue;

    const trimmed = crop(png, bounds.x, bounds.y, bounds.width, bounds.height);
    // A render made for a television — the Scarlet and Violet bag icons — is
    // brought to the size of the rest, which the field draws one-to-one.
    const sized = Math.max(trimmed.width, trimmed.height) > LARGEST_ICON ? shrunk(trimmed, ICON_SIZE) : trimmed;
    return encodePng(sized.width, sized.height, sized.data);
  }
  return null;
}

/** The longest side of a drawn icon, and what a bigger one is brought down to. */
const LARGEST_ICON = 32;
const ICON_SIZE = 20;

/**
 * Shrink a picture so its longer side is `size`, each new pixel the average of
 * the ones it covers — weighted by how opaque they are, so an edge fades into
 * the background rather than taking on the colour of nothing.
 *
 * @param {{width: number, height: number, data: Uint8Array}} source
 * @param {number} size
 */
function shrunk(source, size) {
  const scale = size / Math.max(source.width, source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.min(source.width, Math.ceil((x + 1) / scale));
      const y0 = Math.floor(y / scale);
      const y1 = Math.min(source.height, Math.ceil((y + 1) / scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * source.width + sx) * 4;
          const alpha = source.data[at + 3];
          r += source.data[at] * alpha;
          g += source.data[at + 1] * alpha;
          b += source.data[at + 2] * alpha;
          a += alpha;
          count++;
        }
      }
      const out = (y * width + x) * 4;
      if (a > 0) {
        data[out] = Math.round(r / a);
        data[out + 1] = Math.round(g / a);
        data[out + 2] = Math.round(b / a);
      }
      data[out + 3] = Math.round(a / Math.max(1, count));
    }
  }
  return { width, height, data };
}

/**
 * Split the droppable items into one pool per ball tier.
 *
 * Rarity follows the games' own economy — shop cost first, with held items and
 * TMs weighted up because they are permanent gains here — but the cut points
 * are quantiles rather than fixed prices. Absolute prices cluster badly (most
 * of the dex's items are worth a few hundred, and the truly rare ones are
 * priceless, so they read as free), and quantiles guarantee every tier has
 * something to hand out.
 *
 * @param {Record<string, any>} items
 * @param {Record<string, any>} moves keyed by move name, for scoring TMs
 * @returns {Record<string, string[]>}
 */
export function assignRarityTiers(items, moves = {}) {
  /** @type {Map<string, Array<{name: string, score: number}>>} */
  const byPocket = new Map();
  // What a TM or an HM teaches, so a record that teaches the same can be left
  // out.
  const taughtByMachine = new Set(
    Object.entries(items)
      .filter(([name, item]) => item.pocket === 'machines' && !/^tr\d+$/.test(name) && item.move)
      .map(([, item]) => item.move),
  );

  for (const [name, item] of Object.entries(items)) {
    if (!item.sprite) continue;
    // Sword and Shield's records mostly teach what the TMs already do, and
    // would bury them a hundred deep in the machine pool. The few that teach
    // something no TM does — a Megahorn, a Leaf Blade — are the only way to
    // find those moves on the road, so they stay.
    if (item.pocket === 'machines' && /^tr\d+$/.test(name) && (!item.move || taughtByMachine.has(item.move))) continue;
    if (item.pocket === 'key') continue;
    // A berry grows on a tree; a ball on the road holds something else.
    if (item.pocket === 'berries') continue;
    // A legendary's own item turns up only while it is the one travelling,
    // which the find decides at the time (`fieldevents.mjs`).
    if (SIGNATURE.has(name)) continue;
    if (EXCLUDED_CATEGORIES.has(item.category)) continue;
    if (unnamed(item)) continue;

    let score = item.cost > 0 ? item.cost : UNPRICED_SCORE[item.pocket] ?? 3000;
    // Every TM is priced the same in the data, so rank them by the move they
    // teach instead — otherwise the rarest tiers fill up with TMs in number
    // order and nothing else.
    if (item.pocket === 'machines') score = machineScore(moves[item.move]);
    if (item.attributes.includes('holdable-active')) score = Math.max(score, 4000);

    const list = byPocket.get(item.pocket) ?? [];
    list.push({ name, score });
    byPocket.set(item.pocket, list);
  }

  /** @type {Record<string, string[]>} */
  const tiers = Object.fromEntries(BALL_TIERS.map((tier) => [tier.ball, []]));

  // Quantiles are taken per pocket rather than over the whole pool, so that
  // every tier offers a mix of medicine, berries, held items, balls and TMs
  // instead of one pocket monopolising the rare end.
  for (const list of byPocket.values()) {
    // Ties must not straddle a tier boundary unpredictably, so sort by name too.
    list.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    let start = 0;
    BALL_TIERS.forEach((tier, index) => {
      const end = index === BALL_TIERS.length - 1
        ? list.length
        : Math.round(list.length * TIER_QUANTILES[index]);
      const slice = list.slice(start, Math.max(end, Math.min(start + 1, list.length)));
      tiers[tier.ball].push(...slice.map((entry) => entry.name));
      start = Math.max(end, Math.min(start + 1, list.length));
    });
  }

  for (const list of Object.values(tiers)) list.sort();
  return tiers;
}

/**
 * How valuable a TM is, from the move it teaches: raw power for attacks, and a
 * flat mid-tier value for status moves, which are useful but not jackpots.
 * @param {any} move
 */
function machineScore(move) {
  if (!move) return 2000;
  if (move.damageClass === 'status') return 2600;
  const power = move.power ?? 60;
  const accuracy = (move.accuracy ?? 100) / 100;
  return Math.round(1200 + power * accuracy * 32);
}

/** Pocket labels for the generated document, which is written in Korean. */
const POCKET_LABELS = {
  medicine: '회복',
  berries: '나무열매',
  pokeballs: '볼',
  machines: '기술머신',
  misc: '도구',
};

/** Cumulative share of the item pool below each tier boundary. */
const TIER_QUANTILES = [0.6, 0.85, 0.97];

/** Categories that would be meaningless or game-breaking as a field pickup. */
/** The items that are one species' own. */
const SIGNATURE = signatureItems();

const EXCLUDED_CATEGORIES = new Set([
  // A charm is earned or bought, never found.
  'charms',
  'plates',
  'species-specific',
  'all-mail',
  'unused',
  'event-items',
  'gameplay',
  'loot',
  'mega-stones',
  'z-crystals',
  'dynamax-crystals',
]);

/** Items the games never sell still need a rarity; judge them by pocket. */
const UNPRICED_SCORE = {
  medicine: 900,
  berries: 700,
  pokeballs: 900,
  machines: 6000,
  misc: 2500,
};

/**
 * @param {Record<string, any>} items
 * @param {Record<string, string[]>} tiers
 * @param {Record<string, any>} moves
 */
function renderTierDocument(items, tiers, moves = {}) {
  const lines = [
    '# 아이템 희귀도 티어',
    '',
    '필드의 몬스터볼 이벤트에서 어떤 볼이 나오느냐에 따라 뽑히는 아이템 풀이 달라집니다.',
    '이 문서는 `tools/build/items.mjs` 가 자동 생성합니다 — 직접 편집하지 마세요.',
    '',
    '| 볼 | 등장 확률 | 아이템 수 |',
    '| --- | ---: | ---: |',
    ...BALL_TIERS.map((tier) => `| ${label(items[tier.ball], tier.ball)} | ${tier.chance}% | ${tiers[tier.ball].length} |`),
    '',
  ];

  for (const tier of BALL_TIERS) {
    lines.push(`## ${label(items[tier.ball], tier.ball)} (${tier.chance}%)`, '');
    lines.push('| 아이템 | 포켓 | 비고 |');
    lines.push('| --- | --- | --- |');
    for (const name of tiers[tier.ball]) {
      const item = items[name];
      const note = item.pocket === 'machines'
        ? label(moves[item.move], item.move ?? '-')
        : item.cost > 0 ? `${item.cost}원` : '-';
      lines.push(`| ${label(item, name)} | ${POCKET_LABELS[item.pocket] ?? item.pocket} | ${note} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
