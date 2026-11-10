/**
 * Three save slots, stored as JSON under `userData/saves`.
 *
 * Writes go to a temporary file first and are then renamed into place, because
 * the game autosaves every five minutes and may be killed at any moment — a
 * half-written slot would lose a run.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SAVE_DIR } from './paths.mjs';

export const SLOT_COUNT = 3;

/** Bumped whenever the save shape changes; `migrate` brings old files forward. */
export const SAVE_VERSION = 1;

/** @param {number} slot */
const slotFile = (slot) => join(SAVE_DIR, `slot${slot}.json`);

/**
 * Headline information for the slot-select screen, without loading whole saves.
 * @returns {Promise<Array<{slot: number, empty: boolean, summary: any}>>}
 */
export async function listSlots() {
  const slots = [];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const save = await readSlot(slot);
    slots.push(
      save
        ? {
            slot,
            empty: false,
            summary: {
              speciesId: save.party?.active?.speciesId ?? null,
              nickname: save.party?.active?.nickname ?? null,
              // Which of the two palettes the slot's Pokémon is drawn in, so
              // the slot list shows the one the player actually has.
              shiny: Boolean(save.party?.active?.shiny),
              // A Pokémon carries experience, not a level: what that comes to
              // depends on its species' growth rate, which only the renderer
              // has the data to work out.
              experience: save.party?.active?.experience ?? 0,
              badges: (save.party?.active?.badges ?? save.progress?.badges)?.length ?? 0,
              playtime: save.progress?.playtime ?? 0,
              savedAt: save.savedAt ?? null,
              // Where the run was left, which the title screen shows behind it.
              areaId: save.progress?.areaId ?? null,
              champion: Boolean(save.party?.active?.champion ?? save.progress?.champion),
            },
          }
        : { slot, empty: true, summary: null },
    );
  }
  return slots;
}

/**
 * @param {number} slot
 * @returns {Promise<any|null>}
 */
export async function readSlot(slot) {
  if (!isValidSlot(slot)) return null;
  try {
    const save = JSON.parse(await readFile(slotFile(slot), 'utf8'));
    return migrate(save);
  } catch {
    return null;
  }
}

/**
 * @param {number} slot
 * @param {any} save
 */
export async function writeSlot(slot, save) {
  if (!isValidSlot(slot)) throw new Error(`Invalid save slot ${slot}`);
  await mkdir(SAVE_DIR, { recursive: true });

  const payload = JSON.stringify({ ...save, version: SAVE_VERSION, savedAt: Date.now() });
  const temporary = `${slotFile(slot)}.tmp`;
  await writeFile(temporary, payload);
  await rename(temporary, slotFile(slot));
  return true;
}

/** @param {number} slot */
export async function deleteSlot(slot) {
  if (!isValidSlot(slot)) return false;
  try {
    await unlink(slotFile(slot));
    return true;
  } catch {
    return false;
  }
}

/** Remove temporary files left behind by a crash mid-write. */
export async function cleanTemporaryFiles() {
  try {
    const entries = await readdir(SAVE_DIR);
    await Promise.all(
      entries.filter((entry) => entry.endsWith('.tmp')).map((entry) => unlink(join(SAVE_DIR, entry))),
    );
  } catch {
    // No save directory yet — nothing to clean.
  }
}

const isValidSlot = (slot) => Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT;

/**
 * Bring an older save forward. Version 1 is the first shape, so there is
 * nothing to do yet beyond stamping unversioned files.
 * @param {any} save
 */
function migrate(save) {
  if (!save || typeof save !== 'object') return null;
  if (!save.version) save.version = SAVE_VERSION;
  return save;
}
