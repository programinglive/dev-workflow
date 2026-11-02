'use strict';

/**
 * Mencatat task ke board Factory secara otomatis saat `start_task`.
 *
 * MENGAPA
 * -------
 * Pemilik meminta "setiap pekerjaan terekam di Factory". Sebelum ini, jalur
 * Factory hanya dipakai lewat tool manual (`create_factory_task`), sehingga
 * pekerjaan nyata tidak pernah sampai ke board - dan board berhenti di
 * 31 Oktober tanpa ada yang menyadarinya.
 *
 * ATURAN KERAS
 * ------------
 * 1. TIDAK PERNAH menggagalkan `start_task`. Board yang mati tidak boleh
 *    menghalangi orang mulai bekerja.
 * 2. Tidak menahan: batas waktu pendek, dan kegagalan dilaporkan sebagai
 *    peringatan di hasil tool, bukan galat.
 * 3. Hanya berjalan bila `FACTORY_AUTO_TASK=1`. Menyalakannya mengubah
 *    perilaku (setiap task membuat kartu), jadi harus disengaja.
 * 4. Bila gagal, ALASANNYA ikut ditampilkan. Kegagalan yang tidak terlihat
 *    adalah persis yang membuat board diam dua hari.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/** Apakah pencatatan otomatis diminta. */
function autoTaskEnabled(env = process.env) {
  const v = String(env.FACTORY_AUTO_TASK || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Project Factory yang paling cocok dengan path proyek lokal. */
function pickProject(projects, projectPath) {
  const daftar = Array.isArray(projects) ? projects : [];
  if (daftar.length === 0) return null;
  const nama = String(projectPath || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  if (!nama) return daftar[0];
  const cocok = daftar.find((p) => String(p.name || '').split('/').pop() === nama);
  return cocok || daftar[0];
}

/**
 * Buat task di Factory. Mengembalikan { ok, id } atau { ok:false, reason }.
 * Tidak pernah melempar.
 */
async function recordToFactory({ state, env = process.env, client, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!autoTaskEnabled(env)) return { ok: false, reason: 'dimatikan' };
  const s = state || {};
  const judul = String(s.taskDescription || '').trim();
  if (!judul) return { ok: false, reason: 'task kosong' };

  try {
    const mod = client || (await import('./factory-client.js'));
    const cfg = mod.readFactoryConfig(env);
    if (!cfg) return { ok: false, reason: 'kredensial Factory tidak lengkap' };

    const batas = new Promise((_, tolak) =>
      setTimeout(() => tolak(new Error(`timeout ${timeoutMs}ms`)), timeoutMs),
    );

    const proyek = await Promise.race([mod.listProjects(cfg), batas]);
    const pilih = pickProject(proyek, s.projectDir);
    if (!pilih) return { ok: false, reason: 'tidak ada project di Factory' };

    const dod = Array.isArray(s.definitionOfDone) ? s.definitionOfDone : [];
    const dodText =
      dod.length > 0
        ? dod.map((d) => `- [ ] ${d.text}`).join('\n')
        : '- [ ] task selesai dan terverifikasi';
    const rencana = Array.isArray(s.plan) ? s.plan : [];

    const dibuat = await Promise.race([
      mod.createTask(cfg, {
        projectId: pilih.id || pilih.projectId,
        title: judul,
        description:
          `Dibuat otomatis dari sesi ${String(env.DEVWF_MACHINE || '?')}` +
          (s.projectDir ? ` di ${s.projectDir}` : '') +
          (rencana.length ? `\n\nRencana:\n${rencana.map((p) => `- ${p.text}`).join('\n')}` : ''),
        status: 'backlog',
        priority: 'normal',
        acceptance: 'Task ini tercatat di board Factory dan dapat ditindaklanjuti.',
        definitionOfDone: dodText,
      }),
      batas,
    ]);

    const id = dibuat && (dibuat.id || (dibuat.task && dibuat.task.id)) || '';
    return id ? { ok: true, id } : { ok: false, reason: 'balasan tanpa id' };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { recordToFactory, autoTaskEnabled, pickProject, DEFAULT_TIMEOUT_MS };
