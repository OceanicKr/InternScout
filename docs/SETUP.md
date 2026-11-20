# InternScout — setup and usage

A desktop control center plus an n8n automation pipeline that scouts **remote internships**, scores them against your real skills with the ChatGPT API, tailors your resume per role, and helps you assemble and track applications.

Built to run on **Windows 11**. The app is Electron, so it runs natively as a `.exe`.

```
┌─────────────────────┐        GET /api/profile        ┌──────────────────────────┐
│  InternScout app    │ ◀───────────────────────────── │  n8n workflow 1 (scout)  │
│  (Electron desktop) │ ──── POST /api/jobs (matches) ▶ │  every 6h → ChatGPT score│
│                     │                                 └──────────────────────────┘
│  • Profile + resume │        POST /webhook/tailor-resume      ┌──────────────────┐
│  • Match feed       │ ─────────────────────────────────────▶ │  workflow 2      │
│  • Resume tailoring │ ◀───────────────────────────────────── │  resume tailor   │
│  • Application build │       POST /webhook/submit-application  ┌──────────────────┐
│  • Submission tracker│ ─────────────────────────────────────▶ │  workflow 3      │
└─────────────────────┘ ◀───────────────────────────────────── │  application build│
                                                                 └──────────────────┘
```

The app hosts a tiny local API on **port 4823**. n8n reads your profile from it and pushes scored matches back to it — that is the "updates in a custom app" link. The app calls the n8n webhooks for tailoring and application building, so you never touch n8n's UI day to day.

---

## 1. Run the desktop app (Windows 11)

Install [Node.js LTS for Windows](https://nodejs.org) first. Then in **PowerShell** or **Command Prompt**:

```powershell
cd app
npm install
npm start
```

The first time the app binds port 4823, **Windows Defender Firewall** may pop up — click **Allow access** (Private networks is enough; it only listens on localhost).

Before the first launch, copy `app/seed-profile.example.json` to `app/seed-profile.json` and fill in your own details and plain-text resume (this file is git-ignored). Without it, the app seeds from the placeholder template. Either way, open **Profile & resume**, check it, edit anything, **Save**.

### Build a real installer (`.exe`)

```powershell
npm run dist
```

This produces, in `app\dist\`:
- `InternScout Setup 1.0.0.exe` — a normal Windows installer (creates Start-menu + desktop shortcuts, lets you pick the install folder)
- `InternScout 1.0.0.exe` — a portable single-file build that runs without installing

> Build it on the Windows 11 machine itself. electron-builder downloads the Windows runtime on first build, so the machine needs internet access that one time. The app is unsigned, so SmartScreen may show "Windows protected your PC" — click **More info → Run anyway** (or sign it with your own code-signing cert if you have one).

## 2. Set up n8n

Easiest on Windows is **npx** (needs the Node.js you already installed):

```powershell
npx n8n
```

n8n opens at `http://localhost:5678`. Leave that terminal running.

Or with **Docker Desktop for Windows**:

```powershell
docker run -it --rm --name n8n -p 5678:5678 -v ${HOME}\.n8n:/home/node/.n8n docker.n8n.io/n8nio/n8n
```

> If you run n8n in Docker, it reaches the app at `http://host.docker.internal:4823`, not `localhost`. Import `n8n/1-internship-scout-docker.json` instead of `1-internship-scout.json`; it is identical except that both URLs already point at `host.docker.internal`.

Then in n8n:

1. ****Credentials → Add credential → OpenAI API**** and paste your ChatGPT API key. All three workflows reference this one credential.
2. **Import** each file from `n8n/` (Workflows → ⋯ → Import from File):
   - `1-internship-scout.json`
   - `2-resume-tailor.json`
   - `3-application-builder.json`
3. Open each workflow, confirm the OpenAI nodes show your credential, and toggle **Active** (top right). Webhooks only fire when a workflow is Active.

In the app's **Settings**, set the n8n base URL (default `http://localhost:5678`) and hit **Test n8n connection**.

## 3. Use it

- **Scouted** fills automatically every 6 hours (or run workflow 1 manually once to seed it). Each card shows a 0–100 match score, your matching skills, and any red flags (fake-remote, location-locked, unpaid, etc.).
- Click a card → **Tailor my resume for this role**. Workflow 2 first analyzes what the hiring team screens for, then rewrites your resume to lead with your most relevant *real* experience and mirror the posting's language.
- In the same drawer, add the application's questions, draft rough notes, and **Polish answers with ChatGPT**. Export the resume/cover letter as `.txt`, open the posting, paste, and **Mark as submitted**.

---

## What "thorough" means here, and the one hard rule

Each job goes through a dedicated ChatGPT call that weighs location/timezone eligibility, seniority, whether it's genuinely remote (national **or** international), **company reputation** (estimated from the model's knowledge — shown as a tier badge), and **compensation** (extracted or estimated from the posting). Matches are ranked by a composite score: `0.55 × fit + 0.30 × reputation`, plus 12 points for AI/ML or robotics roles, capped at 100.

### Where it looks
- **Aggregator boards:** Remotive, Jobicy, Arbeitnow, RemoteOK, The Muse — all remote-first.
- **Adzuna** (recommended for India): add a free App ID + Key in Settings (button links to developer.adzuna.com). Countries default to `in,gb,us`, so Indian and international salary-bearing listings flow into the feed automatically every run — this is the unattended, ToS-clean way to cover the big Indian market.
- **Company career pages (the reputable roles):** add a watchlist in Settings and the scout reads those companies' **official** job feeds directly. Format is `system:token`, one per line:
  - `greenhouse:stripe` — token is the slug in `boards.greenhouse.io/<token>`
  - `lever:netflix` — token is the slug in `jobs.lever.co/<token>`
  - `ashby:ramp` — token is the slug in `jobs.ashbyhq.com/<token>`
- **One-click site search (Internshala, Naukri, LinkedIn, Wellfound, Indeed):** the search bar on the Scouted screen and the buttons on each match open these sites' **real, remote-filtered search** in your browser. These sites gate and fight unattended bots, so scraping them risks your IP and account (Naukri especially — it's your recruiter-facing account). The one-click search keeps you a real logged-in user: same speed benefit, zero ban risk.

### Applying — autofill with options
Open a match → **Generate answer options**. ChatGPT reads the live posting and either answers the exact questions you pasted or predicts the 5–6 most likely ones. For each question you get **3–4 answers from different angles** (project-led, skills-led, motivation/fit, concise). Pick one, edit it freely, then **Copy all answers** into the portal. Tailor the resume and cover letter in the same drawer first for best results.

**The one hard rule:** every prompt that touches your resume or answers is instructed to **never invent** skills, tools, employers, achievements, or credentials — only to surface and sharpen what's already true in your profile. Reputation and salary are labelled **estimates**; verify them on the posting before relying on them. Submission stays manual: the app assembles everything, you click submit on the real portal. That keeps applications truthful and your accounts safe.

You supply and pay for your own OpenAI API key; `gpt-4o-mini` is the default. Switch the `MODEL` constant in any workflow's first Code node to `gpt-4o` for deeper analysis.
