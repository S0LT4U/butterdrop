# Butterdrop

Instant fullscreen Milkdrop-style music visualizer for whatever Windows is playing.
Sits in the system tray; one hotkey toggles a fullscreen [Butterchurn](https://github.com/jberg/butterchurn)
visualization driven by system audio (WASAPI loopback via Electron's display-media capture).

## Run

```
npm install
npm start
```

The app starts hidden in the system tray (purple/cyan waveform icon).

## Controls

| Key | Action |
| --- | --- |
| `Ctrl+Alt+V` (global) | Toggle fullscreen visualizer on/off |
| `Esc` | Hide visualizer |
| `Space` / `→` | Next preset |
| `←` | Previous preset |

Presets auto-rotate every 30 seconds with a crossfade blend. The preset name
shows briefly in the top-left when it changes. The visualizer opens on
whichever monitor the mouse cursor is on.

## Tray menu

Right-click the tray icon for: Show/Hide Visualizer, Next Preset,
Run at Startup (adds to Windows login items), and Quit.

## Config

Edit `config.json` (restart the app to apply):

```json
{
  "hotkey": "Control+Alt+V",
  "presetIntervalSeconds": 30,
  "presetBlendSeconds": 2.7
}
```

`hotkey` uses [Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator)
(e.g. `"Super+Shift+M"`).

## How it works

- **main.js** — tray icon, global hotkey, fullscreen frameless window management.
  A `setDisplayMediaRequestHandler` grants every `getDisplayMedia` call the primary
  screen with `audio: 'loopback'`, which is Electron's built-in WASAPI system-audio
  capture — no picker dialog, no virtual audio cable needed.
- **renderer/renderer.js** — calls `getDisplayMedia`, discards the video track,
  feeds the loopback audio through a Web Audio `MediaStreamSource` into Butterchurn,
  and runs the render loop. Capture and audio context are fully torn down when
  hidden, so the app uses ~0 GPU when idle in the tray.
- **Presets** — the base + extra packs from
  [butterchurn-presets](https://github.com/jberg/butterchurn-presets) (~367 presets),
  shuffled on each start.

## Notes

- Audio capture starts when the visualizer is shown, so there's a ~quarter-second
  spin-up on toggle. Nothing is captured or rendered while hidden.
- The Electron "Insecure Content-Security-Policy" warning in dev mode is expected:
  Butterchurn compiles Milkdrop preset equations at runtime, which requires eval.
  The app only loads local files.
