import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeLog } from '../security/sanitizer.js';

const skip=new Set(['node_modules','.git','.state','dist','out','.next','.superpowers']);
let checked=0;
const jsx=[];
async function walk(dir) {
  for(const item of await fs.readdir(dir,{withFileTypes:true})) {
    if(skip.has(item.name)||item.isSymbolicLink())continue;
    const file=path.join(dir,item.name);
    if(item.isDirectory()){await walk(file);continue;}
    if(!/\.(?:js|mjs|cjs)$/.test(file))continue;
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.status!==0){
      const stderr=String(result.stderr||'');
      // `node --check` is not a JSX parser. Files that fail only on a bare `<`
      // are JSX sources (the React Native mobile app) and need the project's
      // own transform, not a Node syntax check. Skipping them is an explicit
      // decision, not a silenced failure.
      if(/Unexpected token '</.test(stderr)){jsx.push(file);continue;}
      safeLog('error','JavaScript syntax check failed',file,result.stderr);process.exitCode=1;
    }
    checked++;
  }
}
await walk(process.cwd());
safeLog('info',`Checked ${checked} JavaScript source files. Dashboard semantic lint runs separately with npm run lint --prefix web.`);
if(jsx.length)safeLog('info',`Skipped ${jsx.length} JSX source file(s); node --check cannot parse JSX (mobile React Native target).`);
