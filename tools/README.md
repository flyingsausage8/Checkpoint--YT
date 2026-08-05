# Browser tools

Scripts for running the real extension in a real Chrome and watching what it
does. They need no packages — Node 18 or newer already has everything.

Caption extraction depends on YouTube's page, which changes without warning, so
assume it will break again. These tools exist so that finding out takes a
minute instead of an afternoon.

## Running the extension against a video

```
node tools/launch-chrome.js              # start a test browser
node tools/reload-extension.js           # install this folder into it
node tools/run-video.js dQw4w9WgXcQ      # watch a video run
```

Re-run `reload-extension.js` after **every** code change. Chrome keeps the old
files until you do, so without it you will be testing the previous version and
wondering why nothing changed.

`run-video.js` prints each log line with the number of seconds since the page
loaded:

```
+  7.0s [log] [FocusFlow] STEP 1/5 Transcript acquired {source: panel, cues: 311, ...}
+  7.1s [log] [FocusFlow] STEP 2/5 API request sent to Azure {window: 1/1, ...}
+ 24.3s [log] [FocusFlow] STEP 5/5 Questions loaded {mode: AI sections, checkpoints: 3, ...}
```

Those timings matter. Output that is correct but arrives thirty seconds late
looks broken to someone watching a video, and that has been the real fault more
than once.

## When a video misbehaves

Clear its cache first. A failed run used to be remembered, and a stale
transcript will happily hide the change you just made:

```
node tools/clear-cache.js vnqKeByO97o
```

Then check whether the transcript actually covers the whole video, rather than
trusting the cue count:

```
node tools/inspect-transcript.js vnqKeByO97o
```

A healthy result reaches close to the video's length and has no suspicious
gaps. If `lastStart` stops near the middle, captions were truncated even though
nothing reported an error.

## Things worth knowing

Chrome 150 removed `--load-extension`, and the feature flag that supposedly
restores it does not. `Extensions.loadUnpacked` over the DevTools Protocol is
what still works, which is why `reload-extension.js` exists at all.

The test browser uses its own profile in your temp directory, so it starts
signed out. YouTube sometimes behaves differently there than in your everyday
browser — if something reproduces for you but not here, that difference is the
first thing to suspect.

The extension's service worker is usually asleep and simply will not appear as
a debugger target. That is normal, not a failure.

Settings that change behaviour:

| Variable | Purpose |
| --- | --- |
| `CHROME_PATH` | Chrome executable, if it is not in the usual place |
| `FOCUSFLOW_CDP` | Debugging endpoint (default `http://127.0.0.1:9222`) |
| `FOCUSFLOW_PROFILE` | Where the test profile lives |
| `FOCUSFLOW_EXT_ID` | Extension id, if you ever repack with a different key |
