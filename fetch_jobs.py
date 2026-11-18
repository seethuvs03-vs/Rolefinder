import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from html import unescape
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

SOURCES = {
    "Arbeitnow": "https://www.arbeitnow.com/api/job-board-api",
    "Remote OK": "https://remoteok.com/api",
}
EMPLOYER_BOARDS = {
    "AccorHotel": ("in", "ae", "qa"),
    "AECOM2": ("in", "ae", "qa"),
    "TurnerTownsend": ("in", "ae", "qa"),
    "BoschGroup": ("in",),
    "NielsenIQ": ("in",),
    "Endava": ("in",),
    "BESIX": ("ae",),
}
COUNTRY_NAMES = {"in": "India", "ae": "United Arab Emirates", "qa": "Qatar"}
SMARTRECRUITERS_API = "https://api.smartrecruiters.com/v1/companies"
INFOPARK = "https://infopark.in/companies-job"
KERALA_TZ = ZoneInfo("Asia/Kolkata")
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


def infopark_description(job):
    try:
        response = requests.get(job["url"], headers=HEADERS, timeout=8)
        response.raise_for_status()
        details = BeautifulSoup(response.text, "html.parser").select_one(".deatil-box")
        if details:
            job["description"] = details.get_text("\n", strip=True)[:25000]
    except requests.RequestException:
        pass
    return job


def get_infopark_jobs():
    jobs = {}
    today = datetime.now(KERALA_TZ).date()
    for keyword in ("data quality", "data", "quality analyst"):
        response = requests.get(INFOPARK, params={"search": keyword}, headers=HEADERS, timeout=8)
        response.raise_for_status()
        board = BeautifulSoup(response.text, "html.parser")
        table = board.select_one("#job-list table")
        if table is None:
            raise ValueError("Infopark listing table is missing.")
        for row in table.select("tbody tr"):
            cells = row.find_all("td", recursive=False)
            if len(cells) != 5:
                continue
            title = cells[1].get_text(strip=True)
            link = cells[4].find("a", href=True)
            if not link or not re.search(r"\b(data|database|quality analyst)\b", title, re.I):
                continue
            url = link["href"]
            if not re.fullmatch(r"https://infopark\.in/company-jobs/details/\d+/\d+", url):
                continue
            try:
                posted = datetime.strptime(cells[0].get_text(strip=True), "%d-%m-%Y")
                deadline = datetime.strptime(cells[3].get_text(strip=True), "%d %b %Y").date()
            except ValueError:
                continue
            if deadline < today or not 0 <= (today - posted.date()).days <= 30:
                continue
            jobs[url] = {
                "title": title,
                "company": cells[2].get_text(strip=True),
                "location": "Kerala, India (Infopark)",
                "remote": False,
                "types": [],
                "tags": [],
                "description": "",
                "date": posted.replace(tzinfo=KERALA_TZ).astimezone(timezone.utc).isoformat(),
                "url": url,
                "source": "Infopark Kerala",
            }
    with ThreadPoolExecutor(max_workers=3) as pool:
        return list(pool.map(infopark_description, jobs.values()))


def get_employer_jobs(board, country):
    endpoint = f"{SMARTRECRUITERS_API}/{board}/postings"
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)
    jobs = []
    for offset in (0, 100):
        response = requests.get(endpoint, params={"country": country, "limit": 100, "offset": offset},
                                headers=HEADERS, timeout=8)
        response.raise_for_status()
        rows = response.json()["content"]
        for row in rows:
            try:
                location = row["location"]
                if location["country"].lower() != country or row["visibility"] != "PUBLIC":
                    continue
                posted = datetime.fromisoformat(row["releasedDate"]).astimezone(timezone.utc)
                identifier = row["id"]
                if not cutoff <= posted <= now or not re.fullmatch(r"\d+", identifier):
                    continue
                country_name = COUNTRY_NAMES[country]
                label = ", ".join(dict.fromkeys(filter(None, [location.get("city"),
                                                             location.get("region"), country_name])))
                employment = row.get("typeOfEmployment", {}).get("label")
                work = "hybrid" if location.get("hybrid") else "remote" if location.get("remote") else "onsite"
                jobs.append({
                    "title": clean(row["name"]),
                    "company": clean(row["company"]["name"]),
                    "location": label,
                    "remote": work == "remote",
                    "work": work,
                    "types": [employment] if employment else [],
                    "tags": [],
                    "description": "",
                    "descriptionUrl": f"{endpoint}/{identifier}",
                    "date": posted.isoformat(),
                    "url": f"https://jobs.smartrecruiters.com/{board}/{identifier}",
                    "source": "Employer careers",
                })
            except (KeyError, TypeError, ValueError, AttributeError):
                continue
        if len(rows) < 100:
            break
    return jobs


def collect_jobs():
    results, errors = [], []
    with ThreadPoolExecutor(max_workers=6) as pool:
        pending = {source: pool.submit(get_jobs, source, url) for source, url in SOURCES.items()}
        pending["Infopark Kerala"] = pool.submit(get_infopark_jobs)
        for board, countries in EMPLOYER_BOARDS.items():
            for country in countries:
                pending[f"{board} ({COUNTRY_NAMES[country]})"] = pool.submit(get_employer_jobs, board, country)
        for source, future in pending.items():
            try:
                results.extend(future.result())
            except (requests.RequestException, KeyError, TypeError, ValueError):
                errors.append(source)
    results.sort(key=lambda job: job["date"], reverse=True)
    if len(errors) == len(pending):
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
