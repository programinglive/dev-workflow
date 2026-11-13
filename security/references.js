const PROVIDERS = new Set(['env','op','vault','aws-secrets','gcp-secret','bitwarden']);

export class SecretReference {
  constructor(uri) {
    if (typeof uri !== 'string' || uri.length > 512) throw new Error('Invalid SecretReference');
    const match = /^([a-z-]+):\/\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/.exec(uri);
    if (!match || !PROVIDERS.has(match[1]) || (match[1] === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(match[2])) || match[2].split('/').some(p=>p==='.'||p==='..')) {
      throw new Error('Invalid SecretReference; use a supported provider URI without credentials');
    }
    this.uri = uri;
    this.provider = match[1];
    Object.freeze(this);
  }
}

export function isSecretReference(value) {
  try { new SecretReference(value); return true; } catch { return false; }
}

// Metadata only. Deliberately no resolve(), fetch(), or provider credential API.
export const secretProviders = Object.freeze([...PROVIDERS]);
