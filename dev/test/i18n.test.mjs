import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRAMMARS,
  languages,
  name,
  resetLanguages,
  setLanguage,
  t,
} from '../../app/renderer/core/i18n.mjs';
import { resolveParticles } from '../../app/renderer/core/korean.mjs';
import {
  defaultLanguage,
  fallbackChain,
  LANGUAGES_FILE,
  normalizeLanguages,
} from '../../app/shared/languages.mjs';

const AUTHORED = fileURLToPath(new URL('../../data/authored/', import.meta.url));

/** @param {string} path relative to the authored data root */
const readAuthored = async (path) => JSON.parse(await readFile(join(AUTHORED, path), 'utf8'));

/** The languages the game actually ships, as opposed to a test's own sheet. */
const shipped = normalizeLanguages(
  JSON.parse(await readFile(join(AUTHORED, LANGUAGES_FILE), 'utf8')),
);

/**
 * Every module under a directory, so the string files can be checked against
 * what the screens really ask for.
 * @param {string} directory
 * @returns {string[]}
 */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

test('object particles follow the final consonant', () => {
  // 리, 기 and 씨 end without a final consonant and take 를; 몽 ends in ㅇ
  // and takes 을.
  assert.equal(resolveParticles('파이리을(를) 선택했다!'), '파이리를 선택했다!');
  assert.equal(resolveParticles('꼬부기을(를) 선택했다!'), '꼬부기를 선택했다!');
  assert.equal(resolveParticles('리자몽을(를) 선택했다!'), '리자몽을 선택했다!');
  assert.equal(resolveParticles('이상해씨을(를) 선택했다!'), '이상해씨를 선택했다!');
});

test('subject and topic particles agree too', () => {
  assert.equal(resolveParticles('리자몽이(가) 나타났다!'), '리자몽이 나타났다!');
  assert.equal(resolveParticles('파이리이(가) 나타났다!'), '파이리가 나타났다!');
  assert.equal(resolveParticles('리자몽은(는) 쓰러졌다!'), '리자몽은 쓰러졌다!');
  assert.equal(resolveParticles('파이리은(는) 쓰러졌다!'), '파이리는 쓰러졌다!');
  assert.equal(resolveParticles('리자몽과(와) 함께'), '리자몽과 함께');
  assert.equal(resolveParticles('파이리과(와) 함께'), '파이리와 함께');
});

test('으로/로 treats a final ㄹ as no final consonant', () => {
  assert.equal(resolveParticles('리자몽으로(로) 변경했다!'), '리자몽으로 변경했다!');
  assert.equal(resolveParticles('파이리으로(로) 변경했다!'), '파이리로 변경했다!');
  // 이글이글 ends in ㄹ, which takes the bare 로.
  assert.equal(resolveParticles('이글이글으로(로) 변경'), '이글이글로 변경');
});

test('so does "(으)로", the way the string files write it', () => {
  assert.equal(resolveParticles('파이리는 리자드(으)로 진화했다!'), '파이리는 리자드로 진화했다!');
  assert.equal(resolveParticles('이브이는 샤미드(으)로 진화했다!'), '이브이는 샤미드로 진화했다!');
  assert.equal(resolveParticles('메타몽은 이상해꽃(으)로 변신했다!'), '메타몽은 이상해꽃으로 변신했다!');
  assert.equal(resolveParticles('이글이글(으)로 변경'), '이글이글로 변경');
  assert.equal(resolveParticles('레벨 16(으)로 올랐다!'), '레벨 16(으)로 올랐다!');
});

test('a non-Hangul word before the particle keeps the written form', () => {
  assert.equal(resolveParticles('Pikachu을(를) 선택'), 'Pikachu을(를) 선택');
  assert.equal(resolveParticles('을(를) 선택'), '을(를) 선택');
});

test('several particles in one sentence are each resolved', () => {
  assert.equal(
    resolveParticles('리자몽은(는) 파이리을(를) 이겼다!'),
    '리자몽은 파이리를 이겼다!',
  );
});

// --------------------------------------------------------------- the sheet

test('a sheet row only needs a code; the rest is filled in', () => {
  const [only] = normalizeLanguages({ languages: [{ code: 'ja' }] });
  assert.equal(only.code, 'ja');
  assert.equal(only.label, 'ja');
  assert.equal(only.strings, 'i18n/ja.json');
  assert.equal(only.source, null);
  assert.equal(only.grammar, null);
  assert.equal(only.fallback, null);
  assert.equal(only.isDefault, false);
});

test('rows without a code, and repeats of one, are dropped', () => {
  const languages = normalizeLanguages({
    languages: [{ code: 'en' }, { label: 'nameless' }, { code: '  ' }, { code: 'en', label: 'again' }],
  });
  assert.deepEqual(languages.map((language) => language.code), ['en']);
  assert.equal(languages[0].label, 'en');
});

test('a missing or malformed sheet lists no languages rather than throwing', () => {
  assert.deepEqual(normalizeLanguages(null), []);
  assert.deepEqual(normalizeLanguages({}), []);
  // A hand-edited sheet whose list is not a list at all.
  assert.deepEqual(normalizeLanguages(/** @type {any} */ ({ languages: 'ko,en' })), []);
});

test('the default language is the one that claims it, else the first listed', () => {
  const marked = normalizeLanguages({ languages: [{ code: 'en' }, { code: 'ko', default: true }] });
  assert.equal(defaultLanguage(marked).code, 'ko');

  const unmarked = normalizeLanguages({ languages: [{ code: 'en' }, { code: 'ko' }] });
  assert.equal(defaultLanguage(unmarked).code, 'en');

  assert.equal(defaultLanguage([]), null);
});

test('the fallback chain follows the declared fallback, then everything else', () => {
  const languages = normalizeLanguages({
    languages: [{ code: 'ko', fallback: 'en' }, { code: 'en' }, { code: 'ja', fallback: 'ko' }],
  });
  // A language reads itself, then what it falls back to, then the rest — so a
  // language added with only half its strings written still shows them all.
  assert.deepEqual(fallbackChain(languages, 'ja'), ['ja', 'ko', 'en']);
  assert.deepEqual(fallbackChain(languages, 'ko'), ['ko', 'en', 'ja']);
  assert.deepEqual(fallbackChain(languages, 'en'), ['en', 'ko', 'ja']);
});

test('a language the sheet does not list still reads every one it does', () => {
  const languages = normalizeLanguages({ languages: [{ code: 'ko', fallback: 'en' }, { code: 'en' }] });
  assert.deepEqual(fallbackChain(languages, 'de'), ['ko', 'en']);
});

test('a fallback loop is walked once rather than forever', () => {
  const languages = normalizeLanguages({
    languages: [{ code: 'ko', fallback: 'en' }, { code: 'en', fallback: 'ko' }],
  });
  assert.deepEqual(fallbackChain(languages, 'ko'), ['ko', 'en']);
});

// ------------------------------------------------------- the shipped sheet

test('every shipped language has the strings it points at', async () => {
  for (const language of shipped) {
    const strings = await readAuthored(language.strings);
    assert.ok(Object.keys(strings).length > 0, `${language.code}: ${language.strings} is empty`);
  }
});

test('every shipped language translates exactly the same keys', async () => {
  const base = defaultLanguage(shipped);
  const expected = Object.keys(await readAuthored(base.strings));

  for (const language of shipped) {
    if (language.code === base.code) continue;
    const keys = Object.keys(await readAuthored(language.strings));
    assert.deepEqual(
      keys.filter((key) => !expected.includes(key)),
      [],
      `${language.code} has keys ${base.code} does not`,
    );
    assert.deepEqual(
      expected.filter((key) => !keys.includes(key)),
      [],
      `${language.code} is missing keys ${base.code} has`,
    );
  }
});

test('every key the screens ask for is written in every language', async () => {
  const keys = new Set();
  for (const file of sourceFiles(fileURLToPath(new URL('../../app/', import.meta.url)))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bt\(\s*(['"])([^'"${}]+)\1/g)) keys.add(match[2]);
  }
  assert.ok(keys.size > 50, `only found ${keys.size} keys — has the lookup moved?`);

  for (const language of shipped) {
    const strings = await readAuthored(language.strings);
    const missing = [...keys].filter((key) => !(key in strings));
    assert.deepEqual(missing, [], `${language.code} is missing ${missing.join(', ')}`);
  }
});

test('a language with a grammar helper names one the renderer has', () => {
  // `korean` is the only helper so far; a sheet naming another would silently
  // get no grammar at all, which is exactly the kind of typo this catches.
  for (const language of shipped) {
    if (!language.grammar) continue;
    assert.ok(GRAMMARS.includes(language.grammar), `${language.code}: unknown grammar "${language.grammar}"`);
  }
});

// ------------------------------------------------------- switching languages

/**
 * Drive the renderer's i18n module against a sheet of our own, standing in for
 * the two things it reaches out to: the `pdc://` protocol and the document.
 *
 * @param {Record<string, any>} files keyed by path under the authored root
 * @param {() => Promise<void>} body
 */
async function withSheet(files, body) {
  const original = { fetch: globalThis.fetch, document: globalThis.document };
  // Only the two members `loadJson` reads, which is all the stub owes a caller.
  globalThis.fetch = /** @type {any} */ (async (url) => {
    const path = String(url).replace('pdc://authored/', '');
    return path in files
      ? { ok: true, status: 200, json: async () => files[path] }
      : { ok: false, status: 404, json: async () => ({}) };
  });
  globalThis.document = /** @type {any} */ ({ documentElement: { lang: '' } });

  try {
    await body();
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    resetLanguages();
  }
}

const TWO_LANGUAGES = {
  'i18n/languages.json': {
    languages: [
      { code: 'ko', label: '한국어', strings: 'i18n/ko.json', grammar: 'korean', fallback: 'en', default: true },
      { code: 'en', label: 'English', strings: 'i18n/en.json' },
    ],
  },
  'i18n/ko.json': { 'settings.close': '닫기', 'battle.fainted': '{name}은(는) 쓰러졌다!' },
  'i18n/en.json': { 'settings.close': 'Close', 'battle.fainted': '{name} fainted!' },
};

test('switching the language switches the strings and the data names', async () => {
  await withSheet(TWO_LANGUAGES, async () => {
    const bulbasaur = { ko: '이상해씨', en: 'Bulbasaur' };

    await setLanguage('en');
    assert.equal(t('settings.close'), 'Close');
    assert.equal(t('battle.fainted', { name: 'Charizard' }), 'Charizard fainted!');
    assert.equal(name(bulbasaur), 'Bulbasaur');
    assert.equal(document.documentElement.lang, 'en');

    await setLanguage('ko');
    assert.equal(t('settings.close'), '닫기');
    // The sheet asks for Korean grammar, so the particle agrees with 몽.
    assert.equal(t('battle.fainted', { name: '리자몽' }), '리자몽은 쓰러졌다!');
    assert.equal(name(bulbasaur), '이상해씨');
    assert.equal(document.documentElement.lang, 'ko');
  });
});

test('a language the sheet no longer lists falls back to the default', async () => {
  await withSheet(TWO_LANGUAGES, async () => {
    assert.equal(await setLanguage('de'), 'ko');
    assert.equal(t('settings.close'), '닫기');
  });
});

test('a language listed in the settings menu is labelled in its own words', async () => {
  await withSheet(TWO_LANGUAGES, async () => {
    await setLanguage('en');
    assert.deepEqual(
      languages().map((language) => [language.code, language.label]),
      [['ko', '한국어'], ['en', 'English']],
    );
  });
});

test('a language added with only some of its strings reads the rest through', async () => {
  // What adding a language is meant to look like: a row in the sheet and a file
  // that need not be finished, with no code change anywhere.
  const partial = {
    'i18n/languages.json': {
      languages: [
        ...TWO_LANGUAGES['i18n/languages.json'].languages,
        { code: 'ja', label: '日本語', strings: 'i18n/ja.json', fallback: 'en' },
      ],
    },
    'i18n/ko.json': TWO_LANGUAGES['i18n/ko.json'],
    'i18n/en.json': TWO_LANGUAGES['i18n/en.json'],
    'i18n/ja.json': { 'settings.close': '閉じる' },
  };

  await withSheet(partial, async () => {
    assert.equal(await setLanguage('ja'), 'ja');
    assert.equal(t('settings.close'), '閉じる');
    // Not translated yet, so English stands in — and with it English grammar,
    // rather than Korean particles left unresolved in a Japanese screen.
    assert.equal(t('battle.fainted', { name: 'Charizard' }), 'Charizard fainted!');
    // The generated data has no Japanese names yet either.
    assert.equal(name({ ko: '이상해씨', en: 'Bulbasaur' }), 'Bulbasaur');
    assert.equal(name({ ja: 'フシギダネ', en: 'Bulbasaur' }), 'フシギダネ');
  });
});

test('a language whose string file is missing still leaves a playable game', async () => {
  const unwritten = {
    'i18n/languages.json': {
      languages: [
        ...TWO_LANGUAGES['i18n/languages.json'].languages,
        { code: 'ja', label: '日本語', fallback: 'en' },
      ],
    },
    'i18n/ko.json': TWO_LANGUAGES['i18n/ko.json'],
    'i18n/en.json': TWO_LANGUAGES['i18n/en.json'],
  };

  await withSheet(unwritten, async () => {
    assert.equal(await setLanguage('ja'), 'ja');
    assert.equal(t('settings.close'), 'Close');
  });
});
