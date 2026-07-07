# Butterdrop

Instant fullscreen Milkdrop-style music visualizer for whatever Windows is
playing — with one-click casting to smart TVs.

![Butterdrop reacting to music, blending between MilkDrop presets](assets/demo.gif)

Butterdrop sits in the system tray. One global hotkey toggles a fullscreen
[Butterchurn](https://github.com/jberg/butterchurn) (WebGL MilkDrop 2)
visualization driven by system audio via WASAPI loopback. Flip on TV Mode and
any browser on your network can run the same visualizer on its own GPU, fed by
a lightweight audio stream (~190 KB/s — no video encoding). Cast it straight
to a Chromecast-enabled TV from the tray, and drive everything from your
phone.

## Features

- **Instant fullscreen visualizer** — global hotkey, opens on whichever
  monitor your cursor is on, ~370 classic MilkDrop presets, auto-rotating
  with crossfade blends
- **Any audio source** — system loopback (everything Windows plays, default)
  or any input device (mic, line-in, Stereo Mix, USB mixer), switchable live
- **TV Mode** — serves the visualizer to any device on your LAN; each screen
  renders on its own GPU with stereo audio playback
- **One-click casting** — discovers Google Cast devices (Chromecast,
  Android TV / Google TV) and pushes the visualizer to them from the tray
- **Phone remote** — next/prev preset, sound on/off, cast/stop-cast from
  your phone's browser
- **Tray service** — starts hidden, optional run-at-boot, near-zero idle cost

## Install & run

Requires [Node.js](https://nodejs.org) 18+ on Windows 10/11.

```
git clone https://github.com/S0LT4U/butterdrop
cd butterdrop
npm install
npm start
```

The app starts hidden in the system tray (purple/cyan waveform icon). On its
first run it drops a **Butterdrop** shortcut on your desktop, so after that
you can just double-click to launch (no terminal needed). Delete the shortcut
and it won't come back.

> **Don't run Butterdrop as administrator.** Windows blocks screen/audio
> capture from elevated processes, so the visualizer can't hear your audio
> (you'll see "Could not start video source"). Launch it from a normal
> terminal or shortcut. Butterdrop warns you if it detects it's elevated.

## Controls

| Key | Action |
| --- | --- |
| `Ctrl+Alt+V` (global) | Toggle fullscreen visualizer on/off |
| `Alt+Shift+V` (global) | Open visualizer with the audio-source picker |
| `Esc` | Hide visualizer (or close the picker if open) |
| `Space` / `→` | Next preset |
| `←` | Previous preset |
| `S` | Open audio-source picker |

The source picker chooses what drives the visuals: **System Audio** (WASAPI
loopback — everything Windows plays, the default) or any audio input device.
Switching is live and remembered across sessions; if a remembered device is
unplugged, Butterdrop falls back to System Audio.

## Tray menu

Right-click the tray icon: Show/Hide Visualizer, Next Preset (drives local
and TV screens), Select Audio Source, TV Mode, **Cast to…**, Stop Casting,
Copy TV URL, Copy Phone Remote URL, Run at Startup, Quit.

## TV Mode

Toggle **TV Mode** in the tray menu. The PC then captures its audio
continuously (even with the local visualizer hidden) and serves two pages on
your LAN (default port 8720):

- **TV page** (`Copy TV URL`, e.g. `http://192.168.1.50:8720/?t=abcd1234`) —
  open it in any browser (smart TV, tablet, another PC), tap/press OK, and
  that device runs the visualizer fullscreen, in sync with the PC's audio.
- **Phone remote** (`Copy Phone Remote URL`, `/remote?t=…`) — big buttons
  for prev/next preset, sound on/off, cast, and stop-cast. Bookmark it to
  your phone's home screen.

The audio feed is 48 kHz stereo 16-bit (~190 KB/s per screen — less than a
Spotify stream). Hi-res outputs (96/192 kHz) are resampled on the wire, and
mic-style processing (auto gain control, noise suppression) is disabled on
the capture, so levels stay steady and faithful to the source. Multiple
screens can connect at once; each renders independently.

**Sound:** every screen plays the audio it receives — mute whichever ones
you don't want (TV remote, M key on the TV page, phone remote, or PC
volume). TV audio plays through the device's native media pipeline (an
endless-WAV HTTP stream), which makes it immune to rendering stutter but
adds a few seconds of startup buffering — each screen's sound and visuals
are perfectly synced with *each other*, just behind the PC. Pick one place
to listen.

**Performance:** TVs render at a capped internal resolution (default 1280,
`?res=` to override) and at most 30 fps. The page tunes itself to the
device: resolution scales down when it struggles and back up on light
presets, and presets whose math is simply too heavy for the device are
auto-skipped and remembered, so each screen gradually curates a set it can
actually run. Playback registers as genuine video, so the TV's screensaver
won't cut in mid-session.

Playing music from your phone? Use Spotify Connect (or similar casting) to
make this PC the playback device — Butterdrop visualizes whatever the PC
plays, on every connected screen.

URL parameters for the TV page: `autostart=1` skips the tap-to-start splash
(used when casting), `sound=0` starts muted.

## Casting

Tray → **Cast to…** lists Google Cast devices discovered on your network
(Chromecast, Android TV / Google TV — e.g. Sony BRAVIA sets). One click:

1. TV Mode starts if it isn't on
2. The TV's Cast receiver launches DashCast (a community receiver that
   displays a URL)
3. The visualizer page loads and autostarts, dancing to the PC's audio

**Stop Casting** from the tray or phone remote ends it (the HOME button on
the TV remote works too). Cast receiver pages can't see TV remote buttons,
so use the phone remote or tray to change presets on a casted screen.

The Cast implementation is dependency-free — a minimal Cast v2 protocol
client (`castclient.js`) speaking hand-encoded protobuf over TLS, with SSDP
(DIAL) discovery across all network interfaces. Found devices are remembered
(locally, outside the repo) and re-probed on refresh, so a known TV shows up
even when it ignores a discovery broadcast.

## Configuration

Edit `config.json` (restart the app to apply):

```json
{
  "hotkey": "Control+Alt+V",
  "pickerHotkey": "Alt+Shift+V",
  "presetIntervalSeconds": 30,
  "presetBlendSeconds": 2.7,
  "tvMode": false,
  "tvPort": 8720
}
```

Hotkeys use [Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator).
`tvMode` persists automatically when toggled from the tray.

## Run at startup

Tray → **Run at Startup** registers the app in Windows login items, so it's
waiting in the tray after every boot.

## Security notes

- The TV/remote pages and the audio WebSocket all require a random
  per-install token in the URL (`?t=…`); requests without it get 403. The
  server only runs while TV Mode is on, and only serves an allowlisted set
  of files. Treat the URL as LAN-private — the audio stream is your
  system audio.
- The visualizer window is locked down: context isolation, no node
  integration, navigation and window-opening denied, CSP restricted to
  local scripts. `unsafe-eval` is required by Butterchurn to compile
  MilkDrop preset equations — presets come only from the pinned npm
  packages.
- `npm audit` is kept at zero known vulnerabilities.

## How it works

- **main.js** — tray, global hotkeys, fullscreen window management, Cast
  session control. A `setDisplayMediaRequestHandler` grants `getDisplayMedia`
  the primary screen with `audio: 'loopback'` (Electron's built-in WASAPI
  system-audio capture — no picker, no virtual audio cable).
- **renderer/renderer.js + tap-worklet.js** — local visualizer + the TV Mode
  capture tap. The tap runs in an AudioWorklet on the audio thread, so heavy
  preset rendering can't starve it and glitch the stream.
- **tvserver.js** — HTTP + WebSocket server: serves the TV/remote pages,
  streams audio as an endless WAV, and broadcasts control messages to
  connected screens.
- **renderer/tv.js** — browser-side client: plays the WAV stream through the
  device's native media pipeline (glitch-immune), feeds it to Butterchurn
  for analysis, adapts render quality, and reports telemetry back to the PC
  logs for debugging.
- **castclient.js** — minimal Google Cast v2 sender + SSDP discovery.

## Credits & acknowledgements

Butterdrop is glue around other people's brilliant work:

- **[Butterchurn](https://github.com/jberg/butterchurn)** by Jordan Berg
  (jberg) — the WebGL implementation of the MilkDrop 2 visualizer that does
  all the actual rendering. MIT licensed.
- **[butterchurn-presets](https://github.com/jberg/butterchurn-presets)** —
  the preset collections, converted from original MilkDrop presets written
  over two decades by the MilkDrop preset community (Flexi, Geiss, martin,
  shifter, Rovastar, and many more — preset names carry their authors).
- **[MilkDrop](https://www.geisswerks.com/milkdrop/)** by Ryan Geiss — the
  original Winamp visualizer (2001) that started all of this.
- **[DashCast](https://github.com/stestagg/dashcast)** by Steve Stagg
  (stestagg), and the [fork by John Wells (madmod)](https://github.com/madmod/dashcast)
  whose hosted Cast receiver (app `84912283`) Butterdrop uses to display the
  visualizer URL on Cast devices.
- **[Electron](https://www.electronjs.org/)** — app shell, tray, global
  shortcuts, and the WASAPI loopback capture.
- **[ws](https://github.com/websockets/ws)** — the WebSocket server that
  carries audio to the TVs.

Butterdrop was designed and written in a pair-programming session with
**Claude Fable 5** via [Claude Code](https://claude.com/claude-code)
(Anthropic).

## License

MIT (see Butterchurn's and other projects' licenses for their components).
