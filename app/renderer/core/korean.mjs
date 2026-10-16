/**
 * Korean grammar helpers.
 *
 * Korean particles agree with the final consonant (받침) of the word before
 * them, which is only known once a Pokémon or item name has been substituted
 * into a string. The string files therefore write particles in the neutral
 * "을(를)" form seen in the games' own text, and this module picks the right
 * one afterwards.
 */

/** Index of ㄹ in the Hangul final-consonant table. */
const RIEUL = 8;

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

/** The neutral forms the string files use, mapped to their two readings. */
const PARTICLE_PATTERN = /(을|이|은|과|으로|아)\((를|가|는|와|로|야)\)/g;

/**
 * The other way the games write 으로/로, and the way the string files do:
 * "(으)로", the optional part in brackets.
 */
const EURO_PATTERN = /\(으\)로/g;

/**
 * @param {string} text
 * @returns {string}
 */
export function resolveParticles(text) {
  text = text.replace(EURO_PATTERN, (match, offset) => {
    const batchim = finalConsonantOf(text[offset - 1]);
    if (batchim === null) return match;
    return batchim === 0 || batchim === RIEUL ? '로' : '으로';
  });
  return text.replace(PARTICLE_PATTERN, (match, withBatchim, withoutBatchim, offset) => {
    const batchim = finalConsonantOf(text[offset - 1]);
    // A Latin or numeric name gives no basis to choose, so the neutral form
    // written in the string file is left as it is.
    if (batchim === null) return match;
    // 으로/로 is the exception: a final ㄹ takes the bare 로.
    if (withBatchim === '으로' && batchim === RIEUL) return withoutBatchim;
    return batchim === 0 ? withoutBatchim : withBatchim;
  });
}

/**
 * The final-consonant index of a Hangul syllable: 0 when it has none, null
 * when the character is not a Hangul syllable at all.
 *
 * @param {string|undefined} character
 * @returns {number|null}
 */
export function finalConsonantOf(character) {
  if (!character) return null;
  const code = character.charCodeAt(0);
  if (code < HANGUL_FIRST || code > HANGUL_LAST) return null;
  return (code - HANGUL_FIRST) % 28;
}
