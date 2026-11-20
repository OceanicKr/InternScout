# Architecture

InternScout has two halves that run on the same machine:

1. **The desktop app** (`app/`): an Electron app that stores your profile and jobs, shows the UI, and runs a small HTTP API for n8n.
2. **The pipeline** (`n8n/`): three n8n workflows that do the fetching and the LLM work.

Splitting it this way keeps the slow, network-heavy and LLM work in n8n, where each step can be inspected, re-run and edited visually. The app stays a thin UI with storage.

---

## 1. Desktop app

### Processes

| File | Role |
|---|---|
| `main.js` | Electron main process. Loads and saves the JSON store, runs the Express API on port 4823, registers IPC handlers, forwards webhook calls to n8n, shows desktop notifications. |
| `preload.js` | Exposes a narrow API to the page as `window.scout` via `contextBridge`. The page runs with `contextIsolation: true` and `nodeIntegration: false`, so it has no direct Node access. |
| `renderer/app.js` | All UI logic: pipeline board, job drawer, profile and settings forms, calls to n8n through `window.scout.callN8n`. |

### Storage

A single file, `internscout-data.json`, in Electron's `userData` directory:

```jsonc
{
  "profile":  { "name", "email", "location", "education", "skills", "interests", "links", "resume" },
  "settings": {
    "n8nBase": "http://localhost:5678",
    "minScore": 50,
    "requirePaid": true,
    "requireGlobal": true,
    "interestKeywords": "AI, ML, ...",
    "watchedCompanies": "greenhouse:stripe\nlever:netflix",
    "adzunaAppId": "", "adzunaAppKey": "",
    "adzunaCountries": "in,gb,us,au,ca,sg,de,nl"
  },
  "jobs": [ {
    "id": "remotive-12345",          // source-prefixed, stable across runs
    "title", "company", "url", "location", "tags", "salary", "posted", "description", "source",
    "analysis":    { /* LLM scoring output, see §2.1 */ },
    "composite":   87,
    "status":      "new | tailored | submitted | dismissed",
    "tailored":    { "tailored_resume", "cover_letter", "changes_made", "honesty_check", "tailoredAt" },
    "application": { "questions": [ { "question", "predicted", "options": [ { "angle", "text" } ], "selected", "answer" } ],
                     "checklist", "email_subject", "email_body" }
  } ]
}
```

On first run, if no data file exists, the profile is seeded from `seed-profile.json` (your own, git-ignored) or, if that is missing, from `seed-profile.example.json`.

### Local API (port 4823)

| Method | Path | Used by | Purpose |
|---|---|---|---|
| GET | `/api/health` | anything | liveness check |
| GET | `/api/profile` | scout workflow | current profile |
| GET | `/api/config` | scout workflow | filters, interest keywords, watched companies (parsed into a list), Adzuna keys and countries |
| POST | `/api/jobs` | scout workflow | upsert one scored job. A new job is added at the top of the list with `status: "new"` and triggers a desktop notification. For an existing `id`, only `analysis` and `description` are refreshed, so the job's status, tailored resume and drafts are kept. |

The server binds to `0.0.0.0` so that n8n running in Docker can reach it through `host.docker.internal`. Windows Firewall blocks access from other machines.

### IPC (renderer ↔ main)

`state:get`, `profile:save`, `settings:save`, `job:update`, `job:delete`, `open:url` (http/https only), `export:text` (save dialog), and `n8n:call`.

`n8n:call` takes `{ webhookPath, payload }`, POSTs to `<n8nBase>/webhook/<webhookPath>`, and returns `{ ok, data | error }`. Routing these calls through the main process avoids browser CORS rules and applies a single 240 s timeout to every n8n call.

---

## 2. n8n workflows

All LLM calls are plain **HTTP Request** nodes to `https://api.openai.com/v1/chat/completions`, authenticated with one shared n8n **OpenAI API** credential. They use `response_format: json_object`, and every response is parsed defensively: code fences are stripped, and a fallback object is used if JSON parsing fails, so one bad response can't break a run.

### 2.1 Workflow 1: Internship Scout

```
Every 6 hours → Scout & normalize jobs → Has jobs? → Score with ChatGPT → Parse & keep matches → Is a match? → Deliver to desktop app
```

**Scout & normalize jobs** (Code node, the core of the pipeline):

1. Fetches `/api/profile` and `/api/config` from the app. Fails with a clear error if the app isn't running or the profile has no skills.
2. Pulls postings from each source, each wrapped in its own `try/catch`, so one failing source doesn't stop the run:
   - **No key needed:** Remotive (`search=intern`), Jobicy (`tag=intern`), Arbeitnow (remote only), RemoteOK, The Muse (`level=Internship`, remote/flexible only), WeWorkRemotely RSS (parsed by hand).
   - **Adzuna** (if keys are set): `what=internship` for each configured country, including salary ranges.
   - **Watched companies** from their official job-board APIs: `greenhouse:<slug>`, `lever:<slug>`, `ashby:<slug>`, `workable:<slug>`.
3. Converts every posting to one common shape `{id, title, company, url, location, tags, salary, posted, description, source}`. The ID is prefixed with the source (`remotive-…`, `gh-<slug>-…`) and HTML is stripped from descriptions, which are cut to 4,500 characters.
4. **Internship filter, applied to the title:** the title must match `intern|internship|co-op|summer analyst|working student|werkstudent|industrial placement|placement year|summer program`, and must not match `full-time|graduate program|senior|lead|staff|principal|director|head of|manager`. Postings from watched companies skip the first check but not the second.
5. Removes duplicates by `title|company`, sorts newest first, and keeps at most `MAX_JOBS_PER_RUN = 70`.
6. Builds one chat-completion request per posting: candidate profile, the posting, and a system prompt that sets four hard requirements (remote, genuine internship, paid, open to international applicants), prefers AI/ML and robotics roles, and specifies the output schema:

```json
{ "is_remote_internship": bool, "is_paid": { "paid": true|false|null, "note": str },
  "accepts_international": bool, "is_ai_robotics": bool, "domain": str,
  "score": 0-100, "reputation": { "tier": "top|established|startup|unknown", "score": 0-100, "note": str },
  "compensation": { "stated": bool, "summary": str },
  "fit_summary": str, "matching_skills": [], "gaps": [], "resume_angle": str, "red_flags": [] }
```

**Parse & keep matches** (runs once per posting) drops a posting if any of these is true:

- `is_remote_internship === false`
- `requirePaid` is on and `is_paid.paid === false`
- `requireGlobal` is on and `accepts_international === false`
- `score < minScore`

Every posting that survives gets a ranking score:

```
composite = min(100, round(0.55 × fit + 0.30 × reputation + (is_ai_robotics ? 12 : 0)))
```

**Deliver to desktop app** POSTs each surviving job to `/api/jobs`. The Docker version of the workflow differs only in its two URLs (`host.docker.internal` instead of `localhost`).

### 2.2 Workflow 2: Resume Tailor (`POST /webhook/tailor-resume`)

```
Webhook → Build analysis request → Analyze hiring priorities → Build tailoring request → Tailor with ChatGPT → Package result → Respond
```

- **Pass 1 (analysis, temperature 0.2):** reads only the posting and returns `top_priorities` (ranked), `keywords_for_ats`, `tone`, `what_impresses` and `what_to_avoid`.
- **Pass 2 (rewrite, temperature 0.3):** gets the analysis, the posting, the profile and the base resume. Its system prompt has one hard rule: never fabricate. It may only reorder, reword, quantify figures already stated, and emphasise. It returns `tailored_resume`, a 150–220 word `cover_letter`, `changes_made[]` and `honesty_check`.

Splitting the work this way means the rewrite is aimed at an explicit list of what the hiring team wants, instead of the model guessing priorities and rewriting in the same step. The app sends a deep copy of the profile, and the result is stored on the job, never on `profile.resume`.

### 2.3 Workflow 3: Application Builder (`POST /webhook/submit-application`)

```
Webhook → Build options request → Generate options with ChatGPT → Package application → Respond
```

- Fetches the live posting page (20 s timeout, scripts and styles removed, up to 7,000 characters) and uses it when it is longer than the stored description.
- Input: any questions and rough notes you've added, plus the tailored resume if one exists (otherwise the base resume).
- Output: for each question, 3–4 options written from different angles. If you gave no questions, it predicts the 5–6 most likely ones (marked `predicted: true`). It also returns a submission checklist, an email subject and body, and an honesty check.
- In the app, each question appears as a set of selectable cards. You pick one, edit it, and use "Copy all answers" to paste into the portal.

---

## 3. Request flow examples

**A new match appears**

```
cron (6 h) → n8n fetches the profile and config from the app → fetches sources → filters to ~70 postings
→ 70 × gpt-4o-mini scoring → filters → POST /api/jobs for each match
→ app saves the job, shows a notification, and updates the board over IPC
```

**Tailoring a resume**

```
click "Tailor" → renderer → IPC n8n:call('tailor-resume', {job, profileCopy})
→ main process POSTs to the n8n webhook → analysis call → rewrite call → JSON response
→ renderer saves job.tailored and status = "tailored"
```

---

## 4. Choices made, and why

| Choice | Reason |
|---|---|
| Official APIs, RSS feeds and company job-board APIs only; one-click browser search for LinkedIn, Internshala, Naukri, Wellfound and Indeed | Those sites block automated access, and scraping them risks your IP and account. Opening their search in your own browser keeps you a normal logged-in user. |
| Submission is manual | Keeps applications truthful and avoids automated form submission on sites that ban bots. |
| LLM outputs a fixed JSON schema, and the code decides what to keep | Filtering stays predictable and testable; the model only supplies the per-posting judgments. |
| One LLM call per posting | Keeps context focused, isolates failures to one posting, and lets n8n run the calls item by item. |
| `gpt-4o-mini` by default | About 70 scoring calls every 6 hours stays cheap. Change the `MODEL` constant to `gpt-4o` for more careful analysis. |
| Single JSON file for storage | One user, small data, no database to install, easy to back up. |
