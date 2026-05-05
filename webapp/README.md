# TDR Web App

This folder contains a web interface for TDR with this architecture:

- Frontend static files in `webapp/frontend` (can be hosted on GitHub Pages)
- Backend API in `webapp/backend` (must run on your local machine)

The frontend sends parameters to the local backend, and the backend launches
`python -m targ_ac_git.targ_range_snr_mf` on this machine.

The form asks for:

- `Transient name` (used as output folder name in repository root)
- `t0` trigger time in GPS seconds or ISO UTC format
- localization by `RA/DEC` or by sky map upload (`.fit` or `.fits`)
- `SNR type` (`mf` or `opt`)

## 1) Install backend dependencies

From repository root:

```bash
pip install -r webapp/requirements.txt
```

## 2) Start local backend

From repository root:

```bash
uvicorn webapp.backend.main:app --host 127.0.0.1 --port 8000
```

Optional security setting for CORS:

```bash
export TDR_WEB_ALLOWED_ORIGINS="https://<your-user>.github.io"
```

## 3) Open frontend locally for testing

From repository root:

```bash
python -m http.server 8080 --directory webapp/frontend
```

Then open:

- http://127.0.0.1:8080

Set API URL in the page to:

- http://127.0.0.1:8000

## 4) GitHub Pages deployment

A workflow is included at:

- `.github/workflows/webapp-pages.yml`

It publishes `webapp/frontend` when pushed to `main`.

After first push, enable GitHub Pages source as "GitHub Actions" in repo
settings if required.

## API endpoints

- `GET /api/health`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/log?tail=300`
- `GET /api/jobs/{job_id}/artifacts`
- `GET /api/jobs/{job_id}/artifacts/{artifact_path}`
- `POST /api/jobs/{job_id}/cancel`
