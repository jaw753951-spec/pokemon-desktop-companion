<div align="center">
  <img src="dev/build/icon.png" width="128" alt="Pokémon Desktop Companion">
  <h1>Pokémon Desktop Companion</h1>
  <p>
    A desktop tamagotchi: in a small window that always floats on top of your screen,<br>
    a Pokémon travels, battles, farms items and grows up on its own.
  </p>
  <p>
    <a href="https://github.com/jaw753951-spec/pokemon-destop-companion/releases/latest"><img src="https://img.shields.io/github/v/release/jaw753951-spec/pokemon-destop-companion?style=flat-square&label=release" alt="Latest release"></a>
    <a href="https://github.com/jaw753951-spec/pokemon-destop-companion/releases"><img src="https://img.shields.io/github/downloads/jaw753951-spec/pokemon-destop-companion/total?style=flat-square" alt="Downloads"></a>
    <img src="https://img.shields.io/badge/fan%20project-non--commercial-ef5350?style=flat-square" alt="Non-commercial fan project">
  </p>
  <p>
    <a href="https://github.com/jaw753951-spec/pokemon-destop-companion/releases/latest"><img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows"></a>
    <a href="https://github.com/jaw753951-spec/pokemon-destop-companion/releases/latest"><img src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS"></a>
    <a href="https://github.com/jaw753951-spec/pokemon-destop-companion/releases/latest"><img src="https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux"></a>
  </p>
  <img src=".github/readme/field.png" width="720" alt="The companion walking Route 101">
</div>

> [!NOTE]
> **This is a non-commercial fan project.** All rights to Pokémon and its related names, images and music
> belong to Nintendo / Creatures Inc. / GAME FREAK inc.

## Download

Grab the file for your OS from the [latest release](https://github.com/jaw753951-spec/pokemon-destop-companion/releases/latest).

| OS | File |
| --- | --- |
| Windows | `*-win-x64.zip` — unzip it and run `Pokemon Desktop Companion.exe` |
| macOS | Apple silicon (M1 and later) `*-mac-arm64.dmg` · Intel `*-mac-x64.dmg` |
| Linux | `*-linux-x86_64.AppImage` |

### The first launch

This is a personal fan project with no signing certificate, so your OS will block it once. You only have to get
past it the one time.

- **Windows** — there is no installer; just unzip it. If a "Windows protected your PC" window appears, choose
  **More info → Run anyway**.
- **macOS** — **right-click the app → Open → Open**. If it is still blocked, run this in Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Pokemon Desktop Companion.app"`
- **Linux** — `chmod +x *.AppImage`, then run it.

### Good to know

- The window is small and always stays on top. Hover over the top of the window and a drag
  bar appears; its position and size are remembered.
- The three save slots and your settings are stored outside the app (`userData`), so they survive an update.

## Auto save

Progress is **saved automatically every 5 minutes**. You can also save and leave yourself with **Save and return
to title** / **Save and quit** in the settings.

## Controls

- The window **always floats above other windows**. Drag it by the top edge or anywhere outside the game picture
  to move it, and the spot is remembered.
- **Press and hold on the screen to fast-forward.** Let go and it returns to normal speed.
- During a battle, pressing the screen skips through the messages faster.
- The buttons along the bottom open the **Bag · Pokédex · Settings · Shop**. Your Pokémon keeps walking while a
  menu is open.

## The journey

Your Pokémon walks the real maps of **Hoenn** (Emerald) and **Kanto** (FireRed). Along the way it comes across
berry trees, item balls, wild Pokémon and trainers, and every so often it moves on to a new place. When it runs
low on health, potions or balls, a Pokémon Center turns up.

<table>
  <tr>
    <td width="50%" align="center"><img src=".github/readme/berry.png" alt="A berry tree on the road"><br><sub>A berry tree</sub></td>
    <td width="50%" align="center"><img src=".github/readme/item-ball.png" alt="An item ball on the road"><br><sub>An item ball</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src=".github/readme/trainer.png" alt="A trainer waiting on the road"><br><sub>A trainer</sub></td>
    <td width="50%" align="center"><img src=".github/readme/center.png" alt="A Pokémon Center on the road"><br><sub>A Pokémon Center</sub></td>
  </tr>
</table>

## Battles

Battles are fought **automatically**. Which moves get used is up to you, in **Auto-battle** under Bag → Pokémon.

<table>
  <tr>
    <td width="50%" align="center"><img src=".github/readme/battle.png" alt="A wild battle"><br><sub>A wild battle</sub></td>
    <td width="50%" align="center"><img src=".github/readme/auto-battle.png" alt="The auto-battle settings"><br><sub>Auto-battle settings</sub></td>
  </tr>
</table>

## Catching

**Win a battle** against a wild Pokémon and it goes up to **To catch** in the top right of the screen. Tap its
icon to open the catch screen and pick a ball from your bag to throw. What you catch goes into your box.

<table>
  <tr>
    <td width="50%" align="center"><img src=".github/readme/to-catch.png" alt="A Pokémon waiting to be caught"><br><sub>Waiting in To catch</sub></td>
    <td width="50%" align="center"><img src=".github/readme/capture.png" alt="The catch screen"><br><sub>The catch screen</sub></td>
  </tr>
</table>

## Shop

Open it any time with the **Shop** button at the bottom right of the field. You earn money by beating trainers,
and pay out when you lose to them.

## Gyms

Gym Leaders show up in place of trainers as your Pokémon grows, and beating one earns you a **badge**.

<table>
  <tr>
    <td width="50%" align="center"><img src=".github/readme/gym.png" alt="Walking into a gym"><br><sub>A gym on the road</sub></td>
    <td width="50%" align="center"><img src=".github/readme/badges.png" alt="The badge case"><br><sub>The badge case</sub></td>
  </tr>
</table>

## The Pokémon League

**Once you have 8 badges**, a **Head for the Pokémon League** button appears at the bottom of the field. Beat the Elite Four
and then the Champion in turn to become Champion. If you leave partway with
**Get ready**, you can pick up again from where you won. Badges and the Champion title are kept per Pokémon.

<table>
  <tr>
    <td width="50%" align="center"><img src=".github/readme/elite-four.png" alt="An Elite Four battle"><br><sub>The Elite Four</sub></td>
    <td width="50%" align="center"><img src=".github/readme/champion.png" alt="The Champion battle"><br><sub>The Champion</sub></td>
  </tr>
</table>

## Bag, Pokédex and box

<table>
  <tr>
    <td width="33%" align="center"><img src=".github/readme/bag.png" alt="The bag"><br><sub>Bag</sub></td>
    <td width="33%" align="center"><img src=".github/readme/pokedex.png" alt="A Pokédex entry"><br><sub>Pokédex</sub></td>
    <td width="33%" align="center"><img src=".github/readme/box.png" alt="The box"><br><sub>Box</sub></td>
  </tr>
</table>

## Settings

| Tab | What's in it |
| --- | --- |
| Display | Window size |
| Sound | Music · sound effect · cry volume |
| Language | 한국어 / English |
| Credits | The list of sprite artists |

## Credits

| What | Source |
| --- | --- |
| Pokémon data, official names and descriptions in each language | [PokeAPI](https://github.com/PokeAPI/api-data) |
| Pokémon sprites | #1–649: the official Pokémon Black & White sprites · after that, and regional forms: the [Smogon Sprite Project](https://www.smogon.com/forums/threads/sword-shield-sprite-project.3647722/) (artists listed in the game under **Settings → Credits**) · [PokeAPI/sprites](https://github.com/PokeAPI/sprites) |
| Cries | [PokeAPI/cries](https://github.com/PokeAPI/cries) |
| Maps · trainer sprites · item icons · BGM | [pret/pokeemerald](https://github.com/pret/pokeemerald), [pret/pokefirered](https://github.com/pret/pokefirered) |
| Move effects · categories | [Pokémon Showdown](https://github.com/smogon/pokemon-showdown) |
| Official Korean text | [sv-text](https://github.com/Pokemon-Project-com/sv-text), [PokeMiners/pogo_assets](https://github.com/PokeMiners/pogo_assets) |

<sub>All rights to Pokémon and its related names, images and music belong to Nintendo / Creatures Inc. /
GAME FREAK inc. This game uses them solely as a non-commercial fan project.</sub>
