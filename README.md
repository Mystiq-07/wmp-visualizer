# Windows Media Player — Visualizer

A single-page music visualizer in the style of classic Windows Media Player.
Vanilla JS, Web Audio API, Canvas 2D. No libraries, no build step, no backend.

```
index.html            markup + WMP window chrome
styles.css            the retro chrome (bevels, title bar, LCD readout)
app.js                audio graph, analysis, and the four renderers
assets/wallpaper.svg  the desktop behind the window
songs/oru-naal.mp3    the default track
```

## Running it

Web Audio needs a real HTTP origin. Opening `index.html` straight off the disk
(`file://`) will load the page but produce silence — the app detects this and
says so in the status bar.

```bash
python3 -m http.server 8000
```



## Audio

The default track is `songs/oru-naal.mp3`, referenced from the
`<audio>` element in `index.html` and named once in `app.js` as `DEFAULT_TRACK`
so the status messages match. To swap the default, change both. Listeners can
always override it at runtime with **Open File…**; nothing autoplays, so the
default only starts on Play.

`assets/test-tone.wav` is a 12-second synthetic tone (kick, bass, chord, hats,
and a sweeping lead) used to verify the analyser across the whole spectrum.
Delete it whenever you like — nothing references it.

## The audio graph

There is exactly one `<audio>` element and exactly one
`MediaElementAudioSourceNode` for the life of the page:

```
<audio> ──▶ MediaElementSource ──▶ Analyser ──▶ destination
```

`createMediaElementSource()` may only be called once per media element; calling
it twice throws `InvalidStateError`. So switching tracks never touches the
graph — the old track is paused, `audio.src` is reassigned, and the existing
source node follows the element. Two source nodes cannot end up fighting over
the analyser, because a second one is never created.

Nothing autoplays. The `AudioContext` is constructed *and* resumed inside the
Play handler, so the first sound is always downstream of a user gesture.

## Visual modes

| Mode | Data | What it draws |
|---|---|---|
| **Bars** | `getByteFrequencyData` | Segmented bars mirrored top/bottom, with peak-hold caps |
| **Radial** | `getByteFrequencyData` | The same bars wrapped around a pulsing centre, mirrored inward |
| **Scope** | `getByteTimeDomainData` | Three stacked oscilloscope traces with phosphor trails |
| **Cascade** | `getByteFrequencyData` | Scrolling spectrogram — frequency across, time down |

Colour is driven by level, and saturation/brightness/glow ride overall
intensity, so the whole display gets hotter as the track does. Bass hits are
detected against a running mean of the low bins and bloom the background.

### Analysis details that matter

**Log frequency mapping.** The bins are linearly spaced to 22 kHz, but almost
all musical energy sits below 8 kHz. Mapped naively, the right half of the
display is a permanent flatline. The 64 display bars are instead spaced
logarithmically over 30 Hz–16 kHz, with a tilt that lifts the quieter high end.

**Resolution.** `fftSize` is 2048, giving 1024 bins about 21 Hz wide. At 512 the
bins were ~86 Hz and 26 of the 64 bars — the whole bass and low-mid region —
shared a single bin, so that half of the display was interpolation rather than
measurement. Bars still narrower than one bin interpolate between neighbours.

**Auto-gain.** A fixed dB window ties the display to how hard the track was
mastered: quiet mixes never leave the floor, loud ones sit pinned at the top.
`analyse()` tracks a reference peak that rises instantly and falls slowly, and
normalises against it, so every track uses the full height. Rising instantly is
the point — a gain that lags the first hit clips the transient the display
exists to show. The reference resets on track change.

**Smoothing.** The analyser's own `smoothingTimeConstant` is 0.5, not 0.78.
Anything higher stacks the analyser's temporal averaging on top of the
per-bar attack/release envelope, smearing every transient twice; the result
reads as lag. The envelope has a genuinely fast attack and does the shaping.

**Beat detection** reads 30–150 Hz, derived from the sample rate rather than
hardcoded bin indices — at the old `fftSize`, bins 1–8 meant 86–690 Hz, which
is vocals and guitar, not kick drum. The test is relative to a running mean
apart from a small floor, so a quietly-mastered track still registers hits.

## Controls

<kbd>Space</kbd> play/pause · <kbd>V</kbd> cycle visuals · <kbd>F</kbd> full screen

Buttons drop focus after a mouse click (but not a keyboard one), so
<kbd>Space</kbd> always means play/pause rather than re-triggering the last
button pressed.
