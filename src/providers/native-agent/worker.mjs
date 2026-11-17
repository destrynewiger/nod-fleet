const fs = await import('node:fs/promises');
const path = await import('node:path');
const os = await import('node:os');
const crypto = await import('node:crypto');
const { spawn } = await import('node:child_process');
const { createInterface } = await import('node:readline');

const root =
  process.env.NOD_FLEET_WORKER_ROOT ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Nod Fleet', 'worker')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Nod Fleet', 'worker')
      : path.join(os.homedir(), '.local', 'state', 'nod-fleet', 'worker'));
await fs.mkdir(root, { recursive: true, mode: 0o700 });
if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('The worker folder is a link.');
await fs.chmod(root, 0o700);
const secrets = Object.entries(process.env)
  .filter(([name, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(name) && value?.length >= 8)
  .map(([, value]) => value);
const hide = (value) =>
  secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
const emit = (value) => process.stdout.write('NOD_FLEET:' + JSON.stringify(value) + '\n');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const engines = ['muse', 'hermes', 'claude'];
const identityFile = path.join(root, 'identity');
let identityId;
try {
  identityId = crypto.randomUUID();
  await fs.writeFile(identityFile, identityId, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  identityId = (await fs.readFile(identityFile, 'utf8')).trim();
}
if (!uuid.test(identityId)) throw new Error('The worker identity is invalid.');
async function executable(name) {
  const folders = [
    path.join(os.homedir(), '.local', 'bin'),
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  for (const folder of folders) {
    if (!folder) continue;
    for (const suffix of process.platform === 'win32' ? ['.exe'] : ['']) {
      const file = path.join(folder, name + suffix);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) {
          await fs.access(file, fs.constants.X_OK);
          return file;
        }
      } catch {}
    }
  }
  return null;
}
const commands = Object.fromEntries(
  await Promise.all(engines.map(async (name) => [name, await executable(name)])),
);
const identity = {
  id: identityId,
  hostname: os.hostname(),
  platform: process.platform,
  engines: engines.filter((name) => commands[name]),
};
emit({ type: 'ready', protocol: 1, identity });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const idle = setTimeout(() => {
  input.close();
  process.stdin.pause();
}, 30000);
let handled = false;
let dispatched = false;
const receiptPath = (id) => path.join(root, id + '.json');
async function readReceipt(id) {
  try {
    return JSON.parse(await fs.readFile(receiptPath(id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function saveReceipt(receipt) {
  const temporary = receiptPath(receipt.id) + '.' + crypto.randomUUID();
  await fs.writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, receiptPath(receipt.id));
}
async function handle(message) {
  if (message.operation === 'close' || message.operation === 'probe') return;
  if (!uuid.test(message.id) || !/^[0-9a-f]{64}$/.test(message.digest))
    throw new Error('The task identifier or digest is invalid.');
  if (message.identityId !== identityId || message.hostname !== identity.hostname)
    throw new Error('The assigned computer identity changed. No task was dispatched.');
  let existing = await readReceipt(message.id);
  if (existing && existing.digest !== message.digest)
    throw new Error('This task identifier already belongs to a different request.');
  if (message.operation === 'receipt') {
    if (existing?.status === 'running') {
      try {
        process.kill(existing.supervisorPid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          existing = {
            ...existing,
            status: 'uncertain',
            error:
              'The native supervisor stopped without a final receipt. Review the outcome before another task.',
          };
          await saveReceipt(existing);
        }
      }
    }
    emit({ type: 'receipt', receipt: existing });
    return;
  }
  if (message.operation === 'stop') {
    if (existing?.status === 'running') {
      await fs.writeFile(path.join(root, message.id + '.stop'), '', { mode: 0o600 });
      emit({ type: 'stop_requested' });
    } else emit({ type: 'receipt', receipt: existing });
    return;
  }
  if (message.operation !== 'start') throw new Error('The worker operation is unavailable.');
  const spec = message.spec;
  if (
    !spec ||
    spec.id !== message.id ||
    spec.identityId !== identityId ||
    spec.hostname !== identity.hostname ||
    !engines.includes(spec.engine) ||
    !commands[spec.engine] ||
    typeof spec.instruction !== 'string' ||
    !spec.instruction.trim() ||
    spec.instruction.length > 32000 ||
    (spec.profile !== null && !/^[a-z0-9_-]{1,64}$/i.test(spec.profile))
  )
    throw new Error('The native task specification is invalid or its agent is not installed.');
  const digest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        spec.id,
        spec.deviceId,
        spec.identityId,
        spec.hostname,
        spec.engine,
        spec.profile,
        spec.instruction,
      ]),
    )
    .digest('hex');
  if (digest !== message.digest)
    throw new Error('The native task payload does not match its digest.');
  if (existing) {
    emit({ type: 'receipt', receipt: existing });
    return;
  }
  const lock = path.join(root, 'active');
  try {
    await fs.writeFile(lock, message.id, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error('This computer already has an active or unresolved native task.');
    throw error;
  }
  const workspace = path.join(root, 'workspaces', message.id);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const promptFile = path.join(workspace, 'request.txt');
  await fs.writeFile(promptFile, spec.instruction, { flag: 'wx', mode: 0o600 });
  let receipt = {
    id: message.id,
    digest,
    identityId,
    hostname: identity.hostname,
    engine: spec.engine,
    status: 'running',
    startedAt: new Date().toISOString(),
    supervisorPid: process.pid,
  };
  await saveReceipt(receipt);
  const args =
    spec.engine === 'muse'
      ? ['exec', '--json', '--prompt-file', promptFile, '--workspace', workspace]
      : spec.engine === 'hermes'
        ? [
            ...(spec.profile ? ['-p', spec.profile] : []),
            'chat',
            '--query-file',
            promptFile,
            '--oneshot',
            '--format',
            'stream-json',
            '--in',
            workspace,
          ]
        : [
            '--print',
            '--output-format',
            'json',
            '--input-format',
            'text',
            '--permission-mode',
            'default',
          ];
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:NOD_|DESKTOP_COMMANDER_|DC_|NODE_OPTIONS$|NODE_PATH$|LD_PRELOAD$)/.test(name),
    ),
  );
  const child = spawn(commands[spec.engine], args, {
    cwd: workspace,
    env: environment,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  dispatched = true;
  let output = '';
  let stopped = false;
  let settled = false;
  let escalation;
  let stopReason = '';
  const collect = (chunk) => {
    output = hide((output + chunk.toString('utf8')).slice(-16384));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.stdin.on('error', () => {});
  child.stdin.end(spec.engine === 'claude' ? spec.instruction : undefined);
  const terminate = (reason) => {
    if (stopped || child.exitCode !== null) return;
    stopped = true;
    stopReason = reason;
    if (process.platform === 'win32')
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => child.kill());
    else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      escalation = setTimeout(() => {
        if (!settled) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
      }, 3000);
    }
  };
  const timer = setTimeout(
    () => terminate('The native task reached its 15-minute limit. Partial work may exist.'),
    900000,
  );
  const control = setInterval(() => {
    void fs.access(path.join(root, message.id + '.stop')).then(
      () => terminate('The owner stopped this native task. Partial work may exist.'),
      () => {},
    );
  }, 500);
  try {
    const result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ exitCode: null, error: hide(error.message) }));
      child.once('close', (code, signal) =>
        resolve({
          exitCode: code,
          error: signal ? 'The native agent exited after signal ' + signal + '.' : undefined,
        }),
      );
    });
    settled = true;
    receipt = {
      ...receipt,
      status: stopped ? 'stopped' : result.exitCode === 0 ? 'finished' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      output,
      ...(stopReason || result.error ? { error: stopReason || result.error } : {}),
    };
    await saveReceipt(receipt);
    if ((await fs.readFile(lock, 'utf8')) === message.id) await fs.unlink(lock);
    await fs.unlink(promptFile).catch(() => {});
    emit({ type: 'receipt', receipt });
  } finally {
    clearTimeout(timer);
    clearInterval(control);
    clearTimeout(escalation);
  }
}
input.on('line', (line) => {
  if (handled) return;
  handled = true;
  clearTimeout(idle);
  input.close();
  process.stdin.pause();
  void Promise.resolve()
    .then(() => {
      if (line.length > 131072) throw new Error('The worker request is too large.');
      return handle(JSON.parse(line));
    })
    .catch((error) => {
      emit({ type: 'error', dispatched, error: hide(error.message) });
      process.exitCode = 1;
    });
});
