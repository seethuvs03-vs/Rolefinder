import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from urllib.parse import urlparse

import requests

SOURCES = {
    "Arbeitnow": "https://www.arbeitnow.com/api/job-board-api",
    "Remote OK": "https://remoteok.com/api",
}
HEADERS = {"User-Agent": "Rolefinder/1.0 (personal job search)"}


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


def collect_jobs():
    results, errors = [], []
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
        pending = {source: pool.submit(get_jobs, source, url) for source, url in SOURCES.items()}
        for source, future in pending.items():
            try:
                results.extend(future.result())
            except (requests.RequestException, KeyError, TypeError, ValueError):
                errors.append(source)
    results.sort(key=lambda job: job["date"], reverse=True)
    if len(errors) == len(SOURCES):
        raise RuntimeError("All job feeds are unavailable.")
    unique = {}
    for job in results:
        unique.setdefault(job["url"], job)
    return {
        "jobs": list(unique.values()),
        "unavailable": errors,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


if __name__ == "__main__":
    Path("dist/jobs.json").write_text(json.dumps(collect_jobs()), encoding="utf-8")
