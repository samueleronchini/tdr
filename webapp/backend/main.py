from __future__ import annotations

import mimetypes
import os
import re
import shlex
import subprocess
import sys
import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Deque, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = REPO_ROOT / "webapp" / "runs"
UPLOADS_DIR = RUNS_DIR / "uploads"

RUNS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

PLOT_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".svg"}
JSON_EXTENSIONS = {".json"}
FIT_EXTENSIONS = {".fit", ".fits"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _tail_file(path: Path, max_lines: int) -> List[str]:
    if not path.exists():
        return []

    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return [line.rstrip("\n") for line in deque(handle, maxlen=max_lines)]


def _sanitize_transient_name(raw_name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", raw_name.strip())
    cleaned = cleaned.strip("._-")

    if not cleaned:
        raise HTTPException(status_code=400, detail="transient_name must contain at least one alphanumeric character")

    return cleaned


def _resolve_output_dir(transient_name: str) -> tuple[str, Path]:
    safe_name = _sanitize_transient_name(transient_name)
    output_dir = (REPO_ROOT / safe_name).resolve()

    if REPO_ROOT not in output_dir.parents and output_dir != REPO_ROOT:
        raise HTTPException(status_code=400, detail="Output directory must stay within repository root")

    return safe_name, output_dir


def _resolve_input_file(raw_path: str, expected_extensions: set[str]) -> Path:
    candidate = Path(raw_path)
    resolved = candidate.resolve() if candidate.is_absolute() else (REPO_ROOT / candidate).resolve()

    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"Input file not found: {raw_path}")

    if resolved.suffix.lower() not in expected_extensions:
        allowed = ", ".join(sorted(expected_extensions))
        raise HTTPException(status_code=400, detail=f"Input file must have one of these extensions: {allowed}")

    return resolved


async def _save_uploaded_skymap(job_id: str, uploaded: UploadFile) -> Path:
    filename = uploaded.filename or "uploaded_skymap.fits"
    suffix = Path(filename).suffix.lower()

    if suffix not in FIT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Sky map upload must be a .fit or .fits file")

    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(filename).name)
    if not safe_name.lower().endswith((".fit", ".fits")):
        safe_name = safe_name + ".fits"

    upload_dir = UPLOADS_DIR / job_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    destination = upload_dir / safe_name

    with destination.open("wb") as handle:
        while True:
            chunk = await uploaded.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)

    await uploaded.close()

    return destination


class JobInput(BaseModel):
    transient_name: str = Field(..., min_length=1)
    t0: str = Field(..., min_length=1)
    ra: Optional[float] = None
    dec: Optional[float] = None
    snr_threshold: float = 8.5
    snr_type: str = "mf"
    iota_min: Optional[float] = None
    iota_max: Optional[float] = None


class ArtifactItem(BaseModel):
    name: str
    relative_path: str
    size_bytes: int
    url: str


class JobResponse(BaseModel):
    job_id: str
    status: str
    created_at: str
    started_at: Optional[str]
    ended_at: Optional[str]
    return_code: Optional[int]
    error_message: Optional[str]
    pid: Optional[int]
    command: str
    transient_name: str
    output_dir: str
    log_file: str
    log_tail: List[str]
    plot_files: List[ArtifactItem]
    json_files: List[ArtifactItem]


@dataclass
class JobState:
    job_id: str
    request: JobInput
    transient_name: str
    output_dir: Path
    skymap_file: Optional[Path]
    log_file: Path
    status: str = "queued"
    created_at: str = field(default_factory=_utc_now)
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    return_code: Optional[int] = None
    error_message: Optional[str] = None
    pid: Optional[int] = None
    command: List[str] = field(default_factory=list)
    process: Optional[subprocess.Popen] = None
    log_tail: Deque[str] = field(default_factory=lambda: deque(maxlen=600))
    lock: threading.Lock = field(default_factory=threading.Lock)


jobs: Dict[str, JobState] = {}
jobs_lock = threading.Lock()


def _validate_request_input(request: JobInput) -> None:
    if request.snr_type not in {"mf", "opt"}:
        raise HTTPException(status_code=400, detail="snr_type must be 'mf' or 'opt'")

    if request.snr_threshold <= 0:
        raise HTTPException(status_code=400, detail="snr_threshold must be > 0")

    if (request.iota_min is None) ^ (request.iota_max is None):
        raise HTTPException(status_code=400, detail="Provide both iota_min and iota_max, or neither")


def _collect_artifacts(output_dir: Path, job_id: str) -> tuple[List[ArtifactItem], List[ArtifactItem]]:
    plot_files: List[ArtifactItem] = []
    json_files: List[ArtifactItem] = []

    if not output_dir.exists():
        return plot_files, json_files

    for file_path in sorted(output_dir.rglob("*")):
        if not file_path.is_file():
            continue

        extension = file_path.suffix.lower()
        if extension not in PLOT_EXTENSIONS and extension not in JSON_EXTENSIONS:
            continue

        relative_path = file_path.relative_to(output_dir).as_posix()
        artifact = ArtifactItem(
            name=file_path.name,
            relative_path=relative_path,
            size_bytes=file_path.stat().st_size,
            url=f"/api/jobs/{job_id}/artifacts/{relative_path}",
        )

        if extension in PLOT_EXTENSIONS:
            plot_files.append(artifact)
        elif extension in JSON_EXTENSIONS:
            json_files.append(artifact)

    return plot_files, json_files


def _build_command(state: JobState) -> List[str]:
    request = state.request
    command = [
        sys.executable,
        "-m",
        "targ_ac_git.targ_range_snr_mf",
        "--output-dir",
        str(state.output_dir),
        "--t0",
        request.t0,
        "--snr-threshold",
        str(request.snr_threshold),
        "--snr-type",
        request.snr_type,
    ]

    if state.skymap_file is not None:
        command.extend(["--skymap-file", str(state.skymap_file)])
    else:
        command.extend(["--ra", str(request.ra), "--dec", str(request.dec)])

    if request.iota_min is not None and request.iota_max is not None:
        command.extend(["--iota-min", str(request.iota_min), "--iota-max", str(request.iota_max)])

    return command


def _append_log(state: JobState, line: str, handle) -> None:
    clean_line = line.rstrip("\n")
    with state.lock:
        state.log_tail.append(clean_line)

    handle.write(line)
    handle.flush()


def _run_job(state: JobState) -> None:
    command = _build_command(state)

    with state.lock:
        state.command = command
        state.status = "running"
        state.started_at = _utc_now()

    state.output_dir.mkdir(parents=True, exist_ok=True)

    with state.log_file.open("w", encoding="utf-8") as handle:
        handle.write(f"$ {shlex.join(command)}\n\n")
        handle.flush()

        try:
            process = subprocess.Popen(
                command,
                cwd=str(REPO_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as exc:
            with state.lock:
                state.status = "failed"
                state.ended_at = _utc_now()
                state.error_message = f"Failed to start process: {exc}"
            handle.write(state.error_message + "\n")
            return

        with state.lock:
            state.process = process
            state.pid = process.pid

        assert process.stdout is not None
        for line in process.stdout:
            _append_log(state, line, handle)

        return_code = process.wait()

        with state.lock:
            state.return_code = return_code
            state.ended_at = _utc_now()
            state.process = None
            state.pid = None

            if state.status == "cancelling":
                state.status = "cancelled"
                state.error_message = "Job cancelled by user"
            elif return_code == 0:
                state.status = "completed"
                state.error_message = None
            else:
                state.status = "failed"
                state.error_message = f"Process exited with return code {return_code}"


def _serialize_job(state: JobState) -> JobResponse:
    with state.lock:
        command = shlex.join(state.command) if state.command else ""
        log_tail = list(state.log_tail)
        status = state.status

    plot_files, json_files = _collect_artifacts(state.output_dir, state.job_id)

    return JobResponse(
        job_id=state.job_id,
        status=status,
        created_at=state.created_at,
        started_at=state.started_at,
        ended_at=state.ended_at,
        return_code=state.return_code,
        error_message=state.error_message,
        pid=state.pid,
        command=command,
        transient_name=state.transient_name,
        output_dir=str(state.output_dir),
        log_file=str(state.log_file),
        log_tail=log_tail,
        plot_files=plot_files,
        json_files=json_files,
    )


def _get_job(job_id: str) -> JobState:
    with jobs_lock:
        state = jobs.get(job_id)

    if state is None:
        raise HTTPException(status_code=404, detail=f"Unknown job_id: {job_id}")

    return state


app = FastAPI(title="TDR Local Web Runner", version="0.2.0")

allowed_origins_env = os.getenv("TDR_WEB_ALLOWED_ORIGINS", "*").strip()
if allowed_origins_env == "*":
    allowed_origins = ["*"]
else:
    allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict:
    return {
        "name": "TDR Local Web Runner",
        "health": "/api/health",
        "create_job": "/api/jobs",
        "artifacts": "/api/jobs/{job_id}/artifacts",
    }


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "repo_root": str(REPO_ROOT),
        "jobs_total": len(jobs),
    }


@app.get("/api/jobs")
def list_jobs() -> List[JobResponse]:
    with jobs_lock:
        current_jobs = list(jobs.values())

    current_jobs.sort(key=lambda item: item.created_at, reverse=True)
    return [_serialize_job(job) for job in current_jobs]


@app.post("/api/jobs", response_model=JobResponse)
async def create_job(
    transient_name: str = Form(...),
    t0: str = Form(...),
    ra: Optional[float] = Form(None),
    dec: Optional[float] = Form(None),
    skymap_path: Optional[str] = Form(None),
    skymap_upload: Optional[UploadFile] = File(None),
    snr_threshold: float = Form(8.5),
    snr_type: str = Form("mf"),
    iota_min: Optional[float] = Form(None),
    iota_max: Optional[float] = Form(None),
) -> JobResponse:
    request_data = JobInput(
        transient_name=transient_name,
        t0=t0,
        ra=ra,
        dec=dec,
        snr_threshold=snr_threshold,
        snr_type=snr_type,
        iota_min=iota_min,
        iota_max=iota_max,
    )
    _validate_request_input(request_data)

    if skymap_upload is not None and skymap_path:
        raise HTTPException(status_code=400, detail="Provide either skymap_upload or skymap_path, not both")

    if skymap_upload is None and not skymap_path and (ra is None or dec is None):
        raise HTTPException(status_code=400, detail="Provide either sky map (upload/path) or both ra and dec")

    job_id = uuid.uuid4().hex[:10]
    log_file = RUNS_DIR / f"{job_id}.log"

    safe_transient_name, output_dir = _resolve_output_dir(transient_name)

    if skymap_upload is not None:
        skymap_file = await _save_uploaded_skymap(job_id, skymap_upload)
    elif skymap_path:
        skymap_file = _resolve_input_file(skymap_path, FIT_EXTENSIONS)
    else:
        skymap_file = None

    state = JobState(
        job_id=job_id,
        request=request_data,
        transient_name=safe_transient_name,
        output_dir=output_dir,
        skymap_file=skymap_file,
        log_file=log_file,
    )

    with jobs_lock:
        jobs[job_id] = state

    thread = threading.Thread(target=_run_job, args=(state,), daemon=True)
    thread.start()

    return _serialize_job(state)


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str) -> JobResponse:
    state = _get_job(job_id)

    # Ensure newest tail is returned also after process finished.
    if state.log_file.exists():
        latest_tail = _tail_file(state.log_file, 600)
        with state.lock:
            state.log_tail = deque(latest_tail, maxlen=600)

    return _serialize_job(state)


@app.get("/api/jobs/{job_id}/log")
def get_job_log(job_id: str, tail: int = 300) -> dict:
    state = _get_job(job_id)
    lines = _tail_file(state.log_file, max(1, min(tail, 2000)))

    with state.lock:
        status = state.status

    return {
        "job_id": job_id,
        "status": status,
        "lines": lines,
    }


@app.get("/api/jobs/{job_id}/artifacts")
def get_job_artifacts(job_id: str) -> dict:
    state = _get_job(job_id)
    plot_files, json_files = _collect_artifacts(state.output_dir, state.job_id)

    with state.lock:
        status = state.status

    return {
        "job_id": job_id,
        "status": status,
        "output_dir": str(state.output_dir),
        "plot_files": [item.model_dump() for item in plot_files],
        "json_files": [item.model_dump() for item in json_files],
    }


@app.get("/api/jobs/{job_id}/artifacts/{artifact_path:path}")
def get_job_artifact(job_id: str, artifact_path: str, download: bool = False):
    state = _get_job(job_id)

    requested_file = (state.output_dir / artifact_path).resolve()
    if state.output_dir not in requested_file.parents and requested_file != state.output_dir:
        raise HTTPException(status_code=403, detail="Artifact path is outside output directory")

    if not requested_file.exists() or not requested_file.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")

    media_type = mimetypes.guess_type(str(requested_file))[0]
    if download:
        return FileResponse(
            path=str(requested_file),
            media_type=media_type,
            filename=requested_file.name,
            content_disposition_type="attachment",
        )

    return FileResponse(
        path=str(requested_file),
        media_type=media_type,
        filename=requested_file.name,
        content_disposition_type="inline",
    )


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    state = _get_job(job_id)

    with state.lock:
        if state.status not in {"running", "queued"}:
            return {"job_id": job_id, "status": state.status, "message": "Job is not running"}

        process = state.process
        state.status = "cancelling"

    if process is not None:
        process.terminate()

    return {"job_id": job_id, "status": "cancelling"}
