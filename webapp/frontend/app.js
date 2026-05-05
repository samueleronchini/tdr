const form = document.getElementById("job-form");
const apiUrlInput = document.getElementById("api-url");
const transientNameInput = document.getElementById("transient-name");
const t0Input = document.getElementById("t0");
const snrThresholdInput = document.getElementById("snr-threshold");
const snrTypeInput = document.getElementById("snr-type");
const skymapUploadInput = document.getElementById("skymap-upload");
const iotaMinInput = document.getElementById("iota-min");
const iotaMaxInput = document.getElementById("iota-max");
const raInput = document.getElementById("ra");
const decInput = document.getElementById("dec");
const coordsFields = document.getElementById("coords-fields");

const runBtn = document.getElementById("run-btn");
const cancelBtn = document.getElementById("cancel-btn");
const flash = document.getElementById("flash");
const jobStatus = document.getElementById("job-status");
const jobIdLabel = document.getElementById("job-id");
const jobReturn = document.getElementById("job-return");
const jobCommand = document.getElementById("job-command");
const jobOutputDir = document.getElementById("job-output-dir");
const logOutput = document.getElementById("log-output");
const artifactsSection = document.getElementById("artifacts");
const plotsGallery = document.getElementById("plots-gallery");
const jsonTableBody = document.getElementById("json-table-body");

const LOCAL_STORAGE_API_KEY = "tdr-web-api-url";

let currentJobId = null;
let pollTimer = null;
const MAX_JSON_ROWS_PER_FILE = 400;

function normalizeApiBase(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

function buildApiUrl(path) {
  const base = normalizeApiBase(apiUrlInput.value);
  return `${base}${path}`;
}

function setFlash(message, isError = false) {
  flash.textContent = message || "";
  flash.style.color = isError ? "#b42318" : "#146c43";
}

function setStatus(state) {
  const normalized = state || "idle";
  jobStatus.textContent = normalized;
  jobStatus.className = `pill ${normalized}`;
}

function getLocalizationMode() {
  const selected = document.querySelector("input[name='localization-mode']:checked");
  return selected ? selected.value : "coords";
}

function applyLocalizationMode() {
  const mode = getLocalizationMode();
  const usingCoords = mode === "coords";

  raInput.disabled = !usingCoords;
  decInput.disabled = !usingCoords;
  skymapUploadInput.disabled = usingCoords;
  coordsFields.hidden = !usingCoords;
  coordsFields.style.display = usingCoords ? "" : "none";
}

function parseOptionalFloat(inputEl) {
  const raw = inputEl.value.trim();
  if (raw === "") {
    return null;
  }

  const val = Number(raw);
  if (!Number.isFinite(val)) {
    throw new Error(`Invalid number: ${raw}`);
  }

  return val;
}

function clearArtifacts() {
  artifactsSection.hidden = true;
  plotsGallery.innerHTML = "";
  jsonTableBody.innerHTML = "";
}

function addNoArtifactsMessage() {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.textContent = "No JSON products found for this run.";
  cell.className = "empty-row";
  row.appendChild(cell);
  jsonTableBody.appendChild(row);
}

function validateFitsFile(file) {
  if (!file) {
    throw new Error("Please choose a sky map file in .fit or .fits format");
  }

  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".fit") && !lower.endsWith(".fits")) {
    throw new Error("Sky map file must have .fit or .fits extension");
  }
}

function buildRequestData() {
  const apiUrl = normalizeApiBase(apiUrlInput.value);
  if (!apiUrl) {
    throw new Error("API URL is required");
  }

  const transientName = transientNameInput.value.trim();
  const t0 = t0Input.value.trim();
  const snrThreshold = Number(snrThresholdInput.value);

  if (!transientName) {
    throw new Error("Transient name is required");
  }
  if (!t0) {
    throw new Error("t0 is required");
  }
  if (!Number.isFinite(snrThreshold) || snrThreshold <= 0) {
    throw new Error("SNR threshold must be a positive number");
  }

  const formData = new FormData();
  formData.append("transient_name", transientName);
  formData.append("t0", t0);
  formData.append("snr_threshold", String(snrThreshold));
  formData.append("snr_type", snrTypeInput.value);

  const iotaMin = parseOptionalFloat(iotaMinInput);
  const iotaMax = parseOptionalFloat(iotaMaxInput);
  if ((iotaMin === null) !== (iotaMax === null)) {
    throw new Error("Provide both Iota Min and Iota Max, or leave both empty");
  }
  if (iotaMin !== null && iotaMax !== null) {
    formData.append("iota_min", String(iotaMin));
    formData.append("iota_max", String(iotaMax));
  }

  if (getLocalizationMode() === "coords") {
    const ra = Number(raInput.value);
    const dec = Number(decInput.value);

    if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
      throw new Error("RA and DEC must be valid numbers");
    }

    formData.append("ra", String(ra));
    formData.append("dec", String(dec));
  } else {
    const selectedFile = skymapUploadInput.files?.[0] || null;
    validateFitsFile(selectedFile);
    formData.append("skymap_upload", selectedFile);
  }

  return { apiUrl, formData };
}

function artifactPreviewUrl(artifact) {
  return buildApiUrl(artifact.url);
}

function artifactDownloadUrl(artifact) {
  const separator = artifact.url.includes("?") ? "&" : "?";
  return buildApiUrl(`${artifact.url}${separator}download=1`);
}

function setRunningUi(isRunning) {
  runBtn.disabled = isRunning;
  cancelBtn.disabled = !isRunning;
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function apiFetch(url, options = {}) {
  const body = options.body;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;

  const headers = isFormData
    ? { ...(options.headers || {}) }
    : {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const text = await res.text();
  let bodyParsed = null;

  try {
    bodyParsed = text ? JSON.parse(text) : null;
  } catch (err) {
    bodyParsed = text;
  }

  if (!res.ok) {
    const detail = bodyParsed && typeof bodyParsed === "object" ? bodyParsed.detail : bodyParsed;
    throw new Error(detail || `HTTP ${res.status}`);
  }

  return bodyParsed;
}

function toDisplayValue(value) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const asText = JSON.stringify(value);
  if (asText === undefined) {
    return "";
  }

  return asText.length > 180 ? `${asText.slice(0, 177)}...` : asText;
}

function flattenJson(value, prefix = "") {
  const rows = [];

  if (value === null || typeof value !== "object") {
    rows.push({ key: prefix || "(value)", value: toDisplayValue(value) });
    return rows;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ key: prefix || "(array)", value: "[]" });
      return rows;
    }

    value.forEach((item, index) => {
      const childKey = prefix ? `${prefix}[${index}]` : `[${index}]`;
      rows.push(...flattenJson(item, childKey));
    });
    return rows;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    rows.push({ key: prefix || "(object)", value: "{}" });
    return rows;
  }

  for (const key of keys) {
    const childKey = prefix ? `${prefix}.${key}` : key;
    const child = value[key];
    if (child !== null && typeof child === "object") {
      rows.push(...flattenJson(child, childKey));
    } else {
      rows.push({ key: childKey, value: toDisplayValue(child) });
    }
  }

  return rows;
}

function appendJsonRows(artifact, rows, truncated) {
  const downloadUrl = artifactDownloadUrl(artifact);

  rows.forEach((item) => {
    const row = document.createElement("tr");

    const fileCell = document.createElement("td");
    fileCell.textContent = artifact.relative_path;

    const keyCell = document.createElement("td");
    keyCell.textContent = item.key;

    const valueCell = document.createElement("td");
    valueCell.className = "value-cell";
    valueCell.textContent = item.value;

    const downloadCell = document.createElement("td");
    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.target = "_blank";
    downloadLink.rel = "noopener noreferrer";
    downloadLink.textContent = "Download";
    downloadCell.appendChild(downloadLink);

    row.appendChild(fileCell);
    row.appendChild(keyCell);
    row.appendChild(valueCell);
    row.appendChild(downloadCell);
    jsonTableBody.appendChild(row);
  });

  if (truncated) {
    const truncRow = document.createElement("tr");
    const truncCell = document.createElement("td");
    truncCell.colSpan = 4;
    truncCell.className = "empty-row";
    truncCell.textContent = `Rows truncated for ${artifact.relative_path}.`;
    truncRow.appendChild(truncCell);
    jsonTableBody.appendChild(truncRow);
  }
}

async function renderJsonContent(jsonFiles) {
  if (jsonFiles.length === 0) {
    addNoArtifactsMessage();
    return;
  }

  for (const artifact of jsonFiles) {
    const url = artifactPreviewUrl(artifact);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        appendJsonRows(
          artifact,
          [{ key: "(raw)", value: text.length > 180 ? `${text.slice(0, 177)}...` : text }],
          false,
        );
        continue;
      }

      const flatRows = flattenJson(parsed);
      const limitedRows = flatRows.slice(0, MAX_JSON_ROWS_PER_FILE);
      const truncated = flatRows.length > MAX_JSON_ROWS_PER_FILE;
      appendJsonRows(artifact, limitedRows, truncated);
    } catch (err) {
      appendJsonRows(
        artifact,
        [{ key: "(error)", value: `Unable to load JSON content: ${err.message}` }],
        false,
      );
    }
  }
}

async function loadArtifacts(jobId) {
  const apiBase = normalizeApiBase(apiUrlInput.value);
  if (!apiBase) {
    return null;
  }

  try {
    return await apiFetch(`${apiBase}/api/jobs/${jobId}/artifacts`);
  } catch (err) {
    setFlash(`Artifact loading error: ${err.message}`, true);
    return null;
  }
}

async function renderArtifacts(job) {
  clearArtifacts();

  const artifactsPayload = await loadArtifacts(job.job_id);

  const fallbackPlotFiles = Array.isArray(job.plot_files) ? job.plot_files : [];
  const fallbackJsonFiles = Array.isArray(job.json_files) ? job.json_files : [];

  const plotFiles =
    artifactsPayload && Array.isArray(artifactsPayload.plot_files)
      ? artifactsPayload.plot_files
      : fallbackPlotFiles;
  const jsonFiles =
    artifactsPayload && Array.isArray(artifactsPayload.json_files)
      ? artifactsPayload.json_files
      : fallbackJsonFiles;

  if (plotFiles.length === 0 && jsonFiles.length === 0) {
    addNoArtifactsMessage();
    artifactsSection.hidden = false;
    return;
  }

  artifactsSection.hidden = false;

  for (const artifact of plotFiles) {
    const card = document.createElement("article");
    card.className = "plot-card";

    const title = document.createElement("h4");
    title.textContent = artifact.relative_path;
    card.appendChild(title);

    const url = artifactPreviewUrl(artifact);
    const downloadUrl = artifactDownloadUrl(artifact);
    const ext = (artifact.name || "").toLowerCase();

    if (ext.endsWith(".pdf")) {
      const frame = document.createElement("iframe");
      frame.className = "plot-frame";
      frame.src = `${url}#view=FitH`;
      frame.loading = "lazy";
      card.appendChild(frame);
    } else {
      const img = document.createElement("img");
      img.className = "plot-image";
      img.src = url;
      img.alt = artifact.relative_path;
      img.loading = "lazy";
      card.appendChild(img);
    }

    const actionBox = document.createElement("div");
    actionBox.className = "artifact-actions";

    const openLink = document.createElement("a");
    openLink.href = url;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.textContent = "Open";

    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.target = "_blank";
    downloadLink.rel = "noopener noreferrer";
    downloadLink.textContent = "Download";

    actionBox.appendChild(openLink);
    actionBox.appendChild(downloadLink);
    card.appendChild(actionBox);

    plotsGallery.appendChild(card);
  }

  await renderJsonContent(jsonFiles);
}

function renderJob(job) {
  if (!job) {
    return;
  }

  setStatus(job.status || "idle");
  jobIdLabel.textContent = job.job_id || "-";
  jobReturn.textContent = job.return_code === null || job.return_code === undefined ? "-" : String(job.return_code);
  jobCommand.textContent = job.command || "-";
  jobOutputDir.textContent = job.output_dir || "-";

  if (Array.isArray(job.log_tail) && job.log_tail.length > 0) {
    logOutput.textContent = job.log_tail.join("\n");
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  if (terminalStates.has(job.status)) {
    setRunningUi(false);
    stopPolling();
  }

  if (job.status === "completed") {
    void renderArtifacts(job);
  }
}

async function pollJob() {
  if (!currentJobId) {
    return;
  }

  const apiBase = normalizeApiBase(apiUrlInput.value);
  if (!apiBase) {
    setFlash("Missing API URL", true);
    stopPolling();
    return;
  }

  try {
    const job = await apiFetch(`${apiBase}/api/jobs/${currentJobId}`);
    renderJob(job);

    const terminalStates = new Set(["completed", "failed", "cancelled"]);
    if (!terminalStates.has(job.status)) {
      pollTimer = setTimeout(pollJob, 2000);
    }
  } catch (err) {
    setFlash(`Polling error: ${err.message}`, true);
    pollTimer = setTimeout(pollJob, 3000);
  }
}

async function startJob(event) {
  event.preventDefault();
  setFlash("");

  try {
    const { apiUrl, formData } = buildRequestData();
    localStorage.setItem(LOCAL_STORAGE_API_KEY, apiUrl);

    setRunningUi(true);
    setStatus("queued");
    logOutput.textContent = "Launching job...";
    clearArtifacts();

    const job = await apiFetch(`${apiUrl}/api/jobs`, {
      method: "POST",
      body: formData,
    });

    currentJobId = job.job_id;
    setFlash(`Job started: ${currentJobId}`);
    renderJob(job);

    stopPolling();
    pollTimer = setTimeout(pollJob, 900);
  } catch (err) {
    setRunningUi(false);
    setStatus("idle");
    setFlash(err.message, true);
  }
}

async function cancelJob() {
  if (!currentJobId) {
    return;
  }

  const apiBase = normalizeApiBase(apiUrlInput.value);
  if (!apiBase) {
    setFlash("Missing API URL", true);
    return;
  }

  try {
    await apiFetch(`${apiBase}/api/jobs/${currentJobId}/cancel`, {
      method: "POST",
    });

    setStatus("cancelling");
    setFlash("Cancellation requested");
  } catch (err) {
    setFlash(`Cancel failed: ${err.message}`, true);
  }
}

function initialize() {
  const savedApi = localStorage.getItem(LOCAL_STORAGE_API_KEY);
  if (savedApi) {
    apiUrlInput.value = savedApi;
  }

  for (const radio of document.querySelectorAll("input[name='localization-mode']")) {
    radio.addEventListener("change", applyLocalizationMode);
  }

  applyLocalizationMode();
  form.addEventListener("submit", startJob);
  cancelBtn.addEventListener("click", cancelJob);

  setStatus("idle");
  clearArtifacts();
}

initialize();
