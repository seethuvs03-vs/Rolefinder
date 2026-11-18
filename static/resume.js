import JSZip from "jszip";

const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const documentPath = "word/document.xml";
const summaryHeading = /^(?:(?:professional|career|executive|personal|profile)\s+)?(?:summary|profile|objective|about me)\s*:?$/i;
const sectionHeading = /^(?:(?:professional|work|relevant|technical|core|key|career)\s+)?(?:experience|employment(?: history)?|education|skills|competencies|qualifications|projects|certifications|achievements|awards|publications|languages|interests|references|activities|volunteering|training|contact(?: information)?|work history|additional information)\s*:?$/i;

function isSummaryParagraph(text) {
  return Boolean(text && !summaryHeading.test(text) && !sectionHeading.test(text) && !/^[-–•●▪*]\s/.test(text));
}

export function textSummary(text) {
  const lines = [...text.matchAll(/[^\r\n]+/g)];
  const headings = lines.filter(([line]) => summaryHeading.test(line.trim()));
  if (headings.length !== 1) return;
  const next = lines.slice(lines.indexOf(headings[0]) + 1).find(([line]) => line.trim());
  if (!next) return;
  const original = next[0].trim();
  if (!isSummaryParagraph(original)) return;
  const start = next.index + next[0].indexOf(original);
  return { original, replace: summary => text.slice(0, start) + summary + text.slice(start + original.length) };
}

function wordChildren(node, localName) {
  return [...node.children].filter(child => child.namespaceURI === wordNamespace && child.localName === localName);
}

function paragraphText(paragraph) {
  return [...paragraph.getElementsByTagNameNS(wordNamespace, "t")].map(node => node.textContent).join("");
}

export async function docxSummary(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file(documentPath);
  if (!part) throw new Error("No document body was found in the DOCX.");
  const xml = new DOMParser().parseFromString(await part.async("string"), "application/xml");
  if (xml.getElementsByTagNameNS("*", "parsererror").length) throw new Error("Could not read the DOCX document body.");
  const paragraphs = [...xml.getElementsByTagNameNS(wordNamespace, "p")];
  const headings = paragraphs.filter(paragraph => summaryHeading.test(paragraphText(paragraph).trim()));
  if (headings.length !== 1) return;
  let paragraph = headings[0].nextElementSibling;
  while (paragraph && paragraph.namespaceURI === wordNamespace && paragraph.localName === "p" &&
    !paragraphText(paragraph).trim() && paragraph.children.length === wordChildren(paragraph, "pPr").length) {
    paragraph = paragraph.nextElementSibling;
  }
  if (paragraph?.namespaceURI !== wordNamespace || paragraph.localName !== "p") return;
  const original = paragraphText(paragraph);
  if (!isSummaryParagraph(original.trim())) return;
  const runs = wordChildren(paragraph, "r");
  const properties = wordChildren(paragraph, "pPr")[0];
  const style = properties && wordChildren(properties, "pStyle")[0]?.getAttributeNS(wordNamespace, "val");
  if (properties?.getElementsByTagNameNS(wordNamespace, "outlineLvl").length ||
    properties?.getElementsByTagNameNS(wordNamespace, "numPr").length ||
    /^(?:heading|title)/i.test(style || "")) return;
  if (paragraph.children.length !== runs.length + Number(Boolean(properties))) return;
  const nodes = runs.flatMap(run => wordChildren(run, "t"));
  if (!nodes.length || nodes.some(node => /[\r\n]/.test(node.textContent)) ||
    runs.some(run => run.children.length !== wordChildren(run, "rPr").length + wordChildren(run, "t").length)) return;
  const lengths = nodes.map(node => Array.from(node.textContent).length);
  return {
    original: original.trim(),
    async replace(summary) {
      if (summary === original.trim()) {
        return new Blob([bytes], { type: docxMimeType });
      }
      const characters = Array.from(summary);
      let offset = 0;
      nodes.forEach((node, index) => {
        const end = index === nodes.length - 1 ? characters.length : offset + lengths[index];
        const value = characters.slice(offset, end).join("");
        node.textContent = value;
        if (/^\s|\s$/.test(value)) node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
        offset = end;
      });
      zip.file(documentPath, new XMLSerializer().serializeToString(xml));
      return zip.generateAsync({
        type: "blob",
        mimeType: docxMimeType
      });
    }
  };
}
