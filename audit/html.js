/**
 * Small, dependency-free HTML helpers for the site audit.
 *
 * The audit never renders a page, so it only needs the handful of tag shapes
 * the checks inspect. These helpers are deliberately tolerant: a malformed page
 * must produce findings, not a parser exception.
 */

const ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&nbsp;", " "],
]);

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi, (match) => {
    return ENTITIES.get(match.toLowerCase()) ?? match;
  });
}

export function getAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = String(tag ?? "").match(pattern);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

export function findTags(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return String(html ?? "").match(pattern) ?? [];
}

export function findTagBlocks(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "gi");
  const blocks = [];
  let match;
  while ((match = pattern.exec(String(html ?? ""))) !== null) {
    blocks.push({ tag: match[0].slice(0, match[0].indexOf(">") + 1), inner: match[1] });
  }
  return blocks;
}

export function textContent(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
  const match = String(html ?? "").match(pattern);
  return match ? stripTags(match[1]).trim() : "";
}

export function stripTags(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function getMeta(html, key) {
  const tags = findTags(html, "meta");
  const wanted = key.toLowerCase();
  for (const tag of tags) {
    const name = (getAttribute(tag, "name") || getAttribute(tag, "property") || "").toLowerCase();
    if (name === wanted) return getAttribute(tag, "content");
  }
  return null;
}

export function getMetaByProperty(html, key) {
  return getMeta(html, key);
}

export function getLinks(html) {
  return findTags(html, "link").map((tag) => ({
    rel: (getAttribute(tag, "rel") || "").toLowerCase(),
    href: getAttribute(tag, "href"),
    hreflang: getAttribute(tag, "hreflang"),
  }));
}

export function getAnchors(html) {
  return findTagBlocks(html, "a").map((block) => ({
    href: getAttribute(block.tag, "href"),
    text: stripTags(block.inner),
    ariaLabel: getAttribute(block.tag, "aria-label"),
  }));
}

export function getImages(html) {
  return findTags(html, "img").map((tag) => ({
    src: getAttribute(tag, "src"),
    alt: getAttribute(tag, "alt"),
    role: getAttribute(tag, "role"),
  }));
}

export function getFormControls(html) {
  const controls = [];
  for (const name of ["input", "select", "textarea"]) {
    for (const tag of findTags(html, name)) {
      const type = (getAttribute(tag, "type") || "").toLowerCase();
      if (name === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      controls.push({
        name,
        id: getAttribute(tag, "id"),
        ariaLabel: getAttribute(tag, "aria-label"),
        ariaLabelledBy: getAttribute(tag, "aria-labelledby"),
        title: getAttribute(tag, "title"),
        raw: tag,
      });
    }
  }
  return controls;
}

export function getLabelTargets(html) {
  return findTags(html, "label")
    .map((tag) => getAttribute(tag, "for"))
    .filter((value) => typeof value === "string" && value !== "");
}

/**
 * Inner HTML of every label block. A control nested inside one of these blocks
 * already has an accessible name, even without a for/id pair.
 */
export function getLabelBodies(html) {
  return findTagBlocks(html, "label").map((block) => block.inner);
}

export function getIds(html) {
  const ids = [];
  const pattern = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = pattern.exec(String(html ?? ""))) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value !== "") ids.push(value);
  }
  return ids;
}

export function getHtmlLang(html) {
  const tag = findTags(html, "html")[0];
  return tag ? getAttribute(tag, "lang") : null;
}

export function countTag(html, name) {
  return findTags(html, name).length;
}

/**
 * Reads image dimensions from the bytes of a PNG, GIF, JPEG, or WebP file.
 * Returns null when the format is unsupported or the buffer is truncated.
 */
export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;

  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  if (buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { width, height };
    }
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length <= 0) break;
      offset += 2 + length;
    }
  }

  return null;
}
