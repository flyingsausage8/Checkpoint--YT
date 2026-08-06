# Checkpoint--YT

Chrome extension that breaks YouTube videos into short sections with a quick check-in question after each one — built to help people with ADHD (or anyone) actually finish what they start watching.

Built by Yihan Sun.

The extension ships under the display name **FocusFlow**; this repository is `Checkpoint--YT`.

FocusFlow is a Chrome extension for people who drift off during long YouTube videos. It splits a video into short chunks, pauses at each checkpoint, and asks a quick multiple-choice or true/false question about the section you just watched.

This build is Phase 1 + Phase 2 only: chunking, pausing, captions, overlays, and offline questions. No proxy, API key, Azure account, or non-YouTube network setup is required.

## Try it in 3 minutes

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `focusflow` folder.
4. Open any normal YouTube video longer than 4 minutes.
5. Click the FocusFlow extension icon.
6. Click **Test checkpoint now** to show the overlay immediately.
7. Click **View transcript** to open the transcript page, or **Show position on video** to see your current section in a toast.

Defaults are testing-friendly: checkpoints every 3 minutes, and videos shorter than 4 minutes are skipped. You can raise those later in the popup.

After editing files, return to `chrome://extensions` and click the reload button on FocusFlow.

## How to tell if captions are working

Open the FocusFlow popup while on a YouTube watch page. The **Current video status** box shows:

- **Video ID**: the detected YouTube id.
- **Length**: detected video duration.
- **Checkpoints**: how many pauses FocusFlow will create.
- **Captions**:
  - `timedtext` means FocusFlow found YouTube's caption track directly. This is the best path.
  - `panel` means it used YouTube's visible transcript panel as a fallback.
  - `none` means no captions were found, so FocusFlow uses hardcoded self-check questions.
- **Cues**: how many transcript snippets were extracted.

## What to try breaking

- A video with captions.
- A video without captions.
- Navigating between videos without reloading the page.
- Fullscreen mode.
- Seeking backwards after answering a checkpoint.
- A very short video under 4 minutes.
- A live stream or Short.


## Transcript and playback position tools

The popup has three testing buttons:

- **Test checkpoint now** opens the checkpoint overlay immediately.
- **View transcript** opens a full-page transcript viewer. Timestamp buttons jump the YouTube tab to that moment, the search box filters text, and checkpoint dividers show which transcript section feeds each question.
- **Show position on video** displays the current time, section, and next checkpoint directly over the video, useful in fullscreen.

The popup also includes a live **Where you are** readout with current time, percent, play/pause state, and checkpoint tick marks.

FocusFlow uses the Chrome `tabs` permission so the popup and transcript page can find the current YouTube tab, open the transcript page, and send seek/progress messages to the original tab. It still only has host permission for YouTube in this AI-free build.

## File map

- `manifest.json` tells Chrome which scripts to load, where the popup lives, permissions, and icons.
- `src/content/mainWorld.js` runs in YouTube's page world and discovers caption track URLs.
- `src/content/captions.js` fetches or reads transcript text.
- `src/content/questionBank.js` contains hardcoded ADHD-friendly fallback questions.
- `src/content/questions.js` builds local transcript-derived questions and falls back to the bank.
- `src/content/validate.js` validates question objects before they reach the overlay.
- `src/content/ai.js` is dormant support for a future proxy-backed AI mode.
- `src/content/overlay.js` builds the checkpoint card shown over the video.
- `src/content/overlay.css` styles the checkpoint card and toast.
- `src/content/markers.js` draws your checkpoints as dots on YouTube's own progress bar.
- `src/content/panel.js` and `src/content/panel.css` are the in-page panel at the top of the recommendations column: live progress plus every setting, including focus mode.
- `src/content/focus.js` and `src/content/focus.css` are focus mode — hiding the distracting parts of YouTube.
- `src/content/content.js` coordinates video detection, checkpoints, captions, storage status, transcript/progress messages, and popup test messages.
- `src/popup/popup.html` is the settings, status, transcript, and playback-position popup.
- `src/popup/popup.js` saves settings, shows status/progress, opens the transcript page, and sends **Test checkpoint now** messages.
- `src/transcript/transcript.html` and `src/transcript/transcript.js` show the full transcript, search, copy/download, and timestamp seeking.
- `src/shared/format.js` formats playback times for extension pages.
- `src/shared/settings.js` is the one definition of a settings object and where it is stored, shared by the panel and focus mode.
- `icons/` contains the extension icons.
- `backend/` contains the optional Azure Functions backend for later AI questions.

## Focus mode

Focus mode hides the parts of YouTube that pull you away from the video you chose. It is on by default and is controlled from the FocusFlow panel beside any video.

There are three levels:

- **On** (the default) hides the home page video wall, the recommended videos beside the player, the comments, and Shorts.
- **Complete focus** also hides the suggestions at the end of a video, live chat, and the menu down the left side.
- **Customize focus** turns the list into individual switches so you can pick exactly what disappears. While it is on, complete focus is disabled, because the per-item switches are then in charge.

Turning focus mode off puts YouTube back exactly as it was.

Everything is hidden with CSS rules keyed on `ff-hide-<part>` classes that `focus.js` puts on `<html>`. No YouTube elements are ever removed or edited, so switching focus mode off is a complete undo, and a broken selector can only ever fail to hide something — it can never break the page. The hiding rules are injected at `document_start`, so distractions are never painted in the first place.

Adding a new part means editing `FOCUS_PARTS` in `src/shared/settings.js`, adding a rule to `src/content/focus.css`, and adding the id to the two lists that guard syncing: `FOCUS_PART_IDS` in `src/background/sync.js` and in `backend/src/functions/sync.js`. Miss either of those and the setting works on one computer but silently refuses to travel to another.

## How captions work

FocusFlow tries two caption strategies because YouTube does not provide a stable public transcript API for extensions.

First, it asks YouTube for the timed caption track URL and fetches the transcript directly. This is fast and invisible.

If that fails, it tries to open YouTube's own transcript panel and read the visible transcript rows from the page. This is slower, but it can keep working when direct caption URLs are unavailable.

If neither strategy finds captions, FocusFlow still shows useful hardcoded check-in questions.

## Known limitations

- Videos without captions cannot produce specific transcript-based questions.
- YouTube may change its page structure or internal events.
- Live streams and Shorts are unsupported.
- Ads may interfere with timing or playback state.

## Later: turning on AI

AI is not required and is not active in this build. The extension defaults `useAI` to off, Azure host permission is not present, and FocusFlow works with offline questions immediately.

When you are ready, `backend/` contains a simple Azure Functions proxy that keeps the Azure OpenAI key out of the extension. The architecture is:

**FocusFlow extension -> your Azure Function -> Azure OpenAI**

The backend keeps these defences in one place:

- Chrome extension origin allowlist with CORS.
- Request body and transcript size caps.
- Strict inbound request schema validation.
- Per-IP rate limiting with Azure Table Storage via the Function App's existing storage account.
- Server-side deployment and token limits.
- Prompt-injection hardening around transcript text.
- Server-side and extension-side output validation.
- Privacy-safe logs that never include transcript content.
- Azure OpenAI secrets loaded only from Function App settings.
- GPT-5-compatible request settings: `max_completion_tokens`, no temperature/sampling parameters, and JSON response format.

Before enabling AI, add `https://*.azurewebsites.net/*` to `manifest.json` host permissions, deploy the Azure Function, set the Azure OpenAI app settings, allowlist your extension id, and paste `https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate` into the popup. The current Azure OpenAI resource is `aoai-checkpoint-yt-pb5kh8`, endpoint `https://aoai-checkpoint-yt-pb5kh8.openai.azure.com/`, deployment `questions`, model `gpt-5-mini` version `2025-08-07`. See `backend/README.md` for the full guide.

Set a budget alert or spending cap in Azure Cost Management before enabling AI. Code-level rate limits help, but a billing cap is the final protection against surprise costs.

