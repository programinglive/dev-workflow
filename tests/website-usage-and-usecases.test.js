import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const webRoot = path.join(repoRoot, "web");

test("USE_CASES_DATA defines all 13 required tutorials with complete metadata", async () => {
  const modPath = path.join(webRoot, "lib", "use-cases-data.ts");
  assert.ok(fs.existsSync(modPath), "web/lib/use-cases-data.ts must exist");
  const content = fs.readFileSync(modPath, "utf8");

  const requiredSlugs = [
    "solo-ai-developer",
    "bug-fix",
    "feature-development",
    "code-review-audit",
    "legacy-refactoring",
    "security-audit",
    "automated-testing",
    "pr-release-safety",
    "multi-agent-collaboration",
    "optional-zettly-planning",
    "optional-android-companion",
    "engineering-retrospectives",
    "organization-governance",
  ];

  assert.equal(requiredSlugs.length, 13, "Must have exactly 13 required use case slugs");

  for (const slug of requiredSlugs) {
    assert.ok(
      content.includes(`slug: "${slug}"`),
      `web/lib/use-cases-data.ts must define tutorial with slug '${slug}'`
    );
  }

  // Verify difficulty tiers
  assert.ok(content.includes('difficulty: "Beginner"'), "Must contain Beginner tutorials");
  assert.ok(content.includes('difficulty: "Intermediate"'), "Must contain Intermediate tutorials");
  assert.ok(content.includes('difficulty: "Advanced"'), "Must contain Advanced tutorials");

  // Verify structure
  assert.ok(content.includes("problem:"), "Tutorials must define problem statements");
  assert.ok(content.includes("whoItIsFor:"), "Tutorials must define target audience");
  assert.ok(content.includes("prerequisites:"), "Tutorials must define prerequisites");
  assert.ok(content.includes("toolsUsed:"), "Tutorials must define tools used");
  assert.ok(content.includes("steps:"), "Tutorials must define step-by-step workflow");
  assert.ok(content.includes("exampleTask:"), "Tutorials must include example start_task payload");
  assert.ok(content.includes("verificationSteps:"), "Tutorials must include verification steps");
  assert.ok(content.includes("limitationsAndTroubleshooting:"), "Tutorials must include limitations and troubleshooting");
});

test("HOW_TO_USE_STEPS defines 10 sequential onboarding steps with valid CLI commands", async () => {
  const modPath = path.join(webRoot, "lib", "how-to-use-data.ts");
  assert.ok(fs.existsSync(modPath), "web/lib/how-to-use-data.ts must exist");
  const content = fs.readFileSync(modPath, "utf8");

  // Check 10 steps
  for (let step = 1; step <= 10; step++) {
    assert.ok(
      content.includes(`step: ${step},`),
      `web/lib/how-to-use-data.ts must define step ${step}`
    );
  }

  // Check published npm package name in command
  assert.ok(
    content.includes("npm install -g @programinglive/dev-workflow"),
    "Step 1 must use the published @programinglive/dev-workflow package name"
  );
  assert.ok(content.includes("devwf setup"), "Step 2 must reference devwf setup");
  assert.ok(content.includes("devwf doctor"), "Step 2 must reference devwf doctor");
  assert.ok(content.includes("devwf fleet doctor"), "Step 4 must reference devwf fleet doctor");

  // Check Role taxonomy
  assert.ok(content.includes("ROLE_COMPARISON_TABLE"), "Must export ROLE_COMPARISON_TABLE");
  assert.ok(content.includes("DevWorkflow CLI (`devwf`)"), "Must document CLI role");
  assert.ok(content.includes("DevWorkflow MCP Server"), "Must document MCP server role");
  assert.ok(content.includes("External AI Coding Client"), "Must document AI coding client role");

  // Check Optional Integrations (Zettly + Android)
  assert.ok(content.includes("OPTIONAL_INTEGRATIONS_DATA"), "Must export OPTIONAL_INTEGRATIONS_DATA");
  assert.ok(content.includes("Zettly Integration"), "Must document optional Zettly integration");
  assert.ok(content.includes("DevWorkflow Android Companion"), "Must document optional Android Companion");
  assert.ok(
    content.includes("DevWorkflow is 100% functional without Zettly"),
    "Must document standalone guarantee for Zettly"
  );
  assert.ok(
    content.includes("The Android Companion is completely optional"),
    "Must document standalone guarantee for Android Companion"
  );
});

test("Navbar and Footer expose /how-to-use/ and /use-cases/ links", async () => {
  const navbarPath = path.join(webRoot, "components", "Navbar.tsx");
  const navbarContent = fs.readFileSync(navbarPath, "utf8");
  assert.ok(
    navbarContent.includes('{ href: "/how-to-use/", label: "How to Use" }'),
    "Navbar must include /how-to-use/ link"
  );
  assert.ok(
    navbarContent.includes('{ href: "/use-cases/", label: "Use Cases" }'),
    "Navbar must include /use-cases/ link"
  );

  const footerPath = path.join(webRoot, "components", "Footer.tsx");
  const footerContent = fs.readFileSync(footerPath, "utf8");
  assert.ok(footerContent.includes('href="/how-to-use/"'), "Footer must link to /how-to-use/");
  assert.ok(footerContent.includes('href="/use-cases/"'), "Footer must link to /use-cases/");
});

test("Homepage and Docs hub link to How to Use and Use Cases", async () => {
  const homePath = path.join(webRoot, "app", "page.tsx");
  const homeContent = fs.readFileSync(homePath, "utf8");
  assert.ok(homeContent.includes('href="/how-to-use/"'), "Homepage must link to /how-to-use/");
  assert.ok(homeContent.includes('href="/use-cases/"'), "Homepage must link to /use-cases/");

  const docsPath = path.join(webRoot, "app", "docs", "page.tsx");
  const docsContent = fs.readFileSync(docsPath, "utf8");
  assert.ok(docsContent.includes('href="/how-to-use/"'), "Docs hub must link to /how-to-use/");
  assert.ok(docsContent.includes('href="/use-cases/"'), "Docs hub must link to /use-cases/");
});

test("Use Cases dynamic route defines generateStaticParams for static export", async () => {
  const detailPath = path.join(webRoot, "app", "use-cases", "[slug]", "page.tsx");
  assert.ok(fs.existsSync(detailPath), "web/app/use-cases/[slug]/page.tsx must exist");
  const detailContent = fs.readFileSync(detailPath, "utf8");
  assert.ok(
    detailContent.includes("export async function generateStaticParams()"),
    "Dynamic route must export generateStaticParams for Next.js static export"
  );
});
