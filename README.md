# Game Power

Many instances of a web game on screen at once, tiled, with live RAM per
instance. The multi-instance grid an Android emulator gives you — without the
Android.

## Why not LDPlayer / MEmu

QQiROSE is a **web** game: WebGL in a browser, with a PWA manifest and no
Android app. Running it under an emulator means

```
Windows -> virtual machine -> Android OS -> Android Chrome -> game
```

Every instance pays for a whole guest operating system, which is where an
emulator's ~1.5–2 GB per instance goes. Game Power's stack is

```
Windows -> window -> game
```

and every instance shares **one** GPU process and **one** network process with
all the others, because they are windows in one browser rather than N virtual
machines. A running instance here costs roughly 200–350 MB.

## How it works

There is **one original** and everything else is a **clone of it**, the way an
emulator's multi-instance manager works.

1. **Start the original**, log in, and download the game's asset packs.
2. Press **Create clone**. That makes a new instance whose storage is a copy of
   the original's, so it already has the packs — the multi-gigabyte download
   happens once instead of once per instance.
3. Start the clone and log it into its own account.

Repeat step 2 for as many instances as you want. Each one keeps its own login,
cookies and asset cache in its own `persist:rca-game-<id>` session.

A clone carries the original's login too, so log out and into the next account
inside each copy. And a clone is a full copy on disk: the same pack set across
ten clones needs ten times the space.

## What else it does

- Lays every running window out in a grid sized to your screen.
- Shows RAM, CPU and uptime per instance, read from Chromium's own per-process
  accounting — not an estimate. The same numbers appear in each window's title
  bar, the way an emulator labels its instances.
- Low-graphics settings that mirror an emulator's:
  - **Frame rate cap** wraps `requestAnimationFrame` so the game's render loop
    is only called N times a second. Frames in between are dropped before
    anything draws. (An emulator's "Frame Rate: 15".)
  - **Render scale** pins `devicePixelRatio` low, so the game allocates a
    physically smaller WebGL drawing buffer and the browser scales it up.
    Fewer pixels per frame, less video memory. (An emulator's "Resolution:
    540x960".)
  - **Phone mode** gives each instance a mobile browser identity and a portrait
    window, so the game serves its lighter layout.

Both low-graphics settings are applied by `game-preload.js` inside the page,
and the "Low graphics" column reports what actually took effect rather than
what was asked for. They apply to instances started after you save.

## Running it

```
npm install
npm start
```

To build a Windows installer and a portable exe into `dist/`:

```
npm run dist
```

## Layout

| File | What it is |
|---|---|
| `main.js` | Control window, IPC |
| `instances.js` | The game windows, the grid, metrics, cloning |
| `game-preload.js` | Frame-rate cap and render scale, inside the page |
| `preload.js` | Control-window bridge |
| `index.html` / `renderer.js` / `styles.css` | The control panel |

Settings live in `game.json` and each instance's data in `Partitions/` under
the app's user-data folder.
