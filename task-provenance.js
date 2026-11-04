import {sanitize} from './security/sanitizer.js';

const SYSTEMS=new Set(['zettly','factory','sentry','manual','unknown']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validId(system,value) {
 const id=String(value??'');
 return system==='zettly'?/^[1-9]\d{0,14}$/.test(id)&&Number.isSafeInteger(Number(id)):system==='sentry'?/^\d{1,30}$/.test(id):system==='factory'?uuid.test(id):['manual','unknown'].includes(system)&&!id;
}
export function validateTaskSource(source,zettlyTodoId) {
 if(source===undefined)return null;
 if(!source||typeof source!=='object'||Array.isArray(source)||!SYSTEMS.has(source.system)||!validId(source.system,source.id))return 'Invalid task source system or source ID.';
 if(source.system==='zettly'&&zettlyTodoId!==undefined&&Number(source.id)!==Number(zettlyTodoId))return 'Zettly source ID must match zettlyTodoId.';
 return null;
}
function safeUrl(value) {
 try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&(url.hostname==='zettly.programinglive.com'||url.hostname==='factory.programinglive.com'||url.hostname==='sentry.io'||url.hostname.endsWith('.sentry.io')))return url.href;}catch{}
 return '';
}
function reference(system,id,{url='',label='',relation=''}={}) {
 id=String(id??'');
 const fallback=system==='zettly'?`https://zettly.programinglive.com/todos/${id}`:system==='factory'?'https://factory.programinglive.com/':system==='sentry'?`https://sentry.io/issues/${id}/`:'';
 return {system,id,url:safeUrl(url)||fallback,label:String(sanitize(label||`${system} ${id}`)).slice(0,200),...(relation?{relation}:{})};
}
export function originForTask(args={},previous) {
 if(!args.source&&previous?.taskOrigin)return structuredClone(previous.taskOrigin);
 const source=args.source||(args.zettlyTodoId?{system:'zettly',id:String(args.zettlyTodoId)}:{system:'manual',id:''});
 if(validateTaskSource(source))return {system:'unknown',id:'',url:'',label:'Unknown source'};
 return reference(source.system,source.id,{label:source.system==='manual'?'Direct request':source.system==='unknown'?'Unknown source':source.label,url:source.url});
}
export function buildTaskProvenance(state={}) {
 const stored=state.taskOrigin;
 const taskOrigin=stored&&!validateTaskSource(stored)?reference(stored.system,stored.id,{url:stored.url,label:stored.label}):{system:'unknown',id:'',url:'',label:'Unknown source'};
 const taskRelations=[];
 const add=(system,id,options)=>{if(validId(system,id)&&!taskRelations.some(item=>item.system===system&&item.id===String(id)))taskRelations.push(reference(system,id,options));};
 const links=state.zettly?.externalLinks||{};
 if(state.zettly?.todoId)add('zettly',state.zettly.todoId,{relation:'tracks',label:`Zettly #${state.zettly.todoId}`});
 if(links.factory)add('factory',links.factory.id,{relation:'executes',label:links.factory.taskKey||links.factory.id});
 if(links.sentry)add('sentry',links.sentry.issueId,{relation:'source_issue',label:links.sentry.shortId||links.sentry.issueId,url:links.sentry.url});
 if(['zettly','factory','sentry'].includes(taskOrigin.system))add(taskOrigin.system,taskOrigin.id,{url:taskOrigin.url,label:taskOrigin.label,relation:'origin'});
 const context=Number(state.zettlyContext?.todoId)===Number(state.zettly?.todoId)?state.zettlyContext:null;
 for(const node of (context?.nodes||[]).slice(0,50)){
  if(node.distance>0){
   const root=String(state.zettlyContext.todoId||state.zettly?.todoId||'');
   const edges=state.zettlyContext.edges||[];
   const outgoing=edges.some(edge=>String(edge.source)===root&&String(edge.target)===String(node.id));
   const incoming=edges.some(edge=>String(edge.target)===root&&String(edge.source)===String(node.id));
   const relation=node.distance>1?'context':outgoing&&incoming?'related_both':outgoing?'related_to':incoming?'related_from':'related_todos';
   add('zettly',node.id,{relation,label:node.title||`Zettly #${node.id}`});
  }
 }
 return {workflowTaskId:String(state.workflowTaskId||''),taskOrigin,taskRelations};
}
