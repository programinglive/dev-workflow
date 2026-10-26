// Import attributes replace the removed `assert` syntax. TypeScript 7 rejects
// `assert { type: "json" }` with TS2880; the modern form is `with`.
import pkg from "../package.json" with { type: "json" };

export const WEB_VERSION = pkg.version;
