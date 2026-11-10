'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..');
const output=path.resolve(process.argv[2]||path.join(repo,'.managed-publish'));
const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo,encoding:'utf8'}).trim();
if(dirty) throw new Error('Commit tracked source changes before publishing');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();

// The version comes from package.json at the published commit, not from the
// working tree, so the manifest always describes exactly what was archived.
// Without this the manifest carried no version and answering "which version is
// running here?" needed an SSH session on every device.
const version=JSON.parse(execFileSync('git',['show',revision+':package.json'],{cwd:repo,encoding:'utf8'})).version;
if(typeof version!=='string'||!version.trim()) throw new Error('package.json at HEAD has no version to publish');

fs.mkdirSync(path.join(output,'releases'),{recursive:true});
const archive=path.join(output,'source.tar.gz');
execFileSync('git',['archive','--format=tar.gz','--output='+archive,revision],{cwd:repo});
const body=fs.readFileSync(archive);
const sha256=createHash('sha256').update(body).digest('hex');
const manifest={revision,sha256,size:body.length,version};
require('./protocol.cjs').validateManifest(manifest);
fs.renameSync(archive,path.join(output,'releases',sha256+'.tar.gz'));
fs.writeFileSync(path.join(output,'current.json'),JSON.stringify(manifest)+'\n');
console.log(JSON.stringify(manifest));
