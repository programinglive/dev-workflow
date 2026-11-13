const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

// The Playwright MCP used to float on @latest, so a reload could change the
// browser server with no record. It is pinned now, and the note that explains
// the pin must not drift away from the version actually configured.
test('the documented Playwright pin matches the configured version',()=>{
  const doc=fs.readFileSync(path.join(__dirname,'../docs/mcp-reload.md'),'utf8');
  const documented=/@playwright\/mcp@(\d+\.\d+\.\d+)/.exec(doc);
  assert.ok(documented,'docs/mcp-reload.md must name the pinned Playwright MCP version');

  const config=path.join(os.homedir(),'.config','opencode','opencode.json');
  if(!fs.existsSync(config)) return; // CI has no client config to compare against

  const configured=/@playwright\/mcp@([^"]+)/.exec(fs.readFileSync(config,'utf8'));
  assert.ok(configured,'the OpenCode config must pin the Playwright MCP instead of @latest');
  assert.notEqual(configured[1],'latest','the OpenCode config must not float on @latest');
  assert.equal(configured[1],documented[1],'the documented pin must match the configured pin');
});
