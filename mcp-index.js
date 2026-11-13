/**
 * Central MCP Ecosystem Index & Context-Aware Recommender.
 *
 * Since `dev-workflow` is always the first MCP server invoked in every coding
 * session (`start_task`, `get_workflow_status`, `continue_workflow`), it acts
 * as the discovery index and router for all other MCP servers available across
 * our devices and central gateway (`http://127.0.0.1:3200/sse`).
 */

export const MCP_ECOSYSTEM_INDEX = Object.freeze([
  {
    id: "notify",
    serverName: "central-gateway (notify_*)",
    endpoint: "http://127.0.0.1:3200/sse -> Notification Hub (127.0.0.1:3099)",
    category: "Notifications & Real-Time Events",
    summary:
      "Send multi-channel notifications (Discord, Pusher Channels ap1, Email, Telegram, WhatsApp, Slack), inspect topic routing (alerts, backup, security, finance, ops), and query delivery logs.",
    tools: [
      {
        name: "notify_send",
        description: "Send a notification to a topic (alerts, backup, security, finance, ops) or explicit channels (discord, pusher, email, telegram, whatsapp, slack).",
        keywords: ["notify", "notification", "alert", "pusher", "discord", "webhook", "email", "telegram", "whatsapp", "slack", "broadcast"],
      },
      {
        name: "notify_list_topics",
        description: "List configured notification topics and their mapped delivery channels.",
        keywords: ["topic", "topics", "routing", "channel", "channels"],
      },
      {
        name: "notify_list_logs",
        description: "List recent notification delivery logs and statuses from Notification Hub / PocketBase.",
        keywords: ["delivery", "notification log", "logs", "retry"],
      },
    ],
    triggers: {
      keywords: [
        "notify",
        "notification",
        "notification-hub",
        "pusher",
        "discord",
        "webhook",
        "telegram",
        "whatsapp",
        "slack",
        "smtp",
        "email alert",
        "backup alert",
        "security alert",
        "3099",
      ],
      pathPatterns: ["notification-hub", "notify"],
    },
  },
  {
    id: "pocketbase",
    serverName: "central-gateway (pb_*) / pocketbase",
    endpoint: "http://127.0.0.1:3200/sse -> PocketBase (127.0.0.1:8090)",
    category: "Database, Collections & Unified Auth",
    summary:
      "Inspect and manage PocketBase collections, schemas, records, superuser/activity_users authentication, and persistence stores.",
    tools: [
      {
        name: "pb_list_collections",
        description: "List all PocketBase collections and their schemas.",
        keywords: ["collection", "collections", "schema", "table", "pocketbase"],
      },
      {
        name: "pb_get_collection",
        description: "Inspect fields, indexes, and API rules of a specific PocketBase collection.",
        keywords: ["collection", "schema", "fields", "rules", "auth"],
      },
      {
        name: "pb_create_collection",
        description: "Create a new PocketBase collection with typed fields and access rules.",
        keywords: ["create collection", "new collection", "migration", "schema"],
      },
      {
        name: "pb_list_records",
        description: "Query records in a PocketBase collection with filter, sort, and pagination.",
        keywords: ["records", "query", "list records", "filter", "activity_users", "notification_logs"],
      },
      {
        name: "pb_create_record",
        description: "Insert a new record into a PocketBase collection.",
        keywords: ["insert", "create record", "save record"],
      },
      {
        name: "pb_update_record",
        description: "Update an existing PocketBase record by ID.",
        keywords: ["update record", "patch record"],
      },
      {
        name: "pb_delete_record",
        description: "Delete a PocketBase record by ID.",
        keywords: ["delete record", "remove record"],
      },
      {
        name: "pb_health",
        description: "Check PocketBase server health and connectivity.",
        keywords: ["pocketbase health", "8090"],
      },
    ],
    triggers: {
      keywords: [
        "pocketbase",
        "pb_",
        "collection",
        "collections",
        "activity_users",
        "notification_logs",
        "_superusers",
        "8090",
        "record",
        "records",
      ],
      pathPatterns: ["pocketbase", "central-mcp-gateway"],
    },
  },
  {
    id: "infra-knowledge",
    serverName: "infra-knowledge / central-gateway (infra_*)",
    endpoint: "Local MCP + http://127.0.0.1:3200/sse",
    category: "Infrastructure, VMs, SSH & Deployment Topology",
    summary:
      "Discover servers/VMs, IP addresses, Tailscale nodes, domains, repositories, deployment paths, fleet health, and run commands via SSH.",
    tools: [
      {
        name: "infra_overview",
        description: "High-level summary of all infrastructure VMs, accounts, domains, and services.",
        keywords: ["overview", "topology", "inventory", "infrastructure", "infra"],
      },
      {
        name: "find_instance",
        description: "Find VM/server details by name, IP, or service.",
        keywords: ["vm", "instance", "server", "ip", "tailscale"],
      },
      {
        name: "ssh_vm",
        description: "Execute a shell command on a target VM over SSH.",
        keywords: ["ssh", "remote command", "systemd", "systemctl", "journalctl", "nginx", "docker", "deploy"],
      },
      {
        name: "deploy_path",
        description: "Look up the canonical deployment procedure, directory, and service name for an app.",
        keywords: ["deploy", "deployment", "service", "production", "staging", "blue-green"],
      },
      {
        name: "find_domain",
        description: "Look up domain routing, reverse proxy, and SSL/TLS details.",
        keywords: ["domain", "dns", "subdomain", "vhost", "nginx", "ssl"],
      },
      {
        name: "find_repo",
        description: "Find repository URL, local checkout path, and branch conventions.",
        keywords: ["repo", "repository", "git", "github"],
      },
      {
        name: "fleet_health",
        description: "Check CPU, RAM, disk, and service health across all VMs and devices.",
        keywords: ["fleet", "health", "cpu", "ram", "disk", "monitoring", "uptime"],
      },
      {
        name: "search_knowledge",
        description: "Full-text search across the infrastructure knowledge base.",
        keywords: ["knowledge", "docs", "runbook", "architecture"],
      },
    ],
    triggers: {
      keywords: [
        "infra",
        "infrastructure",
        "vm",
        "ssh",
        "ssh_vm",
        "tailscale",
        "systemd",
        "systemctl",
        "nginx",
        "deploy",
        "deployment",
        "fleet",
        "server",
        "vhost",
        "pm2",
      ],
      pathPatterns: ["infra", "deploy", "ops"],
    },
  },
  {
    id: "clinic-helper",
    serverName: "clinic-helper",
    endpoint: "Local MCP (Clinic ERP workspace)",
    category: "Clinic ERP (Laravel / Livewire / Beautyworld)",
    summary:
      "Diagnose Clinic ERP environment, run scoped Paratest suites, execute Artisan/Composer commands safely, inspect release plans, and query Clinic domain knowledge.",
    tools: [
      {
        name: "clinic_doctor",
        description: "Verify PHP, Composer, database, Redis, and environment readiness for Clinic ERP.",
        keywords: ["doctor", "clinic", "environment", "laravel", "php"],
      },
      {
        name: "clinic_run",
        description: "Run allowed Artisan, Composer, or Paratest commands inside the Clinic workspace.",
        keywords: ["artisan", "paratest", "composer", "migrate", "tinker", "test"],
      },
      {
        name: "clinic_scope",
        description: "Identify affected modules, Livewire components, and tests for a Clinic change.",
        keywords: ["scope", "livewire", "module", "invoice", "patient", "treatment", "pos", "stock"],
      },
      {
        name: "clinic_knowledge",
        description: "Query Clinic ERP architecture, business rules, and module conventions.",
        keywords: ["clinic knowledge", "business rule", "erp", "beautyworld"],
      },
      {
        name: "clinic_release_plan",
        description: "Generate or inspect the Blue-Green release plan and checklist for Clinic ERP.",
        keywords: ["release plan", "blue-green", "rollout"],
      },
      {
        name: "clinic_release_status",
        description: "Check current Clinic ERP release version and deployment status.",
        keywords: ["release status", "version"],
      },
    ],
    triggers: {
      keywords: [
        "clinic",
        "clinic-helper",
        "clinic_doctor",
        "clinic_run",
        "laravel",
        "livewire",
        "artisan",
        "paratest",
        "filament",
        "eloquent",
        "invoice",
        "pasien",
        "patient",
        "treatment",
        "apotek",
        "kasir",
        "beautyworld",
      ],
      pathPatterns: ["clinic", "bw-", "beautyworld", "erp", "hris", "mgm", "pos", "timeless"],
    },
  },
  {
    id: "playwright",
    serverName: "playwright",
    endpoint: "Local MCP (Headless/Headed Browser Automation)",
    category: "Browser Automation, UI Testing & Visual Verification",
    summary:
      "Navigate web pages, inspect accessibility snapshots, fill forms, click elements, capture screenshots, and inspect console/network errors.",
    tools: [
      {
        name: "browser_navigate",
        description: "Open a URL in the automated browser.",
        keywords: ["navigate", "open url", "browser", "page"],
      },
      {
        name: "browser_snapshot",
        description: "Capture the interactive DOM/accessibility tree snapshot of the current page.",
        keywords: ["snapshot", "dom", "inspect", "elements", "ui"],
      },
      {
        name: "browser_fill_form",
        description: "Fill multiple form inputs (login forms, modal fields, filters).",
        keywords: ["form", "login", "input", "fill"],
      },
      {
        name: "browser_click",
        description: "Click a button, link, or interactive UI element.",
        keywords: ["click", "button", "submit", "modal"],
      },
      {
        name: "browser_take_screenshot",
        description: "Take a visual PNG/JPEG screenshot of the viewport or element.",
        keywords: ["screenshot", "visual", "capture"],
      },
      {
        name: "browser_console_messages",
        description: "Read browser console errors, warnings, and logs.",
        keywords: ["console", "js error", "frontend error"],
      },
    ],
    triggers: {
      keywords: [
        "playwright",
        "browser",
        "ui",
        "frontend",
        "e2e",
        "screenshot",
        "snapshot",
        "login page",
        "modal",
        "button",
        "css",
        "html",
        "dashboard",
        "livewire",
        "react",
        "vite",
        "next",
      ],
      pathPatterns: ["frontend", "web", "ui", "portal", "clinic"],
    },
  },
  {
    id: "zettly",
    serverName: "dev-workflow (sync_zettly_task) / zettly",
    endpoint: "Automatic via dev-workflow -> Zettly API",
    category: "Zettly Todo & Daily Outcome Tracking",
    summary:
      "Automatically synchronize active development tasks, checklists, and completion outcomes with the Zettly Todo workspace.",
    tools: [
      {
        name: "sync_zettly_task",
        description: "Force-flush pending Zettly outbox items and sync the active workflow task with its linked Zettly Todo.",
        keywords: ["zettly", "todo", "outcome", "sync_zettly_task"],
      },
      {name:'get_current_focus',description:'Verify the Zettly owner and current focus before development.',keywords:['focus','scope','zettly']},
      {name:'set_focus',description:'Set one focus without replacing unfinished work.',keywords:['focus','scope']},
      {name:'link_task_to_focus',description:'Link canonical development tasks to their current focus.',keywords:['focus','task','scope']},
      {name:'complete_focus',description:'Finish focus after linked work and verified outcomes.',keywords:['focus','complete','outcome']},
    ],
    triggers: {
      keywords: ["zettly", "todo", "todos", "outcome", "outcomes", "sync_zettly_task", "focus"],
      pathPatterns: ["zettly"],
    },
  },
  {
    id: "central-gateway",
    serverName: "central-gateway",
    endpoint: "http://127.0.0.1:3200/sse",
    category: "Unified Remote MCP Gateway (SSE)",
    summary:
      "Single remote SSE MCP server (127.0.0.1:3200) aggregating PocketBase (pb_*), Infrastructure (infra_*), and Notification Hub (notify_*) tools for zero-maintenance multi-device access.",
    tools: [
      {
        name: "pb_* / infra_* / notify_*",
        description: "15 remote tools served over SSE from a single centrally updated server.",
        keywords: ["gateway", "central-gateway", "sse", "remote mcp", "3200"],
      },
    ],
    triggers: {
      keywords: [
        "central-gateway",
        "central-mcp-gateway",
        "remote mcp",
        "sse",
        "3200",
        "multi-device",
      ],
      pathPatterns: ["central-mcp-gateway"],
    },
  },
  {
    id: "mermaid",
    serverName: "mermaid",
    endpoint: "Local MCP",
    category: "Architecture & Sequence Diagrams",
    summary:
      "Generate and validate Mermaid diagrams (flowcharts, sequence diagrams, ER diagrams, state machines) for feature flows and documentation.",
    tools: [
      {
        name: "generate_mermaid_diagram",
        description: "Render or validate a Mermaid diagram from Mermaid syntax.",
        keywords: ["mermaid", "diagram", "flowchart", "sequence", "erdiagram", "architecture"],
      },
    ],
    triggers: {
      keywords: ["mermaid", "diagram", "flowchart", "sequence diagram", "erdiagram", "visualize"],
      pathPatterns: ["docs", "architecture"],
    },
  },
  {
    id: "gcp",
    serverName: "google-compute-engine / google-cloud-monitoring / google-cloud-pubsub / google-cloud-resource-manager",
    endpoint: "Local GCP MCP Suite (account: mahatmamahardhika200588@gmail.com)",
    category: "Google Cloud Platform (GCE, Monitoring, Pub/Sub, Storage)",
    summary:
      "Inspect and manage GCP Compute Engine instances, disks, snapshots, Cloud Monitoring metrics/alerts/dashboards, and Pub/Sub topics/subscriptions.",
    tools: [
      {
        name: "list_instances / get_instance_basic_info",
        description: "List and inspect Google Compute Engine VM instances.",
        keywords: ["gce", "gcp", "compute engine", "vm", "instance"],
      },
      {
        name: "list_timeseries / query_range / list_alerts",
        description: "Query Cloud Monitoring metrics, alert policies, and active incidents.",
        keywords: ["monitoring", "metrics", "alert policy", "timeseries", "cloud monitoring"],
      },
      {
        name: "list_topics / publish / list_subscriptions",
        description: "Manage Google Cloud Pub/Sub topics, messages, and subscriptions.",
        keywords: ["pubsub", "pub/sub", "topic", "subscription"],
      },
      {
        name: "search_projects",
        description: "Search GCP projects via Resource Manager.",
        keywords: ["gcp project", "resource manager"],
      },
    ],
    triggers: {
      keywords: [
        "gcp",
        "google cloud",
        "compute engine",
        "gce",
        "cloud monitoring",
        "pubsub",
        "pub/sub",
        "bigquery",
        "gcs",
        "bw_gcp_storage",
        "gcloud",
      ],
      pathPatterns: ["gcp", "cloud", "terraform"],
    },
  },
  {
    id: "cloudflare",
    serverName: "cloudflare / wrangler / cf-cli Skills & Tools",
    endpoint: "Cloudflare Edge Platform",
    category: "Cloudflare Workers, DNS, D1, KV, R2 & Zero Trust",
    summary:
      "Build, deploy, and troubleshoot Cloudflare Workers, Durable Objects, D1, R2, DNS zones, Turnstile, and Cloudflare One Zero Trust.",
    tools: [
      {
        name: "wrangler / cf-cli",
        description: "Deploy and manage Cloudflare Workers, KV, D1, R2, and DNS records.",
        keywords: ["cloudflare", "workers", "wrangler", "d1", "r2", "kv", "turnstile", "zero trust"],
      },
    ],
    triggers: {
      keywords: [
        "cloudflare",
        "worker",
        "workers",
        "wrangler",
        "durable object",
        "d1",
        "r2",
        "turnstile",
        "cdn",
      ],
      pathPatterns: ["cloudflare", "worker", "wrangler"],
    },
  },
  {
    id: "netlify",
    serverName: "netlify",
    endpoint: "Local Netlify MCP",
    category: "Netlify Sites, Builds & Edge Functions",
    summary:
      "Read and update Netlify projects, deploy statuses, environment variables, extensions, and observability logs.",
    tools: [
      {
        name: "netlify-project-services-reader",
        description: "Inspect Netlify site configuration, domains, and environment variables.",
        keywords: ["netlify", "site", "project", "env"],
      },
      {
        name: "netlify-deploy-services-reader",
        description: "Inspect Netlify build and deployment status.",
        keywords: ["netlify deploy", "build log", "preview"],
      },
    ],
    triggers: {
      keywords: ["netlify", "netlify.toml", "jamstack", "edge function"],
      pathPatterns: ["netlify"],
    },
  },
]);

function normalizeText(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "object" && item !== null ? item.text || JSON.stringify(item) : String(item)))
      .join(" ")
      .toLowerCase();
  }
  return String(value).toLowerCase();
}

function matchesKeyword(haystack, keyword) {
  const needle = String(keyword || "").toLowerCase().trim();
  if (!needle) return false;
  if (needle.includes(" ") || needle.includes("_") || needle.includes("-")) {
    return haystack.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
  return regex.test(haystack);
}

/**
 * Score and rank MCP servers and specific tools against the current task context.
 *
 * @param {object} context
 * @param {string} [context.description] - Task description
 * @param {string} [context.projectDir] - Active repository / project path
 * @param {Array<string|object>} [context.definitionOfDone] - DoD items
 * @param {Array<string|object>} [context.plan] - Ordered plan steps
 * @param {string} [context.query] - Explicit search query from `recommend_mcp_tools`
 * @param {number} [context.limit=4] - Maximum number of recommended servers to return
 */
export function recommendMcpTools(context = {}) {
  const primaryText = [context.query, context.description].map(normalizeText).filter(Boolean).join(" ");
  const secondaryText = [context.definitionOfDone, context.plan].map(normalizeText).filter(Boolean).join(" ");
  const fullText = `${primaryText} ${secondaryText}`.trim();
  const projectPath = normalizeText(context.projectDir).replaceAll("\\", "/");
  const limit = Number(context.limit) > 0 ? Number(context.limit) : 4;

  const scored = [];

  for (const server of MCP_ECOSYSTEM_INDEX) {
    let score = 0;
    const reasons = [];
    const matchedKeywords = new Set();

    // 1. Check projectDir path patterns
    if (projectPath && Array.isArray(server.triggers?.pathPatterns)) {
      for (const pattern of server.triggers.pathPatterns) {
        const cleanPattern = pattern.toLowerCase();
        if (projectPath.includes(cleanPattern)) {
          score += 5;
          reasons.push(`project path matches '${pattern}'`);
          break;
        }
      }
    }

    // 2. Check server trigger keywords in primary text (higher weight) and secondary text
    if (Array.isArray(server.triggers?.keywords)) {
      for (const kw of server.triggers.keywords) {
        if (primaryText && matchesKeyword(primaryText, kw)) {
          score += kw.includes(" ") || kw.includes("_") ? 6 : 4;
          matchedKeywords.add(kw);
        } else if (secondaryText && matchesKeyword(secondaryText, kw)) {
          score += 2;
          matchedKeywords.add(kw);
        }
      }
    }

    // 3. Score individual tools inside the server
    const matchedTools = [];
    for (const tool of server.tools || []) {
      let toolScore = 0;
      if (fullText && matchesKeyword(fullText, tool.name)) {
        toolScore += 6;
        matchedKeywords.add(tool.name);
      }
      for (const tkw of tool.keywords || []) {
        if (primaryText && matchesKeyword(primaryText, tkw)) {
          toolScore += 3;
          matchedKeywords.add(tkw);
        } else if (secondaryText && matchesKeyword(secondaryText, tkw)) {
          toolScore += 1;
          matchedKeywords.add(tkw);
        }
      }
      if (toolScore > 0) {
        score += Math.min(toolScore, 8);
        matchedTools.push({ ...tool, toolScore });
      }
    }

    if (matchedKeywords.size > 0) {
      const sample = Array.from(matchedKeywords).slice(0, 4).join(", ");
      reasons.push(`matched keywords: ${sample}`);
    }

    if (score > 0) {
      matchedTools.sort((a, b) => b.toolScore - a.toolScore);
      const selectedTools =
        matchedTools.length > 0 ? matchedTools.slice(0, 4) : (server.tools || []).slice(0, 3);

      scored.push({
        id: server.id,
        serverName: server.serverName,
        endpoint: server.endpoint,
        category: server.category,
        summary: server.summary,
        score,
        reasons,
        matchedTools: selectedTools,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Provide helpful baseline orientation when a generic task has no specific domain keywords
  const isFallback = scored.length === 0;
  if (isFallback) {
    for (const fallbackId of ["infra-knowledge", "central-gateway", "zettly"]) {
      const server = MCP_ECOSYSTEM_INDEX.find((s) => s.id === fallbackId);
      if (server) {
        scored.push({
          id: server.id,
          serverName: server.serverName,
          endpoint: server.endpoint,
          category: server.category,
          summary: server.summary,
          score: 1,
          reasons: ["general ecosystem discovery & task tracking"],
          matchedTools: (server.tools || []).slice(0, 2),
        });
      }
    }
  }

  return {
    recommendations: scored.slice(0, limit),
    totalMatched: isFallback ? 0 : scored.length,
    isFallback,
  };
}

/**
 * Render a concise markdown block of recommended MCP servers and tools to embed
 * in `start_task`, `get_workflow_status`, `continue_workflow`, or `recommend_mcp_tools`.
 */
export function formatMcpRecommendations(resultOrContext = {}) {
  const result =
    resultOrContext && Array.isArray(resultOrContext.recommendations)
      ? resultOrContext
      : recommendMcpTools(resultOrContext);

  const items = result.recommendations || [];
  if (items.length === 0) {
    return "";
  }

  const lines = [
    "🧭 Recommended MCP Tools (Context-Aware Index):",
  ];

  for (const item of items) {
    const toolNames = (item.matchedTools || []).map((t) => `\`${t.name}\``).join(", ");
    const reasonText = item.reasons?.length ? ` — _(${item.reasons.join("; ")})_` : "";
    lines.push(
      `- **${item.serverName}** [${item.category}]${reasonText}\n` +
        `  Tools: ${toolNames}\n` +
        `  Use for: ${item.summary}`
    );
  }

  lines.push(
    `💡 Tip: Run \`recommend_mcp_tools\` with \`{ "query": "<topic>" }\` or \`{ "includeAll": true }\` anytime to search all MCP tools in our ecosystem.`
  );

  return lines.join("\n");
}

/**
 * Render the complete catalog of all MCP servers and tools in the ecosystem.
 */
export function formatFullMcpCatalog(optionalQueryResult = null) {
  const lines = [];

  if (optionalQueryResult && optionalQueryResult.recommendations?.length && !optionalQueryResult.isFallback) {
    lines.push(formatMcpRecommendations(optionalQueryResult));
    lines.push("");
  }

  lines.push("📚 Complete MCP Ecosystem Index:");
  lines.push(
    "All devices share `dev-workflow` (auto-updated from `http://127.0.0.1:3101`) as the entry index, plus `central-gateway` (`http://127.0.0.1:3200/sse`) for centralized remote tools."
  );
  lines.push("");

  for (const server of MCP_ECOSYSTEM_INDEX) {
    const toolList = (server.tools || [])
      .map((t) => `    - \`${t.name}\`: ${t.description}`)
      .join("\n");
    lines.push(
      `### 🔹 ${server.id} — \`${server.serverName}\`\n` +
        `- **Category**: ${server.category}\n` +
        `- **Endpoint**: ${server.endpoint}\n` +
        `- **Summary**: ${server.summary}\n` +
        `- **Key Tools**:\n${toolList}`
    );
  }

  return lines.join("\n\n");
}
