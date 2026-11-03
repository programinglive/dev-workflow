import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Artefak `netlify deploy --build` yang tersimpan di working tree lokal.
    // Tanpa ini `npm run lint` MERAH di mesin pengembang karena 12 error di
    // dalam bundel minified Next (`no-this-alias`), sementara CI hijau karena
    // checkout bersih tidak punya folder ini. Lint yang merah karena artefak
    // build akan diabaikan orang, dan error sungguhan tenggelam di dalamnya.
    ".netlify/**",
  ]),
]);

export default eslintConfig;
