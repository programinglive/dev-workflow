/**
 * Search and social metadata for the start page.
 *
 * Metadata is judged on the page a visitor lands on, not on every crawled
 * route. A missing canonical or a 512 px social image on the homepage is a
 * product decision; the same omission on a deep archive page may be deliberate.
 */

import {
  getLinks,
  getMeta,
  getMetaByProperty,
  textContent,
} from "../html.js";

const TITLE_MIN = 10;
const TITLE_MAX = 65;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 170;
const SOCIAL_WIDTH = 1200;
const SOCIAL_HEIGHT = 630;

function push(findings, finding) {
  findings.push({ category: "seo", ...finding });
}

export function checkSeo({
  page,
  origin,
  sitemap = null,
  robots = null,
  parityPrefix = null,
  image = null,
} = {}) {
  const findings = [];
  if (!page || !page.body) return findings;

  const html = page.body;
  const url = page.finalUrl;

  const title = textContent(html, "title");
  if (title === "") {
    push(findings, {
      id: "seo.title_missing",
      severity: "warn",
      title: "The page has no title",
      detail: "A search result and a browser tab both need a title.",
      remediation: "Add a descriptive <title> of roughly 10 to 65 characters.",
      url,
      evidence: "<title> (absent)",
    });
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    push(findings, {
      id: "seo.title_length",
      severity: "warn",
      title: "The title length is outside the useful range",
      detail: `The title is ${title.length} characters; the target range is ${TITLE_MIN} to ${TITLE_MAX}.`,
      remediation: "Shorten or expand the title so it survives truncation and still describes the page.",
      url,
      evidence: title,
    });
  }

  const description = getMeta(html, "description");
  if (!description) {
    push(findings, {
      id: "seo.description_missing",
      severity: "warn",
      title: "The meta description is missing",
      detail: "The search engine will invent a snippet instead of using the page summary.",
      remediation: "Add a meta description of roughly 50 to 170 characters.",
      url,
      evidence: "meta[name=description] (absent)",
    });
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    push(findings, {
      id: "seo.description_length",
      severity: "warn",
      title: "The meta description length is outside the useful range",
      detail: `The description is ${description.length} characters; the target range is ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX}.`,
      remediation: "Rewrite the description so it is complete in a search result.",
      url,
      evidence: description,
    });
  }

  const canonical = getLinks(html).find((link) => link.rel === "canonical")?.href || null;
  if (!canonical) {
    push(findings, {
      id: "seo.canonical_missing",
      severity: "warn",
      title: "The canonical URL is missing",
      detail: "Duplicate routes have no declared preferred URL.",
      remediation: "Add <link rel=\"canonical\"> with the absolute preferred URL.",
      url,
      evidence: "link[rel=canonical] (absent)",
    });
  } else {
    let resolved = null;
    try {
      resolved = new URL(canonical, url);
    } catch {
      resolved = null;
    }
    if (!resolved) {
      push(findings, {
        id: "seo.canonical_invalid",
        severity: "warn",
        title: "The canonical URL is not a valid absolute URL",
        detail: `The declared canonical \"${canonical}\" cannot be resolved against ${url}.`,
        remediation: "Point rel=\"canonical\" at a real absolute URL.",
        url,
        evidence: `canonical: ${canonical}`,
      });
    } else {
      const actual = new URL(url);
      if (resolved.pathname !== actual.pathname) {
        push(findings, {
          id: "seo.canonical_mismatch",
          severity: "info",
          title: "The canonical URL points at a different path",
          detail: `The page is ${actual.pathname} but declares ${resolved.pathname} as canonical.`,
          remediation: "Confirm the canonical target is intentional and reachable.",
          url,
          evidence: `canonical: ${resolved.href}`,
        });
      }
    }
  }

  const robotsMeta = (getMeta(html, "robots") || "").toLowerCase();
  if (robotsMeta.includes("noindex")) {
    push(findings, {
      id: "seo.robots_noindex",
      severity: "warn",
      title: "The page asks search engines not to index it",
      detail: "A noindex directive on the entry page removes the site from search results.",
      remediation: "Remove noindex unless the page is intentionally private.",
      url,
      evidence: `robots: ${robotsMeta}`,
    });
  }

  const ogTitle = getMetaByProperty(html, "og:title");
  if (!ogTitle) {
    push(findings, {
      id: "seo.og_title_missing",
      severity: "info",
      title: "The Open Graph title is missing",
      detail: "A shared link falls back to the page title, which may be truncated.",
      remediation: "Add og:title so shared links read well.",
      url,
      evidence: "og:title (absent)",
    });
  }

  const ogDescription = getMetaByProperty(html, "og:description");
  if (!ogDescription) {
    push(findings, {
      id: "seo.og_description_missing",
      severity: "info",
      title: "The Open Graph description is missing",
      detail: "A shared link has no purpose-written summary.",
      remediation: "Add og:description for social previews.",
      url,
      evidence: "og:description (absent)",
    });
  }

  const ogImage = getMetaByProperty(html, "og:image");
  if (!ogImage) {
    push(findings, {
      id: "seo.og_image_missing",
      severity: "warn",
      title: "The Open Graph image is missing",
      detail: "A shared link has no visual preview.",
      remediation: "Add a 1200x630 og:image and declare its dimensions.",
      url,
      evidence: "og:image (absent)",
    });
  } else {
    const declaredWidth = Number(getMetaByProperty(html, "og:image:width") || 0);
    const declaredHeight = Number(getMetaByProperty(html, "og:image:height") || 0);
    const width = image?.actualWidth || declaredWidth || image?.declaredWidth || 0;
    const height = image?.actualHeight || declaredHeight || image?.declaredHeight || 0;

    if (!width || !height) {
      push(findings, {
        id: "seo.og_image_dimensions",
        severity: "warn",
        title: "The Open Graph image dimensions are unknown",
        detail: "Neither the page nor the image file declares usable dimensions.",
        remediation: "Publish a 1200x630 image and declare og:image:width and og:image:height.",
        url,
        evidence: `og:image: ${ogImage}`,
      });
    } else if (width !== SOCIAL_WIDTH || height !== SOCIAL_HEIGHT) {
      push(findings, {
        id: "seo.og_image_dimensions",
        severity: "warn",
        title: "The Open Graph image is not 1200x630",
        detail: `The social image is ${width}x${height}; most feeds crop or letterbox it.`,
        remediation: "Publish a 1200x630 social card and update og:image, og:image:width, and og:image:height.",
        url,
        evidence: `og:image: ${ogImage} (${width}x${height})`,
      });
    }

    if (image?.actualWidth && declaredWidth && image.actualWidth !== declaredWidth) {
      push(findings, {
        id: "seo.og_image_dimension_mismatch",
        severity: "info",
        title: "The declared Open Graph width does not match the file",
        detail: `The page declares ${declaredWidth} px but the image is ${image.actualWidth} px wide.`,
        remediation: "Keep the declared dimensions in sync with the published file.",
        url,
        evidence: `declared: ${declaredWidth}; actual: ${image.actualWidth}`,
      });
    }
  }

  const twitterCard = (getMeta(html, "twitter:card") || "").toLowerCase();
  if (!twitterCard) {
    push(findings, {
      id: "seo.twitter_card",
      severity: "warn",
      title: "The Twitter card type is missing",
      detail: "The platform chooses a card type, often a small square summary.",
      remediation: "Add twitter:card with summary_large_image when a wide image exists.",
      url,
      evidence: "twitter:card (absent)",
    });
  } else if (twitterCard === "summary") {
    push(findings, {
      id: "seo.twitter_card",
      severity: "warn",
      title: "The Twitter card is a small summary",
      detail: "A summary card renders a square thumbnail instead of a wide preview.",
      remediation: "Use summary_large_image with a 1200x630 image.",
      url,
      evidence: `twitter:card: ${twitterCard}`,
    });
  }

  if (!robots || robots.status >= 400) {
    push(findings, {
      id: "seo.robots_txt_missing",
      severity: "warn",
      title: "robots.txt is missing",
      detail: `The crawler received HTTP ${robots?.status ?? 0} for /robots.txt.`,
      remediation: "Publish a robots.txt that points to the sitemap and allows intended routes.",
      url: `${origin}/robots.txt`,
      evidence: `status: ${robots?.status ?? 0}`,
    });
  }

  if (!sitemap || sitemap.status >= 400 || sitemap.urlCount === 0) {
    push(findings, {
      id: "seo.sitemap_missing",
      severity: "warn",
      title: "The sitemap is missing or empty",
      detail: sitemap
        ? `The sitemap at ${sitemap.url} returned ${sitemap.status} with ${sitemap.urlCount} URLs.`
        : "No sitemap was found.",
      remediation: "Publish a sitemap.xml and reference it from robots.txt.",
      url: sitemap?.url || `${origin}/sitemap.xml`,
      evidence: sitemap ? `status: ${sitemap.status}; urls: ${sitemap.urlCount}` : "(absent)",
    });
  }

  if (parityPrefix) {
    const alternates = getLinks(html).filter((link) => link.rel === "alternate" && link.hreflang);
    if (alternates.length < 2) {
      push(findings, {
        id: "seo.hreflang_missing",
        severity: "warn",
        title: "The language alternates are missing",
        detail: `The site exposes ${parityPrefix} routes but the start page declares ${alternates.length} hreflang alternate(s).`,
        remediation: "Declare hreflang alternates for every language the site publishes.",
        url,
        evidence: alternates.map((link) => `${link.hreflang}: ${link.href}`).join("; ") || "(absent)",
      });
    }
  }

  return findings;
}
