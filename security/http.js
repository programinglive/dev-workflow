import { securityOutputFilter } from './sanitizer.js';
import { assertSafeKnowledge } from './policy.js';

export function securityJsonMiddleware(req,res,next) {
  const json=res.json.bind(res);
  res.json=value=>json(securityOutputFilter(value));
  next();
}
export function knowledgeInputMiddleware(req,res,next) {
  try {assertSafeKnowledge(req.body);next();}
  catch(error) {
    res.status(422).json({error:'Knowledge input rejected; use SecretReference.',findings:error.findings || []});
  }
}

// Authentication is a runtime boundary, separate from knowledge responses.
export const AUTH_COOKIE='dev_workflow_auth';
export function authenticationToken(req) {
  const header=req.headers.authorization;
  if(typeof header==='string' && header.startsWith('Bearer ')) return header.slice(7);
  const cookie=String(req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(AUTH_COOKIE+'='));
  try{return cookie ? decodeURIComponent(cookie.slice(AUTH_COOKIE.length+1)) : null;}catch{return null;}
}
export function authCookieOptions(production=true) {
  return {httpOnly:true,secure:production,sameSite:production?'none':'lax',path:'/',maxAge:30*24*60*60*1000};
}
