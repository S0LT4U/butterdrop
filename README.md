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
| `Alt+Shift+V` (global) | Open visualizer with the audio-source picker |
| `Esc` | Hide visualizer (or close the picker if open) |
| `Space` / `→` | Next preset |
| `←` | Previous preset |
| `S` | Open audio-source picker |

The source picker lets you choose what drives the visuals: **System Audio**
(WASAPI loopback — everything Windows plays, the default) or any audio input
device (microphone, line-in, Stereo Mix, USB mixer). Switching is live; the
choice is remembered across sessions. If a remembered device is unplugged,
Butterdrop falls back to System Audio.

Presets auto-rotate every 30 seconds with a crossfade blend. The preset name
shows briefly in the top-left when it changes. The visualizer opens on
whichever monitor the mouse cursor is on.

## Tray menu

Right-click the tray icon for: Show/Hide Visualizer, Next Preset,
Select Audio Source, TV Mode, Run at Startup (adds to Windows login
items), and Quit.

## TV Mode

Toggle **TV Mode** in the tray menu and any device on your network can run
the visualizer in its own browser: smart TV, Chromecast/Fire TV browser,
tablet, another PC. Use **Copy TV URL** in the tray menu and open that URL
(e.g. `http://192.168.1.50:8720/?t=abcd1234`) on the device, then tap /
press OK to start.

How it works: the PC captures its audio continuously (even with the local
visualizer hidden) and streams raw samples over WebSocket (~100 KB/s — no
video encoding). Each connected device renders Butterchurn on its own GPU,
so many screens can connect at once. The URL token is generated per
install and required for both the page and the audio stream; the server
only runs while TV Mode is on. TV Mode survives restarts (it's saved to
`config.json` as `tvMode`; the port is `tvPort`, default 8720).

Playing music from your phone? Use Spotify Connect (or similar casting)
to make this PC the playback device — Butterdrop visualizes whatever the
PC plays. On the TV page: OK/Enter/click = next preset.

## Config

Edit `config.json` (restart the app to apply):

```json
{
  "hotkey": "Control+Alt+V",
  "pickerHotkey": "Alt+Shift+V",
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
