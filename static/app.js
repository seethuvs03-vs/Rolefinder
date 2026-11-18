import { docxSummary, textSummary } from "./resume.js";
import mammoth from "mammoth";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

const byId = id => document.getElementById(id);
const form = byId("preferences");
const dialog = byId("detail");
const draft = byId("draft");
let preferences = Object.fromEntries(new FormData(form));
let jobs = [];
let unavailable = [];
let updatedAt;
let resume;
let activeDraft;
let selectedJob;
let loading = false;
let liveChecked = [];
let cachedSources = [];

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function phrases(value) {
  return value.toLowerCase().split(",").map(item => item.trim()).filter(Boolean);
}

const keralaCities = [
  "kochi", "cochin", "kakkanad", "ernakulam", "thiruvananthapuram", "trivandrum",
  "kazhakkoottam", "kozhikode", "calicut", "thrissur", "trichur", "kollam",
  "kottayam", "kannur", "palakkad", "alappuzha", "cherthala", "malappuram",
  "pathanamthitta", "kasaragod", "idukki", "wayanad"
];

function normalized(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsPhrase(value, phrase) {
  return Boolean(phrase) && (" " + value + " ").includes(" " + phrase + " ");
}

function locationMatches(location, query) {
  const place = normalized(location);
  const term = normalized(query);
  if (["uae", "u a e", "united arab emirates"].includes(term)) {
    return ["united arab emirates", "uae", "u a e", "dubai", "abu dhabi", "sharjah",
      "ajman", "ras al khaimah", "fujairah", "umm al quwain"].some(alias => containsPhrase(place, alias));
  }
  return containsPhrase(place, term) || (term === "kerala" &&
    keralaCities.some(city => containsPhrase(place, city)));
}

function roleRank(job) {
  const roles = phrases(preferences.roles);
  if (!roles.length) return 1;
  const title = normalized(job.title);
  let rank = 0;
  for (const role of roles) {
    const term = normalized(role);
    if (containsPhrase(title, term)) return 3;
    const tokens = term.split(" ");
    if (tokens.length > 1 && tokens.every(word => containsPhrase(title, word))) rank = 2;
    if (term === "data quality analyst" && rank < 2) {
      if (containsPhrase(title, "data quality") && /\b(associate|specialist|consultant)\b/.test(title)) rank = 1;
      if (containsPhrase(title, "data analyst") &&
          containsPhrase(normalized(job.description), "data quality")) rank = 1;
    }
  }
  return rank;
}

function matches(job) {
  const description = [job.title, job.description, ...(job.tags || [])].join(" ").toLowerCase();
  const location = job.location.toLowerCase();
  const work = job.work || (/\bhybrid\b/i.test(location) ? "hybrid" : job.remote ? "remote" :
    /\bon[- ]?site\b/i.test(location) ? "onsite" : "");
  const locations = phrases(preferences.locations);
  const type = preferences.employment.toLowerCase().replace("-", " ");
  const employmentText = [...job.types, ...job.tags, job.description].join(" ").toLowerCase().replaceAll("-", " ");
  const age = Date.now() - Date.parse(job.date);
  return age >= 0 && age <= Number(preferences.days) * 86400000 &&
    roleRank(job) > 0 &&
    (!locations.length || locations.some(place => locationMatches(location, place))) &&
    (!preferences.work || preferences.work === work) &&
    (!type || employmentText.includes(type)) &&
    phrases(preferences.include).every(term => description.includes(term)) &&
    !phrases(preferences.exclude).some(term => description.includes(term));
}

function metadata(job) {
  return [job.company, job.location || (job.remote ? "Remote · location unspecified" : "Location unspecified"),
    new Date(job.date).toLocaleDateString(undefined, { dateStyle: "medium" }), job.source].filter(Boolean).join(" · ");
}

function renderJobs() {
  const filtered = jobs.filter(matches).sort((a, b) => roleRank(b) - roleRank(a));
  const list = byId("jobs");
  list.replaceChildren();
  for (const job of filtered) {
    const card = element("article", "", "card");
    const info = element("div", "");
    info.append(element("h3", job.title), element("p", metadata(job), "muted"));
    if (phrases(preferences.roles).length && roleRank(job) === 1) {
      info.append(element("p", "Related role", "muted"));
    }
    if (job.tags.length) {
      const tags = element("div", "", "tags");
      tags.append(...job.tags.slice(0, 4).map(tag => element("span", tag, "tag")));
      info.append(tags);
    }
    const button = element("button", "View job");
    button.setAttribute("aria-label", "View " + job.title + " at " + job.company);
    button.onclick = () => openJob(job);
    card.append(info, button);
    list.append(card);
  }
  const count = filtered.length === 1 ? "1 matching job" : filtered.length + " matching jobs";
  byId("job-status").textContent = [count, updatedAt && "Feed updated " + new Date(updatedAt).toLocaleString(),
    liveChecked.length && "Checked live: " + liveChecked.join(", "),
    cachedSources.length && "Using saved listings: " + cachedSources.join(", "),
    unavailable.length && "Unavailable: " + unavailable.join(", ")].filter(Boolean).join(" · ");
  if (!filtered.length) list.append(element("p", jobs.length ?
    "No listings in the current feeds match these filters. Try a wider date range." :
    "No listings are available right now. Use Refresh to try again.", "panel muted"));
  if (!filtered.length && preferences.roles.trim() && phrases(preferences.locations).includes("kerala")) {
    const search = new URL("https://in.indeed.com/jobs");
    search.search = new URLSearchParams({
      q: phrases(preferences.roles).map(role => '"' + role.replaceAll('"', "") + '"').join(" OR "),
      l: "Kerala",
      fromage: preferences.days
    });
    const link = element("a", "Search Indeed India for these roles in Kerala");
    link.href = search.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const panel = element("p", "", "panel");
    panel.append(link);
    list.append(panel);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Could not read job feed.");
  return response.json();
}

function plainText(value) {
  const decoder = document.createElement("textarea");
  decoder.innerHTML = (typeof value === "string" ? value : "")
    .replace(/<(?:br\b[^>]*|\/p|\/li|\/div|\/h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "").replaceAll("<", "&lt;");
  return decoder.value.trim();
}

const liveSources = [
  { name: "Arbeitnow", url: "https://www.arbeitnow.com/api/job-board-api" },
  { name: "Remote OK", url: "https://remoteok.com/api" }
];

async function fetchLiveJobs(source) {
  const payload = await fetchJson(source.url);
  const remote = source.name === "Remote OK";
  const rows = remote && Array.isArray(payload) ? payload.slice(1) : payload?.data;
  if (!Array.isArray(rows)) throw new Error("Unrecognized job feed.");
  return rows.flatMap(row => {
    const title = plainText(row?.title || row?.position);
    const timestamp = Number(row?.created_at ?? row?.epoch) * 1000;
    if (!title || !Number.isFinite(timestamp) || timestamp <= 0 ||
        timestamp > Date.now() || typeof row.url !== "string" ||
        !URL.canParse(row.url) || new URL(row.url).protocol !== "https:") return [];
    return [{
      title,
      company: plainText(row.company_name || row.company),
      location: plainText(row.location),
      remote: remote || row.remote === true,
      types: Array.isArray(row.job_types) ? row.job_types.filter(type => typeof type === "string") : [],
      tags: Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === "string") : [],
      description: plainText(row.description).slice(0, 25000),
      date: new Date(timestamp).toISOString(),
      url: row.url,
      source: source.name
    }];
  });
}

async function refresh(checkLive = false) {
  if (loading) return;
  loading = true;
  const refreshButton = byId("refresh");
  const searchButton = form.querySelector('button[type="submit"]');
  refreshButton.disabled = true;
  searchButton.disabled = true;
  byId("job-status").textContent = checkLive ? "Checking job sources…" : "Loading job listings…";
  try {
    const [snapshot, ...results] = await Promise.allSettled([
      fetchJson(new URL("./jobs.json", import.meta.url)),
      ...(checkLive ? liveSources.map(fetchLiveJobs) : [])
    ]);
    if (snapshot.status === "fulfilled" && Array.isArray(snapshot.value?.jobs)) {
      jobs = snapshot.value.jobs;
      unavailable = snapshot.value.unavailable || [];
      updatedAt = snapshot.value.updatedAt;
    }
    const current = new Map();
    cachedSources = [];
    const missing = new Set(unavailable);
    for (const [index, result] of results.entries()) {
      const { name } = liveSources[index];
      if (result.status === "fulfilled") {
        current.set(name, result.value);
        missing.delete(name);
      } else if (jobs.some(job => job.source === name)) {
        cachedSources.push(name);
      } else {
        missing.add(name);
      }
    }
    unavailable = [...missing];
    liveChecked = [...current.keys()];
    const merged = [...jobs.filter(job => !current.has(job.source)), ...current.values()].flat();
    const unique = new Map(merged.map(job => [job.url, job]));
    jobs = [...unique.values()].sort((a, b) => b.date.localeCompare(a.date));
    renderJobs();
    if (snapshot.status === "rejected") {
      byId("job-status").textContent += " · Published feed could not be refreshed.";
    }
  } finally {
    refreshButton.disabled = false;
    searchButton.disabled = false;
    loading = false;
  }
}

async function openJob(job) {
  selectedJob = job;
  const title = element("h2", job.title);
  title.id = "detail-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const link = element("a", "Open original listing");
  link.href = job.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const description = element("div", job.description ||
    (job.descriptionUrl ? "Loading the employer’s description…" : "No description was provided by the source."),
    "description");
  byId("job-detail").replaceChildren(title, element("p", metadata(job), "muted"), description, link);
  byId("draft-section").hidden = true;
  byId("detail-status").textContent = resume ? "" : "Upload a resume to generate a tailored draft.";
  byId("tailor").disabled = !resume || !job.description;
  dialog.showModal();
  if (job.description || !job.descriptionUrl) return;
  try {
    const detail = await fetchJson(job.descriptionUrl);
    const sections = detail.jobAd?.sections;
    job.description = [sections?.jobDescription, sections?.qualifications, sections?.additionalInformation]
      .map(section => plainText(section?.text)).filter(Boolean).join("\n\n").slice(0, 25000);
  } catch {
    if (selectedJob === job && dialog.open) {
      description.textContent = "The employer’s description could not be loaded. Open the original listing.";
    }
    return;
  }
  if (selectedJob === job && dialog.open) {
    description.textContent = job.description || "No description was provided by the source.";
    byId("tailor").disabled = !resume || !job.description;
  }
}

const stopWords = new Set(("about across also among and are based built can could each for from great have into job join looking must need our over people role should such than that the their them then there these they this through use using want was were what when where which who will with work would year years you your").split(" "));
function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) || [])
    .map(word => word.replace(/[.-]+$/, ""))
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function tailorResume({ text, summary }, job) {
  const terms = new Map();
  for (const word of words(job.description)) terms.set(word, Math.min((terms.get(word) || 0) + 1, 4));
  for (const word of words(job.title + " " + job.tags.join(" "))) terms.set(word, (terms.get(word) || 0) + 4);
  const score = line => [...new Set(words(line))].reduce((sum, word) => sum + (terms.get(word) || 0), 0);
  const original = summary?.original || "";
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(original)]
    .map(({ segment }) => segment.trim());
  const bullet = /^\s*[-–•●▪*]\s+/;
  const evidence = text.split(/\r?\n/).filter(line => bullet.test(line))
    .map(line => line.replace(bullet, "").trim())
    .filter(line => line.length >= 25 && line.length <= 180 && score(line) > 0 &&
      !original.toLowerCase().includes(line.toLowerCase().replace(/[.!?]$/, "")))
    .sort((a, b) => score(b) - score(a))[0];
  if (evidence) {
    sentences.push(/[.!?]$/.test(evidence) ? evidence : evidence + ".");
  }
  sentences.sort((a, b) => score(b) - score(a));
  const tailored = sentences.slice(0, Math.max(1, sentences.length - Number(Boolean(evidence && original)))).join(" ");
  const resumeWords = new Set(words(text));
  const missingTags = job.tags.filter(tag => {
    const tokens = words(tag);
    return tokens.length && tokens.some(word => !resumeWords.has(word));
  });
  const requirements = job.description.split(/\n+/).map(line => line.trim()).filter(line =>
    /\b(required|must have|minimum|certification|degree|years of experience)\b/i.test(line) &&
    line.length <= 260 && words(line).some(word => !resumeWords.has(word)));
  return {
    text: tailored,
    needsReview: [...new Set([...missingTags, ...requirements])].slice(0, 6)
  };
}

try {
  const saved = JSON.parse(localStorage.getItem("rolefinder-preferences") || "{}");
  for (const field of form.elements) {
    if (field.name && typeof saved[field.name] === "string") field.value = saved[field.name];
  }
  preferences = Object.fromEntries(new FormData(form));
} catch {
  // Storage can be disabled in private browsing.
}

form.onsubmit = event => {
  event.preventDefault();
  preferences = Object.fromEntries(new FormData(form));
  try {
    localStorage.setItem("rolefinder-preferences", JSON.stringify(preferences));
  } catch {
    // Preferences still apply to the current page.
  }
  refresh(true);
  byId("results").scrollIntoView({ block: "start", behavior: "smooth" });
};
byId("refresh").onclick = () => refresh(true);
async function readResume(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "txt") return file.text();
  if (extension === "docx") {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      { convertImage: mammoth.images.imgElement(() => ({})) }
    );
    const content = document.createElement("template");
    content.innerHTML = result.value;
    return [...content.content.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li")].flatMap(block => {
      if (block.tagName !== "LI" && block.closest("li")) return [];
      const copy = block.cloneNode(true);
      for (const list of copy.querySelectorAll("ol,ul")) list.remove();
      for (const breakElement of copy.querySelectorAll("br")) breakElement.replaceWith("\n");
      const text = copy.textContent.trim();
      if (!text) return [];
      return block.tagName === "LI" ? "• " + text.replaceAll("\n", " ") : text;
    }).join("\n");
  }
  if (extension === "pdf") {
    const task = getDocument({ data: await file.arrayBuffer(), isEvalSupported: false });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 30) throw new Error("Choose a PDF of up to 30 pages.");
      const pages = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => "str" in item ?
          item.str + (item.hasEOL ? "\n" : "") : "").join(""));
      }
      return pages.join("\n");
    } finally {
      await task.destroy();
    }
  }
  throw new Error("Choose a PDF, DOCX or TXT resume.");
}

byId("resume-file").onchange = async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  const status = byId("resume-status");
  status.textContent = "Reading resume…";
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("Choose a resume up to 5 MB.");
    const text = await readResume(file);
    if (!text.trim()) throw new Error("No selectable text was found. Try a text-based PDF or DOCX.");
    if (text.length > 50000) throw new Error("The resume exceeds 50,000 characters.");
    const extension = file.name.split(".").pop().toLowerCase();
    const editableSummary = extension === "docx" ? await docxSummary(await file.arrayBuffer()) : textSummary(text);
    const summary = editableSummary || textSummary(text);
    resume = { text, extension, summary, editableSummary };
    status.textContent = file.name + " is ready for this session.";
  } catch (error) {
    status.textContent = (error.message || "Could not read the resume.") +
      (resume ? " Your previous resume is still active." : "");
  } finally {
    input.value = "";
    input.disabled = false;
  }
};

byId("tailor").onclick = () => {
  const result = tailorResume(resume, selectedJob);
  activeDraft = resume;
  draft.value = result.text;
  const canDownload = resume.extension !== "pdf" && Boolean(resume.editableSummary);
  byId("download").hidden = !canDownload;
  byId("download").textContent = resume.extension === "docx" ? "Download DOCX" : "Download TXT";
  byId("detail-status").textContent = !result.text ?
    "Enter a summary based on your experience, then copy it into the original resume." : canDownload ?
    "Review the summary before downloading your resume." :
    "Copy your edited summary into the original resume to preserve its layout.";
  byId("gaps").textContent = result.needsReview.length ?
    "Check these listing terms or requirements against your experience: " + result.needsReview.join(" · ") : "";
  byId("draft-section").hidden = false;
  draft.focus();
};

byId("download").onclick = async () => {
  const button = byId("download");
  button.disabled = true;
  try {
    const summary = draft.value.trim().replace(/\s*\r?\n\s*/g, " ");
    if (!summary || summary.length > 60000) throw new Error("Enter a summary of up to 60,000 characters.");
    const { extension } = activeDraft;
    const updatedResume = await activeDraft.editableSummary.replace(summary);
    const file = extension === "docx" ? updatedResume : new Blob([updatedResume], { type: "text/plain" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tailored-resume." + extension;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    byId("detail-status").textContent = error.message || "Download failed.";
  } finally {
    button.disabled = false;
  }
};
refresh();
