import fs from 'node:fs/promises';
import path from 'node:path';
import { scanSecrets } from './scanner.js';
import { classify,securityMode } from './policy.js';
import { sanitize } from './sanitizer.js';
import { isProtectedFile,protectedFileMetadata } from './files.js';
import { databaseConnectionUrl } from './config.js';

export async function auditDatabase({root,userId,projectPath=root,env=process.env}) {
  const type=env.DEV_WORKFLOW_DB_TYPE || 'sqlite';
  const issues=[]; let close=async()=>{}; let query;
  try {
    if(type==='sqlite') {
      const dbPath=env.DEV_WORKFLOW_DB_PATH || path.join(root,'.state','dev-workflow.db');
      try {await fs.access(dbPath);} catch{return {status:'not_present',issues:[]};}
      const {default:Database}=await import('better-sqlite3');
      const db=new Database(dbPath,{readonly:true,fileMustExist:true});
      close=async()=>db.close();
      query=async(table)=>db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND project_path = ? LIMIT 1001`).all(userId,projectPath);
    } else if(['postgres','postgresql'].includes(type)) {
      const {default:pg}=await import('pg');
      const pool=new pg.Pool({connectionString:databaseConnectionUrl(env),connectionTimeoutMillis:3000});
      close=()=>pool.end();
      const {PostgresAdapter}=await import('../db/adapters/postgres.js');
      const numericId=new PostgresAdapter().getNumericUserId(userId);
      query=async(table)=>(await pool.query(`SELECT * FROM ${table} WHERE user_id = $1 AND project_path = $2 LIMIT 1001`,[numericId,projectPath])).rows;
    } else if(type==='mysql') {
      const {default:mysql}=await import('mysql2/promise');
      const connection=await mysql.createConnection(databaseConnectionUrl(env));
      close=()=>connection.end();
      query=async(table)=>(await connection.execute(`SELECT * FROM ${table} WHERE user_id = ? AND project_path = ? LIMIT 1001`,[userId,projectPath]))[0];
    } else return {status:'unsupported',issues:[]};
    let rows_scanned=0,truncated=false;
    const unavailable_tables=[];
    for(const table of ['workflow_history','workflow_state','project_summary']) {
      try {
        const rows=await query(table); truncated ||= rows.length>1000;
        for(const [index,row] of rows.slice(0,1000).entries()) {
          rows_scanned++;
          const findings=scanSecrets(row);
          if(findings.length || classify(row)==='SECRET') issues.push({table,row_number:index+1,findings,detected_sensitivity:'SECRET'});
        }
      } catch {unavailable_tables.push(table);}
    }
    return {status:unavailable_tables.length?'partial':'scanned',rows_scanned,truncated,unavailable_tables,scope:'current user and project only',issues};
  } catch {return {status:'unavailable',issues,remediation:'Verify database configuration and read permissions in a trusted operator session.'};}
  finally {await close().catch(()=>{});}
}

export async function securityAudit({root,state={},stateFile,userId='default',env=process.env}) {
  const report={mode:securityMode(env),status:'review_required',protected_files:[],potential_exposures:[],configuration:[],scan:{files_scanned:0,truncated:false,unreadable:0}};
  const inspect=(source,value)=>{
    const findings=scanSecrets(value);
    if(findings.length || classify(value)==='SECRET') report.potential_exposures.push({source,findings,detected_sensitivity:'SECRET'});
  };
  inspect('in-memory knowledge',state);
  // Scan only the current user's state artifacts; never enumerate other users' state.
  if(stateFile) for(const file of [stateFile,path.join(path.dirname(stateFile),'project-summary.json')]) {
    try {inspect('current-user knowledge artifact',JSON.parse(await fs.readFile(file,'utf8')));}catch {report.scan.unreadable++;}
  }
  const skip=new Set(['.git','node_modules','.state','dist','build','out','.next','.worktrees','.superpowers']);
  async function walk(dir,depth=0) {
    if(depth>12 || report.scan.files_scanned>=500) {report.scan.truncated=true;return;}
    let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{report.scan.unreadable++;return;}
    for(const entry of entries) {
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) {if(!skip.has(entry.name)) await walk(file,depth+1);continue;}
      if(isProtectedFile(file)) {try{report.protected_files.push(await protectedFileMetadata(file));}catch{report.scan.unreadable++;}continue;}
      if(!/\.(?:md|json|[cm]?js|tsx?|ya?ml|sh|ps1|toml)$/i.test(file)||entry.name.endsWith('lock.json'))continue;
      if(report.scan.files_scanned>=500){report.scan.truncated=true;break;}
      try {
        const stat=await fs.stat(file);
        if(stat.size>1024*1024){report.scan.truncated=true;continue;}
        report.scan.files_scanned++;
        inspect(path.relative(root,file),await fs.readFile(file,'utf8'));
      }catch{report.scan.unreadable++;}
    }
  }
  await walk(root);
  if(env.DEV_WORKFLOW_DB_URL) report.configuration.push({issue:'legacy_database_configuration',remediation:'Use DEV_WORKFLOW_DB_URL_ENV and provision its target outside client JSON.'});
  for(const name of ['JWT_SECRET','SESSION_SECRET']) if(!env[name]) report.configuration.push({issue:'signing_secret_not_configured',variable:name,scope:'required only when running the corresponding web authentication server'});
  report.database=await auditDatabase({root,userId,env});
  report.recommendations=['Review candidates in a trusted session; no detected values are returned.','Rotate exposed credentials before reviewing historical Git cleanup.','Replace raw credentials with SecretReference; protect backups and external logs.'];
  return sanitize(report);
}
