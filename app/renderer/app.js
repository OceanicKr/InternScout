// InternScout renderer
let state = { profile: {}, settings: {}, jobs: [] };
let currentView = 'new';
let openJobId = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VIEW_META = {
  new:       { title: 'Scouted',   sub: 'New matches pushed by the n8n scout, scored against your profile.' },
  tailored:  { title: 'Tailored',  sub: 'Roles with a tailored resume and cover letter, ready to apply.' },
  applied:   { title: 'Submitted', sub: 'Applications you have sent. Keep notes and links here.' },
  dismissed: { title: 'Dismissed', sub: 'Roles you passed on. Restore any of them at any time.' },
  profile:   { title: 'Profile & resume', sub: 'The scout and the tailor read this live. Keep it truthful — every tailored resume is built only from what is here.' },
  settings:  { title: 'Settings',  sub: 'Where to find your n8n instance, and how picky the feed should be.' }
};

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- rendering ----------
function counts() {
  const c = { new: 0, tailored: 0, applied: 0, dismissed: 0 };
  for (const j of state.jobs) c[j.status] = (c[j.status] || 0) + 1;
  return c;
}

function renderCounts() {
  const c = counts();
  for (const k of ['new', 'tailored', 'applied', 'dismissed']) {
    const el = $(`#count-${k}`);
    if (el) el.textContent = c[k] || 0;
  }
}

function spineClass(score) { return score >= 75 ? 'hi' : score >= 60 ? 'mid' : 'lo'; }
function repLabel(tier) {
  return { top: '★ Top-tier', established: 'Established', startup: 'Startup', unknown: 'Unverified' }[tier] || tier;
}

// Builds a pre-filtered search URL for each site. You open these in your own
// logged-in browser — no scraping, no ban risk. Filters target remote internships.
function searchUrl(site, title, company) {
  const kw = String(title || 'intern').replace(/\(.*?\)/g, '').trim();
  const q = encodeURIComponent(kw);
  const qc = encodeURIComponent(`${kw} ${company || ''}`.trim());
  switch (site) {
    case 'linkedin':   return `https://www.linkedin.com/jobs/search/?keywords=${qc}&f_WT=2`;            // f_WT=2 = remote
    case 'internshala':return `https://internshala.com/internships/work-from-home-${slug(kw)}-internships/`;
    case 'naukri':     return `https://www.naukri.com/${slug(kw)}-internship-jobs?wfhType=2`;            // wfhType=2 = remote
    case 'wellfound':  return `https://wellfound.com/role/r/${slug(kw)}`;                                 // r/ = remote roles
    case 'indeed':     return `https://www.indeed.com/jobs?q=${q}+internship&sc=0kf%3Aattr%28DSQF7%29%3B`; // remote filter
    default:           return `https://www.google.com/search?q=${qc}+remote+internship`;
  }
}

function renderJobs() {
  const list = $('#jobList');
  const minScore = Number(state.settings.minScore ?? 0);
  const jobs = state.jobs
    .filter(j => j.status === currentView)
    .filter(j => currentView !== 'new' || (j.analysis?.score ?? 0) >= minScore)
    .sort((a, b) => (b.composite ?? b.analysis?.score ?? 0) - (a.composite ?? a.analysis?.score ?? 0));

  list.innerHTML = jobs.map(j => {
    const score = j.analysis?.score ?? 0;
    const skills = (j.analysis?.matching_skills || []).slice(0, 3);
    const flags = (j.analysis?.red_flags || []).slice(0, 1);
    const rep = j.analysis?.reputation;
    const comp = j.analysis?.compensation;
    const intl = j.analysis?.is_international ?? j.analysis?.accepts_international;
    const paid = j.analysis?.is_paid?.paid;
    const aiml = j.analysis?.is_ai_robotics;
    return `
    <button class="job-card" data-id="${esc(j.id)}">
      <div class="spine ${spineClass(score)}">
        <span class="score">${score}</span>
        <span class="score-cap">MATCH</span>
      </div>
      <div class="job-body">
        <div class="job-top">
          <span class="job-title">${esc(j.title)}</span>
          <span class="job-company">${esc(j.company)}</span>
        </div>
        <div class="job-meta">
          <span>${esc(j.location || 'Remote')}</span>
          <span>${esc(j.source || '')}</span>
          ${intl ? '<span>🌐 international</span>' : ''}
          <span>${j.posted ? esc(String(j.posted).slice(0, 10)) : ''}</span>
        </div>
        ${j.analysis?.fit_summary ? `<p class="job-fit">${esc(j.analysis.fit_summary)}</p>` : ''}
        <div class="chiprow">
          ${aiml ? `<span class="chip ai">AI / Robotics</span>` : ''}
          ${rep?.tier ? `<span class="chip rep rep-${esc(rep.tier)}">${repLabel(rep.tier)}</span>` : ''}
          ${paid === true ? `<span class="chip pay">Paid</span>` : paid === null ? `<span class="chip flag">pay unstated</span>` : ''}
          ${comp?.summary && comp.stated ? `<span class="chip pay">${esc(comp.summary).slice(0, 24)}</span>` : ''}
          ${skills.map(s => `<span class="chip">${esc(s)}</span>`).join('')}
          ${flags.map(f => `<span class="chip flag">${esc(f)}</span>`).join('')}
        </div>
      </div>
    </button>`;
  }).join('');

  $('#jobsEmpty').hidden = jobs.length > 0;
  list.querySelectorAll('.job-card').forEach(card =>
    card.addEventListener('click', () => openDrawer(card.dataset.id)));
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.stage').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#viewTitle').textContent = VIEW_META[view].title;
  $('#viewSub').textContent = VIEW_META[view].sub;
  $('#view-jobs').hidden = !['new', 'tailored', 'applied', 'dismissed'].includes(view);
  $('#view-profile').hidden = view !== 'profile';
  $('#view-settings').hidden = view !== 'settings';
  if (!$('#view-jobs').hidden) renderJobs();
  const gs = $('#globalSearch');
  if (gs) gs.style.display = $('#view-jobs').hidden ? 'none' : 'flex';
  closeDrawer();
}

// ---------- drawer ----------
function jobById(id) { return state.jobs.find(j => j.id === id); }

function openDrawer(id) {
  openJobId = id;
  renderDrawer();
  $('#drawer').hidden = false;
}

function closeDrawer() {
  openJobId = null;
  $('#drawer').hidden = true;
}

function renderDrawer() {
  const j = jobById(openJobId);
  if (!j) return closeDrawer();
  const a = j.analysis || {};
  const t = j.tailored;
  const app = j.application || { questions: [] };

  $('#drawerInner').innerHTML = `
    <button class="close-drawer" id="closeDrawer" aria-label="Close">×</button>
    <span class="status-tag">${esc(VIEW_META[j.status]?.title || j.status)}</span>
    <h3>${esc(j.title)}</h3>
    <p class="sub">${esc(j.company)} · ${esc(j.location || 'Remote')} · via ${esc(j.source || '?')}</p>
    <div class="drawer-actions">
      <button class="btn small" id="openPosting">Open posting</button>
      ${j.status !== 'dismissed'
        ? `<button class="btn small danger" id="dismissJob">Dismiss</button>`
        : `<button class="btn small" id="restoreJob">Restore to Scouted</button>`}
    </div>
    <div class="search-row">
      <span class="search-label">Search this role on:</span>
      <button class="link-btn" data-site="linkedin">LinkedIn</button>
      <button class="link-btn" data-site="internshala">Internshala</button>
      <button class="link-btn" data-site="naukri">Naukri</button>
      <button class="link-btn" data-site="wellfound">Wellfound</button>
      <button class="link-btn" data-site="indeed">Indeed</button>
    </div>

    <div class="drawer-section">
      <h4>Match analysis — ${a.score ?? '?'} / 100</h4>
      <p>${esc(a.fit_summary || 'No analysis available.')}</p>
      ${a.matching_skills?.length ? `<p style="margin-top:8px"><strong>Your matching skills:</strong> ${esc(a.matching_skills.join(', '))}</p>` : ''}
      ${a.gaps?.length ? `<p style="margin-top:6px"><strong>Gaps to be ready for:</strong> ${esc(a.gaps.join(', '))}</p>` : ''}
      ${a.red_flags?.length ? `<p style="margin-top:6px"><strong>Flags:</strong> ${esc(a.red_flags.join(', '))}</p>` : ''}
      ${a.resume_angle ? `<p style="margin-top:6px"><strong>Angle:</strong> ${esc(a.resume_angle)}</p>` : ''}
    </div>

    <div class="drawer-section">
      <h4>Tailored resume</h4>
      ${t ? `
        <textarea id="tailoredResume" rows="14">${esc(t.tailored_resume)}</textarea>
        <div class="drawer-section">
          <h4>Cover letter</h4>
          <textarea id="coverLetter" rows="8">${esc(t.cover_letter)}</textarea>
        </div>
        ${t.changes_made?.length ? `<div class="drawer-section"><h4>What was emphasized</h4><ul>${t.changes_made.map(c => `<li>${esc(c)}</li>`).join('')}</ul>${t.honesty_check ? `<p class="small" style="margin-top:8px;color:var(--muted)">${esc(t.honesty_check)}</p>` : ''}</div>` : ''}
        <div class="drawer-actions">
          <button class="btn small" id="saveTailored">Save edits</button>
          <button class="btn small" id="exportResume">Export resume (.txt)</button>
          <button class="btn small" id="exportCover">Export cover letter (.txt)</button>
          <button class="btn small" id="retailor">Re-tailor</button>
        </div>`
      : `
        <p style="color:var(--muted)">No tailored version yet. This builds a <strong>separate copy</strong> from your base resume and the posting, emphasizing your most relevant real skills — it never edits your original, and is instructed never to invent anything.</p>
        <div class="drawer-actions"><button class="btn primary small" id="tailorBtn">Tailor my resume for this role</button></div>`}
    </div>

    <div class="drawer-section">
      <h4>Application — autofill answers</h4>
      <p style="color:var(--muted)" class="small">Paste the real questions from the application form (one per box), or just hit <strong>Generate</strong> and ChatGPT will predict the likely questions for this role. You get 3–4 answer angles per question — pick one, tweak it, done. Everything is grounded in your resume; nothing is invented.</p>
      <div id="qaList">
        ${(app.questions || []).map((q, i) => qaBlockHtml(q, i)).join('')}
      </div>
      <div class="drawer-actions">
        <button class="btn small" id="addQuestion">+ Add a question</button>
        <button class="btn primary small" id="prepareApp">${(app.questions && app.questions.length) ? 'Regenerate options' : 'Generate answer options'}</button>
        ${(app.questions && app.questions.some(q => q.options?.length)) ? `<button class="btn small" id="copyAll">Copy all answers</button>` : ''}
      </div>
      ${app.checklist?.length ? `<div class="drawer-section"><h4>Pre-submit checklist</h4><ul>${app.checklist.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
      ${app.email_body ? `<div class="drawer-section"><h4>Email application (if the posting accepts email)</h4><p class="small mono" style="margin-bottom:6px">Subject: ${esc(app.email_subject)}</p><textarea rows="8" id="emailBody">${esc(app.email_body)}</textarea></div>` : ''}
      <div class="drawer-actions" style="margin-top:18px">
        ${j.status !== 'applied'
          ? `<button class="btn primary" id="markApplied">Mark as submitted</button>`
          : `<span class="save-note">Submitted ${j.appliedAt ? esc(String(j.appliedAt).slice(0, 10)) : ''}</span>`}
      </div>
    </div>
  `;

  // wire actions
  $('#closeDrawer').onclick = closeDrawer;
  $('#openPosting').onclick = () => window.scout.openUrl(j.url);
  document.querySelectorAll('.link-btn').forEach(btn => btn.onclick = () => {
    window.scout.openUrl(searchUrl(btn.dataset.site, j.title, j.company));
  });
  const dismissBtn = $('#dismissJob');
  if (dismissBtn) dismissBtn.onclick = () => patchJob(j.id, { status: 'dismissed' }, true);
  const restoreBtn = $('#restoreJob');
  if (restoreBtn) restoreBtn.onclick = () => patchJob(j.id, { status: 'new' }, true);

  const tailorBtn = $('#tailorBtn') || $('#retailor');
  if (tailorBtn) tailorBtn.onclick = () => tailorResume(j, tailorBtn);

  if (t) {
    $('#saveTailored').onclick = () => {
      const patch = { tailored: { ...t, tailored_resume: $('#tailoredResume').value, cover_letter: $('#coverLetter').value } };
      patchJob(j.id, patch);
      toast('Edits saved.');
    };
    $('#exportResume').onclick = async () => {
      const f = await window.scout.exportText(`resume-tailored-${slug(j.company)}.txt`, $('#tailoredResume').value);
      if (f) toast('Saved to ' + f);
    };
    $('#exportCover').onclick = async () => {
      const f = await window.scout.exportText(`cover-letter-${slug(j.company)}.txt`, $('#coverLetter').value);
      if (f) toast('Saved to ' + f);
    };
  }

  // pick an answer option -> sets selected + fills the editable final answer
  document.querySelectorAll('.opt-card').forEach(card => card.onclick = () => {
    const qi = Number(card.dataset.q), oi = Number(card.dataset.o);
    const qs = readQuestionsFromDom();
    qs[qi].selected = oi;
    qs[qi].answer = qs[qi].options[oi].text;
    patchJob(j.id, { application: { ...app, questions: qs } });
  });

  $('#addQuestion').onclick = () => {
    const qs = readQuestionsFromDom();
    qs.push({ question: '', answer: '', options: [], selected: 0, predicted: false });
    patchJob(j.id, { application: { ...app, questions: qs } });
  };
  document.querySelectorAll('.qa-remove').forEach(btn => btn.onclick = () => {
    const qs = readQuestionsFromDom();
    qs.splice(Number(btn.dataset.i), 1);
    patchJob(j.id, { application: { ...app, questions: qs } });
  });
  $('#prepareApp').onclick = () => prepareApplication(j);
  const copyAll = $('#copyAll');
  if (copyAll) copyAll.onclick = () => {
    const qs = readQuestionsFromDom();
    const text = qs.filter(q => q.question).map(q => `Q: ${q.question}\nA: ${q.answer || ''}`).join('\n\n');
    navigator.clipboard.writeText(text);
    toast('All answers copied to clipboard.');
  };
  const markBtn = $('#markApplied');
  if (markBtn) markBtn.onclick = () => {
    patchJob(j.id, { application: { ...app, questions: readQuestionsFromDom() }, status: 'applied', appliedAt: new Date().toISOString() }, true);
    toast('Marked as submitted. Good luck!');
  };
}

function qaBlockHtml(q, i) {
  const opts = Array.isArray(q.options) ? q.options : [];
  const sel = Number.isInteger(q.selected) ? q.selected : 0;
  const optsHtml = opts.map((o, oi) => `
    <div class="opt-card ${oi === sel ? 'sel' : ''}" data-q="${i}" data-o="${oi}">
      <div class="opt-angle">${esc(o.angle || ('Option ' + (oi + 1)))}</div>
      <div class="opt-text">${esc(o.text || '')}</div>
    </div>`).join('');
  return `<div class="qa-block">
    <button class="qa-remove" data-i="${i}">remove</button>
    <input class="qa-q" data-i="${i}" placeholder="Paste the application question here…" value="${esc(q.question)}">${q.predicted ? '<span class="q-predicted">predicted</span>' : ''}
    ${opts.length ? `<div class="opts" data-i="${i}">${optsHtml}</div>` : ''}
    <div class="final-answer">
      <label>${opts.length ? 'Your answer (edit the picked option freely)' : 'Your notes / draft (optional — guides the options)'}</label>
      <textarea class="qa-a" data-i="${i}" rows="${opts.length ? 5 : 3}" placeholder="${opts.length ? '' : 'Optional notes to steer the answer…'}">${esc(q.answer || '')}</textarea>
    </div>
  </div>`;
}

function readQuestionsFromDom() {
  const qs = [];
  const job = jobById(openJobId);
  const existing = (job && job.application && job.application.questions) || [];
  document.querySelectorAll('#qaList .qa-block').forEach((block, idx) => {
    const prev = existing[idx] || {};
    qs.push({
      question: block.querySelector('.qa-q').value,
      answer: block.querySelector('.qa-a').value,
      options: prev.options || [],
      selected: Number.isInteger(prev.selected) ? prev.selected : 0,
      predicted: !!prev.predicted
    });
  });
  return qs;
}

function slug(s) { return String(s || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40); }

async function patchJob(id, patch, rerenderList = false) {
  await window.scout.updateJob(id, patch);
  const j = jobById(id);
  if (j) Object.assign(j, patch);
  renderCounts();
  if (rerenderList) { renderJobs(); }
  if (openJobId === id) renderDrawer();
}

// ---------- n8n calls ----------
async function tailorResume(job, btn) {
  if (!state.profile.resume) { setView('profile'); return toast('Add your base resume in Profile first.'); }
  btn.disabled = true; btn.textContent = 'Tailoring… (can take ~30s)';
  // Send a deep copy of the profile. The base resume is a read-only source —
  // the tailor builds a separate copy and never writes back to profile.resume.
  const profileCopy = JSON.parse(JSON.stringify(state.profile));
  const res = await window.scout.callN8n('tailor-resume', { job, profile: profileCopy });
  btn.disabled = false;
  if (!res.ok) { renderDrawer(); return toast(res.error, 6000); }
  const data = res.data;
  await patchJob(job.id, {
    tailored: {
      tailored_resume: data.tailored_resume || '',
      cover_letter: data.cover_letter || '',
      changes_made: data.changes_made || [],
      honesty_check: data.honesty_check || '',
      tailoredAt: data.tailoredAt
    },
    status: job.status === 'new' ? 'tailored' : job.status
  }, true);
  toast('Resume tailored. Review it before using — you own every word.');
}

async function prepareApplication(job) {
  const existing = readQuestionsFromDom().filter(q => q.question.trim() || q.answer.trim());
  const btn = $('#prepareApp');
  btn.disabled = true; btn.textContent = 'Generating… (~20–40s)';
  // Send any pasted questions + notes. If none, the workflow predicts likely questions.
  const res = await window.scout.callN8n('submit-application', {
    job,
    profile: JSON.parse(JSON.stringify(state.profile)),
    tailored_resume: job.tailored?.tailored_resume || state.profile.resume,
    questions: existing.map(q => ({ question: q.question, answer: q.answer }))
  });
  if (!res.ok) { btn.disabled = false; btn.textContent = 'Generate answer options'; return toast(res.error, 6000); }
  const d = res.data;
  await patchJob(job.id, {
    application: {
      questions: (d.questions || []).map(q => ({
        question: q.question || '',
        predicted: !!q.predicted,
        options: q.options || [],
        selected: 0,
        answer: (q.options && q.options[0] && q.options[0].text) || ''
      })),
      checklist: d.submission_checklist || [],
      email_subject: d.email_subject || '',
      email_body: d.email_body || ''
    }
  });
  toast('Options ready — pick an angle per question, edit, then copy into the portal.');

}

// ---------- profile & settings ----------
function fillForm(form, obj) {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!obj[el.name];
    else if (obj[el.name] !== undefined) el.value = obj[el.name];
  }
}
function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// ---------- init ----------
async function init() {
  state = await window.scout.getState();
  renderCounts();
  setView(state.profile.resume ? 'new' : 'profile');
  fillForm($('#profileForm'), state.profile);
  fillForm($('#settingsForm'), state.settings);

  document.querySelectorAll('.stage').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  document.querySelectorAll('#globalSearch .link-btn').forEach(btn => btn.addEventListener('click', () => {
    const kw = $('#searchKw').value.trim() || 'remote internship';
    window.scout.openUrl(searchUrl(btn.dataset.site, kw, ''));
  }));

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.profile = await window.scout.saveProfile(readForm(e.target));
    $('#profileSaved').textContent = 'Saved ✓';
    setTimeout(() => $('#profileSaved').textContent = '', 2500);
  });

  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = readForm(e.target);
    state.settings = await window.scout.saveSettings({
      n8nBase: raw.n8nBase,
      minScore: Number(raw.minScore) || 0,
      requirePaid: !!raw.requirePaid,
      requireGlobal: !!raw.requireGlobal,
      interestKeywords: raw.interestKeywords || '',
      watchedCompanies: raw.watchedCompanies || '',
      adzunaAppId: raw.adzunaAppId || '',
      adzunaAppKey: raw.adzunaAppKey || '',
      adzunaCountries: raw.adzunaCountries || 'in,gb,us'
    });
    $('#settingsSaved').textContent = 'Saved ✓';
    setTimeout(() => $('#settingsSaved').textContent = '', 2500);
  });

  const adzLink = $('#adzunaLink');
  if (adzLink) adzLink.addEventListener('click', () => window.scout.openUrl('https://developer.adzuna.com/'));

  const aiPack = $('#loadAIPack');
  if (aiPack) aiPack.addEventListener('click', () => {
    // Starter set of AI/ML & robotics employers known to use these ATSs.
    // Slugs are best-effort EXAMPLES — verify each against the company's live careers page.
    const pack = [
      'lever:scale', 'greenhouse:databricks', 'ashby:openai', 'greenhouse:huggingface',
      'lever:cohere', 'ashby:anthropic', 'greenhouse:nvidia', 'lever:wayve',
      'greenhouse:scaleai', 'ashby:runwayml', 'lever:nuro', 'greenhouse:cruise',
      'lever:figure', 'greenhouse:boston-dynamics', 'ashby:perplexity-ai', 'lever:mistral'
    ].join('\n');
    const ta = document.querySelector('#settingsForm [name="watchedCompanies"]');
    ta.value = ta.value.trim() ? (ta.value.trim() + '\n' + pack) : pack;
    toast('Starter pack loaded — verify each slug, then Save settings.');
  });

  $('#testN8n').addEventListener('click', async () => {    const res = await window.scout.callN8n('tailor-resume', { ping: true });
    // Any HTTP response (even a validation error from the workflow) proves n8n is reachable.
    if (res.ok || /responded \d{3}/.test(res.error || '')) toast('n8n is reachable ✓ (workflows must be Active for webhooks to fire)');
    else toast(res.error, 6000);
  });

  window.scout.onJobsChanged((jobs) => {
    state.jobs = jobs;
    renderCounts();
    if (!$('#view-jobs').hidden) renderJobs();
    if (openJobId && !jobById(openJobId)) closeDrawer();
  });
}

init();
