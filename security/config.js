import { safeLog } from './sanitizer.js';
import { securityMode } from './policy.js';
import { registerRuntimeSecret } from './runtime-secrets.js';

export function databaseConnectionUrl(env=process.env) {
  securityMode(env);
  const variable=env.DEV_WORKFLOW_DB_URL_ENV;
  if(variable) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error('DEV_WORKFLOW_DB_URL_ENV must name an environment variable');
    if(!env[variable]) throw new Error('Referenced database environment variable is missing');
    registerRuntimeSecret(env[variable]);
    return env[variable];
  }
  if(env.DEV_WORKFLOW_DB_URL) safeLog('warn','DEV_WORKFLOW_DB_URL is deprecated; configure DEV_WORKFLOW_DB_URL_ENV outside client configuration.');
  registerRuntimeSecret(env.DEV_WORKFLOW_DB_URL);
  return env.DEV_WORKFLOW_DB_URL;
}

export function requireSigningSecret(name,env=process.env) {
  const value=env[name];
  if(!value || value.length<32 || /change[-_ ]?(?:me|in|this|production)|dev-workflow.*secret/i.test(value)) throw new Error('Configure a strong authentication signing secret outside the knowledge system');
  registerRuntimeSecret(value);
  return value;
}
