const byId = id => document.getElementById(id);
const form = byId("preferences");
const dialog = byId("detail");
const draft = byId("draft");
let preferences = Object.fromEntries(new FormData(form));
let jobs = [];
let unavailable = [];
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

function matches(job) {
  const description = [job.title, job.description, ...(job.tags || [])].join(" ").toLowerCase();
  const location = job.location.toLowerCase();
  const title = job.title.toLowerCase();
  const work = /\bhybrid\b/i.test(location) ? "hybrid" : job.remote ? "remote" :
    /\bon[- ]?site\b/i.test(location) ? "onsite" : "";
  const roles = phrases(preferences.roles);
  const locations = phrases(preferences.locations);
  const type = preferences.employment.toLowerCase().replace("-", " ");
  const employmentText = [...job.types, ...job.tags, job.description].join(" ").toLowerCase().replaceAll("-", " ");
  const age = Date.now() - Date.parse(job.date);
  return age >= 0 && age <= Number(preferences.days) * 86400000 &&
    (!roles.length || roles.some(role => title.includes(role))) &&
    (!locations.length || locations.some(place => location.includes(place))) &&
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
  const filtered = jobs.filter(matches);
  const list = byId("jobs");
  list.replaceChildren();
  for (const job of filtered) {
    const card = element("article", "", "card");
    const info = element("div", "");
    info.append(element("h3", job.title), element("p", metadata(job), "muted"));
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
  byId("job-status").textContent = count + (unavailable.length ? " · Unavailable: " + unavailable.join(", ") : "");
  if (!filtered.length) list.append(element("p", jobs.length ?
    "No listings match these filters. Try a wider date range or a broader location." :
    "No listings are available right now. Use Refresh to try again.", "panel muted"));
}

async function refresh() {
  if (loading) return;
  loading = true;
  byId("refresh").disabled = true;
  byId("job-status").textContent = "Loading job listings…";
  try {
    const response = await fetch("/api/jobs");
    if (!response.ok) throw new Error();
    const data = await response.json();
    jobs = data.jobs;
    unavailable = data.unavailable;
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
byId("resume-file").onchange = async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  const status = byId("resume-status");
  status.textContent = "Reading resume…";
  try {
    const data = new FormData();
    data.append("resume", file);
    const response = await fetch("/api/resume", { method: "POST", body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    resumeText = result.text;
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
    const response = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: draft.value })
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob());
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
