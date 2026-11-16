/**
 * Tear down the devnet that `scripts/up.ts` last ran against, if this run
 * booted it. Running this script is the explicit request: `run-e2e.sh` only
 * calls it when given `--down` (or `E2E_DOWN=1`), which CI passes and a local
 * run does not by default.
 *
 * `up` attaches to a devnet that is already running; it never boots one. It
 * records what it read: the kurtosis enclave's UUID (cold start) or the
 * snapshot's compose file (snapshot mode), and whether
 * `.github/scripts/e2e-setup.sh` created that devnet in this run or `up`
 * merely attached to an existing one. `down` removes exactly the recorded
 * enclave or compose project, and only when the record says this run booted
 * it. A devnet `up` merely attached to may belong to another session on the
 * same engine (`KURTOSIS_ENCLAVE` defaults to `pos` for everyone), so `down`
 * refuses it and prints the command to remove it by hand. With no record
 * there is nothing to remove, and it says so.
 *
 * It never starts a kurtosis engine: with no engine running, the enclave
 * cannot be removed, so it reports that and leaves the record in place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { clearTeardownRecord, readTeardownRecord, removeEnclave } from '../src/kurtosis.ts';

const log = (line: string) => process.stderr.write(`[e2e:down] ${line}\n`);

const record = readTeardownRecord();

if (!record) {
  log('no devnet recorded by `up`; nothing to tear down.');
} else if (!record.createdByHarness) {
  const what =
    record.mode === 'kurtosis'
      ? `kurtosis enclave ${record.enclaveUuid} (remove it with \`kurtosis enclave rm -f ${record.enclaveUuid}\`)`
      : `the snapshot devnet in ${record.composeFile} (stop it with \`docker compose --file ${record.composeFile} down --volumes\`)`;
  log(
    `refusing to remove ${what}: \`up\` attached to it, this run did not boot it. ` +
      'If it is yours and you want `--down` to remove it, export E2E_DEVNET_CREATED_BY_HARNESS=1 before `up`.'
  );
  process.exit(1);
} else if (record.mode === 'kurtosis') {
  removeEnclave(record.enclaveUuid);
  clearTeardownRecord();
  log(`removed kurtosis enclave ${record.enclaveUuid} (booted by e2e-setup.sh).`);
} else if (!existsSync(record.composeFile)) {
  clearTeardownRecord();
  log(`compose file ${record.composeFile} is gone; nothing to tear down.`);
} else {
  execFileSync('docker', ['compose', '--file', record.composeFile, 'down', '--volumes'], {
    stdio: ['ignore', 'inherit', 'inherit']
  });
  clearTeardownRecord();
  log(
    `stopped the snapshot devnet in ${record.composeFile} (booted by e2e-setup.sh) and removed its volumes.`
  );
}
