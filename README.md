# Rolefinder

Rolefinder is a personal job search app. Save preferences, browse recent openings, upload a resume, select a job, and review and export the tailored draft.

## Run

Use Python 3.12.

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
flask --app app run
```

Open http://127.0.0.1:5000. To run on Render, connect this repository via a Blueprint and deploy the included render.yaml. In the Render service environment, retrieve or replace its generated APP_PASSWORD. Open the HTTPS service URL and sign in as owner with that password. A hosting account and plan are required. GitHub Actions runs smoke checks on pushes and pull requests. The hosted app loads current listings when opened or refreshed.

## How it works

- Search the most recent records returned by Arbeitnow and Remote OK. Coverage varies by country and occupational field. Comma-separated titles and locations use OR. All required terms must appear and any excluded term removes a listing. Explicit work or location filters may hide jobs with missing metadata.
- Text-based PDF, DOCX and UTF-8 TXT uploads are supported. The server extracts text in the request, and the browser holds it for the current tab session. Preferences are saved in browser storage.
- Tailoring uses keyword overlap to reorder existing bullets within contiguous bullet groups. Listing tags and requirement cues are shown for manual review. The extracted text may need layout or line-break edits. No AI key is required.
- Download the edited draft as DOCX, or select Print / Save PDF. Use the original listing link to apply.
