'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {timingSafeEqual} = require('node:crypto');
const {validateManifest} = require('./protocol.cjs');

function createReleaseServer({root,token}) {
  if(typeof token!=='string'||token.length<16) throw new Error('Managed release token is required');
  const expected=Buffer.from('Bearer '+token);
  return http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    const fail=(status,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:message}));};
    try {
      const route=new URL(req.url,'http://localhost').pathname;
      if(req.method!=='GET'&&req.method!=='HEAD') return fail(405,'Method not allowed');
      if(route==='/health') {res.writeHead(200,{'content-type':'application/json'});return res.end(req.method==='HEAD'?'':JSON.stringify({ok:true}));}
      const supplied=Buffer.from(String(req.headers.authorization||''));
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) return fail(401,'Unauthorized');
      if(route==='/v1/current') {
        const manifest=validateManifest(JSON.parse(await fs.promises.readFile(path.join(root,'current.json'),'utf8')));
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(req.method==='HEAD'?'':JSON.stringify(manifest));
      }
      const match=/^\/v1\/releases\/([a-f0-9]{64})\.tar\.gz$/.exec(route);
      if(!match) return fail(404,'Not found');
      const file=path.join(root,'releases',match[1]+'.tar.gz');
      const stat=await fs.promises.stat(file);
      if(!stat.isFile()) return fail(404,'Not found');
      res.writeHead(200,{'content-type':'application/gzip','content-length':stat.size});
      if(req.method==='HEAD') return res.end();
      const stream=fs.createReadStream(file);
      stream.on('error',()=>res.destroy());
      res.on('close',()=>stream.destroy());
      stream.pipe(res);
    } catch(error) {
      if(res.headersSent) return res.destroy();
      fail(error.code==='ENOENT'?404:503,'Release unavailable');
    }
  });
}
if(require.main===module) {
  const host=process.env.HOST||'127.0.0.1';
  const port=Number(process.env.PORT||3101);
  const server=createReleaseServer({root:process.env.DEVWF_RELEASE_ROOT||'/var/lib/devwf-releases',token:process.env.DEVWF_MONITOR_TOKEN});
  server.listen(port,host,()=>console.error('Managed MCP release service listening on '+host+':'+port));
  const shutdown=()=>server.close(()=>process.exit(0));
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
module.exports={createReleaseServer};
