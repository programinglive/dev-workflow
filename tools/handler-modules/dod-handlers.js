/**
 * Handler untuk Definition of Done.
 *
 * Tipis dengan sengaja: aturan "apa yang sah" hidup di `dod.js`, dan handler di
 * sini hanya memvalidasi, mengubah state, lalu menyimpan. Kalau logika aturan
 * ikut masuk ke sini, ia hanya bisa diuji lewat MCP penuh.
 */
import { textResponse } from "./shared.js";
import { validateCliFirstEvidence } from "../../governance/evidence-validator.js";
import { loadPolicies, normalizeRepoSlug } from "../../governance/engine.js";
import {
  MAX_ITEMS,
  MAX_EVIDENCE,
  MIN_EVIDENCE,
  validateItemTexts,
  nextItemId,
  renderChecklist,
} from "./dod.js";

function noActiveTask() {
  return textResponse("⚠️ No active task. Use 'start_task' first, or 'set_definition_of_done' after starting one.");
}

function findItem(state, id) {
  const items = Array.isArray(state.definitionOfDone) ? state.definitionOfDone : [];
  return items.find((item) => item.id === id) || null;
}

function itemList(state) {
  const items = Array.isArray(state.definitionOfDone) ? state.definitionOfDone : [];
  return items.map((item) => `   ${item.id} [${item.status}]: ${item.text}`).join("\n");
}

function touch(workflowState) {
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.readyToCommit = false;
}

function newItem(text, state) {
  return {
    id: nextItemId(state.definitionOfDone || []),
    text,
    status: "open",
    evidence: "",
    waivedReason: "",
    revision: Number(state.dodRevision) || 0,
    updatedAt: new Date().toISOString(),
  };
}

export async function handleSetDefinitionOfDone(args, workflowState) {
  const state = workflowState.state;
  if (!state || state.currentPhase === "idle") {
    return noActiveTask();
  }

  const check = validateItemTexts(args.items);
  if (!check.ok) {
    return textResponse(
      `⚠️ ${check.error}\n\n` +
        `Contoh:\n  items: ["build lulus", "halaman login terverifikasi"]`,
    );
  }

  const existing = Array.isArray(state.definitionOfDone) ? state.definitionOfDone : [];
  const append = args.append === true;

  // Mengganti seluruh daftar saat sudah ada bukti berarti membuang bukti yang
  // mungkin sudah diperiksa manusia. Itu tidak boleh terjadi diam-diam.
  if (!append) {
    const proven = existing.filter((item) => item.status === "done" || item.status === "waived");
    if (proven.length > 0) {
      return textResponse(
        `⚠️ Daftar ini sudah punya ${proven.length} item yang terbukti atau dikecualikan:\n${itemList(state)}\n\n` +
          `Mengganti seluruh daftar akan membuang bukti itu. Pilih salah satu:\n` +
          `  - tambahkan item baru: set_definition_of_done { items: [...], append: true }\n` +
          `  - mulai ulang workflow: rerun_workflow`,
      );
    }
  }

  const total = (append ? existing.length : 0) + check.items.length;
  if (total > MAX_ITEMS) {
    return textResponse(
      `⚠️ Total item DoD akan menjadi ${total}, melebihi batas ${MAX_ITEMS}. ` +
        `Ringkas kondisi yang sejenis sebelum menambah.`,
    );
  }

  // Duplikat terhadap item yang SUDAH ada juga harus ditolak: dua item dengan
  // teks sama hanya membuat gerbang bertanya dua kali.
  const seen = new Set((append ? existing : []).map((item) => item.text.toLowerCase()));
  for (const text of check.items) {
    if (seen.has(text.toLowerCase())) {
      return textResponse(
        `⚠️ Item "${text}" sudah ada di daftar DoD task ini. Hapus duplikatnya dari permintaan.`,
      );
    }
    seen.add(text.toLowerCase());
  }

  const items = append ? existing.slice() : [];
  for (const text of check.items) {
    items.push(newItem(text, { ...state, definitionOfDone: items }));
  }

  state.definitionOfDone = items;
  state.dodSource = "manual";
  touch(workflowState);
  await workflowState.save();

  return textResponse(
    `✅ Definition of Done ${append ? "ditambah" : "disusun"}: ${items.length} item.\n\n` +
      renderChecklist(items, state.dodRevision) +
      `\n\nBuktikan dengan 'mark_dod_item' { id, evidence } atau kecualikan dengan 'waive_dod_item' { id, reason }.`,
  );
}

export async function handleMarkDodItem(args, workflowState) {
  const state = workflowState.state;
  if (!state || state.currentPhase === "idle") {
    return noActiveTask();
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    return textResponse(`⚠️ Sebutkan 'id' item DoD. Yang tersedia:\n${itemList(state)}`);
  }

  const item = findItem(state, id);
  if (!item) {
    return textResponse(`⚠️ Tidak ada item DoD dengan id "${id}". Yang tersedia:\n${itemList(state)}`);
  }

  if (item.status === "waived") {
    return textResponse(
      `⚠️ Item "${item.text}" sudah dikecualikan (${item.waivedReason}).\n` +
        `Kalau sekarang benar-benar perlu dibuktikan, tambahkan sebagai item baru dengan ` +
        `set_definition_of_done { items: [...], append: true }.`,
    );
  }

  const evidence = typeof args.evidence === "string" ? args.evidence.trim() : "";
  if (evidence.length < MIN_EVIDENCE || evidence.length > MAX_EVIDENCE) {
    return textResponse(
      `⚠️ 'evidence' untuk "${item.text}" harus ${MIN_EVIDENCE}-${MAX_EVIDENCE} karakter dan menyebut buktinya, ` +
        `contoh: "npm test → 482 pass".\n` +
        `Bukti adalah yang membuat item ini berbeda dari sekadar klaim.`,
    );
  }

  const isCliFirstItem =
    args.governanceType === "cli_first" ||
    /\b(cli[- ]?first|headless|shared\s+service|artisan\s+|devwf\s+)\b/i.test(item.text);

  if (state.governance && isCliFirstItem) {
    const policies = loadPolicies();
    const cliPolicy = policies.policies["architecture.cli_first"];
    const repo = state.governance.repository || normalizeRepoSlug(state.identityContract?.remote || "");
    const candidateEvidence = {
      summary: evidence,
      headlessTestsPassed: Boolean(state.testsPassed),
      repository: repo,
      revision: Number(state.dodRevision) || 0,
      policyVersion: cliPolicy.version,
      policyDigest: policies.digest,
      recordedAt: new Date().toISOString(),
    };
    const check = validateCliFirstEvidence({
      applicability: state.governance.cliFirstApplicability || "REQUIRED",
      evidence: candidateEvidence,
      currentRepo: repo,
      currentRevision: Number(state.dodRevision) || 0,
      expectedPolicyVersion: cliPolicy.version,
      expectedPolicyDigest: policies.digest,
    });
    if (!check.ok && state.governance.effectiveMode === "enforce") {
      return textResponse(`⚠️ ${check.code}: ${check.reason}`);
    }
    if (check.ok) {
      state.governance.cliFirstEvidence = candidateEvidence;
    }
  }

  item.status = "done";
  item.evidence = evidence;
  item.waivedReason = "";
  item.revision = Number(state.dodRevision) || 0;
  item.updatedAt = new Date().toISOString();

  touch(workflowState);
  await workflowState.save();

  const remaining = state.definitionOfDone.filter((candidate) => candidate.status === "open");

  return textResponse(
    `✅ Item "${item.text}" terbukti: ${evidence}\n\n` +
      renderChecklist(state.definitionOfDone, state.dodRevision) +
      (remaining.length === 0
        ? `\n\nSemua item DoD sudah terpenuhi.`
        : `\n\nMasih ${remaining.length} item terbuka: ${remaining.map((candidate) => candidate.id).join(", ")}.`),
  );
}

export async function handleWaiveDodItem(args, workflowState) {
  const state = workflowState.state;
  if (!state || state.currentPhase === "idle") {
    return noActiveTask();
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    return textResponse(`⚠️ Sebutkan 'id' item DoD. Yang tersedia:\n${itemList(state)}`);
  }

  const item = findItem(state, id);
  if (!item) {
    return textResponse(`⚠️ Tidak ada item DoD dengan id "${id}". Yang tersedia:\n${itemList(state)}`);
  }

  if (item.status === "done") {
    return textResponse(
      `⚠️ Item "${item.text}" sudah terbukti (${item.evidence}); tidak ada yang perlu dikecualikan.`,
    );
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (reason.length < MIN_EVIDENCE || reason.length > MAX_EVIDENCE) {
    return textResponse(
      `⚠️ 'reason' untuk "${item.text}" harus ${MIN_EVIDENCE}-${MAX_EVIDENCE} karakter dan menjelaskan ` +
        `mengapa kondisi ini tidak berlaku untuk task ini.\n` +
        `Alasan ini dicatat di state dan di history, jadi tulis yang bisa dibaca orang lain.`,
    );
  }

  item.status = "waived";
  item.waivedReason = reason;
  item.evidence = "";
  item.revision = Number(state.dodRevision) || 0;
  item.updatedAt = new Date().toISOString();

  touch(workflowState);
  await workflowState.save();

  return textResponse(
    `⚠️ Item "${item.text}" dikecualikan: ${reason}\n\n` +
      renderChecklist(state.definitionOfDone, state.dodRevision) +
      `\n\nPengecualian tercatat dan akan muncul di history saat task ditutup.`,
  );
}
