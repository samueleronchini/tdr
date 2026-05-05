const form = document.getElementById("job-form");
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
const skymapField = document.getElementById("skymap-field");

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
const ifosLine = document.getElementById("ifos-line");
const ifosOnline = document.getElementById("ifos-online");
const plotsGallery = document.getElementById("plots-gallery");
const resultsAngleNote = document.getElementById("results-angle-note");
const bnsResultsHead = document.getElementById("json-bns-head");
const bnsResultsBody = document.getElementById("json-bns-body");
const nsbhResultsHead = document.getElementById("json-nsbh-head");
const nsbhResultsBody = document.getElementById("json-nsbh-body");
const bnsJsonDownload = document.getElementById("bns-json-download");
const nsbhJsonDownload = document.getElementById("nsbh-json-download");

function normalizeApiBase(rawBase) {
  return (rawBase || "").trim().replace(/\/+$/, "");
}

const HOSTNAME = window.location.hostname || "127.0.0.1";
const IS_GITHUB_PAGES = HOSTNAME.endsWith("github.io");
const LOCAL_API_BASE = normalizeApiBase(`http://${HOSTNAME}:8000`);
const CONFIGURED_PUBLIC_API_BASE = normalizeApiBase(window.TDR_WEB_CONFIG?.publicApiBase || "");
const API_BASE = IS_GITHUB_PAGES ? CONFIGURED_PUBLIC_API_BASE : LOCAL_API_BASE;

const SENSITIVE_RESULTS_ROOT = "/Users/sjs8171/Desktop/gw_tdr_results";
let currentJobId = null;
let pollTimer = null;

function shortenAbsolutePath(pathValue) {
  if (pathValue === SENSITIVE_RESULTS_ROOT) {
    return "gw_tdr_results";
  }

  if (pathValue.startsWith(`${SENSITIVE_RESULTS_ROOT}/`)) {
    return pathValue.replace(`${SENSITIVE_RESULTS_ROOT}/`, "gw_tdr_results/");
  }

  const segments = pathValue.split("/").filter(Boolean);
  if (segments.length === 0) {
    return pathValue;
  }

  if (segments.length === 1) {
    return segments[0];
  }

  return `.../${segments.slice(-2).join("/")}`;
}

function sanitizeDisplayText(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return String(value).replace(/\/Users\/[^\s"'`]+/g, (token) => shortenAbsolutePath(token));
}

function normalizeDecimalString(rawValue) {
  return String(rawValue ?? "").trim().replace(/,/g, ".");
}

function tokenizeCommand(commandLine) {
  if (!commandLine) {
    return [];
  }

  const rawTokens = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return rawTokens.map((token) => {
    if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function getArgValue(tokens, argName) {
  const idx = tokens.indexOf(argName);
  if (idx === -1 || idx + 1 >= tokens.length) {
    return null;
  }
  return tokens[idx + 1];
}

function buildInputSummary(commandLine) {
  if (!commandLine || !commandLine.includes("targ_ac_git.targ_range_snr_mf")) {
    return "";
  }

  const tokens = tokenizeCommand(commandLine);
  const t0 = getArgValue(tokens, "--t0") || "-";
  const snrThreshold = getArgValue(tokens, "--snr-threshold") || "-";
  const snrType = getArgValue(tokens, "--snr-type") || "-";
  const iotaMin = getArgValue(tokens, "--iota-min");
  const iotaMax = getArgValue(tokens, "--iota-max");
  const ra = getArgValue(tokens, "--ra");
  const dec = getArgValue(tokens, "--dec");
  const skymapFile = getArgValue(tokens, "--skymap-file");
  const outputDir = getArgValue(tokens, "--output-dir");

  const outputName = outputDir ? outputDir.split("/").filter(Boolean).pop() : "-";

  const localizationText = skymapFile
    ? `localization=skymap (${sanitizeDisplayText(skymapFile.split("/").pop())})`
    : `localization=coords (ra=${ra || "-"}, dec=${dec || "-"})`;

  const iotaText = iotaMin !== null && iotaMax !== null ? `${iotaMin}-${iotaMax} deg` : "default 0-45, 0-90 deg";

  return sanitizeDisplayText(
    `Input parameters used: transient=${outputName || "-"}; t0=${t0}; snr_threshold=${snrThreshold}; snr_type=${snrType}; ${localizationText}; iota=${iotaText}`,
  );
}

function isCommandEchoLine(line) {
  if (!line) {
    return false;
  }
  return /targ_ac_git\.targ_range_snr_mf|--output-dir|--cache-dir/.test(line);
}

function normalizeProgressLine(line) {
  return String(line || "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDownloadProgressLine(line) {
  if (/\d{1,3}%\[/.test(line)) {
    return true;
  }

  const normalized = normalizeProgressLine(line);
  const hasPercent = /(?:^|\s)\d{1,3}\s*%(?:\s|$)/.test(normalized);
  const hasThroughputToken = /(?:^|\s)\d+(?:\.\d+)?\s*(?:K|M|G)(?:i?B)?(?:\s|$)/i.test(normalized);
  const hasEtaToken = /(?:^|\s)\d+\s*s(?:\s|$)/i.test(normalized);
  const hasProgressGlyphs = /\.{5,}|={3,}|>{2,}/.test(line);

  return hasPercent && ((hasThroughputToken && hasEtaToken) || hasProgressGlyphs);
}

function isDownloadChunkLine(line) {
  const compact = String(line || "").trim();
  if (!compact) {
    return false;
  }

  // Catch chunk-only wget lines like "62000K .........." or "67650K ......".
  return /^(?:\d+(?:\.\d+)?\s*(?:K|M|G)(?:i?B)?[.\s]+)+$/i.test(compact);
}

function isDownloadNoiseLine(line) {
  return (
    /--\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}--/.test(line) ||
    /Resolving\s+gwosc\.org/.test(line) ||
    /Connecting\s+to\s+gwosc\.org/.test(line) ||
    /HTTP request sent, awaiting response/.test(line) ||
    /Length:\s+\d+/.test(line) ||
    /Saving to:\s+/.test(line) ||
    isDownloadChunkLine(line) ||
    /^[.\s]{8,}$/.test(line)
  );
}

function extractProgressPercent(line) {
  const normalized = normalizeProgressLine(line);
  const matches = [...normalized.matchAll(/(\d{1,3})\s*%/g)];
  if (matches.length === 0) {
    return null;
  }

  let maxPercent = null;
  for (const match of matches) {
    const percent = Number(match[1]);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      continue;
    }
    maxPercent = maxPercent === null ? percent : Math.max(maxPercent, percent);
  }

  return maxPercent;
}

function sanitizeLogLines(logTail, commandLine) {
  const cleanLines = [];
  const summary = buildInputSummary(commandLine);
  let latestDownloadProgress = null;

  if (summary) {
    cleanLines.push(summary);
  }

  for (const rawLine of logTail || []) {
    const line = sanitizeDisplayText(rawLine);
    if (!line.trim()) {
      continue;
    }

    if (isCommandEchoLine(line)) {
      continue;
    }

    if (isDownloadProgressLine(line)) {
      const progressPercent = extractProgressPercent(line);
      if (progressPercent !== null) {
        latestDownloadProgress = progressPercent;
      }
      continue;
    }

    if (isDownloadNoiseLine(line)) {
      continue;
    }

    cleanLines.push(line);
  }

  const runFinished = cleanLines.some((line) => /ANALYSIS COMPLETE|DONE in|completed analysis/i.test(line));
  if (latestDownloadProgress !== null && !runFinished) {
    cleanLines.push(`GWOSC download progress: ${latestDownloadProgress}%`);
  }

  return cleanLines.length > 0 ? cleanLines : ["No log lines yet."];
}

function buildApiUrl(path) {
  return `${API_BASE}${path}`;
}

function setFlash(message, isError = false) {
  flash.textContent = sanitizeDisplayText(message || "");
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
  skymapField.hidden = usingCoords;
  skymapField.style.display = usingCoords ? "none" : "";
}

function parseOptionalFloat(inputEl) {
  const raw = normalizeDecimalString(inputEl.value);
  inputEl.value = raw;

  if (raw === "") {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number: ${raw}. Use "." as decimal separator`);
  }

  return value;
}

function parseRequiredFloat(inputEl, fieldLabel) {
  const raw = normalizeDecimalString(inputEl.value);
  inputEl.value = raw;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldLabel} must be a valid number. Use "." as decimal separator`);
  }

  return value;
}

function clearTableBody(tbody) {
  while (tbody.firstChild) {
    tbody.removeChild(tbody.firstChild);
  }
}

function addInfoRow(tbody, text, cssClass = "empty-row", colSpan = 2) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = Math.max(1, colSpan);
  cell.className = cssClass;
  cell.textContent = sanitizeDisplayText(text);
  row.appendChild(cell);
  tbody.appendChild(row);
}

function renderResultsHeader(thead, angleColumns) {
  if (!thead) {
    return;
  }

  thead.innerHTML = "";

  const columns = Array.isArray(angleColumns) && angleColumns.length > 0 ? angleColumns : ["-"];
  const row = document.createElement("tr");

  const massHeader = document.createElement("th");
  massHeader.textContent = "Mass Combination";
  row.appendChild(massHeader);

  for (const label of columns) {
    const header = document.createElement("th");
    header.innerHTML = label === "-" ? "D<sub>90</sub> (Mpc)" : `D<sub>90</sub> ${label} deg (Mpc)`;
    row.appendChild(header);
  }

  thead.appendChild(row);
}

function resetJsonDownloadLink(linkEl) {
  if (!linkEl) {
    return;
  }

  linkEl.hidden = true;
  linkEl.removeAttribute("href");
}

function setJsonDownloadLink(linkEl, artifact) {
  if (!linkEl) {
    return;
  }

  if (!artifact) {
    resetJsonDownloadLink(linkEl);
    return;
  }

  linkEl.href = artifactDownloadUrl(artifact);
  linkEl.hidden = false;
}

function clearArtifacts() {
  artifactsSection.hidden = true;
  plotsGallery.innerHTML = "";
  clearTableBody(bnsResultsBody);
  clearTableBody(nsbhResultsBody);
  ifosLine.hidden = true;
  ifosOnline.textContent = "-";
  resultsAngleNote.textContent = "";

  resetJsonDownloadLink(bnsJsonDownload);
  resetJsonDownloadLink(nsbhJsonDownload);
  renderResultsHeader(bnsResultsHead, ["-"]);
  renderResultsHeader(nsbhResultsHead, ["-"]);
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
  const transientName = transientNameInput.value.trim();
  const t0 = t0Input.value.trim();
  const snrThreshold = parseRequiredFloat(snrThresholdInput, "SNR threshold");
  const snrType = snrTypeInput.value;

  if (!transientName) {
    throw new Error("Transient name is required");
  }
  if (!t0) {
    throw new Error("t0 is required");
  }
  if (!Number.isFinite(snrThreshold) || snrThreshold <= 0) {
    throw new Error("SNR threshold must be a positive number");
  }
  if (snrType !== "mf" && snrType !== "opt") {
    throw new Error("SNR type is required");
  }

  const formData = new FormData();
  formData.append("transient_name", transientName);
  formData.append("t0", t0);
  formData.append("snr_threshold", String(snrThreshold));
  formData.append("snr_type", snrType);

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
    const ra = parseRequiredFloat(raInput, "RA");
    const dec = parseRequiredFloat(decInput, "DEC");

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

  return formData;
}

function artifactPreviewUrl(artifact) {
  const baseUrl = buildApiUrl(artifact.url);
  const versionToken = Number(artifact?.size_bytes);

  if (!Number.isFinite(versionToken) || versionToken <= 0) {
    return baseUrl;
  }

  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}v=${versionToken}`;
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

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers,
    });
  } catch (_err) {
    throw new Error("Backend non raggiungibile: verifica che API/tunnel sia online.");
  }

  const text = await res.text();
  let bodyParsed = null;

  try {
    bodyParsed = text ? JSON.parse(text) : null;
  } catch (_err) {
    bodyParsed = text;
  }

  if (!res.ok) {
    const detail = bodyParsed && typeof bodyParsed === "object" ? bodyParsed.detail : bodyParsed;
    throw new Error(detail || `HTTP ${res.status}`);
  }

  return bodyParsed;
}

function formatNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "-";
  }

  return num.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function findJsonArtifact(jsonFiles, fileName) {
  return (jsonFiles || []).find((artifact) => artifact?.name === fileName) || null;
}

async function fetchJsonArtifact(artifact) {
  if (!artifact) {
    return { data: null, error: "File not found" };
  }

  try {
    const response = await fetch(artifactPreviewUrl(artifact), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    return { data: JSON.parse(text), error: null };
  } catch (err) {
    return { data: null, error: err.message || "Unable to load JSON" };
  }
}

function extractTdrRows(resultsJson, sourceKey) {
  const source = resultsJson && typeof resultsJson === "object" ? resultsJson[sourceKey] : null;
  if (!source || typeof source !== "object") {
    return [];
  }

  const rows = [];

  for (const [massKey, massPayload] of Object.entries(source)) {
    const tdr = massPayload && typeof massPayload === "object" ? massPayload.tdr : null;
    if (!tdr || typeof tdr !== "object") {
      rows.push({
        mass: massKey,
        iotaLabel: "-",
        d90: "-",
      });
      continue;
    }

    const tdrEntries = Object.entries(tdr);
    if (tdrEntries.length === 0) {
      rows.push({
        mass: massKey,
        iotaLabel: "-",
        d90: "-",
      });
      continue;
    }

    for (const [label, tdrItem] of tdrEntries) {
      const iotaMin = formatNumber(tdrItem?.iota_min_deg, 1);
      const iotaMax = formatNumber(tdrItem?.iota_max_deg, 1);
      const iotaLabel = iotaMin !== "-" && iotaMax !== "-" ? `${iotaMin}-${iotaMax}` : label;

      rows.push({
        mass: massKey,
        iotaLabel,
        d90: formatNumber(tdrItem?.D90_Mpc, 3),
      });
    }
  }

  return rows;
}

function normalizeIotaLabel(rawLabel) {
  if (!rawLabel || rawLabel === "-") {
    return "-";
  }

  const compact = String(rawLabel).trim().replace(/\s+/g, "");
  const match = compact.match(/^([0-9.]+)-([0-9.]+)$/);
  if (!match) {
    return compact;
  }

  return `${formatNumber(Number(match[1]), 1)}-${formatNumber(Number(match[2]), 1)}`;
}

function pickDisplayAngleColumns(rows) {
  const labels = Array.from(
    new Set(
      rows
        .map((row) => normalizeIotaLabel(row.iotaLabel))
        .filter((label) => label && label !== "-"),
    ),
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const isDefault = labels.length === 2 && labels.includes("0-45") && labels.includes("0-90");
  if (isDefault) {
    return ["0-45", "0-90"];
  }

  if (labels.length === 0) {
    return [];
  }

  return [labels[0]];
}

function pivotRowsByMass(rows) {
  const matrix = new Map();

  for (const row of rows) {
    const mass = sanitizeDisplayText(row.mass || "-");
    const label = normalizeIotaLabel(row.iotaLabel);
    const d90 = sanitizeDisplayText(row.d90 || "-");

    if (!matrix.has(mass)) {
      matrix.set(mass, new Map());
    }

    matrix.get(mass).set(label, d90);
  }

  return matrix;
}

function renderResultRows(thead, tbody, rows) {
  clearTableBody(tbody);

  const displayColumns = pickDisplayAngleColumns(rows);
  const headerColumns = displayColumns.length > 0 ? displayColumns : ["-"];
  renderResultsHeader(thead, headerColumns);

  if (rows.length === 0) {
    addInfoRow(tbody, "No rows available.", "empty-row", 1 + headerColumns.length);
    return;
  }

  const matrix = pivotRowsByMass(rows);
  const masses = Array.from(matrix.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const mass of masses) {
    const row = document.createElement("tr");

    const massCell = document.createElement("td");
    massCell.textContent = mass;
    row.appendChild(massCell);

    const values = matrix.get(mass) || new Map();

    for (const columnLabel of headerColumns) {
      const valueCell = document.createElement("td");
      let value = values.get(columnLabel);

      if (value === undefined && columnLabel === "-") {
        value = values.get("-") || Array.from(values.values())[0] || "-";
      }

      if (value === undefined && headerColumns.length === 1 && columnLabel !== "-") {
        value = Array.from(values.values())[0] || "-";
      }

      valueCell.textContent = sanitizeDisplayText(value === undefined ? "-" : value);
      row.appendChild(valueCell);
    }

    tbody.appendChild(row);
  }
}

function updateIfoLine(ifosPayload) {
  const used = Array.isArray(ifosPayload?.used_ifos) ? ifosPayload.used_ifos : [];
  const available = Array.isArray(ifosPayload?.strain_available_ifos) ? ifosPayload.strain_available_ifos : [];
  const onlineIfos = used.length > 0 ? used : available;

  if (onlineIfos.length === 0) {
    ifosLine.hidden = true;
    ifosOnline.textContent = "-";
    return;
  }

  ifosOnline.textContent = sanitizeDisplayText(onlineIfos.join(", "));
  ifosLine.hidden = false;
}

function updateAngleNote(bnsRows, nsbhRows) {
  const labels = new Set([...bnsRows, ...nsbhRows].map((row) => row.iotaLabel).filter((val) => val && val !== "-"));

  if (labels.size === 0) {
    resultsAngleNote.textContent = "No iota range rows available in JSON results.";
    return;
  }

  const sorted = Array.from(labels).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const isDefault = sorted.length === 2 && sorted.includes("0-45") && sorted.includes("0-90");

  if (isDefault) {
    resultsAngleNote.textContent = "Showing default iota ranges 0-45 and 0-90 deg for each mass combination.";
  } else {
    resultsAngleNote.textContent = `Showing user-defined iota range(s): ${sorted.join(", ")} deg.`;
  }
}

function buildPlotDisplayTitle(artifact) {
  const rawName = (artifact?.name || "").toLowerCase();

  if (rawName === "psd_plot.pdf") {
    return "PSD plot";
  }

  if (rawName === "bns_targeted_range.pdf") {
    return "BNS efficiency curve";
  }

  if (rawName === "nsbh_targeted_range.pdf") {
    return "NSBH efficiency curve";
  }

  if (rawName.startsWith("range_map_") && rawName.endsWith(".pdf")) {
    return "TDR map";
  }

  if (rawName.endsWith(".pdf") || rawName.endsWith(".png") || rawName.endsWith(".jpg") || rawName.endsWith(".jpeg")) {
    return "Generated plot";
  }

  return sanitizeDisplayText(artifact?.relative_path || artifact?.name || "Plot");
}

function artifactPathKey(artifact) {
  return String(artifact?.relative_path || artifact?.name || "");
}

function isImagePath(path) {
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(String(path || ""));
}

function isPreviewImageArtifact(artifact) {
  const name = String(artifact?.name || "").toLowerCase();
  return name.endsWith("_preview.png");
}

function buildPdfPreviewMap(plotFiles) {
  const map = new Map();
  const previewImagePaths = new Set();
  const pdfPaths = new Set();

  for (const artifact of plotFiles || []) {
    const relativePath = artifactPathKey(artifact);
    if (relativePath.toLowerCase().endsWith(".pdf")) {
      pdfPaths.add(relativePath);
    }
  }

  for (const artifact of plotFiles || []) {
    const relativePath = artifactPathKey(artifact);

    if (!isPreviewImageArtifact(artifact)) {
      continue;
    }

    const key = relativePath.replace(/_preview\.png$/i, ".pdf");
    if (key) {
      map.set(key, artifact);
      previewImagePaths.add(relativePath);
    }
  }

  for (const artifact of plotFiles || []) {
    const relativePath = artifactPathKey(artifact);
    if (!isImagePath(relativePath) || isPreviewImageArtifact(artifact)) {
      continue;
    }

    const key = relativePath.replace(/\.(png|jpe?g|webp|gif|bmp|svg)$/i, ".pdf");
    if (!pdfPaths.has(key) || map.has(key)) {
      continue;
    }

    map.set(key, artifact);
    previewImagePaths.add(relativePath);
  }

  return { map, previewImagePaths };
}

async function renderPlotCards(plotFiles) {
  plotsGallery.innerHTML = "";

  if (!Array.isArray(plotFiles) || plotFiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-row";
    empty.textContent = "No plot artifacts found for this run.";
    plotsGallery.appendChild(empty);
    return;
  }

  const { map: pdfPreviewMap, previewImagePaths } = buildPdfPreviewMap(plotFiles);
  const primaryArtifacts = plotFiles.filter((artifact) => !previewImagePaths.has(artifactPathKey(artifact)));

  for (const artifact of primaryArtifacts) {
    const card = document.createElement("article");
    card.className = "plot-card";

    const title = document.createElement("h4");
    title.textContent = buildPlotDisplayTitle(artifact);
    card.appendChild(title);

    const url = artifactPreviewUrl(artifact);
    const downloadUrl = artifactDownloadUrl(artifact);
    const ext = String(artifact.name || "").toLowerCase();
    const isPdf = ext.endsWith(".pdf");
    const previewArtifact = isPdf ? pdfPreviewMap.get(artifactPathKey(artifact)) : artifact;

    if (previewArtifact && isImagePath(artifactPathKey(previewArtifact))) {
      const img = document.createElement("img");
      img.className = "plot-image";
      img.src = artifactPreviewUrl(previewArtifact);
      img.alt = sanitizeDisplayText(artifact.relative_path);
      img.loading = "lazy";
      card.appendChild(img);
    } else if (isPdf) {
      const frame = document.createElement("iframe");
      frame.className = "plot-pdf-frame";
      frame.src = `${url}#view=FitH`;
      frame.loading = "lazy";
      frame.title = sanitizeDisplayText(artifact.relative_path || artifact.name || "Plot preview");
      card.appendChild(frame);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "plot-preview-empty";
      placeholder.textContent = "Preview image not available.";
      card.appendChild(placeholder);
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
}

async function renderResultsTables(jsonFiles) {
  clearTableBody(bnsResultsBody);
  clearTableBody(nsbhResultsBody);

  const ifosArtifact = findJsonArtifact(jsonFiles, "ifos_used.json");
  const bnsArtifact = findJsonArtifact(jsonFiles, "results_bns.json");
  const nsbhArtifact = findJsonArtifact(jsonFiles, "results_nsbh.json");

  setJsonDownloadLink(bnsJsonDownload, bnsArtifact);
  setJsonDownloadLink(nsbhJsonDownload, nsbhArtifact);

  const [ifosPayload, bnsPayload, nsbhPayload] = await Promise.all([
    fetchJsonArtifact(ifosArtifact),
    fetchJsonArtifact(bnsArtifact),
    fetchJsonArtifact(nsbhArtifact),
  ]);

  if (ifosPayload.data) {
    updateIfoLine(ifosPayload.data);
  } else {
    ifosLine.hidden = true;
  }

  let bnsRows = [];
  if (!bnsArtifact) {
    renderResultsHeader(bnsResultsHead, ["-"]);
    addInfoRow(bnsResultsBody, "results_bns.json not found.", "empty-row", 2);
  } else if (bnsPayload.error) {
    renderResultsHeader(bnsResultsHead, ["-"]);
    addInfoRow(bnsResultsBody, `Unable to read results_bns.json: ${bnsPayload.error}`, "empty-row", 2);
  } else {
    bnsRows = extractTdrRows(bnsPayload.data, "bns");
    renderResultRows(bnsResultsHead, bnsResultsBody, bnsRows);
  }

  let nsbhRows = [];
  if (!nsbhArtifact) {
    renderResultsHeader(nsbhResultsHead, ["-"]);
    addInfoRow(nsbhResultsBody, "results_nsbh.json not found.", "empty-row", 2);
  } else if (nsbhPayload.error) {
    renderResultsHeader(nsbhResultsHead, ["-"]);
    addInfoRow(nsbhResultsBody, `Unable to read results_nsbh.json: ${nsbhPayload.error}`, "empty-row", 2);
  } else {
    nsbhRows = extractTdrRows(nsbhPayload.data, "nsbh");
    renderResultRows(nsbhResultsHead, nsbhResultsBody, nsbhRows);
  }

  updateAngleNote(bnsRows, nsbhRows);
}

async function loadArtifacts(jobId) {
  try {
    return await apiFetch(`${API_BASE}/api/jobs/${jobId}/artifacts`);
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

  artifactsSection.hidden = false;

  await renderPlotCards(plotFiles);
  await renderResultsTables(jsonFiles);
}

function renderJob(job) {
  if (!job) {
    return;
  }

  setStatus(job.status || "idle");
  jobIdLabel.textContent = sanitizeDisplayText(job.job_id || "-");
  jobReturn.textContent = job.return_code === null || job.return_code === undefined ? "-" : String(job.return_code);

  const inputSummary = buildInputSummary(job.command || "");
  jobCommand.textContent = inputSummary || sanitizeDisplayText(job.command || "-");
  jobOutputDir.textContent = sanitizeDisplayText(job.output_dir || "-");

  if (Array.isArray(job.log_tail) && job.log_tail.length > 0) {
    const cleanLogLines = sanitizeLogLines(job.log_tail, job.command || "");
    logOutput.textContent = cleanLogLines.join("\n");
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

  try {
    const job = await apiFetch(`${API_BASE}/api/jobs/${currentJobId}`);
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
    const formData = buildRequestData();

    setRunningUi(true);
    setStatus("queued");
    logOutput.textContent = "Launching job...";
    clearArtifacts();

    const job = await apiFetch(`${API_BASE}/api/jobs`, {
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

  try {
    await apiFetch(`${API_BASE}/api/jobs/${currentJobId}/cancel`, {
      method: "POST",
    });

    setStatus("cancelling");
    setFlash("Cancellation requested");
  } catch (err) {
    setFlash(`Cancel failed: ${err.message}`, true);
  }
}

function initialize() {
  // Always start from a clean form state when opening/reloading the page.
  form.reset();
  transientNameInput.value = "";
  t0Input.value = "";
  snrThresholdInput.value = "";
  snrTypeInput.value = "";
  iotaMinInput.value = "";
  iotaMaxInput.value = "";
  raInput.value = "";
  decInput.value = "";

  const decimalInputs = [snrThresholdInput, iotaMinInput, iotaMaxInput, raInput, decInput];
  for (const inputEl of decimalInputs) {
    inputEl.addEventListener("input", () => {
      if (inputEl.value.includes(",")) {
        inputEl.value = inputEl.value.replace(/,/g, ".");
      }
    });
  }

  for (const radio of document.querySelectorAll("input[name='localization-mode']")) {
    radio.addEventListener("change", applyLocalizationMode);
  }

  applyLocalizationMode();
  form.addEventListener("submit", startJob);
  cancelBtn.addEventListener("click", cancelJob);

  setStatus("idle");
  clearArtifacts();

  if (!API_BASE) {
    setRunningUi(false);
    runBtn.disabled = true;
    setFlash("Public backend is not configured. Set a HTTPS URL in runtime-config.js.", true);
    return;
  }

  if (window.location.protocol === "https:" && API_BASE.startsWith("http://")) {
    setRunningUi(false);
    runBtn.disabled = true;
    setFlash("Configured backend is HTTP, but this page is HTTPS. Use a HTTPS backend URL.", true);
  }
}

initialize();
