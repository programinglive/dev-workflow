/**
 * Static accessibility heuristics.
 *
 * This is not axe and it does not claim to be. It catches the failures that are
 * visible in the HTML a crawler already has: a missing language, an image with
 * no alternative, a form control with no name, a duplicated id. Anything that
 * needs layout or a real accessibility tree is out of scope for v1.
 */

import {
  countTag,
  getAnchors,
  getFormControls,
  getHtmlLang,
  getIds,
  getImages,
  getLabelBodies,
  getLabelTargets,
  getMeta,
} from "../html.js";

const GENERIC_LINK_TEXT = new Set([
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this",
]);

export function checkA11y({ page } = {}) {
  const findings = [];
  if (!page || !page.body) return findings;

  const html = page.body;
  const url = page.finalUrl;

  if (!getHtmlLang(html)) {
    findings.push({
      id: "a11y.lang_missing",
      category: "a11y",
      severity: "warn",
      title: "The document language is missing",
      detail: "Screen readers cannot choose the correct pronunciation rules.",
      remediation: "Set a lang attribute on the <html> element.",
      url,
      evidence: "<html lang> (absent)",
    });
  }

  const headings = countTag(html, "h1");
  if (headings !== 1) {
    findings.push({
      id: "a11y.heading_structure",
      category: "a11y",
      severity: "warn",
      title: "The page does not have exactly one h1",
      detail: `The page contains ${headings} h1 element(s).`,
      remediation: "Use one h1 for the page subject and h2 or h3 for sections.",
      url,
      evidence: `h1 count: ${headings}`,
    });
  }

  const images = getImages(html);
  const imagesWithoutAlt = images.filter((image) => image.alt === null);
  if (imagesWithoutAlt.length > 0) {
    findings.push({
      id: "a11y.image_alt_missing",
      category: "a11y",
      severity: "warn",
      title: "Images are missing alternative text",
      detail: `${imagesWithoutAlt.length} of ${images.length} image(s) have no alt attribute.`,
      remediation: "Add meaningful alt text, or alt=\"\" for purely decorative images.",
      url,
      evidence: imagesWithoutAlt.slice(0, 5).map((image) => image.src || "(no src)").join(", "),
    });
  }

  const labelTargets = new Set(getLabelTargets(html));
  const labelBodies = getLabelBodies(html);
  const unnamed = getFormControls(html).filter((control) => {
    if (control.ariaLabel || control.ariaLabelledBy || control.title) return false;
    if (control.id && labelTargets.has(control.id)) return false;
    if (control.raw && labelBodies.some((body) => body.includes(control.raw))) return false;
    return true;
  });
  if (unnamed.length > 0) {
    findings.push({
      id: "a11y.input_label_missing",
      category: "a11y",
      severity: "warn",
      title: "Form controls have no accessible name",
      detail: `${unnamed.length} form control(s) have no label, aria-label, aria-labelledby, or title.`,
      remediation: "Associate a <label for> or provide an aria-label for every control.",
      url,
      evidence: unnamed.slice(0, 5).map((control) => `${control.name}${control.id ? `#${control.id}` : ""}`).join(", "),
    });
  }

  const seen = new Map();
  for (const id of getIds(html)) {
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    findings.push({
      id: "a11y.duplicate_id",
      category: "a11y",
      severity: "warn",
      title: "The page contains duplicate ids",
      detail: `${duplicates.length} id value(s) appear more than once.`,
      remediation: "Make every id unique; labels and ARIA references resolve to the first match.",
      url,
      evidence: duplicates.slice(0, 5).join(", "),
    });
  }

  const vagueLinks = getAnchors(html).filter((anchor) => {
    const text = (anchor.text || anchor.ariaLabel || "").trim().toLowerCase();
    return text === "" || GENERIC_LINK_TEXT.has(text);
  });
  if (vagueLinks.length > 0) {
    findings.push({
      id: "a11y.link_text",
      category: "a11y",
      severity: "info",
      title: "Some links have vague or empty text",
      detail: `${vagueLinks.length} link(s) do not describe their destination.`,
      remediation: "Write link text that makes sense when read out of context.",
      url,
      evidence: vagueLinks.slice(0, 5).map((anchor) => anchor.href || "(no href)").join(", "),
    });
  }

  const anchors = getAnchors(html);
  const skipLink = anchors.some((anchor) => {
    const href = anchor.href || "";
    return href.startsWith("#") && href.length > 1 && /skip/i.test(anchor.text || "");
  });
  if (!skipLink) {
    findings.push({
      id: "a11y.skip_link_missing",
      category: "a11y",
      severity: "info",
      title: "No skip link was found",
      detail: "Keyboard users must tab through the navigation on every page.",
      remediation: "Add a visible-on-focus link to the main content.",
      url,
      evidence: "a[href^=#] with skip text (absent)",
    });
  }

  const viewport = getMeta(html, "viewport");
  if (!viewport) {
    findings.push({
      id: "a11y.viewport",
      category: "a11y",
      severity: "warn",
      title: "The viewport meta tag is missing",
      detail: "Mobile browsers fall back to a desktop-width layout.",
      remediation: "Add a viewport meta tag with width=device-width, initial-scale=1.",
      url,
      evidence: "meta[name=viewport] (absent)",
    });
  } else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?\b/i.test(viewport)) {
    findings.push({
      id: "a11y.viewport",
      category: "a11y",
      severity: "warn",
      title: "The viewport blocks zoom",
      detail: "The page prevents users from zooming, which removes a key accessibility affordance.",
      remediation: "Allow user scaling in the viewport meta tag.",
      url,
      evidence: viewport,
    });
  }

  return findings;
}
