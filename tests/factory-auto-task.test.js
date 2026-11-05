import { test } from "node:test";
import assert from "node:assert/strict";
import {taskHasWorkflowLink as integrationWorkflowLink} from '../factory-task-relations.js';
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { autoTaskEnabled, pickProject, recordToFactory,taskHasWorkflowLink } = require("../factory-auto-task.cjs");

/**
 * Pemilik meminta "setiap pekerjaan terekam di Factory". Sebelum ini jalur
 * Factory hanya lewat tool manual, sehingga pekerjaan nyata tidak pernah
 * sampai ke board - dan board diam sejak 31 Oktober tanpa ada yang tahu.
 *
 * Yang dijaga: pencatatan otomatis TIDAK BOLEH menggagalkan start_task, dan
 * kegagalannya harus TERLIHAT (bukan ditelan), karena kegagalan tak terlihat
 * itulah yang membuat masalah kemarin berlangsung dua hari.
 */

test("Factory recording is enabled by default for development tasks", () => {
  assert.equal(autoTaskEnabled({}), true);
  for (const v of ["0", "false", "no", "mati"]) {
    assert.equal(autoTaskEnabled({ FACTORY_AUTO_TASK: v }), false, `nilai ${v}`);
  }
  assert.equal(autoTaskEnabled({FACTORY_AUTO_TASK:''}),true);
  for (const v of ["1", "true", "yes", "TRUE"]) {
    assert.equal(autoTaskEnabled({ FACTORY_AUTO_TASK: v }), true, `nilai ${v}`);
  }
});

test("project dipilih dari nama folder proyek", () => {
  const proyek = [
    { id: "a", name: "programinglive/lain" },
    { id: "b", name: "programinglive/dev-workflow-mcp-server" },
  ];
  assert.equal(pickProject(proyek, "D:\\code\\dev-workflow-mcp-server").id, "b");
  assert.equal(pickProject(proyek, "D:\\code\\entah"), null);
  assert.equal(pickProject(proyek, "C:\\worktrees\\feature", "https://github.com/programinglive/dev-workflow-mcp-server.git").id,"b");
  assert.equal(pickProject([], "x"), null);
});

test("an explicit opt-out avoids a network request", async () => {
  const hasil = await recordToFactory({ state: { taskDescription: "x" }, env: {FACTORY_AUTO_TASK:'false'} });
  assert.equal(hasil.ok, false);
  assert.equal(hasil.reason, "dimatikan");
});

test("an existing Factory relation is reused without creating a duplicate", async () => {
  const id='11111111-1111-4111-8111-111111111111';
  const result=await recordToFactory({state:{taskDescription:'Existing task',zettly:{externalLinks:{factory:{id}}}},env:{},client:{readFactoryConfig(){throw Error('Should not read Factory');}}});
  assert.equal(result.ok,true);assert.equal(result.id,id);assert.equal(result.reused,true);
});

test('a Factory task with the same canonical Todo is reused even when its older description uses another workflow marker',async()=>{
 const id='c8d61cc0-d855-4078-b89c-81bb330b169c';let creates=0;
 const state={taskDescription:'Build monitor',workflowTaskId:'workflow-1',projectDir:'C:/repo/dev-workflow-mcp-server',zettly:{todoId:215}};
 const client={readFactoryConfig:()=>({}),readWorkspace:async()=>({projects:[{id:'p1',name:'programinglive/dev-workflow-mcp-server'}],tasks:[{id,projectId:'p1',description:'Workflow: workflow-1\nZettly Todo #215'}]}),createTask:async()=>{creates++;return {id:'duplicate'};}};
 const result=await recordToFactory({state,env:{},client});assert.equal(result.id,id);assert.equal(result.reused,true);assert.equal(creates,0);
 assert.equal(taskHasWorkflowLink({description:'Zettly Todo #2150'},state),false);
 assert.equal(taskHasWorkflowLink({description:'Workflow: another-workflow\nZettly Todo #215',title:'Build monitor'},state),false);
 assert.equal(taskHasWorkflowLink({description:'Zettly Todo #215',title:'Build monitor'},state),true);
  for(const task of [{description:'Zettly Todo #2150'},{description:'Workflow: another-workflow\nZettly Todo #215',title:'Build monitor'},{description:'Zettly Todo #215',title:'Build monitor'}])assert.equal(taskHasWorkflowLink(task,state),integrationWorkflowLink(task,state));
});

test("kegagalan dilaporkan sebagai alasan, bukan dilempar", async () => {
  const klienPalsu = {
    readFactoryConfig: () => ({ url: "http://x", pocketBaseUrl: "http://y" }),
    listProjects: async () => {
      throw new Error("jaringan mati");
    },
    createTask: async () => ({}),
  };
  const hasil = await recordToFactory({
    state: { taskDescription: "uji" },
    env: { FACTORY_AUTO_TASK: "1" },
    client: klienPalsu,
  });
  assert.equal(hasil.ok, false);
  assert.match(hasil.reason, /jaringan mati/);
});

test("berhasil: mengembalikan id factory", async () => {
  const klienPalsu = {
    readFactoryConfig: () => ({ url: "http://x", pocketBaseUrl: "http://y" }),
    listProjects: async () => [{ id: "p1", name: "programinglive/dev-workflow-mcp-server" }],
    createTask: async () => ({ id: "task-123" }),
  };
  const hasil = await recordToFactory({
    state: {
      taskDescription: "Kerjakan sesuatu",
      projectDir: "D:\\code\\dev-workflow-mcp-server",
      definitionOfDone: [{ text: "build lulus" }],
      plan: [{ text: "mulai" }],
    },
    env: { FACTORY_AUTO_TASK: "1", DEVWF_MACHINE: "uji" },
    client: klienPalsu,
  });
  assert.equal(hasil.ok, true);
  assert.equal(hasil.id, "task-123");
});

test("tanpa DoD tetap mengirim teks yang sah", async () => {
  let dikirim = null;
  const klienPalsu = {
    readFactoryConfig: () => ({ url: "http://x", pocketBaseUrl: "http://y" }),
    listProjects: async () => [{ id: "p1", name: "x/y" }],
    createTask: async (_cfg, input) => {
      dikirim = input;
      return { id: "t1" };
    },
  };
  const hasil = await recordToFactory({
    state: { taskDescription: "tanpa dod", projectDir: "/repo/y", definitionOfDone: [] },
    env: { FACTORY_AUTO_TASK: "1" },
    client: klienPalsu,
  });
  assert.equal(hasil.ok, true);
  assert.match(dikirim.definitionOfDone, /task selesai dan terverifikasi/);
});
