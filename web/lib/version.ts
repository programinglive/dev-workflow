// The website shows the version of the package it documents, not its own.
//
// `web/package.json` used to carry a separate number (1.9.1) while the server
// was already at 1.13.x, because `standard-version` only bumps the root package.
// The site then advertised a version nobody shipped. Reading the root manifest
// keeps one source of truth: the release commit moves the number, and the next
// build picks it up without anyone editing a page.
import pkg from "../../package.json" with { type: "json" };

export const WEB_VERSION = pkg.version;
