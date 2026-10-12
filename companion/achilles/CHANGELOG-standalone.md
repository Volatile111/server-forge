# Achilles Mod Manager - Changelog

Alpha, Beta and Release builds are kept in separate sections. Newest entry first in each.

## Alpha

### 0.4.0 - 2026-10-08

**Changed**
- Achilles is now the **Star Valor** tab of Tavern Client Mod Manager (with its own look, icon and name) instead of a
  separate app. Profiles, settings, the Nexus key, update sources and BepInEx history are copied over on first start.
- The local server only answers its own page: every API call needs the session key, and requests addressed to any
  other host name are refused.

### 0.3.0 - 2026-09-28

**Added - BepInEx version management (new BepInEx tab)**
- Detects what Star Valor runs on (Unity version, Mono vs IL2CPP, 64/32-bit) and lists only
  BepInEx releases whose download fits that engine, straight from BepInEx's GitHub releases.
- **"Will my mods work on this version?"**: every installed plugin is checked against the chosen
  BepInEx version's own files (`server/tools/check-loader.ps1`) before anything is installed.
  For example, BepInEx 6.0.0-pre.2 is correctly shown as breaking all 5 current plugins, since
  they need `BepInEx.dll` and 6.x doesn't have it.
- **"Does it work on this game build?"**: learned from real launches on this PC. Each launch log
  is recorded with the game build, the BepInEx version, whether it reached the main menu, and
  any startup errors.
- Recommendation banner: stay put, update, check mods first, test, or roll back. It also notices
  when Star Valor updates to a build the installed BepInEx hasn't run on yet, and when the engine
  changes.
- Install any version, newer or older, in one click. Only the loader (core, doorstop, winhttp.dll)
  is swapped; mods and configs are untouched, and the old loader is backed up.
- **Test launch**: starts the game through Steam and watches the log to the main menu. There are
  three modes, chosen in the tab and remembered: test + automatic rollback on failure, test +
  ask first, or no test (the next real launch is checked instead). A failure caused by a mod is
  named as such, not blamed on BepInEx.
- Roll back to the previous BepInEx at any time, closing the game first if needed.
- BepInEx problems also show in the Mods tab banner, and a "!" appears on the BepInEx tab.

**Changed**
- The launch log reader also records the BepInEx version, Unity version, and whether the game
  reached the main menu.

### 0.2.0 - 2026-09-28

**Fixed**
- **Disabling mods didn't work for plugins.** 0.1.0 "disabled" a DLL by moving it to
  `BepInEx/plugins/.disabled`, but BepInEx loads DLLs from every subfolder of `plugins/`, so
  disabled plugins kept loading. Even the Vanilla profile loaded every plugin, which is why a
  crashing mod kept crashing the game after it was "turned off". Disabled mods now live in
  `BepInEx/disabled_mods/`, and leftovers in the old folders are moved there on startup.
- A mod that existed both on and off (duplicate file) got stuck: it showed as off, couldn't be
  turned off, and still loaded. The copy that's on now wins, and toggling backs up the stale copy.
- "Remove" permanently deleted the file. It now moves it to `BepInEx/achilles_backups/`.
- App data went to the generic `%APPDATA%\Electron` folder. It now goes to
  `%APPDATA%\Achilles Mod Manager` (0.1.0 data is copied over once; the old copy is left).
- The local server used a fixed port. With the old copy still open, a new copy crashed with
  `EADDRINUSE` or showed the old copy's data. It now uses a free port, and only one copy can run.
- Launching started `Star Valor.exe` directly, which Steam then killed and restarted. It now
  launches through Steam.
- `.zip` downloads were rejected. They're unpacked now.

**Added**
- **Compatibility check** for every mod against the installed game build: static scan of each DLL,
  plus last-launch errors from `Player.log` blamed on the right mod, plus dependency, loader,
  duplicate, and ship-mod checks. Shown as badges, a details panel, a warning banner, and a
  "Problems" filter.
- **One-button updater** (new Updates tab): automatic GitHub source detection and install;
  Nexus identification by MD5 with a free API key (download stays one click, since Nexus only
  allows Premium API downloads); risky updates held back; old versions backed up.
- Downloading or dropping in a newer version of an installed mod updates it in place (matched by
  plugin ID), so profiles keep it.
- **Select all / Select none / Only working ones**, per-group All/None, and a filter box in the
  profile editor.
- Search, filters, and bulk on/off in the mod list; ship mods in a compact grid.
- Settings tab: Nexus API key, game build, BepInEx version, and folder shortcuts.
- App icon and header art: the Achilles, rendered top-down from the game's own mesh and textures.
- `Achilles Mod Manager.lnk` launcher, a README rewrite, and this changelog.

### 0.1.0 - 2026-09-27 (pre-changelog)
Initial build by an earlier session: Electron shell, mod list with enable/disable, drag-and-drop
install, Nexus mod browser with download interception, profiles with Vanilla, save-slot reader
(MS-NRBF), and the unshipped BepInEx bridge plugin. Reconstructed from the code; per-change detail
wasn't recorded.

## Beta

No beta builds yet.

## Release

No release builds yet.
