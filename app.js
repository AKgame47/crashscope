/* CrashScope — client-side accident detection powered by the Gemini API.
   No backend: every request goes from this browser straight to
   generativelanguage.googleapis.com. The API key lives in localStorage only. */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INLINE_LIMIT = 15 * 1024 * 1024; // <=15MB -> inline base64, else File API
const CHUNK = 8 * 1024 * 1024;
const PROCESS_TIMEOUT = 12 * 60 * 1000;

const state = {
  apiKey: (localStorage.getItem('crashscope_gemini_key') || '').trim(),
  file: null,
  fileUrl: null,
  duration: 0,
  activeTab: 'upload',
  busy: false,
  result: null,
  resultMeta: null,
  ytId: null,
};

const SEV_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

const ANALYSIS_PROMPT = `You are a road-safety video analyst. Watch this entire video carefully and detect every traffic accident and road safety incident.

Count as an ACCIDENT: vehicle-vehicle collisions, vehicle-pedestrian/cyclist impacts, rollovers, vehicles leaving the road, pile-ups, fires/explosions involving vehicles, a vehicle hitting a fixed object.
Count as a NEAR MISS: hard emergency braking, violent swerving to avoid a crash, a pedestrian/vehicle narrowly missed, red-light running that nearly causes a crash.

Return ONLY valid JSON (no markdown fences, no commentary) with this exact structure:
{
  "video_summary": "1-2 sentences describing the video: setting, road type, conditions",
  "road_context": "short label, e.g. urban intersection / highway / parking lot / rural road",
  "incidents": [
    {
      "category": "accident",
      "start_seconds": 12.5,
      "end_seconds": 18.0,
      "type": "rear-end collision",
      "severity": "critical",
      "confidence": 92,
      "description": "Clear factual description of what happened, vehicles involved, visible damage or injuries.",
      "vehicles_involved": 2,
      "people_visible": true,
      "visible_injuries": false
    }
  ],
  "safety_score": 68,
  "overall_assessment": "2-3 sentences: how dangerous was this footage overall and why."
}

Rules:
- "severity" is one of: critical (injuries, fire, rollover, pedestrian impact, high-speed crash), high (hard collision, likely damage), moderate (minor contact, low-speed bump), low (near miss with no contact, or trivial scrape).
- "category" is one of: accident, near_miss.
- "start_seconds"/"end_seconds" are numbers counting from the very start of the video (0 = first frame).
- List incidents in chronological order. Include every distinct incident you can see.
- If nothing happened, return "incidents": [] with a high safety_score and say so in overall_assessment.
- "safety_score" is 0-100: 100 = completely uneventful safe driving, 0 = catastrophic multi-vehicle crash.
- Be precise with timestamps. Do not invent incidents you cannot see.`;

/* ---------------- helpers ---------------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function showError(msg) {
  const box = $('#errorBox');
  box.innerHTML = '<strong>Something went wrong:</strong> ' + esc(msg);
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearError() { $('#errorBox').classList.add('hidden'); }

function setStep(name, cls) {
  const li = document.querySelector(`#stepList li[data-step="${name}"]`);
  if (li) li.className = cls;
}
function resetSteps() { $$('#stepList li').forEach((li) => (li.className = '')); }
function setProgress(pct, msg) {
  $('#barFill').style.width = Math.min(100, Math.max(0, pct)) + '%';
  if (msg != null) $('#progressMsg').textContent = msg;
}
function friendlyApiError(status, bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const m = j.error && j.error.message ? j.error.message : null;
    if (m) {
      if (/api key/i.test(m)) return 'API key problem: ' + m + ' Check the key in Step 1.';
      return m;
    }
  } catch (e) { /* fall through */ }
  if (status === 400) return 'The request was rejected (HTTP 400). The video format may be unsupported.';
  if (status === 403) return 'Access denied (HTTP 403). Check that your API key is valid and the Gemini API is enabled for it.';
  if (status === 404) return 'Model not found (HTTP 404). Try a different model in Step 3.';
  if (status === 429) return 'Rate limit hit (HTTP 429). Wait a minute and try again, or use a paid-tier key.';
  return 'HTTP ' + status + ': ' + (bodyText || 'unknown error').slice(0, 200);
}

/* ---------------- API key ---------------- */
async function validateKey(key) {
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key) + '&pageSize=5'
  );
  if (!r.ok) throw new Error(friendlyApiError(r.status, await r.text()));
  return true;
}
function refreshKeyStatus() {
  const el = $('#keyStatus');
  if (state.apiKey) { el.textContent = 'Key saved. Ready.'; el.className = 'key-status ok'; }
  else { el.textContent = 'No key saved yet.'; el.className = 'key-status'; }
  $('#apiKey').value = state.apiKey;
}
async function onSaveKey() {
  const key = $('#apiKey').value.trim();
  const status = $('#keyStatus');
  if (!key) { status.textContent = 'Paste a key first.'; status.className = 'key-status bad'; return; }
  status.textContent = 'Testing key…'; status.className = 'key-status';
  try {
    await validateKey(key);
    state.apiKey = key;
    localStorage.setItem('crashscope_gemini_key', key);
    status.textContent = 'Key valid and saved.';
    status.className = 'key-status ok';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'key-status bad';
  }
}

/* ---------------- tabs & file input ---------------- */
function switchTab(name) {
  state.activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['upload', 'youtube', 'demo'].forEach((n) => $('#panel-' + n).classList.toggle('hidden', n !== name));
}
function setFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) { showError('That file is not a video. Please choose a video file.'); return; }
  clearError();
  state.file = file;
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(file);
  $('#fileName').textContent = file.name;
  $('#fileMeta').textContent = ' · ' + (file.size / 1048576).toFixed(1) + ' MB · reading duration…';
  $('#fileInfo').classList.remove('hidden');
  const v = document.createElement('video');
  v.preload = 'metadata'; v.src = state.fileUrl;
  v.onloadedmetadata = () => {
    state.duration = v.duration || 0;
    $('#fileMeta').textContent = ' · ' + (file.size / 1048576).toFixed(1) + ' MB · ' + fmtTime(v.duration);
    URL.revokeObjectURL(v.src);
  };
}

/* ---------------- Gemini: generateContent ---------------- */
async function generateContent(parts, label) {
  const model = $('#modelSelect').value;
  const key = state.apiKey;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
    },
  };
  if ($('#detailToggle').checked) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_HIGH';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  setProgress(92, (label || 'Analyzing') + ' — Gemini is watching the video…');
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(friendlyApiError(r.status, await r.text()));
  const j = await r.json();
  const text = (j.candidates && j.candidates[0] && j.candidates[0].content &&
    j.candidates[0].content.parts || []).map((p) => p.text || '').join('');
  if (!text.trim()) throw new Error('The model returned an empty response. Try again or use a shorter clip.');
  return text;
}

function parseReport(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let j;
  try { j = JSON.parse(t); }
  catch (e) { return { _raw: text, _parseError: 'Could not parse the model output as JSON.' }; }
  if (!Array.isArray(j.incidents)) j.incidents = [];
  j.incidents = j.incidents.map((inc, i) => ({
    category: inc.category === 'near_miss' ? 'near_miss' : 'accident',
    start_seconds: Number(inc.start_seconds) || 0,
    end_seconds: Number(inc.end_seconds) || Number(inc.start_seconds) || 0,
    type: String(inc.type || 'incident'),
    severity: ['critical', 'high', 'moderate', 'low'].includes(inc.severity) ? inc.severity : 'moderate',
    confidence: Math.min(100, Math.max(0, Number(inc.confidence) || 50)),
    description: String(inc.description || 'No description provided.'),
    vehicles_involved: Number(inc.vehicles_involved) || 0,
    people_visible: !!inc.people_visible,
    visible_injuries: !!inc.visible_injuries,
    _id: i + 1,
  })).sort((a, b) => a.start_seconds - b.start_seconds);
  j.safety_score = Math.min(100, Math.max(0, Number(j.safety_score) || 0));
  j.video_summary = String(j.video_summary || '');
  j.road_context = String(j.road_context || '');
  j.overall_assessment = String(j.overall_assessment || '');
  return j;
}

/* ---------------- upload paths ---------------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(new Error('Could not read the video file.'));
    fr.readAsDataURL(file);
  });
}

async function resumableUpload(file, onProgress) {
  const key = state.apiKey;
  const init = await fetch(
    'https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(file.size),
        'X-Goog-Upload-Header-Content-Type': file.type || 'video/mp4',
      },
      body: JSON.stringify({ file: { display_name: file.name.slice(0, 80) } }),
    });
  if (!init.ok) throw new Error('Upload could not start: ' + friendlyApiError(init.status, await init.text()));
  const uploadId = init.headers.get('X-GUploader-UploadID');
  if (!uploadId) throw new Error('Upload could not start: the server did not return an upload session.');
  const sessionUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=' + uploadId;

  let offset = 0, fileMeta = null;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const last = end >= file.size;
    const put = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - offset),
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload',
      },
      body: file.slice(offset, end),
    });
    if (!put.ok) throw new Error('Upload failed at ' + Math.round(100 * offset / file.size) + '%: ' +
      friendlyApiError(put.status, await put.text()));
    if (last) fileMeta = await put.json();
    offset = end;
    onProgress(offset / file.size);
  }
  if (!fileMeta || !fileMeta.name) throw new Error('Upload finished but the server returned no file record.');
  return fileMeta;
}

async function waitForActive(fileName) {
  const key = state.apiKey;
  const deadline = Date.now() + PROCESS_TIMEOUT;
  let wait = 4000;
  for (;;) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/' + fileName +
      '?key=' + encodeURIComponent(key));
    if (!r.ok) throw new Error('Could not check processing status: ' + friendlyApiError(r.status, await r.text()));
    const j = await r.json();
    if (j.state === 'ACTIVE') return j;
    if (j.state === 'FAILED') throw new Error('Google could not process this video (unsupported codec or corrupt file).');
    if (Date.now() > deadline) throw new Error('Timed out waiting for video processing (>12 min). Try a shorter clip.');
    setProgress(55, 'Video processing — Google is preparing the footage…');
    await sleep(wait);
    wait = Math.min(wait * 1.4, 15000);
  }
}

async function deleteRemoteFile(fileName) {
  try {
    await fetch('https://generativelanguage.googleapis.com/v1beta/' + fileName +
      '?key=' + encodeURIComponent(state.apiKey), { method: 'DELETE' });
  } catch (e) { /* best effort cleanup */ }
}

function extractYouTubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/* ---------------- main flow ---------------- */
async function runAnalysis() {
  if (state.busy) return;
  clearError();
  if (!state.apiKey) { showError('Add your Gemini API key in Step 1 first.'); return; }

  state.busy = true;
  $('#analyzeBtn').disabled = true;
  $('#results').classList.add('hidden');
  $('#progress').classList.remove('hidden');
  resetSteps();

  try {
    let raw, meta;
    if (state.activeTab === 'youtube') {
      const url = $('#ytUrl').value.trim();
      const vid = extractYouTubeId(url);
      if (!vid) throw new Error('That does not look like a YouTube link. Paste a full youtube.com or youtu.be URL.');
      state.ytId = vid;
      setStep('upload', 'done'); setStep('process', 'done'); setStep('analyze', 'active');
      setProgress(88, 'Analyzing — Gemini is fetching the YouTube video…');
      raw = await generateContent(
        [{ text: ANALYSIS_PROMPT }, { fileData: { fileUri: 'https://www.youtube.com/watch?v=' + vid } }],
        'Analyzing YouTube video');
      meta = { source: 'youtube', label: 'youtube.com/watch?v=' + vid };
    } else {
      const file = state.file;
      if (!file) throw new Error('Choose a video file in Step 2 first.');
      state.ytId = null;
      const mime = file.type || 'video/mp4';
      if (file.size <= INLINE_LIMIT) {
        setStep('upload', 'done'); setStep('process', 'done'); setStep('analyze', 'active');
        setProgress(30, 'Preparing clip…');
        const b64 = await fileToBase64(file);
        setProgress(60, 'Sending to Gemini…');
        raw = await generateContent(
          [{ text: ANALYSIS_PROMPT }, { inlineData: { mimeType: mime, data: b64 } }],
          'Analyzing video');
      } else {
        setStep('upload', 'active');
        const meta_up = await resumableUpload(file, (p) =>
          setProgress(p * 45, 'Uploading — ' + Math.round(p * 100) + '%'));
        setStep('upload', 'done'); setStep('process', 'active');
        const active = await waitForActive(meta_up.name);
        setStep('process', 'done'); setStep('analyze', 'active');
        raw = await generateContent(
          [{ text: ANALYSIS_PROMPT }, { fileData: { mimeType: active.mimeType || mime, fileUri: active.uri } }],
          'Analyzing video');
        deleteRemoteFile(meta_up.name);
      }
      meta = { source: 'upload', label: file.name, duration: state.duration };
    }
    setStep('analyze', 'done'); setStep('report', 'active');
    setProgress(97, 'Building your report…');
    const report = parseReport(raw);
    state.result = report; state.resultMeta = meta;
    renderResults(report, meta);
    setStep('report', 'done');
    setProgress(100, 'Done.');
    setTimeout(() => $('#results').scrollIntoView({ behavior: 'smooth' }), 350);
  } catch (e) {
    showError(e.message || String(e));
    resetSteps();
    $('#progress').classList.add('hidden');
  } finally {
    state.busy = false;
    $('#analyzeBtn').disabled = false;
  }
}

/* ---------------- rendering ---------------- */
function highestSeverity(incidents) {
  let best = null, rank = 0;
  for (const i of incidents) {
    if (i.category !== 'accident') continue;
    const r = SEV_RANK[i.severity] || 0;
    if (r > rank) { rank = r; best = i.severity; }
  }
  return best;
}

function renderResults(report, meta) {
  const box = $('#results');
  box.classList.remove('hidden');
  $('#assessment').innerHTML = '';
  $('#incidentList').innerHTML = '';
  $('#timeline').querySelector('.timeline-track').innerHTML = '';

  if (report._parseError) {
    $('#summaryGrid').innerHTML = '';
    $('#videoWrap').classList.add('hidden');
    $('#assessment').innerHTML = '<h5>Raw model output</h5><p>' + esc(report._parseError) +
      ' The raw text is below:</p><p style="white-space:pre-wrap;font-family:monospace;font-size:.8rem">' +
      esc(report._raw).slice(0, 4000) + '</p>';
    return;
  }

  const acc = report.incidents.filter((i) => i.category === 'accident');
  const near = report.incidents.filter((i) => i.category === 'near_miss');
  const hi = highestSeverity(report.incidents);
  const score = report.safety_score;
  const scoreCls = score >= 80 ? 'none' : score >= 55 ? 'low' : score >= 30 ? 'moderate' : 'critical';

  $('#summaryGrid').innerHTML =
    sumCard('Accidents', String(acc.length), acc.length ? 'critical' : 'none') +
    sumCard('Near-misses', String(near.length), near.length ? 'high' : 'none') +
    sumCard('Highest severity', hi ? hi : '—', hi || 'none') +
    sumCard('Safety score', String(score) + '<span style="font-size:1rem;color:var(--muted)">/100</span>', scoreCls);

  // video player + timeline (uploads only)
  const vw = $('#videoWrap'), yn = $('#ytNote');
  if (meta.source === 'upload' && state.fileUrl) {
    vw.classList.remove('hidden'); yn.classList.add('hidden');
    const v = $('#resultVideo');
    v.src = state.fileUrl;
    const dur = meta.duration || state.duration || 0;
    v.onloadedmetadata = () => drawMarkers(report.incidents, v.duration || dur);
    drawMarkers(report.incidents, dur);
    $('#timeline').onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const d = v.duration || dur;
      if (d) v.currentTime = frac * d;
    };
  } else if (meta.source === 'youtube') {
    vw.classList.add('hidden'); yn.classList.remove('hidden');
    yn.innerHTML = 'Source: <a href="https://www.youtube.com/watch?v=' + esc(state.ytId || '') +
      '" target="_blank" rel="noopener" style="color:var(--blue)">youtube.com/watch?v=' + esc(state.ytId || '') +
      '</a> — incident times below are clickable YouTube links.';
  } else {
    vw.classList.add('hidden'); yn.classList.remove('hidden');
    yn.textContent = 'Sample report — demo data. Analyze your own video in the Upload tab to get a player with clickable timestamps.';
  }

  // incident cards
  const list = $('#incidentList');
  if (!report.incidents.length) {
    list.innerHTML = '<div class="no-incidents"><div class="big">✓</div>' +
      '<h4>No accidents or near-misses detected</h4>' +
      '<p class="muted">Gemini watched the full video and found nothing matching accident or near-miss patterns.</p></div>';
  } else {
    list.innerHTML = '';
    report.incidents.forEach((inc) => list.appendChild(incidentCard(inc, meta)));
  }

  if (report.video_summary || report.road_context) {
    $('#assessment').innerHTML = '<h5>Scene overview</h5><p>' +
      (report.road_context ? '<strong>' + esc(report.road_context) + '.</strong> ' : '') +
      esc(report.video_summary) + '</p>' +
      (report.overall_assessment ? '<h5 style="margin-top:.9rem">Overall assessment</h5><p>' +
        esc(report.overall_assessment) + '</p>' : '');
  } else if (report.overall_assessment) {
    $('#assessment').innerHTML = '<h5>Overall assessment</h5><p>' + esc(report.overall_assessment) + '</p>';
  }
}

function sumCard(k, vHtml, cls) {
  return '<div class="sum-card"><div class="k">' + esc(k) + '</div><div class="v ' + cls + '">' + vHtml + '</div></div>';
}

function incidentCard(inc, meta) {
  const el = document.createElement('div');
  el.className = 'incident sev-' + inc.severity;
  const t0 = fmtTime(inc.start_seconds), t1 = fmtTime(inc.end_seconds);
  const range = inc.end_seconds > inc.start_seconds ? t0 + ' – ' + t1 : t0;
  let timeHtml;
  if (meta.source === 'youtube' && state.ytId) {
    const href = 'https://www.youtube.com/watch?v=' + state.ytId + '&t=' + Math.floor(inc.start_seconds) + 's';
    timeHtml = '<a class="time-link" href="' + href + '" target="_blank" rel="noopener">' + range + ' ↗</a>';
  } else {
    timeHtml = '<span class="time-link">' + range + '</span>';
  }
  el.innerHTML =
    '<div class="incident-top">' + timeHtml +
    '<span class="badge ' + inc.severity + '">' + inc.severity + '</span>' +
    '<span class="badge cat">' + (inc.category === 'near_miss' ? 'near miss' : 'accident') + '</span></div>' +
    '<h5>' + esc(inc.type) + '</h5><p>' + esc(inc.description) + '</p>' +
    '<div class="incident-meta"><span>Confidence<span class="conf-bar"><i style="width:' +
    inc.confidence + '%"></i></span> ' + inc.confidence + '%</span>' +
    (inc.vehicles_involved ? '<span>' + inc.vehicles_involved + ' vehicle(s)</span>' : '') +
    (inc.people_visible ? '<span>People visible</span>' : '') +
    (inc.visible_injuries ? '<span style="color:var(--red);font-weight:700">Possible injuries</span>' : '') +
    '</div>';
  if (meta.source === 'upload') {
    el.title = 'Click to jump to this moment';
    el.addEventListener('click', () => {
      const v = $('#resultVideo');
      if (v && isFinite(v.duration)) { v.currentTime = Math.min(inc.start_seconds, v.duration - 0.1); v.play().catch(() => {}); }
      v.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  return el;
}

function drawMarkers(incidents, duration) {
  const track = $('#timeline').querySelector('.timeline-track');
  track.innerHTML = '';
  if (!duration) return;
  incidents.forEach((inc) => {
    const m = document.createElement('div');
    m.className = 'marker ' + inc.severity + (inc.category === 'near_miss' ? ' nearmiss' : '');
    m.style.left = Math.min(100, Math.max(0, 100 * inc.start_seconds / duration)) + '%';
    m.title = fmtTime(inc.start_seconds) + ' — ' + inc.type + ' (' + inc.severity + ')';
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = $('#resultVideo');
      if (v && isFinite(v.duration)) { v.currentTime = Math.min(inc.start_seconds, v.duration - 0.1); v.play().catch(() => {}); }
    });
    track.appendChild(m);
  });
}

/* ---------------- export / reset / demo ---------------- */
function downloadJson() {
  if (!state.result) return;
  const payload = {
    tool: 'CrashScope', generated_at: new Date().toISOString(),
    source: state.resultMeta, model: $('#modelSelect').value, report: state.result,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'crashscope-report-' + Date.now() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const DEMO_REPORT = {
  video_summary: 'Dashcam footage from a 4-lane highway in light rain. Traffic is moderate, visibility reduced by spray from trucks.',
  road_context: 'Highway, wet conditions',
  incidents: [
    {
      category: 'accident', start_seconds: 47, end_seconds: 54, type: 'rear-end collision',
      severity: 'high', confidence: 94,
      description: 'Silver sedan fails to brake in time and rear-ends a slowing box truck in the middle lane. Visible front-end damage to the sedan; both vehicles pull onto the shoulder with hazard lights on.',
      vehicles_involved: 2, people_visible: true, visible_injuries: false, _id: 1,
    },
    {
      category: 'accident', start_seconds: 132, end_seconds: 139, type: 'sideswipe during lane change',
      severity: 'moderate', confidence: 88,
      description: 'Blue SUV changes lanes without signaling and sideswipes a white hatchback. Both drivers brake hard; the hatchback sustains scrapes along the driver-side doors. No one exits the vehicles on camera.',
      vehicles_involved: 2, people_visible: true, visible_injuries: false, _id: 2,
    },
    {
      category: 'near_miss', start_seconds: 203, end_seconds: 207, type: 'hard braking to avoid stopped traffic',
      severity: 'low', confidence: 91,
      description: 'Camera vehicle brakes hard as traffic ahead stops suddenly around a blind curve. Stops with an estimated 3-4 meters to spare; no contact.',
      vehicles_involved: 1, people_visible: false, visible_injuries: false, _id: 3,
    },
    {
      category: 'accident', start_seconds: 268, end_seconds: 281, type: 'multi-vehicle pile-up',
      severity: 'critical', confidence: 96,
      description: 'Three cars collide in the left lane after the lead vehicle hydroplanes into the barrier. Airbags deploy in the second car; a passenger is seen holding their head. Emergency vehicles arrive at the end of the clip.',
      vehicles_involved: 3, people_visible: true, visible_injuries: true, _id: 4,
    },
  ],
  safety_score: 22,
  overall_assessment: 'Extremely hazardous stretch of driving: four separate events in under five minutes, including one critical pile-up with likely injuries. Wet roads and following distances far too short for conditions are the clear contributing factors.',
};

function runDemo() {
  clearError();
  state.result = DEMO_REPORT;
  state.resultMeta = { source: 'demo', label: 'Sample report — demo data (no video)' };
  state.ytId = null;
  $('#progress').classList.add('hidden');
  renderResults(DEMO_REPORT, state.resultMeta);
  setTimeout(() => $('#results').scrollIntoView({ behavior: 'smooth' }), 150);
}

/* ---------------- wire up ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  refreshKeyStatus();
  $('#saveKeyBtn').addEventListener('click', onSaveKey);
  $('#clearKeyBtn').addEventListener('click', () => {
    state.apiKey = ''; localStorage.removeItem('crashscope_gemini_key'); refreshKeyStatus();
  });
  $('#apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveKey(); });

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  const dz = $('#dropzone'), fi = $('#fileInput');
  $('#browseBtn').addEventListener('click', (e) => { e.stopPropagation(); fi.click(); });
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => setFile(fi.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; setFile(f); });
  $('#removeFileBtn').addEventListener('click', () => {
    state.file = null; if (state.fileUrl) URL.revokeObjectURL(state.fileUrl); state.fileUrl = null;
    fi.value = ''; $('#fileInfo').classList.add('hidden');
  });

  $('#analyzeBtn').addEventListener('click', runAnalysis);
  $('#demoBtn').addEventListener('click', runDemo);
  $('#exportBtn').addEventListener('click', downloadJson);
  $('#copyBtn').addEventListener('click', async () => {
    if (!state.result) return;
    try { await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2)); $('#copyBtn').textContent = 'Copied!'; }
    catch (e) { $('#copyBtn').textContent = 'Copy failed'; }
    setTimeout(() => ($('#copyBtn').textContent = 'Copy JSON'), 1600);
  });
  $('#resetBtn').addEventListener('click', () => {
    $('#results').classList.add('hidden');
    $('#progress').classList.add('hidden');
    resetSteps(); setProgress(0, ''); clearError();
    window.scrollTo({ top: $('#analyzer').offsetTop - 70, behavior: 'smooth' });
  });
});
