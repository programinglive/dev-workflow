// Bukti bahwa penjaga review-ganda akan menyala pada data Factory sungguhan.
// Read-only: hanya membaca workspace, tidak pernah POST /api/work.
import { readFactoryConfig, readWorkspace, findBlockingReviewEvent } from "../factory-client.js";

const TASKS = {
  "5127f86d": "5127f86d-e32f-4b00-991c-d817c01e2774",
  "db4468aa": "db4468aa-0000-4000-8000-000000000000",
  "f57f017b": "f57f017b-915c-4a91-a25d-ecb3a7050260",
  "6a833f7d": "6a833f7d-4ea6-4e30-9c9b-3d93f4e2c428",
};

const config = readFactoryConfig();
if (!config) {
  console.error("Factory belum dikonfigurasi (FACTORY_URL/FACTORY_TOKEN atau email+password).");
  process.exit(1);
}

const workspace = await readWorkspace(config);
console.log(`workspace: ${(workspace.tasks || []).length} task, ${(workspace.events || []).length} event\n`);

for (const [short, id] of Object.entries(TASKS)) {
  const task = (workspace.tasks || []).find((t) => t.id === id);
  if (!task) {
    console.log(`${short}: task tidak ditemukan (id contoh)`);
    continue;
  }
  const prior = findBlockingReviewEvent(workspace.events, id);
  const aktif = task.work?.state === "active";
  console.log(`${short}  status=${task.status.padEnd(8)} sesi=${String(task.work?.state).padEnd(8)}`);
  console.log(`   penjaga review: ${prior ? `MENOLAK (${prior.kind} @ ${prior.createdAt})` : "lolos"}`);
  if (prior && aktif) console.log("   -> akan ditolak sebelum POST /api/work");
  console.log();
}
