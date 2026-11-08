import {spawnSync} from 'node:child_process';

export function taskHasWorkflowLink(task,state) {
  const description=String(task?.description||'');
  const workflowId=String(state?.workflowTaskId||'');
  const todoId=Number(state?.zettly?.todoId);
  const markers=[...description.matchAll(/\bWorkflow(?: task)?:\s*([A-Za-z0-9._:-]+)/g)].map(match=>match[1]);
  if(markers.length)return Boolean(workflowId&&markers.includes(workflowId));
  const sameTodo=Number.isSafeInteger(todoId)&&todoId>0&&new RegExp(`Zettly Todo #${todoId}(?:\\D|$)`).test(description);
  const sameTitle=String(task?.title||'').trim().toLowerCase()===String(state?.taskDescription||'').trim().toLowerCase();
  return Boolean(sameTodo&&sameTitle);
}

export function taskMatchesProject(task,projectPath) {
  const name=String(task?.projectName||'').toLowerCase();
  const local=String(projectPath||'');
  const remote=local?spawnSync('git',['-C',local,'config','--get','remote.origin.url'],{encoding:'utf8',windowsHide:true,timeout:3000}).stdout?.trim():'';
  const repository=String(remote||'').replace(/\.git$/,'').match(/[:/]([^/:]+\/[^/]+)$/)?.[1]?.toLowerCase()||'';
  const folder=local.replace(/[\\/]+$/,'').split(/[\\/]/).pop().toLowerCase();
  return Boolean(name&&(repository?name===repository:name.split('/').pop()===folder));
}
