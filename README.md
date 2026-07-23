# Jasper's 40th — Live Quiz

A private, session-based real-time quiz app: host control, team phones, Jasper's
phone, and a public projector view, all kept in sync over WebSockets.

## What's working (tested end-to-end)

- Room code + host secret, no accounts
- Team join, Jasper join (one claim per session), projector join
- Role-specific question content — the server only ever sends each client
  the content it's allowed to see (Jasper never gets team options, teams
  never see Jasper's wording, projector gets neither) — enforced server-side,
  not just hidden in the UI
- Staged hints (Hint 1 / Hint 2) with decaying point value
- Single-choice, numeric-with-tolerance, and free-text auto-marking on lock
- Multi-part / matching / ordering / image-ID questions fall through to
  **manual marking** in the host dashboard (auto-marking logic isn't written
  for those types yet — see Known Gaps)
- Jasper punitive scoring incl. "correct = no loss" and max-loss caps, all
  configurable per question
- Score ledger: every point change is logged with a reason; host can
  manually adjust any participant's score and undo any ledger entry
  (undo = compensating entry, never a silent edit)
- Per-question exclusion (e.g. "Ben is out for this one") with a lockout
  screen on the excluded device
- Phone a Friend token issuance (basic — see Known Gaps)
- Reconnect after refresh/signal loss: identity and current question state
  restore from a token in `localStorage`
- Pause/resume broadcast to all screens

Ran a full simulated rehearsal (`test/smoke.js`) covering join, role
isolation, hint release, submission, lock+auto-mark, reveal, manual
adjust+undo, exclusion, and reconnect — all passed.

## Known gaps — be aware before the night

- **Matching pairs / drag-and-drop ordering / image identification** have no
  dedicated input UI yet — they'll currently render as a free-text box and
  need manual marking. Fine functionally, less slick than a proper drag UI.
  If you want these, tell me which questions use them and I'll build the
  specific input widget.
- **Phone a Friend "lowest team gets one extra next round"** is not
  automated — you issue tokens manually from the host dashboard, which
  covers the base rule but you'll need to decide the bonus token yourself
  rather than have the app calculate "lowest team."
- **Photo/image display** — `assets` is in the schema but there's no upload
  UI yet. For now, images need a URL you paste into `public_display.media`
  by hand-editing the content JSON, or I can add an upload flow if useful.
- **No export-results button yet** — the data's all in the SQLite file
  (`data/quiz.db`), so nothing is lost, but there's no one-click CSV export.
- Host dashboard is functional but plain — no drag-reordering of the
  question list, you click questions in sequence.

None of these block the acceptance test in your brief; they're the things
I'd prioritise next if you want polish before the 13th.

## Adding your real questions

Edit `content/session.example.json` (or copy it to `content/session.json`)
— it's the same shape as the schema in your brief. Each question needs
`public_display`, `team_view`, `jasper_view`, `answer_key`, and `scoring`.
Input types currently auto-marked: `single_choice`, `numeric`, `free_text`.
Anything else (`multi_part`, `matching`, `ordering`, `image_id`) will queue
for manual marking automatically.

Then re-seed:

```bash
node server/seed.js content/session.json
```

This prints a fresh **room code** (give to players) and **host secret**
(keep private — this is your `/host?secret=...` URL). Re-seeding creates a
brand new session; it doesn't overwrite the old one, so you can seed a
rehearsal session and a real one separately.

## Running locally (for rehearsal)

```bash
npm install
node server/seed.js
npm start
```

Then on the same wifi network:
- Host: `http://<your-laptop-ip>:3000/host?secret=<from seed output>`
- Team: `http://<your-laptop-ip>:3000/team`
- Jasper: `http://<your-laptop-ip>:3000/jasper`
- Projector: `http://<your-laptop-ip>:3000/projector`

Find your laptop's local IP with `ipconfig` (Windows) or `ifconfig`/`ip a`
(Mac/Linux). Phones must be on the same network to reach it this way.

## Deploying for the actual event (Render, free tier)

Running it locally on your laptop works but ties the whole quiz to your
laptop's wifi and battery. Deploying is more robust:

1. Push this folder to a GitHub repo (private is fine).
2. On [render.com](https://render.com), New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Render gives you a persistent URL — use that instead of `localhost` in
   all the links above.
5. **Important:** Render's free tier SQLite storage is ephemeral on
   redeploy — don't redeploy mid-event. Seed once before the event, verify,
   and leave it alone on the day.
6. Run `node server/seed.js` locally against the same repo *before* pushing
   if you want the session baked in, or SSH/run a one-off job on Render to
   seed remotely — happy to walk through whichever you prefer.

## Low-tech fallback (paper pack)

If the app or venue wifi fails entirely, the quiz can run from paper. Generate
the pack straight from your content file so it's never out of sync with
what's actually configured:

```bash
node print/generate-printouts.js content/session.json print/output
```

This writes three Word documents to `print/output/`:

- **Host_Master_Pack.docx** — the whole quiz on paper: for every question,
  the read-aloud public wording, team wording + options, Jasper wording,
  both scripted hints, the answer key, the reveal line, and the exact
  scoring (team value at each hint stage, Jasper correct/incorrect/max-loss).
  Ends with a **manual scoring tally grid** — blank rows for team names plus
  a Jasper row, one column per question, so you can score entirely by hand
  with a pen if needed. A quick-reference block at the end reminds you of
  each question's point values without flipping back through the pack.
- **Team_Answer_Sheet.docx** — one generic template with a blank team-name
  line and a numbered answer box per question (with options printed where
  relevant so they can circle rather than write). Photocopy one per team
  before the event.
- **Jasper_Answer_Sheet.docx** — same idea, Jasper's wording, no options
  where the brief calls for none.

Regenerate any time you edit the questions — it always reflects the current
content file, so the paper pack and the live app can never drift apart.
I'd print these regardless of how confident you are in the tech; a "wifi
just died" moment shouldn't mean stopping the quiz.

## Day-of runbook

- Seed the real session the morning of, not the night before, so the host
  secret is fresh in your notes.
- Open `/host` on your phone first, confirm rounds show up, do one test
  question end-to-end with your own two phones before guests arrive.
- Bring your hotspot as the backup you mentioned — worth testing the
  handoff (switch host phone from venue wifi to hotspot) once beforehand,
  since reconnect works but a mid-quiz network switch is still a live
  moment, not a non-event.
- Projector device just needs the room code typed once; it reconnects on
  its own after that.
- **Print the paper pack (see below) even if you're confident in the tech.**
  Bring it on the day regardless — it costs nothing and it's the difference
  between a five-minute hiccup and stopping the quiz.
