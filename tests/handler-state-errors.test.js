import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import { StateConflict, StateUnavailable } from "../db/errors.js";

/**
 * Dua kegagalan penyimpanan state tidak boleh berakhir sebagai
 * "⚠️ Internal server error".
 *
 * Pesan generik itu memberi tahu agen bahwa ADA yang salah, tetapi tidak apa
 * yang harus dilakukan. Untuk konflik, tindakannya "muat ulang state". Untuk
 * penyimpanan rusak, tindakannya "berhenti dan perbaiki disknya" - dan agen
 * yang mengira itu bug sementara akan mencoba lagi berkali-kali.
 */
function callWithThrow(error) {
  return handleToolCall({
    request: { params: { name: "get_workflow_status", arguments: {} } },
    normalizeRequestArgs: () => {
      throw error;
    },
    workflowState: null,
  });
}

test("StateConflict dijawab dengan pesan yang menyebut sesi, bukan error internal", async () => {
  const response = await callWithThrow(
    new StateConflict("versi 3 sudah basi", {
      sessionKey: "ses_bentrok",
      expectedVersion: 3,
      actualVersion: 4,
    }),
  );

  const text = response.content[0].text;
  assert.equal(text.includes("Internal server error"), false);
  assert.match(text, /ses_bentrok/);
  assert.equal(response.isError, true);
});

test("StateUnavailable menyebut sebabnya dan menolak mengaku sukses", async () => {
  const response = await callWithThrow(new StateUnavailable("disk penuh saat menulis state"));

  const text = response.content[0].text;
  assert.match(text, /disk penuh saat menulis state/);
  assert.equal(response.isError, true);
});