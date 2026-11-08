'use strict';

/**
 * Record development work in Factory when start_task succeeds.
 * The Factory task is linked to the same canonical Zettly Todo and retains
 * the original source identity. Network failures remain visible warnings.
 * An explicit FACTORY_AUTO_TASK=false disables creation for isolated tests.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const TITLE_MAX = 140;

/**
 * Judul kartu Factory dibatasi 3-140 karakter oleh API-nya.
 *
 * `start_task` memakai deskripsi tugas sebagai judul, dan deskripsi yang
 * wajar sering melewati 140 karakter. Dulu judul dikirim apa adanya:
 * Factory menolak, `start_task` tetap berhasil, dan satu-satunya jejaknya
 * adalah peringatan kecil di hasil tool - jadi pekerjaan bisa tidak
 * tercatat tanpa ada yang menyadarinya.
 *
 * Teks lengkap tetap disimpan di deskripsi kartu; yang dipotong hanya judul.
 */
function factoryTitle(text, max = TITLE_MAX) {
  const rapi = String(text || '').replace(/\s+/g, ' ').trim();
  if (rapi.length <= max) return rapi;
  return rapi.slice(0, max - 1).trimEnd() + '\u2026';
}
const {spawnSync}=require('node:child_process');

/** Determine whether Factory recording is enabled. */
function autoTaskEnabled(env = process.env) {
  const v = String(env.FACTORY_AUTO_TASK || '').trim().toLowerCase();
  return !['0', 'false', 'no', 'mati'].includes(v);
}

/** Match the Factory project to the Git remote or the repository directory. */
function pickProject(projects, projectPath, repositoryUrl='') {
  const daftar = Array.isArray(projects) ? projects : [];
  if (daftar.length === 0) return null;
  const normalizedRemote=String(repositoryUrl||'').replace(/\.git$/,'');
  const remote=(/^[^/]+\/[^/]+$/.test(normalizedRemote)?normalizedRemote:normalizedRemote.match(/[:/]([^/:]+\/[^/]+)$/)?.[1])?.toLowerCase();
  if(remote){const match=daftar.find(project=>String(project.name||'').toLowerCase()===remote);if(match)return match;}
  const nama = String(projectPath || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  if (!nama) return null;
  const cocok = daftar.find((p) => String(p.name || '').split('/').pop() === nama);
  return cocok || null;
}

function repositoryName(projectPath) {
  const local=String(projectPath||'');
  const remote=local?spawnSync('git',['-C',local,'config','--get','remote.origin.url'],{encoding:'utf8',windowsHide:true,timeout:3000}).stdout?.trim():'';
  return String(remote||'').replace(/\.git$/,'').match(/[:/]([^/:]+\/[^/]+)$/)?.[1]?.toLowerCase()||'';
}

function taskHasWorkflowLink(task,state) {
  const description=String(task?.description||'');
  const workflowId=String(state?.workflowTaskId||'');
  const todoId=Number(state?.zettly?.todoId);
  const markers=[...description.matchAll(/\bWorkflow(?: task)?:\s*([A-Za-z0-9._:-]+)/g)].map(match=>match[1]);
  if(markers.length)return Boolean(workflowId&&markers.includes(workflowId));
  const sameTodo=Number.isSafeInteger(todoId)&&todoId>0&&new RegExp(`Zettly Todo #${todoId}(?:\\D|$)`).test(description);
  const sameTitle=String(task?.title||'').trim().toLowerCase()===String(state?.taskDescription||'').trim().toLowerCase();
  return Boolean(sameTodo&&sameTitle);
}

function taskMatchesProject(task,projectPath) {
  const name=String(task?.projectName||'').toLowerCase();
  const remote=repositoryName(projectPath);
  const local=String(projectPath||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop().toLowerCase();
  return Boolean(name&&(remote?name===remote:name.split('/').pop()===local));
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
  const existingId = s.zettly?.externalLinks?.factory?.id;
  if (typeof existingId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(existingId)) {
    return { ok: true, id: existingId, reused: true };
  }

  try {
    const mod = client || (await import('./factory-client.js'));
    const cfg = mod.readFactoryConfig(env);
    if (!cfg) return { ok: false, reason: 'kredensial Factory tidak lengkap' };

    const batas = new Promise((_, tolak) =>
      setTimeout(() => tolak(new Error(`timeout ${timeoutMs}ms`)), timeoutMs),
    );

    const workspace=mod.readWorkspace?await Promise.race([mod.readWorkspace(cfg),batas]):{projects:await Promise.race([mod.listProjects(cfg),batas]),tasks:[]};
    const projectDir=String(s.projectDir||'');
    const remote=repositoryName(projectDir);
    const pilih = pickProject(workspace.projects, projectDir,remote);
    if (!pilih) return { ok: false, reason: 'no matching Factory project for the Git repository' };
    const marker=s.workflowTaskId?`Workflow task: ${s.workflowTaskId}`:'';
    const reused=Array.isArray(workspace.tasks)?workspace.tasks.find(task=>task.projectId===(pilih.id||pilih.projectId)&&taskHasWorkflowLink(task,s)):null;
    if(reused?.id)return {ok:true,id:reused.id,reused:true};

    const dod = Array.isArray(s.definitionOfDone) ? s.definitionOfDone : [];
    const dodText =
      dod.length > 0
        ? dod.map((d) => `- [ ] ${d.text}`).join('\n')
        : '- [ ] task selesai dan terverifikasi';
    const rencana = Array.isArray(s.plan) ? s.plan : [];

    const dibuat = await Promise.race([
      mod.createTask(cfg, {
        projectId: pilih.id || pilih.projectId,
        title: factoryTitle(judul),
        description:
          `Created by Dev Workflow on ${String(env.DEVWF_MACHINE || '?')}` +
          (s.projectDir ? ` di ${s.projectDir}` : '') +
          (marker?`\n${marker}`:'')+
          (s.zettly?.todoId?`\nZettly Todo #${s.zettly.todoId}`:'')+
          (rencana.length ? `\n\nPlan:\n${rencana.map((p) => `- ${p.text}`).join('\n')}` : ''),
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

module.exports = { recordToFactory, autoTaskEnabled, pickProject, factoryTitle, taskHasWorkflowLink, taskMatchesProject, DEFAULT_TIMEOUT_MS, TITLE_MAX };
