# Achilles Mod Manager

A mod manager for **Star Valor**, named after the Achilles - the user's favorite ship, whose real in-game model is
its icon.

**Since 0.4.0 it's part of Tavern Client Mod Manager**: the **Star Valor** tab. `companion/main.js` starts this
folder's local server (`server/http.js`) when the tab first opens and shows its page (`public/`) in a frame; the
frame's `window.desktop` comes from `companion/preload.cjs`. Every `/api` call needs that session's key (sent as
`X-Achilles-Key`; the page gets it in its URL fragment), and the server only answers requests addressed to
`127.0.0.1:<its port>`. Data lives in `%APPDATA%\Tavern Client Mod Manager\achilles` (copied once from the old
`%APPDATA%\Achilles Mod Manager`, which is left as it was). The standalone app's history is in
`CHANGELOG-standalone.md`; the original repo is `C:\Users\Chris\AchillesModManager` on Gaming-RatV2.

The rest of this file describes the standalone 0.3.0 app; the features are the same.

## Running it

Double-click **`Achilles Mod Manager.lnk`** in this folder (pin it to Start/taskbar if you like).
It runs Electron directly, so Node doesn't need to be on PATH.

Or from a terminal: `npm install` once, then `npm start`. (The start script clears
`ELECTRON_RUN_AS_NODE`, which VS Code's terminal sets and which otherwise makes Electron run as
plain Node and fail with "Cannot find module 'electron'".)

The app finds Star Valor through Steam automatically. Only one copy runs at a time; opening it
again focuses the existing window.

## What it does

- **Mods** - every BepInEx plugin (`.dll`, including ones in subfolders) and every ship definition
  (`.shipmod`) in the install. Turn mods on/off one at a time or in bulk (search, filters, per-group
  All on / All off). Drop in `.dll`, `.shipmod` or `.zip` files.
- **Compatibility** - each mod gets a verdict against the *installed* game version:
  - a static scan of the DLL (`server/tools/inspect-plugins.ps1`, using the Mono.Cecil that ships
    inside BepInEx) finds references to game classes, methods, fields, Harmony patch targets and
    reflection lookups that no longer exist, and says which of the mod's functions uses them and
    when that runs;
  - the last launch's `Player.log` is read for errors, attributed to the mod responsible (even when
    Mono blames the game method the mod hooks), and classified as *before the main menu*,
    *while loading a save*, or *while playing*;
  - plus missing/disabled dependencies, BepInEx 6 / MelonLoader builds, wrong-game plugins,
    duplicate copies, ship mods without We Mod Any Ship, and ship files We Mod Any Ship failed to
    load (it renames those `ERR…`, one more `ERR` every launch).
- **Updates** - one **Update all** button. Plugin sources are detected automatically: GitHub repos
  named after the plugin's assembly that actually publish that file, and Nexus mods by file MD5
  (needs a free Nexus API key, set in Settings). Versions are compared using the plugin's own
  version, not the release tag. GitHub updates install automatically; updates whose new version
  still fails the compatibility scan are held back. Nexus only lets Premium accounts download
  through apps, so Nexus updates open in the built-in mod browser - clicking Download there
  installs the file *as an update* of the mod you have.
- **BepInEx** - keeps the mod loader right for this game over time. BepInEx depends on the game's
  *engine* (Unity version, Mono vs IL2CPP, 64-bit), not its build number, so the manager detects
  the engine and only offers BepInEx builds that fit it. Before installing any version it checks
  every plugin against that version's own files (`server/tools/check-loader.ps1`); a mod built
  for BepInEx 5 can't run on 6, for example. It learns from real launch logs which BepInEx
  version actually worked on which game build, and flags when the game updates to a build that
  hasn't been run yet. Installing (newer or older) swaps only the loader and backs up the old
  one. An optional test launch checks the game reaches the main menu, with three modes: auto
  rollback, ask, or no test.
- **Profiles** - named sets of mods (Select all / none / only working ones). Applying one turns
  exactly those on. **Vanilla** = zero mods.
- **Saves** - reads character, level, credits and playtime from each slot's `_Info.dat`
  (`server/lib/nrbf.js`, a purpose-built BinaryFormatter reader), and tracks which profile each
  slot was played with.
- **Launch** - starts the game through Steam.

## Where files go (inside the game's `BepInEx` folder)

| Folder | What's in it |
|---|---|
| `plugins/`, `plugins/ShipMods/` | Mods that are **on** |
| `disabled_mods/plugins`, `disabled_mods/ShipMods` | Mods that are **off** |
| `achilles_backups/<time>_<reason>/` | Every file this app ever replaced or removed |

Disabled mods must be **outside** `plugins/`: BepInEx scans every subfolder of `plugins/`, so
0.1.0's `plugins/.disabled` folder never actually disabled anything. 0.2.0 moves anything left
there on startup.

**Nothing is ever deleted.** Removing, updating, or replacing a mod moves the old file to
`achilles_backups`.

The app's own data (profiles, mod list, settings, caches) lives in
`%APPDATA%\Achilles Mod Manager`. 0.1.0 had put it in `%APPDATA%\Electron`; it's copied over once,
and the old files are left in place.

## Not built yet

- The **BepInEx bridge** plugin (`BepInExBridge/`, live "what's loaded right now" over a named
  pipe) still isn't installed into the game. Rebuilding it needs a .NET SDK, which isn't on this
  PC any more.
- `.7z` / `.rar` downloads aren't unpacked - extract them and drop the files in.

## Code map

```
desktop/        Electron shell (main.js is CommonJS on purpose), preload bridge, icons
server/http.js  local JSON API on a random 127.0.0.1 port
server/lib/     steam · layout · mods · zip · inspect · gamelog · compat · updater · nexus ·
                bepinex · peversion · gameprocess · profiles · saveinfo · nrbf · savelinks ·
                store · game · bridge
server/tools/   inspect-plugins.ps1 (mods vs. the game's code)
                check-loader.ps1    (mods vs. a BepInEx version's code)
public/         UI (index.html, app.js, styles.css, img/)
```
