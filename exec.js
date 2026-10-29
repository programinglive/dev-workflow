import { exec as execCallback, execFile as execFileCallback } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { sanitize } from './security/sanitizer.js';

const execPromise = promisify(execCallback);
const execFilePromise = promisify(execFileCallback);

function findRepoRoot(startDir) {
  if (!startDir) {
    return null;
  }

  let current = path.resolve(startDir);
  const { root } = path.parse(current);

  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }

    if (current === root) {
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function getDefaultCwd() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateDirs = [process.cwd(), process.env.INIT_CWD, moduleDir];
  return candidateDirs.reduce((resolved, candidate) => {
    if (resolved) {
      return resolved;
    }
    return findRepoRoot(candidate) || null;
  }, null) || process.cwd();
}

export async function exec(command, options = {}) {
  const {executable,arguments:args,...runtimeOptions}=options;
  const execOptions = runtimeOptions.cwd ? runtimeOptions : { ...runtimeOptions, cwd: getDefaultCwd() };
  try { return sanitize(await (executable ? execFilePromise(executable,args,{...execOptions,shell:false}) : execPromise(command, execOptions))); }
  catch(error) {
    const safe=new Error(sanitize(error.message));
    safe.code=error.code;
    safe.stdout=sanitize(error.stdout || '');
    safe.stderr=sanitize(error.stderr || '');
    throw safe;
  }
}
