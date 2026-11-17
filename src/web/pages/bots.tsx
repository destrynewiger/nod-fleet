import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  desktopCommanderEndpoint,
  crosswalkEndpoint,
  nativeEngines,
  type FleetBot,
  type FleetDirectory,
  type FleetEngine,
  type FleetJob,
  type FleetView,
} from '../../shared/fleet.ts';
import { PageTitle } from '../components/page-title';
import { ManualMcpDialog } from '../components/manual-mcp-dialog';
import { AppDiscoveryDialog } from '../components/app-discovery-dialog';
import { Monitor, Plus, Users } from '../components/icons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Loading,
  Notice,
} from '../components/ui';
import { api, ApiError, errorMessage, post } from '../lib/api';
import { usePageData } from '../hooks/use-page-data';

const engineNames: Record<FleetEngine, string> = {
  muse: 'Muse CLI',
  'muse-web': 'Muse · muse.ai',
  hermes: 'Hermes',
  claude: 'Claude Code',
  'grok-bot': 'Grok Bot',
  instinct: 'Instinct',
  'claude-duet': 'Claude Duet',
  dots: 'ChatGPT dots',
};
const serviceDetails: Partial<Record<FleetEngine, { url?: string; text: string }>> = {
  'muse-web': {
    url: 'https://muse.ai/',
    text: 'Muse uses its own cloud computer and account. Its web connection is separate from the installed Muse CLI.',
  },
  'claude-duet': {
    url: 'https://claude.ai/duet',
    text: 'Claude Duet uses your Claude account and connected apps. Its connection is separate from Claude Code.',
  },
  instinct: {
    url: 'https://app.instinct.com/',
    text: 'Instinct uses its own email and text account. This computer assignment does not move that account.',
  },
  'grok-bot': {
    text: 'Grok Bot receives tasks through its connected Crosswalk account.',
  },
  dots: { text: 'Dots run in the ChatGPT app and receive tasks through Crosswalk.' },
};
const statuses: Record<FleetJob['status'], string> = {
  starting: 'Dispatching',
  running: 'Running',
  queued: 'Handoff queued',
  claimed: 'Agent claimed task',
  reported: 'Result reported',
  stopping: 'Stopping',
  finished: 'Run finished',
  failed: 'Failed',
  stopped: 'Stopped',
  uncertain: 'Needs review',
};
const active = (job: FleetJob) =>
  ['starting', 'running', 'queued', 'claimed', 'stopping', 'uncertain'].includes(job.status);
const native = (engine: FleetEngine) => (nativeEngines as readonly string[]).includes(engine);

function BotEditor({
  bot,
  view,
  onClose,
  onSaved,
}: {
  bot: FleetBot | null;
  view: FleetView;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [engine, setEngine] = useState<FleetEngine>(bot?.engine ?? 'hermes');
  const [deviceId, setDeviceId] = useState(bot?.deviceId ?? '');
  const [delivery, setDelivery] = useState<'native' | 'crosswalk'>(
    bot?.delivery === 'crosswalk' || bot?.handoff || !native(bot?.engine ?? 'hermes')
      ? 'crosswalk'
      : 'native',
  );
  const [handoffAccount, setHandoffAccount] = useState(
    bot?.handoff?.connectionId ?? view.handoffConnections[0]?.id ?? '',
  );
  const [recipient, setRecipient] = useState(bot?.handoff?.recipient ?? '');
  const [space, setSpace] = useState(bot?.handoff?.space ?? '');
  const [directory, setDirectory] = useState<FleetDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useRef(bot?.id ?? crypto.randomUUID());
  useEffect(() => {
    const controller = new AbortController();
    setDirectory(null);
    setDirectoryError('');
    if (delivery === 'crosswalk' && handoffAccount)
      void api<FleetDirectory>('/api/fleet/handoffs/' + handoffAccount, {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setDirectory(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setDirectoryError(errorMessage(cause));
        });
    return () => controller.abort();
  }, [delivery, handoffAccount]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('/api/fleet/bots/' + id.current, {
        method: 'PUT',
        body: JSON.stringify({
          name: values.get('name'),
          engine,
          delivery,
          profile:
            engine === 'hermes' && delivery === 'native'
              ? String(values.get('profile') ?? '').trim() || null
              : null,
          handoff:
            delivery === 'crosswalk' && handoffAccount
              ? { connectionId: handoffAccount, recipient, space }
              : null,
          deviceId: deviceId || null,
          computerName: String(values.get('computerName') ?? '').trim() || 'Not assigned',
          revision: bot?.revision ?? 0,
        }),
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="bot-editor">
        <DialogTitle>{bot ? 'Edit bot' : 'Add bot'}</DialogTitle>
        <DialogDescription>
          Choose the agent and the computer that will run its tasks.
        </DialogDescription>
        <form onSubmit={(event) => void save(event)}>
          <Field label="Bot name">
            <Input name="name" required maxLength={80} defaultValue={bot?.name} disabled={busy} />
          </Field>
          <Field label="Agent">
            <select
              className="input"
              value={engine}
              onChange={(event) => {
                const next = event.target.value as FleetEngine;
                setEngine(next);
                if (!native(next)) setDelivery('crosswalk');
              }}
              disabled={busy}
            >
              {Object.entries(engineNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                  {native(value as FleetEngine) ? '' : ' · Crosswalk'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Task delivery">
            <select
              className="input"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as 'native' | 'crosswalk')}
              disabled={busy}
            >
              <option value="native" disabled={!native(engine)}>
                Native agent on this computer
              </option>
              <option value="crosswalk">Crosswalk handoff</option>
            </select>
          </Field>
          {delivery === 'crosswalk' && (
            <>
              <Field label="Crosswalk account">
                <select
                  className="input"
                  value={handoffAccount}
                  onChange={(event) => {
                    setHandoffAccount(event.target.value);
                    setRecipient('');
                    setSpace('');
                  }}
                  disabled={busy}
                >
                  <option value="">Connection pending</option>
                  {view.handoffConnections.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </Field>
              {directory && (
                <>
                  <p className="bot-detail">Crosswalk account: {directory.username}</p>
                  <Field label="Agent recipient">
                    <select
                      className="input"
                      value={recipient}
                      onChange={(event) => setRecipient(event.target.value)}
                      required
                      disabled={busy}
                    >
                      <option value="">Choose your agent</option>
                      {directory.recipients.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.id.slice(-4)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {directory.recipients.find((agent) => agent.id === recipient)?.aliases.length ? (
                    <p className="bot-detail">
                      This number also answers as{' '}
                      {directory.recipients
                        .find((agent) => agent.id === recipient)!
                        .aliases.join(', ')}
                      .
                    </p>
                  ) : null}
                  <Field label="Private workspace">
                    <select
                      className="input"
                      value={space}
                      onChange={(event) => setSpace(event.target.value)}
                      required
                      disabled={busy}
                    >
                      <option value="">Choose a private workspace</option>
                      {directory.spaces.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
              {directoryError && <Notice>{directoryError}</Notice>}
              {!handoffAccount && (
                <Notice>
                  Connect Crosswalk to choose an existing agent. This assignment stays pending until
                  its route is verified.
                </Notice>
              )}
              <p className="bot-detail">
                The task goes to the chosen agent. Its result is a report from that agent. A cloud
                service keeps its own computer.
              </p>
            </>
          )}
          {engine === 'hermes' && delivery === 'native' && (
            <Field label="Hermes profile">
              <Input
                name="profile"
                pattern="[A-Za-z0-9_-]{1,64}"
                defaultValue={bot?.profile ?? ''}
                placeholder="Default profile on this computer"
                disabled={busy}
              />
            </Field>
          )}
          <Field label={delivery === 'crosswalk' ? 'Requested computer' : 'Computer'}>
            <select
              className="input"
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              disabled={busy || !view.connectionId}
            >
              <option value="">Not verified</option>
              {view.devices.map((device) => (
                <option key={device.id} value={device.id} disabled={!device.online}>
                  {device.name}
                  {device.online ? '' : ' · offline'}
                </option>
              ))}
              {bot?.deviceId && !view.devices.some((device) => device.id === bot.deviceId) && (
                <option value={bot.deviceId} disabled>
                  {bot.computerName} · unavailable
                </option>
              )}
            </select>
          </Field>
          {!deviceId && (
            <Field label="Expected computer">
              <Input
                name="computerName"
                defaultValue={bot?.computerName ?? ''}
                placeholder="Computer name"
                maxLength={255}
                disabled={busy}
              />
            </Field>
          )}
          <p className="bot-detail">
            {delivery === 'native'
              ? 'A verified assignment keeps each task on that computer.'
              : 'The handoff includes this computer as a requirement. It does not move the app or prove where the agent executes.'}
          </p>
          {!native(engine) && !handoffAccount && (
            <Notice>This agent needs its Crosswalk connection before it can receive tasks.</Notice>
          )}
          {error && <Notice>{error}</Notice>}
          <div className="bot-editor-actions">
            <Button variant="outline" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || (delivery === 'crosswalk' && Boolean(handoffAccount) && !directory)}
            >
              {busy ? 'Verifying…' : deviceId ? 'Verify and save' : 'Save bot'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Bots() {
  const { data, error, refresh } = usePageData<FleetView>('/api/fleet');
  const [editing, setEditing] = useState<FleetBot | null | undefined>();
  const [manual, setManual] = useState<false | 'desktop' | 'crosswalk'>(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [submissionHeld, setSubmissionHeld] = useState(false);
  const request = useRef<{
    id: string;
    revision: number;
    instruction: string;
    botId: string;
  } | null>(null);
  const connect = useRef<HTMLButtonElement>(null);
  const manualReturn = useRef<HTMLElement | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const currentJobs = useRef(data?.jobs ?? []);
  currentJobs.current = data?.jobs ?? [];
  useEffect(() => {
    let checking = false;
    const timer = window.setInterval(() => {
      if (document.hidden || checking) return;
      const jobs = currentJobs.current.filter((job) =>
        ['starting', 'running', 'queued', 'claimed', 'stopping'].includes(job.status),
      );
      if (!jobs.length) return;
      checking = true;
      void Promise.allSettled(jobs.map((job) => post('/api/fleet/jobs/' + job.id + '/check')))
        .then(() => refresh())
        .finally(() => {
          checking = false;
        });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!data) return error ? <Notice>{errorMessage(error)}</Notice> : <Loading />;
  const bot = data.bots.find((item) => item.id === selected);
  const device = data.devices.find((item) => item.id === bot?.deviceId);
  const runnable = Boolean(
    bot?.identity &&
    device?.online &&
    (bot.delivery === 'crosswalk'
      ? Boolean(
          bot.handoff &&
          data.handoffConnections.some((account) => account.id === bot.handoff!.connectionId),
        )
      : native(bot.engine) &&
        bot.identity.engines.includes(bot.engine as (typeof nativeEngines)[number])) &&
    !data.jobs.some((job) => job.deviceId === bot.deviceId && active(job)),
  );

  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
      void refresh();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || !bot) return;
    request.current ??= {
      id: crypto.randomUUID(),
      revision: bot.revision,
      instruction: instruction.trim(),
      botId: bot.id,
    };
    const saved = request.current;
    setBusy(true);
    setMessage('');
    try {
      await post('/api/fleet/bots/' + saved.botId + '/jobs', {
        id: saved.id,
        revision: saved.revision,
        instruction: saved.instruction,
      });
      request.current = null;
      setSubmissionHeld(false);
      setInstruction('');
      void refresh();
    } catch (cause) {
      const refused = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (refused) request.current = null;
      setSubmissionHeld(!refused);
      setMessage(errorMessage(cause));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bots-page">
      <PageTitle path="/bots" />
      <div className="bots-intro">
        <div>
          <h2>Your bots, on your computers</h2>
          <p>Run native agents on your computers or hand tasks to your connected apps.</p>
        </div>
        <Button onClick={() => setEditing(null)} disabled={busy}>
          <Plus size={16} /> Add bot
        </Button>
      </div>
      <section className="bots-connection" aria-label="Computer connection">
        <div>
          <strong>Computer connection</strong>
          <p>Desktop Commander links this harness to your selected devices.</p>
        </div>
        <div className="bots-connection-actions">
          {data.connections.length > 0 && (
            <select
              aria-label="Desktop Commander account"
              className="input"
              value={data.connectionId ?? ''}
              disabled={busy}
              onChange={(event) => {
                const connectionId = event.target.value;
                if (connectionId)
                  void perform(() =>
                    api('/api/fleet/connection', {
                      method: 'PUT',
                      body: JSON.stringify({ connectionId }),
                    }),
                  );
              }}
            >
              <option value="">Select an account</option>
              {data.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          )}
          <Button
            ref={connect}
            variant="outline"
            onClick={(event) => {
              manualReturn.current = event.currentTarget;
              setManual('desktop');
            }}
          >
            Connect computers
          </Button>
        </div>
      </section>
      <section className="bots-connection" aria-label="Agent handoff connection">
        <div>
          <strong>Agent handoffs</strong>
          <p>Crosswalk routes tasks to existing agents in your private workspaces.</p>
          {data.handoffConnections.map((account) => (
            <p key={account.id}>{account.name} · connected</p>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={(event) => {
            manualReturn.current = event.currentTarget;
            setManual('crosswalk');
          }}
        >
          Connect Crosswalk
        </Button>
      </section>
      {(message || data.error || error) && (
        <Notice>{message || data.error || errorMessage(error)}</Notice>
      )}
      <div className="bot-grid">
        {data.bots.map((item) => {
          const computer = data.devices.find((candidate) => candidate.id === item.deviceId);
          const hasAgent =
            item.delivery === 'crosswalk'
              ? Boolean(
                  item.handoff &&
                  data.handoffConnections.some(
                    (account) => account.id === item.handoff!.connectionId,
                  ),
                )
              : native(item.engine) &&
                item.identity?.engines.includes(item.engine as (typeof nativeEngines)[number]);
          const current = data.jobs.find((job) => job.deviceId === item.deviceId && active(job));
          const label = current
            ? statuses[current.status]
            : !item.identity
              ? 'Computer not verified'
              : !computer?.online
                ? 'Computer unavailable'
                : !hasAgent
                  ? 'Agent setup needed'
                  : 'Ready';
          return (
            <article
              className="bot-card"
              key={item.id}
              data-state={current?.status ?? (hasAgent && computer?.online ? 'ready' : 'waiting')}
            >
              <div className="bot-card-heading">
                <span className="bot-avatar">
                  <Users size={22} />
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <p>{engineNames[item.engine]}</p>
                </div>
                <span className="bot-status">{label}</span>
              </div>
              <p className="bot-computer">
                <Monitor size={16} /> {item.computerName}
              </p>
              {item.profile && <p className="bot-detail">Hermes profile: {item.profile}</p>}
              {item.handoff && (
                <p className="bot-detail">
                  Crosswalk: {item.handoff.recipientName} · {item.handoff.space}. The agent reports
                  its result.
                </p>
              )}
              {serviceDetails[item.engine] && (
                <p className="bot-detail">
                  {serviceDetails[item.engine]!.text}{' '}
                  {serviceDetails[item.engine]!.url && (
                    <a href={serviceDetails[item.engine]!.url} target="_blank" rel="noreferrer">
                      Open service
                    </a>
                  )}
                </p>
              )}
              <div className="bot-card-actions">
                <Button
                  variant="outline"
                  onClick={() => setEditing(item)}
                  disabled={busy || Boolean(current)}
                >
                  Edit assignment
                </Button>
                <Button
                  onClick={() => {
                    setSelected(item.id);
                    composer.current?.focus();
                  }}
                  disabled={!hasAgent || !computer?.online || Boolean(current) || submissionHeld}
                >
                  Give task
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {!data.bots.length && (
        <div className="bot-empty">
          <Users size={30} />
          <h3>Add your first bot</h3>
          <p>Give it a name, then choose its agent and computer.</p>
        </div>
      )}
      <section className="bot-compose" aria-labelledby="bot-task-title">
        <h2 id="bot-task-title">Give a task</h2>
        <form onSubmit={(event) => void send(event)}>
          <Field label="Bot">
            <select
              className="input"
              required
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy || submissionHeld}
            >
              <option value="">Choose a bot</option>
              {data.bots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.computerName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Task">
            <textarea
              ref={composer}
              className="input bot-task-input"
              required
              maxLength={bot?.handoff ? 16000 : 32000}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              disabled={busy || submissionHeld}
              placeholder="Describe the task and its limits."
            />
          </Field>
          {bot && (
            <p className="bot-detail">
              {bot.delivery === 'crosswalk'
                ? bot.handoff
                  ? `This task goes to ${bot.handoff.recipientName} in ${bot.handoff.space}. It requests ${bot.computerName}. The receiving agent keeps its own accounts and approval rules.`
                  : 'Choose this bot’s Crosswalk recipient and private workspace before sending.'
                : `This task will use ${engineNames[bot.engine]} on ${bot.computerName}. The agent keeps its normal approval rules.`}
            </p>
          )}
          {submissionHeld && (
            <Notice>
              The response was lost. Confirm the same request before changing or sending another
              one.
            </Notice>
          )}
          <Button
            type="submit"
            disabled={busy || !instruction.trim() || (!runnable && !submissionHeld)}
          >
            {busy ? 'Sending…' : submissionHeld ? 'Confirm this request' : 'Send task'}
          </Button>
        </form>
      </section>
      <section className="bot-history" aria-labelledby="bot-history-title">
        <h2 id="bot-history-title">Task receipts</h2>
        {!data.jobs.length && (
          <p className="bot-detail">Tasks and their results will appear here.</p>
        )}
        {data.jobs.map((job) => (
          <article className="bot-job" key={job.id} data-state={job.status}>
            <header>
              <div>
                <strong>{job.botName}</strong>
                <span>
                  {job.computerName} · {engineNames[job.engine]}
                </span>
              </div>
              <span className="bot-status">
                {job.delivery === 'crosswalk' && job.status === 'stopping'
                  ? 'Stop requested'
                  : statuses[job.status]}
              </span>
            </header>
            <p className="bot-job-request">{job.instruction}</p>
            {job.delivery === 'crosswalk' && (
              <p className="bot-detail">
                Handoff to {job.recipient}. A reported result is the agent’s own account of the
                work.
              </p>
            )}
            {job.error && <Notice>{job.error}</Notice>}
            {job.receipt?.output && (
              <details open={job.status === 'finished' || job.status === 'reported'}>
                <summary>Agent result</summary>
                <pre>{job.receipt.output}</pre>
              </details>
            )}
            <footer>
              <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
              <div>
                {active(job) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void perform(() => post('/api/fleet/jobs/' + job.id + '/check'))}
                  >
                    Check status
                  </Button>
                )}
                {active(job) && job.status !== 'stopping' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void perform(() => post('/api/fleet/jobs/' + job.id + '/stop'))}
                  >
                    Stop task
                  </Button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      {editing !== undefined && (
        <BotEditor
          key={editing?.id ?? 'new'}
          bot={editing}
          view={data}
          onClose={() => setEditing(undefined)}
          onSaved={refresh}
        />
      )}
      {manual && (
        <ManualMcpDialog
          initial={
            manual === 'crosswalk'
              ? { name: 'Crosswalk', endpoint: crosswalkEndpoint, auth: 'bearer' }
              : { name: 'Desktop Commander', endpoint: desktopCommanderEndpoint }
          }
          onClose={() => setManual(false)}
          onCreated={(id) => {
            setManual(false);
            setDiscovery(id);
          }}
          returnFocus={() => manualReturn.current ?? connect.current}
        />
      )}
      {discovery && (
        <AppDiscoveryDialog
          id={discovery}
          returnFocus={() => manualReturn.current ?? connect.current}
          onClose={() => {
            setDiscovery(null);
            void refresh();
          }}
          onConnected={() => {
            setDiscovery(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
