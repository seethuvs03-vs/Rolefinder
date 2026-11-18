import hmac
import io
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape
from urllib.parse import urlparse

import requests
from docx import Document
from flask import Flask, Response, jsonify, request, send_file
from pypdf import PdfReader

app = Flask(__name__, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
SOURCES = {
    "Arbeitnow": "https://www.arbeitnow.com/api/job-board-api",
    "Remote OK": "https://remoteok.com/api",
}
HEADERS = {"User-Agent": "Rolefinder/1.0 (personal job search)"}


@app.before_request
def protect():
    password = os.getenv("APP_PASSWORD")
    if not password and os.getenv("RENDER"):
        return "Configure APP_PASSWORD before opening the app.", 503
    auth = request.authorization
    if password and (not auth or auth.username != "owner" or not hmac.compare_digest(
        (auth.password or "").encode(), password.encode()
    )):
        return Response("Sign in to Rolefinder.", 401, {"WWW-Authenticate": 'Basic realm="Rolefinder"'})


@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.errorhandler(413)
def too_large(error):
    return jsonify(error="Choose a resume smaller than 5 MB."), 413


@app.get("/")
def index():
    return app.send_static_file("index.html")


def clean(value):
    value = re.sub(r"<(?:br\b[^>]*|/p|/li|/div|/h[1-6])\s*>", "\n", value or "", flags=re.I)
    return unescape(re.sub(r"<[^>]+>", "", value)).strip()


def get_jobs(source, url):
    response = requests.get(url, headers=HEADERS, timeout=8)
    response.raise_for_status()
    payload = response.json()
    rows = payload["data"] if source == "Arbeitnow" else payload[1:]
    jobs = []
    for row in rows:
        try:
            date = datetime.fromtimestamp(int(row.get("created_at") or row["epoch"]), timezone.utc)
            link = row["url"]
            if urlparse(link).scheme != "https":
                continue
            jobs.append({
                "title": clean(row.get("title") or row.get("position")),
                "company": clean(row.get("company_name") or row.get("company")),
                "location": clean(row.get("location")),
                "remote": bool(row.get("remote")) or source == "Remote OK",
                "types": row.get("job_types") or [],
                "tags": row.get("tags") or [],
                "description": clean(row.get("description"))[:25000],
                "date": date.isoformat(),
                "url": link,
                "source": source,
            })
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return jobs


@app.get("/api/jobs")
def jobs():
    results, errors = [], []
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
        pending = {source: pool.submit(get_jobs, source, url) for source, url in SOURCES.items()}
        for source, future in pending.items():
            try:
                results.extend(future.result())
            except (requests.RequestException, KeyError, TypeError, ValueError):
                errors.append(source)
    results.sort(key=lambda job: job["date"], reverse=True)
    return jsonify(jobs=list({job["url"]: job for job in results}.values()), unavailable=errors)


@app.post("/api/resume")
def resume():
    uploaded = request.files.get("resume")
    if not uploaded:
        return jsonify(error="Choose a PDF, DOCX or TXT resume."), 400
    try:
        extension = uploaded.filename.lower().rsplit(".", 1)[-1]
        if extension == "pdf":
            reader = PdfReader(uploaded.stream)
            text = "\n".join(page.extract_text() or "" for page in reader.pages[:30])
        elif extension == "docx":
            document = Document(uploaded.stream)
            text = "\n".join(
                block.text if hasattr(block, "text") else "\n".join(
                    " | ".join(cell.text for cell in row.cells) for row in block.rows
                ) for block in document.iter_inner_content()
            )
        elif extension == "txt":
            text = uploaded.read().decode("utf-8-sig")
        else:
            return jsonify(error="Choose a PDF, DOCX or TXT resume."), 400
    except Exception:
        return jsonify(error="This file could not be read. Try an unlocked PDF, DOCX or TXT file."), 400
    if not text.strip():
        return jsonify(error="No selectable text was found. Try a text-based PDF or DOCX."), 400
    if len(text) > 50000:
        return jsonify(error="The resume exceeds 50,000 characters."), 400
    return jsonify(text=text.strip())


@app.post("/api/export")
def export():
    data = request.get_json(silent=True) or {}
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 60000:
        return jsonify(error="Provide a draft of up to 60,000 characters."), 400
    document = Document()
    for line in text.splitlines():
        line = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]", "", line)
        if line.startswith("• "):
            document.add_paragraph(line[2:], style="List Bullet")
        elif line and line.isupper() and len(line) < 65:
            document.add_heading(line.title(), level=1)
        else:
            document.add_paragraph(line)
    output = io.BytesIO()
    document.save(output)
    output.seek(0)
    return send_file(output, as_attachment=True, download_name="tailored-resume.docx")


if __name__ == "__main__":
    app.run()
