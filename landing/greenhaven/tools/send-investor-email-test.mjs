import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg.startsWith('--')) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith('--')) {
      args.set(arg, next);
      index += 1;
    } else {
      args.set(arg, true);
    }
  } else if (!args.has('--to')) {
    args.set('--to', arg);
  }
}

const recipient = args.get('--to') || 'carlsagan0654@gmail.com';
const from = args.get('--from') || 'Greenhaven Quest <author@greenhaven.quest>';
const envelopeFrom = args.get('--envelope-from') || 'author@greenhaven.quest';
const replyTo = args.get('--reply-to') || 'author@greenhaven.quest';
const subject =
  args.get('--subject') ||
  'Greenhaven: AI-agent narrative RPG with living memory';
const remote =
  args.get('--remote') || 'root@144.124.230.27';
const keyPath =
  args.get('--key') ||
  'C:\\Users\\user5\\Desktop\\key to qr\\MainFramePriveKey.txt';
const dryRun = Boolean(args.get('--dry-run'));

const html = readFileSync(resolve(root, 'investor-email.html'), 'utf8');
const text = readFileSync(resolve(root, 'investor-email.txt'), 'utf8');
const boundary = `greenhaven_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2)}`;

function wrapBase64(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trim();
}

function header(value) {
  return String(value).replace(/\r?\n/g, ' ');
}

const messageId = `<greenhaven-investor-test-${Date.now()}@greenhaven.quest>`;
const message = [
  `From: ${header(from)}`,
  `To: ${header(recipient)}`,
  `Reply-To: ${header(replyTo)}`,
  `Subject: ${header(subject)}`,
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: ${messageId}`,
  'MIME-Version: 1.0',
  'List-Unsubscribe: <mailto:author@greenhaven.quest?subject=unsubscribe>',
  'X-Greenhaven-Mail: investor-postcard-test',
  `Content-Type: multipart/alternative; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  wrapBase64(text),
  '',
  `--${boundary}`,
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  wrapBase64(html),
  '',
  `--${boundary}--`,
  '',
].join('\r\n');

if (dryRun) {
  console.log(message);
  process.exit(0);
}

const ssh = spawn(
  'ssh',
  [
    '-i',
    keyPath,
    '-o',
    'StrictHostKeyChecking=accept-new',
    remote,
    '/usr/sbin/sendmail',
    '-f',
    envelopeFrom,
    '-t',
    '-oi',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);

let stdout = '';
let stderr = '';
ssh.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
ssh.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});
ssh.stdin.end(message);

ssh.on('close', (code) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (code !== 0) {
    console.error(`sendmail exited through ssh with code ${code}`);
    process.exit(code ?? 1);
  }
  console.log(
    JSON.stringify(
      {
        sent: true,
        to: recipient,
        from,
        envelopeFrom,
        subject,
        messageId,
      },
      null,
      2,
    ),
  );
});
