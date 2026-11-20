# InternScout

An Electron desktop app and three n8n workflows that find remote internships, score each one against your profile with an LLM, tailor your resume per role, and draft application answers. You review everything and submit it yourself.

```
                    ┌──────────────────────── n8n ─────────────────────────┐
                    │                                                      │
 ┌──────────────┐   │  ① Scout (every 6 h)                                 │
 │  InternScout │◀──┼── GET /api/profile, /api/config                      │
 │  desktop app │   │   → 8+ job sources → internship filter → dedupe      │
 │  (Electron)  │   │   → gpt-4o-mini scores each posting (JSON)           │
 │              │◀──┼── POST /api/jobs  (one call per match)               │
 │  local API   │   │                                                      │
 │  :4823       │───┼─▶ POST /webhook/tailor-resume        ② Tailor        │
 │              │◀──┼── tailored resume + cover letter + change log        │
 │  JSON store  │───┼─▶ POST /webhook/submit-application   ③ Applications  │
 │  (userData)  │◀──┼── 3–4 answer options per question                    │
 └──────────────┘   └──────────────────────────────────────────────────────┘
```

## What it does

| Stage | What happens | Where |
|---|---|---|
| **Scout** | Every 6 hours, pulls postings from Remotive, Jobicy, Arbeitnow, RemoteOK, The Muse, WeWorkRemotely (RSS), Adzuna (optional, multi-country) and any company career boards you list (Greenhouse, Lever, Ashby, Workable). Keeps only real internships, removes duplicates, and sends up to 70 per run to the LLM for scoring. | `n8n/1-internship-scout.json` |
| **Score** | One LLM call per posting returns structured JSON: is it a remote internship, paid, open to international applicants, AI/robotics, fit score, company reputation, compensation, matching skills, gaps, red flags. Postings that fail your filters are dropped; the rest are ranked and pushed to the app. | same workflow |
| **Tailor** | Two LLM calls: first works out what the hiring team screens for, then rewrites your resume and drafts a cover letter around your most relevant real experience. Returns a list of every change and an honesty check. | `n8n/2-resume-tailor.json` |
| **Apply** | Reads the live posting, then gives 3–4 answers per application question from different angles (project-led, skills-led, motivation/fit, concise). If you paste no questions, it predicts the 5–6 most likely ones. | `n8n/3-application-builder.json` |
| **Track** | Pipeline board in the app: Scouted → Tailored → Submitted → Dismissed, with desktop notifications for new matches. | `app/` |

Two design rules hold throughout:

- **Nothing is invented.** Every prompt that touches your resume or answers may only reorder, reword and emphasise what is already in your profile. Your base resume is never overwritten; each tailored version is stored separately per job.
- **Submission stays manual.** The app prepares the package; you submit on the real portal. LinkedIn, Internshala, Naukri, Wellfound and Indeed are reached through one-click searches in your own browser instead of scraping, which avoids bot detection and account bans.

## How it is built

The app and n8n talk to each other in both directions over HTTP on your machine:

- **n8n → app:** the Electron main process runs an Express server on port **4823**. The scout workflow reads your profile and settings from it and posts each scored match back to it.
- **app → n8n:** the app calls n8n's webhooks for tailoring and application building. These calls go through the Electron main process over IPC, not from the page itself, so there are no CORS issues and one 240 s timeout applies to all of them.

Everything the app knows (profile, settings, every job with its analysis, tailored resume and application drafts) lives in one JSON file in Electron's `userData` directory. When the scout re-sends a job you already have, only its analysis is refreshed; your progress on that job is kept.

Full details (node-by-node workflow breakdown, scoring formula, API reference, data model) are in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Repository layout

```
app/                         Electron desktop app
  main.js                    main process: local API, JSON store, IPC handlers, n8n proxy
  preload.js                 contextBridge API exposed to the renderer as window.scout
  renderer/                  UI (index.html, app.js, styles.css), no framework
  seed-profile.example.json  placeholder profile; copy to seed-profile.json (git-ignored)
  build/                     app icons
n8n/
  1-internship-scout.json         scheduled scout + scorer (n8n run with npx)
  1-internship-scout-docker.json  same, with URLs for n8n running in Docker
  2-resume-tailor.json            webhook: tailor-resume
  3-application-builder.json      webhook: submit-application
docs/
  ARCHITECTURE.md            how each part works
  SETUP.md                   install, run, build the Windows installer, daily use
```

## Quick start

Requirements: Node.js LTS, an OpenAI API key, and n8n (`npx n8n` or Docker).

```powershell
cd app
copy seed-profile.example.json seed-profile.json   # then fill in your details
npm install
npm start
```

```powershell
npx n8n          # in a second terminal; opens http://localhost:5678
```

In n8n: add an **OpenAI API** credential, import the three workflows from `n8n/`, select the credential on each OpenAI request node, and set each workflow to **Active**. In the app, open **Settings** and click **Test n8n connection**.

To build a Windows installer: `npm run dist` (produces an NSIS installer and a portable `.exe` in `app/dist/`).

See **[docs/SETUP.md](docs/SETUP.md)** for the full walkthrough, Docker networking, and Windows Firewall/SmartScreen prompts.

## Known limitations

- **Missing information is sometimes treated as "no".** The scoring prompt asks for `null` when a posting doesn't mention pay or international eligibility, but `gpt-4o-mini` sometimes returns an explicit `false`. With "require paid" or "require global" switched on, those postings get dropped even though they might qualify. Fix options: treat `false` as unknown unless the posting gives evidence, or ask for a quoted span from the posting as justification.
- **Reputation and salary are model estimates** and are labelled as such in the UI. Check them on the posting.
- **The internship filter only checks the job title.** It catches "intern", "co-op", "working student" and similar, and drops titles with "senior", "manager", "full-time" etc. Roles with unusual titles can be missed; postings from companies on your watchlist skip this filter.

## Tech

Electron 42 · Express 4 · vanilla JS/HTML/CSS · n8n (Code, HTTP Request, Webhook nodes) · OpenAI Chat Completions with JSON-mode output (`gpt-4o-mini` default; change the `MODEL` constant in each workflow's first Code node)

## License

Apache License 2.0, see [LICENSE](LICENSE).
