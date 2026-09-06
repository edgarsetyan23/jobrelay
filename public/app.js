// JobRelay workshop frontend. Vanilla JS, no build step, no framework --
// polling is the simplest approach that makes the demonstration clear (see
// README "Frontend" for why). Every status shown here comes from a real
// backend response; nothing is simulated or interpolated client-side.
"use strict";

const POLL_MS = 1500;
const STATUSES = ["queued", "running", "retrying", "succeeded", "failed"];

const state = {
  jobs: new Map(), // id -> job
  selectedId: null,
  workers: [],
};

// --- tiny DOM helpers -------------------------------------------------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function fmtTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false });
}

function elapsedSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : "--------";
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const message = body?.error?.message || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function newIdempotencyKey() {
  return crypto.randomUUID();
}

// --- upload ------------------------------------------------------------

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const uploadStatus = document.getElementById("upload-status");
const uploadPreview = document.getElementById("upload-preview");
const trySampleBtn = document.getElementById("try-sample");
const submitBtn = document.getElementById("submit-upload");
let pendingFile = null;

async function fetchSampleBlob() {
  const res = await fetch("/sample.jpg");
  const blob = await res.blob();
  return new File([blob], "sample.jpg", { type: "image/jpeg" });
}

function setPendingFile(file) {
  pendingFile = file;
  uploadPreview.innerHTML = "";
  if (!file) {
    submitBtn.disabled = true;
    return;
  }
  const img = el("img", { alt: `preview of ${file.name}` });
  img.src = URL.createObjectURL(file);
  uploadPreview.appendChild(img);
  uploadPreview.appendChild(el("div", { class: "status-line" }, file.name));
  submitBtn.disabled = false;
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setPendingFile(fileInput.files[0]);
});
["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  }),
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setPendingFile(file);
});

trySampleBtn.addEventListener("click", async () => {
  uploadStatus.textContent = "loading sample...";
  uploadStatus.className = "status-line";
  const file = await fetchSampleBlob();
  setPendingFile(file);
  uploadStatus.textContent = "";
});

submitBtn.addEventListener("click", async () => {
  if (!pendingFile) return;
  submitBtn.disabled = true;
  uploadStatus.textContent = "submitting...";
  uploadStatus.className = "status-line";
  try {
    const form = new FormData();
    form.append("image", pendingFile);
    const body = await api("/api/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": newIdempotencyKey() },
      body: form,
    });
    uploadStatus.textContent = `Ticket ${shortId(body.job.id)} created -- watch the dispatch board below.`;
    uploadStatus.className = "status-line ok";
    selectJob(body.job.id);
    await refreshJobs();
  } catch (err) {
    uploadStatus.textContent = `Rejected: ${err.message}`;
    uploadStatus.className = "status-line error";
  } finally {
    submitBtn.disabled = false;
  }
});

// --- dispatch board ------------------------------------------------------

const columns = {
  queued: document.getElementById("column-queued"),
  running: document.getElementById("column-running"),
  retrying: document.getElementById("column-running"), // retrying rides in the same lane as running -- it's still "in the queue's care"
  succeeded: document.getElementById("column-succeeded"),
  failed: document.getElementById("column-failed"),
};
const counts = {
  queued: document.getElementById("count-queued"),
  running: document.getElementById("count-running"),
  succeeded: document.getElementById("count-succeeded"),
  failed: document.getElementById("count-failed"),
};

function ticketNode(job) {
  const btn = el(
    "button",
    {
      class: `ticket status-${job.status}${job.isDemo ? " demo" : ""}${job.id === state.selectedId ? " selected" : ""}`,
      type: "button",
      "aria-pressed": job.id === state.selectedId ? "true" : "false",
      onclick: () => selectJob(job.id),
    },
    job.status === "succeeded" || job.status === "failed" ? el("span", { class: "stamp" }, job.status === "succeeded" ? "DONE" : "FAILED") : null,
    el("div", { class: "ticket-id" }, `#${shortId(job.id)}${job.isDemo ? " (demo)" : ""}`),
    el("div", { class: "ticket-name" }, job.result?.originalFilename || (job.payload && job.payload.originalFilename) || "image"),
    el(
      "div",
      { class: "ticket-meta" },
      el("span", null, `attempt ${job.attempts || (job.status === "queued" ? 0 : 1)}`),
      el("span", null, fmtTime(job.createdAt)),
    ),
  );
  return btn;
}

function renderBoard() {
  const grouped = { queued: [], running: [], succeeded: [], failed: [] };
  for (const job of state.jobs.values()) {
    if (job.status === "queued") grouped.queued.push(job);
    else if (job.status === "running" || job.status === "retrying") grouped.running.push(job);
    else if (job.status === "succeeded") grouped.succeeded.push(job);
    else grouped.failed.push(job);
  }
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  for (const key of ["queued", "running", "succeeded", "failed"]) {
    const container = columns[key];
    container.innerHTML = "";
    if (grouped[key].length === 0) {
      container.appendChild(el("div", { class: "empty-hint" }, "nothing here"));
    } else {
      for (const job of grouped[key].slice(0, 25)) container.appendChild(ticketNode(job));
    }
    counts[key].textContent = String(grouped[key].length);
  }
}

async function refreshJobs() {
  const body = await api("/api/jobs?limit=100");
  state.jobs = new Map(body.jobs.map((j) => [j.id, j]));
  renderBoard();
  if (state.selectedId) await renderDetail(state.selectedId);
}

// --- worker stations -------------------------------------------------

const stationsEl = document.getElementById("stations");
const workerBanner = document.getElementById("worker-banner");

function stationNode(worker) {
  return el(
    "div",
    { class: `station${worker.status === "offline" ? " offline" : ""}` },
    el("div", { class: "kind" }, worker.kind === "main" ? "Main worker" : "Demo worker"),
    el("div", { class: "id" }, worker.id),
    el("span", { class: `badge ${worker.status}` }, worker.status),
    worker.currentJobId ? el("div", { class: "status-line" }, `job #${shortId(worker.currentJobId)}`) : null,
  );
}

async function refreshWorkers() {
  const body = await api("/api/workers");
  state.workers = body.workers;
  stationsEl.innerHTML = "";
  if (body.workers.length === 0) {
    stationsEl.appendChild(el("div", { class: "empty-hint" }, "no workers registered yet"));
  } else {
    for (const w of body.workers) stationsEl.appendChild(stationNode(w));
  }
  const hasLiveMain = body.workers.some((w) => w.kind === "main" && w.status !== "offline");
  workerBanner.hidden = hasLiveMain;
}

// --- ticket detail ---------------------------------------------------

const detailEmpty = document.getElementById("detail-empty");
const detailContent = document.getElementById("detail-content");

function selectJob(id) {
  state.selectedId = id;
  renderBoard();
  renderDetail(id);
}

async function renderDetail(id) {
  let job, attempts;
  try {
    [{ job }, { attempts }] = await Promise.all([api(`/api/jobs/${id}`), api(`/api/jobs/${id}/attempts`)]);
  } catch {
    return;
  }
  detailEmpty.hidden = true;
  detailContent.hidden = false;
  detailContent.innerHTML = "";

  const header = el(
    "div",
    { class: "detail-header" },
    el("h3", null, job.result?.originalFilename || "image ticket"),
    el("span", { class: "id" }, job.id),
  );
  const meta = el(
    "p",
    { class: "status-line" },
    `${job.isDemo ? "demo job" : "normal job"} -- status: ${job.status} -- attempts: ${job.attempts}/${job.maxAttempts}` +
      (job.status === "running" || job.status === "retrying" ? ` -- elapsed: ${elapsedSince(job.startedAt || job.createdAt)}` : ""),
  );

  const events = el(
    "ul",
    { class: "event-list" },
    ...attempts.map((a) =>
      el(
        "li",
        null,
        el("span", null, `attempt ${a.attempt_number}: ${a.status}${a.error ? ` -- ${a.error}` : ""} (worker ${a.worker_id})`),
        el("time", null, fmtTime(a.started_at)),
      ),
    ),
    attempts.length === 0 ? el("li", null, el("span", null, "waiting to be picked up by a worker...")) : null,
  );

  const body = el("div", { class: "detail-grid" }, el("div", null, meta, events));

  if (job.status === "succeeded" && job.result?.thumbnails) {
    const thumbs = el(
      "div",
      { class: "thumbs" },
      ...job.result.thumbnails.map((t) =>
        el(
          "figure",
          null,
          el("img", { src: t.url, alt: `${t.label} thumbnail, ${t.width}x${t.height}` }),
          el("figcaption", null, `${t.label} (${t.width}x${t.height})`),
          el("br"),
          el("a", { href: t.url, target: "_blank", rel: "noopener" }, "open full size"),
        ),
      ),
    );
    body.appendChild(el("div", null, el("h4", null, "Thumbnails"), thumbs));
  } else if (job.status === "failed") {
    body.appendChild(el("div", null, el("h4", null, "Failure reason"), el("p", { class: "status-line error" }, job.error || "unknown error")));
  }

  detailContent.appendChild(header);
  detailContent.appendChild(body);
}

// --- demo panel ----------------------------------------------------------

async function demoSubmit(fault) {
  const file = await fetchSampleBlob();
  const form = new FormData();
  form.append("image", file);
  if (fault) form.append("fault", JSON.stringify(fault));
  return api("/api/demo/jobs", {
    method: "POST",
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: form,
  });
}

function setResult(node, text, cls) {
  node.textContent = text;
  node.className = `result status-line ${cls || ""}`;
}

async function pollJobUntil(id, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { job } = await api(`/api/jobs/${id}`);
    if (predicate(job)) return job;
    if (Date.now() > deadline) throw new Error("timed out waiting for the job");
    await new Promise((r) => setTimeout(r, 700));
  }
}

// Control 1: Send twice
document.getElementById("demo-send-twice").addEventListener("click", async (e) => {
  const out = document.getElementById("result-send-twice");
  e.target.disabled = true;
  setResult(out, "sending the same ticket twice...");
  try {
    const key = newIdempotencyKey();
    const file = await fetchSampleBlob();
    const submitOnce = () => {
      const form = new FormData();
      form.append("image", file);
      return api("/api/jobs", { method: "POST", headers: { "Idempotency-Key": key }, body: form });
    };
    const [a, b] = await Promise.all([submitOnce(), submitOnce()]);
    const same = a.job.id === b.job.id;
    setResult(out, `Request A -> #${shortId(a.job.id)}\nRequest B -> #${shortId(b.job.id)}\n${same ? "Same ticket both times, as expected." : "MISMATCH -- this would be a bug."}`, same ? "ok" : "error");
    await refreshJobs();
  } catch (err) {
    setResult(out, `Error: ${err.message}`, "error");
  } finally {
    e.target.disabled = false;
  }
});

// Control 2: Fail this attempt
document.getElementById("demo-fail-attempt").addEventListener("click", async (e) => {
  const out = document.getElementById("result-fail-attempt");
  e.target.disabled = true;
  setResult(out, "submitting a demo job that will fail its first attempt...");
  try {
    const { job } = await demoSubmit({ mode: "transient-fail-count", failCount: 1 });
    selectJob(job.id);
    setResult(out, `Ticket #${shortId(job.id)}: waiting for attempt 1 to fail...`);
    await pollJobUntil(job.id, (j) => j.status === "retrying" || j.status === "failed" || j.attempts >= 1);
    setResult(out, `Ticket #${shortId(job.id)}: attempt 1 failed on purpose. Waiting for the retry to succeed...`);
    const final = await pollJobUntil(job.id, (j) => j.status === "succeeded" || j.status === "failed");
    setResult(out, `Ticket #${shortId(job.id)} finished: ${final.status} after ${final.attempts} attempt(s).`, final.status === "succeeded" ? "ok" : "error");
    await refreshJobs();
  } catch (err) {
    setResult(out, `Error: ${err.message}`, "error");
  } finally {
    e.target.disabled = false;
  }
});

// Control 3: Stop this worker
document.getElementById("demo-stop-worker").addEventListener("click", async (e) => {
  const out = document.getElementById("result-stop-worker");
  e.target.disabled = true;
  setResult(out, "submitting a slow demo job so there's time to pull the plug...");
  try {
    const { job } = await demoSubmit({ mode: "slow", delayMs: 6000, onlyOnAttempt: 1 });
    selectJob(job.id);
    setResult(out, `Ticket #${shortId(job.id)}: waiting for a demo worker to pick it up...`);
    await pollJobUntil(job.id, (j) => j.status === "running");

    const { attempts } = await api(`/api/jobs/${job.id}/attempts`);
    const workerId = attempts[attempts.length - 1]?.worker_id;
    if (!workerId) throw new Error("could not determine which worker picked up the job");

    setResult(out, `Ticket #${shortId(job.id)} is being processed by ${workerId}. Pulling the plug...`);
    await api(`/api/demo/workers/${encodeURIComponent(workerId)}/stop`, { method: "POST" });
    await refreshWorkers();

    setResult(out, `${workerId} was killed mid-job. Waiting for the queue's stalled-job check to hand it to another worker...`);
    const final = await pollJobUntil(job.id, (j) => j.status === "succeeded" || j.status === "failed", 30_000);
    setResult(out, `Recovered: ticket #${shortId(job.id)} finished ${final.status} despite the crash.`, final.status === "succeeded" ? "ok" : "error");
    await refreshJobs();
    await refreshWorkers();
  } catch (err) {
    setResult(out, `Error: ${err.message}`, "error");
  } finally {
    e.target.disabled = false;
  }
});

// --- boot ----------------------------------------------------------------

api("/api/config")
  .then((cfg) => {
    document.getElementById("demo-section").hidden = !cfg.demoEnabled;
  })
  .catch(() => {});

async function tick() {
  try {
    await Promise.all([refreshJobs(), refreshWorkers()]);
  } catch (err) {
    // A transient poll failure (e.g. the API restarting) shouldn't be fatal --
    // just try again on the next tick.
    console.warn("poll failed", err);
  }
}

tick();
setInterval(tick, POLL_MS);
