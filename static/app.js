import { Document, HeadingLevel, Packer, Paragraph } from "docx";
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
let resumeText = "";
let selectedJob;
let loading = false;

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
  const work = /\bhybrid\b/i.test(location) ? "hybrid" : job.remote ? "remote" :
    /\bon[- ]?site\b/i.test(location) ? "onsite" : "";
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

async function refresh() {
  if (loading) return;
  loading = true;
  byId("refresh").disabled = true;
  byId("job-status").textContent = "Loading job listings…";
  try {
    const response = await fetch(new URL("./jobs.json", import.meta.url), { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    jobs = data.jobs;
    unavailable = data.unavailable;
    updatedAt = data.updatedAt;
    renderJobs();
  } catch {
    byId("job-status").textContent = "Could not refresh listings. Please try again.";
  } finally {
    byId("refresh").disabled = false;
    loading = false;
  }
}

function openJob(job) {
  selectedJob = job;
  const title = element("h2", job.title);
  title.id = "detail-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const link = element("a", "Open original listing");
  link.href = job.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  byId("job-detail").replaceChildren(title, element("p", metadata(job), "muted"),
    element("div", job.description || "No description was provided by the source.", "description"), link);
  byId("draft-section").hidden = true;
  byId("detail-status").textContent = resumeText ? "" : "Upload a resume to generate a tailored draft.";
  byId("tailor").disabled = !resumeText || !job.description;
  dialog.showModal();
}

const stopWords = new Set(("about across also among and are based built can could each for from great have into job join looking must need our over people role should such than that the their them then there these they this through use using want was were what when where which who will with work would year years you your").split(" "));
function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) || [])
    .map(word => word.replace(/[.-]+$/, ""))
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function tailorResume(text, job) {
  const terms = new Map();
  for (const word of words(job.description)) terms.set(word, Math.min((terms.get(word) || 0) + 1, 4));
  for (const word of words(job.title + " " + job.tags.join(" "))) terms.set(word, (terms.get(word) || 0) + 4);
  const score = line => [...new Set(words(line))].reduce((sum, word) => sum + (terms.get(word) || 0), 0);
  const lines = text.split(/\r?\n/);
  const bullet = /^\s*[-–•●▪*]\s+/;
  const relevant = new Set();
  for (let index = 0; index < lines.length;) {
    if (!bullet.test(lines[index])) {
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && bullet.test(lines[end])) end++;
    const sorted = lines.slice(index, end).sort((a, b) => score(b) - score(a));
    lines.splice(index, sorted.length, ...sorted);
    for (const line of sorted) if (score(line) > 0) relevant.add(line.replace(bullet, ""));
    index = end;
  }
  const resumeWords = new Set(words(text));
  const missingTags = job.tags.filter(tag => {
    const tokens = words(tag);
    return tokens.length && tokens.some(word => !resumeWords.has(word));
  });
  const requirements = job.description.split(/\n+/).map(line => line.trim()).filter(line =>
    /\b(required|must have|minimum|certification|degree|years of experience)\b/i.test(line) &&
    line.length <= 260 && words(line).some(word => !resumeWords.has(word)));
  return {
    text: lines.join("\n"),
    relevantCount: relevant.size,
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
  renderJobs();
  byId("results").scrollIntoView({ block: "start", behavior: "smooth" });
};
byId("refresh").onclick = refresh;
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
    const text = (await readResume(file)).trim();
    if (!text) throw new Error("No selectable text was found. Try a text-based PDF or DOCX.");
    if (text.length > 50000) throw new Error("The resume exceeds 50,000 characters.");
    resumeText = text;
    status.textContent = file.name + " is ready for this session.";
  } catch (error) {
    status.textContent = (error.message || "Could not read the resume.") +
      (resumeText ? " Your previous resume is still active." : "");
  } finally {
    input.value = "";
    input.disabled = false;
  }
};

byId("tailor").onclick = () => {
  const result = tailorResume(resumeText, selectedJob);
  draft.value = result.text;
  byId("detail-status").textContent = result.relevantCount ?
    "Prioritized matching bullets within their original sections." :
    "No matching bullets were detected. Review and edit the extracted resume below.";
  byId("gaps").textContent = result.needsReview.length ?
    "Check these listing terms or requirements against your experience: " + result.needsReview.join(" · ") : "";
  byId("draft-section").hidden = false;
  draft.focus();
};

byId("download").onclick = async () => {
  const button = byId("download");
  button.disabled = true;
  try {
    const text = draft.value.trim();
    if (!text || text.length > 60000) throw new Error("Provide a draft of up to 60,000 characters.");
    const children = text.split(/\r?\n/).map(line => {
      if (/^\s*[-–•●▪*]\s+/.test(line)) {
        return new Paragraph({ text: line.replace(/^\s*[-–•●▪*]\s+/, ""), bullet: { level: 0 } });
      }
      if (line.length < 65 && /[A-Z]/.test(line) && line === line.toUpperCase()) {
        return new Paragraph({ text: line, heading: HeadingLevel.HEADING_1 });
      }
      return new Paragraph({ text: line });
    });
    const file = new Document({ sections: [{ children }] });
    const url = URL.createObjectURL(await Packer.toBlob(file));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tailored-resume.docx";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    byId("detail-status").textContent = error.message || "Download failed.";
  } finally {
    button.disabled = false;
  }
};
byId("print").onclick = () => {
  byId("printout").textContent = draft.value;
  window.print();
};
refresh();
