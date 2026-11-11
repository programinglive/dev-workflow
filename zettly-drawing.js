import {createHash} from 'node:crypto';
import {createZettlyClient,resolveZettlyConfig,zettlySyncEnabled} from './zettly-client.js';
import {deriveTags,ensureTags} from './zettly-tags.js';
import {buildTaskProvenance} from './task-provenance.js';

const BASE62='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function fractionalIndex(index) {
  const i=Number(index);
  if(i<62)return `a${BASE62[i]}`;
  const high=Math.floor(i/62),low=i%62;
  return `b${BASE62[high]}${BASE62[low]}`;
}

const richText=text=>{
  const trimmed=String(text||'').trim();
  if(!trimmed)return {type:'doc',content:[{type:'paragraph',content:[]}]};
  return {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:trimmed}]}]};
};
const xml=text=>String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export const TLDRAW_SCHEMA={
  schemaVersion:2,
  sequences:{
    'com.tldraw.store':5,'com.tldraw.asset':1,'com.tldraw.camera':1,'com.tldraw.document':2,
    'com.tldraw.instance':26,'com.tldraw.instance_page_state':5,'com.tldraw.page':1,
    'com.tldraw.instance_presence':6,'com.tldraw.pointer':1,'com.tldraw.shape':4,
    'com.tldraw.asset.bookmark':2,'com.tldraw.asset.image':6,'com.tldraw.asset.video':5,
    'com.tldraw.shape.group':0,'com.tldraw.shape.text':4,'com.tldraw.shape.bookmark':2,
    'com.tldraw.shape.draw':4,'com.tldraw.shape.geo':11,'com.tldraw.shape.note':10,
    'com.tldraw.shape.line':5,'com.tldraw.shape.frame':1,'com.tldraw.shape.arrow':8,
    'com.tldraw.shape.highlight':3,'com.tldraw.shape.embed':4,'com.tldraw.shape.image':5,
    'com.tldraw.shape.video':4,'com.tldraw.binding.arrow':1
  }
};

export const TLDRAW_SESSION={
  version:0,
  currentPageId:'page:page',
  exportBackground:true,
  isFocusMode:false,
  isDebugMode:false,
  isToolLocked:false,
  isGridMode:false,
  pageStates:[{pageId:'page:page',camera:{x:0,y:0,z:1},selectedShapeIds:[],focusedGroupId:null}]
};

export function flowGraph(mermaidCode) {
  const code=String(mermaidCode||'').trim();
  if(!/^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b/i.test(code))throw Error('Use a Mermaid flowchart or graph with a direction.');
  const labels=new Map();
  const expression=/\b([A-Za-z][\w-]*)\s*(?:\[([^\]]{1,120})\]|\{([^}]{1,120})\}|\(([^)]{1,120})\))/g;
  for(const match of code.matchAll(expression))labels.set(match[1],String(match[2]||match[3]||match[4]).replace(/<[^>]*>/g,'').trim().slice(0,100));
  const edges=[];
  const nodes=new Map();
  const add=id=>{if(!nodes.has(id))nodes.set(id,{id,label:labels.get(id)||id});};
  for(const part of code.split(/[\n;]/)){
    const plain=part.replace(/\b([A-Za-z][\w-]*)\s*(?:\[[^\]]*\]|\{[^}]*\}|\([^)]*\))/g,'$1').replace(/-->\s*\|([^|]{1,60})\|\s*/g,'-- $1 --> ');
    const labeled=/\b([A-Za-z][\w-]*)\s*--\s*(?:\|([^|]{1,60})\|>|([^->]{1,60}?)\s*-->)\s*([A-Za-z][\w-]*)/g;
    let matched=false;
    for(const match of plain.matchAll(labeled)){add(match[1]);add(match[4]);edges.push({from:match[1],to:match[4],label:String(match[2]||match[3]||'').trim()});matched=true;}
    if(matched)continue;
    const chain=plain.split(/\s*-->\s*/).map(item=>item.trim());
    if(chain.length<2)continue;
    for(let index=0;index<chain.length-1;index++){
      const from=chain[index].match(/([A-Za-z][\w-]*)$/)?.[1],to=chain[index+1].match(/^([A-Za-z][\w-]*)/)?.[1];
      if(from&&to){add(from);add(to);edges.push({from,to,label:''});}
    }
  }
  if(nodes.size<2||edges.length<1||nodes.size>12||edges.length>24)throw Error('The Mermaid flow must contain 2–12 connected nodes and at most 24 arrows.');
  return {nodes:[...nodes.values()],edges};
}

export function flowNodes(mermaidCode) {return flowGraph(mermaidCode).nodes.map(node=>node.label);}

export function drawingMatchesWorkflow(drawing,state) {
  const meta=drawing?.document?.document?.store?.['document:document']?.meta;
  return Boolean(meta&&Number(meta.zettlyTodoId)===Number(state?.zettly?.todoId)&&String(meta.workflowTaskId||'')===String(state?.workflowTaskId||''));
}

export function drawingPayload(state,mermaidCode,description) {
  const todoId=Number(state.zettly?.todoId);
  if(!Number.isSafeInteger(todoId)||todoId<1)throw Error('A canonical Zettly Todo is required before creating a drawing');
  const title=`Dev Workflow #${todoId} — ${String(state.taskDescription||'Development plan').slice(0,80)}`;
  const graph=flowGraph(mermaidCode);
  const nodes=graph.nodes;
  const store={
    'document:document':{id:'document:document',typeName:'document',gridSize:20,name:title,meta:{workflowTaskId:String(state.workflowTaskId||''),zettlyTodoId:todoId,factoryTaskId:String(state.zettly?.externalLinks?.factory?.id||''),mermaidCode:String(mermaidCode).slice(0,10000)}},
    'page:page':{id:'page:page',typeName:'page',name:'Page 1',index:'a1',meta:{}},
  };
  const height=50+Math.ceil(nodes.length/2)*154;
  const colors=['blue','orange','violet','green'];
  const nodeBlocks=[];
  const edgeBlocks=[];
  let orderIndex=1;
  for(let index=0;index<nodes.length;index++){
    const x=40+(index%2)*320,y=40+Math.floor(index/2)*154;
    const color=colors[index%colors.length];
    store[`shape:step${index+1}`]={id:`shape:step${index+1}`,typeName:'shape',type:'geo',x,y,rotation:0,index:fractionalIndex(orderIndex++),parentId:'page:page',isLocked:false,opacity:1,props:{geo:'rectangle',w:250,h:94,color,fill:'semi',dash:'solid',size:'m',font:'sans',align:'middle',verticalAlign:'middle',richText:richText(`${index+1}. ${nodes[index].label}`),labelColor:'black',url:'',growY:0,scale:1},meta:{}};
    nodeBlocks.push(`<rect x="${x}" y="${y}" width="250" height="94" rx="14" fill="#172036" stroke="${['#60a5fa','#f59e0b','#a78bfa','#22c55e'][index%4]}" stroke-width="2"/><text x="${x+125}" y="${y+52}" text-anchor="middle" fill="#fff" font-family="Arial" font-size="15">${index+1}. ${xml(nodes[index].label.slice(0,24))}</text>`);
  }
  for(let index=0;index<graph.edges.length;index++){
    const edge=graph.edges[index],fromIndex=nodes.findIndex(node=>node.id===edge.from),toIndex=nodes.findIndex(node=>node.id===edge.to);
    const fromX=40+(fromIndex%2)*320,fromY=40+Math.floor(fromIndex/2)*154,toX=40+(toIndex%2)*320,toY=40+Math.floor(toIndex/2)*154;
    let x1,y1,x2,y2;
    if(fromY===toY){x1=fromX+(toX>fromX?250:0);y1=fromY+47;x2=toX+(toX>fromX?0:250);y2=toY+47;}
    else if(toY>fromY){x1=fromX+125;y1=fromY+94;x2=toX+125;y2=toY;}
    else{x1=fromX+125;y1=fromY;x2=toX+125;y2=toY+94;}
    const id=`shape:edge${index+1}`;
    store[id]={id,typeName:'shape',type:'arrow',x:x1,y:y1,rotation:0,index:fractionalIndex(orderIndex++),parentId:'page:page',isLocked:false,opacity:1,props:{kind:'arc',labelColor:'black',color:'black',fill:'none',dash:'solid',size:'m',arrowheadStart:'none',arrowheadEnd:'arrow',font:'sans',start:{x:0,y:0},end:{x:x2-x1,y:y2-y1},bend:0,richText:richText(edge.label),labelPosition:0.5,scale:1,elbowMidPoint:0.5},meta:{from:edge.from,to:edge.to}};
    edgeBlocks.push(`<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="#94a3b8" stroke-width="2" marker-end="url(#arrow)"/>${edge.label?`<text x="${(x1+x2)/2}" y="${(y1+y2)/2-5}" text-anchor="middle" fill="#e2e8f0" font-family="Arial" font-size="13">${xml(edge.label)}</text>`:''}`);
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="680" height="${height}" viewBox="0 0 680 ${height}"><rect width="680" height="${height}" rx="22" fill="#0b1020"/><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#94a3b8"/></marker></defs>${edgeBlocks.join('')}${nodeBlocks.join('')}</svg>`;
  return {
    title,
    document:{
      document:{name:title,store,schema:TLDRAW_SCHEMA},
      session:TLDRAW_SESSION
    },
    thumbnail:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)
  };
}

export async function syncZettlyDrawing(workflowState,{client,env=process.env}={}) {
  const state=workflowState.state;
  const todoId=state.zettly?.todoId;
  if(!todoId)return {ok:false,note:'Zettly drawing pending: the canonical Todo has no ID yet.'};
  const code=String(state.mermaidCode||'');
  const revision=createHash('sha256').update(code).digest('hex');
  const previous=state.zettly?.externalLinks?.drawing;
  if(previous?.revision===revision)return {ok:true,id:previous.id,reused:true};
  if(!client&&!zettlySyncEnabled(env))return {ok:false,note:'Zettly drawing pending: automatic synchronization is disabled.'};
  if(!client){const config=await resolveZettlyConfig(env);client=config?createZettlyClient(config):null;}
  if(!client)return {ok:false,note:'Zettly drawing pending: owner connection is unavailable.'};
  const payload=drawingPayload(state,code,state.featureFlowDescription);
  const id=previous?.id;
  if(!id&&state.zettlyDrawingCreateAttempted)return {ok:false,note:'Zettly drawing creation result is uncertain; inspect Draw before retrying.'};
  if(!id){state.zettlyDrawingCreateAttempted=true;const saved=await workflowState.save();if(saved?.verified===false||saved?.conflict)throw Error('Drawing creation intent was not saved');}
  let response;
  try{
    const tagNames=deriveTags({taskDescription:state.taskDescription,taskType:state.taskType,projectDir:state.projectDir,taskOrigin:buildTaskProvenance(state)});
    const tagIds=await ensureTags({client,names:tagNames});
    const payloadWithTags={...payload,...(Number.isSafeInteger(Number(state.focus?.id))&&Number(state.focus.id)>0?{focus_id:Number(state.focus.id)}:{}),...(tagIds.length?{tag_ids:tagIds}:{})};
    response=await client.request(id?'PATCH':'POST',id?`/drawings/${id}`:'/drawings',payloadWithTags);
  }
  catch(error){return {ok:false,note:`Zettly drawing pending: ${error.status?`HTTP ${error.status}`:'connection or response unavailable'}.`};}
  const drawing=response.drawing||response.data?.drawing||response.data;
  if(!Number.isSafeInteger(Number(drawing?.id))||Number(drawing.id)<1)return {ok:false,note:'Zettly drawing pending: creation returned no ID.'};
  state.zettly.externalLinks={...state.zettly.externalLinks,drawing:{id:Number(drawing.id),revision,url:`https://zettly.programinglive.com/draw/${drawing.id}`}};
  const saved=await workflowState.save();
  if(saved?.verified===false||saved?.conflict)throw Error('Drawing link was not saved');
  return {ok:true,id:Number(drawing.id),url:state.zettly.externalLinks.drawing.url};
}
